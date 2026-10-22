// How a CFD result is written down, and what it is compared against.
//
// The run panel put every figure through `Number(value).toPrecision(4)`.
// Significant figures are a property of the number, not of the quantity, so:
//
//     drag  0.127  ->  "0.1270"    a digit the solve does not support
//     Cd    0.352  ->  "0.3520"
//     drag  1.4    ->  "1.400"
//
// and a column of runs did not line up, because four significant figures is a
// different number of decimal places for every value. A team comparing two
// runs was counting characters.
//
// The comparison half matters as much. "Lower is better" is true of drag and
// of Cd and is not true of lift: downforce is negative lift, and a team may be
// chasing either. Colouring a lift change green because it went down would be
// congratulating somebody for the opposite of what they were trying to do.
//
// Run: node tests/test_quantities.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/lib/quantities.js"), "utf8");
const {
  formatQuantity, unitOf, labelOf, compareQuantity, describeChange,
  HEADLINE, SECONDARY, MIRRORED, QUANTITIES,
} = await import("data:text/javascript;base64," + Buffer.from(src, "utf8").toString("base64"));

let checks = 0;
const failures = [];
const eq = (what, got, want) => {
  checks += 1;
  if (got !== want) failures.push(`${what}\n     got      ${JSON.stringify(got)}\n     expected ${JSON.stringify(want)}`);
};
const ok = (what, cond, detail) => {
  checks += 1;
  if (!cond) failures.push(detail ? `${what}: ${detail}` : what);
};

// ── the figures a real run produced ────────────────────────────────────────
// 0.127 N is the drag off Run 4 of the customer car in this repo's history.
eq("drag keeps three places and no more", formatQuantity(0.127, "drag"), "0.127");
eq("and does not grow a digit it has not earned", formatQuantity(1.4, "drag"), "1.400");
eq("a whole-car drag doubled from a half model", formatQuantity(0.254, "drag"), "0.254");
eq("Cd to three places", formatQuantity(0.352, "cd"), "0.352");
eq("lift keeps its sign", formatQuantity(-0.25, "lift"), "-0.250");
eq("a pitching moment gets a fourth place", formatQuantity(1.2, "pitch"), "1.2000");

// The old behaviour, written down so the difference is on the record.
eq("toPrecision(4) would have said", (0.127).toPrecision(4), "0.1270");
ok("and the new formatter does not", formatQuantity(0.127, "drag") !== (0.127).toPrecision(4));

// ── decimal points line up, which is the whole point of a column ───────────
const column = [0.127, 1.4, 12.5, 0.008].map((v) => formatQuantity(v, "drag"));
const places = column.map((s) => s.split(".")[1]?.length ?? 0);
ok("every force has the same number of decimal places",
  new Set(places).size === 1, JSON.stringify(column));

// ── the edges ──────────────────────────────────────────────────────────────
eq("zero is a number, not a dash", formatQuantity(0, "drag"), "0.000");
eq("a side force that cancelled exactly", formatQuantity(0, "side"), "0.000");
eq("nothing at all", formatQuantity(null, "drag"), "-");
eq("not a number", formatQuantity(NaN, "drag"), "-");
eq("a string that is not a number", formatQuantity("banana", "drag"), "-");
eq("infinity", formatQuantity(Infinity, "drag"), "-");
// A lift of 0.000365 N on a 250 mm car is zero. It used to print as "3.65e-4"
// in a column beside "0.127", which broke the decimal alignment that tabular
// figures are there to create and claimed three figures the solve cannot
// support. Rounding to the quantity's own resolution is the honest answer.
eq("a force below the reported resolution rounds to zero",
  formatQuantity(0.000365, "lift"), "0.000");
eq("and so does a moment", formatQuantity(0.00001, "pitch"), "0.0000");
ok("nothing small goes exponential and breaks the column",
  !/e/.test(formatQuantity(0.0000004, "drag")), formatQuantity(0.0000004, "drag"));
ok("and something absurdly large does too",
  /e\+/.test(formatQuantity(5e9, "drag")), formatQuantity(5e9, "drag"));
eq("an unknown key still formats rather than throwing",
  formatQuantity(1.5, "whatever"), "1.500");

// ── units ──────────────────────────────────────────────────────────────────
eq("force is newtons", unitOf("drag"), "N");
eq("a moment is newton-metres", unitOf("pitch"), "N m");
eq("a coefficient has no unit", unitOf("cd"), "");
eq("and is not given one", unitOf("cl"), "");
eq("side force is named in full", labelOf("side"), "Side force");

// ── which figures lead ─────────────────────────────────────────────────────
ok("drag and Cd lead", HEADLINE.includes("drag") && HEADLINE.includes("cd"));
ok("and nothing else does", HEADLINE.length === 2, JSON.stringify(HEADLINE));
ok("lift and Cl support them",
  SECONDARY.includes("lift") && SECONDARY.includes("cl"));
ok("the three that mirror out are kept apart",
  MIRRORED.join() === ["side", "roll", "yaw"].join(), JSON.stringify(MIRRORED));
ok("no quantity is in two groups at once",
  new Set([...HEADLINE, ...SECONDARY, ...MIRRORED]).size
  === HEADLINE.length + SECONDARY.length + MIRRORED.length);

// ── this run against the last one ──────────────────────────────────────────
const better = compareQuantity(0.119, 0.127, "drag");
ok("drag going down is an improvement", better.direction === "better", better.direction);
ok("and the size of it is the difference",
  Math.abs(better.delta + 0.008) < 1e-9, String(better.delta));
ok("with a percentage of the old value",
  Math.abs(better.percent + 6.2992) < 0.001, String(better.percent));

const worse = compareQuantity(0.135, 0.127, "drag");
eq("drag going up is not", worse.direction, "worse");
eq("Cd going down is an improvement too", compareQuantity(0.34, 0.352, "cd").direction, "better");

// The one that matters. Downforce is negative lift; a team chasing downforce
// wants lift to fall, and a team chasing straight-line speed may not. The
// product does not know which, so it does not say.
eq("lift going down is not called an improvement",
  compareQuantity(-0.3, -0.25, "lift").direction, "neutral");
eq("nor going up", compareQuantity(-0.2, -0.25, "lift").direction, "neutral");
eq("nor is Cl", compareQuantity(0.1, 0.2, "cl").direction, "neutral");
ok("only drag and Cd claim a direction",
  Object.entries(QUANTITIES).filter(([, q]) => q.better).map(([k]) => k).join() === "drag,cd");

// ── no previous run is not the same as no change ───────────────────────────
eq("no previous value", compareQuantity(0.127, null, "drag"), null);
eq("no current value", compareQuantity(null, 0.127, "drag"), null);
eq("neither", compareQuantity(undefined, undefined, "drag"), null);
const same = compareQuantity(0.127, 0.127, "drag");
eq("an identical result is no change", same.direction, "neutral");
eq("and its delta is zero", same.delta, 0);

// A previous value of zero cannot give a percentage, and must not give
// Infinity: "drag is Infinity% higher" has appeared on real dashboards.
const fromZero = compareQuantity(0.5, 0, "drag");
eq("a percentage of zero is not a number, so there is none", fromZero.percent, null);
ok("but the absolute change is still there", fromZero.delta === 0.5);

// ── what a screen reader is told ───────────────────────────────────────────
ok("the change is a sentence, not an arrow",
  describeChange(better).includes("lower") && describeChange(better).includes("N"),
  describeChange(better));
ok("and it names the run it is against",
  describeChange(better).includes("previous run"), describeChange(better));
eq("nothing to describe", describeChange(null), "");

console.log(failures.length ? "" : `quantities: ${checks} checks, results read like measurements`);
if (failures.length) {
  console.log(`\nFAIL  ${failures.length} of ${checks}\n`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
