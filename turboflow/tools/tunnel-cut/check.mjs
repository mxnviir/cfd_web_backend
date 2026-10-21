// Self-check for cut-core.js on a car built from boxes, so it needs no
// customer CAD. Run: node check.mjs
import assert from "node:assert/strict";
import { OcctKernel } from "occt-wasm";
import { prepareTunnel, detectScale, CutError } from "./cut-core.js";

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
  const { stats, labels } = prepareTunnel(k, step,
    { symmetry, up: 1.5, down: 0.5, side: 0.3, top: 0.3 }, quiet);
  k.releaseAll();
  const want = symmetry ? carMm3 / 2 : carMm3;
  assert.ok(Math.abs(stats.removedMm3 - want) < want * 0.001,
    `${symmetry ? "half" : "full"} tunnel removed ${stats.removedMm3}, wanted ${want}`);
  for (const w of walls) assert.ok(stats.labels[w] >= 1, `no ${w} face`);
  assert.equal(stats.labels.symmetry ?? 0, symmetry ? 1 : 0);
  assert.equal(stats.valid, true);
  assert.match(labels, /^step_entity_id,label,radius_m,cx_m,cy_m,cz_m\r\n\d+,/);
}

// Not a STEP file at all.
assert.throws(() => prepareTunnel(k, "ISO-10303-21;\nnothing\n", { symmetry: true }, quiet), CutError);

console.log("cut-core: all checks passed");
