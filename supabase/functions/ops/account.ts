// Accounts and Fusion 360 connection tokens.
//
// ensureAccount writes the account row and the signup bonus, once, in
// private.ensure_account. A client cannot create its own row (no grant), so
// "is this your first account?" is never asked of the client.
//
// Connection tokens (tfk_...) are random, stored only as a hash, revocable,
// and exchanged for an hour-long session token (tfs_...) that the router
// accepts as a script - refused everything humanOnly.
import { sql, OpsError, overRateLimit, clientIp, getInternalSecret } from "../_shared/core.ts";
import type { Ctx } from "./index.ts";

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (v: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** How long a session from a connection token lasts. The add-in exchanges again after. */
const SESSION_S = 3600;

export async function ensureAccount({ caller }: Ctx) {
  const [existing] = await sql`select 1 from public.users where id = ${caller.uid}`;
  if (existing) return { created: false };

  // Google is the only way to make an account. The local development stack
  // also lets the anonymous localhost session have one, so the Workbench
  // opens without the popup; nothing else gets a row or credits.
  const dev = (Deno.env.get("TURBOFLOW_ENV") ?? "") === "development";
  if (!caller.google && !(dev && caller.anonymous)) {
    console.warn(`refused an account row for ${caller.uid}: not a Google sign-in`);
    throw new OpsError("permission-denied",
      "TurboFlow accounts are made with Google. Sign out and use Continue with Google.");
  }
  const [row] = await sql`select private.ensure_account(${caller.uid}, ${caller.email}, ${caller.name}, ${caller.uid}) as created`;
  return { created: row.created === true };
}

export async function createFusionToken({ caller, data }: Ctx) {
  // A session minted from a connection token cannot mint more of them, or
  // revoking one would be pointless.
  if (caller.fusion) throw new OpsError("permission-denied", "A connection token cannot create another one.");
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const token = `tfk_${secret}`;
  const hash = await sha256(token);
  const id = hash.slice(0, 20);
  const label = String(data?.label ?? "").trim().slice(0, 60) || "Fusion 360";
  const tail = secret.slice(-6);
  await sql.begin(async (tx) => {
    await tx`insert into public.fusion_tokens (hash, user_id, token_id) values (${hash}, ${caller.uid}, ${id})`;
    await tx`insert into public.fusion_token_listing (id, user_id, label, tail) values (${id}, ${caller.uid}, ${label}, ${tail})`;
  });
  // The only time the token is ever returned. Lost means replaced.
  return { token, id, label, tail };
}

export async function revokeFusionToken({ caller, data }: Ctx) {
  const rows = await sql.begin(async (tx) => {
    const listed = await tx`delete from public.fusion_token_listing where id = ${data.id} and user_id = ${caller.uid} returning id`;
    await tx`delete from public.fusion_tokens where user_id = ${caller.uid} and token_id = ${data.id}`;
    return listed;
  });
  if (!rows.length) throw new OpsError("not-found", "That token does not exist.");
  return { revoked: data.id };
}

/**
 * A connection token for a session token. Public - the add-in has no session
 * yet - so it is limited by address, before the lookup it would spend.
 */
export async function exchangeFusionToken({ data, req }: Ctx) {
  const token = String(data?.token ?? "");
  if (!token.startsWith("tfk_") || token.length < 20 || token.length > 200) {
    throw new OpsError("invalid-argument", "Invalid token.");
  }
  const ip = clientIp(req);
  if (ip && await overRateLimit(`ip:${ip}`, "exchangeFusionToken")) {
    throw new OpsError("resource-exhausted", "Too many attempts. Wait a little and try again.");
  }
  const hash = await sha256(token);
  const [record] = await sql`select user_id, token_id from public.fusion_tokens where hash = ${hash}`;
  if (!record) {
    // The same answer whether or not the token was well formed.
    throw new OpsError("unauthenticated",
      "That connection token is not valid. Create a new one on the Simulations page.");
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_S;
  const payload = `${record.user_id}.${record.token_id}.${exp}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(await getInternalSecret()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  await sql`update public.fusion_tokens set last_used_at = now() where hash = ${hash}`;
  await sql`update public.fusion_token_listing set last_used_at = now() where id = ${record.token_id}`;
  return { session_token: `tfs_${payload}.${sig}`, user_id: record.user_id, expires_at: exp };
}
