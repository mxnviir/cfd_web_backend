// SUBMIT: send a charged job's STEP to SimScale and start its import.
//
// Called by the ops router straight after queueRun charges, and by POLL for
// any charged job nobody started. Answers at once and does the work in the
// background; private.submit_claim makes sure only one caller does it.
import { json, isInternal } from "../_shared/core.ts";
import { submit } from "../_shared/pipeline.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (!(await isInternal(req))) return json({ error: "unauthorized" }, 401);
  const { job_id } = await req.json().catch(() => ({}));
  if (typeof job_id !== "string") return json({ error: "job_id is required" }, 400);
  EdgeRuntime.waitUntil(submit(job_id).then((r) => console.log(`submit ${job_id}: ${r}`)));
  return json({ accepted: job_id }, 202);
});
