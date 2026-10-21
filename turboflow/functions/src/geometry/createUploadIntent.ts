// Claim a storage path before anything is uploaded to it.
//
// Two problems this solves.
//
// The old storage rule was `allow create, update: if isSignedIn()` on
// jobs/{jobId}/**, because the Fusion add-in uploads under a random job id
// before the job document exists, so the rule had nothing to check ownership
// against. That meant any signed-in user could overwrite anyone else's geometry
// or results, with no size or content-type limit.
//
// Minting the id here, and writing the owner claim first, means the storage
// rule can require that the geometry document exists and belongs to the caller.
// The claim comes before the bytes, so there is no window where the path is
// unowned.
//
// The path is keyed by geometry, not by job. The worker deletes its own job
// folder when it finishes, and with job-keyed paths a second run against the
// same geometry was downloading a file the first run had already cleaned up.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db, FieldValue } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { createUploadIntentSchema } from "../lib/schema";
import { usage } from "../storage/quota";

/**
  * Maximum upload size per file. The storage rules enforce the same number.
  *
  * 60 MB for a raw CAD upload, per build spec 13.4. The geometry service
  * refuses anything over 50 MB anyway, so a larger cap would only let someone
  * wait through a long upload to be told no at the end.
  */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_RAW_BYTES = 60 * 1024 * 1024;

const FILENAME = { step: "geometry.step", labels: "entity_labels.csv" } as const;

/** Which extension means what, for the geometries document. STEP only:
 *  the browser's occt-wasm engine is the reader now, and it reads STEP. */
const FORMAT_OF: Record<string, "STEP"> = {
  step: "STEP", stp: "STEP",
};

/**
 * Returns the one path the caller is allowed to upload to.
 *
 * Call it once per file. Leave geometry_id out for the first file; pass the id
 * it returns for the second, so both land under the same geometry.
 */
/**
 * Filing a car into a group requires being in that group.
 *
 * Nothing checked this, here or in firestore.rules, while createSimulation
 * checked it all along. The list rules let a group member read anything
 * carrying their group_id, so a stranger who learned a group id could put a
 * geometry with a name of their choosing into somebody else's Workbench.
 */
async function mustReachGroup(uid: string, groupId: string | null | undefined) {
  if (!groupId) return;
  const snap = await db.collection(COL.groups).doc(groupId).get();
  if (!snap.exists) throw new HttpsError("not-found", "No such group.");
  const shared = snap.get("shared_with") ?? {};
  if (snap.get("user_id") !== uid && shared[uid] !== "edit") {
    throw new HttpsError("permission-denied", "You cannot add a car to this group.");
  }
}

export const createUploadIntent = onCall(async (request) => {
  const { uid, data } = await guard(request, "createUploadIntent", createUploadIntentSchema);
  await mustReachGroup(uid, data.group_id);

  // Refused here, with a sentence, rather than after a 60 MB upload finishes.
  // The trigger in storage/quota.ts is the half that cannot be skipped; this is
  // the half that is polite about it.
  const { used, quota } = await usage(uid);
  if (used + data.size_bytes > quota) {
    const gb = (n: number) => (n / (1024 ** 3)).toFixed(1);
    throw new HttpsError(
      "resource-exhausted",
      `This would take you past your ${gb(quota)} GB of storage; you are using `
      + `${gb(used)} GB. Delete a car you have finished with, or ask us to raise it.`,
    );
  }

  const ref = data.geometry_id
    ? db.collection(COL.geometries).doc(data.geometry_id)
    : db.collection(COL.geometries).doc();

  if (data.geometry_id) {
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "That geometry does not exist.");
    if (snap.data()?.user_id !== uid) {
      throw new HttpsError("permission-denied", "That geometry is not yours.");
    }
  }

  if (data.kind === "raw") {
    if (!data.ext) {
      throw new HttpsError("invalid-argument", "Say which kind of file this is.");
    }
    if (!FORMAT_OF[data.ext]) {
      throw new HttpsError(
        "invalid-argument",
        "TurboFlow reads STEP files. Export your model as STEP and try again.",
      );
    }
    if (data.size_bytes > MAX_RAW_BYTES) {
      throw new HttpsError(
        "invalid-argument",
        `That file is ${Math.round(data.size_bytes / 1048576)} MB. The limit is 60 MB.`,
      );
    }
    const path = `users/${uid}/geometries/${ref.id}/raw.${data.ext}`;
    await ref.set({
      user_id: uid,
      group_id: data.group_id ?? null,
      name: data.name,
      format: FORMAT_OF[data.ext],
      input_unit: data.input_unit ?? "mm",
      import_options: {
        facet_split: data.import_options?.facet_split ?? true,
        sewing: data.import_options?.sewing ?? true,
        improve: data.import_options?.improve ?? true,
      },
      raw_path: path,
      size_bytes: data.size_bytes,
      // Nothing has been uploaded yet. onGeometryUploaded moves this on when
      // the bytes land, and processGeometry moves it again; a client cannot
      // set any of them, so "ready" always means the service said so.
      status: "uploading",
      // Only on a new geometry.
      //
      // Called with an existing geometry_id, this merged `versions: {}` and
      // `current_version: 0` over the document, so re-uploading a raw file to a
      // car that had already been prepared erased every version it had: the
      // tunnels, the face lists, the STEP paths. The storage objects survived
      // with nothing pointing at them, and any run pinned to a version failed
      // when the worker could not find its face list.
      ...(data.geometry_id ? {} : { current_version: 0, versions: {} }),
      error: null,
      prepared_by: "workbench",
      ...(data.geometry_id ? {} : { created_at: FieldValue.serverTimestamp() }),
      updated_at: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { geometry_id: ref.id, path, max_bytes: MAX_RAW_BYTES };
  }

  const path = `users/${uid}/geometries/${ref.id}/${FILENAME[data.kind]}`;
  const pathField = data.kind === "step" ? { step_path: path } : { label_path: path };

  await ref.set({
    user_id: uid,
    group_id: data.group_id ?? null,
    name: data.name,
    // Recorded server-side so the client cannot later claim a different path
    // was agreed, and so submitJob can resolve paths without trusting input.
    ...pathField,
    size_bytes: data.size_bytes,
    ...(data.geometry_id ? {} : { created_at: FieldValue.serverTimestamp() }),
  }, { merge: true });

  return { geometry_id: ref.id, path, max_bytes: MAX_UPLOAD_BYTES };
});
