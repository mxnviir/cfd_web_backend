// Firestore documents into Postgres rows: the pure half of the migration.
//
// No network, no database: every function here takes what Firestore's REST
// API returns and gives back rows for the tables in supabase/migrations.
// tests/test_migrate.mjs runs them on documents shaped like production's.

// ── Firestore REST values ──────────────────────────────────────────────────
/** A Firestore REST `Value` as plain data; timestamps become ISO strings. */
export function decode(v) {
  if (v == null) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return new Date(v.timestampValue).toISOString();
  if ("stringValue" in v) return v.stringValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decode);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}

export const decodeFields = (fields) =>
  Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, decode(v)]));

/** A REST document as {path, id, parentId, data}. */
export function fromRest(doc) {
  const path = doc.name.replace(/^projects\/[^/]+\/databases\/[^/]+\/documents\//, "");
  const parts = path.split("/");
  return {
    path,
    id: parts[parts.length - 1],
    parentId: parts.length >= 4 ? parts[parts.length - 3] : null,
    data: decodeFields(doc.fields),
    created: doc.createTime ?? null,
  };
}

// ── names ──────────────────────────────────────────────────────────────────
const EXPLICIT = { jobId: "job_id", userId: "user_id", paraviewUrl: "paraview_url", drag_N: "drag_n", lift_N: "lift_n" };
export const toSnake = (k) => EXPLICIT[k]
  ?? k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();

/**
 * Top-level keys in snake_case, the snake spelling winning where a document
 * carries both (functions/src/lib/normalize.ts). Blobs keep their inside.
 */
export function snakeTop(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) if (toSnake(k) === k) out[k] = v;
  for (const [k, v] of Object.entries(data)) if (toSnake(k) !== k && !(toSnake(k) in out)) out[toSnake(k)] = v;
  return out;
}

/** The listed columns that have a value. Absent ones take the table's default. */
export const pick = (row, cols) =>
  Object.fromEntries(cols.filter((c) => row[c] != null).map((c) => [c, row[c]]));

/** Split a document into the table's columns and everything else (`extra`). */
export function columns(data, cols) {
  const row = {};
  const extra = {};
  for (const [k, v] of Object.entries(data)) {
    if (cols.includes(k)) row[k] = v;
    else extra[k] = v;
  }
  return { row, extra: Object.keys(extra).length ? extra : null };
}

// ── statuses ───────────────────────────────────────────────────────────────
export const JOB_STATUS = [
  "draft", "pending", "downloading", "uploading_geometry", "processing", "creating_simulation",
  "checking", "meshing", "running", "downloading_results", "complete", "failed", "cancelling", "cancelled",
];
export const TERMINAL = ["draft", "complete", "failed", "cancelled"];

/** A job status the enum accepts. Anything older is kept in extra and read as failed. */
export function jobStatus(s) {
  return JOB_STATUS.includes(s) ? s : "failed";
}

// ── per-table ──────────────────────────────────────────────────────────────
/** A function from Firebase uid to Supabase user id; throws on an unknown uid. */
export function uidMapper(map) {
  return (uid) => {
    if (uid == null || uid === "") return null;
    const id = map.get(uid);
    if (!id) throw new Error(`no account for Firebase uid ${uid}`);
    return id;
  };
}

/** Keys of a {uid: value} map, re-keyed by Supabase id; unknown uids dropped. */
export function remapKeys(obj, map) {
  const out = {};
  for (const [uid, v] of Object.entries(obj ?? {})) if (map.has(uid)) out[map.get(uid)] = v;
  return out;
}

const USER_COLS = ["email", "name", "team_name", "region", "contact_email", "lap_calc_defaults", "job_race_times",
  "workbench_defaults", "notifications", "credits", "sponsored", "sponsor_rate", "usd_per_credit", "unlimited_usd",
  "unlimited_until", "unlimited_started_at", "email_verified", "storage_bytes", "storage_quota_bytes",
  "storage_over_quota", "created_at", "last_seen"];

export function userRow(doc, newId) {
  const { row, extra } = columns(snakeTop(doc.data), USER_COLS);
  return {
    ...row,
    id: newId,
    storage_uid: doc.id,
    legacy_uid: doc.id,
    credits: Math.round(Number(row.credits ?? 0)),
    notifications: row.notifications ?? [],
    extra,
  };
}

const GROUP_COLS = ["name", "description", "category", "tags", "unit_system", "thumbnail_path", "counts", "lock",
  "created_at", "updated_at"];

export function groupRow(doc, map) {
  const { row, extra } = columns(snakeTop(doc.data), [...GROUP_COLS, "user_id", "shared_with", "shared_emails"]);
  return {
    ...pick(row, GROUP_COLS),
    tags: row.tags ?? [],
    counts: row.counts ?? {},
    id: doc.id,
    user_id: uidMapper(map)(row.user_id),
    shared_with: remapKeys(row.shared_with, map),
    shared_emails: remapKeys(row.shared_emails, map),
    extra,
  };
}

const GEOMETRY_COLS = ["name", "description", "format", "input_unit", "import_options", "raw_path", "step_path",
  "label_path", "glb_path", "source_step_path", "prepared_by", "size_bytes", "status", "error", "current_version",
  "domain_status", "domain_error", "domain_options", "bbox", "face_count", "solid_count", "triangle_count",
  "wheel_count", "created_at", "updated_at"];

/** A geometry row, and one geometry_versions row per entry of its versions map. */
export function geometryRows(doc, map, groupIds) {
  const { row, extra } = columns(snakeTop(doc.data), [...GEOMETRY_COLS, "user_id", "group_id", "versions"]);
  const userId = uidMapper(map)(row.user_id);
  const geometry = {
    ...pick(row, GEOMETRY_COLS),
    prepared_by: ["workbench", "fusion"].includes(row.prepared_by) ? row.prepared_by : "workbench",
    current_version: Number(row.current_version ?? 0),
    id: doc.id,
    user_id: userId,
    group_id: groupIds.has(row.group_id) ? row.group_id : null,
    extra,
  };
  const versions = Object.entries(row.versions ?? {})
    .filter(([n]) => Number.isInteger(Number(n)))
    .map(([n, data]) => ({ geometry_id: doc.id, version: Number(n), user_id: userId, data }));
  return { geometry, versions };
}

const SIM_COLS = ["name", "geometry_version", "analysis", "spec", "mesh_spec", "setup", "primitives", "validation",
  "setup_source", "created_at", "updated_at"];

export function simulationRow(doc, map, groupIds, geometryIds) {
  const { row, extra } = columns(snakeTop(doc.data), [...SIM_COLS, "user_id", "group_id", "geometry_id"]);
  return {
    ...pick(row, SIM_COLS),
    primitives: row.primitives ?? [],
    id: doc.id,
    user_id: uidMapper(map)(row.user_id),
    group_id: groupIds.has(row.group_id) ? row.group_id : null,
    geometry_id: geometryIds.has(row.geometry_id) ? row.geometry_id : null,
    extra,
  };
}

const RUN_COLS = ["simulation_id", "simulation_name", "geometry_id", "geometry_version", "job_id", "name", "kind",
  "status", "stage_text", "progress", "credits", "refunded", "spec_snapshot", "mesh_snapshot", "clamped", "simscale",
  "mesh", "log_paths", "plots", "summary", "results_glb_path", "results_fields", "case_path", "error", "started_at",
  "finished_at", "created_at", "updated_at"];

export function runRow(doc, map, groupIds) {
  const { row, extra } = columns(snakeTop(doc.data), [...RUN_COLS, "user_id", "group_id", "queued_by"]);
  return {
    ...pick(row, RUN_COLS),
    kind: row.kind ?? "run",
    status: row.status ?? "failed",
    progress: Number(row.progress ?? 0),
    simscale: row.simscale ?? {},
    log_paths: row.log_paths ?? {},
    id: doc.id,
    user_id: uidMapper(map)(row.user_id),
    group_id: groupIds.has(row.group_id) ? row.group_id : null,
    queued_by: map.get(row.queued_by) ?? null,
    extra,
  };
}

const JOB_COLS = ["group_id", "geometry_id", "simulation_ref", "run_ref", "source", "spec_mode", "step_path",
  "label_path", "file_name", "team_name", "part", "setup_snapshot", "iteration_count", "refine_level",
  "inlet_velocity", "debug_mesh", "mesh_cells_m", "fineness", "cost", "charged_at", "error", "mesh_id",
  "simulation_id", "results_glb_path", "results_fields", "case_path", "drag_n", "lift_n", "created_at", "updated_at"];

/**
 * A job. The Fusion add-in wrote camelCase, folded here as onJobPending did.
 * A job still in flight cannot carry on after cutover (its worker is the
 * Cloud Run job); it is imported as it stands and not scheduled.
 */
export function jobRow(doc, map) {
  const { row, extra } = columns(snakeTop(doc.data),
    [...JOB_COLS, "user_id", "status", "run_id", "cancelled_by"]);
  const status = jobStatus(row.status);
  const legacyStatus = status !== row.status ? { legacy_status: row.status ?? null } : {};
  return {
    ...pick(row, JOB_COLS),
    source: row.source ?? "web",
    spec_mode: row.spec_mode === true,
    debug_mesh: row.debug_mesh === true,
    cost: row.cost == null ? null : Math.round(Number(row.cost)),
    id: doc.id,
    user_id: uidMapper(map)(row.user_id),
    status,
    simscale_run_id: row.run_id ?? null,
    cancelled_by: map.get(row.cancelled_by) ?? null,
    next_poll_at: null,
    extra: extra || Object.keys(legacyStatus).length ? { ...(extra ?? {}), ...legacyStatus } : null,
  };
}

export function transactionRow(doc, map) {
  const d = snakeTop(doc.data);
  return {
    user_id: uidMapper(map)(doc.parentId),
    id: doc.id,
    type: d.type,
    amount: Math.round(Number(d.amount ?? 0)),
    reason: d.reason ?? null,
    job_id: d.job_id ?? null,
    order_id: d.order_id ?? null,
    capture_id: d.capture_id ?? null,
    timestamp: d.timestamp ?? doc.created ?? new Date(0).toISOString(),
  };
}

/** The transaction types the ledger accepts; anything else is reported, not imported. */
export const TRANSACTION_TYPES = ["simulation_charge", "simulation_charge_reversal", "refund", "purchase",
  "unlimited_pass", "signup_bonus"];

// ── storage ────────────────────────────────────────────────────────────────
/** GCS's base64 md5 as the hex Storage reports in an object's eTag. */
export const md5Hex = (b64) => Buffer.from(b64, "base64").toString("hex");

/** Objects worth copying: everything under users/ and the add-in's jobs/. */
export const shouldCopy = (name) => /^(users|jobs)\//.test(name) && !name.endsWith("/");
