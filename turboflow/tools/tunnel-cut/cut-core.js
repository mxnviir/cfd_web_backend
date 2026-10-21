// The core of the geometry service's /prepare (services/tessellate/main.py),
// ported to run in the browser on occt-wasm: work out the unit, size the
// tunnel, cut the car out of it with the same three fallbacks and the same
// volume checks, export the flow region and label its faces from the STEP text.
//
// ponytail: not ported yet, so this is a test of the cut and not a drop-in for
// /prepare. No turning the car to face the wind, no wheel detection (so no
// rotating walls, and the floor sits under the car's lowest point rather than
// under its tyres). No frontal area and no viewer files.

const UNITS = [["m", 1], ["cm", 0.01], ["mm", 0.001]];
const CAR_MIN_M = 0.10, CAR_MAX_M = 0.60;
const GROUND_GAP_M = 1e-4;
const SYMMETRY_NUDGE_M = 2e-6;
const DOMAIN_TOL = 0.05;
const MIN_SPAN = 0.30;

// A fault in the car, worded for the person who drew it. Anything else that
// is thrown is the engine's own failure.
export class CutError extends Error {}

export function detectScale(longest) {
  const fits = UNITS.filter(([, s]) => longest * s >= CAR_MIN_M && longest * s <= CAR_MAX_M);
  if (fits.length === 1) return { unit: fits[0][0], scale: fits[0][1] };
  if (!fits.length) {
    throw new CutError(
      `Could not tell what unit this model is in. It is ${+longest.toPrecision(4)} units ` +
      `along its longest side, which is no car in metres, centimetres or millimetres.`);
  }
  throw new CutError("Could not tell what unit this model is in: " +
    fits.map(([n, s]) => `${n} gives ${+(longest * s).toPrecision(3)} m`).join(" and ") +
    ", both of which could be a car.");
}

export function buildDomain(lo, hi, o, symmetryY, nudge) {
  const dom = {
    outlet_x: lo[0] - o.down,
    inlet_x: hi[0] + o.up,
    ground_z: lo[2] - GROUND_GAP_M,
    top_z: hi[2] + o.top,
    side_y: lo[1] - o.side,
    symmetry: o.symmetry,
  };
  if (!o.symmetry) {
    dom.symmetry_y = hi[1] + o.side;
    return dom;
  }
  let plane = symmetryY;
  plane += ((plane - lo[1]) > (hi[1] - plane) ? -1 : 1) * nudge;
  dom.symmetry_y = plane;
  dom.side_y = (hi[1] - plane) > (plane - lo[1]) ? hi[1] + o.side : lo[1] - o.side;
  return dom;
}

// symmetry_plane: where the car's own mirror plane is, in model units, read
// off its triangles. A half model has a cut face flat against one end and a
// curved flank at the other; comparing the two ends is what tells it from a
// whole car. Returns [y, "half" | "centre" | "ambiguous"].
export function symmetryPlane(k, car, scale) {
  const { positions: v, indices: t } = k.tessellate(car);
  if (!t.length) return [0, "centre"];
  let lo = Infinity, hi = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]);
    lo = Math.min(lo, v[i + 1]); hi = Math.max(hi, v[i + 1]);
    z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2]);
  }
  const centre = (lo + hi) / 2;
  if (hi <= lo) return [centre, "centre"];
  const tol = 1e-4 / scale;
  const profile = (x1 - x0) * (z1 - z0) || 1;
  const share = [0, 0];
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    [hi, lo].forEach((edge, j) => {
      if (Math.abs(v[a + 1] - edge) < tol && Math.abs(v[b + 1] - edge) < tol &&
          Math.abs(v[c + 1] - edge) < tol) share[j] += area;
    });
  }
  const [top, bottom] = share.map((s) => s / profile);
  const big = Math.max(top, bottom), small = Math.min(top, bottom);
  if (big < 0.15) return [centre, "centre"];
  if (big > small * 2) return [top >= bottom ? hi : lo, "half"];
  return [centre, big > 0.5 ? "ambiguous" : "centre"];
}

function volumeOf(k, shape) {
  try { return k.getVolume(shape); } catch { return 0; }
}

function isValid(k, shape) {
  try { return k.isValid(shape); } catch { return false; }
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

// cut_car_out: the whole car in one pass, then the bodies fused into one, then
// body at a time with the sound ones first. Every result is held to what a cut
// can remove, because the failures this guards against do not throw.
export function cutCarOut(k, tunnel, car, solids, expected, say) {
  const start = k.getVolume(tunnel);
  const sane = (shape) => {
    if (shape == null) return null;
    const left = volumeOf(k, shape);
    const removed = start - left;
    if (left <= 0 || removed <= 0 || removed > expected * 1.5) return null;
    return removed;
  };
  const cut = (base, tool) => {
    try { return k.cutAll(base, [tool]); } catch { return null; }
  };
  // OCC's booleans loosen the tolerances of the shapes they are given, so every
  // cut changes the next one: on step_render (11 bodies) the fused car removed
  // 100.9% when it was cut first and 2.6% after the whole-car cut had touched
  // it. Each attempt therefore gets its own copies of the untouched shapes.
  // cutAll also uses an oriented-box shortcut that is meant only to save time;
  // a cut that comes back short is done once more without it, and the better
  // of the two kept.
  const cutTwice = (base, tool) => {
    const fast = cut(k.copy(base), k.copy(tool));
    if ((sane(fast) ?? -1) >= expected * 0.8) return fast;
    let plain = null;
    try { plain = k.cut(k.copy(base), k.copy(tool)); } catch { plain = null; }
    return (sane(plain) ?? -1) > (sane(fast) ?? -1) ? plain : fast;
  };

  let best = null, bestRemoved = -1, how = "";

  say("Cutting the whole car out in one pass");
  const once = cutTwice(tunnel, car);
  let removed = sane(once);
  if (removed != null) {
    best = once; bestRemoved = removed; how = "one pass, whole car";
    if (removed >= expected * 0.8) return { region: best, note: "", how };
  }

  if (solids.length > 1) {
    say(`Joining the car's ${solids.length} bodies into one and cutting again`);
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

  const ordered = solids
    .map((s) => ({ s, bad: !isValid(k, s), vol: volumeOf(k, s) }))
    .sort((a, b) => (a.bad - b.bad) || (a.vol - b.vol));
  let flow = tunnel;
  const missed = [];
  ordered.forEach(({ s, vol }, i) => {
    if (vol <= 0) return;
    say(`Cutting body ${i + 1} of ${ordered.length}`);
    const before = volumeOf(k, flow);
    const next = cut(flow, k.copy(s));
    if (next == null) { missed.push(vol); return; }
    const took = before - volumeOf(k, next);
    // A cut cannot take away more than the tool it cut with.
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

// classify_faces: every ADVANCED_FACE in the exported STEP, labelled by where
// its boundary vertices sit. Same regexes and tolerances as the server.
const ENTITY = /#(\d+)\s*=\s*([\s\S]+?)(?=\n#|\nENDSEC|$)/g;
const POINT = /\(\s*'[^']*'\s*,\s*\(\s*([\d.+\-Ee]+)\s*,\s*([\d.+\-Ee]+)\s*,\s*([\d.+\-Ee]+)/;
const FACE_SURF = /ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\([^)]+\)\s*,\s*#(\d+)/;

export function classifyFaces(stepText, dom, scale) {
  const text = stepText.replace(/\r\n/g, "\n");
  const entities = new Map();
  for (const m of text.matchAll(ENTITY)) {
    entities.set(+m[1], m[2].trim().replace(/;+$/, ""));
  }
  const points = new Map();
  for (const [id, body] of entities) {
    if (!body.startsWith("CARTESIAN_POINT")) continue;
    const p = POINT.exec(body);
    if (p) points.set(id, [+p[1] * scale, +p[2] * scale, +p[3] * scale]);
  }
  const refs = (id) => [...(entities.get(id) || "").matchAll(/#(\d+)/g)].map((m) => +m[1]);
  const is = (id, kind) => (entities.get(id) || "").startsWith(kind);

  const facePoints = (fid) => {
    const m = /ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\(([^)]*)\)/.exec(entities.get(fid) || "");
    if (!m) return [];
    const out = [];
    for (const bound of [...m[1].matchAll(/#(\d+)/g)].map((x) => +x[1])) {
      for (const loop of refs(bound)) {
        if (!is(loop, "EDGE_LOOP")) continue;
        for (const oriented of refs(loop)) {
          if (!is(oriented, "ORIENTED_EDGE")) continue;
          for (const curve of refs(oriented)) {
            if (!is(curve, "EDGE_CURVE")) continue;
            for (const vertex of refs(curve)) {
              if (!is(vertex, "VERTEX_POINT")) continue;
              for (const p of refs(vertex)) if (points.has(p)) out.push(points.get(p));
            }
          }
        }
      }
    }
    return out;
  };

  const classify = (fid) => {
    const sm = FACE_SURF.exec(entities.get(fid) || "");
    if (!sm || !is(+sm[1], "PLANE")) return "car_no_slip";
    const pts = facePoints(fid);
    if (!pts.length) return "car_no_slip";
    const span = (i) => Math.max(...pts.map((p) => p[i])) - Math.min(...pts.map((p) => p[i]));
    const mean = (i) => pts.reduce((t, p) => t + p[i], 0) / pts.length;
    const [sx, sy, sz] = [span(0), span(1), span(2)];
    if (Math.max(sx, sy, sz) < MIN_SPAN) return "car_no_slip";
    const [cx, cy, cz] = [mean(0), mean(1), mean(2)];
    if (Math.abs(cx - dom.inlet_x) < DOMAIN_TOL) return "inlet";
    if (Math.abs(cx - dom.outlet_x) < DOMAIN_TOL) return "outlet";
    if (Math.abs(cz - dom.top_z) < DOMAIN_TOL) return "top";
    if (Math.abs(cy - dom.side_y) < DOMAIN_TOL) return "side";
    if (Math.abs(cy - dom.symmetry_y) < DOMAIN_TOL && sx > MIN_SPAN && sz > MIN_SPAN) {
      return dom.symmetry ? "symmetry" : "side";
    }
    if (Math.abs(cz - dom.ground_z) < DOMAIN_TOL && sx > MIN_SPAN && sy > MIN_SPAN) return "ground";
    return "car_no_slip";
  };

  const rows = [], counts = {};
  const faces = [...entities].filter(([, b]) => b.startsWith("ADVANCED_FACE")).map(([id]) => id);
  for (const fid of faces.sort((a, b) => a - b)) {
    const label = classify(fid);
    rows.push([fid, label]);
    counts[label] = (counts[label] || 0) + 1;
  }
  return { rows, counts };
}

export function labelsCsv(rows) {
  return "step_entity_id,label,radius_m,cx_m,cy_m,cz_m\r\n" +
    rows.map(([id, label]) => `${id},${label},,,,\r\n`).join("");
}

// The whole job. `say(stage, text)` reports progress; stages are
// read, measure, cut, check, export, label.
export function prepareTunnel(k, stepData, o, say) {
  say("read", "Reading the STEP file");
  let car;
  try { car = k.importStep(stepData); } catch {
    throw new CutError("That STEP file could not be read.");
  }
  const solids = k.getSubShapes(car, "solid");
  if (!solids.length) throw new CutError("That file contains no solid bodies.");

  say("measure", "Measuring the car");
  const b = k.getBoundingBox(car);
  const longest = Math.max(b.xmax - b.xmin, b.ymax - b.ymin, b.zmax - b.zmin);
  const { unit, scale } = detectScale(longest);
  const lo = [b.xmin * scale, b.ymin * scale, b.zmin * scale];
  const hi = [b.xmax * scale, b.ymax * scale, b.zmax * scale];
  const inv = 1 / scale;
  const carVolume = solids.reduce((t, s) => t + volumeOf(k, s), 0);
  const [planeRaw, kind] = symmetryPlane(k, car, scale);
  if (kind === "half" && !o.symmetry) {
    throw new CutError("This file is half a car: one side of it is a flat face on " +
      "its centreline. Use the half tunnel. A full-width tunnel would solve half a " +
      "car in open air.");
  }
  // A half tunnel takes half a whole car, and all of a half model.
  const expected = o.symmetry && kind !== "half" ? carVolume * 0.5 : carVolume;
  const symmetryY = planeRaw * scale;

  // Where the symmetry wall goes: no single offset is safe, so each is cut,
  // measured, and the first that removes the car wins. A half model's cut face
  // lies in the plane and needs the wall off it; a whole car wants none.
  const nudges = !o.symmetry ? [0]
    : kind === "half" ? [SYMMETRY_NUDGE_M, 0, 2e-5, 1e-4]
    : [0, 2e-5, 1e-4, SYMMETRY_NUDGE_M];
  let chosen = null;
  nudges.some((nudge, attempt) => {
    const dom = buildDomain(lo, hi, o, symmetryY, nudge);
    const tunnel = tunnelBox(k, dom, inv);
    const tag = attempt ? ` (symmetry wall moved ${nudge * 1e6} µm, try ${attempt + 1})` : "";
    const got = cutCarOut(k, tunnel, car, solids, expected, (t) => say("cut", t + tag));
    if (!got) return false;
    const removed = k.getVolume(tunnel) - volumeOf(k, got.region);
    if (!chosen || (chosen.note && !got.note) ||
        (!!chosen.note === !!got.note && removed > chosen.removed)) {
      chosen = { ...got, removed, dom, tunnel, attempts: attempt + 1 };
    }
    return removed >= expected * 0.66 && !got.note;
  });
  if (!chosen) {
    throw new CutError("Could not cut the car out of the wind tunnel. The " +
      "geometry may have gaps or self-intersections.");
  }
  if (chosen.removed < expected * 0.66) {
    throw new CutError("The car could not be cut out of the wind tunnel. Every " +
      "position tried left most of the bodywork behind, so the tunnel would have " +
      "solved the wheels alone. This usually means the bodywork is not a closed " +
      "solid: check it in your CAD tool.");
  }

  say("check", "Checking the result");
  const pieces = k.getSubShapes(chosen.region, "solid");
  if (!pieces.length) throw new CutError("The wind tunnel came out empty.");
  const region = pieces.reduce((a, s) => (volumeOf(k, s) > volumeOf(k, a) ? s : a));
  const removed = k.getVolume(chosen.tunnel) - volumeOf(k, region);
  if (carVolume <= 0 || removed < carVolume * 0.05) {
    throw new CutError("The car could not be cut out of the wind tunnel. The wind " +
      "tunnel came out empty. Check the STEP file is a solid car and not a surface model.");
  }
  if (removed > carVolume * 1.5) {
    throw new CutError("The car could not be cut out of the wind tunnel. The cut " +
      "took away far more than the car. Check the STEP file for self-intersecting " +
      "or inverted faces.");
  }
  const shells = k.getSubShapes(region, "shell")
    .map((s) => Math.abs(volumeOf(k, s)) * scale ** 3)
    .sort((a, b) => b - a);
  const voids = shells.slice(1);
  const slivers = voids.filter((v) => v < 1e-12).length;
  if (slivers) {
    throw new CutError(`The cut left ${slivers} sliver(s) of nothing inside the wind ` +
      "tunnel, too small to mesh. This usually happens where a flat face of the car " +
      "lies in exactly the same plane as a tunnel wall.");
  }
  const valid = isValid(k, region);

  say("export", "Writing the tunnel as a STEP file");
  const step = k.exportStep(region);

  // A region OCC will not certify can still be written out as a STEP file that
  // reads back as something else entirely: step_render's tunnel came back as
  // two scraps of 1,262 and 1,118 mm³, from the server's engine as well as this
  // one, and would have gone to SimScale like that. So an uncertified region is
  // read back and weighed before it is trusted.
  if (!valid) {
    say("export", "Checking the tunnel file reads back as the same shape");
    let back = 0;
    try {
      back = k.getSubShapes(k.importStep(step), "solid").reduce((t, s) => t + volumeOf(k, s), 0);
    } catch { back = 0; }
    const want = volumeOf(k, region);
    if (Math.abs(back - want) > want * 0.01) {
      throw new CutError("The wind tunnel came out of the cut as a broken solid: written " +
        "to a file and read back, it is not the same shape. This is a fault in the car " +
        "rather than the tunnel, usually bodies whose faces overlap or cross where they " +
        "meet. Repair the car in your CAD tool, or join its bodies there, and try again.");
    }
  }

  say("label", "Labelling the tunnel walls");
  const { rows, counts } = classifyFaces(step, chosen.dom, scale);

  return {
    step,
    labels: labelsCsv(rows),
    stats: {
      unit,
      car: kind,
      bodies: solids.length,
      carVolumeMm3: carVolume * (scale * 1000) ** 3,
      expectedMm3: expected * (scale * 1000) ** 3,
      removedMm3: removed * (scale * 1000) ** 3,
      removedPct: (removed / expected) * 100,
      how: chosen.how,
      note: chosen.note,
      attempts: chosen.attempts,
      valid,
      voids: voids.length,
      faces: rows.length,
      labels: counts,
      stepBytes: step.length,
    },
  };
}
