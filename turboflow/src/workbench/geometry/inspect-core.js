// The import pipeline, in the browser: raw car STEP in, the same five answers
// the geometry service's /inspect used to give back out.
//
// This is what makes a car appear in the Workbench at all: the pickable model
// (a GLB with a face id on every vertex), the face list and body list the
// viewer and the picker read, the re-exported STEP the tunnel will later be
// cut from, and the measurements the setup panel offers before anything is
// built - wheels, shadow, the default tunnel box.
//
// It runs on the same occt-wasm engine as the tunnel cut, in a Web Worker
// (inspectCar.worker.js), so nothing here may touch the DOM except through
// OffscreenCanvas, which the thumbnail uses and Node lacks.
//
// One deliberate difference from the service: the shape is normalised to
// millimetres before the STEP re-export, because occt-wasm's exporter always
// stamps its files MILLI.METRE. The service could write the shape in its own
// units and stamp them to match; the browser cannot, so the numbers are made
// to agree with the stamp instead. faces.json still reports metres through
// scale_to_m, exactly as before.
import { buildGlb } from "./glb.js";
import {
  CutError, detectScale, deflectionFor, orientToWind, meshByFace, meshFaceStats,
  faceBoxes, symmetryPlane, frontalArea, faceAdjacency, surveyFaces,
  solidSummary, solidOfFace, buildDomain,
  LINEAR_DEFLECTION, ANGULAR_DEFLECTION, HASH_UPPER,
} from "./cut-core.js";
import { findWheelsFrom, matchStepIds } from "./cut-step.js";

/** Faces that meet within this many degrees count as one surface to the
 *  picker: a tyre split into patches should highlight as a whole. */
const TANGENT_DEGREES = 1.0;

/** The thumbnail the dashboard cards show. Same canvas size and margins as
 *  the service's rasteriser. */
const THUMB_W = 512, THUMB_H = 384, THUMB_MARGIN = 16;

/**
 * A shaded three-quarter view of the mesh, drawn by hand onto an
 * OffscreenCanvas.
 *
 * The service rasterised this with numpy because a Cloud Run container has
 * no GPU. The browser has a canvas instead, so the same camera and light go
 * through Canvas2D: project every triangle with the same orthographic
 * camera, shade it with the same Lambert term, and paint them far to near.
 * Per-triangle painting rather than per-pixel depth is the one shortcut, and
 * on a thumbnail it does not show.
 *
 * Returns PNG bytes, or null where no canvas exists (Node, old browsers) -
 * the dashboard survives without a picture.
 */
export async function renderThumb(positions, indices) {
  if (typeof OffscreenCanvas === "undefined" || !positions?.length || !indices?.length) {
    return null;
  }
  // Camera above and to one side; a light off the camera axis, because a
  // light on the axis flattens every visible face to the same brightness and
  // the car reads as a silhouette.
  const norm = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a, b2) => [
    a[1] * b2[2] - a[2] * b2[1],
    a[2] * b2[0] - a[0] * b2[2],
    a[0] * b2[1] - a[1] * b2[0],
  ];
  const eye = norm([1.0, -1.0, 0.6]);
  const fwd = [-eye[0], -eye[1], -eye[2]];
  let right = cross(fwd, [0, 0, 1]);
  if (Math.hypot(right[0], right[1], right[2]) < 1e-9) right = [1, 0, 0];
  right = norm(right);
  const up = cross(right, fwd);
  const light = norm([0.35, -0.55, 1.0]);

  const at = (i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
  const project = (p) => {
    const x = p[0] * right[0] + p[1] * right[1] + p[2] * right[2];
    const y = p[0] * up[0] + p[1] * up[1] + p[2] * up[2];
    const z = p[0] * fwd[0] + p[1] * fwd[1] + p[2] * fwd[2];
    return [x, y, z];
  };

  const pts = [];
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity, zLo = Infinity, zHi = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const p = at(i / 3);
    const q = project(p);
    pts.push(q);
    xLo = Math.min(xLo, q[0]); xHi = Math.max(xHi, q[0]);
    yLo = Math.min(yLo, q[1]); yHi = Math.max(yHi, q[1]);
    zLo = Math.min(zLo, q[2]); zHi = Math.max(zHi, q[2]);
  }
  const kFit = Math.min(
    (THUMB_W - 2 * THUMB_MARGIN) / Math.max(xHi - xLo, 1e-12),
    (THUMB_H - 2 * THUMB_MARGIN) / Math.max(yHi - yLo, 1e-12));
  const sx = (x) => (x - (xHi + xLo) / 2) * kFit + THUMB_W / 2;
  const sy = (y) => THUMB_H / 2 - (y - (yHi + yLo) / 2) * kFit;

  // Far triangles first. Depth along the camera axis, tie-broken by the
  // nearest corner, which keeps adjacent faces from speckle.
  const tris = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = pts[indices[t]], b2 = pts[indices[t + 1]], c = pts[indices[t + 2]];
    const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    const n = cross([ux, uy, uz], [wx, wy, wz]);
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const lam = Math.max(0, Math.min(1,
      (n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / nl));
    const shade = Math.round(45 + 195 * lam);
    const z = (a[2] + b2[2] + c[2]) / 3;
    const zNear = Math.max(a[2], b2[2], c[2]);
    tris.push({ a, b2, c, shade, z, zNear });
  }
  tris.sort((p, q) => (q.z - p.z) || (q.zNear - p.zNear));

  const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  for (const t of tris) {
    ctx.fillStyle = `rgb(${t.shade},${t.shade},${t.shade})`;
    ctx.beginPath();
    ctx.moveTo(sx(t.a[0]), sy(t.a[1]));
    ctx.lineTo(sx(t.b2[0]), sy(t.b2[1]));
    ctx.lineTo(sx(t.c[0]), sy(t.c[1]));
    ctx.closePath();
    ctx.fill();
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Raw car STEP in, the import's artefacts and answers out.
 *
 * `o` carries the version the artefacts are filed under and the unit the
 * upload dialog said, which is only a fallback: the size of the model is
 * measured first, as the service did.
 */
export async function inspectCar(k, stepData, o = {}, say = () => {}) {
  const version = Number.isInteger(o.version) ? o.version : 1;

  say("read", "Reading the STEP file", 0.01);
  let car;
  try { car = k.importStep(stepData); } catch {
    throw new CutError("That STEP file could not be read.");
  }
  let solids = k.getSubShapes(car, "solid");
  if (!solids.length) throw new CutError("That file contains no solid bodies.");

  // Triangulate before measuring: it makes the exact bounding box fast, and
  // the mesh is needed a few steps below anyway.
  say("mesh", "Meshing the model", 0.08);
  k.meshShape(car, { linearDeflection: LINEAR_DEFLECTION, angularDeflection: ANGULAR_DEFLECTION });

  say("measure", "Measuring the model", 0.16);
  let b = k.getBoundingBox(car);

  say("orient", "Turning the model to face the wind", 0.2);
  const turned0 = orientToWind(k, car, b);
  car = turned0.car;
  const turned = turned0.turned;
  if (turned) {
    solids = k.getSubShapes(car, "solid");
    b = k.getBoundingBox(car);
  }

  const { unit: unit0, scale: scale0 } = detectScale(
    Math.max(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin), o.unit);

  // Millimetres, always, so the re-exported STEP agrees with the MILLI stamp
  // its writer puts on it. See the header.
  let unit = unit0, scale = scale0;
  if (scale !== 0.001) {
    const factor = 0.001 / scale;
    car = k.scale(car, { x: 0, y: 0, z: 0 }, factor);
    scale = 0.001;
    unit = "mm";
    b = {
      xmin: b.xmin * factor, ymin: b.ymin * factor, zmin: b.zmin * factor,
      xmax: b.xmax * factor, ymax: b.ymax * factor, zmax: b.zmax * factor,
    };
    solids = k.getSubShapes(car, "solid");
  }

  say("mesh", "Splitting the surfaces", 0.3);
  const faces = k.getSubShapes(car, "face");
  const faceHashes = k.subShapeHashes(car, "face", HASH_UPPER);
  const mesh = meshByFace(k, car, faces, faceHashes, deflectionFor(k, car));

  say("survey", "Surveying the surfaces", 0.45);
  const stats = meshFaceStats(mesh.positions, mesh.indices, mesh.tranges, scale);
  const boxes = faceBoxes(mesh.positions, mesh.vranges, scale);
  const meta = surveyFaces(k, faces, stats, scale);
  const adjacency = faceAdjacency(mesh);
  const tangent = meta.map(() => []);
  for (const [a, b2, angle] of adjacency) {
    if (angle <= TANGENT_DEGREES) {
      tangent[a].push(b2);
      tangent[b2].push(a);
    }
  }
  const solidsOfFace = solidOfFace(k, car, faceHashes);
  for (let i = 0; i < meta.length; i++) {
    const d = meta[i];
    d.tri_start = mesh.tranges[i][0];
    d.tri_count = mesh.tranges[i][1];
    d.start = mesh.vranges[i][0];
    d.count = mesh.vranges[i][1];
    d.bbox = boxes[i];
    d.tangent = tangent[i].sort((p, q) => p - q);
    d.solid = solidsOfFace[i];
  }

  // The model the viewer draws, with a face id on every vertex.
  say("glb", "Writing the model", 0.6);
  const glb = buildGlb(mesh);

  // The STEP re-export, written before the face list because the face ids in
  // it are matched against this file.
  say("step", "Re-exporting the model", 0.7);
  const step = k.exportStep(car);
  const stepIds = matchStepIds(step, faces.map((f) => {
    try {
      return k.getSubShapes(f, "vertex").map((v) => {
        const p = k.vertexPosition(v);
        return [p.x, p.y, p.z];
      });
    } catch { return []; }
  }));
  for (const [i, eid] of stepIds) meta[i].step_id = eid;

  say("wheels", "Finding the wheels", 0.8);
  const wheels = findWheelsFrom(meta, [0.014125], 0.08);

  // The whole model's shadow, and the half of it a symmetric tunnel would
  // see. The half is split where the model's own mirror plane is, not at the
  // origin - a half car drawn off-centre otherwise reports half its full
  // area and nothing looks wrong until the coefficient comes out wrong.
  const [symYRaw, symKind] = symmetryPlane(mesh.positions, mesh.indices, scale);
  const areaFull = frontalArea(mesh.positions, mesh.indices, null, null) * scale * scale;
  const areaHalf = frontalArea(mesh.positions, mesh.indices, null, symYRaw) * scale * scale;

  const lo = [b.xmin * scale, b.ymin * scale, b.zmin * scale];
  const hi = [b.xmax * scale, b.ymax * scale, b.zmax * scale];
  const bbox = {
    min: lo,
    max: hi,
    size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
  };
  // The default box the viewer draws before anything is built: the add-in's
  // own offsets.
  const domain = buildDomain(lo, hi, wheels,
    { symmetry: true, up: 1.5, down: 0.5, side: 0.3, top: 0.3 },
    symYRaw * scale, undefined);

  const facesJson = {
    version,
    unit,
    scale_to_m: scale,
    step_id_count: stepIds.size,
    faces: meta,
    adjacency,
  };
  const solidsJson = { version, solids: solidSummary(k, solids, scale) };

  say("thumb", "Drawing the thumbnail", 0.92);
  const thumb = await renderThumb(mesh.positions, mesh.indices);

  return {
    step,
    glb,
    faces: facesJson,
    solids: solidsJson,
    thumb,
    meta: {
      bbox,
      domain,
      unit,
      scale_to_m: scale,
      wheels,
      symmetry_plane_y: Math.round(symYRaw * scale * 1e6) / 1e6,
      symmetry_kind: symKind,
      frontal_area_m2: Math.round(areaFull * 1e9) / 1e9,
      frontal_area_half_m2: Math.round(areaHalf * 1e9) / 1e9,
      rotated_deg: turned,
      face_count: meta.length,
      solid_count: solids.length,
      triangle_count: mesh.triangleCount,
    },
    stats: {
      unit,
      faces: meta.length,
      solids: solids.length,
      wheels: wheels.length,
      triangleCount: mesh.triangleCount,
      frontalAreaM2: areaFull,
      frontalAreaHalfM2: areaHalf,
      stepIdCount: stepIds.size,
      symY: symYRaw * scale,
      symKind,
      stepBytes: step.length,
    },
  };
}
