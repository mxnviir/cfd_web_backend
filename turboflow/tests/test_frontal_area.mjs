// A flow domain's shadow is the tunnel, not the car.
//
// "Frontal area" is the area of the imported model's shadow. For a bare car
// that is the car. For the flow region TurboFlow actually runs - a tunnel box
// with the car subtracted - it is the tunnel's cross-section, 0.125 m2 on the
// test model, which is the inlet face.
//
// It was prefilled straight into the reference area of a forces-and-moments
// result control, so a team enabling coefficients would have divided their
// drag by the tunnel and quoted a Cd wrong by the ratio of tunnel to car. Cd
// is the number they compete on.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/workbench/panels/setup.jsx"), "utf8");

// Cut the function out by brace matching: importing the module would pull in
// React and the whole panel tree for one piece of arithmetic.
const at = src.indexOf("export function isFlowDomain(");
if (at < 0) throw new Error("isFlowDomain is gone from setup.jsx");
let depth = 0;
let i = src.indexOf("{", at);
for (; i < src.length; i += 1) {
  if (src[i] === "{") depth += 1;
  else if (src[i] === "}") { depth -= 1; if (!depth) break; }
}
const { isFlowDomain } = await import(
  "data:text/javascript," + encodeURIComponent(src.slice(at, i + 1)));

const fails = [];
const check = (what, got, want) => { if (got !== want) fails.push(`${what}: got ${got}, wanted ${want}`); };

// The real test car's flow region, straight off its geometry document.
const flowRegion = {
  frontal_area_m2: 0.12534625,
  bbox: { size: [2.2198871031073333, 0.34256466839067207, 0.3725085180533332] },
};
check("the test flow region is a domain", isFlowDomain(flowRegion), true);

// An F1-in-Schools car: 210 x 70 x 50 mm, and its shadow is about half of the
// 0.0035 m2 its bounding box presents. (The first draft of this fixture said
// 0.0125 m2, which is larger than the bounding box itself and so impossible.)
const car = { frontal_area_m2: 0.0018, bbox: { size: [0.21, 0.07, 0.05] } };
check("a bare car is not a domain", isFlowDomain(car), false);

// Right at the edge of the test, either side.
check("just under the threshold is a car",
  isFlowDomain({ frontal_area_m2: 0.89, bbox: { size: [1, 1, 1] } }), false);
check("just over the threshold is a domain",
  isFlowDomain({ frontal_area_m2: 0.91, bbox: { size: [1, 1, 1] } }), true);

// Nothing to judge on must never claim it is a domain, because claiming it
// blanks the user's reference area.
check("no version", isFlowDomain(null), false);
check("no bbox", isFlowDomain({ frontal_area_m2: 0.1 }), false);
check("no area", isFlowDomain({ bbox: { size: [1, 1, 1] } }), false);
check("area zero", isFlowDomain({ frontal_area_m2: 0, bbox: { size: [1, 1, 1] } }), false);
check("a flat bbox cannot be divided by",
  isFlowDomain({ frontal_area_m2: 0.1, bbox: { size: [1, 0, 1] } }), false);
check("a short size array",
  isFlowDomain({ frontal_area_m2: 0.1, bbox: { size: [1, 1] } }), false);
check("size is not an array",
  isFlowDomain({ frontal_area_m2: 0.1, bbox: { size: "1,1,1" } }), false);

if (fails.length) {
  console.log("frontal area: FAILED");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
console.log("frontal area: 11 checks, a tunnel is not mistaken for a car");
