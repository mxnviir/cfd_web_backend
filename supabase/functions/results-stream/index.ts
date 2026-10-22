// RESULTS-STREAM: copy a finished run's results from SimScale into Storage.
//
// The plots are read (a few KB each); the solution field is streamed from
// SimScale to Storage chunk by chunk and never held. Called by POLL when a
// run finishes, and again by POLL if an attempt dies.
import { json, isInternal } from "../_shared/core.ts";
import { streamResults } from "../_shared/pipeline.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (!(await isInternal(req))) return json({ error: "unauthorized" }, 401);
  const { job_id } = await req.json().catch(() => ({}));
  if (typeof job_id !== "string") return json({ error: "job_id is required" }, 400);
  EdgeRuntime.waitUntil(streamResults(job_id)
    .then((r) => console.log(`results ${job_id}: ${r}`))
    .catch((err) => console.error(`results ${job_id}:`, err)));
  return json({ accepted: job_id }, 202);
});
