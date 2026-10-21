// Ask a run to stop. Build spec 14.9.
//
// This does not stop anything itself. It writes "cancelling" on the job, and
// the worker notices at its next poll and winds SimScale down properly.
// Killing the Cloud Run task instead would leave a mesh operation running on
// SimScale that nobody is watching and that still bills.
//
// Whether the credits come back is not decided here either. refundJob and
// onJobPending draw the same line: a run that never reached the solver costs
// nothing, and past that point it really did consume compute.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";

export const cancelRunSchema = z.object({
  run_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

/** The statuses it makes sense to ask to stop. */
const STOPPABLE = [
  "queued", "pending", "downloading", "uploading_geometry", "processing",
  "checking", "meshing", "running", "downloading_results",
];

export const cancelRun = onCall(async (request) => {
  const { uid, data } = await guard(request, "refundJob", cancelRunSchema);

  const runRef = db.collection(COL.runs).doc(data.run_id);
  const run = await runRef.get();
  if (!run.exists) throw new HttpsError("not-found", "No such run.");
  if (run.get("user_id") !== uid) {
    const project = await db.collection(COL.groups).doc(run.get("group_id")).get();
    if (!project.exists || (project.get("user_id") !== uid
      && (project.get("shared_with") ?? {})[uid] !== "edit")) {
      throw new HttpsError("permission-denied", "That run is not yours to cancel.");
    }
  }

  const status = String(run.get("status") ?? "");
  if (!STOPPABLE.includes(status)) {
    throw new HttpsError(
      "failed-precondition",
      status === "cancelled" ? "That run is already cancelled."
        : `That run is ${status} and cannot be stopped.`,
    );
  }

  const jobId = run.get("job_id");
  if (jobId) {
    // The worker polls this. It is the only signal that reaches a task
    // already running inside Cloud Run.
    await db.collection(COL.jobs).doc(jobId).update({
      status: "cancelling",
      updated_at: FieldValue.serverTimestamp(),
    });
  }
  await runRef.update({
    status: "cancelling",
    stage_text: "Stopping",
    updated_at: FieldValue.serverTimestamp(),
  });

  return { ok: true };
});
