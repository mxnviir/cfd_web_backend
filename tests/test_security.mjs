// Security regression tests for the rewritten backend.
//
// These run against the emulators as a real signed-in user, through the client
// SDK, so they exercise firestore.rules and the callables the way a browser
// does. The admin SDK is used only to set up state a client could not create.
//
// The test that matters most is "a forged job refunds nothing". It is the one
// that fails against the old backend and passes against this one, which is the
// only real proof the vulnerability is closed.
import { initializeApp } from "firebase/app";
import {
  getAuth, connectAuthEmulator, signInWithCredential, signInWithCustomToken,
  GoogleAuthProvider, signOut, createUserWithEmailAndPassword,
} from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, updateDoc, collection,
  getDocs, query, where,
} from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { initializeApp as initAdmin } from "firebase-admin/app";
import { getFirestore as adminFirestore } from "firebase-admin/firestore";

const PROJECT = "demo-turboflow";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";

// ── harness ────────────────────────────────────────────────────────────────
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

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Expect an operation to be refused. A silent success here is the bug. */
async function denied(promise, what) {
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  assert(threw, `${what} was ALLOWED — it must be refused`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a background function to do its work, or give up. */
async function waitFor(check, label, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ── setup ──────────────────────────────────────────────────────────────────
initAdmin({ projectId: PROJECT });
const admin = adminFirestore();

const app = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(fns, "127.0.0.1", 5001);

// Google is the only way into TurboFlow, so the tests sign in the way a real
// user does. The Auth emulator accepts an unsigned payload as a Google
// credential. The site then asks ensureAccount for the account document, and
// so do the tests.
const email = `t${Date.now()}@example.com`;
const cred = await signInWithCredential(
  auth,
  GoogleAuthProvider.credential(JSON.stringify({
    sub: `google-${Date.now()}`, email, email_verified: true, name: "Test Team",
  })),
);
const uid = cred.user.uid;
console.log(`\nsigned in with Google as ${email}\n  uid ${uid}\n`);

const balance = async () => {
  const snap = await admin.collection("users").doc(uid).get();
  return Number(snap.data()?.credits ?? 0);
};

const made = await httpsCallable(fns, "ensureAccount")({});
if (!made.data?.created) throw new Error("ensureAccount did not create the account");
await waitFor(async () => (await admin.collection("users").doc(uid).get()).exists,
  "ensureAccount to write the account");

// A Google account gets the signup bonus.
const bonus = (await admin.collection("users").doc(uid).get()).data().credits;
if (bonus !== 50) throw new Error(`signup bonus was ${bonus}, expected 50`);
console.log(`  ensureAccount granted ${bonus} credits\n`);

// The site calls it on every sign-in that finds no document, and two tabs can
// sign in at once. A second call must never hand the bonus out again or reset
// a balance that has been spent.
await test("ensureAccount on an existing account changes nothing", async () => {
  await admin.collection("users").doc(uid).update({ credits: 777 });
  const again = await httpsCallable(fns, "ensureAccount")({});
  assert(again.data?.created === false, "a second call claimed to create the account");
  assert((await balance()) === 777, "a second call changed the balance");
  await admin.collection("users").doc(uid).update({ credits: 50 });
});

// Google is the only sign-in. The emulator has every provider switched on, so
// this is ensureAccount refusing, not the provider being off: a password
// account can exist, but it gets no document and no credits, so it can do
// nothing. On its own app so the session the tests run as is not replaced.
{
  const pwApp = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT }, "password");
  const pwAuth = getAuth(pwApp);
  const pwFns = getFunctions(pwApp);
  connectAuthEmulator(pwAuth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFunctionsEmulator(pwFns, "127.0.0.1", 5001);
  await test("a password account is refused an account and credits", async () => {
    const made = await createUserWithEmailAndPassword(
      pwAuth, `pw${Date.now()}@example.com`, "long-enough-password");
    await denied(httpsCallable(pwFns, "ensureAccount")({}), "an account document for a password account");
    const doc = await admin.collection("users").doc(made.user.uid).get();
    assert(!doc.exists, "a password account was given an account document");
  });
}
await admin.collection("users").doc(uid).update({ credits: 500 });

console.log("Firestore rules\n");

await test("a client cannot create its own account document", async () => {
  await denied(
    setDoc(doc(db, "users", uid), { credits: 999999, email }),
    "creating users/<uid> with 999999 credits",
  );
});

await test("a client cannot change its own credit balance", async () => {
  await denied(
    updateDoc(doc(db, "users", uid), { credits: 999999 }),
    "writing credits directly",
  );
});

await test("a client cannot write its own ledger row", async () => {
  await denied(
    setDoc(doc(collection(db, "users", uid, "transactions")), {
      type: "simulation_charge", amount: -1, job_id: "x",
    }),
    "writing a transactions row",
  );
});

await test("a job carrying its own cost is refused", async () => {
  // This is the write the old rules allowed and refundJob then paid out.
  await denied(
    setDoc(doc(db, "jobs", `forged-${Date.now()}`), {
      user_id: uid, status: "pending", cost: 1e9,
    }),
    "creating a job with cost: 1e9",
  );
});

await test("a job cannot point at another user's geometry", async () => {
  await denied(
    setDoc(doc(db, "jobs", `steal-${Date.now()}`), {
      user_id: uid, status: "draft",
      step_path: "users/SOMEONE-ELSE/geometries/g1/geometry.step",
    }),
    "creating a job whose step_path is in another user's folder",
  );
});

await test("a job cannot be created for another user", async () => {
  await denied(
    setDoc(doc(db, "jobs", `other-${Date.now()}`), {
      user_id: "SOMEONE-ELSE", status: "pending",
    }),
    "creating a job owned by someone else",
  );
});

await test("a client cannot move a job's status itself", async () => {
  const id = `mine-${Date.now()}`;
  await setDoc(doc(db, "jobs", id), { user_id: uid, status: "draft" });
  await denied(
    updateDoc(doc(db, "jobs", id), { status: "complete" }),
    "updating a job status directly",
  );
});

console.log("\nrefundJob\n");

await test("a forged job refunds ZERO, not its stated cost", async () => {
  // Written with the admin SDK so it exists despite the rules — this stands in
  // for a document created before the rules were tightened, and proves the
  // ledger check is doing the work rather than the rules alone.
  const jobId = `forged-admin-${Date.now()}`;
  await admin.collection("jobs").doc(jobId).set({
    user_id: uid, status: "draft", cost: 1_000_000_000,
  });

  const before = await balance();
  const res = await httpsCallable(fns, "refundJob")({ job_id: jobId });
  const after = await balance();

  assert(res.data.refunded === 0,
    `refunded ${res.data.refunded} credits for a job that was never charged`);
  assert(after === before,
    `balance moved from ${before} to ${after} on a forged refund`);

  // And the document survives, so the evidence is not destroyed.
  const snap = await admin.collection("jobs").doc(jobId).get();
  assert(snap.exists, "the job document was deleted");
  assert(snap.data().status === "cancelled", `status is ${snap.data().status}, expected cancelled`);
});

await test("someone else's job cannot be refunded", async () => {
  const jobId = `theirs-${Date.now()}`;
  await admin.collection("jobs").doc(jobId).set({
    user_id: "SOMEONE-ELSE", status: "draft", cost: 500,
  });
  await denied(
    httpsCallable(fns, "refundJob")({ job_id: jobId }),
    "refunding a job owned by someone else",
  );
});

console.log("\ncharging\n");

await test("a real job is charged the server's price, and refunded if it cannot start", async () => {
  // One job, both assertions. Splitting them made the tests interfere: a job
  // that fails dispatch is refunded a few seconds later, so a second test
  // reading the balance in between saw it drift under its feet.
  const geomId = `g-${Date.now()}`;
  const base = `users/${uid}/geometries/${geomId}`;
  await setDoc(doc(db, "geometries", geomId), {
    user_id: uid, name: "test.step",
    step_path: `${base}/geometry.step`, label_path: `${base}/entity_labels.csv`,
  });

  const before = await balance();
  const res = await httpsCallable(fns, "submitJob")({
    geometry_id: geomId, refine_level: 1, iteration_count: 1000, file_name: "test.step",
  });
  const jobId = res.data.job_id;
  assert(res.data.status === "pending", `job created as ${res.data.status}, expected pending`);

  // Level 1 at 1000 iterations lists at 100 credits. The client asked for
  // nothing in particular; this is the server's own price.
  await waitFor(async () => (await balance()) !== before, "onJobPending to charge");
  const charged = before - (await balance());
  assert(charged === 100, `charged ${charged} credits, expected 100`);

  const ledgerRows = async () => {
    const rows = await admin.collection("users").doc(uid)
      .collection("transactions").where("job_id", "==", jobId).get();
    return rows.docs.map((d) => d.data());
  };
  const charge = (await ledgerRows()).find((d) => d.type === "simulation_charge");
  assert(charge, "no simulation_charge row was written");
  assert(charge.amount === -100, `ledger says ${charge.amount}, expected -100`);

  // There is no Cloud Run behind the emulator, so dispatch always fails. The
  // old backend took the credits and left them taken.
  await waitFor(async () => {
    const snap = await admin.collection("jobs").doc(jobId).get();
    return snap.data()?.status === "failed";
  }, "the job to fail on dispatch");

  await waitFor(async () => (await balance()) === before, "the charge to be reversed");
  const reversal = (await ledgerRows()).find((d) => d.type === "simulation_charge_reversal");
  assert(reversal, "no reversal row was written");
  assert(reversal.amount === 100, `reversal says ${reversal.amount}, expected 100`);
});

await test("a draft job is not charged", async () => {
  const before = await balance();
  const res = await httpsCallable(fns, "submitJob")({ file_name: "no-geometry.step" });
  assert(res.data.status === "draft", `expected draft, got ${res.data.status}`);
  await sleep(2500);
  assert((await balance()) === before, "a draft job took credits");
});

console.log("\nsize limits\n");

const huge = "x".repeat(5000);

await test("an oversized profile name is refused", async () => {
  await denied(
    updateDoc(doc(db, "users", uid), { name: huge }),
    "writing a 5000-character name",
  );
});

await test("a normal profile name is accepted", async () => {
  // The limit must not be so tight that ordinary use trips it.
  await updateDoc(doc(db, "users", uid), { team_name: "Red Rocket Racing" });
});

await test("an oversized job file name is refused", async () => {
  await denied(
    setDoc(doc(db, "jobs", `big-${Date.now()}`), {
      user_id: uid, status: "draft", file_name: huge,
    }),
    "creating a job with a 5000-character file name",
  );
});

await test("an oversized group name is refused", async () => {
  await denied(
    setDoc(doc(db, "groups", `bigproj-${Date.now()}`), {
      user_id: uid, name: huge,
    }),
    "creating a group with a 5000-character name",
  );
});

await test("an oversized simulation name is refused", async () => {
  await denied(
    setDoc(doc(db, "simulations", `bigsim-${Date.now()}`), {
      user_id: uid, name: huge,
    }),
    "creating a simulation with a 5000-character name",
  );
});

// These two isolate the worker-failure path from the dispatch-failure path.
// A job created as "pending" also fails dispatch under the emulator (there is
// no Cloud Run), which reverses the charge on its own — so a test that started
// there would pass whatever the failure handler did. Instead the charge is
// written by hand and the job starts past pending.
async function seedChargedJob(jobId, fields) {
  await admin.collection("jobs").doc(jobId).set({ user_id: uid, ...fields });
  await admin.collection("users").doc(uid).collection("transactions")
    .doc(`charge_${jobId}`).set({
      type: "simulation_charge", amount: -100, job_id: jobId,
      reason: "test", timestamp: new Date(),
    });
  await admin.collection("users").doc(uid)
    .update({ credits: (await balance()) - 100 });
}

await test("a run that fails before solving gives the credits back", async () => {
  const jobId = `wfail-${Date.now()}`;
  await seedChargedJob(jobId, { status: "downloading" });
  const charged = await balance();

  // The worker giving up before it meshed anything.
  await admin.collection("jobs").doc(jobId).update({
    status: "failed", error: "The simulation worker is not configured.",
  });

  await waitFor(async () => (await balance()) === charged + 100,
    "the charge to be reversed");
  const rows = await admin.collection("users").doc(uid)
    .collection("transactions").where("job_id", "==", jobId).get();
  assert(rows.docs.some((d) => d.data().type === "simulation_charge_reversal"),
    "no reversal row was written");
});

await test("a run that fails after solving keeps the charge", async () => {
  // Past this point SimScale compute was really spent, so the charge stands —
  // the same line refundJob draws.
  const jobId = `sfail-${Date.now()}`;
  await seedChargedJob(jobId, { status: "running", mesh_id: "mesh-123" });
  const charged = await balance();

  await admin.collection("jobs").doc(jobId).update({
    status: "failed", error: "Run failed: DIVERGED",
  });
  await sleep(5000);
  assert((await balance()) === charged,
    `balance moved from ${charged} to ${await balance()} — the charge was reversed `
    + "even though the solver had already run");
});

console.log("\nFusion connection tokens\n");

let fusionToken = null;
let fusionTokenId = null;

await test("a connection token is minted, and is not the refresh token", async () => {
  const res = await httpsCallable(fns, "createFusionToken")({ label: "Test rig" });
  fusionToken = res.data.token;
  fusionTokenId = res.data.id;
  assert(typeof fusionToken === "string" && fusionToken.startsWith("tfk_"),
    `expected a tfk_ token, got ${fusionToken}`);
  assert(fusionToken !== auth.currentUser.refreshToken,
    "the minted token IS the account refresh token");
});

await test("the stored token is a hash, never the token itself", async () => {
  const secrets = await admin.collection("fusion_tokens").get();
  const mine = secrets.docs.filter((d) => d.data().user_id === uid);
  assert(mine.length === 1, `expected 1 stored token, found ${mine.length}`);
  const raw = JSON.stringify(mine[0].data()) + mine[0].id;
  assert(!raw.includes(fusionToken), "the token was stored in a recoverable form");
});

await test("the listing the user can read carries no secret", async () => {
  const snap = await getDoc(doc(db, "users", uid, "fusion_tokens", fusionTokenId));
  assert(snap.exists(), "the token listing is not readable by its owner");
  const raw = JSON.stringify(snap.data());
  assert(!raw.includes(fusionToken), "the readable listing contains the token");
});

await test("a client cannot write its own token listing", async () => {
  await denied(
    setDoc(doc(db, "users", uid, "fusion_tokens", "forged"), { label: "mine" }),
    "writing a token listing directly",
  );
});

await test("a session from a connection token cannot buy credits", async () => {
  // What the claim is for: a leaked token submits jobs, it does not spend money.
  const exchanged = await fetch(
    "http://127.0.0.1:5001/demo-turboflow/us-central1/exchangeFusionToken",
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: fusionToken }) });
  assert(exchanged.ok, `exchange failed: ${exchanged.status}`);
  const { custom_token } = await exchanged.json();

  await signInWithCustomToken(auth, custom_token);
  await denied(
    httpsCallable(fns, "createPayPalOrder")({ product: "credits", credits: 100 }),
    "buying credits from a connection-token session",
  );
  await denied(
    updateDoc(doc(db, "users", uid), { team_name: "changed by a script" }),
    "editing the profile from a connection-token session",
  );

  // Back to a normal session for anything after this.
  await signInWithCredential(auth, GoogleAuthProvider.credential(JSON.stringify({
    sub: `google-${uid}`, email, email_verified: true,
  })));
});

await test("an unknown connection token is refused", async () => {
  const res = await fetch(
    "http://127.0.0.1:5001/demo-turboflow/us-central1/exchangeFusionToken",
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "tfk_" + "z".repeat(43) }) });
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

// ── groups and sharing (build spec 14.1) ───────────────────────────────────
console.log("\nProjects, folders and sharing\n");

// A second signed-in account, so sharing can be tested from both ends rather
// than asserted from the owner's side only.
const otherEmail = `o${Date.now()}@example.com`;
const otherApp = initializeApp({ apiKey: "fake-api-key", projectId: PROJECT }, "other");
const otherAuth = getAuth(otherApp);
const otherDb = getFirestore(otherApp);
connectAuthEmulator(otherAuth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(otherDb, "127.0.0.1", 8080);
const otherCred = await signInWithCredential(
  otherAuth,
  GoogleAuthProvider.credential(JSON.stringify({
    sub: `google-other-${Date.now()}`, email: otherEmail, email_verified: true, name: "Rival Team",
  })),
);
const otherUid = otherCred.user.uid;
{
  const otherFns = getFunctions(otherApp);
  connectFunctionsEmulator(otherFns, "127.0.0.1", 5001);
  await httpsCallable(otherFns, "ensureAccount")({});
}
await waitFor(async () => (await admin.collection("users").doc(otherUid).get()).exists,
  "the second account to be created");

let sharedGroupId = null;

await test("createGroup writes a group owned by the caller", async () => {
  const res = await httpsCallable(fns, "createGroup")({
    name: "Wind tunnel tests", description: "the good one", tags: ["aero", "2026"],
  });
  sharedGroupId = res.data.group_id;
  assert(sharedGroupId, "no group_id came back");
  const snap = await admin.collection("groups").doc(sharedGroupId).get();
  assert(snap.get("user_id") === uid, "group is not owned by the caller");
  assert(snap.get("unit_system") === "SI", "unit_system did not default to SI");
  assert(JSON.stringify(snap.get("shared_with")) === "{}", "a new group is shared with nobody");
});

await test("a group name over 200 characters is refused", async () => {
  await denied(
    httpsCallable(fns, "createGroup")({ name: "x".repeat(201) }),
    "an oversized group name",
  );
});

await test("a stranger cannot read a group that is not shared", async () => {
  await denied(getDoc(doc(otherDb, "groups", sharedGroupId)), "reading a stranger's group");
});

// This used to assert the opposite: that shareGroup replies "No TurboFlow
// account with that email." It does not any more, on purpose.
//
// That reply was an account-existence oracle. Sixty calls an hour, any address
// you like, and the answer tells you whether that person has an account here -
// a list of this product's users, assembled from a competitor's team sheet.
//
// Both outcomes now look the same to the caller. The owner typed the address
// and knows whether they expect it to work; a stranger learns nothing. An
// address with no account simply never appears in the share list.
await test("shareGroup does not say whether an email has an account", async () => {
  const unknown = await httpsCallable(fns, "shareGroup")({
    group_id: sharedGroupId, email: "nobody@example.com", permission: "view",
  });
  assert(unknown.data?.pending === true,
    `expected a pending share, got ${JSON.stringify(unknown.data)}`);
  assert(unknown.data?.uid == null, "an unknown address must not resolve to a uid");

  // And nothing was written, so the group is not quietly shared with a
  // stranger who later signs up on that address.
  const snap = await admin.collection("groups").doc(sharedGroupId).get();
  const shared = snap.get("shared_with") ?? {};
  assert(!Object.values(shared).length || !Object.keys(shared).includes("nobody@example.com"),
    "an unknown address was recorded on the group");

  // The real share still works and still returns the uid, so the owner can see
  // who is on the group.
  const known = await httpsCallable(fns, "shareGroup")({
    group_id: sharedGroupId, email: otherEmail, permission: "view",
  });
  assert(known.data?.uid === otherUid, "a real share must resolve to the account");
  assert(!known.data?.pending, "a real share is not pending");
});

await test("a collaborator with view can read the group", async () => {
  await httpsCallable(fns, "shareGroup")({
    group_id: sharedGroupId, email: otherEmail, permission: "view",
  });
  const snap = await getDoc(doc(otherDb, "groups", sharedGroupId));
  assert(snap.exists(), "the collaborator could not read the shared group");
});

await test("a collaborator with view cannot write the group", async () => {
  await denied(
    updateDoc(doc(otherDb, "groups", sharedGroupId), { name: "mine now" }),
    "a view collaborator writing the group",
  );
});

await test("a collaborator cannot promote themselves to edit", async () => {
  await denied(
    updateDoc(doc(otherDb, "groups", sharedGroupId), { [`shared_with.${otherUid}`]: "edit" }),
    "a collaborator promoting themselves",
  );
});

await test("the owner cannot rewrite shared_with directly either", async () => {
  await denied(
    updateDoc(doc(db, "groups", sharedGroupId), { shared_with: { [otherUid]: "edit" } }),
    "the owner editing shared_with outside the callable",
  );
});

await test("a collaborator with view can read the group's simulations", async () => {
  const simRef = admin.collection("simulations").doc();
  await simRef.set({ user_id: uid, group_id: sharedGroupId, name: "Case 1" });
  const snap = await getDoc(doc(otherDb, "simulations", simRef.id));
  assert(snap.exists(), "the collaborator could not read a simulation in the shared group");
});

// ── listing a group's contents ──────────────────────────────────────────
// These exist because the Workbench showed an empty tree over a group that
// had a car in it, and nothing anywhere said why.
//
// A list rule is not evaluated against the documents it would return. It runs
// once against a document carrying only the fields the query constrains with
// equality; every other field reads as undefined, and reading one is an error
// that fails the whole rule. So a rule written as
// `resource.data.user_id == request.auth.uid` refuses a query filtered by
// group_id even when every document it would return belongs to the caller.
//
// Nothing in the suite covered a list, only gets, which is why it passed
// through. Both query shapes are tested here now, from both sides.

await test("the owner can list a group's geometries by group", async () => {
  const g = admin.collection("geometries").doc();
  await g.set({ user_id: uid, group_id: sharedGroupId, name: "car.step" });
  const snap = await getDocs(query(collection(db, "geometries"),
    where("group_id", "==", sharedGroupId)));
  assert(snap.size >= 1, "the owner could not list their own group's geometries");
});

await test("the owner can still list geometries by owner", async () => {
  const snap = await getDocs(query(collection(db, "geometries"),
    where("user_id", "==", uid)));
  assert(snap.size >= 1, "the owner could not list their own geometries");
});

await test("a collaborator can list the shared group's geometries", async () => {
  const snap = await getDocs(query(collection(otherDb, "geometries"),
    where("group_id", "==", sharedGroupId)));
  assert(snap.size >= 1, "the collaborator could not list the shared geometries");
});

await test("a collaborator can list the shared group's simulations and runs", async () => {
  const r = admin.collection("runs").doc();
  await r.set({ user_id: uid, group_id: sharedGroupId, status: "finished" });
  const sims = await getDocs(query(collection(otherDb, "simulations"),
    where("group_id", "==", sharedGroupId)));
  assert(sims.size >= 1, "the collaborator could not list the shared simulations");
  const runs = await getDocs(query(collection(otherDb, "runs"),
    where("group_id", "==", sharedGroupId)));
  assert(runs.size >= 1, "the collaborator could not list the shared runs");
});

await test("a stranger cannot list another team's geometries", async () => {
  const theirs = admin.collection("groups").doc();
  await theirs.set({ user_id: "someone-else", name: "Theirs", shared_with: {} });
  const g = admin.collection("geometries").doc();
  await g.set({ user_id: "someone-else", group_id: theirs.id, name: "secret.step" });
  await denied(
    getDocs(query(collection(db, "geometries"), where("group_id", "==", theirs.id))),
    "listing another team's geometries",
  );
});

await test("a group that does not exist is a plain refusal, not an error", async () => {
  // memberOf checks exists() before get(). Without it this comes back as
  // "Null value error" rather than permission-denied, and an error in a rule
  // cannot be told apart from a bug in the rule.
  await denied(
    getDocs(query(collection(db, "geometries"), where("group_id", "==", "no-such-group"))),
    "listing geometries of a group that is not there",
  );
});

await test("a stranger cannot read a simulation in a group they were not given", async () => {
  const lonely = admin.collection("groups").doc();
  await lonely.set({ user_id: uid, name: "Private", shared_with: {} });
  const simRef = admin.collection("simulations").doc();
  await simRef.set({ user_id: uid, group_id: lonely.id, name: "Case 2" });
  await denied(getDoc(doc(otherDb, "simulations", simRef.id)), "reading a private simulation");
});

await test("unshareGroup takes the access away again", async () => {
  await httpsCallable(fns, "unshareGroup")({ group_id: sharedGroupId, uid: otherUid });
  await denied(getDoc(doc(otherDb, "groups", sharedGroupId)), "reading after unshare");
});

await test("a client cannot write a run document", async () => {
  await denied(
    setDoc(doc(db, "runs", "forged-run"), { user_id: uid, status: "finished", summary: { cd: 0.1 } }),
    "forging a finished run",
  );
});

await test("a client cannot mark a geometry ready", async () => {
  const gid = `g${Date.now()}`;
  await admin.collection("geometries").doc(gid).set({
    user_id: uid, group_id: sharedGroupId, name: "car.step", status: "uploading",
  });
  await denied(
    updateDoc(doc(db, "geometries", gid), { status: "ready" }),
    "a client setting geometry status",
  );
  await denied(
    updateDoc(doc(db, "geometries", gid), { current_version: 9 }),
    "a client setting current_version",
  );
});

await test("a client cannot mark its own simulation valid", async () => {
  const simRef = admin.collection("simulations").doc();
  await simRef.set({ user_id: uid, group_id: sharedGroupId, name: "Case 3" });
  await denied(
    updateDoc(doc(db, "simulations", simRef.id), { validation: { ok: true, errors: [] } }),
    "a client writing validation",
  );
});

await test("copyGroup duplicates the children under new ids", async () => {
  const res = await httpsCallable(fns, "copyGroup")({ group_id: sharedGroupId });
  const copyId = res.data.group_id;
  assert(copyId && copyId !== sharedGroupId, "the copy reused the original id");
  const copy = await admin.collection("groups").doc(copyId).get();
  assert(JSON.stringify(copy.get("shared_with")) === "{}", "a copy carried the original's sharing");
  const sims = await admin.collection("simulations").where("group_id", "==", copyId).get();
  assert(sims.size >= 1, "the copy has no simulations");
  for (const d of sims.docs) {
    assert(d.get("validation") == null, "a copied simulation kept its validation");
  }
});

await test("deleting a group with a running job is refused", async () => {
  const runRef = admin.collection("runs").doc();
  await runRef.set({ user_id: uid, group_id: sharedGroupId, status: "running", job_id: "j1" });
  let message = "";
  try {
    await httpsCallable(fns, "deleteGroup")({ group_id: sharedGroupId });
  } catch (err) { message = err.message || ""; }
  assert(message.includes("Cancel running jobs first"), `expected the cancel message, got "${message}"`);
  await runRef.update({ status: "finished" });
});

await test("deleteGroup removes the group and its children", async () => {
  await httpsCallable(fns, "deleteGroup")({ group_id: sharedGroupId });
  const gone = await admin.collection("groups").doc(sharedGroupId).get();
  assert(!gone.exists, "the group survived deletion");
  const sims = await admin.collection("simulations").where("group_id", "==", sharedGroupId).get();
  assert(sims.empty, `${sims.size} simulations were left behind`);
  const runs = await admin.collection("runs").where("group_id", "==", sharedGroupId).get();
  assert(runs.empty, `${runs.size} runs were left behind`);
  const geoms = await admin.collection("geometries").where("group_id", "==", sharedGroupId).get();
  assert(geoms.empty, `${geoms.size} geometries were left behind`);
});

await test("someone else's group cannot be deleted", async () => {
  const theirs = admin.collection("groups").doc();
  await theirs.set({ user_id: otherUid, name: "Theirs", shared_with: {} });
  await denied(
    httpsCallable(fns, "deleteGroup")({ group_id: theirs.id }),
    "deleting a stranger's group",
  );
});

// ── simulation setup, save and validate (build spec 14.5) ─────────────────
// The checks the spec names, plus the one that matters most in practice: a
// face assigned to two boundary conditions. That mistake does not fail a
// run. The solver takes one of them, the other silently does nothing, and
// the team gets a plausible drag number for a car they did not model.
console.log("\nSimulation setup and validation\n");

const simGroup = (await httpsCallable(fns, "createGroup")({ name: "Validation" })).data.group_id;
// A geometry to attach it to. Without one the checker says so, correctly,
// and every other assertion here would be drowned by that one error.
const simGeomRef = admin.collection("geometries").doc();
await simGeomRef.set({
  user_id: uid, group_id: simGroup, name: "car.step",
  status: "ready", current_version: 1, versions: {},
});
let simId = null;

const vector = (x, y, z) => ({
  x: { type: "CONSTANT", value: x },
  y: { type: "CONSTANT", value: y },
  z: { type: "CONSTANT", value: z },
});

const inlet = (faces = [1]) => ({
  name: "Velocity inlet 1", type: "VELOCITY_INLET_V3",
  velocity: { type: "FIXED_VALUE", value: { value: vector(-20, 0, 0), unit: "m/s" } },
  turbulence: { type: "AUTOMATIC_TURBULENCE" },
  topologicalReference: { faces },
});
const outlet = (faces = [2]) => ({
  name: "Pressure outlet 1", type: "PRESSURE_OUTLET_V30",
  gaugePressure: { type: "FIXED_VALUE", value: { value: { type: "CONSTANT", value: 0 }, unit: "Pa" } },
  topologicalReference: { faces },
});
const wallBc = (name, faces) => ({
  name, type: "WALL_V34",
  velocity: { type: "NO_SLIP", turbulenceWall: "WALL_FUNCTION" },
  topologicalReference: { faces },
});

const specWith = (bcs, extra = {}) => ({
  type: "INCOMPRESSIBLE",
  turbulenceModel: "KOMEGASST",
  timeDependency: { type: "STATIONARY" },
  algorithm: "SIMPLE",
  materials: { fluids: [{ name: "Air" }] },
  initialConditions: {
    gaugePressure: { global: { value: 0, unit: "Pa" }, subdomains: [] },
    velocity: { global: { value: { x: 0, y: 0, z: 0 }, unit: "m/s" }, subdomains: [] },
    turbulentKineticEnergy: { global: { value: 0.00375, unit: "m\u00b2/s\u00b2" } },
    omegaDissipationRate: { global: { value: 3.375, unit: "1/s" } },
  },
  boundaryConditions: bcs,
  numerics: {},
  simulationControl: {
    endTime: { value: 1000, unit: "s" },
    deltaT: { value: 1, unit: "s" },
    writeControl: { type: "TIME_STEP", writeInterval: 1000 },
    numProcessors: -1,
    maxRunTime: { value: 20000, unit: "s" },
  },
  resultControl: {
    forcesMoments: [{ name: "Drag and lift" }],
    surfaceData: [], scalarTransport: [], probePoints: [], fieldCalculations: [],
  },
  ...extra,
});

await test("createSimulation writes the default Incompressible setup", async () => {
  const res = await httpsCallable(fns, "createSimulation")({
    group_id: simGroup, geometry_id: simGeomRef.id,
  });
  simId = res.data.simulation_id;
  const snap = await admin.collection("simulations").doc(simId).get();
  assert(snap.get("name") === "Incompressible", `named ${snap.get("name")}`);
  assert(snap.get("spec").turbulenceModel === "KOMEGASST", "wrong turbulence model");
  // 9.5, not 5: the default moved to the value the Fusion add-in has meshed
  // every real car with, and 5.0 is not on the priced ladder in lib/pricing
  // at all. DEFAULT_MESH_SPEC in functions/src/simulations is the source.
  assert(snap.get("mesh_spec").sizing.fineness === 9.5,
    `wrong default fineness: ${snap.get("mesh_spec").sizing.fineness}`);
  // The one string that does not survive a careless encoding round trip.
  assert(
    snap.get("spec").initialConditions.turbulentKineticEnergy.global.unit === "m\u00b2/s\u00b2",
    "the turbulent kinetic energy unit is not exactly m squared per s squared",
  );
});

await test("a second simulation is numbered rather than duplicated", async () => {
  const res = await httpsCallable(fns, "createSimulation")({ group_id: simGroup });
  const snap = await admin.collection("simulations").doc(res.data.simulation_id).get();
  assert(snap.get("name") === "Incompressible 1", `named ${snap.get("name")}`);
});

await test("an inlet, an outlet, a wall and Air validate clean", async () => {
  const res = await httpsCallable(fns, "saveSimulation")({
    simulation_id: simId,
    spec: specWith([inlet([1]), outlet([2]), wallBc("Wall 1", [3, 4])]),
  });
  assert(res.data.ok, `expected ok, got ${JSON.stringify(res.data.errors)}`);
});

await test("removing the outlet is reported", async () => {
  const res = await httpsCallable(fns, "saveSimulation")({
    simulation_id: simId,
    spec: specWith([inlet([1]), wallBc("Wall 1", [3, 4])]),
  });
  assert(!res.data.ok, "expected the setup to be refused");
  assert(res.data.errors.some((e) => e.includes("No outlet")),
    `expected an outlet error, got ${JSON.stringify(res.data.errors)}`);
});

await test("one face in two boundary conditions names both", async () => {
  const res = await httpsCallable(fns, "saveSimulation")({
    simulation_id: simId,
    spec: specWith([inlet([1]), outlet([2]), wallBc("Wall 1", [3]), wallBc("Wall 2", [3])]),
  });
  assert(!res.data.ok, "expected the setup to be refused");
  const clash = res.data.errors.find((e) => e.includes("Face 3"));
  assert(clash, `expected a clash on face 3, got ${JSON.stringify(res.data.errors)}`);
  assert(clash.includes("Wall 1") && clash.includes("Wall 2"),
    `expected both names, got "${clash}"`);
});

await test("a boundary condition with no faces is reported", async () => {
  const res = await httpsCallable(fns, "saveSimulation")({
    simulation_id: simId,
    spec: specWith([inlet([1]), outlet([2]), wallBc("Wall 1", [])]),
  });
  assert(res.data.errors.some((e) => e.includes("no faces assigned")),
    `got ${JSON.stringify(res.data.errors)}`);
});

await test("a fineness between two steps is reported", async () => {
  const res = await httpsCallable(fns, "saveSimulation")({
    simulation_id: simId,
    spec: specWith([inlet([1]), outlet([2])]),
    mesh_spec: {
      type: "SIMMETRIX_MESHING_FLUID_V16",
      sizing: { type: "AUTOMATIC_V9", fineness: 5.05 },
      refinements: [],
    },
  });
  assert(res.data.errors.some((e) => e.includes("not a multiple of 0.1")),
    `got ${JSON.stringify(res.data.errors)}`);
});

await test("no force result control is a warning, not an error", async () => {
  const spec = specWith([inlet([1]), outlet([2])]);
  spec.resultControl.forcesMoments = [];
  const res = await httpsCallable(fns, "saveSimulation")({ simulation_id: simId, spec });
  assert(res.data.warnings.some((w) => w.includes("forces and moments")),
    `got ${JSON.stringify(res.data.warnings)}`);
  assert(!res.data.errors.some((e) => e.includes("forces")), "a warning became an error");
});

await test("an inlet at 300 m/s is questioned", async () => {
  const fast = inlet([1]);
  fast.velocity.value.value = vector(-300, 0, 0);
  const res = await httpsCallable(fns, "saveSimulation")({
    simulation_id: simId, spec: specWith([fast, outlet([2])]),
  });
  assert(res.data.warnings.some((w) => w.includes("300.0 m/s")),
    `got ${JSON.stringify(res.data.warnings)}`);
});

await test("a boundary condition type the API does not have is refused", async () => {
  await denied(
    httpsCallable(fns, "saveSimulation")({
      simulation_id: simId,
      spec: specWith([{ name: "Nope", type: "MAGIC_WALL", topologicalReference: { faces: [1] } }]),
    }),
    "an invented boundary condition type",
  );
});

await test("a mistyped unit is refused rather than sent to SimScale", async () => {
  const spec = specWith([inlet([1]), outlet([2])]);
  // The mojibake an encoding slip produces. SimScale rejects it with a
  // message about the value, which sends the search the wrong way.
  spec.initialConditions.turbulentKineticEnergy.global.unit = "m\u00c2\u00b2/s\u00c2\u00b2";
  await denied(
    httpsCallable(fns, "saveSimulation")({ simulation_id: simId, spec }),
    "a mis-encoded unit string",
  );
});

await test("a direct write is validated by the trigger too", async () => {
  // Autosave writes straight to Firestore. Without the trigger a setup saved
  // that way would keep whatever validation it had, so a broken one could
  // still show a green tick.
  await updateDoc(doc(db, "simulations", simId), {
    spec: specWith([inlet([1])]),          // no outlet
  });
  await waitFor(async () => {
    const snap = await admin.collection("simulations").doc(simId).get();
    return snap.get("validation")?.errors?.some((e) => e.includes("No outlet"));
  }, "the trigger to re-check a direct write");
});

await test("a client cannot mark its own setup valid", async () => {
  await denied(
    updateDoc(doc(db, "simulations", simId), { validation: { ok: true, errors: [], warnings: [] } }),
    "a client writing validation",
  );
});

await httpsCallable(fns, "deleteGroup")({ group_id: simGroup }).catch(() => {});

// ── queueing a run (build spec 14.6) ──────────────────────────────────────
// The money step. Two things matter here and nothing else does: a broken
// setup must be refused before any document is written, and a good one must
// be charged exactly once.
console.log("\nQueueing a run\n");

const runGroup = (await httpsCallable(fns, "createGroup")({ name: "Queue" })).data.group_id;
const runGeom = admin.collection("geometries").doc();
await runGeom.set({
  user_id: uid, group_id: runGroup, name: "car.step", status: "ready",
  current_version: 1,
  versions: { 1: { step_path: `users/${uid}/geometries/${runGeom.id}/v1/geometry.step` } },
});
const runSim = (await httpsCallable(fns, "createSimulation")({
  group_id: runGroup, geometry_id: runGeom.id,
})).data.simulation_id;

await test("a run cannot be queued from a setup that is not ready", async () => {
  let message = "";
  try {
    await httpsCallable(fns, "queueRun")({ simulation_id: runSim });
  } catch (err) { message = err.message || ""; }
  assert(message.includes("cannot run yet"), `expected a refusal, got "${message}"`);
  const jobs = await admin.collection("jobs").where("simulation_ref", "==", runSim).get();
  assert(jobs.empty, "a job was written for a setup that cannot run");
  const runs = await admin.collection("runs").where("simulation_id", "==", runSim).get();
  assert(runs.empty, "a run was written for a setup that cannot run");
});

await test("a complete setup queues one run and one job", async () => {
  await httpsCallable(fns, "saveSimulation")({
    simulation_id: runSim,
    spec: specWith([inlet([1]), outlet([2]), wallBc("Wall 1", [3])]),
  });
  await admin.collection("users").doc(uid).set({ credits: 5000 }, { merge: true });

  const res = await httpsCallable(fns, "queueRun")({ simulation_id: runSim });
  assert(res.data.run_id && res.data.job_id, "no ids came back");
  assert(res.data.price > 0, `expected a price, got ${res.data.price}`);

  const run = await admin.collection("runs").doc(res.data.run_id).get();
  assert(run.get("status") === "queued", `run is ${run.get("status")}`);
  assert(run.get("spec_snapshot"), "the run kept no snapshot of the setup");
  assert(run.get("job_id") === res.data.job_id, "the run does not point at its job");

  const job = await admin.collection("jobs").doc(res.data.job_id).get();
  assert(job.get("spec_mode") === true, "the job is not in spec mode");
  assert(job.get("run_ref") === res.data.run_id, "the job does not point at its run");
  assert(job.get("step_path"), "the job has no STEP to send");
});

await test("the run is charged once, and given back when dispatch fails", async () => {
  // The emulator cannot reach Cloud Run, so the worker never starts. That
  // makes this the test for the path that matters most: we took the money
  // and could not do the work, so it goes back. An earlier version of this
  // backend left the user out of pocket here.
  const runs = await admin.collection("runs").where("simulation_id", "==", runSim).get();
  const jobId = runs.docs[0].get("job_id");
  await waitFor(async () => {
    const ledger = await admin.collection("users").doc(uid)
      .collection("transactions").where("job_id", "==", jobId).get();
    return ledger.size >= 2;
  }, "the charge and its reversal to reach the ledger");

  const ledger = await admin.collection("users").doc(uid)
    .collection("transactions").where("job_id", "==", jobId).get();
  const charges = ledger.docs.filter((d) => d.get("type") === "simulation_charge");
  const reversals = ledger.docs.filter((d) => d.get("type") === "simulation_charge_reversal");
  assert(charges.length === 1, `expected one charge, found ${charges.length}`);
  assert(reversals.length === 1, `expected one reversal, found ${reversals.length}`);
  assert(charges[0].get("amount") < 0, "a charge should be negative");
  assert(charges[0].get("amount") + reversals[0].get("amount") === 0,
    "the reversal did not undo the charge exactly");

  const after = await admin.collection("users").doc(uid).get();
  assert(after.get("credits") === 5000, `balance is ${after.get("credits")}, expected 5000`);
});

await test("cancelling a running run asks the worker to stop", async () => {
  // Its own run, not the one the previous test left behind.
  //
  // That run is deliberately a failed one: it exists to prove the charge is
  // reversed when dispatch fails. Cancelling it is correctly refused, and
  // once onJobFinished started mirroring a job's ending onto its run, this
  // test began failing on a refusal that is the right answer. A cancel test
  // needs something cancellable.
  const jobRef = admin.collection("jobs").doc();
  const runRef = admin.collection("runs").doc();
  await jobRef.set({
    user_id: uid, group_id: runGroup, status: "running",
    run_ref: runRef.id, spec_mode: true,
  });
  await runRef.set({
    user_id: uid, group_id: runGroup, simulation_id: runSim,
    job_id: jobRef.id, name: "Cancel me", status: "running",
  });

  await httpsCallable(fns, "cancelRun")({ run_id: runRef.id });
  const run = await runRef.get();
  assert(run.get("status") === "cancelling", `run is ${run.get("status")}`);
  const job = await jobRef.get();
  assert(job.get("status") === "cancelling", `job is ${job.get("status")}`);
});

await test("a run that already failed cannot be cancelled", async () => {
  const runs = await admin.collection("runs")
    .where("simulation_id", "==", runSim).where("status", "==", "failed").get();
  assert(!runs.empty, "expected the dispatch-failure run to be marked failed");
  await denied(
    httpsCallable(fns, "cancelRun")({ run_id: runs.docs[0].id }),
    "cancelling a run that has already failed",
  );
});

await test("someone else's run cannot be cancelled", async () => {
  const theirs = admin.collection("runs").doc();
  await theirs.set({ user_id: otherUid, group_id: "nope", status: "running" });
  await denied(
    httpsCallable(fns, "cancelRun")({ run_id: theirs.id }),
    "cancelling a stranger's run",
  );
});

// ── a run cannot buy more compute than it paid for ────────────────────────
//
// queueRun prices a run from the end time in the spec and the fineness in the
// mesh spec, and caps both. Those caps only ever reached the `jobs` document.
// What the worker posts to SimScale is spec_snapshot and mesh_snapshot, which
// were the simulation document as written - and a client writes that document
// directly, since the rules check only that `spec` has at most 30 top-level
// keys. 200,000 iterations for the price of 3,000.
console.log("\nPaying for what you get\n");

await test("a greedy setup is cut to the run it paid for", async () => {
  const greedyGeom = admin.collection("geometries").doc();
  await greedyGeom.set({
    user_id: uid, group_id: runGroup, name: "greedy.step", status: "ready",
    current_version: 1,
    versions: { 1: { step_path: `users/${uid}/geometries/${greedyGeom.id}/v1/geometry.step` } },
  });
  const simId = (await httpsCallable(fns, "createSimulation")({
    group_id: runGroup, geometry_id: greedyGeom.id,
  })).data.simulation_id;

  // Written straight to Firestore, which is the way round that skips every
  // zod schema in the backend.
  await updateDoc(doc(db, "simulations", simId), {
    spec: specWith([inlet([1]), outlet([2]), wallBc("Wall 1", [3])], {
      simulationControl: {
        endTime: { value: 200000, unit: "s" },
        deltaT: { value: 1, unit: "s" },
        writeControl: { type: "TIME_STEP", writeInterval: 200000 },
        maxRunTime: { value: 4000000, unit: "s" },
      },
    }),
    mesh_spec: {
      type: "SIMMETRIX_MESHING_FLUID_V16",
      sizing: { type: "AUTOMATIC_V9", fineness: 9.0 },
      refinements: [{
        type: "SURFACE_CUSTOM_SIZING", name: "all of it",
        sizing: { type: "AUTOMATIC_V9", fineness: 10 },
        topologicalReference: { faces: [1, 2, 3] },
      }],
      automaticLayerSettings: {
        type: "AUTOMATIC_LAYER_ON",
        layerType: { type: "FRACTIONAL_HEIGHT_2", numberOfLayers: 40, growthRate: 1.5 },
      },
      numOfProcessors: 96,
    },
  });
  await waitFor(async () => {
    const s = await admin.collection("simulations").doc(simId).get();
    return s.get("validation")?.ok === true;
  }, "the checker to accept the greedy setup");

  await admin.collection("users").doc(uid).set({ credits: 100000 }, { merge: true });
  const res = await httpsCallable(fns, "queueRun")({ simulation_id: simId });
  const run = await admin.collection("runs").doc(res.data.run_id).get();

  const sent = run.get("spec_snapshot");
  const mesh = run.get("mesh_snapshot");
  assert(sent.simulationControl.endTime.value === 3000,
    `the solver was asked for ${sent.simulationControl.endTime.value} iterations`);
  assert(sent.simulationControl.maxRunTime.value <= 21600,
    `max run time is ${sent.simulationControl.maxRunTime.value} s`);
  assert(mesh.refinements[0].sizing.fineness <= 9.5,
    `a refinement went out at fineness ${mesh.refinements[0].sizing.fineness}`);
  assert(mesh.automaticLayerSettings.layerType.numberOfLayers <= 10,
    `${mesh.automaticLayerSettings.layerType.numberOfLayers} boundary layers went out`);
  assert(mesh.numOfProcessors === -1, `numOfProcessors went out as ${mesh.numOfProcessors}`);
  assert((run.get("clamped") ?? []).length > 0, "nothing was recorded as cut");

  // And the document the user typed is left alone - only the snapshot is cut.
  const sim = await admin.collection("simulations").doc(simId).get();
  assert(sim.get("spec").simulationControl.endTime.value === 200000,
    "the simulation document was edited under the user");
});

// ── a group you are not in is not yours to put things in ──────────────────
//
// The list rules let a group member read anything carrying their group_id, so
// a stranger who learned a group id could plant a car, with a name of their
// choosing, in somebody else's Workbench. Nothing checked membership on create,
// here or in createUploadIntent, while createSimulation had checked it all
// along.
console.log("\nPlanting things in someone else's group\n");

await test("a stranger cannot file a geometry into a group they are not in", async () => {
  await denied(
    setDoc(doc(otherDb, "geometries", `planted${Date.now()}`), {
      user_id: otherUid, group_id: runGroup, name: "not yours", status: "uploading",
    }),
    "creating a geometry in a stranger's group",
  );
});

await test("nor a simulation", async () => {
  await denied(
    setDoc(doc(otherDb, "simulations", `planted${Date.now()}`), {
      user_id: otherUid, group_id: runGroup, name: "not yours",
    }),
    "creating a simulation in a stranger's group",
  );
});

await test("createUploadIntent refuses a group the caller is not in", async () => {
  const otherFns = getFunctions(otherApp);
  connectFunctionsEmulator(otherFns, "127.0.0.1", 5001);
  await denied(
    httpsCallable(otherFns, "createUploadIntent")({
      group_id: runGroup, name: "not yours", kind: "raw", ext: "step", size_bytes: 1000,
    }),
    "claiming an upload path inside a stranger's group",
  );
});

await test("a geometry with no group is still allowed", async () => {
  // The check must not break the ordinary case: a car imported before any
  // group has been chosen carries no group_id at all.
  const id = `loose${Date.now()}`;
  await setDoc(doc(db, "geometries", id), {
    user_id: uid, name: "loose.step", status: "uploading",
  });
  const snap = await getDoc(doc(db, "geometries", id));
  assert(snap.exists(), "a geometry with no group was refused");
});

// ── a job may only name its own bytes ─────────────────────────────────────
await test("a job cannot name a step under a different job's folder", async () => {
  const mine = `job${Date.now()}`;
  await denied(
    setDoc(doc(db, "jobs", mine), {
      user_id: uid, status: "pending",
      step_path: "jobs/someone-elses-job-id/geometry.step",
    }),
    "naming another job's upload folder",
  );
});

await test("but it may name its own", async () => {
  const mine = `job${Date.now()}b`;
  await setDoc(doc(db, "jobs", mine), {
    user_id: uid, status: "draft",
    step_path: `jobs/${mine}/geometry.step`,
  });
  const snap = await getDoc(doc(db, "jobs", mine));
  assert(snap.exists(), "a job naming its own folder was refused");
});

await httpsCallable(fns, "deleteGroup")({ group_id: runGroup }).catch(() => {});

await signOut(otherAuth).catch(() => {});

// ── report ─────────────────────────────────────────────────────────────────

await signOut(auth).catch(() => {});
console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const [name, err] of failures) console.log(`FAILED: ${name}\n  ${err.stack}\n`);
  process.exit(1);
}
process.exit(0);
