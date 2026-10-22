// Rehearse the production data migration, and its rollback, on the emulator.
//
// Loads the copy of production's Firestore (every document, as of the backup)
// into the local emulator, with the new build's functions and rules running,
// then:
//   1. renames it forward with scripts/prod-migrate.mjs
//   2. checks the new build works on it: a real migrated user sees their jobs,
//      balance and history through the rules, and nobody's credits moved
//   3. rolls it back, and checks every document is byte-for-byte what it was
//   4. does it again with activity in between (a refund on a stuck job), and
//      checks the rollback keeps that activity in the old app's shape
//
// Personal data never leaves this machine: it goes from the backup file into
// the emulator and nowhere else.
//
// Run: npx firebase-tools emulators:exec --only auth,firestore,functions \
//        --project demo-turboflow "node tests/rehearse_prod_migration.mjs"
import { readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getFirestore as adminFirestore, Timestamp, GeoPoint } from "firebase-admin/firestore";
import { getAuth as adminAuth } from "firebase-admin/auth";
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithCustomToken } from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, collection, query, where, getDocs, doc, getDoc,
} from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const PROJECT = "demo-turboflow";
const BACKUP = "C:/Users/shash/Desktop/cfd_web_backend/backups/turboflow-7b3ca-2026-09-24/data/firestore_documents.json";
const LOG = "rehearsal-migrate.log.json";

initAdmin({ projectId: PROJECT });
const admin = adminFirestore();

let passed = 0;
const failures = [];
const check = (cond, what) => {
  if (cond) { passed++; console.log(`  PASS  ${what}`); }
  else { failures.push(what); console.log(`  FAIL  ${what}`); }
};

// ── Firestore's REST JSON -> admin values ───────────────────────────────────
function decode(v) {
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) {
    const m = v.timestampValue.match(/^(.*?)(?:\.(\d+))?Z$/);
    const seconds = Math.floor(Date.parse(`${m[1]}Z`) / 1000);
    const nanos = m[2] ? Number(m[2].padEnd(9, "0")) : 0;
    return new Timestamp(seconds, nanos);
  }
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)]));
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  if ("geoPointValue" in v) return new GeoPoint(v.geoPointValue.latitude ?? 0, v.geoPointValue.longitude ?? 0);
  if ("bytesValue" in v) return Buffer.from(v.bytesValue, "base64");
  if ("referenceValue" in v) return admin.doc(v.referenceValue.split("/documents/")[1]);
  throw new Error(`unknown value ${JSON.stringify(v).slice(0, 80)}`);
}

// ── admin values -> a canonical string, for exact comparison ────────────────
function canon(x) {
  if (x instanceof Timestamp) return { $ts: [x.seconds, x.nanoseconds] };
  if (x instanceof GeoPoint) return { $geo: [x.latitude, x.longitude] };
  if (Buffer.isBuffer(x)) return { $bytes: x.toString("base64") };
  if (x && typeof x === "object" && typeof x.path === "string" && x.firestore) return { $ref: x.path };
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === "object") {
    return Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])]));
  }
  return x;
}

async function snapshotAll() {
  const out = new Map();
  for (const path of PATHS) {
    const s = await admin.doc(path).get();
    out.set(path, s.exists ? JSON.stringify(canon(s.data())) : null);
  }
  return out;
}

const migrate = (dir) => execFileSync(process.execPath,
  ["scripts/prod-migrate.mjs", `--${dir}`, `--project=${PROJECT}`, `--log=${LOG}`],
  { stdio: "inherit", env: process.env });

// ── load production's documents ─────────────────────────────────────────────
const raw = JSON.parse(readFileSync(BACKUP, "utf8"));
const PATHS = raw.map((d) => d.name.split("/documents/")[1]);
{
  let batch = admin.batch();
  let n = 0;
  for (const d of raw) {
    const data = Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, decode(v)]));
    batch.set(admin.doc(d.name.split("/documents/")[1]), data);
    if (++n % 400 === 0) { await batch.commit(); batch = admin.batch(); }
  }
  await batch.commit();
  console.log(`\nloaded ${raw.length} production documents into the emulator\n`);
}

// Loading creates every document, and to the job triggers a newly created
// failed job is one that has just failed: onJobPending reverses its charge.
// That is loading, not migrating (on production these documents already
// exist, and a rename is an update that leaves the status alone), so wait for
// it to finish and take the "before" picture after it.
const ledgerSize = async () => (await admin.collectionGroup("transactions").get()).size;
{
  let last = -1;
  let same = 0;
  while (same < 3) {
    await new Promise((r) => setTimeout(r, 2000));
    const now = await ledgerSize();
    same = now === last ? same + 1 : 0;
    last = now;
  }
  console.log(`load settled: ${last} ledger rows (${last - raw.filter((d) => d.name.includes("/transactions/")).length} written by the triggers reacting to the load)\n`);
}
for (const d of (await admin.collectionGroup("transactions").get()).docs) {
  if (!PATHS.includes(d.ref.path)) PATHS.push(d.ref.path);
}
const original = await snapshotAll();
const ledgerBefore = await ledgerSize();
const creditsOf = async () => Object.fromEntries((await admin.collection("users").get()).docs
  .map((d) => [d.id, d.get("credits")]));
const creditsBefore = await creditsOf();

// ── 1. forward ──────────────────────────────────────────────────────────────
rmSync(LOG, { force: true });
migrate("forward");
await new Promise((r) => setTimeout(r, 4000));   // let any trigger that wanted to fire, fire

console.log("\nAfter the forward migration\n");
const creditsAfter = await creditsOf();
check(JSON.stringify(creditsBefore) === JSON.stringify(creditsAfter),
  "nobody's credits moved (the renames set off no charge or refund)");
check((await ledgerSize()) === ledgerBefore, "no ledger row was written by the renames");

const leftovers = [];
for (const path of PATHS.filter((p) => /^(users|jobs)\//.test(p))) {
  const s = await admin.doc(path).get();
  for (const k of Object.keys(s.data() ?? {})) {
    if (/[a-z][A-Z]/.test(k) && !["drag_N", "lift_N"].includes(k)) leftovers.push(`${path}.${k}`);
  }
}
check(leftovers.length === 0, `no camelCase field left on users, their ledgers or jobs (${leftovers.slice(0, 3).join(", ")})`);

// A real user, signed in through the client SDK and the new rules.
const jobsByUser = {};
for (const p of PATHS.filter((p) => p.startsWith("jobs/"))) {
  const uid = JSON.parse(original.get(p)).userId;
  jobsByUser[uid] = (jobsByUser[uid] ?? 0) + 1;
}
const [who, jobCount] = Object.entries(jobsByUser).sort((a, b) => b[1] - a[1])[0];
const txCount = PATHS.filter((p) => p.startsWith(`users/${who}/transactions/`)).length;  // includes rows from the load
const app = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT });
const auth = getAuth(app);
const cdb = getFirestore(app);
const fns = getFunctions(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(cdb, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);
await signInWithCustomToken(auth, await adminAuth().createCustomToken(who));

const mine = await getDocs(query(collection(cdb, "jobs"), where("user_id", "==", who)));
check(mine.size === jobCount, `a migrated user sees all ${jobCount} of their jobs through the new rules (saw ${mine.size})`);
const me = await getDoc(doc(cdb, "users", who));
check(me.exists() && me.get("credits") === creditsBefore[who], `their balance reads ${creditsBefore[who]} as before`);
check(me.get("team_name") != null, "their team name is there under the new field name");
const myTx = await getDocs(collection(cdb, "users", who, "transactions"));
check(myTx.size === txCount, `their ${txCount} ledger rows are readable (read ${myTx.size})`);

// ── 2. roll back with no activity: everything exactly as it was ─────────────
migrate("reverse");
const back = await snapshotAll();
const diffs = PATHS.filter((p) => back.get(p) !== original.get(p));
check(diffs.length === 0, `after the rollback all ${PATHS.length} documents are exactly as they were (${diffs.length} differ: ${diffs.slice(0, 3).join(", ")})`);

// ── 3. again, with a refund in between ──────────────────────────────────────
console.log("\nForward again, a refund on a stuck job, then roll back\n");
rmSync(LOG, { force: true });
migrate("forward");
const stuck = PATHS.filter((p) => p.startsWith("jobs/"))
  .map((p) => [p, JSON.parse(original.get(p))])
  .filter(([, d]) => d.status === "meshing")
  .map(([p, d]) => {
    const rows = PATHS.filter((q) => q.startsWith(`users/${d.userId}/transactions/`))
      .map((q) => JSON.parse(original.get(q))).filter((r) => (r.jobId ?? r.job_id) === p.split("/")[1]);
    const charged = rows.filter((r) => r.type === "simulation_charge").reduce((s, r) => s + Math.abs(r.amount), 0);
    const refunded = rows.filter((r) => r.type === "refund" || r.type === "simulation_charge_reversal")
      .reduce((s, r) => s + Math.abs(r.amount), 0);
    return { path: p, uid: d.userId, owed: Math.max(0, charged - refunded) };
  })
  .find((j) => j.owed > 0);
if (!stuck) {
  console.log("  (no meshing job with an outstanding charge to refund; skipping the activity round)");
} else {
  await signInWithCustomToken(auth, await adminAuth().createCustomToken(stuck.uid));
  const res = await httpsCallable(fns, "refundJob")({ job_id: stuck.path.split("/")[1] });
  check(res.data.refunded === stuck.owed,
    `refundJob on an old stuck job pays back what the old ledger says it cost (${res.data.refunded} of ${stuck.owed})`);
  const creditsNow = (await admin.doc(`users/${stuck.uid}`).get()).get("credits");
  check(creditsNow === creditsBefore[stuck.uid] + stuck.owed, "and the balance rises by exactly that");

  migrate("reverse");
  const u = (await admin.doc(`users/${stuck.uid}`).get()).data();
  const j = (await admin.doc(stuck.path).get()).data();
  check(u.credits === creditsBefore[stuck.uid] + stuck.owed, "after the rollback the refund is kept");
  check("teamName" in u && !("team_name" in u), "and the user is back in the old app's field names");
  check("userId" in j && !("user_id" in j) && j.status === "cancelling", "the job is in the old shape, cancelling");
  const refundRow = (await admin.collection(`users/${stuck.uid}/transactions`).get()).docs
    .map((d) => d.data()).find((r) => r.type === "refund" && r.jobId === stuck.path.split("/")[1] && !("job_id" in r)
      && r.amount === stuck.owed);
  check(!!refundRow, "the new refund row is in the old app's field names too");
  const others = PATHS.filter((p) => !p.includes(stuck.uid) && p !== stuck.path);
  const after2 = await snapshotAll();
  const otherDiffs = others.filter((p) => after2.get(p) !== original.get(p));
  check(otherDiffs.length === 0, `every other document is exactly as it was (${otherDiffs.length} differ)`);
}

rmSync(LOG, { force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
