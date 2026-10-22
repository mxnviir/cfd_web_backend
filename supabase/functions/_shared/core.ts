// What every TurboFlow edge function shares: the database, the bucket,
// errors, and who is calling.
//
// The functions talk to Postgres directly, as the database owner, over
// SUPABASE_DB_URL. That is how they reach the `private` schema, which holds
// the ledger and is exposed to nothing else; it is also why every check a
// client would get from RLS has to be made here by hand before a write.
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";

export const BUCKET = "turboflow";

const env = (name: string): string => Deno.env.get(name) ?? "";

export const sql = postgres(env("SUPABASE_DB_URL"), {
  prepare: false,
  max: 4,
  idle_timeout: 20,
  onnotice: () => {},
});

/** Storage and Auth with the service key. Never handed to a caller. */
export const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── errors ─────────────────────────────────────────────────────────────────
// The Firebase callable codes, so the pages that show err.message and switch
// on err.code keep working unchanged.
const STATUS: Record<string, number> = {
  "invalid-argument": 400,
  "failed-precondition": 400,
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "resource-exhausted": 429,
  internal: 500,
  unavailable: 503,
};

export class OpsError extends Error {
  constructor(public code: keyof typeof STATUS | string, message: string) {
    super(message);
  }
}

/** A Postgres error raised by one of our functions, as the caller should see it. */
export function fromPostgres(err: unknown): OpsError | null {
  const e = err as { code?: string; message?: string };
  const map: Record<string, string> = {
    P0001: "failed-precondition",
    P0002: "not-found",
    "42501": "permission-denied",
  };
  return e?.code && map[e.code] ? new OpsError(map[e.code], e.message ?? "") : null;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export function errorResponse(err: unknown): Response {
  const known = err instanceof OpsError ? err : fromPostgres(err);
  if (known) {
    return json({ error: { code: known.code, message: known.message } }, STATUS[known.code] ?? 400);
  }
  console.error(err);
  return json({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
}

// ── the internal secret ────────────────────────────────────────────────────
// Generated in the vault by the poller migration. pg_cron sends it to POLL,
// and the functions send it to each other; it never appears in code.
let internalSecret: string | null = null;

export async function getInternalSecret(): Promise<string> {
  if (internalSecret) return internalSecret;
  const [row] = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret'`;
  internalSecret = String(row?.decrypted_secret ?? "");
  return internalSecret;
}

/** True when the request carries the internal secret, compared in constant time. */
export async function isInternal(req: Request): Promise<boolean> {
  const got = req.headers.get("x-internal-secret") ?? "";
  const want = await getInternalSecret();
  if (!got || !want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i += 1) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

/** Call another of our functions, fire-and-forget or awaited. */
export async function callFunction(name: string, body: unknown): Promise<Response> {
  return fetch(`${env("SUPABASE_URL")}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": await getInternalSecret() },
    body: JSON.stringify(body),
  });
}

// ── callers ────────────────────────────────────────────────────────────────
export interface Caller {
  uid: string;
  email: string | null;
  name: string | null;
  /** A session from a Fusion connection token: a script, not a person. */
  fusion: boolean;
  anonymous: boolean;
  /** Google, as far as Auth knows. */
  google: boolean;
}

/**
 * Who sent this request, or null.
 *
 * A Supabase session token is checked with Auth. A Fusion session token
 * (tfs_...) is checked in Postgres, which holds both the key it was signed
 * with and the list of tokens that have not been revoked.
 */
export async function callerOf(req: Request): Promise<Caller | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  if (token.startsWith("tfs_")) {
    const [row] = await sql`select private.fusion_session(${token}) as uid`;
    return row?.uid
      ? { uid: row.uid, email: null, name: null, fusion: true, anonymous: false, google: false }
      : null;
  }

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  const u = data.user;
  const providers = (u.app_metadata?.providers as string[] | undefined) ?? [];
  return {
    uid: u.id,
    email: u.email ?? null,
    name: (u.user_metadata?.full_name as string | undefined) ?? (u.user_metadata?.name as string | undefined) ?? null,
    fusion: false,
    anonymous: u.is_anonymous === true,
    google: u.app_metadata?.provider === "google" || providers.includes("google"),
  };
}

// ── rate limits ────────────────────────────────────────────────────────────
// functions/src/lib/ratelimit.ts, the same table. Fixed windows, counted in
// public.rate_counters.
export const RATE = {
  submitJob: [30, 3600],
  runJob: [30, 3600],
  refundJob: [30, 3600],
  createPayPalOrder: [20, 3600],
  capturePayPalOrder: [40, 3600],
  createUploadIntent: [60, 3600],
  createGroup: [30, 3600],
  shareGroup: [60, 3600],
  deleteGroup: [30, 3600],
  copyGroup: [10, 3600],
  saveSimulation: [600, 3600],
  createCarIntent: [2, 60],
  ingestCar: [2, 60],
  failCarImport: [5, 60],
  createArtifactIntent: [2, 60],
  ingestPreparedDomain: [2, 60],
  failDomainBuild: [5, 60],
  exchangeFusionToken: [120, 3600],
  ensureAccount: [30, 3600],
  collaboratorRun: [8, 3600],
  updateGroup: [120, 3600],
  createSimulation: [60, 3600],
  fusionToken: [20, 3600],
  paypalWebhook: [300, 3600],
  finishResults: [20, 3600],
} as const satisfies Record<string, readonly [number, number]>;

export type RateAction = keyof typeof RATE;

/** Count one use. True when the key is now over its limit. Fails open. */
export async function overRateLimit(key: string, action: RateAction): Promise<boolean> {
  const [limit, windowS] = RATE[action];
  try {
    const [row] = await sql`select private.rate_hit(${`${key}:${action}`}, ${limit}, ${windowS}) as over`;
    return row?.over === true;
  } catch (err) {
    console.warn(`rate limit check failed for ${key} on ${action}, allowing`, err);
    return false;
  }
}

export async function enforceRateLimit(uid: string, action: RateAction): Promise<void> {
  if (await overRateLimit(uid, action)) {
    throw new OpsError("resource-exhausted", `Too many ${action} requests. Try again later.`);
  }
}

/** The address a request came from: the last X-Forwarded-For hop. */
export function clientIp(req: Request): string {
  const hops = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? "";
}

// ── storage ────────────────────────────────────────────────────────────────
/** The service key, as Storage wants it: in apikey (a new sb_secret_ key is
 *  read only there) and as the bearer, which is what supabase-js sends. */
const serviceHeaders = () => ({
  apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
  Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
});

export async function objectExists(path: string): Promise<boolean> {
  const [row] = await sql`select 1 from storage.objects where bucket_id = ${BUCKET} and name = ${path}`;
  return !!row;
}

/** The first `n` bytes of an object, without downloading the rest. */
export async function firstBytes(path: string, n: number): Promise<Uint8Array> {
  const resp = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    headers: { ...serviceHeaders(), Range: `bytes=0-${n - 1}` },
  });
  if (!resp.ok) throw new Error(`could not read ${path}: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer()).slice(0, n);
}

/** A whole object as a stream, for passing straight on to somewhere else. */
export async function objectStream(path: string): Promise<{ body: ReadableStream<Uint8Array>; size: number }> {
  const resp = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    headers: serviceHeaders(),
  });
  if (!resp.ok || !resp.body) throw new Error(`could not read ${path}: ${resp.status}`);
  return { body: resp.body, size: Number(resp.headers.get("content-length") ?? 0) };
}

export async function readJson(path: string): Promise<any> {
  const { data, error } = await admin.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`could not read ${path}: ${error?.message}`);
  return JSON.parse(await data.text());
}

export async function writeObject(path: string, body: BodyInit, contentType: string): Promise<void> {
  const { error } = await admin.storage.from(BUCKET).upload(path, body as Blob, { contentType, upsert: true });
  if (error) throw new Error(`could not write ${path}: ${error.message}`);
}

/**
 * Stream a body into the bucket without holding it in memory. Used for
 * results that can be gigabytes; the Storage API takes a chunked body.
 */
export async function streamObject(path: string, body: ReadableStream<Uint8Array>, contentType: string): Promise<void> {
  const resp = await fetch(`${env("SUPABASE_URL")}/storage/v1/object/${BUCKET}/${encodeURI(path)}`, {
    method: "POST",
    headers: {
      ...serviceHeaders(),
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body,
    // @ts-ignore: Deno's fetch streams a request body with duplex "half".
    duplex: "half",
  });
  if (!resp.ok) throw new Error(`could not stream ${path}: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
}

export async function copyObject(from: string, to: string): Promise<void> {
  await admin.storage.from(BUCKET).remove([to]);
  const { error } = await admin.storage.from(BUCKET).copy(from, to);
  if (error) throw new Error(`could not copy ${from}: ${error.message}`);
}

/** Every object under a prefix, removed. Best effort, like deleteFiles. */
export async function removePrefix(prefix: string): Promise<void> {
  const rows = await sql`select name from storage.objects where bucket_id = ${BUCKET} and name like ${prefix + "%"}`;
  const names = rows.map((r) => String(r.name));
  for (let i = 0; i < names.length; i += 100) {
    const { error } = await admin.storage.from(BUCKET).remove(names.slice(i, i + 100));
    if (error) console.warn(`could not clear part of ${prefix}`, error.message);
  }
}

export async function listPrefix(prefix: string): Promise<string[]> {
  const rows = await sql`select name from storage.objects where bucket_id = ${BUCKET} and name like ${prefix + "%"}`;
  return rows.map((r) => String(r.name));
}

/** The caller's folder under users/. */
export async function storageUid(uid: string): Promise<string> {
  const [row] = await sql`select storage_uid from public.users where id = ${uid}`;
  if (!row) throw new OpsError("failed-precondition", "Your account is not set up yet. Reload the page.");
  return String(row.storage_uid);
}

/** A jsonb parameter. postgres.js types its JSON narrowly; every caller's value is plain data. */
// deno-lint-ignore no-explicit-any
export const jsonb = (v: unknown) => sql.json(v as any);
