// The STEP-text half of the geometry service's /prepare
// (services/tessellate/main.py), in plain JavaScript: no kernel, nothing to
// release, safe to call from the page's thread.
//
// Two jobs live here. The first reads the car's own STEP file to find the
// wheels - cylindrical faces about Y of the right radius - because the face
// list the browser already has for the car is the *re-exported* file, whose
// entity ids are what its faces.json carries, so the ids found in the text
// can be mapped straight onto the face indices the viewer knows. The second
// labels the *tunnel's* faces twice over, exactly as the service does: once
// from the exported tunnel STEP's own text (the CSV the SimScale worker
// reads), and once from the tessellated survey (the labels the setup is built
// from, which cannot lose a face the entity route cannot pair).

// STEP writes reals as 1., 0.E0, -4.44E-16, .5 and sometimes with a
// Fortran D exponent; a pattern that demands a digit after the point reads
// 1.E1 as 1, and every coordinate then lands in the wrong place.
export const STEP_NUMBER = "[-+]?(?:[0-9]+\\.[0-9]*|\\.[0-9]+|[0-9]+)(?:[EeDd][-+]?[0-9]+)?";
const NUM = (n) => parseFloat(n.replace(/[Dd]/, "E"));

// How far a face centroid may sit off a domain wall, in metres.
export const DOMAIN_TOL = 0.05;
// Below this a plane is car bodywork, not a wall.
export const MIN_SPAN = 0.30;
// A face this small is not a feature, it is debris (0.25 mm2).
export const SLIVER_AREA_M2 = 0.25e-6;

const ENTITY = /#(\d+)\s*=\s*([\s\S]+?)(?=\n#|\nENDSEC|$)/g;
const POINT = new RegExp(`\\(\\s*'[^']*'\\s*,\\s*\\(\\s*(${STEP_NUMBER})\\s*,\\s*(${STEP_NUMBER})\\s*,\\s*(${STEP_NUMBER})`);
const FACE_SURF = /ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\([^)]+\)\s*,\s*#(\d+)/;
const FACE_BOUNDS = /ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\(([^)]*)\)/;
const CYL_SURF = new RegExp(`CYLINDRICAL_SURFACE\\s*\\(\\s*'[^']*'\\s*,\\s*#(\\d+)\\s*,\\s*(${STEP_NUMBER})`);
const AXIS_PT = /AXIS2_PLACEMENT_3D\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*(?:,\s*(?:#(\d+)|\$))?/;
const DIRECTION = new RegExp(`DIRECTION\\s*\\(\\s*'[^']*'\\s*,\\s*\\(\\s*(${STEP_NUMBER})\\s*,\\s*(${STEP_NUMBER})\\s*,\\s*(${STEP_NUMBER})\\s*\\)`);

const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
// Python's str.capitalize(): first character upper, the rest lower.
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

const normalizeText = (text) => text.replace(/\r\n/g, "\n");

/** Every entity in a STEP file, as id -> body (the part after `=`). */
export function stepEntities(stepText) {
  const text = normalizeText(stepText);
  const entities = new Map();
  for (const m of text.matchAll(ENTITY)) {
    entities.set(+m[1], m[2].trim().replace(/;+$/, ""));
  }
  return entities;
}

/** Every CARTESIAN_POINT in a STEP file, as id -> [x, y, z] in file units. */
export function stepPoints(entities) {
  const points = new Map();
  for (const [id, body] of entities) {
    if (!body.startsWith("CARTESIAN_POINT")) continue;
    const p = POINT.exec(body);
    if (p) points.set(id, [NUM(p[1]), NUM(p[2]), NUM(p[3])]);
  }
  return points;
}

const refsOf = (entities, id) => {
  const out = [];
  for (const m of (entities.get(id) || "").matchAll(/#(\d+)/g)) out.push(+m[1]);
  return out;
};

const isKind = (entities, id, kind) => (entities.get(id) || "").startsWith(kind);

/**
 * The vertices of a face's own boundary loops, and nothing else.
 *
 * One typed chain: face, to its bounds, to the edge loop, to each oriented
 * edge, to the edge curve, to its two vertices. Walking every reference the
 * way the add-in does crosses into neighbouring faces through shared edge
 * curves, which gave three of the six tunnel walls a bounding box spanning
 * the entire domain. Points come back in file units.
 */
export function facePointsOf(entities, points, fid) {
  const m = FACE_BOUNDS.exec(entities.get(fid) || "");
  if (!m) return [];
  const out = [];
  for (const bound of [...m[1].matchAll(/#(\d+)/g)].map((x) => +x[1])) {
    for (const loop of refsOf(entities, bound)) {
      if (!isKind(entities, loop, "EDGE_LOOP")) continue;
      for (const oriented of refsOf(entities, loop)) {
        if (!isKind(entities, oriented, "ORIENTED_EDGE")) continue;
        for (const curve of refsOf(entities, oriented)) {
          if (!isKind(entities, curve, "EDGE_CURVE")) continue;
          for (const vertex of refsOf(entities, curve)) {
            if (!isKind(entities, vertex, "VERTEX_POINT")) continue;
            for (const p of refsOf(entities, vertex)) {
              if (points.has(p)) out.push(points.get(p));
            }
          }
        }
      }
    }
  }
  return out;
}

// ── wheels, from the STEP text ───────────────────────────────────────────────
//
// A wheel is a cylindrical face whose axis lies within 0.05 of the Y axis and
// whose radius is within `tolerance` of a radius the user gave. The axis
// origin of a cylindrical face can sit anywhere along its own axis, so the
// axle is keyed on x and z and the two wheels on one axle are split by where
// each face's surface actually reaches along y - the faces' boundary
// vertices, not that same unreliable origin.

const FORE_NAMES = ["Front", "Rear"];
const SIDE_NAMES = ["left", "right"];

/** Every wheel size this car is allowed to have, deduplicated. */
export function wheelRadii(o) {
  let out = [];
  const list = Array.isArray(o?.wheel_radii_m)
    ? o.wheel_radii_m
    : [o?.wheel_radius_m, o?.rear_wheel_radius_m]
        .filter((v) => typeof v === "number" && v > 0);
  for (const one of list) {
    const v = Number(one);
    if (Number.isFinite(v) && 0.001 <= v && v <= 1.0) out.push(v);
  }
  if (!out.length) {
    const v = Number(o?.wheel_radius_m ?? 0.014125);
    out = [Number.isFinite(v) && 0.001 <= v && v <= 1.0 ? v : 0.014125];
  }
  const kept = [];
  for (const v of [...out].sort((a, b) => a - b)) {
    if (!kept.length || Math.abs(v - kept[kept.length - 1]) > 1e-6) kept.push(v);
  }
  return kept;
}

/** One entry per wheel on an axle, from the faces that share its axis. */
export function splitAxle(faces, radius) {
  const gap = radius * 0.5;
  const clusters = [];
  for (const f of [...faces].sort((a, b) => a.y_lo - b.y_lo)) {
    if (clusters.length && f.y_lo - clusters[clusters.length - 1].y_hi <= gap) {
      const c = clusters[clusters.length - 1];
      c.y_hi = Math.max(c.y_hi, f.y_hi);
      c.faces.push(f);
    } else {
      clusters.push({ y_lo: f.y_lo, y_hi: f.y_hi, faces: [f] });
    }
  }
  return clusters;
}

/** Axles keyed by (x, z), each a list of faces, into named wheels. */
export function wheelsFromAxles(found) {
  const out = [];
  const entries = [...found.entries()]
    .sort((a, b) => (a[0][0] - b[0][0]) || (a[0][1] - b[0][1]));
  for (const [[x, z], faces] of entries) {
    const axleRadius = Math.max(...faces.map((f) => f.radius));
    for (const c of splitAxle(faces, axleRadius)) {
      out.push({
        radius_m: round(Math.max(...c.faces.map((f) => f.radius)), 6),
        cx_m: round(x, 6),
        cy_m: round((c.y_lo + c.y_hi) / 2.0, 6),
        cz_m: round(z, 6),
        y_lo_m: round(c.y_lo, 6),
        y_hi_m: round(c.y_hi, 6),
        face_entities: c.faces.map((f) => f.index).sort((a, b) => a - b),
        source: "auto",
      });
    }
  }
  return nameWheels(out);
}

/**
 * Wheels from the survey of the model itself, the way the import reads them.
 *
 * The same axle test as the STEP-text route, over the face list the survey
 * already produced: here the "entities" are face indices into that very list,
 * so they are renamed face_indices on the way out - the viewer lights them up
 * directly, with no id matching in between.
 */
export function findWheelsFrom(survey, radii, tolerance) {
  const found = new Map();
  for (const f of survey) {
    if (f.type !== "cylinder" || !f.axis) continue;
    if (Math.abs(Math.abs(f.axis[1]) - 1.0) > 0.05) continue;
    const rM = f.radius_m;
    if (!radii.some((r) => r * (1 - tolerance) <= rM && rM <= r * (1 + tolerance))) {
      continue;
    }
    const x = f.axis_x_m, z = f.axis_z_m;
    const near = rM * 0.5;
    let key = null;
    for (const k of found.keys()) {
      if (Math.abs(k[0] - x) < near && Math.abs(k[1] - z) < near) { key = k; break; }
    }
    if (!key) { key = [x, z]; found.set(key, []); }
    // The face's own reach along y, not the cylinder origin, which can sit
    // anywhere along the axis - the same distinction splitAxle depends on.
    let yLo, yHi;
    if (f.bbox) {
      yLo = f.bbox.min[1];
      yHi = f.bbox.max[1];
    } else {
      yLo = yHi = f.cy_m ?? 0;
    }
    found.get(key).push({ index: f.index, radius: rM, y_lo: yLo, y_hi: yHi });
  }
  return wheelsFromAxles(found).map((w) => ({
    name: w.name,
    radius_m: w.radius_m,
    cx_m: w.cx_m,
    cy_m: w.cy_m,
    cz_m: w.cz_m,
    y_lo_m: w.y_lo_m,
    y_hi_m: w.y_hi_m,
    face_indices: w.face_entities,
    source: "auto",
  }));
}

/** Name each wheel for where it sits, and return them front-left first. */
export function nameWheels(wheels) {
  const axles = [];
  for (const w of [...wheels].sort((a, b) => b.cx_m - a.cx_m)) {
    const near = Math.max(w.radius_m, 1e-6);
    let hit = null;
    for (const a of axles) {
      if (Math.abs(a[0].cx_m - w.cx_m) < near) { hit = a; break; }
    }
    if (hit) hit.push(w); else axles.push([w]);
  }
  const out = [];
  axles.forEach((axle, ai) => {
    const fore = axles.length === 2 ? FORE_NAMES[ai]
      : axles.length === 1 ? "" : `Axle ${ai + 1}`;
    axle.sort((a, b) => b.cy_m - a.cy_m);            // +y is the left side
    axle.forEach((w, si) => {
      const side = axle.length === 2 ? SIDE_NAMES[si]
        : axle.length === 1 ? "" : String(si + 1);
      const parts = [fore, side].filter(Boolean);
      w.name = parts.length ? capitalize(parts.join(" ")) : "Wheel";
      out.push(w);
    });
  });
  return out;
}

/**
 * Wheels as the service finds them: cylindrical faces about Y, read from the
 * car's own STEP text. `scale` converts the file's units to metres and
 * `turnDeg` rotates the text's coordinates into the oriented frame (the text
 * is the pre-rotation file, so a car the browser turned -90 degrees about Z
 * has its text turned the same way: (x, y) -> (y, -x)).
 *
 * Each wheel carries its faces' STEP entity ids in `face_entities`; the
 * caller maps those onto the car's faces.json indices, because an entity id
 * is not a face index and must never reach `face_indices` unmapped.
 */
export function findWheelsInStepText(stepText, radii, tolerance, scale, turnDeg) {
  const entities = stepEntities(stepText);
  const points = stepPoints(entities);
  const spin = Math.abs(turnDeg) > 1e-9;
  const turn = (p) => (spin ? [p[1], -p[0], p[2]] : p);

  const found = new Map();
  for (const [fid, body] of entities) {
    if (!body.startsWith("ADVANCED_FACE")) continue;
    const sm = FACE_SURF.exec(body);
    if (!sm) continue;
    const surf = entities.get(+sm[1]);
    if (!surf || !surf.startsWith("CYLINDRICAL_SURFACE")) continue;
    const cm = CYL_SURF.exec(surf);
    if (!cm) continue;
    const radius = NUM(cm[2]);
    const placement = entities.get(+cm[1]);
    if (!placement) continue;
    const am = AXIS_PT.exec(placement);
    if (!am) continue;
    const raw = points.get(+am[1]);
    if (!raw) continue;
    let dir = [0, 0, 1];
    if (am[2]) {
      const dm = DIRECTION.exec(entities.get(+am[2]) || "");
      if (dm) dir = [NUM(dm[1]), NUM(dm[2]), NUM(dm[3])];
    }
    const p = turn(raw.map((c) => c * scale));
    const d = turn(dir);
    if (Math.abs(Math.abs(d[1]) - 1.0) > 0.05) continue;
    const rM = radius * scale;
    if (!radii.some((r) => r * (1 - tolerance) <= rM && rM <= r * (1 + tolerance))) {
      continue;
    }
    const [x, z] = [p[0], p[2]];
    const near = rM * 0.5;
    let key = null;
    for (const k of found.keys()) {
      if (Math.abs(k[0] - x) < near && Math.abs(k[1] - z) < near) { key = k; break; }
    }
    if (!key) {
      key = [x, z];
      found.set(key, []);
    }
    // The face's own reach along y, from its boundary vertices - not the
    // cylinder origin, which can sit anywhere along the axis.
    const pts = facePointsOf(entities, points, fid)
      .map((q) => turn(q.map((c) => c * scale)));
    const yLo = pts.length ? Math.min(...pts.map((q) => q[1])) : p[1];
    const yHi = pts.length ? Math.max(...pts.map((q) => q[1])) : p[1];
    found.get(key).push({ index: fid, radius: rM, y_lo: yLo, y_hi: yHi });
  }
  return wheelsFromAxles(found);
}

// ── labelling the tunnel's faces ─────────────────────────────────────────────

/**
 * Every ADVANCED_FACE in the exported tunnel STEP, labelled from its text.
 *
 * `scale` converts the file's units to metres and every comparison is in
 * metres. A cylindrical face is a rotating wall when its axis point sits on
 * a wheel's axle (within 10 mm in x and z); the row then carries the wheel's
 * own radius and centre, never a re-measured one, because omega is speed over
 * radius. Rows are [entity id, label, radius, cx, cy, cz] with the last four
 * empty for anything that is not a rotating wall.
 */
export function classifyFaces(stepText, domain, wheels, scale) {
  const entities = stepEntities(stepText);
  const points = stepPoints(entities);

  const wheelAt = (x, y, z) => {
    for (const w of wheels) {
      if (Math.abs(x - w.cx_m) < 0.01 && Math.abs(z - w.cz_m) < 0.01) return w;
    }
    return null;
  };

  const classify = (fid) => {
    const body = entities.get(fid) || "";
    const sm = FACE_SURF.exec(body);
    if (!sm) return [fid, "car_no_slip", "", "", "", ""];
    const surf = entities.get(+sm[1]) || "";

    if (surf.startsWith("CYLINDRICAL_SURFACE")) {
      const rm = CYL_SURF.exec(surf);
      if (rm) {
        const apm = AXIS_PT.exec(entities.get(+rm[1]) || "");
        if (apm) {
          const pt = points.get(+apm[1]);
          if (pt) {
            const w = wheelAt(pt[0] * scale, pt[1] * scale, pt[2] * scale);
            if (w) {
              return [fid, "rotating_wall", w.radius_m, w.cx_m, w.cy_m, w.cz_m];
            }
          }
        }
      }
    }

    if (surf.startsWith("PLANE")) {
      const pts = facePointsOf(entities, points, fid)
        .map((p) => [p[0] * scale, p[1] * scale, p[2] * scale]);
      if (pts.length) {
        const span = (i) => Math.max(...pts.map((p) => p[i])) - Math.min(...pts.map((p) => p[i]));
        const [sx, sy, sz] = [span(0), span(1), span(2)];
        // Anything smaller than a domain wall is bodywork that happens to
        // be flat, not the tunnel.
        if (Math.max(sx, sy, sz) >= MIN_SPAN) {
          const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
          const cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
          const cz = pts.reduce((t, p) => t + p[2], 0) / pts.length;
          if (Math.abs(cx - domain.inlet_x) < DOMAIN_TOL) return [fid, "inlet", "", "", "", ""];
          if (Math.abs(cx - domain.outlet_x) < DOMAIN_TOL) return [fid, "outlet", "", "", "", ""];
          if (Math.abs(cz - domain.top_z) < DOMAIN_TOL) return [fid, "top", "", "", "", ""];
          if (Math.abs(cy - domain.side_y) < DOMAIN_TOL) return [fid, "side", "", "", "", ""];
          if (Math.abs(cy - domain.symmetry_y) < DOMAIN_TOL && sx > MIN_SPAN && sz > MIN_SPAN) {
            // Without a symmetry plane the far wall is just the other side.
            return [fid, domain.symmetry ? "symmetry" : "side", "", "", "", ""];
          }
          if (Math.abs(cz - domain.ground_z) < DOMAIN_TOL && sx > MIN_SPAN && sy > MIN_SPAN) {
            return [fid, "ground", "", "", "", ""];
          }
        }
      }
    }

    return [fid, "car_no_slip", "", "", "", ""];
  };

  const rows = [];
  const counts = {};
  const faces = [...entities]
    .filter(([, b]) => b.startsWith("ADVANCED_FACE"))
    .map(([id]) => id)
    .sort((a, b) => a - b);
  for (const fid of faces) {
    const row = classify(fid);
    rows.push(row);
    counts[row[1]] = (counts[row[1]] || 0) + 1;
  }
  return { rows, counts };
}

/**
 * The labels file, in the column order the SimScale worker's reader expects
 * (simscale_job.py load_entity_labels). A rotating_wall row with no usable
 * radius is demoted to car_no_slip rather than written as it is: the worker's
 * loader falls back to a bare label on a bad radius and build_model never
 * looks that up, so those faces would end up with no boundary condition at
 * all rather than being treated as a wall.
 */
export function labelsCsvText(rows) {
  let demoted = 0;
  const lines = ["step_entity_id,label,radius_m,cx_m,cy_m,cz_m"];
  for (const [fid, label0, radius, cx, cy, cz] of rows) {
    let label = label0, r = radius, x = cx, y = cy, z = cz;
    if (label === "rotating_wall" && !(Number(r) > 0)) {
      label = "car_no_slip";
      r = x = y = z = "";
      demoted += 1;
    }
    lines.push([fid, label, r, x, y, z].join(","));
  }
  return { text: lines.join("\r\n") + "\r\n", demoted };
}

// ── labelling the tunnel's faces from the survey ─────────────────────────────

/**
 * Which wall of the tunnel each face is, by face index, from the tessellated
 * survey rather than the STEP text. The entity route has a join in it that
 * can fail: entity numbers are recovered by matching corner clouds, and a
 * face it cannot pair has no index, so its label is dropped - on the first
 * real car that happened to exactly one face, the symmetry plane. Here every
 * face has an index by construction, so no label can go missing.
 *
 * A wall is recognised by sitting in the plane of one of the six sides *and*
 * spanning most of it. The span test is what keeps a flat piece of bodywork
 * that happens to lie in the floor plane from being labelled as the road.
 */
export function labelFaces(meta, domain, wheels, symmetry) {
  const xs = [domain.outlet_x, domain.inlet_x];
  const zs = [domain.ground_z, domain.top_z];
  const ys = [domain.side_y, domain.symmetry_y].sort((a, b) => a - b);
  const span = [xs[1] - xs[0], ys[1] - ys[0], zs[1] - zs[0]];

  const covers = (box, a, b) => {
    if (!box) return false;
    const { min, max } = box;
    return (max[a] - min[a]) > 0.5 * span[a] && (max[b] - min[b]) > 0.5 * span[b];
  };

  const wheelOf = (f) => {
    if (f.type !== "cylinder" || !f.axis) return null;
    if (Math.abs(Math.abs(f.axis[1]) - 1.0) > 0.05) return null;
    for (const w of wheels) {
      if (Math.abs((f.axis_x_m ?? 1e9) - w.cx_m) < 0.01
          && Math.abs((f.axis_z_m ?? 1e9) - w.cz_m) < 0.01) {
        return w;
      }
    }
    return null;
  };

  const out = {};
  for (const f of meta) {
    const i = f.index;
    if (wheelOf(f) !== null) {
      out[i] = "rotating_wall";
      continue;
    }
    if (f.type !== "plane") {
      out[i] = "car_no_slip";
      continue;
    }
    const { cx_m: cx, cy_m: cy, cz_m: cz } = f;
    const box = f.bbox;
    let label = null;
    if (Math.abs(cx - domain.inlet_x) < DOMAIN_TOL && covers(box, 1, 2)) label = "inlet";
    else if (Math.abs(cx - domain.outlet_x) < DOMAIN_TOL && covers(box, 1, 2)) label = "outlet";
    else if (Math.abs(cz - domain.top_z) < DOMAIN_TOL && covers(box, 0, 1)) label = "top";
    else if (Math.abs(cz - domain.ground_z) < DOMAIN_TOL && covers(box, 0, 1)) label = "ground";
    else if (Math.abs(cy - domain.side_y) < DOMAIN_TOL && covers(box, 0, 2)) label = "side";
    else if (Math.abs(cy - domain.symmetry_y) < DOMAIN_TOL && covers(box, 0, 2)) {
      label = symmetry ? "symmetry" : "side";
    }
    out[i] = label || "car_no_slip";
  }
  return out;
}

/**
 * Which wheel a rotating face belongs to, or null.
 *
 * Coaxial about y within 10 mm in x and z - the same test labelFaces used to
 * call it a wheel face at all - and then, among the wheels that pass it, the
 * one whose own span along the axle is nearest. x and z name an axle, not a
 * wheel, so without the second step every face on a four-wheel car lands on
 * whichever of the two wheels was listed first.
 */
export function wheelForFace(f, wheels) {
  const fy = f.cy_m;
  let best = null, bestGap = null;
  for (let j = 0; j < wheels.length; j++) {
    const w = wheels[j];
    if (Math.abs((f.axis_x_m ?? 1e9) - w.cx_m) >= 0.01) continue;
    if (Math.abs((f.axis_z_m ?? 1e9) - w.cz_m) >= 0.01) continue;
    if (fy == null) return j;
    const lo = w.y_lo_m ?? w.cy_m ?? 0;
    const hi = w.y_hi_m ?? w.cy_m ?? 0;
    const gap = lo <= fy && fy <= hi ? 0 : Math.min(Math.abs(fy - lo), Math.abs(fy - hi));
    if (bestGap === null || gap < bestGap) {
      best = j;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Sort the labelled faces into wheels, carrying each wheel's own radius.
 *
 * The radius here is the one thing that must not be re-measured off the
 * face, because omega is speed over radius and the solver spins the wall at
 * whatever number this produces. Returns (labels, tunnel_wheels) and sets
 * meta[i].label on the way.
 */
export function groupWheelFaces(meta, perFace, wheels) {
  const labels = {};
  const wheelFaces = {};
  for (const i of Object.keys(perFace).map(Number).sort((a, b) => a - b)) {
    const label = perFace[i];
    meta[i].label = label;
    if (label !== "rotating_wall") {
      (labels[label] = labels[label] || []).push(i);
      continue;
    }
    const hit = wheelForFace(meta[i], wheels);
    if (hit === null) {
      // Labelled as turning but belonging to no wheel anyone found. A plain
      // wall beats a wall spun at a speed nothing measured.
      meta[i].label = "car_no_slip";
      (labels.car_no_slip = labels.car_no_slip || []).push(i);
      continue;
    }
    (wheelFaces[hit] = wheelFaces[hit] || []).push(i);
  }

  const tunnelWheels = [];
  const groups = Object.keys(wheelFaces).map(Number).sort((a, b) => a - b);
  groups.forEach((j, n) => {
    const w = wheels[j];
    const faces = wheelFaces[j];
    // A wheel with no usable radius cannot be spun - omega is speed over
    // radius - so it becomes a plain wall rather than a face with no physics
    // at all. Same demotion the labels CSV applies.
    if (!(w.radius_m > 0)) {
      (labels.car_no_slip = labels.car_no_slip || []).push(...faces);
      for (const k of faces) meta[k].label = "car_no_slip";
      return;
    }
    tunnelWheels.push({
      name: w.name || `Wheel_${n + 1}`,
      radius_m: round(w.radius_m, 6),
      cx_m: w.cx_m,
      cy_m: w.cy_m,
      cz_m: w.cz_m,
      y_lo_m: w.y_lo_m ?? w.cy_m,
      y_hi_m: w.y_hi_m ?? w.cy_m,
      face_indices: [...faces].sort((a, b) => a - b),
      source: "labelled",
    });
  });
  for (const key of Object.keys(labels)) labels[key] = [...labels[key]].sort((a, b) => a - b);
  return { labels, tunnelWheels };
}

// ── matching the exported STEP's entity ids back onto faces ──────────────────

/**
 * Every ADVANCED_FACE in a STEP file, with the corner points it uses.
 *
 * OCC will not say which entity produced which face, so the mapping is
 * recovered from the file itself. Only VERTEX_POINTs are collected, not every
 * CARTESIAN_POINT the face mentions: a face also references the origin of its
 * plane, the centre of its circle and the control net of its spline, and none
 * of those have a counterpart on the kernel side. Its corners do, exactly.
 */
export function parseStepFacesText(stepText) {
  const at = stepText.indexOf("DATA;");
  const body = at >= 0
    ? stepText.slice(at + 5).split("ENDSEC;")[0]
    : stepText;
  const kind = new Map();
  const refs = new Map();
  const points = new Map();
  const number = new RegExp(STEP_NUMBER, "g");

  for (const statement of body.split(";")) {
    const head = statement.indexOf("=");
    if (head < 0) continue;
    const left = statement.slice(0, head).trim();
    if (!left.startsWith("#")) continue;
    const eid = parseInt(left.slice(1), 10);
    if (!Number.isFinite(eid)) continue;
    const rest = statement.slice(head + 1).trim();
    const nameEnd = rest.indexOf("(");
    if (nameEnd < 0) continue;
    kind.set(eid, rest.slice(0, nameEnd).trim());
    refs.set(eid, [...rest.matchAll(/#(\d+)/g)].map((m) => +m[1]));
    if (kind.get(eid) === "CARTESIAN_POINT") {
      const parts = rest.split("'");
      const tail = parts.length >= 3 ? parts.slice(2).join("'") : rest;
      const found = tail.match(number) || [];
      if (found.length >= 3) {
        points.set(eid, found.slice(0, 3).map(NUM));
      }
    }
  }

  const faces = new Map();
  for (const [eid, what] of kind) {
    if (what !== "ADVANCED_FACE") continue;
    const seen = new Set();
    const stack = [[eid, 0]];
    const corners = [];
    while (stack.length) {
      const [node, depth] = stack.pop();
      if (seen.has(node) || depth > 8) continue;
      seen.add(node);
      if (kind.get(node) === "VERTEX_POINT") {
        for (const ref of refs.get(node) || []) {
          if (points.has(ref)) corners.push(points.get(ref));
        }
        continue;
      }
      for (const ref of refs.get(node) || []) stack.push([ref, depth + 1]);
    }
    if (corners.length) faces.set(eid, corners);
  }
  return faces;
}

const shapeKey = (corners) => {
  const n = corners.length;
  return [n, [
    corners.reduce((t, c) => t + c[0], 0) / n,
    corners.reduce((t, c) => t + c[1], 0) / n,
    corners.reduce((t, c) => t + c[2], 0) / n,
  ]];
};

const extentOf = (all) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of all) {
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  }
  return [lo, [Math.max(hi[0] - lo[0], 1e-12), Math.max(hi[1] - lo[1], 1e-12), Math.max(hi[2] - lo[2], 1e-12)]];
};

/**
 * Face index to STEP entity id, matched on the corners of each face.
 *
 * `cornersByFace` is one corner array (in the shape's own units) per face.
 * Both clouds are normalised by their own overall extent, which is what makes
 * the comparison independent of the writer's unit choice, and faces are
 * bucketed by corner count before the nearest-centroid search. A leftover
 * face is paired to a leftover entity nearest-first on a second pass: a face
 * with no entity id cannot carry a boundary condition at all, and dropping
 * one used to be silent.
 */
export function matchStepIds(stepText, cornersByFace) {
  const parsed = parseStepFacesText(stepText);
  if (!parsed.size) return new Map();

  const ours = cornersByFace.map((c) => c || []);
  const theirsAll = [...parsed.values()].flat();
  const oursAll = ours.flat();
  if (!theirsAll.length || !oursAll.length) return new Map();
  const [tLo, tSpan] = extentOf(theirsAll);
  const [oLo, oSpan] = extentOf(oursAll);
  const norm = (p, lo, span) => [
    (p[0] - lo[0]) / span[0], (p[1] - lo[1]) / span[1], (p[2] - lo[2]) / span[2],
  ];
  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  const buckets = new Map();
  for (const [eid, corners] of parsed) {
    const [n, centre] = shapeKey(corners);
    if (!buckets.has(n)) buckets.set(n, []);
    buckets.get(n).push([eid, norm(centre, tLo, tSpan)]);
  }

  const out = new Map();
  const used = new Set();
  const leftovers = [];
  ours.forEach((corners, i) => {
    if (!corners.length) return;
    const [n, centre] = shapeKey(corners);
    const here = norm(centre, oLo, oSpan);
    let best = null;
    for (const [eid, there] of buckets.get(n) || []) {
      if (used.has(eid)) continue;
      const d = dist2(here, there);
      if (best === null || d < best[0]) best = [d, eid];
    }
    // A normalised distance of 1e-4 is a tenth of a millimetre on a 200 mm
    // car; squared, the line is 1e-8.
    if (best === null || best[0] > 1e-8) {
      leftovers.push([i, here]);
    } else {
      used.add(best[1]);
      out.set(i, best[1]);
    }
  });

  if (leftovers.length) {
    const spare = [];
    for (const [eid, corners] of parsed) {
      if (used.has(eid)) continue;
      spare.push([eid, norm(shapeKey(corners)[1], tLo, tSpan)]);
    }
    const pairs = [];
    for (const [i, here] of leftovers) {
      for (const [eid, there] of spare) pairs.push([dist2(here, there), i, eid]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const takenFaces = new Set();
    for (const [, i, eid] of pairs) {
      if (takenFaces.has(i) || used.has(eid)) continue;
      takenFaces.add(i);
      used.add(eid);
      out.set(i, eid);
    }
  }
  return out;
}

// ── the sliver report ────────────────────────────────────────────────────────

/**
 * How much of this model is fragments, and where they are.
 *
 * A customer car once arrived with 342 of its 640 faces under half a
 * millimetre square, and SimScale meshed for ten minutes and then refused,
 * naming one entity. None of that is visible in the Workbench, and every
 * attempt to find it out costs a mesh. It is all in the face survey that has
 * already been done.
 */
export function sliverReport(survey) {
  const areas = survey.map((f) => [f.area_m2 || 0, f.cx_m || 0, f.index]);
  const tiny = areas.filter(([a]) => a > 0 && a < SLIVER_AREA_M2);
  if (!tiny.length || !areas.length) {
    return { count: 0, of: areas.length, faces: [] };
  }
  // Where along the car they sit, in 20 mm bands, so a person can be sent
  // to the right part of the model rather than told the whole thing is bad.
  const band = new Map();
  for (const [, x] of tiny) {
    const k = Math.floor(x / 0.02) * 0.02;
    band.set(k, (band.get(k) || 0) + 1);
  }
  let worst = null;
  for (const [k, n] of band) if (!worst || n > worst[1]) worst = [k, n];
  return {
    count: tiny.length,
    of: areas.length,
    threshold_m2: SLIVER_AREA_M2,
    worst_band_m: [round(worst[0], 4), round(worst[0] + 0.02, 4)],
    worst_band_count: worst[1],
    smallest_m2: Math.min(...tiny.map(([a]) => a)),
    faces: tiny.map(([, , i]) => i).filter((i) => i != null).sort((a, b) => a - b),
  };
}
