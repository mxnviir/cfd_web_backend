// Creating a run from the web app or the Workbench.
//
// The old submitSimulationJob took the money at creation time and wrote
// status "queued". Nothing dispatched "queued" — onNewJob only acted on
// "pending" — so every web submission charged 100 credits and then sat there
// forever. That is fixed structurally rather than by changing the string:
// nothing here charges anything. A job is only paid for when it becomes
// runnable, and that single transition also starts the worker (see
// onJobPending.ts), so the two cannot come apart again.
//
// A job therefore arrives in one of two states:
//   draft   — no geometry attached yet. Free, and stays free.
//   pending — geometry is in place. Charged and dispatched by onJobPending.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { submitJobSchema, docId, assertSetupSize } from "../lib/schema";
import { clampRunParams } from "../lib/pricing";
import type { JobStatus } from "../lib/types";

export const submitJob = onCall(async (request) => {
  const { uid, data } = await guard(request, "submitJob", submitJobSchema);

  try {
    assertSetupSize(data.setup);
  } catch (err) {
    throw new HttpsError("invalid-argument", (err as Error).message);
  }

  // Where the geometry files live. Resolved from the geometry document rather
  // than accepted from the client, so a caller cannot point a job at a storage
  // path belonging to someone else.
  let stepPath: string | null = null;
  let labelPath: string | null = null;

  if (data.geometry_id) {
    const geomSnap = await db.collection(COL.geometries).doc(data.geometry_id).get();
    if (!geomSnap.exists) throw new HttpsError("not-found", "That geometry does not exist.");
    const geom = geomSnap.data() as { user_id?: string; step_path?: string; label_path?: string };
    if (geom.user_id !== uid) throw new HttpsError("permission-denied", "That geometry is not yours.");
    stepPath = geom.step_path ?? null;
    labelPath = geom.label_path ?? null;
  }

  // Without entity_labels.csv the worker finds no labelled faces and creates no
  // boundary conditions at all — the run completes and means nothing. Better to
  // hold the job as a draft than to charge for that.
  const ready = Boolean(stepPath && labelPath);
  const status: JobStatus = ready ? "pending" : "draft";

  const params = clampRunParams({
    iteration_count: data.iteration_count,
    refine_level: data.refine_level,
    inlet_velocity: data.inlet_velocity,
    debug_mesh: data.debug_mesh,
  });

  const ref = db.collection(COL.jobs).doc();
  await ref.set({
    user_id: uid,
    status,
    source: "web",
    group_id: data.group_id ?? null,
    simulation_ref: data.simulation_id ?? null,
    geometry_id: data.geometry_id ?? null,
    file_name: data.file_name ?? null,
    team_name: data.team_name ?? null,
    step_path: stepPath,
    label_path: labelPath,
    // A run is labelled with the conditions it actually ran under. Without this
    // snapshot, editing the simulation afterwards silently relabels every past
    // run and the compare table starts lying.
    setup_snapshot: data.setup ?? null,
    ...params,
    created_at: FieldValue.serverTimestamp(),
  });

  return { job_id: ref.id, status };
});

/**
 * Flip a draft to pending once its geometry is uploaded.
 *
 * This is the moment the account is charged and the worker starts — both happen
 * in onJobPending, off the status transition, not here.
 */
export const startJob = onCall(async (request) => {
  const { uid, data } = await guard(request, "submitJob", z.object({ job_id: docId }));
  const ref = db.collection(COL.jobs).doc(data.job_id);

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "That job does not exist.");

    const job = snap.data() as { user_id?: string; status?: JobStatus; step_path?: string; label_path?: string };
    if (job.user_id !== uid) throw new HttpsError("permission-denied", "That job is not yours.");
    if (job.status !== "draft") {
      throw new HttpsError("failed-precondition", `This job is already ${job.status}.`);
    }
    if (!job.step_path || !job.label_path) {
      throw new HttpsError(
        "failed-precondition",
        "This job needs both a STEP file and an entity_labels.csv before it can run.",
      );
    }
    txn.update(ref, { status: "pending" });
  });

  return { job_id: data.job_id, status: "pending" };
});
