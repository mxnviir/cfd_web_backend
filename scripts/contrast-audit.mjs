// Text that cannot be read against the thing behind it.
//
// Found three of these by hand on 11 Sep 2026, the worst being the account
// avatar: a white initial on the "ok" green, at 1.6:1. The green is a status
// colour doing decorative work, and on the dark theme it is the light half of
// the pair, so the white on top of it disappeared. Nothing would have caught
// it, because it only goes wrong in one of the two themes.
//
// Static, so it runs without a browser: every rule that sets both a colour and
// a background is resolved against each theme's palette and measured.
//
// Usage: node scripts/contrast-audit.mjs [--json]
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// Two sets of stylesheets with their own palettes. The site's pages were not
// measured at all until 24 Sep 2026, which is how every primary button on the
// dark theme shipped as white on #4a90d9, 3.3:1: the Workbench had already
// found that and filled its buttons a deeper blue, and the site never did.
const SUITES = [{
  files: ["src/workbench/tokens.css", "src/workbench/workbench.css", "src/dashboard/dashboard.css"],
  dark: (sel) => sel === ".wb, .db",
  light: (sel) => /\[data-theme="light"\]/.test(sel),
  media: (sel) => /:root:not\(\[data-theme="dark"\]\)/.test(sel),
  page: "--tf-panel",
}, {
  files: ["src/styles.css", "src/type.css", "src/buttons.css", "src/chrome.css", "src/pages.css"],
  // Exact matches, so the print stylesheet's own :root block is not taken
  // for a theme.
  dark: (sel) => sel === ":root",
  light: (sel) => sel === ':root[data-theme="light"]',
  media: (sel) => sel === ':root:not([data-theme="dark"])',
  page: "--panel",
}];

// Comments go first. Without this the block regex swallows the comment sitting
// above a rule into that rule's selector, `.wb, .db` never matches, every
// colour resolves to null and the audit passes by finding nothing at all. It
// did exactly that on its first run, and reported a clean sheet on a file that
// still had the 1.6:1 avatar in it.
for (const suite of SUITES) {
  const css = suite.files.map((f) => readFileSync(ROOT + f, "utf8")).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  suite.blocks = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    // A selector never contains a semicolon, so anything up to the last one
    // is a statement before it: the @import lines above :root in styles.css
    // were being read as part of its selector, and the dark palette came out
    // empty.
    .map(([, sel, body]) => ({ sel: sel.replace(/^[\s\S]*;/, "").replace(/\s+/g, " ").trim(), body }));
}

/** The custom properties one theme's block sets. */
function palette(suite, which) {
  const out = {};
  for (const { sel, body } of suite.blocks) {
    if (!suite[which](sel)) continue;
    for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  }
  return out;
}

/** Resolve var() chains, giving up rather than guessing. */
function resolve(value, vars, depth = 0) {
  if (!value || depth > 12) return null;
  const m = value.trim().match(/^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (!m) return value.trim();
  const next = vars[m[1]] ?? m[2];
  return next ? resolve(next, vars, depth + 1) : null;
}

function parse(colour, vars) {
  if (!colour) return null;

  // color-mix(in srgb, X 16%, transparent) is how the run status strips paint
  // a wash of their own status colour. The audit could not read it, skipped
  // those rules, and missed "Finished" at 4.1:1 on the light theme.
  const mix = colour.match(/^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/i);
  if (mix) {
    const a = parse(resolve(mix[1], vars || {}), vars);
    const pct = Number(mix[2]) / 100;
    const bTxt = mix[3].trim();
    const b = bTxt === "transparent"
      ? { r: 0, g: 0, b: 0, a: 0 }
      : parse(resolve(bTxt, vars || {}), vars);
    if (!a || !b) return null;
    return {
      r: a.r * pct + b.r * (1 - pct),
      g: a.g * pct + b.g * (1 - pct),
      b: a.b * pct + b.b * (1 - pct),
      a: (a.a ?? 1) * pct + (b.a ?? 1) * (1 - pct),
    };
  }
  if (colour === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = colour.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = colour.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = colour.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.every((v) => !Number.isNaN(v))) {
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    }
  }
  if (colour === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (colour === "black") return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

const over = (fg, bg) => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
  a: 1,
});

const lum = (c) => {
  const f = [c.r, c.g, c.b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
};

const ratio = (a, b) => {
  const la = lum(a);
  const lb = lum(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
};

const THEMES = ["dark", "light", "light-system"];
const failures = [];
let pairs = 0;

for (const suite of SUITES) for (const theme of THEMES) {
  const own = palette(suite, theme === "dark" ? "dark" : theme === "light" ? "light" : "media");
  // A light block only restates what changes, so it stands on the dark one.
  const vars = theme === "dark" ? own : { ...palette(suite, "dark"), ...own };
  const page = parse(resolve(vars[suite.page], vars), vars) || { r: 30, g: 30, b: 30, a: 1 };

  for (const { sel, body } of suite.blocks) {
    if (sel.includes("--") || !sel) continue;
    const fgRaw = body.match(/(?:^|;|\s)color\s*:\s*([^;]+)/);
    const bgRaw = body.match(/(?:^|;|\s)background(?:-color)?\s*:\s*([^;]+)/);
    if (!fgRaw || !bgRaw) continue;
    const fg = parse(resolve(fgRaw[1], vars), vars);
    const bgc = parse(resolve(bgRaw[1], vars), vars);
    if (!fg || !bgc) continue;
    pairs++;

    const bg = bgc.a < 1 ? over(bgc, page) : bgc;
    // The Workbench sets 12px and 13px text; nothing in it is "large text",
    // so AA is 4.5:1 throughout.
    const cr = ratio(fg.a < 1 ? over(fg, bg) : fg, bg);
    if (cr < 4.5) failures.push({ theme, selector: sel.slice(0, 60), ratio: +cr.toFixed(2) });
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(failures, null, 1));
} else if (failures.length) {
  console.log(`contrast audit: ${failures.length} failing pairs of ${pairs} (AA needs 4.5:1)\n`);
  for (const f of failures) console.log(`  [${f.theme}] ${f.selector}  ${f.ratio}:1`);
} else {
  console.log(`contrast audit: all ${pairs} colour-on-background pairs pass AA across ${THEMES.length} themes`);
}
process.exit(failures.length ? 1 : 0);
