// Rename production's camelCase fields to the snake_case the new build reads,
// and back again.
//
// Production (turboflow-7b3ca) was written by the original app, in camelCase:
// users have teamName and unlimitedUntil, jobs have userId and drag_N, ledger
// rows have jobId. The new build reads team_name, user_id, drag_n, job_id.
// Unconverted, every existing user would be asked for their team again and
// every job would vanish from its owner's list.
//
// Renamed, not copied. lib/firebase.js maps field names one way per key, so a
// document holding both teamName and team_name shows whichever it happens to
// read last, and after an edit that is the stale one.
//
//   --forward   rename camelCase -> snake_case, using the backend's own
//               snakeCasePatch (functions/src/lib/normalize.ts), so the result
//               is exactly what the new backend would produce by itself. Writes
//               a log of every rename.
//   --reverse   rename back, from the log. Uses the documents' current values,
//               so credits spent or bought after the switch are kept. Documents
//               created after the switch are renamed back with the same field
//               map, so the old app can read them.
//   --dry-run   say what would change and write nothing.
//
// Target: the Firestore emulator when FIRESTORE_EMULATOR_HOST is set, else the
// project named by --project. Production needs --production as well, so it
// cannot be hit by a typo.
//
// Run from the repo root, after `npm run build` in functions/.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

const mode = has("--forward") ? "forward" : has("--reverse") ? "reverse" : null;
const project = opt("project");
const logPath = resolve(opt("log") || "prod-migrate.log.json");
const dry = has("--dry-run");
if (!mode || !project) {
  console.error("usage: node scripts/prod-migrate.mjs --forward|--reverse --project=<id> [--log=<file>] [--dry-run] [--production]");
  process.exit(2);
}
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
if (project === "turboflow-7b3ca" && !emulator && !has("--production")) {
  console.error("refusing to write to production without --production");
  process.exit(2);
}

const { snakeCasePatch } = await import(pathToFileURL(resolve("functions/lib/lib/normalize.js")).href);
initializeApp({ projectId: project });
const db = getFirestore();

/** What gets converted. Everything else (kofi_*, paypal_orders, config) is left alone. */
const TARGETS = [
  { name: "users", list: () => db.collection("users") },
  { name: "users/*/transactions", list: () => db.collectionGroup("transactions"),
    only: (ref) => ref.parent.parent?.parent?.id === "users" },
  { name: "jobs", list: () => db.collection("jobs") },
];

const DELETE = Symbol("delete");

async function forward() {
  if (existsSync(logPath) && !dry) {
    console.error(`${logPath} exists: a forward run has happened. Move it aside first; it is the only record of what to reverse.`);
    process.exit(2);
  }
  const log = { project, at: new Date().toISOString(), renames: {}, docs: {} };
  for (const t of TARGETS) {
    const snap = await t.list().get();
    let changed = 0;
    const fieldMap = (log.renames[t.name] ??= {});
    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      if (t.only && !t.only(doc.ref)) continue;
      const patch = snakeCasePatch(doc.data(), DELETE);
      const renames = [];
      const update = {};
      for (const [key, value] of Object.entries(patch)) {
        if (value === DELETE) {
          update[key] = FieldValue.delete();
        } else {
          update[key] = value;
        }
      }
      // Pair each deleted camelCase key with the snake_case name it became,
      // asking the same function about that key alone.
      for (const [key, value] of Object.entries(patch)) {
        if (value !== DELETE) continue;
        const to = Object.keys(snakeCasePatch({ [key]: 1 }, DELETE)).find((k) => k !== key);
        if (to) { renames.push([key, to]); fieldMap[key] = to; }
      }
      if (!renames.length) continue;
      log.docs[doc.ref.path] = renames;
      changed++;
      if (!dry) {
        batch.update(doc.ref, update);
        if (++inBatch === 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
      }
    }
    if (!dry && inBatch) await batch.commit();
    console.log(`${t.name}: ${changed} of ${snap.size} documents ${dry ? "would be" : ""} renamed; fields: ${
      Object.entries(fieldMap).map(([a, b]) => `${a}->${b}`).join(", ") || "none"}`);
  }
  if (!dry) writeFileSync(logPath, JSON.stringify(log, null, 1));
  console.log(dry ? "dry run: nothing written" : `log written to ${logPath}`);
}

async function reverse() {
  const log = JSON.parse(readFileSync(logPath, "utf8"));
  if (log.project !== project) {
    console.error(`the log is for ${log.project}, not ${project}`);
    process.exit(2);
  }
  for (const t of TARGETS) {
    // snake -> camel, for exactly the fields the forward run renamed.
    const back = Object.fromEntries(Object.entries(log.renames[t.name] ?? {}).map(([a, b]) => [b, a]));
    const snap = await t.list().get();
    let changed = 0;
    let batch = db.batch();
    let inBatch = 0;
    for (const doc of snap.docs) {
      if (t.only && !t.only(doc.ref)) continue;
      const data = doc.data();
      const update = {};
      for (const [snake, camel] of Object.entries(back)) {
        if (!(snake in data)) continue;
        if (!(camel in data)) update[camel] = data[snake];
        update[snake] = FieldValue.delete();
      }
      if (!Object.keys(update).length) continue;
      changed++;
      if (!dry) {
        batch.update(doc.ref, update);
        if (++inBatch === 400) { await batch.commit(); batch = db.batch(); inBatch = 0; }
      }
    }
    if (!dry && inBatch) await batch.commit();
    console.log(`${t.name}: ${changed} of ${snap.size} documents ${dry ? "would be" : ""} renamed back`);
  }
  console.log(dry ? "dry run: nothing written" : "reverse complete");
}

console.log(`${mode}${dry ? " (dry run)" : ""} on ${emulator ? "the emulator" : project}`);
await (mode === "forward" ? forward() : reverse());
process.exit(0);
