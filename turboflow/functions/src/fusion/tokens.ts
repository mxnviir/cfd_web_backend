// Connection tokens for the Fusion 360 add-in.
//
// What this replaces: the Simulations page showed `auth.currentUser.refreshToken`
// as the "Fusion 360 Connection Token", with a Copy button, and told the user it
// never expires. That is the credential Firebase uses to mint session tokens for
// the account. Handing it to a desktop script means:
//
//   - it grants everything the account can do, not just submitting a job;
//   - it does not expire, and the user has no way to revoke it;
//   - it was printed on screen, so it leaks to a screenshot, a shared screen or
//     someone standing behind you — and STEM Racing teams demo their setup.
//
// These tokens are different in each of those respects. They are random, stored
// only as a hash, revocable one at a time, and the session they produce carries
// a `fusion` claim so the rest of the backend can tell a script apart from a
// person and refuse it the things a script has no business doing.
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { db, auth, FieldValue } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { overRateLimit, clientIp } from "../lib/ratelimit";
import { docId } from "../lib/schema";

/** Where the secret lives: keyed by hash, readable only by this backend. */
const SECRETS = "fusion_tokens";
/** What the user sees: no secret in it, listed under their own account. */
const LISTING = "fusion_tokens";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * A token the user pastes into the add-in.
 *
 * 32 random bytes. Prefixed so that if one is ever pasted somewhere public, a
 * secret scanner has something to match on and it is obvious what it is.
 */
function mint(): { token: string; hash: string; tail: string } {
  const secret = randomBytes(32).toString("base64url");
  const token = `tfk_${secret}`;
  return { token, hash: sha256(token), tail: secret.slice(-6) };
}

export const createFusionToken = onCall(async (request) => {
  const { uid } = await guard(
    request,
    "fusionToken",
    z.object({ label: z.string().trim().max(60).optional() }),
  );

  // A person creates these, not a script. A Fusion session minting more Fusion
  // tokens would make revoking one pointless.
  if (request.auth?.token?.fusion === true) {
    throw new HttpsError("permission-denied", "A connection token cannot create another one.");
  }

  const { token, hash, tail } = mint();
  const id = hash.slice(0, 20);
  const label = (request.data as { label?: string })?.label?.trim() || "Fusion 360";

  const batch = db.batch();
  batch.set(db.collection(SECRETS).doc(hash), {
    user_id: uid,
    token_id: id,
    created_at: FieldValue.serverTimestamp(),
    last_used_at: null,
  });
  // The listing carries no secret — just enough to tell one token from another
  // when deciding which to revoke.
  batch.set(db.collection(COL.users).doc(uid).collection(LISTING).doc(id), {
    label,
    tail,
    created_at: FieldValue.serverTimestamp(),
    last_used_at: null,
  });
  await batch.commit();

  // The only time the token is ever returned. It is not stored in a form that
  // can produce it again, so a lost token is replaced rather than recovered.
  return { token, id, label, tail };
});

export const revokeFusionToken = onCall(async (request) => {
  const { uid, data } = await guard(
    request,
    "fusionToken",
    z.object({ id: docId }),
    // A script cannot revoke tokens either. Revoking is how a person recovers
    // from a leak, and a leaked token being able to revoke the others would
    // hand an attacker the account.
    { humanOnly: true },
  );

  const listing = db.collection(COL.users).doc(uid).collection(LISTING).doc(data.id);
  const snap = await listing.get();
  if (!snap.exists) throw new HttpsError("not-found", "That token does not exist.");

  // The secret document is keyed by the full hash, and the listing id is its
  // first 20 characters, so find it by prefix rather than storing the hash
  // where the client can read it.
  const secrets = await db.collection(SECRETS)
    .where("user_id", "==", uid).where("token_id", "==", data.id).get();

  const batch = db.batch();
  secrets.docs.forEach((d) => batch.delete(d.ref));
  batch.delete(listing);
  await batch.commit();

  return { revoked: data.id };
});

/**
 * Exchange a connection token for a short-lived sign-in.
 *
 * Public, because the add-in has no session yet — that is the point of it. What
 * makes that safe is that the token is 32 random bytes and is compared against
 * a stored hash, so this endpoint leaks nothing to someone guessing.
 */
export const exchangeFusionToken = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = String((req.body as { token?: string })?.token ?? "");
  if (!token.startsWith("tfk_") || token.length < 20 || token.length > 200) {
    res.status(400).json({ error: "Invalid token." });
    return;
  }

  // Before the Firestore read, which is the thing being spent.
  //
  // Everything else in this backend is limited per user, and this endpoint has
  // no user yet - that is what it is for. So it is limited by address instead.
  // overRateLimit fails open, which is right here: a Firestore hiccup must not
  // stop an add-in signing in.
  const ip = clientIp(req);
  if (ip && await overRateLimit(`ip:${ip}`, "exchangeFusionToken")) {
    res.status(429).json({ error: "Too many attempts. Wait a little and try again." });
    return;
  }

  const hash = sha256(token);
  const snap = await db.collection(SECRETS).doc(hash).get();
  if (!snap.exists) {
    // Deliberately the same answer as a well-formed token that does not exist,
    // so this cannot be used to tell which tokens are real.
    logger.warn("fusion token exchange: no such token");
    res.status(401).json({ error: "That connection token is not valid. Create a new one on the Simulations page." });
    return;
  }

  const record = snap.data() as { user_id: string; token_id: string };

  // The comparison that used to be here was theatre: it ran timingSafeEqual on
  // `hash` against `snap.id`, and the document had just been fetched *by* that
  // hash, so the two were equal by construction and the branch could never be
  // taken. The lookup is the comparison, and a Firestore document-id lookup is
  // not constant time - which does not matter at 256 bits of entropy, but a
  // check that cannot fail should not be left standing as if it protected
  // something.

  // The claim marks this as a script session. Nothing else can set it, so the
  // rules and the callables can trust it to refuse a script the things only a
  // person should do — changing a profile, or buying credits.
  const customToken = await auth.createCustomToken(record.user_id, {
    fusion: true,
    fusion_token_id: record.token_id,
  });

  const now = FieldValue.serverTimestamp();
  await Promise.all([
    snap.ref.update({ last_used_at: now }),
    db.collection(COL.users).doc(record.user_id)
      .collection(LISTING).doc(record.token_id).update({ last_used_at: now })
      .catch(() => undefined),
  ]);

  res.status(200).json({ custom_token: customToken, user_id: record.user_id });
});
