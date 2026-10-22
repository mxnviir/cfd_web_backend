// Replay the old Fusion 360 add-in against a project, request for request.
//
// The add-in production hands out today (TurboFlow_CFD.zip, August 2026)
// signs in with a stored refresh token, reads the user's credits, uploads the
// STEP and a face-label CSV to jobs/<id>/, and writes the job document with
// camelCase fields and status "pending". Those are copies installed on users'
// machines; they will keep sending exactly this after production moves to the
// new build. This sends the same requests, in the same order, with the same
// field names and value types, and then watches what the new backend does
// with the job. Then it cancels, so no solve is paid for.
//
// The refresh token comes from an admin-signed custom-token session for an
// existing Google account on the project (as in e2e_autosetup.mjs), not from a
// password or a real user's machine.
//
// Run: E2E_ADMIN_TOKEN=... node tests/replay_old_addin.mjs [project]
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const PROJECT = process.argv[2] || "turboflow-test";
if (PROJECT === "turboflow-7b3ca") throw new Error("not against production");
const API_KEY = "AIzaSyAa2xUoMWrVjNGYEmrRfzBy8CKQRC8NhK8"; // turboflow-test's public web key
const BUCKET = `${PROJECT}.firebasestorage.app`;
const SA = `firebase-adminsdk-fbsvc@${PROJECT}.iam.gserviceaccount.com`;
const STEP = "C:/Users/shash/Downloads/car(17.3).step";
const admin = process.env.E2E_ADMIN_TOKEN.trim();
const AH = { Authorization: `Bearer ${admin}`, "Content-Type": "application/json", "X-Goog-User-Project": PROJECT };
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { log(`  ${ok ? "PASS" : "FAIL"}  ${what}`); if (!ok) failed++; };

// ── a refresh token for an existing Google account ──────────────────────────
const accounts = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`,
  { method: "POST", headers: AH, body: JSON.stringify({ limit: "50" }) }).then((r) => r.json());
const me = (accounts.userInfo ?? []).find((u) => !u.disabled
  && (u.providerUserInfo ?? []).some((p) => p.providerId === "google.com"));
const now = Math.floor(Date.now() / 1000);
const signed = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt`, {
  method: "POST", headers: AH,
  body: JSON.stringify({ payload: JSON.stringify({ iss: SA, sub: SA, uid: me.localId, iat: now, exp: now + 3600,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit" }) }),
}).then((r) => r.json());
const session = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
  { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: signed.signedJwt, returnSecureToken: true }) }).then((r) => r.json());
const REFRESH_TOKEN = session.refreshToken;

// ── from here on, the add-in's own requests ─────────────────────────────────
log(`\nold add-in replay against ${PROJECT}\n`);

// get_access_token()
const tok = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: REFRESH_TOKEN }),
}).then((r) => r.json());
const ACCESS_TOKEN = tok.id_token;
check(!!ACCESS_TOKEN, "refresh token exchanged for an ID token");
const USER_ID = JSON.parse(Buffer.from(ACCESS_TOKEN.split(".")[1], "base64url")).user_id;
const UH = { Authorization: `Bearer ${ACCESS_TOKEN}` };

// fs_get("users", USER_ID) and the credit check
const userDoc = await fetch(`${FS}/users/${USER_ID}`, { headers: UH }).then((r) => r.json());
const credits = Number(userDoc.fields?.credits?.integerValue ?? 0);
check(Number.isFinite(credits) && "credits" in (userDoc.fields ?? {}), `it reads the balance the way it always has (${credits})`);

// fb_upload x2
const job_id = randomUUID();
const upload = async (bytes, remote) => fetch(
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(remote)}`,
  { method: "POST", headers: { ...UH, "Content-Type": "application/octet-stream" }, body: bytes });
const step_remote = `jobs/${job_id}/geometry.step`;
const label_remote = `jobs/${job_id}/entity_labels.csv`;
const up1 = await upload(readFileSync(STEP), step_remote);
check(up1.ok, `STEP upload to ${step_remote.replace(job_id, "<id>")} accepted (${up1.status})`);
const csv = "step_entity_id,label,radius_m,cx_m,cy_m,cz_m\n";
const up2 = await upload(Buffer.from(csv), label_remote);
check(up2.ok, `label upload accepted (${up2.status})`);

// fs_write("jobs", job_id, {...}) - PATCH, the add-in's value encoding
const fv = (v) => typeof v === "string" ? { stringValue: v }
  : typeof v === "boolean" ? { booleanValue: v }
  : Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
const fields = {
  status: "pending", jobId: job_id, userId: USER_ID, stepPath: step_remote, labelPath: label_remote,
  bucket: BUCKET, createdAt: new Date().toISOString(), faceCount: 0, wheelCount: 0,
  inletVelocity: 20.0, iterationCount: 100, refineLevel: 0, debugMesh: true, surfaceRefinement: true,
  bbox_upstream_m: 0.5, bbox_downstream_m: 1.5, bbox_side_m: 0.5, bbox_top_m: 0.5,
  domain_inlet_x: -0.5, domain_outlet_x: 1.7, domain_ground_z: 0.0, domain_top_z: 0.57,
  domain_side_y: 0.53, domain_symmetry_y: 0.0,
};
const wrote = await fetch(`${FS}/jobs/${job_id}`, {
  method: "PATCH", headers: { ...UH, "Content-Type": "application/json" },
  body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fv(v)])) }),
});
check(wrote.ok, `the camelCase job document is accepted by the rules (${wrote.status})`);

// ── what the new backend does with it ───────────────────────────────────────
const job = async () => (await fetch(`${FS}/jobs/${job_id}`, { headers: AH }).then((r) => r.json())).fields ?? {};
const bal = async () => Number((await fetch(`${FS}/users/${USER_ID}`, { headers: AH }).then((r) => r.json()))
  .fields?.credits?.integerValue ?? NaN);
// The worker is a Cloud Run job: about two minutes to start cold (measured
// 24 Sep 2026: scheduled 07:26:25, first log line 07:28:19), so wait four.
let j = {};
for (let i = 0; i < 80; i++) {
  await sleep(3000);
  j = await job();
  if (!["pending", undefined].includes(j.status?.stringValue)) break;
}
const status = j.status?.stringValue;
check(status && status !== "pending", `the new backend picked it up (status now ${status})`);
check("user_id" in j && !("userId" in j), "and renamed its fields to the new spelling");
const cost = Number(j.cost?.integerValue ?? j.cost?.doubleValue ?? NaN);
const after = await bal();
check(Number.isFinite(cost) && after === credits - cost, `it charged ${cost} credits by the server's formula (balance ${credits} -> ${after})`);

// ── cancel, so no solve is paid for ─────────────────────────────────────────
const refund = await fetch(`https://us-central1-${PROJECT}.cloudfunctions.net/refundJob`, {
  method: "POST", headers: { ...UH, "Content-Type": "application/json" },
  body: JSON.stringify({ data: { job_id } }),
}).then((r) => r.json());
const back = await bal();
check(refund.result?.refunded === cost && back === credits,
  `cancelled and refunded ${refund.result?.refunded ?? JSON.stringify(refund.error)} (balance back to ${back})`);
log(`\njob ${job_id}\n${failed ? `${failed} failed` : "old add-in works against the new backend"}`);
process.exit(failed ? 1 : 0);
