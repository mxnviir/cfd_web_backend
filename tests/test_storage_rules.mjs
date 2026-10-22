// Storage rules: who can read and write which bytes.
//
// These did not exist. tests/test_security.mjs is 69 checks of firestore.rules
// and not one of storage.rules, and that gap hid a live bug for the whole life
// of the product: results were stored at results/{jobId}/ and owned by a
// cross-service Firestore lookup inside the Storage rules. That lookup does
// not work - cut down to a bare firestore.exists() it still denies the job's
// own owner - so every results download anyone ever asked for returned 403.
//
// Run against the emulators:
//   npx firebase-tools emulators:exec --only auth,firestore,storage \
//     --project demo-turboflow "node tests/test_storage_rules.mjs"
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth, connectAuthEmulator, signInWithCredential, GoogleAuthProvider, signOut,
} from "firebase/auth";
import {
  getStorage, connectStorageEmulator, ref, getBytes, uploadBytes, listAll,
} from "firebase/storage";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getStorage as adminStorage } from "firebase-admin/storage";

const PROJECT = "demo-turboflow";
const BUCKET = `${PROJECT}.appspot.com`;
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.STORAGE_EMULATOR_HOST ||= "http://127.0.0.1:9199";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** The call must be refused, and refused for the right reason. */
async function denied(promise, what) {
  try {
    await promise;
  } catch (err) {
    const code = err?.code || "";
    if (/unauthorized|permission|denied/i.test(code + " " + err.message)) return;
    throw new Error(`${what} failed, but not with a permission error: ${code} ${err.message}`);
  }
  throw new Error(`${what} was ALLOWED and must not be`);
}

async function allowed(promise, what) {
  try {
    return await promise;
  } catch (err) {
    // An allowed path with no object there is a 404, not a 403. That is the
    // control the whole suite rests on: without it, "denied" and "not there"
    // look the same and a broken rule reads as an empty folder.
    if (err?.code === "storage/object-not-found") return null;
    throw new Error(`${what} was REFUSED and should be allowed: ${err?.code} ${err.message}`);
  }
}

const admin = initAdmin({ projectId: PROJECT, storageBucket: BUCKET });
const bucket = adminStorage(admin).bucket();

const app = initializeApp({ projectId: PROJECT, apiKey: "fake", storageBucket: BUCKET });
const auth = getAuth(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
const storage = getStorage(app);
connectStorageEmulator(storage, "127.0.0.1", 9199);

// The auth emulator mints its own uid and ignores the `sub` we ask for, so the
// real uid has to be read back before any path can be built from it.
const signIn = async (who) => {
  const cred = await signInWithCredential(auth, GoogleAuthProvider.credential(
    JSON.stringify({ sub: who, email: `${who}@example.com`, email_verified: true })));
  return cred.user.uid;
};

// Bytes only the worker could have written: the Admin SDK bypasses these rules.
async function seed(path, body) {
  await bucket.file(path).save(Buffer.from(body), { contentType: "application/json" });
}

console.log("storage rules\n");

// Two real accounts, so "another user" means a uid the emulator actually
// issued rather than a string this file made up.
const B = await signIn("userB");
const A = await signIn("userA");
if (A === B) throw new Error("both sign-ins produced the same uid");

await seed(`users/${A}/results/job-a/logs/run.json`, '{"entries":[]}');
await seed(`users/${B}/results/job-b/logs/run.json`, '{"entries":[]}');
await seed("results/job-a/logs/run.json", '{"entries":[]}');
await seed(`users/${A}/geometries/geo1/v1/model.glb`, "glb");

await test("a user reads their own results", async () => {
  const bytes = await allowed(getBytes(ref(storage, `users/${A}/results/job-a/logs/run.json`)),
    "reading own results");
  if (!bytes) throw new Error("the object should be there");
});

await test("a user cannot read another user's results", () =>
  denied(getBytes(ref(storage, `users/${B}/results/job-b/logs/run.json`)),
    "reading another user's results"));

await test("the old results location stays closed", () =>
  denied(getBytes(ref(storage, "results/job-a/logs/run.json")),
    "reading the pre-move results path"));

await test("a user cannot write into their own results", () =>
  denied(uploadBytes(ref(storage, `users/${A}/results/job-a/forged.json`), new Uint8Array([1])),
    "writing into own results"));

await test("results cannot be listed", () =>
  denied(listAll(ref(storage, `users/${A}/results/job-a`)), "listing own results"));

await test("a user reads their own geometry version", async () => {
  const bytes = await allowed(getBytes(ref(storage, `users/${A}/geometries/geo1/v1/model.glb`)),
    "reading own geometry");
  if (!bytes) throw new Error("the object should be there");
});

await test("a user cannot read another user's geometry", () =>
  denied(getBytes(ref(storage, `users/${B}/geometries/geo1/v1/model.glb`)),
    "reading another user's geometry"));

await test("a user uploads their own CAD file", () =>
  allowed(uploadBytes(ref(storage, `users/${A}/geometries/geo2/raw.step`), new Uint8Array([1, 2, 3])),
    "uploading own raw.step"));

await test("an upload cannot be overwritten", () =>
  denied(uploadBytes(ref(storage, `users/${A}/geometries/geo2/raw.step`), new Uint8Array([9])),
    "overwriting an existing upload"));

await test("a file the geometry service cannot read is refused", () =>
  denied(uploadBytes(ref(storage, `users/${A}/geometries/geo3/car.blend`), new Uint8Array([1])),
    "uploading an unsupported format"));

await test("a user cannot upload into another user's folder", () =>
  denied(uploadBytes(ref(storage, `users/${B}/geometries/geo9/raw.step`), new Uint8Array([1])),
    "uploading into another user's folder"));

await test("a user cannot write a geometry version directory", () =>
  denied(uploadBytes(ref(storage, `users/${A}/geometries/geo1/v1/faces.json`), new Uint8Array([1])),
    "writing faces.json, which would let a client rename the inlet"));

// The browser cut's staging folder. Same deal as a raw upload - write-once,
// owner only - plus the two shape checks: a token the backend would never
// mint, and a file that is not one of the five artefacts.
const TOKEN = "4f7c9e2ab35d81c06b9a7d3f2e1c8a54";
const incoming = (who, geo, token, name) =>
  `users/${who}/geometries/${geo}/incoming/${token}/${name}`;

await test("a user uploads their own tunnel artefact", () =>
  allowed(uploadBytes(ref(storage, incoming(A, "geo4", TOKEN, "geometry.glb")),
    new Uint8Array([1, 2])), "uploading own geometry.glb"));

await test("a tunnel artefact cannot be overwritten", () =>
  denied(uploadBytes(ref(storage, incoming(A, "geo4", TOKEN, "geometry.glb")),
    new Uint8Array([9])), "overwriting a staged artefact"));

await test("a token the backend would not mint is refused", () =>
  denied(uploadBytes(ref(storage, incoming(A, "geo4", "short", "faces.json")),
    new Uint8Array([1])), "uploading under a malformed token"));

await test("only the five artefacts belong in staging", () =>
  denied(uploadBytes(ref(storage, incoming(A, "geo4", TOKEN, "car.blend")),
    new Uint8Array([1])), "uploading an unexpected file name"));

await test("a user cannot stage into another user's folder", () =>
  denied(uploadBytes(ref(storage, incoming(B, "geo9", TOKEN, "geometry.step")),
    new Uint8Array([1])), "staging into another user's folder"));

await test("staging cannot be listed", () =>
  denied(listAll(ref(storage, `users/${A}/geometries/geo4/incoming/${TOKEN}`)),
    "listing staged artefacts"));

await test("nothing outside the named paths is reachable", () =>
  denied(getBytes(ref(storage, "secrets/keys.json")), "reading an unmatched path"));

await signOut(auth);

await test("a signed-out visitor reads nothing", () =>
  denied(getBytes(ref(storage, `users/${A}/results/job-a/logs/run.json`)),
    "reading results while signed out"));

await deleteApp(app);

console.log();
if (failures.length) {
  console.log(`storage rules: ${passed} passed, ${failures.length} FAILED`);
  process.exit(1);
}
console.log(`storage rules: ${passed} passed, 0 failed`);
