// Per-user rate limiting for callable functions.
//
// Without this, one script can call createPayPalOrder or submitJob in a loop.
// Nothing in the old backend stopped that, so a single account could open
// thousands of PayPal orders or hammer the credit transaction.
//
// A fixed window per user per action, counted in Firestore. Fixed windows allow
// a burst of up to 2x the limit across a window boundary; that is fine here,
// where the point is to stop runaway loops rather than to meter precisely.
//
// Rows carry expire_at so a TTL policy on the `rate` collection clears them.
// Set that policy up on the project — Firestore > TTL — or the collection grows
// forever. It is a project setting, not something code can declare.
import { logger } from "firebase-functions/v2";
import { HttpsError } from "firebase-functions/v2/https";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { db } from "./admin";
import { COL } from "./config";

export interface RateRule {
  /** Maximum calls allowed inside one window. */
  limit: number;
  /** Window length in seconds. */
  windowS: number;
}

/**
 * `as const` so the keys are a real union.
 *
 * This was `Record<string, RateRule>`, which makes `keyof typeof RATE` just
 * `string` - so a callable guarded with an action name that is not in this
 * table compiled fine and was silently not rate limited at all, because
 * enforceRateLimit returns without doing anything when it cannot find a rule.
 * A typo bought an endpoint an exemption.
 */
export const RATE = {
  submitJob: { limit: 30, windowS: 3600 },
  // Queueing a run by writing the job document directly, which is what the
  // Workbench and the Fusion add-in both do. submitJob's limit never applied
  // to either of them, so until now the only thing standing between one
  // account and an unbounded number of Cloud Run executions was its credit
  // balance, and a job that fails before it is charged does not even cost
  // that.
  runJob: { limit: 30, windowS: 3600 },
  refundJob: { limit: 30, windowS: 3600 },
  createPayPalOrder: { limit: 20, windowS: 3600 },
  capturePayPalOrder: { limit: 40, windowS: 3600 },
  createUploadIntent: { limit: 60, windowS: 3600 },
  // Group records are cheap, but a loop that makes them is still a
  // loop, and shareGroup resolves an email to a uid on every call.
  createGroup: { limit: 30, windowS: 3600 },
  shareGroup: { limit: 60, windowS: 3600 },
  // Deleting and copying both walk every child of a group, so they are not
  // free - but they were sharing createGroup's thirty, along with everything
  // else in that file.
  deleteGroup: { limit: 30, windowS: 3600 },
  copyGroup: { limit: 10, windowS: 3600 },
  // Its own bucket, and a large one, because this is the autosave.
  //
  // saveSimulation passed "createGroup" and so shared thirty calls an hour
  // with every other group callable. The Workbench saves as you type: an
  // ordinary editing session ran out inside a few minutes and then failed with
  // "Too many createGroup requests", which is not a sentence anybody could act
  // on. It writes one small document and re-runs the checker, so the real
  // limit is Firestore's own write rate.
  saveSimulation: { limit: 600, windowS: 3600 },
  // Importing and building run in the caller's own browser now, so these
  // guard documents and bucket writes rather than containers - but the shape
  // is the same as before: one intent out, one ingest back, per attempt. A
  // quick retry is expected (a bad file comes back in seconds and the user
  // fixes it and goes again), so two a minute; a loop of them is still what
  // this is for.
  createCarIntent: { limit: 2, windowS: 60 },
  ingestCar: { limit: 2, windowS: 60 },
  failCarImport: { limit: 5, windowS: 60 },
  // The browser cut path: one intent out, one ingest back, per build. A
  // quick retry is expected - a car-fault comes back in seconds and the user
  // fixes a number and goes again - so two a minute rather than prepareDomain's
  // twenty an hour. A loop of them is still what this is for.
  createArtifactIntent: { limit: 2, windowS: 60 },
  ingestPreparedDomain: { limit: 2, windowS: 60 },
  // The page calls this whenever a build goes wrong after the intent was
  // minted, including for failures that were nothing to do with the backend.
  failDomainBuild: { limit: 5, windowS: 60 },
  // Keyed by IP, not by user: exchangeFusionToken is how the add-in gets a
  // session in the first place, so there is nobody to charge it to. It was
  // public and unlimited, and every call did a Firestore read before anything
  // else - so an unauthenticated script could drive reads and invocations at
  // whatever rate it liked. The token is 32 random bytes, so guessing is not
  // the risk; the bill is.
  exchangeFusionToken: { limit: 120, windowS: 3600 },
  // Called on every sign-in that finds no account document. Almost always
  // once per account; the limit stops a loop, it does not ration anything.
  ensureAccount: { limit: 30, windowS: 3600 },
  // A run queued by somebody who is not the owner.
  //
  // Queueing spends the *owner's* credits, and that is deliberate: a group is
  // shared so a team can work in it. What was missing is a ceiling. A
  // collaborator with edit could queue thirty runs an hour against somebody
  // else's balance, which at 30 credits a run is nine hundred credits, and the
  // owner would find out from their balance.
  //
  // Keyed on owner:caller, so each collaborator gets their own allowance
  // against each owner rather than sharing one, and the owner's own limit
  // still applies on top.
  collaboratorRun: { limit: 8, windowS: 3600 },
  // These four were filed under another endpoint's allowance: updateGroup and
  // createSimulation under createGroup, the two token calls under
  // createUploadIntent. So a user who made a few simulations could no longer
  // rename a group, and the error named something they had not done.
  updateGroup: { limit: 120, windowS: 3600 },
  createSimulation: { limit: 60, windowS: 3600 },
  fusionToken: { limit: 20, windowS: 3600 },
  // By address, like exchangeFusionToken: PayPal is not a signed-in user. Every
  // call costs an outbound verify-webhook-signature request, and a flood of
  // forged ones could get our PayPal app throttled while real payments wait.
  // PayPal sends one event per payment, so this is far above any real rate.
  paypalWebhook: { limit: 300, windowS: 3600 },
} as const satisfies Record<string, RateRule>;

/**
 * Count one use and say whether the caller is now over the limit.
 *
 * Separate from enforceRateLimit because a background trigger has no caller to
 * throw an HttpsError at: it has to mark the job failed and explain why.
 *
 * Fails open. A limiter that stops every run when Firestore is briefly
 * unhappy is worse than the abuse it prevents.
 */
export async function overRateLimit(uid: string, action: keyof typeof RATE): Promise<boolean> {
  const rule = RATE[action];
  if (!rule) return false;
  try {
    return (await countUse(uid, action, rule)) > rule.limit;
  } catch (err) {
    logger.warn(`rate limit check failed for ${uid} on ${action}, allowing`, err);
    return false;
  }
}

async function countUse(uid: string, action: string, rule: RateRule): Promise<number> {
  const windowStart = Math.floor(Date.now() / (rule.windowS * 1000));
  const ref = db.collection(COL.rate).doc(`${uid}:${action}:${windowStart}`);

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const next = ((snap.exists ? Number(snap.data()?.count) : 0) || 0) + 1;
    txn.set(ref, {
      count: FieldValue.increment(1),
      uid,
      action,
      // Keep the row a little past the window so a late call in the same window
      // still sees the count rather than starting from zero.
      expire_at: Timestamp.fromMillis((windowStart + 2) * rule.windowS * 1000),
    }, { merge: true });
    return next;
  });
}

/**
 * The address a request really came from, for limits keyed by address.
 *
 * The last X-Forwarded-For entry, not the first. The client can send its own
 * X-Forwarded-For, and Google's front end appends the real address after it,
 * so the first entry is whatever the caller chose. Keyed on that, the limit on
 * exchangeFusionToken was one header away from not existing: tested against
 * the deployed function, a made-up 203.0.113.x got its own fresh bucket.
 */
export function clientIp(req: { get(name: string): string | undefined; ip?: string }): string {
  const hops = String(req.get("x-forwarded-for") ?? "").split(",")
    .map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1] ?? req.ip ?? "";
}

export async function enforceRateLimit(uid: string, action: keyof typeof RATE): Promise<void> {
  const rule = RATE[action];
  if (!rule) return;

  const count = await countUse(uid, action, rule);

  if (count > rule.limit) {
    throw new HttpsError(
      "resource-exhausted",
      `Too many ${action} requests. Try again later.`,
    );
  }
}
