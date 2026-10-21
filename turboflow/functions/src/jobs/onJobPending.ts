// The one place a simulation is paid for and started.
//
// Three bugs in the old version are fixed by the shape of this file:
//
// 1. It fired on document *creation* and only dispatched when status was
//    exactly "pending". But submitSimulationJob wrote "queued", so web jobs were
//    charged 100 credits and then sat there forever — nothing ever ran them.
//    Charging and dispatch now both hang off the transition *into* pending, so
//    they cannot come apart: whatever route creates the job, the moment it
//    becomes runnable is the moment it is paid for and started.
//
// 2. If the Cloud Run dispatch failed, the credits had already been taken and
//    were never given back. The charge is now reversed on that path.
//
// 3. The Discord ping fired before any validation, with unbounded client
//    strings in it. It now runs after the job is known to be real, with the
//    strings cut short.
//
// Re-entry: this handler writes back to the document it is triggered by. That
// second write has pending both before and after, so the transition test below
// rejects it. Do not weaken that test to "after.status === 'pending'" — that
// version charges in a loop.
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "../lib/admin";
import { auth } from "../lib/admin";
import { COL, DISCORD_WEBHOOK_URL, secretValue } from "../lib/config";
import { clampRunParams, chargeFor } from "../lib/pricing";
import { readJobLedger, writeCharge, writeReversal } from "../lib/ledger";
import { snakeCasePatch, readField } from "../lib/normalize";
import { dispatchWorker } from "./dispatch";
import { overRateLimit } from "../lib/ratelimit";
import type { UserDoc } from "../lib/types";

const cut = (v: unknown, n = 80): string => String(v ?? "").slice(0, n) || "N/A";

export const onJobPending = onDocumentWritten(
  { document: "jobs/{jobId}", secrets: [DISCORD_WEBHOOK_URL] },
  async (event) => {
    const jobId = event.params.jobId;
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!after) return;
    const jobRef = db.collection(COL.jobs).doc(jobId);

    // ── a run that failed before it solved anything ───────────────────────
    // Dispatch succeeding is not the same as the work happening. The worker can
    // fail on its own — a missing SimScale key, a geometry SimScale will not
    // import, a bad entity_labels.csv — and until this existed the account had
    // still been charged for a run that produced nothing.
    //
    // The line is whether the solver actually ran. The worker writes mesh_id
    // when it moves to `running`, so a failure with no mesh_id means no compute
    // was spent and the whole charge goes back. Past that point the run really
    // did consume SimScale time, and refundJob draws the same line.
    if (after.status === "failed" && before?.status !== "failed") {
      const uid = readField<string>(after, "user_id");
      if (!uid) return;
      if (after.mesh_id || after.run_id) {
        logger.info(`job ${jobId}: failed after solving started — charge stands`);
        return;
      }
      let reversed = 0;
      await db.runTransaction(async (txn) => {
        const ledger = await readJobLedger(db, txn, uid, jobId);
        if (ledger.outstanding <= 0) return;
        reversed = ledger.outstanding;
        writeReversal(db, txn, uid, jobId, ledger.outstanding,
          "The simulation could not be run, so the charge was reversed");
        logger.info(`job ${jobId}: failed before solving, reversed ${ledger.outstanding}`);
      });
      // Say so on the run, not only in the ledger. The panel showed a failed
      // run beside "30 credits" in red, which reads as thirty credits gone,
      // and the balance was never touched.
      if (reversed > 0) {
        const runRef = readField<string>(after, "run_ref");
        if (runRef) {
          await db.collection(COL.runs).doc(runRef)
            .update({ refunded: reversed }).catch(() => undefined);
        }
      }
      return;
    }

    // ── a run becoming ready ──────────────────────────────────────────────
    const wasPending = before?.status === "pending";
    const isPending = after.status === "pending";
    if (!isPending || wasPending) return;

    // Fold any camelCase the Fusion add-in wrote into the snake_case schema
    // before anything reads the parameters, so there is one spelling from here on.
    const patch = snakeCasePatch(after, FieldValue.delete());

    // Where the job came from. A document written in camelCase came from a
    // Fusion add-in; the web app and the Workbench write snake_case. Worth
    // recording, because the two routes fail in different ways and support
    // questions start with "which one were you using?".
    const inferredSource = Object.keys(patch).length ? "fusion" : "web";

    if (Object.keys(patch).length) {
      await jobRef.update(patch);
      for (const [k, v] of Object.entries(patch)) {
        if (v === FieldValue.delete()) delete after[k];
        else after[k] = v;
      }
    }

    const fail = async (reason: string): Promise<void> => {
      logger.error(`job ${jobId}: ${reason}`);
      await jobRef.update({ status: "failed", error: reason });
    };

    // ── the job must belong to a real user ────────────────────────────────
    const uid = readField<string>(after, "user_id");
    if (!uid || typeof uid !== "string" || uid.length < 10) {
      await fail("Job has no valid user_id.");
      return;
    }
    try {
      await auth.getUser(uid);
    } catch {
      await fail("The user on this job does not exist.");
      return;
    }

    // ── rate limit ────────────────────────────────────────────────────────
    // Checked here rather than in submitJob because this is the path that is
    // actually used: the Workbench and the Fusion add-in both write the job
    // document straight to Firestore, so submitJob's limit never saw them.
    // Before the charge, so a caller in a loop is refused rather than billed.
    if (await overRateLimit(uid, "runJob")) {
      await fail("Too many runs queued in the last hour. Wait a little and try again.");
      return;
    }

    // ── charge ────────────────────────────────────────────────────────────
    const params = clampRunParams(after);
    let charged = 0;

    try {
      charged = await db.runTransaction(async (txn) => {
        // Every read first — Firestore rejects a transaction that reads after writing.
        const userSnap = await txn.get(db.collection(COL.users).doc(uid));
        const ledger = await readJobLedger(db, txn, uid, jobId);

        // Already paid for. Reaching here means a retry of an event we have
        // handled; charging again would bill twice for one run.
        if (ledger.charged > 0) return 0;

        if (!userSnap.exists) throw new Error("User account not found.");
        const user = userSnap.data() as UserDoc;

        const amount = chargeFor(user, params);
        const balance = Number(user.credits ?? 0);
        if (balance < amount) {
          throw new Error(`Not enough credits: you have ${balance}, this run costs ${amount}.`);
        }

        writeCharge(db, txn, uid, jobId, amount,
          `Simulation (level ${params.refine_level}, ${params.iteration_count} iterations${params.debug_mesh ? ", debug" : ""})`);

        // Stamp the values the worker will actually use. Anything the client
        // sent that disagrees with these is overwritten here, which is why the
        // clamping has to happen before the charge and not after.
        txn.update(jobRef, {
          ...params,
          cost: amount,
          user_id: uid,
          source: after.source ?? inferredSource,
          charged_at: FieldValue.serverTimestamp(),
        });
        return amount;
      });
    } catch (err) {
      await fail(err instanceof Error ? err.message : "Could not charge for this run.");
      return;
    }

    // ── start the worker ──────────────────────────────────────────────────
    try {
      // A Workbench run carries its own SimScale spec and the run document
      // the worker reports progress into. A Fusion job carries neither and
      // takes the worker's older path, which builds the model from the four
      // columns on the job.
      await dispatchWorker(jobId, readField<boolean>(after, "spec_mode")
        ? { SPEC_MODE: "1", RUN_ID: String(readField<string>(after, "run_ref") ?? "") }
        : {});
      logger.info(`job ${jobId}: charged ${charged}, worker started`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Could not start the worker.";
      // We took the money and cannot do the work. Give it back before failing —
      // the old code left the user out of pocket here.
      //
      // The ledger decides how much, not the `charged` variable. On a retry of
      // an event we have already handled, the charge transaction returns 0
      // because the row exists — but the account was still debited by the first
      // attempt, and gating the reversal on `charged > 0` would leave that debit
      // standing with nothing running against it.
      await db.runTransaction(async (txn) => {
        const ledger = await readJobLedger(db, txn, uid, jobId);
        if (ledger.outstanding <= 0) return;
        writeReversal(db, txn, uid, jobId, ledger.outstanding,
          "Could not start the simulation, so the charge was reversed");
      });
      await fail(`Could not start the simulation: ${reason}`);
      return;
    }

    // ── notify, only now that the job is known to be real ─────────────────
    const hook = secretValue(DISCORD_WEBHOOK_URL);
    if (hook) {
      try {
        await fetch(hook, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [{
              title: "New simulation job",
              color: 0x3b82f6,
              fields: [
                { name: "Job", value: cut(jobId, 40), inline: true },
                { name: "Team", value: cut(readField(after, "team_name")), inline: true },
                { name: "File", value: cut(readField(after, "file_name")), inline: true },
                { name: "Credits", value: String(charged), inline: true },
                { name: "Level", value: String(params.refine_level), inline: true },
                { name: "Iterations", value: String(params.iteration_count), inline: true },
              ],
              timestamp: new Date().toISOString(),
            }],
          }),
        });
      } catch (err) {
        logger.warn(`job ${jobId}: Discord ping failed: ${(err as Error).message}`);
      }
    }
  },
);
