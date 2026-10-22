// Cancel a run and give back what was actually paid for it.
//
// This is the function the critical vulnerability lived in. The old version:
//
//     const amount = job.cost ?? 100;
//     txn.update(userRef, { credits: FieldValue.increment(amount) });
//     ...
//     txn.delete(jobRef);
//
// took the refund amount from a field the client wrote, and then deleted the
// document, removing the evidence. Firestore rules constrained only user_id and
// status on create, so `cost` could be anything.
//
// What changed:
//   - The amount comes from the ledger this backend wrote, never from the job.
//     A forged job has no charge row and refunds zero.
//   - The document is no longer deleted. It becomes cancelled or cancelling,
//     which also fixes the orphaned-storage problem: storage rules check that
//     the job document exists, so deleting it left files nobody could remove.
//   - The branch is on status, not on whether a simulation id happens to be
//     present. simulation_id is not written until meshing, but the worker starts
//     at downloading — so the old code deleted documents the worker was actively
//     running, and the run kept burning SimScale compute with nothing left to
//     record it against.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { db } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { refundJobSchema } from "../lib/schema";
import { readJobLedger, writeRefund } from "../lib/ledger";
import type { JobStatus } from "../lib/types";

/** Not picked up by the worker yet — nothing to wind down, so it stops here. */
const NOT_STARTED: readonly JobStatus[] = ["draft", "pending"];

/**
 * The worker holds it, but no solver iterations have run. Refundable, and the
 * document goes to `cancelling` so the worker sees it and shuts SimScale down
 * cleanly instead of being orphaned mid-run.
 */
const IN_SETUP: readonly JobStatus[] = [
  "downloading", "uploading_geometry", "processing", "creating_simulation", "meshing",
];

export const refundJob = onCall(async (request) => {
  const { uid, data } = await guard(request, "refundJob", refundJobSchema);
  const jobId = data.job_id;
  const jobRef = db.collection(COL.jobs).doc(jobId);

  return await db.runTransaction(async (txn) => {
    // Reads first, always — a transaction that reads after a write is rejected
    // at commit, which surfaces as a confusing generic failure.
    const jobSnap = await txn.get(jobRef);
    if (!jobSnap.exists) throw new HttpsError("not-found", "That job does not exist.");

    const job = jobSnap.data() as { user_id?: string; status?: JobStatus };
    if (job.user_id !== uid) {
      throw new HttpsError("permission-denied", "That job is not yours.");
    }

    const status = job.status as JobStatus;
    const notStarted = NOT_STARTED.includes(status);
    const inSetup = IN_SETUP.includes(status);
    if (!notStarted && !inSetup) {
      throw new HttpsError(
        "failed-precondition",
        `A job that is ${status} cannot be cancelled for a refund.`,
      );
    }

    const ledger = await readJobLedger(db, txn, uid, jobId);

    // The whole point of this function. `outstanding` is charges this backend
    // recorded minus refunds already given — not anything the client wrote. A
    // job that was never charged refunds zero, and calling twice refunds zero
    // the second time.
    const amount = ledger.outstanding;

    if (amount > 0) {
      writeRefund(db, txn, uid, jobId, amount, "Simulation cancelled");
    }

    txn.update(jobRef, {
      status: notStarted ? "cancelled" : "cancelling",
      cancelled_by: uid,
    });

    return { refunded: amount, status: notStarted ? "cancelled" : "cancelling" };
  });
});
