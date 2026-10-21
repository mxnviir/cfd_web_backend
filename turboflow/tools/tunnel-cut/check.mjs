// Self-check for cut-core.js on cars built from boxes, so it needs no
// customer CAD. Run: node check.mjs
import assert from "node:assert/strict";
import { OcctKernel } from "occt-wasm";
import { prepareTunnel, detectScale, CutError } from "../../src/workbench/geometry/cut-core.js";

const k = await OcctKernel.init();
const quiet = () => {};

// Units: a 200-unit car is only a car in millimetres; 0.2 is only one in metres.
assert.equal(detectScale(200).unit, "mm");
assert.equal(detectScale(0.2).unit, "m");
assert.throws(() => detectScale(5000), CutError);

// A two-body car: a hull and a front wing clear of it, sitting on y = 0 to 60.
const hull = k.translate(k.makeBox(200, 60, 40), 0, 0, 10);
const wing = k.translate(k.makeBox(20, 60, 5), -30, 0, 12);
const step = k.exportStep(k.makeCompound([hull, wing]));
const carMm3 = 200 * 60 * 40 + 20 * 60 * 5;
const walls = ["inlet", "outlet", "ground", "top", "side"];

for (const symmetry of [false, true]) {
  const { stats, labels, faces, meta, glb } = prepareTunnel(k, step,
    { symmetry, up: 1.5, down: 0.5, side: 0.3, top: 0.3 }, quiet);
  const want = symmetry ? carMm3 / 2 : carMm3;
  assert.ok(Math.abs(stats.removedMm3 - want) < want * 0.001,
    `${symmetry ? "half" : "full"} tunnel removed ${stats.removedMm3}, wanted ${want}`);
  for (const w of walls) assert.ok(stats.labels[w] >= 1, `no ${w} face`);
  assert.equal(stats.labels.symmetry ?? 0, symmetry ? 1 : 0);
  assert.equal(stats.valid, true);
  assert.match(labels, /^step_entity_id,label,radius_m,cx_m,cy_m,cz_m\r\n\d+,/);

  // faces.json: every face carries its mesh ranges and box, in metres, and
  // every face found its STEP entity - the SimScale worker resolves boundary
  // conditions through that id.
  assert.equal(faces.unit, "mm");
  assert.equal(faces.scale_to_m, 0.001);
  assert.ok(faces.faces.length > 0);
  assert.equal(faces.step_id_count, faces.faces.length);
  assert.deepEqual(meta.unresolvable_faces, []);
  assert.deepEqual(meta.missing_labels, []);
  for (const f of faces.faces) {
    for (const key of ["start", "count", "tri_start", "tri_count"]) {
      assert.ok(Number.isInteger(f[key]) && f[key] >= 0, `face ${f.index} ${key}`);
    }
    assert.ok(f.area_m2 > 0, `face ${f.index} area`);
    assert.equal(f.bbox.min.length, 3);
    assert.equal(f.bbox.max.length, 3);
    for (let a = 0; a < 3; a++) assert.ok(f.bbox.min[a] <= f.bbox.max[a]);
    assert.ok(Number.isInteger(f.step_id), `face ${f.index} step_id`);
  }
  // Adjacency: pairs of distinct faces, in range, with a non-negative angle.
  assert.ok(faces.adjacency.length > 0);
  for (const [a, b, angle] of faces.adjacency) {
    assert.ok(Number.isInteger(a) && Number.isInteger(b) && a !== b);
    assert.ok(a >= 0 && a < faces.faces.length && b >= 0 && b < faces.faces.length);
    assert.ok(angle >= 0);
  }

  // The GLB the viewer loads: magic, version, a JSON chunk naming _FACEID,
  // and a binary chunk after it.
  assert.ok(glb instanceof Uint8Array);
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  assert.equal(view.getUint32(0, true), 0x46546c67, "glTF magic");
  assert.equal(view.getUint32(4, true), 2, "GLB version");
  assert.equal(view.getUint32(8, true), glb.byteLength, "GLB length");
  const jsonLen = view.getUint32(12, true);
  assert.equal(view.getUint32(16, true), 0x4e4f534a, "JSON chunk type");
  const gltf = JSON.parse(Buffer.from(glb.buffer, glb.byteOffset + 20, jsonLen).toString("utf8"));
  const prim = gltf.meshes[0].primitives[0];
  assert.ok("_FACEID" in prim.attributes, "_FACEID attribute");
  assert.ok("POSITION" in prim.attributes && "NORMAL" in prim.attributes);
  assert.ok(Number.isInteger(prim.indices));
  assert.equal(view.getUint32(20 + jsonLen + 4, true), 0x004e4942, "BIN chunk type");

  k.releaseAll();
}

// A four-wheel car. The wheels sit clear of the hull - y in [0, 10] and
// [50, 60] against a hull on [12, 48] - the way wheels sit under arches, so
// the cut has to take them out and the labelling has to find them. Wheels
// flush with the body or sunk into it are a different (degenerate) fixture:
// the boolean then keeps or mangles them and there is nothing to label.
const wheel = (cx, cy, cz) => k.translate(
  // The cylinder starts at the origin along +z; turned a quarter turn about x
  // it spans y in [-10, 0], so the +5 centres it on cy.
  k.rotate(k.makeCylinder(14.125, 10),
    { point: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, Math.PI / 2),
  cx, cy + 5, cz);
const buildCar = () => k.makeCompound([
  k.translate(k.makeBox(200, 36, 40), 0, 12, 10),
  wheel(160, 5, 14.125), wheel(160, 55, 14.125),
  wheel(40, 5, 14.125), wheel(40, 55, 14.125),
]);
const wheelNames = ["Front left", "Front right", "Rear left", "Rear right"];

// The shadow the car casts into the wind: the hull, 36 x 40, plus each wheel's
// 10 x 28.25 rectangle - two wheels share each y band, and a shadow is a
// union, so two bands count once. 1440 + 2 * 282.5 = 2005 mm2 full, half of it
// in a half tunnel; the car is symmetric about y = 30.
const frontalFull = 0.002003756, frontalHalf = 0.001001875;

for (const symmetry of [false, true]) {
  const out = prepareTunnel(k, k.exportStep(buildCar()),
    { symmetry, up: 1.5, down: 0.5, side: 0.3, top: 0.3 }, quiet);
  k.releaseAll();
  const { meta, stats } = out;
  assert.equal(stats.valid, true);
  assert.ok(stats.removedPct > 99, `removed ${stats.removedPct}%`);
  assert.deepEqual(meta.car_wheels.map((w) => w.name).sort(), wheelNames);
  for (const w of meta.car_wheels) assert.equal(w.radius_m, 0.014125);
  // The wheels touch the ground, so the floor sits a tenth of a millimetre
  // under them.
  assert.ok(Math.abs(meta.domain.ground_z - -1e-4) < 1e-9, `ground ${meta.domain.ground_z}`);
  // The wheels the tunnel keeps: every one has faces, and those faces are
  // labelled rotating_wall in faces.json.
  assert.equal(meta.wheels.length, symmetry ? 2 : 4);
  for (const w of meta.wheels) {
    assert.ok(w.face_indices.length >= 1, `${w.name} has no faces`);
    for (const i of w.face_indices) {
      assert.equal(out.faces.faces[i].label, "rotating_wall");
      assert.equal(out.faces.faces[i].type, "cylinder");
    }
  }
  // The CSV the SimScale worker reads: one rotating_wall row per wheel void,
  // carrying the wheel's own radius.
  const rows = out.labels.split("\r\n").filter((r) => r.includes("rotating_wall"));
  assert.ok(rows.length >= (symmetry ? 2 : 4), `only ${rows.length} rotating_wall rows`);
  for (const r of rows) assert.ok(r.includes("0.014125"), `row ${r}`);
  // Reference area: measured against the analytic shadow above, and a half
  // tunnel pairs half the car with exactly half the area.
  const want = symmetry ? frontalHalf : frontalFull;
  assert.ok(Math.abs(meta.frontal_area_m2 - want) < want * 0.02,
    `frontal ${meta.frontal_area_m2}, wanted about ${want}`);
  assert.deepEqual(meta.unresolvable_faces, []);
  assert.deepEqual(meta.missing_labels, []);
  if (!symmetry) {
    assert.equal(meta.symmetry_plane_y, 0.03);
    assert.ok(Math.abs(meta.frontal_area_m2 - 2 * frontalHalf) < frontalFull * 0.001);
  }
}

// The same car, drawn facing sideways: the cut must turn it to face the wind,
// find the same wheels, and measure the same shadow.
const rotated = prepareTunnel(k,
  k.exportStep(k.rotate(buildCar(), { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } }, Math.PI / 2)),
  { symmetry: false, up: 1.5, down: 0.5, side: 0.3, top: 0.3 }, quiet);
k.releaseAll();
assert.equal(rotated.meta.rotated_deg, -90);
assert.equal(rotated.stats.valid, true);
assert.deepEqual(rotated.meta.car_wheels.map((w) => w.name).sort(), wheelNames);
assert.equal(rotated.meta.wheels.length, 4);
assert.ok(Math.abs(rotated.meta.frontal_area_m2 - frontalFull) < frontalFull * 0.02,
  `rotated frontal ${rotated.meta.frontal_area_m2}`);

// Not a STEP file at all.
assert.throws(() => prepareTunnel(k, "ISO-10303-21;\nnothing\n", { symmetry: true }, quiet), CutError);

console.log("cut-core: all checks passed");
