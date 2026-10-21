// The browser cut, run in Node on the same engine, to compare against the
// server's cadquery cut (reference.py) without a browser in the way.
// Run: node run-node.mjs <car.step> [--full]
import { readFileSync, writeFileSync } from "node:fs";
import { OcctKernel } from "occt-wasm";
import { prepareTunnel } from "./cut-core.js";

const [file, ...flags] = process.argv.slice(2);
const options = { symmetry: !flags.includes("--full"), up: 1.5, down: 0.5, side: 0.3, top: 0.3 };
const k = await OcctKernel.init();
const t0 = performance.now();
let last = t0;
const out = prepareTunnel(k, readFileSync(file, "utf8"), options, (stage, text) => {
  const now = performance.now();
  console.error(`${((now - t0) / 1000).toFixed(1).padStart(6)}s  (+${((now - last) / 1000).toFixed(1)})  ${stage}: ${text}`);
  last = now;
});
out.stats.seconds = +((performance.now() - t0) / 1000).toFixed(1);
out.stats.heapMB = Math.round(k.getRawModule().HEAP32.buffer.byteLength / 2 ** 20);
console.log(JSON.stringify(out.stats, null, 1));
if (flags.includes("--write")) {
  writeFileSync("out-geometry.step", out.step);
  writeFileSync("out-entity_labels.csv", out.labels);
}
