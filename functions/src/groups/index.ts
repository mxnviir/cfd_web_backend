// Groups. Build spec 14.1, rewritten 12 Sep 2026.
//
// One container, not two. The old shape was a project that held geometries and
// simulations, inside a folder that held projects - SimScale's arrangement,
// for a product where a simulation is one car in one wind tunnel. In practice
// a project was one simulation wearing a folder.
//
// A group holds as many simulations as you want and there is nothing above it.
// The folders collection is gone.
//
// Database records only: nothing runs, nothing is charged, the solver is not
// involved. The two that need care are delete and copy, because both touch
// Storage as well as Firestore and both can leave a mess behind if they stop
// halfway.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { db, auth, bucket } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import {
  createGroupSchema, updateGroupSchema, groupIdSchema, copyGroupSchema,
  shareGroupSchema, unshareGroupSchema,
  DEFAULT_CATEGORY,
} from "./schemas";

/** Firestore refuses a batch over 500 writes; 400 leaves room for the parent. */
const BATCH = 400;

/** Statuses that mean SimScale is still doing something we paid for. */
const BUSY = ["queued", "uploading", "importing", "checking", "meshing", "running", "downloading"];

async function mustOwn(uid: string, groupId: string) {
  const ref = db.collection(COL.groups).doc(groupId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "That group does not exist.");
  if (snap.get("user_id") !== uid) {
    // Deliberately the same message as not-found: telling a stranger that a
    // group exists but is not theirs is telling them something.
    throw new HttpsError("not-found", "That group does not exist.");
  }
  return { ref, snap };
}

const stamps = (uid: string) => ({
  user_id: uid,
  created_at: FieldValue.serverTimestamp(),
  updated_at: FieldValue.serverTimestamp(),
});

// ── create ───────────────────────────────────────────────────────────────────
export const createGroup = onCall(async (request) => {
  const { uid, data } = await guard(request, "createGroup", createGroupSchema);
  const ref = db.collection(COL.groups).doc();
  await ref.set({
    ...stamps(uid),
    name: data.name,
    description: data.description ?? "",
    category: data.category ?? DEFAULT_CATEGORY,
    tags: data.tags ?? [],
    unit_system: data.unit_system ?? "SI",
    thumbnail_path: null,
    shared_with: {},
    counts: { geometries: 0, simulations: 0, runs: 0 },
});
  return { group_id: ref.id };
});

// ── update ───────────────────────────────────────────────────────────────────
export const updateGroup = onCall(async (request) => {
  const { uid, data } = await guard(request, "updateGroup", updateGroupSchema);
  const { ref } = await mustOwn(uid, data.group_id);
  const patch: Record<string, unknown> = { updated_at: FieldValue.serverTimestamp() };
  for (const k of ["name", "description", "category", "tags", "unit_system"] as const) {
    if (data[k] !== undefined) patch[k] = data[k];
  }
  await ref.update(patch);
  return { ok: true };
});

// ── delete ───────────────────────────────────────────────────────────────────
/** Every child of a group, so delete and copy agree on what a group is. */
async function childrenOf(groupId: string) {
  const [geoms, sims, runs] = await Promise.all([
    db.collection(COL.geometries).where("group_id", "==", groupId).get(),
    db.collection(COL.simulations).where("group_id", "==", groupId).get(),
    db.collection(COL.runs).where("group_id", "==", groupId).get(),
  ]);
  return { geoms, sims, runs };
}

async function deleteInBatches(refs: FirebaseFirestore.DocumentReference[]) {
  for (let i = 0; i < refs.length; i += BATCH) {
    const batch = db.batch();
    for (const ref of refs.slice(i, i + BATCH)) batch.delete(ref);
    await batch.commit();
  }
}

export const deleteGroup = onCall(async (request) => {
  const { uid, data } = await guard(request, "deleteGroup", groupIdSchema,
    { humanOnly: true });
  const { ref } = await mustOwn(uid, data.group_id);
  const { geoms, sims, runs } = await childrenOf(data.group_id);

  // A run that SimScale is still working on has been paid for. Deleting the
  // group would orphan it: the worker would keep going, finish, and write
  // results nobody can reach, having charged for them.
  const busy = runs.docs.filter((d) => BUSY.includes(String(d.get("status"))));
  if (busy.length) {
    throw new HttpsError(
      "failed-precondition",
      `Cancel running jobs first. ${busy.length} ${busy.length === 1 ? "run is" : "runs are"} still going.`,
    );
  }

  // Subcollections are not deleted with their parent, so they go first.
  const postStates: FirebaseFirestore.DocumentReference[] = [];
  for (const run of runs.docs) {
    const states = await run.ref.collection("post_states").get();
    postStates.push(...states.docs.map((d) => d.ref));
  }
  const selections: FirebaseFirestore.DocumentReference[] = [];
  for (const geom of geoms.docs) {
    const sel = await geom.ref.collection("selections").get();
    selections.push(...sel.docs.map((d) => d.ref));
  }

  await deleteInBatches([...postStates, ...selections]);
  await deleteInBatches([
    ...geoms.docs.map((d) => d.ref),
    ...sims.docs.map((d) => d.ref),
    ...runs.docs.map((d) => d.ref),
  ]);

  // Storage after Firestore. If this half fails, what is left is orphaned
  // bytes, which cost pennies and can be swept later. The other order leaves
  // documents pointing at files that no longer exist, which looks to a user
  // like the product has lost their work.
  const prefixes = [
    ...geoms.docs.map((d) => `users/${uid}/geometries/${d.id}/`),
    // Results moved under the owner so the Storage rules can check ownership
    // from the path. Both locations are swept: runs from before the move still
    // have their bytes at the old prefix.
    ...runs.docs.map((d) => `users/${uid}/results/${d.get("job_id") ?? d.id}/`),
    ...runs.docs.map((d) => `results/${d.get("job_id") ?? d.id}/`),
  ];
  for (const prefix of prefixes) {
    try {
      await bucket().deleteFiles({ prefix });
    } catch (err) {
      logger.warn(`could not clear ${prefix}`, err);
    }
  }

  await ref.delete();
  return { ok: true, deleted: { geometries: geoms.size, simulations: sims.size, runs: runs.size } };
});

// ── copy ─────────────────────────────────────────────────────────────────────
export const copyGroup = onCall({ timeoutSeconds: 300 }, async (request) => {
  const { uid, data } = await guard(request, "copyGroup", copyGroupSchema,
    { humanOnly: true });
  const { snap } = await mustOwn(uid, data.group_id);
  const { geoms, sims } = await childrenOf(data.group_id);

  const newGroup = db.collection(COL.groups).doc();
  const source = snap.data() as Record<string, unknown>;
  const batch = db.batch();
  batch.set(newGroup, {
    ...source,
    ...stamps(uid),
    name: data.name ?? `${source.name} copy`,
    // A copy is nobody else's until its owner shares it again, and it starts
    // with no runs, so the counts cannot be carried over either.
    shared_with: {},
    counts: { geometries: geoms.size, simulations: sims.size, runs: 0 },
});

  // Old id to new, so a simulation in the copy points at the copied geometry
  // rather than reaching back into the original.
  const geomIds = new Map<string, string>();
  const copies: Array<[string, string]> = [];
  for (const g of geoms.docs) {
    const ref = db.collection(COL.geometries).doc();
    geomIds.set(g.id, ref.id);
    const gd = g.data() as Record<string, unknown>;
    batch.set(ref, {
      ...gd,
      ...stamps(uid),
      group_id: newGroup.id,
      ...rewritePaths(gd, uid, g.id, ref.id),
});
    copies.push([g.id, ref.id]);
  }
  for (const s of sims.docs) {
    const ref = db.collection(COL.simulations).doc();
    const sd = s.data() as Record<string, unknown>;
    batch.set(ref, {
      ...sd,
      ...stamps(uid),
      group_id: newGroup.id,
      geometry_id: geomIds.get(String(sd.geometry_id)) ?? null,
      // A copy has never been validated or run.
      validation: null,
});
  }
  await batch.commit();

  // Server-side copy: the bytes never come to us and go back, which for a
  // 40 MB STEP is the difference between a second and a minute.
  for (const [oldId, newId] of copies) {
    const from = `users/${uid}/geometries/${oldId}/`;
    const [files] = await bucket().getFiles({ prefix: from });
    for (const file of files) {
      const dest = `users/${uid}/geometries/${newId}/${file.name.slice(from.length)}`;
      try {
        await file.copy(bucket().file(dest));
      } catch (err) {
        logger.warn(`could not copy ${file.name}`, err);
      }
    }
  }

  return { group_id: newGroup.id };
});

/** Path fields inside a geometry document, pointed at the copy's own prefix. */
function rewritePaths(doc: Record<string, unknown>, uid: string, oldId: string, newId: string) {
  const swap = (v: unknown) =>
    typeof v === "string" && v.includes(`/geometries/${oldId}/`)
      ? v.replace(`/geometries/${oldId}/`, `/geometries/${newId}/`)
      : v;
  const out: Record<string, unknown> = {};
  for (const key of ["raw_path", "step_path", "label_path", "glb_path", "source_step_path"]) {
    if (doc[key] !== undefined) out[key] = swap(doc[key]);
  }
  if (doc.versions && typeof doc.versions === "object") {
    const versions: Record<string, unknown> = {};
    for (const [n, v] of Object.entries(doc.versions as Record<string, Record<string, unknown>>)) {
      versions[n] = Object.fromEntries(Object.entries(v).map(([k, val]) => [k, swap(val)]));
    }
    out.versions = versions;
  }
  return out;
}

// ── sharing ──────────────────────────────────────────────────────────────────
export const shareGroup = onCall(async (request) => {
  const { uid, data } = await guard(request, "shareGroup", shareGroupSchema,
    { humanOnly: true });
  const { ref } = await mustOwn(uid, data.group_id);

  // An account-existence oracle, until now.
  //
  // "No TurboFlow account with that email" against a successful share told a
  // caller, sixty times an hour, whether any address they liked was registered
  // here. That is a list of this product's users, assembled from a competitor's
  // team sheet, and it leaks whether a particular teacher or student has an
  // account.
  //
  // What is left is what sharing cannot avoid: an address with no account
  // comes back `pending` and never appears in the share list, so the owner of
  // the group can tell. That is one answer per call, to a signed-in human who
  // owns a group, inside the shareGroup rate limit, rather than a cheap
  // lookup. The share dialog tells the owner in words (dialogs.jsx).
  let target;
  try {
    target = await auth.getUserByEmail(data.email);
  } catch {
    logger.info(`share to an address with no account, from ${uid}`);
    return { uid: null, email: data.email, permission: data.permission, pending: true };
  }
  if (target.uid === uid) {
    throw new HttpsError("invalid-argument", "That is your own account.");
  }
  await ref.update({
    [`shared_with.${target.uid}`]: data.permission,
    // The address the owner typed, kept beside the uid so the share dialog can
    // list "sam@school.org" rather than "vKMrDw909rvzMEwrXZ47". A client
    // cannot read another user's document to look it up, and it should not be
    // able to: the owner already knows this address because they typed it.
    [`shared_emails.${target.uid}`]: target.email ?? data.email,
    updated_at: FieldValue.serverTimestamp(),
});
  return { uid: target.uid, email: target.email ?? data.email, permission: data.permission };
});

export const unshareGroup = onCall(async (request) => {
  const { uid, data } = await guard(request, "shareGroup", unshareGroupSchema,
    { humanOnly: true });
  const { ref } = await mustOwn(uid, data.group_id);
  await ref.update({
    [`shared_with.${data.uid}`]: FieldValue.delete(),
    [`shared_emails.${data.uid}`]: FieldValue.delete(),
    updated_at: FieldValue.serverTimestamp(),
});
  return { ok: true };
});

// ── folders ──────────────────────────────────────────────────────────────────
