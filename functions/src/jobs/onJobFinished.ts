// Mirror a job's ending onto its run, and tell the user about it.
//
// The worker writes both documents as it goes (spec_mode.make_stage_writer), so
// while a run is progressing the two agree. The gap is every ending that happens
// *without* the worker: onJobPending refusing a job, a dispatch that never
// started a container, a container that died before its first write. In all of
// those the job says "failed" and the run is left on whatever it last said,
// which is "queued".
//
// Found on 11 Sep 2026 by running a real car: the worker image was older than
// the code and exited immediately, the job went to failed, and the Workbench
// went on showing "Queued" with the job-status chip counting it as running. A
// run that can never finish and never says so is worse than a run that fails,
// because the only way out is a page reload that changes nothing.
//
// This trigger is the backstop. It only ever writes a run that is not already
// in a terminal state, so it cannot fight the worker: whoever gets there first
// wins, and the worker is more specific.
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../lib/admin";
import { COL } from "../lib/config";

/** What a run looks like once nothing more will happen to it. */
const TERMINAL_RUN = new Set(["finished", "failed", "cancelled"]);

/** Job ending -> run ending. Anything not here is still in flight. */
const ENDINGS: Record<string, "finished" | "failed" | "cancelled"> = {
  complete: "finished",
  failed: "failed",
  cancelled: "cancelled",
};

/** What the run panel shows under the name. */
const STAGE_TEXT: Record<string, string> = {
  finished: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const onJobFinished = onDocumentWritten("jobs/{jobId}", async (event) => {
  const before = event.data?.before.data();
  const after = event.data?.after.data();
  if (!after) return;

  const ending = ENDINGS[String(after.status ?? "")];
  if (!ending) return;
  if (before && before.status === after.status) return;   // not a transition

  const runId = after.run_ref;
  if (!runId || typeof runId !== "string") return;        // Fusion jobs have no run document

  const runRef = db.collection(COL.runs).doc(runId);

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(runRef);
    if (!snap.exists) return;
    const current = String(snap.get("status") ?? "");
    if (TERMINAL_RUN.has(current)) return;                // the worker already said so

    txn.update(runRef, {
      status: ending,
      stage_text: STAGE_TEXT[ending],
      ...(ending === "failed" && after.error ? { error: String(after.error).slice(0, 2000) } : {}),
      ...(ending === "finished" ? { progress: 1 } : {}),
      finished_at: FieldValue.serverTimestamp(),
    });
    logger.info(`run ${runId}: ${current} -> ${ending} (job ${event.params.jobId})`);
  });

  // ── tell the user ───────────────────────────────────────────────────────
  // Capped at 50 and newest first, because this list is read on every page
  // load and an uncapped array grows until the document stops loading.
  const uid = after.user_id;
  if (!uid || typeof uid !== "string") return;
  const runSnap = await runRef.get();
  const name = String(runSnap.get("name") ?? "A run");
  const text = ending === "finished" ? `${name} finished.`
    : ending === "cancelled" ? `${name} was cancelled.`
    : `${name} failed: ${String(after.error ?? "no reason given").slice(0, 160)}`;

  const userRef = db.collection(COL.users).doc(uid);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(userRef);
    if (!snap.exists) return;
    const list = Array.isArray(snap.get("notifications")) ? snap.get("notifications") : [];
    const next = [{
      type: ending, text, run_id: runId, job_id: event.params.jobId,
      at: Date.now(), read: false,
    }, ...list].slice(0, 50);
    txn.update(userRef, { notifications: next });
  });
});
