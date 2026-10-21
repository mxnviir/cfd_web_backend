// The stored plot shape must be drawable by the chart that draws it.
//
// tests/test_chart.mjs passes, and it tests a different renderer. The React
// Plot component wants { name: [[x, y], ...] }; export_plots writes parallel
// arrays sharing one iteration axis. Nothing converted between them, so the
// run panel threw "is not iterable" and the whole panel fell to the error
// boundary the first time a run ever got far enough to have plots at all.
//
// tests/plots.json is a real capture from a completed SimScale run, so this
// asserts against the shape the backend actually produces.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plots = JSON.parse(readFileSync(join(root, "tests/plots.json"), "utf8"));

// The adapter lives in RunPanel.jsx next to the component it feeds. Sliced out
// rather than imported, because importing the module pulls in React and the
// Firebase client for two pure functions.
const src = readFileSync(join(root, "src/workbench/runs/RunPanel.jsx"), "utf8");
const cut = (name) => {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} is gone from RunPanel.jsx`);
  let depth = 0;
  let i = src.indexOf("{", at);
  const start = i;
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") { depth -= 1; if (!depth) break; }
  }
  return src.slice(at, i + 1).replace(/^function /, "function ") + "\n";
};
const mod = await import(
  "data:text/javascript," + encodeURIComponent(
    cut("toPairs") + cut("groupSeries") + cut("residualSeries") +
    "export { toPairs, groupSeries, residualSeries };"));

const fails = [];
const check = (what, ok, detail) => { if (!ok) fails.push(what + (detail ? ": " + detail : "")); };

/** Exactly what Plot's model loop does, which is where it threw. */
function drawable(series) {
  const names = Object.keys(series || {});
  if (!names.length) return "no series";
  for (const n of names) {
    if (!Array.isArray(series[n])) return `${n} is not an array`;
    for (const point of series[n]) {
      if (!Array.isArray(point) || point.length < 2) return `${n} holds ${typeof point}, not a pair`;
      const [x, y] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return `${n} has a non-finite pair`;
    }
  }
  return null;
}

// ── residuals, six series on one iteration axis ────────────────────────────
const residuals = mod.residualSeries(plots.residuals);
check("residuals convert", !!residuals);
check("residuals are drawable", drawable(residuals) === null, drawable(residuals));
check("one series per solved variable",
      Object.keys(residuals).length === Object.keys(plots.residuals.series).length,
      `${Object.keys(residuals).length} of ${Object.keys(plots.residuals.series).length}`);

// ── forces ─────────────────────────────────────────────────────────────────
const forces = mod.groupSeries(plots.forces, [["drag", "Drag"], ["lift", "Lift"], ["side", "Side"]]);
check("forces convert", !!forces);
check("forces are drawable", drawable(forces) === null, drawable(forces));
check("side is dropped when the solver wrote none", !("Side" in forces));
check("drag keeps its points",
      forces.Drag.length === plots.forces.drag.filter(Number.isFinite).length,
      `${forces.Drag.length} points`);
check("the x axis is the iteration number",
      forces.Drag[0][0] === plots.forces.iterations[0],
      `${forces.Drag[0][0]} vs ${plots.forces.iterations[0]}`);

// ── moments, which nothing drew until now ──────────────────────────────────
const moments = mod.groupSeries(
  { iterations: [1, 2, 3], roll: [0.1, 0.2, 0.3], pitch: [1, 1.1, 1.2], yaw: [0, 0, 0] },
  [["roll", "Roll"], ["pitch", "Pitch"], ["yaw", "Yaw"]]);
check("moments are drawable", drawable(moments) === null, drawable(moments));

// ── the shapes that threw ──────────────────────────────────────────────────
check("a raw stored block is not passed through",
      drawable(plots.forces) !== null,
      "the un-adapted shape must still be rejected, or this test proves nothing");
check("no plots at all", mod.groupSeries(null, [["drag", "Drag"]]) === null);
check("a block with no matching key", mod.groupSeries({ iterations: [1] }, [["drag", "Drag"]]) === null);
check("a ragged series stops at its own end",
      mod.groupSeries({ iterations: [1, 2, 3], drag: [1, 2] }, [["drag", "Drag"]]).Drag.length === 2);
check("nulls in a series are dropped, not drawn",
      mod.groupSeries({ iterations: [1, 2, 3], drag: [1, null, 3] }, [["drag", "Drag"]]).Drag.length === 2);

if (fails.length) {
  console.log("plot shape: FAILED");
  for (const f of fails) console.log("  " + f);
  process.exit(1);
}
console.log("plot shape: 14 checks, stored plots reach the chart as drawable pairs");
