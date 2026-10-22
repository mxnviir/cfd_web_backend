// The geometry service's /prepare (services/tessellate/main.py), ported to
// run in the browser on occt-wasm: work out the unit, turn the car to face
// the wind, find the wheels, size the tunnel, cut the car out of it with the
// same fallbacks and the same volume checks, and write the same five
// artefacts the service writes - geometry.step, entity_labels.csv,
// geometry.glb, faces.json and solids.json - plus the same summary a run's
// setup is built from.
//
// Everything the kernel cannot answer is read off the STEP text instead; that
// half lives in cut-step.js. This file is the engine side: shapes in, shapes
// cut, meshes and surveys out.
//
// The whole job runs inside one Web Worker (tunnelCut.worker.js), so the page
// never blocks and the ~hundreds of megabytes the engine needs are the
// worker's to spend. One engine per worker; the page throws the worker away
// after each build.

import { buildGlb } from "./glb.js";
import {
  wheelRadii, findWheelsInStepText, classifyFaces, labelsCsvText,
  labelFaces, groupWheelFaces, matchStepIds, sliverReport,
} from "./cut-step.js";

export {
  wheelRadii, findWheelsInStepText, nameWheels, splitAxle, wheelsFromAxles,
  classifyFaces, labelsCsvText, labelFaces, wheelForFace, groupWheelFaces,
  parseStepFacesText, matchStepIds, sliverReport,
  DOMAIN_TOL, MIN_SPAN, SLIVER_AREA_M2, STEP_NUMBER,
} from "./cut-step.js";

// A car this service will accept, in metres, along its longest side.
const CAR_MIN_M = 0.10, CAR_MAX_M = 0.60;
const UNITS = [["m", 1], ["cm", 0.01], ["mm", 0.001],
               ["in", 0.0254], ["ft", 0.3048], ["yd", 0.9144]];
// Only the metric three are ever guessed: a model 8 units long is 8 inches
// and also 8 feet, so an imperial file has to say what it is.
const GUESSABLE = ["m", "cm", "mm"];

// How far the road sits below the bottom of the wheels (0.1 mm: near enough
// to touching that the flow is unchanged, far enough that the boolean is not
// the degenerate tangent case).
const GROUND_GAP_M = 1e-4;
// How far the symmetry wall is moved off the car's own cut plane.
const SYMMETRY_NUDGE_M = 2e-6;

// Tessellation. Scaled to the model so the triangle count is roughly constant
// whatever units or size the car was drawn in.
export const LINEAR_DEFLECTION = 0.1;
const DEFLECTION_FRACTION = 0.0015;
export const ANGULAR_DEFLECTION = 0.3;

// Cells across the longer side of the car's shadow, for the frontal area.
const FRONTAL_CELLS = 900;

// occt-wasm's subShapeHashes upper bound that agrees with meshShape's
// per-face group hashes. 0xffffffff matches only some of them.
export const HASH_UPPER = 0x7fffffff;

// A fault in the car, worded for the person who drew it. Anything else that
// is thrown is the engine's own failure.
export class CutError extends Error {}

const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
// Python's %g: six significant digits, trailing zeros gone.
const fmtG = (v) => String(Number(v.toPrecision(6)));

/**
 * How many metres one model unit is, as { unit, scale }.
 *
 * Every unit is tried and only those that put the car in a plausible size are
 * kept: a real car matches exactly one (219.88 units is 0.22 m as
 * millimetres and 2.2 m as centimetres, and only the first is a car). The
 * size wins when it is unambiguous; the stated unit - the car version's own
 * `unit`, written when the car was imported - is the fallback when no unit
 * fits or two do, because a STEP header states its unit and knows better
 * than a guess.
 */
export function detectScale(longest, stated) {
  if (!(longest > 0)) {
    throw new CutError("the model has no size in any direction");
  }
  const fits = UNITS.filter(([n, s]) => GUESSABLE.includes(n)
    && longest * s >= CAR_MIN_M && longest * s <= CAR_MAX_M);
  if (fits.length === 1) return { unit: fits[0][0], scale: fits[0][1] };
  if (stated) {
    const hit = UNITS.find(([n]) => n === stated);
    if (hit) return { unit: hit[0], scale: hit[1] };
    throw new CutError("unit must be one of "
      + UNITS.map(([n]) => n).join(", ") + `, not '${stated}'`);
  }
  if (!fits.length) {
    throw new CutError(
      `could not tell what unit this model is in. It is ${fmtG(longest)} units `
      + `along its longest side, which is no car at any scale: that is `
      + `${fmtG(longest)} m, ${fmtG(longest * 0.01)} m or ${fmtG(longest * 0.001)} m, `
      + `and a car is between ${CAR_MIN_M} and ${CAR_MAX_M} m. Send \`unit\` to say which it is.`);
  }
  throw new CutError("could not tell what unit this model is in: "
    + fits.map(([n, s]) => `${n} gives ${fmtG(longest * s)} m`).join(" and ")
    + ", both of which could be a car. Send `unit` to say which it is.");
}

function volumeOf(k, shape) {
  try { return k.getVolume(shape); } catch { return 0; }
}

function isValid(k, shape) {
  try { return k.isValid(shape); } catch { return false; }
}

/** How finely to triangulate this particular shape. */
export function deflectionFor(k, shape) {
  try {
    const b = k.getBoundingBox(shape, { precise: false });
    const diag = Math.hypot(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin);
    return Math.max(LINEAR_DEFLECTION, diag * DEFLECTION_FRACTION);
  } catch {
    return LINEAR_DEFLECTION;
  }
}

/**
 * Turn the car so it lies along X with its axles along Y.
 *
 * Only a quarter turn about Z is applied, which is the case that actually
 * occurs: CAD packages agree about which way is up and disagree about which
 * horizontal axis is forward. The long axis of the car is the direction of
 * travel. Returns the shape and how far it was turned (-90, or 0), so the
 * caller can say so rather than silently moving the user's geometry.
 */
export function orientToWind(k, car, bbox) {
  const size = [bbox.xmax - bbox.xmin, bbox.ymax - bbox.ymin, bbox.zmax - bbox.zmin];
  let longAxis = 0;
  for (let i = 1; i < 3; i++) if (size[i] > size[longAxis]) longAxis = i;
  if (longAxis !== 1) return { car, turned: 0 };
  try {
    const moved = k.rotate(car,
      { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
      -Math.PI / 2);
    return { car: moved, turned: -90 };
  } catch {
    return { car, turned: 0 };
  }
}

/**
 * Tessellate a shape and rebuild the mesh as per-face vertex runs.
 *
 * meshShape shares vertices between faces, which is wrong for everything
 * downstream: the viewer paints a selection over a face's own run of
 * vertices, the face boxes come from those runs, and a click has to map
 * back to a face by a range lookup. So every face gets its own copy of the
 * vertices its triangles use, and the triangles are remapped onto them.
 *
 * Returns positions/normals (Float32Array), per-vertex face ids (Float32Array,
 * the GLB's _FACEID), remapped indices (Uint32Array), and per-face ranges:
 * vranges in vertex units, tranges in triangle units - the same units the
 * service's faces.json uses.
 */
export function meshByFace(k, shape, faces, faceHashes, deflection) {
  const mesh = k.meshShape(shape, {
    linearDeflection: deflection,
    angularDeflection: ANGULAR_DEFLECTION,
  });
  const { positions, normals, indices, faceGroups } = mesh;
  const nFaces = faces.length;

  const hashToFace = new Map();
  faceHashes.forEach((h, i) => { if (!hashToFace.has(h)) hashToFace.set(h, i); });

  // faceGroups is [triStart, triCount, faceHash] triples, with the triangle
  // range in index units (three per triangle).
  const triRanges = new Array(nFaces).fill(null);
  if (faceGroups) {
    const groups = faceGroups.length / 3;
    for (let g = 0; g < groups; g++) {
      const fi = hashToFace.get(faceGroups[g * 3 + 2]);
      if (fi === undefined || triRanges[fi]) continue;
      triRanges[fi] = [faceGroups[g * 3], faceGroups[g * 3 + 1]];
    }
  }

  const outPositions = [];
  const outNormals = [];
  const outFaceIds = [];
  const outIndices = [];
  const vranges = [];
  const tranges = [];
  let vBase = 0, tBase = 0;
  for (let fi = 0; fi < nFaces; fi++) {
    const range = triRanges[fi];
    if (!range || range[1] <= 0) {
      vranges.push([vBase, 0]);
      tranges.push([tBase, 0]);
      continue;
    }
    const [iStart, iCount] = range;
    const triCount = iCount / 3;
    const local = new Map();
    for (let t = 0; t < triCount; t++) {
      for (let kk = 0; kk < 3; kk++) {
        const ov = indices[iStart + t * 3 + kk];
        let nv = local.get(ov);
        if (nv === undefined) {
          nv = vBase + local.size;
          local.set(ov, nv);
          outPositions.push(positions[ov * 3], positions[ov * 3 + 1], positions[ov * 3 + 2]);
          outNormals.push(normals[ov * 3], normals[ov * 3 + 1], normals[ov * 3 + 2]);
          outFaceIds.push(fi);
        }
        outIndices.push(nv);
      }
    }
    vranges.push([vBase, local.size]);
    tranges.push([tBase, triCount]);
    vBase += local.size;
    tBase += triCount;
  }
  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    faceIds: new Float32Array(outFaceIds),
    indices: new Uint32Array(outIndices),
    vranges,
    tranges,
    vertexCount: vBase,
    triangleCount: tBase,
  };
}

/** Area and centroid of every face, straight off its triangles, in metres. */
export function meshFaceStats(positions, indices, tranges, scale) {
  const out = [];
  for (const [ts, tc] of tranges) {
    let area = 0;
    const wmid = [0, 0, 0];
    for (let t = ts; t < ts + tc; t++) {
      const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
      const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
      const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const ta = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
      area += ta;
      wmid[0] += (positions[a] + positions[b] + positions[c]) / 3 * ta;
      wmid[1] += (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 * ta;
      wmid[2] += (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 * ta;
    }
    const centroid = area > 0 ? [wmid[0] / area, wmid[1] / area, wmid[2] / area] : [0, 0, 0];
    out.push({ area: area * scale * scale, centroid: centroid.map((c) => c * scale) });
  }
  return out;
}

/** The bounding box of every face, from the vertices already in memory. */
export function faceBoxes(positions, vranges, scale) {
  return vranges.map(([vs, vc]) => {
    if (!vc) return null;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = vs; i < vs + vc; i++) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i * 3 + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    return {
      min: lo.map((v) => round(v * scale, 6)),
      max: hi.map((v) => round(v * scale, 6)),
    };
  });
}

/**
 * Where the car's own mirror plane is, in model units, measured from its
 * triangles. A half model has a cut face flat against one end and a curved
 * flank at the other; comparing the two ends is what tells it from a whole
 * car. Returns [y, "half" | "centre" | "ambiguous"].
 */
export function symmetryPlane(positions, indices, scale) {
  if (!indices.length) return [0, "centre"];
  let lo = Infinity, hi = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 1] < lo) lo = positions[i + 1];
    if (positions[i + 1] > hi) hi = positions[i + 1];
    if (positions[i] < x0) x0 = positions[i];
    if (positions[i] > x1) x1 = positions[i];
    if (positions[i + 2] < z0) z0 = positions[i + 2];
    if (positions[i + 2] > z1) z1 = positions[i + 2];
  }
  const centre = (lo + hi) / 2;
  if (hi <= lo) return [centre, "centre"];
  // How much surface lies within a tenth of a millimetre of each end plane.
  // Distance to the plane, not flatness: flatness per triangle is a property
  // of the mesh, distance is not.
  const tol = 1e-4 / scale;
  const profile = (x1 - x0) * (z1 - z0) || 1;
  const share = [0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
    const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    if (Math.abs(positions[a + 1] - hi) < tol && Math.abs(positions[b + 1] - hi) < tol
        && Math.abs(positions[c + 1] - hi) < tol) share[0] += area;
    if (Math.abs(positions[a + 1] - lo) < tol && Math.abs(positions[b + 1] - lo) < tol
        && Math.abs(positions[c + 1] - lo) < tol) share[1] += area;
  }
  const topShare = share[0] / profile, bottomShare = share[1] / profile;
  const big = Math.max(topShare, bottomShare), small = Math.min(topShare, bottomShare);
  if (big < 0.15) return [centre, "centre"];
  if (big > small * 2.0) return [topShare >= bottomShare ? hi : lo, "half"];
  return [centre, big > 0.5 ? "ambiguous" : "centre"];
}

/**
 * Rasterise the car's shadow along the wind onto the (y, z) plane, clipped to
 * [yLo, yHi] in model units. The shadow is a union, not a sum: a covered cell
 * counts once however many triangles cover it, which is why adding up
 * triangle areas would count every hidden surface.
 */
export function shadowGrid(positions, indices, yLo, yHi) {
  if (!indices.length) return null;
  let loY = Infinity, hiY = -Infinity, loZ = Infinity, hiZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 1] < loY) loY = positions[i + 1];
    if (positions[i + 1] > hiY) hiY = positions[i + 1];
    if (positions[i + 2] < loZ) loZ = positions[i + 2];
    if (positions[i + 2] > hiZ) hiZ = positions[i + 2];
  }
  if (yLo != null) loY = Math.max(loY, yLo);
  if (yHi != null) hiY = Math.min(hiY, yHi);
  const spanY = hiY - loY, spanZ = hiZ - loZ;
  if (spanY <= 0 || spanZ <= 0) return null;

  const per = FRONTAL_CELLS / Math.max(spanY, spanZ);
  const nx = Math.max(1, Math.floor(spanY * per));
  const ny = Math.max(1, Math.floor(spanZ * per));
  const cw = spanY / nx, ch = spanZ / ny;
  const grid = new Uint8Array(nx * ny);

  const clip = (v, n) => Math.max(0, Math.min(n, v));
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a + 1], ay = positions[a + 2];
    const bx = positions[b + 1], by = positions[b + 2];
    const cx = positions[c + 1], cy = positions[c + 2];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    // A triangle edge-on to the wind casts no shadow, and dividing by its
    // determinant would be dividing by zero.
    if (Math.abs(det) <= 1e-20) continue;
    const i0 = clip(Math.floor((Math.min(ax, bx, cx) - loY) / cw), nx);
    const i1 = clip(Math.ceil((Math.max(ax, bx, cx) - loY) / cw), nx);
    const j0 = clip(Math.floor((Math.min(ay, by, cy) - loZ) / ch), ny);
    const j1 = clip(Math.ceil((Math.max(ay, by, cy) - loZ) / ch), ny);
    if (i1 - i0 <= 0 || j1 - j0 <= 0) continue;
    for (let ii = i0; ii < i1; ii++) {
      const px = loY + (ii + 0.5) * cw;
      for (let jj = j0; jj < j1; jj++) {
        const py = loZ + (jj + 0.5) * ch;
        const u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
        const v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
        if (u >= 0 && v >= 0 && u + v <= 1) grid[ii * ny + jj] = 1;
      }
    }
  }
  return { grid, cw, ch, nx, ny };
}

/** The area of the shadow, in model units. */
export function frontalArea(positions, indices, yLo, yHi) {
  const grid = shadowGrid(positions, indices, yLo, yHi);
  if (!grid) return 0;
  let covered = 0;
  for (let i = 0; i < grid.grid.length; i++) covered += grid.grid[i];
  return covered * grid.cw * grid.ch;
}

/**
 * Every pair of faces that share an edge, with the angle between them, as
 * [faceA, faceB, dihedralDeg] - the shape the viewer's tangentFaces reads.
 *
 * Built from the mesh rather than the B-rep: two faces share an edge exactly
 * when two of their triangles share a quantised vertex pair, and the angle
 * is between the two triangles' outward normals. The kernel's mesh is
 * orientation-corrected, so those normals point out of the solid on both
 * sides. The seam of a closed face (a cylinder joined to itself) is skipped:
 * it is tangent, and saying so would make every cylinder its own neighbour.
 */
export function faceAdjacency(mesh) {
  const { positions, indices, faceIds, triangleCount } = mesh;
  const Q = 1e4;
  const vkey = new Array(positions.length / 3);
  for (let i = 0; i < vkey.length; i++) {
    vkey[i] = `${Math.round(positions[i * 3] * Q)},${Math.round(positions[i * 3 + 1] * Q)},${Math.round(positions[i * 3 + 2] * Q)}`;
  }
  const triNormal = (t) => {
    const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    return len > 1e-20 ? [nx / len, ny / len, nz / len] : null;
  };

  const edges = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const f = faceIds[indices[t * 3]];
    for (let kk = 0; kk < 3; kk++) {
      const va = indices[t * 3 + kk], vb = indices[t * 3 + (kk + 1) % 3];
      const ka = vkey[va], kb = vkey[vb];
      if (ka === kb) continue;
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      let list = edges.get(ek);
      if (!list) { list = []; edges.set(ek, list); }
      list.push([f, t]);
    }
  }

  const out = [];
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [[fa, ta], [fb, tb]] = list;
    if (fa === fb) continue;
    const na = triNormal(ta), nb = triNormal(tb);
    if (!na || !nb) continue;
    const dot = Math.max(-1, Math.min(1, na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]));
    out.push([fa, fb, round(Math.acos(dot) * 180 / Math.PI, 2)]);
  }
  return out;
}

// ── the face survey ──────────────────────────────────────────────────────────

const SURFACE_NAMES = new Set(["plane", "cylinder", "cone", "sphere", "torus", "bspline", "bezier"]);

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normOf = (a) => Math.hypot(a[0], a[1], a[2]);

/**
 * The outward normal of a face at (u, v).
 *
 * The kernel's surfaceNormal is the underlying surface's own normal, which
 * points into the solid on a reversed face - and the faces of a flow region
 * are mostly reversed, because they bound the fluid rather than the car. The
 * orientation decides the sign, exactly as the service's survey does.
 */
function outwardNormal(k, face, u, v) {
  const n = k.surfaceNormal(face, u, v);
  const flip = k.shapeOrientation(face) === "reversed" ? -1 : 1;
  return { x: n.x * flip, y: n.y * flip, z: n.z * flip };
}

/**
 * Radius, axis and axis point of a cylindrical face, from the surface itself.
 *
 * The kernel hands back only the radius, so the axis comes from two outward
 * normals a quarter and a half turn of U apart - their cross product is along
 * it - and the axis point from p - r * n_out, which lands on the axis
 * wherever the surface point sits. Sampling away from the antipode keeps the
 * cross product from collapsing.
 */
function cylinderData(k, face, scale) {
  const cyl = k.getFaceCylinderData(face);
  if (!cyl) return null;
  const r = cyl.radius;
  const uv = k.uvBounds(face);
  const du = uv.uMax - uv.uMin;
  const v = (uv.vMin + uv.vMax) / 2;
  const u1 = uv.uMin + 0.25 * du;
  const n1 = outwardNormal(k, face, u1, v);
  const n2 = outwardNormal(k, face, uv.uMin + 0.5 * du, v);
  let ax = cross([n1.x, n1.y, n1.z], [n2.x, n2.y, n2.z]);
  if (normOf(ax) < 1e-9) {
    const n3 = outwardNormal(k, face, uv.uMin + 0.75 * du, v);
    ax = cross([n1.x, n1.y, n1.z], [n3.x, n3.y, n3.z]);
  }
  const out = { radius_m: round(r * scale, 6) };
  if (normOf(ax) < 1e-9) return out;
  const len = normOf(ax);
  out.axis = [round(ax[0] / len, 6), round(ax[1] / len, 6), round(ax[2] / len, 6)];
  // p - r * n_out lands on the axis, at the surface point's own height.
  const p = k.pointOnSurface(face, u1, v);
  const loc = [p.x - r * n1.x, p.y - r * n1.y, p.z - r * n1.z];
  out.axis_x_m = round(loc[0] * scale, 6);
  out.axis_y_m = round(loc[1] * scale, 6);
  out.axis_z_m = round(loc[2] * scale, 6);
  return out;
}

/**
 * Everything the rest of the job wants to know about each face, once: type,
 * area and centroid (from the triangles - both are only ever compared
 * against other faces of the same model), the outward normal at the middle
 * of the parameter range (from the real surface, because averaging a
 * cylinder's triangle normals points at nothing), and the cylinder fields a
 * wheel face needs to be recognised.
 */
export function surveyFaces(k, faces, stats, scale) {
  const out = [];
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    let type = "other";
    try { type = k.surfaceType(face); } catch { /* keep "other" */ }
    if (!SURFACE_NAMES.has(type)) type = "other";
    const { area, centroid } = stats[i];
    const info = {
      index: i,
      type,
      area_m2: round(area, 9),
      cx_m: round(centroid[0], 6),
      cy_m: round(centroid[1], 6),
      cz_m: round(centroid[2], 6),
    };
    try {
      const uv = k.uvBounds(face);
      const n = outwardNormal(k, face,
        (uv.uMin + uv.uMax) / 2, (uv.vMin + uv.vMax) / 2);
      info.normal = [round(n.x, 6), round(n.y, 6), round(n.z, 6)];
    } catch { /* no normal defined here */ }
    if (type === "cylinder") {
      try {
        const cyl = cylinderData(k, face, scale);
        if (cyl) Object.assign(info, cyl);
      } catch { /* no cylinder data */ }
    }
    out.push(info);
  }
  return out;
}

/** Volume and bounding box per solid, for solids.json. */
export function solidSummary(k, solids, scale) {
  return solids.map((solid, i) => {
    let volume = 0;
    try { volume = k.getVolume(solid) * scale ** 3; } catch { volume = 0; }
    let box = null;
    try {
      const b = k.getBoundingBox(solid);
      box = {
        min: [b.xmin * scale, b.ymin * scale, b.zmin * scale],
        max: [b.xmax * scale, b.ymax * scale, b.zmax * scale],
        size: [(b.xmax - b.xmin) * scale, (b.ymax - b.ymin) * scale, (b.zmax - b.zmin) * scale],
      };
    } catch { box = null; }
    return { id: i, name: `Solid ${i + 1}`, volume_m3: round(volume, 12), bbox: box };
  });
}

/** Which solid each face belongs to, by index into the region's solids. */
export function solidOfFace(k, region, faceHashes) {
  const out = new Array(faceHashes.length).fill(-1);
  const solids = k.getSubShapes(region, "solid");
  for (let si = 0; si < solids.length; si++) {
    let hashes;
    try { hashes = k.subShapeHashes(solids[si], "face", HASH_UPPER); } catch { continue; }
    const set = new Set(hashes);
    for (let i = 0; i < faceHashes.length; i++) {
      if (out[i] < 0 && set.has(faceHashes[i])) out[i] = si;
    }
  }
  return out;
}

/**
 * The faces OCC will not accept, and where they are.
 *
 * "Invalid solid" on its own sends a person back to a two-thousand-face
 * model with nowhere to start looking, so each fault is reported as the
 * centre of its face. The kernel's validity check is a boolean, so the
 * problem list is just "Invalid"; what matters is where.
 */
export function faultyFaces(k, region, limit = 6) {
  const faces = k.getSubShapes(region, "face");
  const out = [];
  for (const f of faces) {
    if (out.length >= limit) break;
    let bad = false;
    try { bad = !k.isValid(f); } catch { bad = true; }
    // The wire is where a self-intersection is recorded, not the face.
    if (!bad) {
      for (const w of k.getSubShapes(f, "wire")) {
        let wireBad = false;
        try { wireBad = !k.isValid(w); } catch { wireBad = true; }
        if (wireBad) { bad = true; break; }
      }
    }
    if (!bad) continue;
    let centre = [0, 0, 0];
    try {
      const b = k.getBoundingBox(f, { precise: false });
      centre = [round((b.xmin + b.xmax) / 2, 3),
                round((b.ymin + b.ymax) / 2, 3),
                round((b.zmin + b.zmax) / 2, 3)];
    } catch { /* keep the origin */ }
    out.push({ centre, problems: ["Invalid"] });
  }
  return out;
}

/**
 * Where a point sits on the car, in words that survive a rotation.
 *
 * Distance back from the nose, out from the centreline and up from the
 * ground mean the same thing whichever way round the car is drawn. The nose
 * is the +x end: the air comes from the inlet at high x.
 */
export function describeSpot(point, lo, hi, unit = "mm") {
  const [x, y, z] = point;
  const back = hi[0] - x;
  const side = y - (lo[1] + hi[1]) / 2;
  const up = z - lo[2];
  const hand = side < 0 ? "left" : "right";
  return `${Math.round(back)} ${unit} back from the nose, `
    + `${Math.round(Math.abs(side))} ${unit} ${hand} of the centreline, `
    + `${Math.round(up)} ${unit} up from the ground`;
}

// ── the tunnel ───────────────────────────────────────────────────────────────

/**
 * The wind tunnel, in metres, positioned around the car.
 *
 * The inlet is at MAX x and the outlet at MIN x, because the solver drives
 * the flow in the -x direction. The floor is set from the lowest wheel
 * bottom, not from the body's own minimum: a car sitting on its wheels has
 * its lowest bodywork above the contact patch, and taking the body minimum
 * would put the road surface inside the wheels. `symmetryY` is the car's own
 * mirror plane in metres; `nudge` moves the wall off it, because a half
 * model's cut face lying exactly in the wall's plane is the degenerate
 * boolean the whole nudge list exists to avoid.
 */
export function buildDomain(lo, hi, wheels, o, symmetryY, nudge) {
  const ground = wheels.length
    ? Math.min(...wheels.map((w) => w.cz_m - w.radius_m)) - GROUND_GAP_M
    : lo[2] - GROUND_GAP_M;
  const dom = {
    outlet_x: lo[0] - o.down,
    inlet_x: hi[0] + o.up,
    ground_z: ground,
    top_z: hi[2] + o.top,
    side_y: lo[1] - o.side,
    symmetry: !!o.symmetry,
  };
  if (!o.symmetry) {
    // A whole car gets a slip wall on both sides and no mirror plane.
    dom.symmetry_y = hi[1] + o.side;
    return dom;
  }
  let plane = symmetryY;
  const step = nudge ?? SYMMETRY_NUDGE_M;
  const towardCar = (plane - lo[1]) > (hi[1] - plane) ? -1 : 1;
  plane += towardCar * step;
  dom.symmetry_y = plane;
  // The tunnel runs from the plane, over the car, to a wall beyond it. Which
  // way that is depends on which side of its own mirror plane the car was
  // drawn, and it is not always the low side.
  dom.side_y = (hi[1] - plane) > (plane - lo[1]) ? hi[1] + o.side : lo[1] - o.side;
  return dom;
}

function tunnelBox(k, dom, inv) {
  const x0 = dom.outlet_x * inv, x1 = dom.inlet_x * inv;
  const z0 = dom.ground_z * inv, z1 = dom.top_z * inv;
  const [y0, y1] = [dom.side_y * inv, dom.symmetry_y * inv].sort((a, b) => a - b);
  const box = k.makeBox(x1 - x0, y1 - y0, z1 - z0);
  const moved = k.translate(box, x0, y0, z0);
  k.release(box);
  return moved;
}

/**
 * How much volume a correct cut takes out of the tunnel. A half tunnel stops
 * at the symmetry plane: a whole car standing in it has half of itself past
 * the plane, so a good cut removes about half the car; a car drawn as a half
 * model has nothing past the plane, so a good cut removes all of it.
 */
export function expectedRemoval(carVolume, symmetry, kind) {
  if (symmetry && kind !== "half") return carVolume * 0.5;
  return carVolume;
}

/**
 * The flow region: the tunnel with the car taken out of it.
 *
 * Three attempts, in order of cost: the whole car in one pass, the car's
 * bodies fused into one, and body at a time with the sound ones first. Every
 * result is held to what a cut can remove, because the failures this guards
 * against do not throw. `say(text, inner)` reports progress within the
 * attempt, 0 to 1.
 */
export function cutCarOut(k, tunnel, car, solids, expected, say) {
  const start = k.getVolume(tunnel);
  const sane = (shape) => {
    if (shape == null) return null;
    const left = volumeOf(k, shape);
    const removed = start - left;
    // 1.5 rather than 1.0 because "expected" is an estimate: a half tunnel
    // is split at the symmetry plane and a car is not perfectly symmetric.
    if (left <= 0 || removed <= 0 || removed > expected * 1.5) return null;
    return removed;
  };
  const cut = (base, tool) => {
    try { return k.cutAll(base, [tool]); } catch { return null; }
  };
  // OCC's booleans loosen the tolerances of the shapes they are given, so
  // every cut changes the next one: each attempt therefore gets its own
  // copies of the untouched shapes. cutAll also uses an oriented-box
  // shortcut that is meant only to save time; a cut that comes back short is
  // done once more without it, and the better of the two kept.
  const cutTwice = (base, tool) => {
    const fast = cut(k.copy(base), k.copy(tool));
    if ((sane(fast) ?? -1) >= expected * 0.8) return fast;
    let plain = null;
    try { plain = k.cut(k.copy(base), k.copy(tool)); } catch { plain = null; }
    return (sane(plain) ?? -1) > (sane(fast) ?? -1) ? plain : fast;
  };

  let best = null, bestRemoved = -1, how = "";

  say("Cutting the whole car out in one pass", 0.15);
  const once = cutTwice(tunnel, car);
  let removed = sane(once);
  if (removed != null) {
    best = once; bestRemoved = removed; how = "one pass, whole car";
    if (removed >= expected * 0.8) return { region: best, note: "", how };
  }

  if (solids.length > 1) {
    say(`Joining the car's ${solids.length} bodies into one and cutting again`, 0.45);
    let fused = null;
    try {
      fused = k.fuseAll(solids.map((s) => k.copy(s)));
      if (!(volumeOf(k, fused) > 0)) fused = null;
    } catch { fused = null; }
    if (fused != null) {
      const whole = cutTwice(tunnel, fused);
      removed = sane(whole);
      if (removed != null && removed >= expected * 0.8) {
        return { region: whole, note: "", how: "fused car" };
      }
      if (removed != null && removed > bestRemoved) {
        best = whole; bestRemoved = removed; how = "fused car";
      }
    }
  }

  // Body at a time. Sound ones first: once a cut has involved an invalid
  // body every later boolean on that result blows up, so the damage has to
  // come last where nothing follows it.
  const ordered = solids
    .map((s) => ({ s, bad: !isValid(k, s), vol: volumeOf(k, s) }))
    .sort((a, b) => (a.bad - b.bad) || (a.vol - b.vol));
  let flow = tunnel;
  const missed = [];
  ordered.forEach(({ s, vol }, i) => {
    if (vol <= 0) return;
    say(`Cutting body ${i + 1} of ${ordered.length}`, 0.5 + 0.5 * (i + 1) / ordered.length);
    const before = volumeOf(k, flow);
    const next = cut(flow, k.copy(s));
    if (next == null) { missed.push(vol); return; }
    const took = before - volumeOf(k, next);
    // The invariant. A cut takes away the part of the tool that was inside
    // the shape, so it cannot take away more than the tool.
    if (took > vol * 1.01 + 1e-6 || took <= 1e-9) {
      k.release(next);
      missed.push(vol);
      return;
    }
    flow = next;
  });
  removed = sane(flow);
  if (removed != null && removed > bestRemoved) {
    best = flow; bestRemoved = removed; how = "body at a time";
  }
  if (best == null) return null;
  const note = missed.length && how === "body at a time"
    ? `${missed.length} part${missed.length === 1 ? "" : "s"} of the car could not be cut out of the tunnel`
    : "";
  return { region: best, note, how };
}

// ── the whole job ────────────────────────────────────────────────────────────

/**
 * Raw car STEP in, the wind-tunnel flow region plus the same five artefacts
 * the geometry service writes out.
 *
 * `o` is the setup form: symmetry, upstream_m/downstream_m/side_m/top_m (or
 * the short up/down/side/top), wheel_radius_m/rear_wheel_radius_m/
 * wheel_tolerance, optionally picked `wheels`, the car version's stated
 * `unit`, the car's faces.json `carFaces` (for mapping wheel entity ids onto
 * face indices), and the `version` the artefacts are written for.
 * `say(stage, text, fraction)` reports progress; fraction is 0 to 1 over the
 * whole build.
 */
export function prepareTunnel(k, stepData, o = {}, say = () => {}) {
  const symmetry = o.symmetry ?? true;
  const opts = {
    symmetry,
    up: o.upstream_m ?? o.up ?? 1.5,
    down: o.downstream_m ?? o.down ?? 0.5,
    side: o.side_m ?? o.side ?? 0.3,
    top: o.top_m ?? o.top ?? 0.3,
  };
  const version = Number.isInteger(o.version) ? o.version : 0;

  say("read", "Reading the STEP file", 0.01);
  let car;
  try { car = k.importStep(stepData); } catch {
    throw new CutError("That STEP file could not be read.");
  }
  let solids = k.getSubShapes(car, "solid");
  if (!solids.length) throw new CutError("That file contains no solid bodies.");

  // Triangulate before measuring: an exact bounding box over a car full of
  // B-splines costs seconds unmeshed and milliseconds meshed, and the mesh is
  // needed anyway, for the symmetry plane and the frontal area.
  let carMesh = k.meshShape(car, {
    linearDeflection: LINEAR_DEFLECTION,
    angularDeflection: ANGULAR_DEFLECTION,
  });

  say("measure", "Measuring the car", 0.04);
  let b = k.getBoundingBox(car);
  const { unit: unit0, scale: scale0 } = detectScale(
    Math.max(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin), o.unit);

  say("orient", "Turning the car to face the wind", 0.06);
  const turned0 = orientToWind(k, car, b);
  car = turned0.car;
  const turned = turned0.turned;
  if (turned) {
    solids = k.getSubShapes(car, "solid");
    b = k.getBoundingBox(car);
  }

  // Normalise the shape to millimetres. The kernel's STEP writer stamps
  // SI_UNIT(.MILLI.,.METRE.) whatever the shape's own numbers are, so a car
  // drawn in metres would reach the solver labelled millimetres and solve a
  // thousand times too small. After this, one model unit is one millimetre.
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
  if (turned || scale0 !== 0.001) {
    say("mesh", "Meshing the car", 0.07);
    carMesh = k.meshShape(car, {
      linearDeflection: LINEAR_DEFLECTION,
      angularDeflection: ANGULAR_DEFLECTION,
    });
  }

  const carVolume = solids.reduce((t, s) => t + volumeOf(k, s), 0);

  say("wheels", "Finding the wheels", 0.09);
  let wheels;
  if (Array.isArray(o.wheels) && o.wheels.length) {
    // Wheels the user picked override the automatic search entirely.
    wheels = o.wheels.map((w, i) => {
      const cy = round(Number(w.cy_m), 6);
      return {
        name: String(w.name || `Wheel_${i + 1}`).slice(0, 40),
        radius_m: round(Number(w.radius_m), 6),
        cx_m: round(Number(w.cx_m), 6),
        cy_m: cy,
        cz_m: round(Number(w.cz_m), 6),
        y_lo_m: w.y_lo_m != null ? round(Number(w.y_lo_m), 6) : cy,
        y_hi_m: w.y_hi_m != null ? round(Number(w.y_hi_m), 6) : cy,
        face_indices: (Array.isArray(w.face_indices) ? w.face_indices : [])
          .filter((f) => Number.isInteger(f) && f >= 0).slice(0, 20000),
        source: "picked",
      };
    });
  } else {
    wheels = findWheelsInStepText(stepData, wheelRadii(o),
      o.wheel_tolerance ?? 0.08, scale0, turned);
    // Entity ids are not face indices: map them onto the car's faces.json,
    // which carries the same ids the text was parsed from. A wheel whose
    // faces are not in the list keeps an empty one - never an entity id.
    const byStep = new Map();
    for (const [i, f] of (o.carFaces || []).entries()) {
      if (f && Number.isInteger(f.step_id) && !byStep.has(f.step_id)) {
        byStep.set(f.step_id, Number.isInteger(f.index) ? f.index : i);
      }
    }
    for (const w of wheels) {
      w.face_indices = (w.face_entities || [])
        .map((e) => byStep.get(e))
        .filter((v) => v !== undefined)
        .sort((a, b2) => a - b2)
        .slice(0, 20000);
      delete w.face_entities;
    }
  }

  const [symYRaw, symKind] = symmetryPlane(carMesh.positions, carMesh.indices, scale);
  if (symKind === "half" && !symmetry) {
    throw new CutError("This file is half a car: one side of it is a flat face "
      + "on its centreline. Build it with Width set to Half, which mirrors it "
      + "into the whole car. A full-width tunnel would solve half a car in open air.");
  }
  const expected = expectedRemoval(carVolume, symmetry, symKind);

  const lo = [b.xmin * scale, b.ymin * scale, b.zmin * scale];
  const hi = [b.xmax * scale, b.ymax * scale, b.zmax * scale];
  const bboxM = {
    min: lo,
    max: hi,
    size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
  };

  // Where to put the symmetry wall, in order of preference. A half model's
  // cut face lies in the plane and needs the wall off it; a whole car wants
  // none. More than one candidate because no single offset is safe, so the
  // cut is tried and measured, and the first one that removes the car wins.
  const nudges = !symmetry ? [0]
    : symKind === "half" ? [SYMMETRY_NUDGE_M, 0, 2e-5, 1e-4]
    : [0, 2e-5, 1e-4, SYMMETRY_NUDGE_M];
  const inv = 1 / scale;

  const domain0 = buildDomain(lo, hi, wheels, opts, symYRaw * scale, nudges[0]);
  // The shadow the car casts into the wind, over exactly the width of tunnel
  // being built. This is the reference area a coefficient needs, and it has
  // to agree with the forces the solver reports: half a tunnel gives half
  // the force and must be paired with half the area.
  const areaM2 = frontalArea(carMesh.positions, carMesh.indices,
    Math.min(domain0.side_y, domain0.symmetry_y) / scale,
    Math.max(domain0.side_y, domain0.symmetry_y) / scale) * scale * scale;

  // Cut, measure, and move the wall if the car is still standing. "Did it
  // work" cannot be answered by whether the boolean raised, because the
  // failure this guards against does not raise: it returns a tunnel with the
  // wheels taken out and the bodywork left in, which meshes, solves and
  // reports a drag for four wheels flying in formation.
  let chosen = null;
  for (let attempt = 0; attempt < nudges.length; attempt++) {
    const nudge = nudges[attempt];
    const dom = attempt
      ? buildDomain(lo, hi, wheels, opts, symYRaw * scale, nudge)
      : domain0;
    const tunnel = tunnelBox(k, dom, inv);
    const tag = attempt
      ? ` (symmetry wall moved ${nudge * 1e6} µm, try ${attempt + 1})` : "";
    const got = cutCarOut(k, tunnel, car, solids, expected,
      (text, inner) => say("cut", text + tag,
        0.13 + 0.72 * ((attempt + inner) / nudges.length)));
    if (!got) { k.release(tunnel); continue; }
    const removed = volumeOf(k, tunnel) - volumeOf(k, got.region);
    // A cut with a part missing loses to one without, whatever it removed:
    // a car without its front wing is a different car.
    const better = !chosen || (chosen.note && !got.note)
      || (!!chosen.note === !!got.note && removed > chosen.removed);
    if (better) {
      if (chosen) { k.release(chosen.region); k.release(chosen.tunnel); }
      chosen = { ...got, removed, dom, tunnel, attempts: attempt + 1 };
    } else {
      k.release(got.region);
      k.release(tunnel);
    }
    if (removed >= expected * 0.66 && !got.note) break;
  }
  if (!chosen) {
    throw new CutError("Could not cut the car out of the wind tunnel. The "
      + "geometry may have gaps or self-intersections.");
  }
  if (chosen.removed < expected * 0.66) {
    k.release(chosen.region);
    k.release(chosen.tunnel);
    throw new CutError("The car could not be cut out of the wind tunnel. Every "
      + "position tried left most of the bodywork behind, so the tunnel would "
      + "have solved the wheels alone. This usually means the bodywork is not "
      + "a closed solid: check it in your CAD tool.");
  }

  say("check", "Checking the result", 0.86);
  // The cut can leave the void inside the car as its own solid. The external
  // flow region is the biggest thing left.
  const pieces = k.getSubShapes(chosen.region, "solid");
  if (!pieces.length) {
    k.release(chosen.region);
    k.release(chosen.tunnel);
    throw new CutError("The wind tunnel came out empty.");
  }
  let region = pieces[0];
  for (const p of pieces.slice(1)) {
    if (volumeOf(k, p) > volumeOf(k, region)) region = p;
  }
  const removed = volumeOf(k, chosen.tunnel) - volumeOf(k, region);
  k.release(chosen.tunnel);

  // The one check that catches a boolean which quietly did nothing, and the
  // other end of it, which nothing used to check. The yardstick is the car,
  // not the box: the box is around three thousand times the car's volume, and
  // any fraction of it is either far below boolean noise or far above a
  // whole car.
  if (carVolume <= 0 || removed < carVolume * 0.05) {
    throw new CutError("The car could not be cut out of the wind tunnel. The "
      + "wind tunnel came out empty, so this geometry would solve to nothing. "
      + "Check the STEP file is a solid car and not a surface model.");
  }
  if (removed > carVolume * 1.5) {
    throw new CutError("The car could not be cut out of the wind tunnel. The "
      + "cut took away far more than the car, which means it went wrong rather "
      + "than merely failing. Check the STEP file for self-intersecting or "
      + "inverted faces.");
  }

  // A solid has one outer shell, and every extra one is a sealed void inside
  // the tunnel. A body that does not touch the car - a wheel floating clear
  // of the bodywork - cuts a bubble of nothing out of the middle of the flow
  // region, and a bubble is not a fluid domain.
  const shellVols = k.getSubShapes(region, "shell")
    .map((s) => Math.abs(volumeOf(k, s)) * scale ** 3)
    .sort((a, b) => b - a);
  const voids = shellVols.slice(1);

  // Is what came out of the boolean a solid the solver can read? OCC's own
  // validity analyser catches a boolean that produced self-intersecting or
  // unclosed geometry. BRepCheck is stricter than the solver, though: a
  // correct tunnel around a car whose wheels stand clear of the bodywork
  // comes back "invalid" with no fault on any face, wire or edge, and
  // refusing there blocked a tunnel that had removed 100.0% of the car. So:
  // refuse when the fault can be described, and carry on when it cannot.
  const wasCertified = isValid(k, region);
  let valid = wasCertified;
  let cutNote = chosen.note;
  if (!wasCertified) {
    const faults = faultyFaces(k, region);
    if (!faults.length) {
      valid = true;
      cutNote = (cutNote ? cutNote + "; " : "") + "the tunnel is "
        + "geometrically correct but OCC does not certify it as a valid solid";
    } else {
      const loM = [bboxM.min[0] / scale, bboxM.min[1] / scale, bboxM.min[2] / scale];
      const hiM = [bboxM.max[0] / scale, bboxM.max[1] / scale, bboxM.max[2] / scale];
      // A face and its twin sit in the same place, so the same description
      // twice reads as sloppiness rather than two faces.
      const seen = new Set();
      const spots = [];
      for (const f of faults) {
        const where = describeSpot(f.centre, loM, hiM, unit);
        if (!seen.has(where)) { seen.add(where); spots.push(where); }
      }
      const where = spots.length
        ? ` ${faults.length} face${faults.length === 1 ? "" : "s"} of the car `
          + `will not orient. Look ${spots.slice(0, 2).join("; and ")}.`
        : "";
      throw new CutError("The wind tunnel came out of the cut as an invalid "
        + "solid." + where + " This is a fault in the car rather than the "
        + "tunnel: the usual cause is a face turned inside out, or a face "
        + "boundary that crosses itself. Repair those faces in your CAD tool "
        + "and import the car again.");
    }
  }

  // A void is not wrong on its own - a wheel modelled clear of the bodywork
  // leaves a wheel-shaped hole in the middle of the air, and that is exactly
  // right. What is wrong is a void with no volume: a sliver left behind where
  // the car's cut face lies in the same plane as the tunnel's wall.
  const sliverCount = voids.filter((v) => v < 1e-12).length;
  if (sliverCount) {
    throw new CutError(`The cut left ${sliverCount} sliver(s) of nothing inside `
      + "the wind tunnel, too small to mesh. This usually happens where a "
      + "flat face of the car lies in exactly the same plane as a tunnel "
      + "wall. Try the full-width tunnel, or move the car a little off that "
      + "plane in your CAD tool.");
  }

  say("export", "Writing the tunnel as a STEP file", 0.89);
  const step = k.exportStep(region);

  // A region OCC will not certify can still be written out as a STEP file
  // that reads back as something else entirely, so an uncertified region is
  // read back and weighed before it is trusted.
  if (!wasCertified) {
    say("export", "Checking the tunnel file reads back as the same shape", 0.89);
    let back = 0;
    try {
      back = k.getSubShapes(k.importStep(step), "solid")
        .reduce((t, s) => t + volumeOf(k, s), 0);
    } catch { back = 0; }
    const want = volumeOf(k, region);
    if (Math.abs(back - want) > want * 0.01) {
      throw new CutError("The wind tunnel came out of the cut as a broken "
        + "solid: written to a file and read back, it is not the same shape. "
        + "This is a fault in the car rather than the tunnel, usually bodies "
        + "whose faces overlap or cross where they meet. Repair the car in "
        + "your CAD tool, or join its bodies there, and try again.");
    }
  }

  say("label", "Labelling the tunnel walls", 0.91);
  // The labels file, from the exported STEP's own text: the CSV the SimScale
  // worker reads, keyed on entity ids.
  const { rows, counts } = classifyFaces(step, chosen.dom, wheels, scale);
  const { text: labelsCsv, demoted } = labelsCsvText(rows);
  if (demoted) {
    counts.car_no_slip = (counts.car_no_slip || 0) + demoted;
    counts.rotating_wall = Math.max(0, (counts.rotating_wall || 0) - demoted);
  }

  say("mesh", "Meshing the tunnel", 0.93);
  const regionFaces = k.getSubShapes(region, "face");
  const faceHashes = k.subShapeHashes(region, "face", HASH_UPPER);
  const mesh = meshByFace(k, region, regionFaces, faceHashes, deflectionFor(k, region));

  say("survey", "Surveying the tunnel", 0.95);
  const stats = meshFaceStats(mesh.positions, mesh.indices, mesh.tranges, scale);
  const boxes = faceBoxes(mesh.positions, mesh.vranges, scale);
  const meta = surveyFaces(k, regionFaces, stats, scale);
  for (let i = 0; i < meta.length; i++) {
    const d = meta[i];
    d.tri_start = mesh.tranges[i][0];
    d.tri_count = mesh.tranges[i][1];
    d.start = mesh.vranges[i][0];
    d.count = mesh.vranges[i][1];
    d.bbox = boxes[i];
  }

  // Which STEP entity each face became in the file the solver will upload,
  // matched on the corners of each face. Every boundary condition depends on
  // it: the worker resolves a face to a SimScale name through it.
  const stepIds = matchStepIds(step, regionFaces.map((f) => {
    try {
      return k.getSubShapes(f, "vertex").map((v) => {
        const p = k.vertexPosition(v);
        return [p.x, p.y, p.z];
      });
    } catch { return []; }
  }));
  for (const [i, eid] of stepIds) meta[i].step_id = eid;

  // Which wall each face is, by face index, from the survey - the labels the
  // setup is built from, which cannot lose a face the entity route cannot
  // pair. Then the wheels as they exist on the tunnel: the boolean cut
  // replaces every face, so a face index into the car means nothing here.
  const perFace = labelFaces(meta, chosen.dom, wheels, symmetry);
  const { labels, tunnelWheels } = groupWheelFaces(meta, perFace, wheels);
  const unresolvable = meta.map((d) => d.index)
    .filter((i) => !stepIds.has(i))
    .sort((a, b) => a - b);

  const adjacency = faceAdjacency(mesh);
  const solidsOfFace = solidOfFace(k, region, faceHashes);
  for (let i = 0; i < meta.length; i++) meta[i].solid = solidsOfFace[i];

  const facesJson = {
    version,
    unit,
    scale_to_m: scale,
    step_id_count: stepIds.size,
    faces: meta,
    adjacency,
  };
  const solidsJson = { version, solids: solidSummary(k, [region], scale) };

  const glb = buildGlb(mesh);

  // Anything the caller should see before paying for a run. A missing inlet
  // is the failure that produces a run which completes and means nothing, so
  // the missing ones go back rather than just a success.
  const wanted = ["inlet", "outlet", "ground", "car_no_slip"];
  if (symmetry) wanted.push("symmetry");
  const missing = wanted.filter((key) => !(labels[key] || []).length);

  return {
    step,
    labels: labelsCsv,
    faces: facesJson,
    solids: solidsJson,
    glb,
    meta: {
      bbox: bboxM,
      domain: chosen.dom,
      unit,
      scale_to_m: scale,
      wheels: tunnelWheels,
      car_wheels: wheels,
      unresolvable_faces: unresolvable.slice(0, 50),
      void_count: voids.length,
      void_volumes_m3: voids.slice(0, 10).map((v) => round(v, 12)),
      symmetry_plane_y: round(symYRaw * scale, 6),
      symmetry_kind: symKind,
      labels,
      label_counts: counts,
      missing_labels: missing,
      frontal_area_m2: round(areaM2, 9),
      rotated_deg: turned,
      reference_length_m: round(bboxM.size[0], 6),
      face_count: meta.length,
      solid_count: solids.length,
      triangle_count: mesh.triangleCount,
      demoted_wheel_faces: demoted,
      slivers: sliverReport(meta),
      cut_note: cutNote,
    },
    stats: {
      unit,
      car: symKind,
      bodies: solids.length,
      carVolumeMm3: carVolume * (scale * 1000) ** 3,
      expectedMm3: expected * (scale * 1000) ** 3,
      removedMm3: removed * (scale * 1000) ** 3,
      removedPct: (removed / expected) * 100,
      how: chosen.how,
      note: cutNote,
      attempts: chosen.attempts,
      valid,
      voids: voids.length,
      faces: meta.length,
      triangleCount: mesh.triangleCount,
      labels: counts,
      wheels: wheels.length,
      tunnelWheels: tunnelWheels.length,
      frontalAreaM2: areaM2,
      symmetryPlaneY: symYRaw * scale,
      stepBytes: step.length,
    },
  };
}
