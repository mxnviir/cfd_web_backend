// POLL: called by pg_cron once a minute (private.poll_tick).
//
// Claims the jobs that are due - FOR UPDATE SKIP LOCKED, with a lease, so an
// overlapping tick gets different jobs - and moves each one step. A step is
// one SimScale call, or the few it takes to cross from one status to the
// next, and every job is handed back to the schedule before the tick ends.
import { sql, json, isInternal } from "../_shared/core.ts";
import { step, fail, release, type Job } from "../_shared/pipeline.ts";
import { SpecError } from "../_shared/simscale.ts";

/** Jobs per tick, and how long a claimed job is held. */
const BATCH = 10;
const LEASE_S = 120;

Deno.serve(async (req) => {
  if (!(await isInternal(req))) return json({ error: "unauthorized" }, 401);

  const jobs = (await sql`select * from private.poll_claim(${BATCH}, ${LEASE_S})`) as unknown as Job[];
  const outcomes = await Promise.all(jobs.map(async (job) => {
    const from = job.status;
    try {
      await step(job);
      return { id: job.id, from, ok: true };
    } catch (err) {
      if (err instanceof SpecError) {
        await fail(job, err.message);
      } else {
        // Probably transient: SimScale or the network. Try again shortly;
        // the six-hour deadline in step() ends a job that never recovers.
        console.warn(`job ${job.id} (${from}): ${(err as Error).message}`);
        await release(job, 60);
      }
      return { id: job.id, from, ok: false, error: (err as Error).message };
    }
  }));
  return json({ claimed: outcomes });
});
