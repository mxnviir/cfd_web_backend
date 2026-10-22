// Every CSS custom property that is used and never defined.
//
// This exists because of --wb-ink-1. There is no such token - the scale is
// --wb-ink, --wb-ink-2, --wb-ink-3 - and a heading written against it did not
// fail, or warn, or fall back to something obviously wrong. An undefined custom
// property resolves to the inherited value, so the heading rendered as grey
// body text and looked like a styling choice. Nothing in the build, the tests
// or the contrast audit had anything to say about it, and it shipped.
//
// The same mistake is available for every one of the sixty-odd tokens in
// tokens.css, and off-by-one names (--wb-ink-1 for --wb-ink) are the easy ones
// to make. So: collect what is defined, collect what is used, subtract.
//
// Run: node scripts/token-audit.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "dist-prod", "archive", ".git", ".firebase"]);

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(css|jsx?|html)$/.test(name)) files.push(full);
  }
})(join(ROOT, "src"));
for (const extra of ["public", "."]) {
  const dir = join(ROOT, extra);
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile() && /\.(css|html)$/.test(name)) files.push(full);
    } catch { /* ignore */ }
  }
}

const defined = new Set();
const used = new Map();   // name -> [where]

for (const file of files) {
  const text = readFileSync(file, "utf8");
  // A definition is a declaration: `--name:` at the start of a declaration.
  for (const m of text.matchAll(/(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[2]);
  // A use is var(--name) or var(--name, fallback).
  for (const m of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g)) {
    // A use with a fallback still renders something, so it is not a silent
    // failure. Recorded separately rather than ignored.
    const key = m[1];
    if (!used.has(key)) used.set(key, { places: [], everFallback: false });
    const entry = used.get(key);
    entry.everFallback = entry.everFallback || !!m[2];
    const line = text.slice(0, m.index).split("\n").length;
    const rel = file.replace(ROOT, "").replace(/\\/g, "/").replace(/^\//, "");
    if (entry.places.length < 4) entry.places.push(`${rel}:${line}`);
  }
}

const missing = [...used.entries()]
  .filter(([name]) => !defined.has(name))
  .sort((a, b) => a[0].localeCompare(b[0]));

// A token used only with a fallback still paints something, so it is a
// warning; one used bare is the silent kind and fails the check.
const silent = missing.filter(([, e]) => !e.everFallback);
const withFallback = missing.filter(([, e]) => e.everFallback);

for (const [name, e] of withFallback) {
  console.log(`  note  ${name} is never defined, but every use has a fallback`);
  console.log(`        ${e.places.join(", ")}`);
}

if (silent.length) {
  console.log(`\nFAIL  ${silent.length} custom propert${silent.length === 1 ? "y is" : "ies are"} used and never defined\n`);
  for (const [name, e] of silent) {
    const near = [...defined]
      .filter((d) => d.startsWith(name.replace(/-\d+$/, "")) || name.startsWith(d))
      .slice(0, 3);
    console.log(`   - ${name}`);
    console.log(`       used at ${e.places.join(", ")}`);
    if (near.length) console.log(`       did you mean ${near.join(", ")}?`);
  }
  process.exit(1);
}

console.log(`token audit: ${used.size} custom properties used, all ${defined.size} defined somewhere`);
