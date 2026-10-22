// The comparison delta is the number a team acts on: "did that change make the
// car faster". Getting the sign backwards would tell them to keep the worse
// design, so it is worth pinning down properly.
//
// deltaHtml is lifted straight out of workbench.html.
// Reads public/workbench-classic.html, the hand-written Workbench this
// build replaced. Kept while that file is still shipped; it goes when the
// classic page does (build spec section 15, step 15), and the charts it
// covers are tested against src/workbench/runs/Plot.jsx after that.
import { readFileSync } from "node:fs";
import assert from "node:assert";

const html = readFileSync(new URL("../legacy/workbench-classic.html", import.meta.url), "utf8");
const js = [...html.matchAll(/<script(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).find((b) => b.includes("function deltaHtml"));
assert(js, "deltaHtml not found in workbench.html");

const start = js.indexOf("function deltaHtml");
const bodyAt = js.indexOf(") {", start);
let src;
for (let k = bodyAt + 2, depth = 0; k < js.length; k++) {
  if (js[k] === "{") depth++;
  else if (js[k] === "}" && --depth === 0) { src = js.slice(start, k + 1); break; }
}
const { deltaHtml } = await import(
  "data:text/javascript," + encodeURIComponent(src + "\nexport { deltaHtml };"));

const cls = (h) => (h.match(/class="(\w+)"/) || [])[1];
const pct = (h) => parseFloat((h.match(/ ([+-]?[\d.]+)%/) || [])[1]);

// Drag is negative in this solver's convention: -0.19 N is MORE drag than -0.17.
const baseDrag = -0.17308;
const worse = deltaHtml(-0.19333, baseDrag);
assert.equal(cls(worse), "bad", `more drag should read bad, got: ${worse}`);
assert.ok(pct(worse) > 11 && pct(worse) < 12, `expected ~+11.7%, got ${pct(worse)}`);

const better = deltaHtml(-0.15, baseDrag);
assert.equal(cls(better), "good", `less drag should read good, got: ${better}`);
assert.ok(pct(better) < 0, "an improvement must be negative");

// Same magnitudes, opposite signs, must not read as a 200% change.
assert.equal(cls(deltaHtml(0.17308, baseDrag)), "muted",
  "equal magnitude with flipped sign should be neutral");
assert.match(deltaHtml(0.17308, baseDrag), /±0%/);

// Positive convention behaves identically.
assert.equal(cls(deltaHtml(1.2, 1.0)), "bad");
assert.equal(cls(deltaHtml(0.8, 1.0)), "good");
assert.ok(Math.abs(pct(deltaHtml(1.2, 1.0)) - 20) < 1e-9);

// Nothing to compare against, or nonsense in: no output, no crash.
for (const [v, b] of [[null, 1], [1, null], [1, 0], [NaN, 1], [1, Infinity]]) {
  assert.equal(deltaHtml(v, b), "", `expected empty for (${v}, ${b})`);
}

// Noise below 0.05% is not a result.
assert.match(deltaHtml(1.0002, 1.0), /±0%/);

console.log("ok - comparison deltas read correctly for both sign conventions");
