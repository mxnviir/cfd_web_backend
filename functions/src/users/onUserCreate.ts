// Creating the account record, server-side.
//
// The old rules let the client create its own users/{uid} document as long as it
// said `credits == 50`. Signing up is free and unverified, so the 50 credits
// were farmable: make an account, take the credits, make another. Rules cannot
// fix this — they can only check what a client claims, and "this is my first
// account" is not something a client can be asked.
//
// So the client does not write this document. firestore.rules denies create on
// users/{uid}, and it is written here, by a callable the site makes straight
// after sign-in (Shell.jsx). The server decides everything: whether the account
// is a Google one, whether a document already exists, and the fifty credits.
//
// Why a callable. Until 24 Sep 2026 this was `beforeUserCreated`, a blocking
// function that runs inside sign-up. Blocking functions need Identity Platform;
// production (turboflow-7b3ca) is on plain Firebase Auth, and that upgrade
// cannot be undone, and the owner chose to stay on Firebase Auth so a move to
// this build can be rolled back completely. The other non-blocking option, a
// first-generation `auth.user().onCreate`, cannot run on Node 24, which the
// rest of this codebase uses. A callable runs anywhere.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { z } from "zod";
import { auth, db, FieldValue } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";

/** Credits a new account starts with. */
export const SIGNUP_BONUS = 50;

/**
 * Google is the only way to make a TurboFlow account.
 *
 * Password accounts were possible until 24 Sep 2026; the owner decided on
 * Google only. The provider is off on both projects. An account made any other
 * way (a provider switched on in the console by mistake) gets no document and
 * no credits, so it can do nothing here.
 *
 * Checked every way the provider can be reported, because refusing a real
 * Google account would lock out a new team with no error they could act on.
 */
export function isGoogleSignUp(event: {
  additionalUserInfo?: { providerId?: string };
  credential?: { providerId?: string };
  data?: { providerData?: { providerId?: string }[] };
}): boolean {
  return event.additionalUserInfo?.providerId === "google.com"
    || event.credential?.providerId === "google.com"
    || (event.data?.providerData ?? []).some((p) => p.providerId === "google.com");
}

export const ensureAccount = onCall(async (request) => {
  const { uid } = await guard(request, "ensureAccount", z.object({}), { humanOnly: true });

  const userRef = db.collection(COL.users).doc(uid);
  // Almost every call is a returning user: answer that without the lookup.
  if ((await userRef.get()).exists) return { created: false };

  // The account's providers, from the auth record rather than the token, so a
  // Google account is recognised however this particular session was made.
  const record = await auth.getUser(uid);
  // The local test page signs in anonymously against the emulator, and an
  // account document is what gets it past the team-setup screen. Anonymous is
  // the one exception the emulator makes; anything else — a password account,
  // say — is refused exactly as in production.
  const emulated = process.env.FUNCTIONS_EMULATOR === "true";
  // An anonymous user has no providers at all: providerData is empty.
  const anonymous = (record.providerData ?? []).length === 0;
  if (!(emulated && anonymous) && !isGoogleSignUp({ data: record })) {
    const via = record.providerData.map((p) => p.providerId).join(",") || "no provider";
    logger.warn(`refused an account document for ${uid}, created via ${via}: Google is the only sign-in`);
    throw new HttpsError("permission-denied",
      "TurboFlow accounts are made with Google. Sign out and use Continue with Google.");
  }

  // Two tabs can sign in at once. Written only if the document still does not
  // exist inside the transaction, so a second call can never reset a balance
  // that has already been spent back to fifty.
  const created = await db.runTransaction(async (txn) => {
    if ((await txn.get(userRef)).exists) return false;
    txn.set(userRef, {
      email: record.email ?? null,
      name: record.displayName ?? null,
      team_name: null,
      credits: SIGNUP_BONUS,
      sponsored: false,
      sponsor_rate: 1,
      // Google has already verified the address.
      email_verified: true,
      created_at: FieldValue.serverTimestamp(),
      last_seen: FieldValue.serverTimestamp(),
    });
    txn.set(userRef.collection(COL.transactions).doc("signup_bonus"), {
      type: "signup_bonus",
      amount: SIGNUP_BONUS,
      reason: "Welcome to TurboFlow",
      timestamp: FieldValue.serverTimestamp(),
    });
    return true;
  });

  if (created) logger.info(`account created for ${uid} via google.com, credits ${SIGNUP_BONUS}`);
  return { created };
});
