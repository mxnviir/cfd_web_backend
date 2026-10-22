// A real car, from upload to a queued run, through the deployed stack.
//
// Nothing is stubbed and nothing takes a short cut past the product: the file
// is uploaded by the signed-in user to the one path the storage rules allow,
// and every step goes through the callable the Workbench calls. Admin
// credentials do two things a browser cannot - mint a sign-in token, and read
// documents back to report on them - and never write anything.
//
// The Admin SDK is deliberately not used. Its Firestore client authenticates
// over gRPC through google-auth-library, which will not accept an access token
// handed to it from gcloud impersonation, and there is no service-account key
// on this machine. The REST API takes the same token without complaint.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PROJECT = "turboflow-test";
const BUCKET = "turboflow-test.firebasestorage.app";
const API_KEY = "AIzaSyAa2xUoMWrVjNGYEmrRfzBy8CKQRC8NhK8";
const SA = `firebase-adminsdk-fbsvc@${PROJECT}.iam.gserviceaccount.com`;
const REGION = "us-central1";
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => Number(args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? d);
const CAR = args.find((a) => !a.startsWith("--")) || "C:/Users/shash/Downloads/car(17.3).step";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// E2E_ADMIN_TOKEN lets a caller hand the token in: CI, or a shell where
// Node's cmd.exe cannot run gcloud's .cmd launcher.
const admin = (process.env.E2E_ADMIN_TOKEN || execSync(
  `gcloud auth print-access-token --impersonate-service-account=${SA} --project ${PROJECT}`,
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
)).trim();

function decode(v) {
  if (v == null) return null;
  const [k] = Object.keys(v);
  if (k === "nullValue") return null;
  if (k === "integerValue") return Number(v.integerValue);
  if (k === "doubleValue") return v.doubleValue;
  if (k === "arrayValue") return (v.arrayValue.values ?? []).map(decode);
  if (k === "mapValue") return fields(v.mapValue.fields ?? {});
  return v[k];
}
const fields = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decode(v)]));

async function getDoc(path) {
  const r = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${admin}` } });
  if (r.status === 404) return null;
  const b = await r.json();
  if (b.error) throw new Error(`firestore ${path}: ${b.error.message}`);
  return fields(b.fields ?? {});
}

async function query(collection, field, value) {
  const r = await fetch(`${FS}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } },
        limit: 20,
      },
    }),
  });
  const b = await r.json();
  if (b.error) throw new Error(b.error.message);
  return (Array.isArray(b) ? b : [b]).filter((x) => x.document)
    .map((x) => ({ id: x.document.name.split("/").pop(), ...fields(x.document.fields ?? {}) }));
}

// ── sign in as a real user ──────────────────────────────────────────────────
const accounts = await fetch(
  `https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({ limit: "20" }),
  },
).then((r) => r.json());
// A disabled account cannot sign in, custom token or not. The hi@hi.com
// password account was disabled on 24 Sep 2026, when Google became the only
// sign-in, so it has to be skipped rather than picked because it has an email.
const live = (accounts.userInfo ?? []).filter((u) => !u.disabled);
// --uid=<id> runs as a named account, normally a test account made for the
// purpose, rather than as the first real person the query happens to return.
const wantUid = args.find((a) => a.startsWith("--uid="))?.split("=")[1];
const me = wantUid
  ? { localId: wantUid }
  : live.find((u) => u.email) ?? live[0];
if (!me) throw new Error("no enabled users: " + JSON.stringify(accounts).slice(0, 200));
log(`user: ${me.email || me.localId}`);

const now = Math.floor(Date.now() / 1000);
const signed = await fetch(
  `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:signJwt`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      payload: JSON.stringify({
        iss: SA, sub: SA, uid: me.localId, iat: now, exp: now + 3600,
        aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      }),
    }),
  },
).then((r) => r.json());
if (!signed.signedJwt) throw new Error("signJwt: " + JSON.stringify(signed).slice(0, 300));

const signIn = await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
  {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: signed.signedJwt, returnSecureToken: true }),
  },
).then((r) => r.json());
if (!signIn.idToken) throw new Error("sign-in: " + JSON.stringify(signIn).slice(0, 300));
const idToken = signIn.idToken;

async function call(name, data) {
  const r = await fetch(`https://${REGION}-${PROJECT}.cloudfunctions.net/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data }),
  });
  const body = await r.json().catch(() => ({}));
  if (body.error) throw new Error(`${name}: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}

// ── a project, and the car ──────────────────────────────────────────────────
// --group=<id> adds another simulation to a group that already exists, which
// is the case the whole model change is for: one group, many cars.
const reuse = args.find((a) => a.startsWith("--group="))?.split("=")[1];
const groupId = reuse || (await call("createGroup", {
  name: `Group ${new Date().toISOString().slice(11, 19)}`,
})).group_id;
log(`project: ${groupId}`);

const bytes = readFileSync(CAR);
log(`car: ${CAR.split(/[\\/]/).pop()}  ${(bytes.length / 1048576).toFixed(1)} MB`);

const intent = await call("createUploadIntent", {
  kind: "raw", ext: "step", name: "Test car", group_id: groupId,
  size_bytes: bytes.length, input_unit: "mm",
  import_options: { facet_split: false, sewing: true, improve: true },
});
log(`geometry: ${intent.geometry_id}`);

const up = await fetch(
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?uploadType=media&name=`
  + encodeURIComponent(intent.path),
  {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/octet-stream" },
    body: bytes,
  },
);
if (!up.ok) throw new Error(`upload refused ${up.status}: ${(await up.text()).slice(0, 200)}`);
log(`uploaded to ${intent.path}`);

async function waitFor(what, done, timeoutMs) {
  const started = Date.now();
  let last = "";
  for (;;) {
    const d = (await getDoc(`geometries/${intent.geometry_id}`)) ?? {};
    const s = `${d.status}/${d.domain_status ?? "-"}`;
    if (s !== last) { log(`  [${((Date.now() - started) / 1000).toFixed(0)}s] ${s}`); last = s; }
    const verdict = done(d);
    if (verdict) return { d, verdict };
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(5000);
  }
}

log("\nimporting the car");
const imported = await waitFor("import",
  (d) => (d.status === "ready" ? "ready" : d.status === "failed" ? "failed" : null), 420000);
if (imported.verdict === "failed") throw new Error("import failed: " + imported.d.error);

const mm3 = (a) => a.map((x) => (x * 1000).toFixed(1)).join(", ");
const v1 = imported.d.versions[String(imported.d.current_version)];
log(`  v${imported.d.current_version}: ${v1.face_count} faces, ${v1.solid_count} solids, `
  + `${Number(v1.triangle_count ?? 0).toLocaleString()} triangles, unit ${v1.unit}`);
log(`  bbox min (${mm3(v1.bbox.min)}) max (${mm3(v1.bbox.max)}) mm`);
log(`  wheels at import: ${(v1.wheels ?? []).length}`);
log(`  frontal area: full ${(v1.frontal_area_m2 * 1e4).toFixed(2)} cm2, `
  + `half ${((v1.frontal_area_half_m2 ?? 0) * 1e4).toFixed(2)} cm2`);
if (v1.rotated_deg) log(`  turned ${v1.rotated_deg} deg into the wind`);

// ── the tunnel and the setup ────────────────────────────────────────────────
const SPEED = opt("speed", 20);
const ITERATIONS = opt("iterations", 400);
const SYMMETRY = !flag("--full");
log(`\nbuilding the wind tunnel (${SYMMETRY ? "half" : "full"} width, `
  + `${SPEED} m/s, ${ITERATIONS} iterations)`);
await call("prepareDomain", {
  geometry_id: intent.geometry_id, group_id: groupId,
  symmetry: SYMMETRY, speed: SPEED, iterations: ITERATIONS, fineness: opt("fineness", 9.5),
});

const prepared = await waitFor("tunnel",
  (d) => (d.domain_status === "ready" ? "ready"
    : d.domain_status === "failed" ? "failed" : null), 600000);
if (prepared.verdict === "failed") throw new Error("prepare failed: " + prepared.d.domain_error);

const v2 = prepared.d.versions[String(prepared.d.current_version)];
log(`\n  v${prepared.d.current_version} (${v2.kind}), symmetry ${v2.symmetry}`);
if (v2.symmetry_plane_y != null) {
  log(`  symmetry plane at y = ${(v2.symmetry_plane_y * 1000).toFixed(1)} mm  (${v2.symmetry_kind})`);
  log(`  the car spans y = ${(v1.bbox.min[1] * 1000).toFixed(1)} to `
    + `${(v1.bbox.max[1] * 1000).toFixed(1)} mm`);
  // Against the B-rep bounding box, which is not where the car ends: OCC pads
  // a box round a B-spline, and on this car it claims 6.1 mm of y that no
  // triangle occupies. So this is a hint, not a verdict - the face counts
  // below are what say whether anything was really lost.
  const outside = v1.bbox.max[1] - v2.symmetry_plane_y;
  log(outside > 1e-6
    ? `  the bounding box reaches ${(outside * 1000).toFixed(1)} mm past the plane `
      + "(OCC pads B-splines; check the car face count)"
    : "  the bounding box ends at the plane");
}
log(`  ${v2.face_count} faces, ${Number(v2.triangle_count ?? 0).toLocaleString()} triangles`);
log(`  reference area ${(v2.frontal_area_m2 * 1e4).toFixed(2)} cm2, `
  + `length ${(v2.reference_length_m * 1000).toFixed(1)} mm`);
log("  walls: " + Object.entries(v2.label_counts ?? {}).map(([k, n]) => `${k} ${n}`).join(", "));
if ((v2.missing_labels ?? []).length) log(`  MISSING: ${v2.missing_labels.join(", ")}`);
log(`  wheels on the tunnel: ${(v2.wheels ?? []).length}`
  + ((v2.wheels ?? []).length
    ? " (" + v2.wheels.map((w) => `${(w.radius_m * 2000).toFixed(1)}mm`).join(", ") + ")" : ""));

// ── the setup ───────────────────────────────────────────────────────────────
// By geometry, not by group. A Firestore query with no ordering comes back in
// document-id order, so once a group held three cars sims[0] was whichever id
// happened to sort first - and reading that one's name is how a uniqueness
// rule that works got reported as broken.
// The worker marks the tunnel ready and then writes the simulation, about half
// a second apart, so the first look can land in between.
let sims = [];
for (let tries = 0; tries < 20 && !sims.length; tries++) {
  sims = await query("simulations", "geometry_id", intent.geometry_id);
  if (!sims.length) await sleep(1500);
}
if (!sims.length) throw new Error("no simulation was created");
const sim = sims[0];
const spec = sim.spec;
log(`\nsimulation ${sim.id} (${sim.setup_source}) named ${JSON.stringify(sim.name)}`);
for (const b of spec.boundaryConditions) {
  const how = b.velocity?.type || b.gaugePressure?.type || b.type;
  log(`    ${String(b.name).padEnd(15)} ${String(b.type).padEnd(21)} `
    + `${String(how).padEnd(23)} ${b.topologicalReference.faces.length} faces`);
}
for (const c of spec.resultControl.forcesMoments) {
  log(`  result: ${c.name} on ${c.topologicalReference.faces.length} faces`);
  if (c.referenceArea) {
    log(`    area ${(c.referenceArea.value * 1e4).toFixed(2)} cm2, `
      + `length ${(c.referenceLength.value * 1000).toFixed(1)} mm, `
      + `U ${c.freestreamVelocityMagnitude.value} m/s, `
      + `drag (${c.dragDirection.x}, ${c.dragDirection.y}, ${c.dragDirection.z})`);
  }
}
const iv = spec.boundaryConditions.find((b) => b.type === "VELOCITY_INLET_V3").velocity.value.value;
log(`  inlet (${iv.x.value}, ${iv.y.value}, ${iv.z.value}) m/s`);
log(`  iterations ${spec.simulationControl.endTime.value}, fineness ${sim.mesh_spec.sizing.fineness}`);
const val = sim.validation;
log(`  validation ok=${val?.ok}`
  + (val?.errors?.length ? `\n    errors: ${val.errors.join(" | ")}` : "")
  + (val?.warnings?.length ? `\n    warnings: ${val.warnings.join(" | ")}` : ""));
if (!val?.ok) { console.error("\nNot runnable. Stopping before spending credits."); process.exit(1); }

// ── queue ───────────────────────────────────────────────────────────────────
if (flag("--queue")) {
  const before = (await getDoc(`users/${me.localId}`))?.credits;
  const queued = await call("queueRun", { simulation_id: sim.id, name: "Auto setup run" });
  log(`\nqueued ${queued.run_id} for ${queued.price} credits (balance was ${before})`);
  if (flag("--watch")) {
    const started = Date.now();
    let last = "";
    for (;;) {
      const r = await getDoc(`runs/${queued.run_id}`);
      const s = `${r.status} ${r.stage_text ?? ""} ${Math.round((r.progress ?? 0) * 100)}%`;
      if (s !== last) { log(`  [${((Date.now() - started) / 60000).toFixed(1)}m] ${s}`); last = s; }
      if (["finished", "failed", "cancelled"].includes(r.status)) {
        if (r.mesh) log(`  mesh: ${Number(r.mesh.cell_count ?? 0).toLocaleString()} cells`);
        if (r.summary) log("  summary: " + JSON.stringify(r.summary));
        if (r.error) log("  error: " + r.error);
        break;
      }
      if (Date.now() - started > 3600000) { log("  still going"); break; }
      await sleep(20000);
    }
  }
} else {
  log("\nnot queued (pass --queue to spend credits)");
}
// Every car in the group, oldest first, which is what the group model is for
// and what has to stay readable as it fills up.
const inGroup = await query("simulations", "group_id", groupId);
inGroup.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
log(`\n${inGroup.length} simulation(s) in this group, oldest first:`);
for (const s of inGroup) log(`  ${s.id}  ${s.name}`);

log(`\nopen: https://turboflow-test.web.app/workbench/${groupId}`);
