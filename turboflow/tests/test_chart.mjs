// Render the workbench's convergence and force charts with the real payload
// from run 376ccaaf, straight out of workbench.html â€” not a copy of the code.
// Reads public/workbench-classic.html, the hand-written Workbench this
// build replaced. Kept while that file is still shipped; it goes when the
// classic page does (build spec section 15, step 15), and the charts it
// covers are tested against src/workbench/runs/Plot.jsx after that.
import { readFileSync } from "node:fs";
import assert from "node:assert";

const html = readFileSync(new URL("../legacy/workbench-classic.html", import.meta.url), "utf8");
const js = [...html.matchAll(/<script(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).find((b) => b.includes("function lineChart"));
assert(js, "lineChart not found in workbench.html");

// Pull just the pieces the chart needs, so nothing browser-only has to run.
const grab = (name, kind = "function") => {
  const start = js.indexOf(`${kind} ${name}`);
  assert(start >= 0, `${name} missing`);
  // start after the parameter list, or a destructured default like { log = false }
  // is mistaken for the body
  const bodyAt = js.indexOf(") {", start);
  assert(bodyAt > start, `${name}: could not find body`);
  for (let k = bodyAt + 2, depth = 0; k < js.length; k++) {
    if (js[k] === "{") depth++;
    else if (js[k] === "}" && --depth === 0) return js.slice(start, k + 1);
  }
  throw new Error(`unbalanced ${name}`);
};
const src = [
  js.match(/const SERIES_COLOURS = \[[^\]]*\];/)[0],
  "const esc = (v) => String(v ?? '').replace(/[&<>\"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));",
  grab("lineChart"),
  "export { lineChart };",
].join("\n");
const { lineChart } = await import("data:text/javascript," + encodeURIComponent(src));

const plots = JSON.parse(readFileSync(new URL("./plots.json", import.meta.url), "utf8"));

// convergence: 6 residual series, log scale
const conv = lineChart(
  Object.entries(plots.residuals.series).map(([name, values]) => ({ name, values })),
  plots.residuals.iterations, { log: true });
const forces = lineChart(
  [{ name: "Drag (X)", values: plots.forces.drag }, { name: "Lift (Z)", values: plots.forces.lift }],
  plots.forces.iterations, { unit: "newtons" });

for (const [label, svg, expectPaths] of [["convergence", conv, 6], ["forces", forces, 2]]) {
  assert(!/NaN|Infinity|undefined/.test(svg), `${label}: non-finite coordinate in output`);
  const paths = [...svg.matchAll(/<path /g)].length;
  assert.equal(paths, expectPaths, `${label}: ${paths} paths, expected ${expectPaths}`);
  // every plotted point must sit inside the viewBox
  for (const m of svg.matchAll(/([\d.\-e]+),([\d.\-e]+)/g)) {
    const [x, y] = [parseFloat(m[1]), parseFloat(m[2])];
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    assert(x >= 0 && x <= 720 && y >= 0 && y <= 170, `${label}: point off canvas ${x},${y}`);
  }
  console.log(`${label}: ${paths} series, ${svg.length} bytes of SVG`);
}

// log axis must actually span the residual decades
const decades = [...conv.matchAll(/1e(-?\d+)/g)].map((m) => +m[1]);
assert(Math.min(...decades) <= -3, `log axis only reaches 1e${Math.min(...decades)}`);
console.log(`log axis: 1e${Math.max(...decades)} down to 1e${Math.min(...decades)}`);
console.log("ok - charts render from real solver output");

