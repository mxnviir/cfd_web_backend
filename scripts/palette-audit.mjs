// The Workbench palette against the site's, token by token.
//
// tokens.css says it restates "the same hexes as src/styles.css", and mostly it
// does. But nothing checked, and one token had drifted: --on-accent. The site
// puts white on the accent; the Workbench had flipped it to near-black. Same
// blue, opposite text - which is why a primary button there never looked like a
// primary button on the site, and why a sign-in screen built from those tokens
// came out looking like a different product.
//
// Divergence is sometimes right. The light-theme status colours are deliberately
// darker than the site's, because the Workbench puts them on its own panels
// where the site's values measure 4.15-4.50 and fail AA - tried, measured,
// reverted. So this does not forbid divergence; it forbids *unrecorded*
// divergence. Anything not in ALLOWED below has to match.
//
// Run: node scripts/palette-audit.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Divergences with a reason. The reason is the point of the entry. */
const ALLOWED = {
  "light:--ok": "Workbench panels need a darker green; the site's 15703f is 4.15:1 there",
  "light:--warn": "as above, the site's 7a5600 is 4.50:1 on Workbench panels",
  "light:--bad": "as above, the site's b3261e is 4.40:1 on Workbench panels",
};

/** token pairs: site name -> workbench name */
const PAIRS = [
  ["--bg", "--tf-bg"], ["--panel", "--tf-panel"], ["--panel-2", "--tf-panel-2"],
  ["--rule", "--tf-rule"], ["--rule-strong", "--tf-rule-strong"],
  ["--ink", "--tf-ink"], ["--ink-2", "--tf-ink-2"], ["--ink-3", "--tf-ink-3"],
  ["--accent", "--tf-accent"], ["--accent-wash", "--tf-accent-wash"],
  ["--on-accent", "--tf-on-accent"],
  ["--accent-fill", "--tf-accent-fill"], ["--accent-fill-strong", "--tf-accent-fill-strong"],
  ["--accent-ink", "--tf-accent-ink"],
  ["--ok", "--tf-ok"], ["--warn", "--tf-warn"], ["--bad", "--tf-bad"],
];

function tokensByTheme(file) {
  const text = readFileSync(join(ROOT, file), "utf8");
  const themes = { dark: {}, light: {} };
  for (const m of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = m[1].split("\n").pop().trim();
    const body = m[2];
    const theme = /light/.test(selector) ? "light" : "dark";
    for (const d of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
      // First definition wins, which is the base theme block.
      if (!(d[1] in themes[theme])) themes[theme][d[1]] = d[2].trim();
    }
  }
  return themes;
}

const site = tokensByTheme("src/styles.css");
const wb = tokensByTheme("src/workbench/tokens.css");

const problems = [];
let checked = 0;
let excused = 0;

for (const theme of ["dark", "light"]) {
  for (const [a, b] of PAIRS) {
    const va = site[theme][a];
    const vb = wb[theme][b];
    if (va === undefined || vb === undefined) {
      problems.push(`${theme}: ${a}=${va ?? "(missing)"} / ${b}=${vb ?? "(missing)"}`);
      continue;
    }
    checked += 1;
    const same = va.replace(/\s+/g, "").toLowerCase() === vb.replace(/\s+/g, "").toLowerCase();
    if (same) continue;
    const key = `${theme}:${a}`;
    if (ALLOWED[key]) { excused += 1; continue; }
    problems.push(`${theme}: ${a} is ${va} on the site but ${b} is ${vb} in the Workbench`);
  }
}

if (problems.length) {
  console.log(`\nFAIL  ${problems.length} palette divergence(s) with no recorded reason\n`);
  for (const p of problems) console.log("   -", p);
  console.log("\n   If the difference is deliberate, add it to ALLOWED in this file");
  console.log("   with the reason - a measured one, not 'looks better'.");
  process.exit(1);
}

console.log(`palette audit: ${checked} token pairs match the site across 2 themes `
  + `(${excused} recorded divergence${excused === 1 ? "" : "s"})`);
