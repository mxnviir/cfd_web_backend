// Every field the Workbench reads off a run must be a field something writes.
//
// Made this mistake twice on 11 Sep 2026, in the same afternoon. The results
// panel read `run.results.glb_path` and `run.summary.drag_n`; the worker
// writes `run.results_glb_path` and `run.summary.drag`. A third, `run.events`,
// had never been written by anything, so the Workbench's event log said "No
// events recorded for this run" for every run there has ever been.
//
// A name nobody writes is silent in JavaScript. This makes it loud.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const slash = (p) => p.split(String.fromCharCode(92)).join("/");

function walk(dir, ext, out = []) {
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = join(dir, n);
    if (statSync(join(ROOT, p)).isDirectory()) walk(p, ext, out);
    else if (n.endsWith(ext)) out.push(p);
  }
  return out;
}

// ── every key anything writes onto a document ──────────────────────────────
const written = new Set();
const sources = [
  "services/simscale-job/simscale_job.py",
  "services/simscale-job/spec_mode.py",
  ...walk("functions/src", ".ts"),
];
for (const f of sources) {
  const src = read(f);
  for (const m of src.matchAll(/["']([a-z][a-z0-9_]*)(?:\.[a-z_]+)?["']\s*:/gi)) written.add(m[1]);
  for (const m of src.matchAll(/^\s{2,}([a-z][a-zA-Z0-9_]*)\s*:/gm)) written.add(m[1]);
  for (const m of src.matchAll(/patch\[["']([a-z0-9_]+)["']\]/gi)) written.add(m[1]);
}

// What the client is actually handed.
//
// lib/firebase.js converts top-level keys snake_case -> camelCase on every
// read, so the worker's `results_glb_path` reaches the Workbench as
// `resultsGlbPath`. The first version of this test compared the UI's reads
// against the *writer's* spelling, so `run.results_glb_path` passed and
// `run.logPaths` would have failed - exactly backwards. It reported a clean
// sheet on three real bugs.
//
// Both spellings are accepted: a field may be written camelCase by a Cloud
// Function and snake_case by the worker, and either converts to the same name.
const toCamel = (k) => ({ drag_n: "drag_N", lift_n: "lift_N" })[k]
  ?? k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// Set by Firestore itself or by the client, never named in a writer literal.
const ALLOW = new Set(["id", "data", "exists", "ref", "length", "toMillis"]);

// Every writer name as the Workbench will see it, and only that. Accepting
// the snake_case spelling too would let `run.results_glb_path` pass, and the
// client is never handed that name.
const seen = new Set([...written].map(toCamel));

// `r` is a run only in the job table, where the rows are runs. Everywhere else
// it is a DOMRect, and matching it there reports r.left and r.width as missing
// run fields.
const R_IS_A_RUN = /JobStatus\.jsx$/;

const missing = [];
for (const f of walk("src/workbench", ".jsx")) {
  const pattern = R_IS_A_RUN.test(slash(f))
    ? /\b(?:run|r)\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g
    : /\brun\??\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  read(f).split("\n").forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*")) return;
    for (const m of line.matchAll(pattern)) {
      const key = m[1];
      // The reader sees camelCase, so compare against every writer name run
      // through the same conversion the client applies.
      if (ALLOW.has(key)) continue;
      if (seen.has(key)) continue;
      missing.push({ file: slash(f), line: i + 1, key, text: t.slice(0, 70) });
    }
  });
}

if (missing.length) {
  console.log("run fields: " + missing.length + " read with no writer\n");
  for (const m of missing) console.log("  " + m.file + ":" + m.line + "  ." + m.key + "\n      " + m.text);
  process.exit(1);
}
console.log("run fields: every field read off a run is written by the worker or a function");
