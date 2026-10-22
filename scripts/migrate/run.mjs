// Firebase -> Supabase: accounts, every collection, and every stored file.
//
//   node scripts/migrate/run.mjs              a dry run: reads everything,
//                                             transforms it, writes nothing
//   node scripts/migrate/run.mjs --execute    writes
//   ... --skip-storage / --only-storage       one half or the other
//
// Delivered for cutover, and run then by the owner; see docs/CUTOVER.md for
// the order of operations around it. It has never been run against
// production.
//
// Reads Firebase through Google's REST APIs with an access token - no
// Firebase SDK - from a service account that can read Auth, Firestore and
// the bucket:
//   FIREBASE_TOKEN=$(gcloud auth print-access-token --impersonate-service-account=<sa>)
//   FIREBASE_PROJECT=<project id>  FIREBASE_BUCKET=<bucket name>
// Writes Supabase with:
//   SUPABASE_DB_URL  SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY
//
// Safe to run again. Accounts are matched on legacy_uid, rows are inserted
// with ON CONFLICT DO NOTHING, and a file already in Storage with the same
// MD5 is skipped. Every file copied is checked: the MD5 of the bytes read
// from Google must equal Google's own, and the ETag Storage reports for what
// it stored must equal both.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import * as t from "./transform.mjs";

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has("--execute");
const need = (n) => process.env[n] || (() => { throw new Error(`${n} is not set`); })();
const PROJECT = need("FIREBASE_PROJECT");
const TOKEN = need("FIREBASE_TOKEN");
const BUCKET = need("FIREBASE_BUCKET");
const SUPABASE_URL = need("SUPABASE_URL");
const SERVICE_KEY = need("SUPABASE_SERVICE_ROLE_KEY");
const sql = postgres(need("SUPABASE_DB_URL"), { max: 4, onnotice: () => {} });

const report = { mode: EXECUTE ? "execute" : "dry-run", started: new Date().toISOString(), tables: {}, storage: {}, problems: [] };
const problem = (what) => { report.problems.push(what); console.warn(`  ! ${what}`); };
const google = (url, init = {}) => fetch(url, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
const supa = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// ── reading Firebase ───────────────────────────────────────────────────────
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

/** Every document of a collection id (or of every subcollection with that id), by name order. */
async function collection(id, allDescendants = false) {
  const out = [];
  let after = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: id, allDescendants }],
      orderBy: [{ field: { fieldPath: "__name__" } }],
      limit: 500,
      ...(after ? { startAt: { values: [{ referenceValue: after }], before: false } } : {}),
    };
    const resp = await google(`${DOCS}:runQuery`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery }),
    });
    if (!resp.ok) throw new Error(`Firestore ${id}: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    const docs = (await resp.json()).filter((r) => r.document).map((r) => r.document);
    // Top-level only, unless asked for the subcollections.
    const keep = docs.filter((d) => allDescendants || t.fromRest(d).path.split("/").length === 2);
    out.push(...keep.map(t.fromRest));
    if (docs.length < 500) break;
    after = docs[docs.length - 1].name;
  }
  return out;
}

async function firebaseAccounts() {
  const out = [];
  let page = "";
  for (;;) {
    const resp = await google(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:batchGet?maxResults=1000${page ? `&nextPageToken=${page}` : ""}`);
    if (!resp.ok) throw new Error(`Auth: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
    const body = await resp.json();
    out.push(...(body.users ?? []));
    if (!body.nextPageToken) break;
    page = body.nextPageToken;
  }
  return out;
}

// ── writing Supabase ───────────────────────────────────────────────────────
/** Arrays and objects go in as jsonb, not as Postgres arrays. */
const asParams = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) =>
  [k, v !== null && typeof v === "object" ? sql.json(v) : v]));

async function insert(table, rows, conflict = "do nothing") {
  report.tables[table] = { read: rows.length, written: 0 };
  if (!EXECUTE) return;
  for (const row of rows) {
    const done = await sql`insert into ${sql("public." + table)} ${sql(asParams(row))} on conflict ${sql.unsafe(conflict)} returning 1`
      .catch((err) => { problem(`${table} ${row.id ?? ""}: ${err.message}`); return []; });
    report.tables[table].written += done.length;
  }
}

/**
 * Each Firebase account as a Supabase one, keeping its email. A Google user
 * signing in for the first time on Supabase is linked to this account by
 * their verified email, so their data is waiting for them.
 */
async function accounts(users) {
  const map = new Map();
  for (const u of await sql`select id, legacy_uid from public.users where legacy_uid is not null`) map.set(u.legacy_uid, u.id);
  const fb = await firebaseAccounts();
  report.tables.auth_users = { read: fb.length, created: 0, matched: map.size };
  const byUid = new Map(users.map((u) => [u.id, u]));
  for (const a of fb) {
    if (map.has(a.localId)) continue;
    if (!byUid.has(a.localId)) continue;  // no account document: never finished signing up
    if (!EXECUTE) { map.set(a.localId, `dry-run-${a.localId}`); continue; }
    const resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: "POST", headers: { ...supa, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: a.email, email_confirm: true,
        user_metadata: { full_name: a.displayName ?? null, avatar_url: a.photoUrl ?? null, firebase_uid: a.localId },
        app_metadata: { provider: "google", providers: ["google"] },
      }),
    });
    const body = await resp.json();
    if (!resp.ok) { problem(`account ${a.localId} (${a.email}): ${body.msg ?? body.message ?? resp.status}`); continue; }
    map.set(a.localId, body.id);
    report.tables.auth_users.created += 1;
  }
  return map;
}

// ── storage ────────────────────────────────────────────────────────────────
async function copyStorage() {
  const stats = report.storage = { listed: 0, copied: 0, skipped_same: 0, failed: 0, bytes: 0 };
  let page = "";
  for (;;) {
    const resp = await google(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?maxResults=1000${page ? `&pageToken=${page}` : ""}`);
    if (!resp.ok) throw new Error(`bucket list: ${resp.status}`);
    const body = await resp.json();
    for (const o of (body.items ?? []).filter((x) => t.shouldCopy(x.name))) {
      stats.listed += 1;
      const want = o.md5Hash ? t.md5Hex(o.md5Hash) : null;
      const [have] = await sql`select metadata->>'eTag' as etag from storage.objects where bucket_id = 'turboflow' and name = ${o.name}`;
      if (have && want && have.etag?.replaceAll('"', "") === want) { stats.skipped_same += 1; continue; }
      if (!EXECUTE) continue;
      try {
        await copyOne(o, want);
        stats.copied += 1;
        stats.bytes += Number(o.size);
      } catch (err) {
        stats.failed += 1;
        problem(`file ${o.name}: ${err.message}`);
      }
    }
    if (!body.nextPageToken) break;
    page = body.nextPageToken;
  }
}

/** One object, streamed from Google to Storage, hashed on the way through. */
async function copyOne(o, wantMd5) {
  const src = await google(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(o.name)}?alt=media`);
  if (!src.ok || !src.body) throw new Error(`download ${src.status}`);
  const hash = createHash("md5");
  const counted = src.body.pipeThrough(new TransformStream({ transform(chunk, ctl) { hash.update(chunk); ctl.enqueue(chunk); } }));
  const put = await fetch(`${SUPABASE_URL}/storage/v1/object/turboflow/${o.name.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST",
    headers: { ...supa, "Content-Type": o.contentType || "application/octet-stream", "x-upsert": "true" },
    body: counted,
    duplex: "half",
  });
  if (!put.ok) throw new Error(`upload ${put.status} ${(await put.text()).slice(0, 200)}`);
  const got = hash.digest("hex");
  if (wantMd5 && got !== wantMd5) throw new Error(`read ${got}, Google says ${wantMd5}`);
  const [stored] = await sql`select metadata->>'eTag' as etag, (metadata->>'size')::bigint as size
                               from storage.objects where bucket_id = 'turboflow' and name = ${o.name}`;
  if (Number(stored?.size) !== Number(o.size)) throw new Error(`stored ${stored?.size} bytes of ${o.size}`);
  const etag = stored?.etag?.replaceAll('"', "");
  // A multipart upload's ETag is not an MD5 (it has a -<parts> suffix); size and the read hash stand.
  if (etag && !etag.includes("-") && etag !== got) throw new Error(`Storage's ETag ${etag} is not ${got}`);
}

// ── the run ────────────────────────────────────────────────────────────────
console.log(`${report.mode}: ${PROJECT} -> ${SUPABASE_URL}`);
try {
  if (!args.has("--only-storage")) {
    console.log("reading Firestore");
    const [users, groups, geometries, simulations, runs, jobs, txns, selections, intents, postStates,
      listings, hashes, config, orders] = await Promise.all([
      collection("users"), collection("groups"), collection("geometries"), collection("simulations"),
      collection("runs"), collection("jobs"), collection("transactions", true), collection("selections", true),
      collection("artifact_intents", true), collection("post_states", true), collection("fusion_tokens", true),
      collection("fusion_tokens"), collection("config"), collection("paypal_orders"),
    ]);

    console.log("accounts");
    const map = await accounts(users);
    const known = users.filter((u) => map.has(u.id));
    for (const u of users) if (!map.has(u.id)) problem(`users/${u.id}: no Auth account, not migrated`);
    await insert("users", known.map((u) => t.userRow(u, map.get(u.id))));

    const safe = (rows, fn) => rows.flatMap((d) => {
      try { return [fn(d)]; } catch (err) { problem(`${d.path}: ${err.message}`); return []; }
    });
    const groupRows = safe(groups, (d) => t.groupRow(d, map));
    await insert("groups", groupRows);
    const groupIds = new Set(groupRows.map((g) => g.id));

    const geo = safe(geometries, (d) => t.geometryRows(d, map, groupIds));
    await insert("geometries", geo.map((g) => g.geometry));
    await insert("geometry_versions", geo.flatMap((g) => g.versions), "(geometry_id, version) do nothing");
    const geometryIds = new Set(geo.map((g) => g.geometry.id));

    await insert("selections", safe(selections.filter((d) => geometryIds.has(d.parentId)), (d) => ({
      id: d.id, geometry_id: d.parentId,
      user_id: geo.find((g) => g.geometry.id === d.parentId).geometry.user_id,
      name: d.data.name ?? null, entity_type: d.data.entity_type ?? "face", step_ids: d.data.step_ids ?? [],
    })));
    await insert("artifact_intents", safe(intents.filter((d) => geometryIds.has(d.parentId)), (d) => ({
      token: d.id, geometry_id: d.parentId, user_id: map.get(d.data.user_id),
      group_id: d.data.group_id ?? null, kind: d.data.kind === "car" ? "car" : "tunnel",
      version: Number(d.data.version ?? 0), reserve_bytes: Number(d.data.reserve_bytes ?? 0),
      paths: d.data.paths ?? {}, state: ["open", "consumed", "failed", "cancelled", "ingested"].includes(d.data.state) ? d.data.state : "failed",
      error: d.data.error ?? null,
    })));

    await insert("simulations", safe(simulations, (d) => t.simulationRow(d, map, groupIds, geometryIds)));
    const runRows = safe(runs, (d) => t.runRow(d, map, groupIds));
    await insert("runs", runRows);
    const runIds = new Set(runRows.map((r) => r.id));
    await insert("post_states", safe(postStates.filter((d) => runIds.has(d.parentId)), (d) => ({
      id: d.id, run_id: d.parentId, user_id: runRows.find((r) => r.id === d.parentId).user_id, state: d.data,
    })));

    const jobRows = safe(jobs, (d) => t.jobRow(d, map));
    for (const j of jobRows) {
      if (!t.TERMINAL.includes(j.status)) problem(`jobs/${j.id} is ${j.status}: it will not resume after cutover`);
    }
    await insert("jobs", jobRows);

    const txRows = safe(txns.filter((d) => d.path.startsWith("users/")), (d) => t.transactionRow(d, map));
    for (const r of txRows.filter((r) => !t.TRANSACTION_TYPES.includes(r.type))) {
      problem(`ledger row ${r.id} has type ${r.type}: not imported`);
    }
    await insert("transactions", txRows.filter((r) => t.TRANSACTION_TYPES.includes(r.type)), "(user_id, id) do nothing");

    // A connection token keeps working: the hash is the same SHA-256 of the same token.
    await insert("fusion_tokens", safe(hashes, (d) => ({
      hash: d.id, user_id: t.uidMapper(map)(d.data.user_id), token_id: d.data.token_id,
      last_used_at: d.data.last_used_at ?? null,
    })), "(hash) do nothing");
    await insert("fusion_token_listing", safe(listings.filter((d) => d.path.startsWith("users/")), (d) => ({
      id: d.id, user_id: t.uidMapper(map)(d.parentId), label: d.data.label ?? null, tail: d.data.tail ?? null,
      last_used_at: d.data.last_used_at ?? null,
    })));
    await insert("config", config.map((d) => ({ id: d.id, data: d.data })), "(id) do nothing");
    // Orders still open at cutover, so a capture or webhook can still settle them.
    await insert("paypal_orders", safe(orders, (d) => ({
      id: d.id, user_id: t.uidMapper(map)(d.data.uid), kind: d.data.kind, credits: d.data.credits ?? null,
      days: d.data.days ?? null, months: d.data.months ?? null, amount_usd: Number(d.data.amount_usd),
      currency: d.data.currency ?? "USD", expire_at: d.data.expire_at ?? null,
    })));

    // Every balance must match the Firestore one it came from.
    if (EXECUTE) {
      for (const u of known) {
        const [row] = await sql`select credits from public.users where legacy_uid = ${u.id}`;
        if (Number(row?.credits) !== Math.round(Number(u.data.credits ?? 0))) {
          problem(`users/${u.id}: balance ${row?.credits} in Postgres, ${u.data.credits} in Firestore`);
        }
      }
    }
  }
  if (!args.has("--skip-storage")) {
    console.log("storage");
    await copyStorage();
  }
} catch (err) {
  problem(`stopped: ${err.message}`);
} finally {
  report.finished = new Date().toISOString();
  const file = `migration-report-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ tables: report.tables, storage: report.storage, problems: report.problems.length }, null, 2));
  console.log(`report: ${file}`);
  await sql.end();
  process.exit(report.problems.some((p) => p.startsWith("stopped")) ? 1 : 0);
}
