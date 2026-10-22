// The poller's lock: two POLL ticks that overlap never get the same job.
//
//   node supabase/tests/lock.mjs
//
// Two real database connections. The first claims inside a transaction and
// holds it open, the way a tick is mid-claim when the next one starts; the
// second claims while those row locks are held. SKIP LOCKED must hand it
// different jobs, and once the first commits, its lease must keep a third
// tick off the same jobs. Then eight claims race at once, and every job must
// have gone to exactly one of them. (Eight, not more: the session pooler on a
// small plan holds only so many connections.)
//
// The jobs are made for the test and deleted after it. pg_cron's own tick is
// paused while it runs, so the only claimants are the test's; run it on its
// own, not alongside the pipeline test.
import postgres from "postgres";
import { dbUrl } from "./db.mjs";

const url = dbUrl();
const a = postgres(url, { max: 1, onnotice: () => {} });
const b = postgres(url, { max: 1, onnotice: () => {} });
const admin = postgres(url, { max: 4, onnotice: () => {} });

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
}

const tag = `lock${Date.now().toString(36)}`;
const [owner] = await admin`select id from public.users limit 1`;
if (!owner) throw new Error("No account to own the test jobs; run the seed.");

async function makeJobs(n) {
  const ids = Array.from({ length: n }, (_, i) => `${tag}_${i}_${Math.random().toString(36).slice(2, 6)}`);
  for (const id of ids) {
    // `processing` with a due poll: what a tick would pick up.
    await admin`insert into public.jobs (id, user_id, status, next_poll_at)
                values (${id}, ${owner.id}, 'processing', now() - interval '1 minute')`;
  }
  return ids;
}
const claimed = (rows) => rows.map((r) => r.id).filter((id) => id.startsWith(tag));

await admin`select cron.alter_job(jobid, active := false) from cron.job where jobname = 'turboflow-poll'`;
try {
  console.log("one tick mid-claim, another starting");
  const jobs = await makeJobs(6);
  let releaseFirst;
  const held = new Promise((r) => { releaseFirst = r; });
  let firstGot = [];
  const first = a.begin(async (tx) => {
    firstGot = claimed(await tx`select * from private.poll_claim(3, 60)`);
    await held;  // the transaction stays open, row locks held
  });
  while (!firstGot.length) await new Promise((r) => setTimeout(r, 50));
  const secondGot = claimed(await b`select * from private.poll_claim(10, 60)`);
  releaseFirst();
  await first;

  check("the first tick claims its batch", firstGot.length === 3, JSON.stringify(firstGot));
  check("the second tick, mid-way through the first, gets none of the same jobs",
    secondGot.every((id) => !firstGot.includes(id)), JSON.stringify(secondGot));
  check("...and takes the rest", secondGot.length === 3, JSON.stringify(secondGot));
  const thirdGot = claimed(await b`select * from private.poll_claim(10, 60)`);
  check("a third tick after both have committed finds every job leased", thirdGot.length === 0, JSON.stringify(thirdGot));

  console.log("eight ticks at once");
  const many = await makeJobs(24);
  const racers = Array.from({ length: 8 }, () => postgres(url, { max: 1, onnotice: () => {} }));
  const results = await Promise.all(racers.map((c) => c`select * from private.poll_claim(4, 60)`.then(claimed)));
  await Promise.all(racers.map((c) => c.end()));
  const all = results.flat().filter((id) => many.includes(id));
  check("no job claimed by two ticks", new Set(all).size === all.length,
    `${all.length} claims for ${new Set(all).size} jobs`);
  check("every job claimed by one", new Set(all).size === many.length, `${new Set(all).size} of ${many.length}`);

  console.log("SUBMIT's claim");
  const [s] = await makeJobs(1);
  await admin`update public.jobs set status = 'pending', charged_at = now() where id = ${s}`;
  const claims = await Promise.all(Array.from({ length: 8 }, () =>
    admin`select id from private.submit_claim(${s})`));
  check("eight simultaneous SUBMITs: exactly one starts the job", claims.filter((r) => r.length).length === 1);
  const [unpaid] = await makeJobs(1);
  await admin`update public.jobs set status = 'pending' where id = ${unpaid}`;
  check("SUBMIT will not start a job that was never charged",
    (await admin`select id from private.submit_claim(${unpaid})`).length === 0);
} catch (err) {
  failures.push(`crashed: ${err.message}`);
  console.error(err);
} finally {
  await admin`delete from public.jobs where id like ${tag + "%"}`;
  await admin`select cron.alter_job(jobid, active := true) from cron.job where jobname = 'turboflow-poll'`;
  await Promise.all([a.end(), b.end(), admin.end()]);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
