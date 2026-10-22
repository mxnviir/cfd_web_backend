// The Supabase client, behind the surface the pages were written against.
//
// The views were written for Firebase: `db.collection('x').doc(y).onSnapshot`,
// `snap.exists`, `functions.httpsCallable(name)`, a resumable upload task
// with progress events. Rewriting every view by hand is a large change with
// plenty of room for a silent mistake, so that small surface is implemented
// here on supabase-js instead, and the views stay as they were:
//
//   collections     Postgres tables, through PostgREST and RLS
//   onSnapshot      a fetch, then a Realtime subscription that refetches
//   httpsCallable   POST /functions/v1/ops {op, payload}
//   storage         the `turboflow` bucket, same paths
//
// Two flavours share it. The Workbench (makeDb({ camel: true })) reads and
// writes camelCase at the top level, converted here to the snake_case the
// tables use, as firebase.js did. The classic site's compiled bundle reads
// and writes the raw names, and gets both spellings back on read.
import { createClient } from "@supabase/supabase-js";

const LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

// supabase-config.js is a plain script in public/, so it is not bundled and
// can be swapped between projects without rebuilding.
const config = typeof window !== "undefined" && window.SUPABASE_CONFIG;
if (!config?.url || !config?.anonKey) throw new Error("supabase-config.js must load before the app.");

export const supabase = createClient(config.url, config.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const BUCKET = "turboflow";

/** True on localhost, where the Workbench signs in anonymously. */
export const isLocal = LOCAL;

// ── names ──────────────────────────────────────────────────────────────────
const TO_SNAKE = { drag_N: "drag_n", lift_N: "lift_n" };
const TO_CAMEL = { drag_n: "drag_N", lift_n: "lift_N" };
export const toSnake = (k) => TO_SNAKE[k] ?? k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
export const toCamel = (k) => TO_CAMEL[k] ?? k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Firestore's Timestamp, enough of it for the views: seconds, toMillis, toDate. */
export class Timestamp {
  constructor(ms) {
    this.seconds = Math.floor(ms / 1000);
    this.nanoseconds = (ms % 1000) * 1e6;
    this._ms = ms;
  }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
  static now() { return new Timestamp(Date.now()); }
}
const TIME_KEY = /(_at|At)$|^(last_seen|lastSeen|unlimited_until|unlimitedUntil|timestamp)$/;

const SERVER_TIMESTAMP = Symbol("serverTimestamp");
class Increment { constructor(n) { this.n = n; } }
export const FieldValue = {
  serverTimestamp: () => SERVER_TIMESTAMP,
  increment: (n) => new Increment(n),
  delete: () => undefined,
};

// ── tables ─────────────────────────────────────────────────────────────────
// A Firestore path, as a table and the filters it implies. Subcollections
// become a child table filtered on its parent's id.
const SUB = {
  transactions: { table: "transactions", parent: "user_id" },
  fusion_tokens: { table: "fusion_token_listing", parent: "user_id" },
  artifact_intents: { table: "artifact_intents", parent: "geometry_id", key: "token" },
  selections: { table: "selections", parent: "geometry_id" },
  post_states: { table: "post_states", parent: "run_id" },
};

function resolve(path) {
  const parts = path.split("/");
  if (parts.length % 2 === 1) {
    if (parts.length === 1) return { table: parts[0], key: "id", filters: [] };
    const sub = SUB[parts[2]];
    if (!sub) throw new Error(`No table for ${path}.`);
    return { table: sub.table, key: sub.key ?? "id", filters: [[sub.parent, "==", parts[1]]], parentCol: sub.parent, parentId: parts[1] };
  }
  const col = resolve(parts.slice(0, -1).join("/"));
  return { ...col, id: parts[parts.length - 1] };
}

const OPS = { "==": "eq", "!=": "neq", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte", in: "in", "array-contains": "contains" };

function applyFilters(q, filters) {
  for (const [field, op, value] of filters) {
    const fn = OPS[op];
    if (!fn) throw new Error(`Unsupported query operator ${op}.`);
    q = fn === "contains" ? q.contains(field, [value]) : q[fn](field, value);
  }
  return q;
}

/** A PostgREST / Storage error, in Firestore's vocabulary. */
function asError(err) {
  if (!err) return null;
  const code = err.code === "42501" || /row-level security|permission denied/i.test(err.message ?? "")
    ? "permission-denied" : err.code === "PGRST116" ? "not-found" : "unknown";
  return Object.assign(new Error(err.message ?? String(err)), { code });
}

export function makeDb({ camel }) {
  const keyIn = camel ? toCamel : (k) => k;
  const keyOut = camel ? toSnake : toSnake;

  const fromRow = (row, key) => {
    const out = {};
    for (const [k, v] of Object.entries(row ?? {})) {
      const val = TIME_KEY.test(k) && typeof v === "string" ? new Timestamp(Date.parse(v)) : v;
      out[keyIn(k)] = val;
      // The classic site reads either spelling: give it both.
      if (!camel && toCamel(k) !== k) out[toCamel(k)] = val;
    }
    if (key !== "id") out.id = row?.[key];
    return out;
  };

  /** A write's values, as columns: names converted, sentinels resolved. */
  const toRow = async (data, current) => {
    const row = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v === undefined) continue;
      const col = keyOut(k);
      if (v === SERVER_TIMESTAMP) row[col] = new Date().toISOString();
      else if (v instanceof Increment) row[col] = Number(current?.[col] ?? 0) + v.n;
      else if (v instanceof Timestamp) row[col] = v.toDate().toISOString();
      else if (v instanceof Date) row[col] = v.toISOString();
      else row[col] = v;
    }
    return row;
  };

  const wrapDoc = (id, row, key) => ({
    id,
    exists: !!row,
    data: () => (row ? fromRow(row, key) : undefined),
    get: (f) => (row ? fromRow(row, key)[f] : undefined),
  });

  const wrapQuery = (rows, key) => {
    const docs = rows.map((r) => wrapDoc(r[key], r, key));
    return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
  };

  /** Refetch on any change to the table that RLS lets this session see. */
  let channelSeq = 0;
  const watch = (table, filter, refetch) => {
    let timer = null;
    const channel = supabase.channel(`tf-${table}-${(channelSeq += 1)}`)
      .on("postgres_changes", { event: "*", schema: "public", table, ...(filter ? { filter } : {}) }, () => {
        clearTimeout(timer);
        timer = setTimeout(refetch, 50);
      })
      .subscribe();
    return () => { clearTimeout(timer); supabase.removeChannel(channel); };
  };
  const realtimeFilter = ([field, op, value]) =>
    op === "==" && typeof value !== "object" ? `${field}=eq.${value}` : null;

  function docRef(path) {
    const r = resolve(path);
    const select = async () => {
      const { data, error } = await supabase.from(r.table).select("*").eq(r.key, r.id).maybeSingle();
      if (error) throw asError(error);
      return data;
    };
    return {
      id: r.id,
      path,
      get: async () => wrapDoc(r.id, await select(), r.key),
      set: async (data, opts) => {
        const current = await select().catch(() => null);
        if (opts?.merge && current) {
          // Firestore merges nested maps; so does this, one level down.
          const patch = await toRow(data, current);
          for (const [k, v] of Object.entries(patch)) {
            if (v && typeof v === "object" && !Array.isArray(v) && current[k] && typeof current[k] === "object") {
              patch[k] = { ...current[k], ...v };
            }
          }
          const { error } = await supabase.from(r.table).update(patch).eq(r.key, r.id);
          if (error) throw asError(error);
          return;
        }
        const row = { ...(await toRow(data, current)), [r.key]: r.id };
        if (r.parentCol) row[r.parentCol] = r.parentId;
        const { error } = await supabase.from(r.table).upsert(row);
        if (error) throw asError(error);
      },
      update: async (data) => {
        const needsCurrent = Object.values(data ?? {}).some((v) => v instanceof Increment);
        const { error } = await supabase.from(r.table)
          .update(await toRow(data, needsCurrent ? await select() : null)).eq(r.key, r.id);
        if (error) throw asError(error);
      },
      delete: async () => {
        const { error } = await supabase.from(r.table).delete().eq(r.key, r.id);
        if (error) throw asError(error);
      },
      onSnapshot: (next, onError) => {
        let live = true;
        const refetch = () => select()
          .then((row) => live && next(wrapDoc(r.id, row, r.key)))
          .catch((err) => live && onError?.(err));
        refetch();
        const stop = watch(r.table, `${r.key}=eq.${r.id}`, refetch);
        return () => { live = false; stop(); };
      },
      collection: (name) => collectionRef(`${path}/${name}`),
    };
  }

  function collectionRef(path) {
    const r = resolve(path);
    const build = (filters, order, max) => {
      const run = async () => {
        let q = applyFilters(supabase.from(r.table).select("*"), filters);
        for (const [field, dir] of order) q = q.order(field, { ascending: dir !== "desc" });
        if (max) q = q.limit(max);
        const { data, error } = await q;
        if (error) throw asError(error);
        return data ?? [];
      };
      return {
        doc: (id) => docRef(`${path}/${id ?? genId()}`),
        // A field name is a database name, so it converts too - otherwise
        // where('userId', ...) matches nothing and the page looks empty.
        where: (field, op, value) => build([...filters, [toSnake(field), op, value]], order, max),
        orderBy: (field, dir) => build(filters, [...order, [toSnake(field), dir]], max),
        limit: (n) => build(filters, order, n),
        get: async () => wrapQuery(await run(), r.key),
        onSnapshot: (next, onError) => {
          let live = true;
          const refetch = () => run().then((rows) => live && next(wrapQuery(rows, r.key)))
            .catch((err) => live && onError?.(err));
          refetch();
          const stop = watch(r.table, filters.length ? realtimeFilter(filters[0]) : null, refetch);
          return () => { live = false; stop(); };
        },
      };
    };
    return build(r.filters, [], null);
  }

  const batch = () => {
    const ops = [];
    return {
      set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)); },
      update: (ref, data) => { ops.push(() => ref.update(data)); },
      delete: (ref) => { ops.push(() => ref.delete()); },
      // ponytail: applied in order, not atomically. Only the classic site's
      // old client-side ledger code batches, and every write it makes is
      // refused by the grants anyway; anything that must be atomic is an op.
      commit: async () => { for (const op of ops) await op(); },
    };
  };

  return { collection: collectionRef, batch };
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export const genId = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => ID_CHARS[b % 62]).join("");

export const db = makeDb({ camel: true });

// ── auth ───────────────────────────────────────────────────────────────────
/** A Supabase user, in the shape the views read off firebase.User. */
function wrapUser(u) {
  if (!u) return null;
  return {
    uid: u.id,
    email: u.email ?? null,
    displayName: u.user_metadata?.full_name ?? u.user_metadata?.name ?? null,
    photoURL: u.user_metadata?.avatar_url ?? null,
    isAnonymous: u.is_anonymous === true,
    // Firebase's refresh token was once shown as a "connection token". There
    // is no such thing to show here; connection tokens are minted by the
    // createFusionToken op.
    refreshToken: null,
    getIdToken: async () => (await supabase.auth.getSession()).data.session?.access_token ?? null,
  };
}

let current = null;
supabase.auth.getSession().then(({ data }) => { current = wrapUser(data.session?.user); });

export class GoogleAuthProvider {}

export const auth = {
  get currentUser() { return current; },
  onAuthStateChanged: (cb) => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      current = wrapUser(session?.user);
      // Supabase calls back inside its auth lock; anything the callback does
      // with the client must run after it.
      setTimeout(() => cb(current), 0);
    });
    return () => data.subscription.unsubscribe();
  },
  // A redirect, not a popup: Supabase's OAuth comes back to this page and
  // the session is picked up from the URL.
  signInWithPopup: () => auth.signInWithRedirect(),
  signInWithRedirect: async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google", options: { redirectTo: location.href },
    });
    if (error) throw Object.assign(new Error(error.message), { code: "auth/internal-error" });
  },
  signInAnonymously: async () => {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw Object.assign(new Error(error.message), { code: "auth/operation-not-allowed" });
  },
  signOut: () => supabase.auth.signOut(),
};

// ── ops ────────────────────────────────────────────────────────────────────
/** Firebase's callable, against the ops router: resolves {data}, throws {code, message}. */
export async function callOp(name, payload) {
  const token = (await supabase.auth.getSession()).data.session?.access_token ?? config.anonKey;
  const resp = await fetch(`${config.url}/functions/v1/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: config.anonKey },
    body: JSON.stringify({ op: name, payload: payload ?? {} }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const code = body?.error?.code ?? "internal";
    throw Object.assign(new Error(body?.error?.message ?? `The request failed (${resp.status}).`),
      { code: `functions/${code}`, details: body?.error });
  }
  return { data: body.data };
}

export const functions = {
  httpsCallable: (name) => (data) => callOp(name, data),
};

// ── storage ────────────────────────────────────────────────────────────────
/**
 * Firebase's UploadTask: .on("state_changed", progress, error, complete) and
 * thenable. Uploaded with XHR so the progress is the upload's own, which
 * fetch cannot report. Write-once, as the storage policy requires.
 */
function upload(path, blob, meta) {
  const listeners = [];
  const snap = { bytesTransferred: 0, totalBytes: blob.size ?? 0, state: "running" };
  const done = (async () => {
    const token = (await supabase.auth.getSession()).data.session?.access_token;
    await new Promise((resolveUpload, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${config.url}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("apikey", config.anonKey);
      xhr.setRequestHeader("Content-Type", meta?.contentType || blob.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        snap.bytesTransferred = e.loaded;
        snap.totalBytes = e.total || snap.totalBytes;
        listeners.forEach((l) => l.next?.({ ...snap }));
      };
      xhr.onload = () => (xhr.status < 300 ? resolveUpload()
        : reject(Object.assign(new Error(`Upload refused (${xhr.status}): ${xhr.responseText.slice(0, 200)}`),
          { code: xhr.status === 403 || xhr.status === 400 ? "storage/unauthorized" : "storage/unknown" })));
      xhr.onerror = () => reject(Object.assign(new Error("The upload failed."), { code: "storage/retry-limit-exceeded" }));
      xhr.send(blob);
    });
    snap.state = "success";
    snap.bytesTransferred = snap.totalBytes;
    return snap;
  })();
  done.then(() => listeners.forEach((l) => l.complete?.()), (err) => listeners.forEach((l) => l.error?.(err)));
  return {
    on: (_event, next, error, complete) => { listeners.push({ next, error, complete }); },
    then: (a, b) => done.then(a, b),
    catch: (b) => done.catch(b),
  };
}

async function signedUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error) throw Object.assign(new Error(error.message), { code: "storage/object-not-found" });
  return data.signedUrl;
}

async function bytes(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw Object.assign(new Error(error.message || `Could not read ${path}`), { code: "storage/object-not-found" });
  return data.arrayBuffer();
}

/** An object's size in bytes, from Storage's listing of its folder. */
async function size(path) {
  const slash = path.lastIndexOf("/");
  const { data, error } = await supabase.storage.from(BUCKET)
    .list(path.slice(0, slash), { search: path.slice(slash + 1), limit: 10 });
  const hit = (data ?? []).find((o) => o.name === path.slice(slash + 1));
  if (error || !hit) throw Object.assign(new Error(error?.message || `${path} is not there`), { code: "storage/object-not-found" });
  return Number(hit.metadata?.size ?? 0);
}

export const storage = {
  upload,
  size,
  url: signedUrl,
  bytes,
  /** A JSON file the pipeline wrote, such as a saved SimScale event log. */
  getJson: async (path) => JSON.parse(new TextDecoder().decode(await bytes(path))),
};
