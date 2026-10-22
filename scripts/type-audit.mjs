// Font sizes typed into style objects, counted, with a ceiling that only falls.
//
// The home page was rendering thirteen distinct font sizes: 11, 12, 13, 14, 15,
// 16, 17, 18, 20, 22, 36, 65, 72. Not a scale - a pile. 15 and 16 and 17 are
// three people's guesses at "normal text", a reader cannot tell them apart, and
// a page whose sizes carry no meaning reads as a set of components that were
// built separately and put next to each other.
//
// The mechanical cause is countable: `fontSize: 15` written into an inline
// style object. Inline styles also cannot be reached by a media query, which is
// how the marketing slides ended up clipping their own text on a phone, and how
// the prose in one panel measured 87px across.
//
// So this counts them. Not zero, because src/Shell.jsx alone is 746 lines of
// generated React.createElement and converting it is a separate job from
// deciding what the sizes should be. A ceiling that only ever falls means the
// number is visible, the debt is named, and nobody adds to it by accident.
//
// Lower the numbers in BUDGET as files are converted. Raising one should take
// an argument.
//
// Run: node scripts/type-audit.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "dist-prod", "archive", ".git", "legacy", "public"]);

/**
 * What each file is still allowed.
 *
 * Every number here is a measurement, not a target: taken on 14 September
 * 2026 and lowered on 24 September, when the home, docs, billing, policy and
 * programme pages and the sidebar were rewritten on the type scale and left
 * with none. The target is zero; these are the balances outstanding.
 */
const BUDGET = {
  "src/views/SimulationsView.jsx": 25,
  "src/views/LapCalcView.jsx": 19,
  "src/components/TransactionsList.jsx": 8,
  "src/components/InlineRaceCalc.jsx": 4,
  "src/components/LapField.jsx": 3,
  "src/lib/status.js": 1,
};

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.jsx?$/.test(name)) files.push(full);
  }
})(join(ROOT, "src"));

/**
 * A hardcoded size, and not a tokenised one.
 *
 * `fontSize: 15` and `fontSize: '15px'` count. `fontSize: 'var(--fs-body)'`
 * does not, and neither does a clamp() built out of tokens, because those are
 * the scale being used rather than worked around.
 */
const HARDCODED = /fontSize:\s*(?!['"]?var\(|['"]?inherit|['"]?clamp\([^)]*var\()([0-9]+(?:\.[0-9]+)?|['"][^'"]*['"])/g;

const found = new Map();
const sizes = new Map();
let total = 0;

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const src = readFileSync(file, "utf8");
  const hits = [...src.matchAll(HARDCODED)];
  if (!hits.length) continue;
  found.set(rel, hits.length);
  total += hits.length;
  for (const h of hits) {
    const v = h[1].replace(/['"]/g, "");
    sizes.set(v, (sizes.get(v) ?? 0) + 1);
  }
}

const over = [];
const unlisted = [];
for (const [file, n] of [...found.entries()].sort((a, b) => b[1] - a[1])) {
  const allowed = BUDGET[file];
  if (allowed === undefined) unlisted.push([file, n]);
  else if (n > allowed) over.push([file, n, allowed]);
}

// A budget for a file that no longer has any is a budget to delete.
const stale = Object.keys(BUDGET).filter((f) => !found.has(f));

console.log(`type audit: ${total} hardcoded font sizes across ${found.size} files`);
const distinct = [...sizes.entries()].sort((a, b) => Number(a[0]) - Number(b[0]));
console.log(`  ${distinct.length} distinct values: ${distinct.map(([v, n]) => `${v}(${n})`).join(" ")}`);

if (process.argv.includes("--list")) {
  for (const [file, n] of [...found.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${file}`);
  }
}

if (!over.length && !unlisted.length) {
  const worst = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log(`  worst offenders: ${worst.map(([f, n]) => `${f} (${n})`).join(", ")}`);
  if (stale.length) {
    console.log(`  note  ${stale.length} budget line(s) now unused and can be deleted: ${stale.slice(0, 3).join(", ")}`);
  }
  process.exit(0);
}

console.log("");
for (const [file, n, allowed] of over) {
  console.log(`  OVER    ${file}: ${n} hardcoded sizes, budget ${allowed}`);
  console.log("          Use a class from src/type.css, or raise the budget with a reason.");
}
for (const [file, n] of unlisted) {
  console.log(`  NEW     ${file}: ${n} hardcoded size(s), and no budget line.`);
  console.log("          Use src/type.css. If it genuinely cannot, add a budget line.");
}
process.exit(1);
