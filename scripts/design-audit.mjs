// Checks the build against DESIGN_RULES.md.
//
// Section 5 of those rules says to run a review on every page before merge, and
// a checklist nobody can run is a checklist nobody runs. This is the mechanical
// part of it: the bans that are a matter of fact rather than taste. Whether a
// heading is vague is not something a script can tell you; whether the page
// loads Inter is.
//
// Usage: node scripts/design-audit.mjs [--json]
// Exit code is 1 when anything fails, so it can gate a merge.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// legacy/ is the old single-file Workbench, kept for reference: not built, not served.
const SKIP = new Set(["node_modules", "dist", "dist-prod", "archive", ".git", "scripts", "docs", "functions", "services", "legacy"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if ([".html", ".css", ".js", ".jsx"].includes(extname(name))) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => p.slice(ROOT.length).replace(/\\/g, "/");

// Comments are exempt from the copy rules: a rule about how the site reads is
// about what a visitor reads, and stripping prose out of an explanation makes
// the code worse to no one's benefit.
function stripComments(src, isCss) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  if (!isCss) out = out.replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  return out;
}

const fails = [];
const add = (rule, detail, count, where) => count && fails.push({ rule, detail, count, where });

const tally = (re, { code = false, cssOnly = false } = {}) => {
  const hits = new Map();
  let total = 0;
  for (const f of files) {
    const isCss = extname(f) === ".css";
    if (cssOnly && !isCss && extname(f) !== ".html") continue;
    const src = code ? read(f) : stripComments(read(f), isCss);
    const n = (src.match(re) || []).length;
    if (n) { hits.set(rel(f), n); total += n; }
  }
  return { total, where: [...hits.keys()].join(", ") };
};

// 1.10 Tooling: no Tailwind.
{
  const cfg = ["tailwind.config.js", "tailwind.config.cjs", "tailwind.config.ts"]
    .filter((f) => existsSync(join(ROOT, f)));
  add("1.10", "tailwind config present", cfg.length, cfg.join(", "));
  const pkg = existsSync(join(ROOT, "package.json")) ? read(join(ROOT, "package.json")) : "";
  add("1.10", "tailwindcss in package.json", /"tailwindcss"\s*:/.test(pkg) ? 1 : 0, "package.json");
  const dir = tally(/@(tailwind|apply)\b/g, { code: true });
  add("1.10", "tailwind directives in CSS", dir.total, dir.where);
}

// 1.4 Typography: banned faces.
{
  const banned = ["Inter", "Space Grotesk", "DM Sans", "Manrope", "Plus Jakarta Sans",
                  "Poppins", "Outfit", "Geist", "Satoshi"];
  // Comments are stripped here: a note explaining that the site used to be on
  // Inter is not the site being on Inter, and the alternative is code that
  // cannot explain its own history.
  for (const face of banned) {
    const t = tally(new RegExp(`["'\\s:]${face.replace(/ /g, "[+ ]")}["',;\\s]`, "g"));
    add("1.4", `banned typeface: ${face}`, t.total, t.where);
  }
}

// 1.2 Shape and surface.
{
  const dots = tally(/radial-gradient\([^)]*\)[^;]*background-size|dot-?grid/gi, { code: true });
  add("1.2", "dot grid background", dots.total, dots.where);
  const blur = tally(/backdrop-filter\s*:|backdropFilter\s*:|backdrop-blur/g, { code: true });
  add("1.2", "backdrop blur / glassmorphism", blur.total, blur.where);

  // One radius, or none. Tokens are counted once each, so a design system with
  // --r1/--r2/--r3 reads as three values however often they are used.
  const radii = new Set();
  for (const f of files) {
    if (![".css", ".html"].includes(extname(f))) continue;
    for (const m of read(f).matchAll(/border-radius\s*:\s*([^;{}]+)/g)) {
      for (const v of m[1].matchAll(/(\d+(?:\.\d+)?)px/g)) if (+v[1] > 0) radii.add(+v[1]);
    }
    for (const m of read(f).matchAll(/--r[a-z0-9-]*\s*:\s*(\d+(?:\.\d+)?)px/g)) {
      if (+m[1] > 0) radii.add(+m[1]);
    }
  }
  // React style objects, which is where most of them were hiding: the check
  // read stylesheets only, and eighty-three inline radii across fourteen
  // values went straight past it. 50% is a circle, not a corner.
  for (const f of files) {
    for (const m of read(f).matchAll(/borderRadius:\s*([^,}\n]+)/g)) {
      if (m[1].includes("%")) continue;
      for (const v of m[1].matchAll(/(\d+(?:\.\d+)?)(?:px)?\b/g)) if (+v[1] > 0) radii.add(+v[1]);
    }
  }
  add("1.2 / 3.4", `distinct corner radii: [${[...radii].sort((a, b) => a - b)}]`,
      radii.size > 2 ? radii.size : 0, "styles.css, *.html");

  // Shadows are allowed on things that actually float. A script cannot tell a
  // dialog from a button, so the rule is enforced through the token instead:
  // `box-shadow: var(--shadow-*)` is a deliberate, named, reviewable decision,
  // and a raw value pasted onto a hover state is what the ban is aimed at.
  //
  // Read the value and test it, rather than putting a negative lookahead after
  // `\s*`: the star can match nothing, the lookahead then reads the space
  // instead of the value, and every tokenised shadow gets reported. It did.
  let shTotal = 0;
  const shWhere = [];
  for (const f of files) {
    let n = 0;
    for (const m of read(f).matchAll(/box-shadow\s*:\s*([^;}]+)/gi)) {
      const v = m[1].trim();
      if (!/^(none|var\(--shadow)/.test(v)) n++;
    }
    for (const m of read(f).matchAll(/boxShadow\s*:\s*['"]([^'"]+)/g)) {
      if (!/^(none|var\(--shadow)/.test(m[1].trim())) n++;
    }
    if (n) { shTotal += n; shWhere.push(rel(f)); }
  }
  add("1.2", "untokenised box-shadow (shadows are for things that float)",
      shTotal, shWhere.join(", "));
}

// 1.1 Color: no gradients.
{
  let gTotal = 0;
  const gWhere = [];
  for (const f of files) {
    const lines = read(f).split("\n");
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!/(linear|radial|conic)-gradient\(/.test(lines[i])) continue;
      // The marker may sit on the line above, because a long colour-stop list
      // wraps and the declaration it justifies does not start where it does.
      if (/design:\s*data/.test(lines[i]) || /design:\s*data/.test(lines[i - 1] || "")) continue;
      n++;
    }
    if (n) { gTotal += n; gWhere.push(rel(f)); }
  }
  add("1.1", "decorative gradient declarations", gTotal, gWhere.join(", "));
}

// 1.7 Copy: no em dashes, no banned words, in what a visitor reads.
{
  const dash = tally(/\u2014|\\u2014|&mdash;|&#8212;/g);
  add("1.7", "em dashes outside comments", dash.total, dash.where);
  const WORDS = ["seamless", "effortless", "effortlessly", "supercharge", "unlock",
                 "streamline", "empower", "elevate", "leverage", "robust",
                 "cutting-edge", "next-gen", "revolutionize", "game-changer",
                 "in minutes", "at scale", "unleash", "transform your"];
  for (const w of WORDS) {
    const t = tally(new RegExp(`\\b${w.replace(/[-\s]/g, "[-\\\\s]")}\\b`, "gi"));
    add("1.7", `banned word: ${w}`, t.total, t.where);
  }
}

// A token defined as itself resolves to nothing, and the page silently loses
// that colour. Three separate search-and-replace passes over colour literals
// have now rewritten a token's own definition into `--x: var(--x)`, once in
// the app stylesheet and twice in the Workbench, so it is checked rather than
// remembered.
{
  for (const f of files) {
    if (![".css", ".html"].includes(extname(f))) continue;
    const bad = [...read(f).matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/g)]
      .filter((m) => m[1] === m[2]).map((m) => m[1]);
    add("3.5", `token defined as itself: ${[...new Set(bad)].join(", ")}`, bad.length, rel(f));
  }
}

// 3.5 Themes: two complete sets, and the same set in both light blocks.
//
// This check exists because the same mistake happened twice. A token added to
// the media-query block but not to the [data-theme="light"] block looks fine
// until someone picks Light by hand, and then that one value silently stays on
// its dark setting. It happened to --scrim, and then to --hero-veil, and both
// times the page looked right in the way it was tested and wrong in the way it
// was not.
{
  const css = existsSync(join(ROOT, "src/styles.css")) ? read(join(ROOT, "src/styles.css")) : "";
  const block = (re) => {
    const m = css.match(re);
    if (!m) return null;
    return new Set([...m[1].matchAll(/(--[a-z0-9-]+)\s*:/g)].map((x) => x[1]));
  };
  const dark = block(/:root\s*\{([\s\S]*?)\n\s*\}/);
  const auto = block(/@media \(prefers-color-scheme: light\)[\s\S]*?\{[\s\S]*?\{([\s\S]*?)\n\s*\}/);
  const picked = block(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\s*\}/);

  if (!dark || !auto || !picked) {
    add("3.5", "could not find all three theme blocks in styles.css", 1, "src/styles.css");
  } else {
    const missingAuto = [...auto].filter((t) => !picked.has(t));
    const missingPicked = [...picked].filter((t) => !auto.has(t));
    add("3.5", `light tokens in the media query but not in [data-theme=light]: ${missingAuto.join(", ")}`,
        missingAuto.length, "src/styles.css");
    add("3.5", `light tokens in [data-theme=light] but not in the media query: ${missingPicked.join(", ")}`,
        missingPicked.length, "src/styles.css");
    // A colour token with no light value is a dark value showing on a light page.
    const colourish = [...dark].filter((t) => !/^--(r|s[0-9]|font|mono)$/.test(t));
    const noLight = colourish.filter((t) => !picked.has(t));
    add("3.5", `tokens with no light value: ${noLight.join(", ")}`, noLight.length, "src/styles.css");
  }
}

// ── added 24 Sep 2026: the rest of the mechanically checkable rules ──────────
//
// Each block names the rule it enforces. What a script cannot judge - whether
// a heading could belong to another product, whether a number is backed by a
// measurement, whether a hero shows real evidence - stays on the section 5
// checklist and is reviewed by a person.

// Copy as a visitor reads it: comments stripped, CSS left out.
const copyFiles = files.filter((f) => [".jsx", ".js", ".html"].includes(extname(f)));
const copyTally = (re) => {
  const hits = new Map();
  let total = 0;
  for (const f of copyFiles) {
    const n = (stripComments(read(f), false).match(re) || []).length;
    if (n) { hits.set(rel(f), n); total += n; }
  }
  return { total, where: [...hits.keys()].join(", ") };
};

// 1.10: no utility-class framework, which means the classes as well as the tool.
{
  add("1.10", "src/utilities.css (frozen Tailwind output) still exists",
      existsSync(join(ROOT, "src/utilities.css")) ? 1 : 0, "src/utilities.css");
  const UTILITY = /^(?:[a-z]+:)*-?(?:text-(?:xs|sm|base|lg|[2-9]?xl|left|right|center|white|black|slate-\d+|gray-\d+|blue-\d+|cyan-\d+|red-\d+|green-\d+|amber-\d+|emerald-\d+|purple-\d+)|font-(?:thin|light|normal|medium|semibold|bold|extrabold|mono|sans)|bg-\S+|border(?:-[a-z0-9./-]+)?|rounded(?:-\S+)?|[mp][trblxy]?-[\d.]+|gap-[\d.]+|space-[xy]-[\d.]+|flex(?:-\S+)?|grid(?:-\S+)?|inline(?:-\S+)?|block|hidden|items-\S+|justify-\S+|self-\S+|[wh]-\S+|min-[wh]-\S+|max-[wh]-\S+|leading-\S+|tracking-\S+|uppercase|capitalize|truncate|whitespace-\S+|overflow-\S+|opacity-\d+|shadow(?:-\S+)?|z-\S+|inset-\S+|(?:top|left|right|bottom)-\S+|absolute|relative|fixed|sticky|cursor-\S+|transition(?:-\S+)?|duration-\d+|ease-\S+|col-span-\S+|shrink-\d|grow|order-\S+|object-\S+|select-\S+|pointer-events-\S+|underline|italic|antialiased)$/;
  let total = 0;
  const where = new Map();
  for (const f of copyFiles) {
    const src = stripComments(read(f), false);
    for (const m of src.matchAll(/className\s*[:=]\s*(?:\{\s*)?(["'`])([^"'`]*)\1/g)) {
      const n = m[2].split(/\s+/).filter((c) => c && !c.includes("$") && UTILITY.test(c)).length;
      if (n) { total += n; where.set(rel(f), (where.get(rel(f)) || 0) + n); }
    }
  }
  add("1.10", "utility classes in markup (text-sm, flex, px-4 ...)", total,
      [...where].map(([k, v]) => `${k} ${v}`).join(", "));
}

// 1.7: the whole banned list, and the heading templates.
{
  const WORDS = ["next generation", "10x", "blazing fast", "lightning fast", "powered by ai",
                 "ai-powered", "reimagined", "all-in-one", "end-to-end", "world-class",
                 "best-in-class", "frictionless", "intuitive", "delightful", "magical",
                 "transform your workflow", "built for modern teams", "ship with confidence",
                 "focus on what matters", "actionable insights", "made with ai"];
  for (const w of WORDS) {
    const t = copyTally(new RegExp(`\\b${w.replace(/[-\s]/g, "[-\\s]")}\\b`, "gi"));
    add("1.7", `banned word: ${w}`, t.total, t.where);
  }
  const TEMPLATES = [/["'>]\s*Everything you need to/g, /["'>]\s*Built for /g, /["'>]\s*Designed for /g,
                     /["'>]\s*Powerful features for/g, /["'>]\s*(?:Meet|Introducing|Say hello to) [A-Z]/g];
  for (const re of TEMPLATES) {
    const t = copyTally(re);
    add("1.7", `template heading ${re.source.replace(/\\s\*|\["'>\]/g, "").slice(0, 40)}`, t.total, t.where);
  }
}

// 1.5: no emojis, no arrow glyph tacked onto a label.
{
  const emoji = copyTally(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/gu);
  add("1.5", "emojis in the interface", emoji.total, emoji.where);
  const arrow = copyTally(/["'>][^"'<>\n]{1,40}\s(?:→|↗|->|&rarr;)\s*["'<]/g);
  add("1.5", "arrow glyph after a label", arrow.total, arrow.where);
}

// 1.3: no big numbered steps.
{
  const steps = copyTally(/\b(?:n|num|step|number)\s*:\s*['"]0\d['"]/g);
  add("1.3", "numbered 01 02 03 steps", steps.total, steps.where);
}

// 2.2: no small uppercase letter-spaced labels.
{
  let total = 0;
  const where = [];
  for (const f of files) {
    const src = stripComments(read(f), extname(f) === ".css");
    const n = (src.match(/text-transform\s*:\s*uppercase|textTransform\s*:\s*['"]uppercase['"]|\buppercase\b(?=[^"'`]*["'`])/g) || []).length;
    if (n) { total += n; where.push(rel(f)); }
  }
  add("2.2", "uppercase labels", total, where.join(", "));
}

// 2.3 and 2.4: links that say where they go, and go somewhere.
{
  const more = copyTally(/Learn more/gi);
  add("2.3", '"Learn more" links', more.total, more.where);
  const hash = copyTally(/href\s*[:=]\s*\{?\s*["']#["']/g);
  add("2.4", 'links to "#"', hash.total, hash.where);
  // The policy pages pass their date to LegalPage as a prop, so the date and
  // the words "Last updated" are no longer on one line. Both forms count.
  const dated = copyTally(/Last updated:?\s*(?:[A-Z][a-z]+\s+)?\d{4}|\bupdated=["'][A-Z][a-z]+ \d{4}/g);
  add("2.4", "hardcoded Last updated dates", dated.total, dated.where);
}

// 3.5: every colour comes from a token. No hex or rgb() literals in components.
{
  let total = 0;
  const where = [];
  // A literal that has to be exactly that colour - another company's logo -
  // is marked `design: brand` on its line or the line above, the same way a
  // data gradient is marked `design: data`, and is not counted.
  for (const f of files) {
    if (![".jsx", ".js"].includes(extname(f))) continue;
    const lines = read(f).split("\n");
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/design:\s*(brand|data)/.test(lines[i]) || /design:\s*(brand|data)/.test(lines[i - 1] || "")) continue;
      n += (stripComments(lines[i], false).match(/["'`]\s*#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*\d/g) || []).length;
    }
    if (n) { total += n; where.push(`${rel(f)} ${n}`); }
  }
  add("3.5", "colour literals in components instead of tokens", total, where.join(", "));
}

// 1.4 / 3.4: three font weights at most.
{
  const weights = new Set();
  const NAMED = { thin: 100, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 };
  for (const f of files) {
    const src = stripComments(read(f), extname(f) === ".css");
    for (const m of src.matchAll(/font-weight\s*:\s*(\d{3}|bold|normal)/g)) weights.add(NAMED[m[1]] || +m[1]);
    for (const m of src.matchAll(/fontWeight\s*:\s*['"]?(\d{3}|bold|normal)/g)) weights.add(NAMED[m[1]] || +m[1]);
    for (const m of src.matchAll(/className\s*[:=][^\n]*?\bfont-(thin|light|normal|medium|semibold|bold|extrabold)\b/g)) weights.add(NAMED[m[1]]);
  }
  add("1.4", `font weights in use: [${[...weights].sort((a, b) => a - b)}]`,
      weights.size > 3 ? weights.size : 0, "*.css, *.jsx");
}

// 1.4: no title case on every heading. A heading is title case when every
// significant word is capitalised; the rule is broken when that is the house
// style, so this fails at more than a third of them.
{
  const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or",
                         "the", "to", "vs", "with"]);
  const heads = [];
  for (const f of copyFiles) {
    const src = stripComments(read(f), false);
    for (const m of src.matchAll(/(?:createElement|\bh)\(\s*["']h[1-3]["'],[\s\S]{0,400}?\}\s*,\s*["']([^"'\n]{3,80})["']/g)) heads.push([rel(f), m[1]]);
    for (const m of src.matchAll(/<h([1-3])\b[^>]*>([^<{]{3,80})<\/h\1>/g)) heads.push([rel(f), m[2].trim()]);
  }
  const titled = heads.filter(([, t]) => {
    const words = t.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !SMALL.has(w.toLowerCase()));
    return words.length >= 2 && words.every((w) => /^[A-Z]/.test(w));
  });
  add("1.4", `title case headings: ${titled.length} of ${heads.length} (${titled.slice(0, 6).map(([, t]) => t).join("; ")})`,
      titled.length * 3 > heads.length ? titled.length : 0, [...new Set(titled.map(([f]) => f))].join(", "));
}

// Launch gates, on the built pages: a real title, a description, a canonical
// link and an Open Graph image on every public one.
{
  const dist = join(ROOT, "dist");
  if (existsSync(dist)) {
    const missing = [];
    for (const name of readdirSync(dist).filter((n) => n.endsWith(".html"))) {
      const html = read(join(dist, name));
      if (/<meta name="robots" content="noindex/.test(html)) continue;
      const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
      if (!title || /vite|react|create next app/i.test(title)) missing.push(`${name}: title`);
      if (!/<meta name="description" content="[^"]{20,}"/.test(html)) missing.push(`${name}: description`);
      if (!/<link rel="canonical" href="https?:\/\//.test(html)) missing.push(`${name}: canonical`);
      if (!/<meta property="og:image" content="https?:\/\//.test(html)) missing.push(`${name}: og:image`);
      if (!/<html lang="[a-z]{2}/.test(html)) missing.push(`${name}: lang`);
    }
    add("launch gate", `public pages missing basics: ${missing.join(", ")}`, missing.length, "dist/*.html");
  }
}

// Launch gates.

{
  const icons = ["public/icon.svg", "icon.svg", "public/favicon.svg"];
  add("launch gate", "missing favicon variant: icon.svg",
      icons.some((f) => existsSync(join(ROOT, f))) ? 0 : 1, "*.html");
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(fails, null, 1));
} else if (!fails.length) {
  console.log("design audit: clean");
} else {
  console.log(`design audit: ${fails.length} failing rules\n`);
  for (const f of fails) {
    console.log(`  [${f.rule}] ${f.detail}  (x${f.count})`);
    console.log(`      ${process.argv.includes("--full") ? f.where : f.where.slice(0, 160)}`);
  }
}
process.exit(fails.length ? 1 : 0);
