// How much of the bucket one account may use.
//
// The hole: `storage.rules` allows
//
//     match /jobs/{jobId}/{allPaths=**} {
//       allow create: if signedIn() && resource == null && underLimit(60);
//     }
//
// `resource == null` makes a path write-once, which stops one account
// overwriting another's upload. It does nothing about *new* paths. Any signed-in
// account could write a 60 MB object to `jobs/<anything>/<anything>` as many
// times as it liked, and the same is true under its own
// `users/{uid}/geometries/{anything}/raw.step`: the filename is constrained,
// the number of geometry ids is not.
//
// Sign-up is free and unverified, so that is an unmetered write to somebody
// else's bill, and nothing anywhere counted the bytes.
//
// Two halves, because either alone can be walked around:
//
//   1. createUploadIntent refuses to hand out a path when the account is over.
//      That is the polite stop, with a message, before a long upload.
//   2. This trigger counts every object as it lands. A client that skips the
//      callable and writes straight to Storage still gets counted, and once it
//      is over, anything it writes that it was allowed to write is removed.
//
// What is never removed is a file one of our own services wrote - a version's
// GLB, face list or STEP. Deleting one of those mid-pipeline would break a run
// the user has already paid for, to enforce a quota. Those count toward the
// tally and can push an account over; they just are not what gets swept.
import { onObjectFinalized, onObjectDeleted } from "firebase-functions/v2/storage";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { db, bucket } from "../lib/admin";
import { COL } from "../lib/config";

/** Same region as the other storage trigger; see processGeometry. */
const BUCKET_REGION = process.env.BUCKET_REGION || "us-east1";

/**
 * Five gibibytes.
 *
 * A raw upload is capped at 60 MB and a prepared version adds a GLB, a face
 * list, a solids file and a STEP on top, so one car costs a few hundred
 * megabytes across its versions. Five gibibytes is roughly a season of cars for
 * a team with room to spare, and it is four orders of magnitude below what an
 * unmetered account could write in an afternoon.
 *
 * Per account, overridable on the user document for a team that needs more.
 */
export const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/** Which account a path belongs to, or null if it belongs to none. */
export function ownerOf(path: string): string | null {
  const m = /^users\/([^/]+)\//.exec(path ?? "");
  return m ? (m[1] as string) : null;
}

/**
 * Paths a client is allowed to create, and therefore paths worth sweeping.
 *
 * Everything else under a user's prefix was written by the geometry service or
 * the worker with admin credentials, and removing one of those breaks a run
 * rather than stopping an abuse.
 */
export function clientWritable(path: string): boolean {
  return /^users\/[^/]+\/geometries\/[^/]+\/(raw\.(step|stp|iges|igs|stl)|geometry\.step|entity_labels\.csv)$/i
    .test(path ?? "");
}

/**
 * Results the worker writes after a run: the 3D surface, its fields, the logs
 * and the full OpenFOAM case for ParaView.
 *
 * Not counted. A case is 100 MB and up, so counting them would fill a 5 GiB
 * allowance in about fifty runs and then refuse the team's next CAD upload -
 * a quota on uploads enforced by results nobody uploaded. They also cannot be
 * used for free storage: only the worker writes here, and only after a run the
 * account paid for. The full cases expire on a bucket lifecycle rule instead.
 */
export function isRunResult(path: string): boolean {
  return /^users\/[^/]+\/results\//.test(path ?? "");
}

/** The account's cap, and what it has used. */
export async function usage(uid: string): Promise<{ used: number; quota: number; over: boolean }> {
  const snap = await db.collection(COL.users).doc(uid).get();
  const used = Number(snap.get("storage_bytes") ?? 0);
  const quota = Number(snap.get("storage_quota_bytes")) > 0
    ? Number(snap.get("storage_quota_bytes"))
    : DEFAULT_QUOTA_BYTES;
  return { used: Number.isFinite(used) ? used : 0, quota, over: used >= quota };
}

export const onStorageWrite = onObjectFinalized(
  { region: BUCKET_REGION, memory: "256MiB" },
  async (event) => {
    const path = event.data.name ?? "";
    const uid = ownerOf(path);
    if (!uid || isRunResult(path)) return;  // jobs/**, results, anything else: see above
    const size = Number(event.data.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) return;

    const userRef = db.collection(COL.users).doc(uid);
    // increment, not read-modify-write: several uploads land at once and a
    // read-then-set loses all but the last.
    await userRef.set({ storage_bytes: FieldValue.increment(size) }, { merge: true });

    const { used, quota } = await usage(uid);
    if (used <= quota) return;

    if (!clientWritable(path)) {
      // One of ours pushed them over. Record it; do not delete it.
      logger.warn(`${uid} is over its storage quota (${used} of ${quota}) after a service write`);
      await userRef.set({ storage_over_quota: true }, { merge: true });
      return;
    }

    logger.warn(`${uid} is over its storage quota (${used} of ${quota}); removing ${path}`);
    try {
      await bucket().file(path).delete();
      await userRef.set({
        storage_bytes: FieldValue.increment(-size),
        storage_over_quota: true,
      }, { merge: true });
    } catch (err) {
      logger.error(`could not remove ${path} for an over-quota account`, err);
    }
  },
);

export const onStorageDelete = onObjectDeleted(
  { region: BUCKET_REGION, memory: "256MiB" },
  async (event) => {
    const path = event.data.name ?? "";
    const uid = ownerOf(path);
    if (!uid || isRunResult(path)) return;  // never counted, so never refunded
    const size = Number(event.data.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) return;

    const userRef = db.collection(COL.users).doc(uid);
    await userRef.set({ storage_bytes: FieldValue.increment(-size) }, { merge: true });

    // Coming back under the cap clears the flag, so deleting a car is a way out
    // of a full account rather than a state somebody has to write in about.
    const { over } = await usage(uid);
    if (!over) await userRef.set({ storage_over_quota: false }, { merge: true });
  },
);
