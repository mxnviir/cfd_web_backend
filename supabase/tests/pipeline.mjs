// The run pipeline, end to end, against a deployed development project with
// the SimScale mock (supabase/functions/simscale-mock).
//
//   node supabase/tests/pipeline.mjs
//
// Real ops router, real Storage policies, real SUBMIT/POLL/RESULTS-STREAM.
// It makes three accounts (owner, collaborator, stranger), imports a car
// and builds a tunnel through the same ops the Workbench calls - the
// geometry the browser would compute is stood in by files made here - and
// then queues runs and watches them:
//
//   a run that finishes: charged once, summary and case in Storage
//   a run cancelled before the mesher: refunded in full
//   a run cancelled while meshing: stopped, charge kept
//   a run that fails while solving: charge kept
//
// POLL is driven here as two concurrent calls per round, on top of
// pg_cron's own ticks, and at the end every job must have exactly one
// simulation, one mesh and one solver run in the mock: overlapping ticks
// never processed a job twice. Everything it made is deleted at the end.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { dbUrl } from "./db.mjs";
import { projectEnv } from "./env.mjs";

const STEP_FILE = process.env.STEP_FILE ?? new URL("../../../cfd_web_backend/trial_car.step", import.meta.url);
const env = projectEnv();
const sql = postgres(dbUrl(), { max: 4, onnotice: () => {} });
const admin = createClient(env.url, env.service, { auth: { persistSession: false } });
const [{ decrypted_secret: internal }] =
  await sql`select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret'`;

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── accounts ───────────────────────────────────────────────────────────────
const tag = Math.random().toString(36).slice(2, 8);
const made = [];
async function account(label) {
  const email = `pipeline-${label}-${tag}@turboflow.test`;
  const password = crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  // Signed up with Google, as far as the router can tell.
  await admin.auth.admin.updateUserById(data.user.id, { app_metadata: { provider: "google", providers: ["google"] } });
  made.push(data.user.id);
  const client = createClient(env.url, env.anon, { auth: { persistSession: false } });
  const { data: s, error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  const token = s.session.access_token;
  const op = async (name, payload = {}) => {
    const resp = await fetch(`${env.url}/functions/v1/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ op: name, payload }),
    });
    const body = await resp.json();
    if (!resp.ok) throw Object.assign(new Error(body?.error?.message ?? resp.status), { code: body?.error?.code });
    return body.data;
  };
  return { id: data.user.id, email, client, op };
}

const poll = () => fetch(`${env.url}/functions/v1/poll`, {
  method: "POST", headers: { "x-internal-secret": internal, "Content-Type": "application/json" }, body: "{}",
}).then((r) => r.json());

/** Drive POLL - two at once each round - until the run reaches one of `want`. */
async function until(runId, want, timeoutS = 420) {
  const start = Date.now();
  while (Date.now() - start < timeoutS * 1000) {
    const [run] = await sql`select status, stage_text from public.runs where id = ${runId}`;
    if (want.includes(run?.status)) return run.status;
    const [a, b] = await Promise.all([poll(), poll()]);
    const ids = (x) => (x.claimed ?? []).map((c) => c.id);
    const overlap = ids(a).filter((id) => ids(b).includes(id));
    if (overlap.length) check("two concurrent POLL ticks never claim the same job", false, overlap.join(","));
    await sleep(4000);
  }
  const [run] = await sql`select status, stage_text from public.runs where id = ${runId}`;
  return `timeout at ${run?.status} (${run?.stage_text})`;
}

const ledger = async (jobId) =>
  Number((await sql`select coalesce(sum(amount), 0)::int as s from public.transactions where job_id = ${jobId}`)[0].s);
const credits = async (uid) => Number((await sql`select credits from public.users where id = ${uid}`)[0].credits);

try {
  console.log("accounts");
  const owner = await account("owner");
  const collab = await account("collab");
  const stranger = await account("stranger");
  check("ensureAccount creates the account", (await owner.op("ensureAccount")).created === true);
  check("ensureAccount a second time changes nothing", (await owner.op("ensureAccount")).created === false);
  await collab.op("ensureAccount");
  await stranger.op("ensureAccount");
  check("a new account starts with 50 credits", (await credits(owner.id)) === 50);
  await sql`update public.users set credits = 5000 where id = ${owner.id}`;

  console.log("group");
  const { group_id: groupId } = await owner.op("createGroup", { name: "Pipeline test", description: null, tags: null });
  check("createGroup", !!groupId);
  await owner.op("shareGroup", { group_id: groupId, email: collab.email, permission: "view" });
  const { data: seen } = await collab.client.from("groups").select("id").eq("id", groupId);
  check("a collaborator reads a shared group through the API", seen?.length === 1);
  const { data: notSeen } = await stranger.client.from("groups").select("id").eq("id", groupId);
  check("a stranger does not", notSeen?.length === 0);

  console.log("geometry (the browser's half stood in by files made here)");
  const step = readFileSync(STEP_FILE);
  const stepIds = [...step.toString("latin1").matchAll(/#(\d+)\s*=\s*ADVANCED_FACE/g)].map((m) => Number(m[1]));
  const raw = await owner.op("createUploadIntent", {
    group_id: groupId, name: "Trial car", size_bytes: step.length, kind: "raw", ext: "step", input_unit: "mm",
  });
  const up = async (path, body, type) => {
    const res = await owner.client.storage.from("turboflow").upload(path, body, { contentType: type });
    if (res.error && !path.endsWith("raw.step")) throw new Error(`upload ${path}: ${res.error.message}`);
    return res;
  };
  check("the owner uploads to the reserved raw path", !(await up(raw.path, step, "application/octet-stream")).error);
  check("...and not again (write-once)", !!(await up(raw.path, step, "application/octet-stream")).error);
  check("a stranger cannot upload into the owner's folder",
    !!(await stranger.client.storage.from("turboflow").upload(raw.path.replace("raw.step", "geometry.step"), step)).error);

  const glb = Buffer.concat([Buffer.from("glTF"), Buffer.alloc(16)]);
  const faces = { faces: stepIds.map((id, index) => ({ index, step_id: id, area_m2: 1e-4 })), adjacency: [] };
  const solids = { solids: [{ index: 0, faces: stepIds.map((_, i) => i) }] };
  const car = await owner.op("createCarIntent", { geometry_id: raw.geometry_id, group_id: groupId, reserve_bytes: step.length * 3 });
  await up(car.paths.step, step, "application/octet-stream");
  await up(car.paths.glb, glb, "model/gltf-binary");
  await up(car.paths.faces, JSON.stringify(faces), "application/json");
  await up(car.paths.solids, JSON.stringify(solids), "application/json");
  const { error: consumeErr } = await owner.client.from("artifact_intents").update({ state: "consumed" }).eq("token", car.token);
  check("the page marks its upload consumed", !consumeErr);
  const bbox = { min: [-0.1, -0.03, 0], max: [0.1, 0.03, 0.05], size: [0.2, 0.06, 0.05] };
  const domain = { outlet_x: -0.6, inlet_x: 1.6, ground_z: 0, top_z: 0.35, side_y: 0.33, symmetry_y: 0, symmetry: true };
  const carIngest = await owner.op("ingestCar", {
    geometry_id: raw.geometry_id, artifacts: car.paths,
    meta: { bbox, domain, unit: "mm", scale_to_m: 0.001, wheels: [], frontal_area_m2: 0.003, frontal_area_half_m2: 0.0015,
      rotated_deg: 0, face_count: stepIds.length, solid_count: 1, triangle_count: 1000 },
  });
  check("ingestCar files version 1", carIngest.version === 1);

  const tunnel = await owner.op("createArtifactIntent", { geometry_id: raw.geometry_id, group_id: groupId, reserve_bytes: step.length * 3, iterations: 1000 });
  for (const [k, body, type] of [["step", step, "application/octet-stream"], ["labels", "label,face\n", "text/csv"],
    ["glb", glb, "model/gltf-binary"], ["faces", JSON.stringify(faces), "application/json"], ["solids", JSON.stringify(solids), "application/json"]]) {
    await up(tunnel.paths[k], body, type);
  }
  const labels = { inlet: [0], outlet: [1], ground: [2], top: [3], side: [4], symmetry: [5],
    car_no_slip: stepIds.slice(6, 60).map((_, i) => i + 6) };
  const built = await owner.op("ingestPreparedDomain", {
    geometry_id: raw.geometry_id, group_id: groupId, artifacts: tunnel.paths, iterations: 1000,
    meta: { bbox, domain, unit: "mm", labels, label_counts: {}, missing_labels: [], wheels: [], car_wheels: [],
      unresolvable_faces: [], face_count: stepIds.length, triangle_count: 1000, rotated_deg: 0,
      frontal_area_m2: 0.0015, reference_length_m: 0.2 },
  });
  const [sim] = await sql`select validation from public.simulations where id = ${built.simulation_id}`;
  check("the tunnel build writes a simulation the server validated", sim?.validation?.ok === true,
    JSON.stringify(sim?.validation?.errors));
  const simId = built.simulation_id;

  console.log("a run that finishes");
  const before = await credits(owner.id);
  const q1 = await owner.op("queueRun", { simulation_id: simId });
  check("queueRun quotes the server's price (level 3, 1000 iterations = 150)", q1.price === 150, JSON.stringify(q1));
  check("...and takes it once", (await credits(owner.id)) === before - 150);
  try {
    await collab.op("queueRun", { simulation_id: simId });
    check("a view-only collaborator cannot queue a run", false);
  } catch (err) {
    check("a view-only collaborator cannot queue a run", err.code === "permission-denied", err.message);
  }
  const end1 = await until(q1.run_id, ["finished", "failed"]);
  check("the run finishes", end1 === "finished", end1);
  const [r1] = await sql`select summary, case_path, results_glb_path, log_paths, mesh from public.runs where id = ${q1.run_id}`;
  check("its drag is the whole car's (half model doubled)", Math.abs((r1.summary?.drag ?? 0) - 0.5) < 0.02, JSON.stringify(r1.summary));
  check("the case is in Storage, unconverted until the owner opens it",
    !!r1.case_path && !r1.results_glb_path && !!(await sql`select 1 from storage.objects where name = ${r1.case_path}`).length);
  check("the mesh and run logs are kept beside it", !!r1.log_paths?.mesh && !!r1.log_paths?.run);
  check("the charge stands, once", (await ledger(q1.job_id)) === -150);
  const [n1] = await sql`select notifications from public.users where id = ${owner.id}`;
  check("the owner is told it finished", n1.notifications?.[0]?.type === "finished");

  console.log("a run cancelled before the mesher");
  const before2 = await credits(owner.id);
  const q2 = await owner.op("queueRun", { simulation_id: simId });
  const c2 = await owner.op("cancelRun", { run_id: q2.run_id });
  check("cancelling before the mesher refunds in full", c2.refunded === 150, JSON.stringify(c2));
  const end2 = await until(q2.run_id, ["cancelled"]);
  check("...and the run ends cancelled", end2 === "cancelled", end2);
  check("...with the balance back where it was", (await credits(owner.id)) === before2);

  console.log("a run cancelled while meshing");
  const q3 = await owner.op("queueRun", { simulation_id: simId });
  const at3 = await until(q3.run_id, ["meshing"]);
  check("the run reaches meshing", at3 === "meshing", at3);
  try {
    await stranger.op("cancelRun", { run_id: q3.run_id });
    check("a stranger cannot cancel it", false);
  } catch (err) {
    check("a stranger cannot cancel it", err.code === "permission-denied", err.message);
  }
  const c3 = await owner.op("cancelRun", { run_id: q3.run_id });
  check("cancelling while meshing refunds nothing", c3.refunded === 0, JSON.stringify(c3));
  const end3 = await until(q3.run_id, ["cancelled"]);
  check("...and POLL winds it down to cancelled", end3 === "cancelled", end3);
  const [mesh3] = await sql`select cancelled from dev_mock.objects where kind = 'mesh' and data ->> 'name' = ${`tf-mesh-${q3.job_id}`}`;
  check("...having cancelled the mesh in SimScale", mesh3?.cancelled === true);
  check("...and the charge stands", (await ledger(q3.job_id)) === -150);

  console.log("a run that fails while solving");
  const q4 = await owner.op("queueRun", { simulation_id: simId, name: "Run [fail-run]" });
  const end4 = await until(q4.run_id, ["failed", "finished"]);
  check("the run fails", end4 === "failed", end4);
  check("...after the solver started, so the charge stands", (await ledger(q4.job_id)) === -150);

  console.log("refundJob");
  try {
    await owner.op("refundJob", { job_id: q1.job_id });
    check("a finished job cannot be refunded", false);
  } catch (err) {
    check("a finished job cannot be refunded", err.code === "failed-precondition", err.message);
  }

  console.log("no job was processed twice");
  for (const q of [q1, q2, q3, q4]) {
    const counts = await sql`
      select kind, count(*)::int as n from dev_mock.objects
       where data ->> 'name' in (${`tf-${q.job_id}`}, ${`tf-mesh-${q.job_id}`}) or (kind = 'run' and id in (
         select simscale ->> 'run_id' from public.jobs where id = ${q.job_id}))
       group by kind`;
    const by = Object.fromEntries(counts.map((c) => [c.kind, c.n]));
    check(`job ${q.job_id}: at most one simulation, mesh and solver run in SimScale`,
      (by.simulation ?? 0) <= 1 && (by.mesh ?? 0) <= 1 && (by.run ?? 0) <= 1, JSON.stringify(by));
    const charges = await sql`select count(*)::int as n from public.transactions where job_id = ${q.job_id} and type = 'simulation_charge'`;
    check(`job ${q.job_id}: one charge row`, charges[0].n === 1);
  }

  console.log("pg_cron");
  const ticks = await sql`
    select count(*)::int as n from cron.job_run_details d join cron.job j on j.jobid = d.jobid
     where j.jobname = 'turboflow-poll' and d.status = 'succeeded' and d.start_time > now() - interval '30 minutes'`;
  check("pg_cron's POLL tick has been firing", ticks[0].n > 0, `${ticks[0].n} ticks`);
} catch (err) {
  failures.push(`crashed: ${err.message}`);
  console.error(err);
} finally {
  for (const id of made) {
    const [u] = await sql`select storage_uid from public.users where id = ${id}`;
    if (u) {
      const names = (await sql`select name from storage.objects where bucket_id = 'turboflow' and name like ${`users/${u.storage_uid}/%`}`).map((r) => r.name);
      for (let i = 0; i < names.length; i += 100) await admin.storage.from("turboflow").remove(names.slice(i, i + 100));
    }
    await sql`delete from public.jobs where user_id = ${id}`;
    await admin.auth.admin.deleteUser(id);
  }
  await sql.end();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
