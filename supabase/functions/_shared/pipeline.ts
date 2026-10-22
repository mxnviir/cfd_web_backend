// The run pipeline: what happens to a job between "charged" and "complete".
//
// The Cloud Run worker did all of this in one process that slept between
// SimScale polls. Here each step is short and stateless, and the job row is
// the state:
//
//   pending              charged; SUBMIT has not claimed it
//   uploading_geometry   SUBMIT is sending the STEP to SimScale
//   processing           SimScale is importing it        (POLL watches)
//   creating_simulation  map faces, create simulation and mesh operation
//   meshing              SimScale is meshing             (POLL watches)
//   checking             SimScale's setup check, then start the solver
//   running              SimScale is solving             (POLL watches)
//   downloading_results  RESULTS-STREAM is copying the results
//   complete | failed | cancelling -> cancelled
//
// Every status change is conditional on the status the step started from,
// so a cancel that lands mid-step wins: the step's write matches no row,
// and the next tick sees `cancelling`. SimScale's ids are recorded the
// moment they exist, unconditionally, so a cancel can always find what to
// stop.
import { sql, readJson, writeObject, objectStream, streamObject, storageUid, callFunction, jsonb } from "./core.ts";
import {
  api, type Api, SpecError, readableApiError, stepIdToNames, regionNames, resolveSpec,
  geometryImportError, firstErrorInEventLog, checkSetup, attachMesh, simscaleConfig,
  downloadUrlOf, exportPlots, wholeCar, summarise, flowDirection, symmetryFactor,
} from "./simscale.ts";

export type Job = Record<string, any> & { id: string; status: string; simscale: Record<string, any> };

/** How long a run may take before the pipeline gives up on it. */
const MAX_RUN_MS = 6 * 3600 * 1000;
/** Polls a SimScale operation may sit in READY before it counts as stuck. */
const READY_LIMIT = 8;
/** Seconds between status checks on a SimScale operation. */
export const POLL_EVERY_S = 15;

const PROGRESS: Record<string, number> = {
  uploading_geometry: 0.05, processing: 0.15, creating_simulation: 0.2,
  meshing: 0.25, checking: 0.48, running: 0.5, downloading_results: 0.9,
};

export async function loadJob(id: string): Promise<Job | null> {
  const [row] = await sql`select * from public.jobs where id = ${id}`;
  return (row as Job) ?? null;
}

/** Record SimScale ids on the job and run, whatever the status. */
export async function recordIds(job: Job, ids: Record<string, string | number>, jobCols: Record<string, unknown> = {}) {
  await sql`update public.jobs set simscale = simscale || ${jsonb(ids)} where id = ${job.id}`;
  if (Object.keys(jobCols).length) await sql`update public.jobs set ${sql(jobCols)} where id = ${job.id}`;
  if (job.run_ref) {
    await sql`update public.runs set simscale = simscale || ${jsonb(ids)} where id = ${job.run_ref}`;
  }
  Object.assign(job.simscale, ids);
}

/**
 * Move a job from one status to the next, and its run with it. Returns false
 * when the job was no longer at `from` - someone cancelled it.
 */
export async function advance(
  job: Job, from: string, to: string, text: string,
  opts: { progress?: number; pollInS?: number } = {},
): Promise<boolean> {
  const pollIn = opts.pollInS ?? POLL_EVERY_S;
  const ok = await sql.begin(async (tx) => {
    const rows = await tx`
      update public.jobs
         set status = ${to}::public.job_status,
             lease_until = null,
             ready_polls = 0,
             next_poll_at = now() + make_interval(secs => ${pollIn})
       where id = ${job.id} and status = ${from}::public.job_status
      returning id`;
    if (!rows.length) return false;
    if (job.run_ref) {
      await tx`
        update public.runs
           set status = ${to}, stage_text = ${text},
               progress = greatest(progress, ${opts.progress ?? PROGRESS[to] ?? 0}),
               started_at = coalesce(started_at, now())
         where id = ${job.run_ref} and status not in ('finished', 'failed', 'cancelled')`;
    }
    return true;
  });
  if (ok) job.status = to;
  return ok;
}

/** Progress inside one status: the run panel's "Meshing 43%". */
export async function report(job: Job, text: string, progress: number) {
  if (!job.run_ref) return;
  await sql`
    update public.runs set stage_text = ${text}, progress = greatest(progress, ${progress})
     where id = ${job.run_ref} and status = ${job.status}`;
}

export async function release(job: Job, afterS = POLL_EVERY_S) {
  await sql`select private.poll_release(${job.id}, ${afterS})`;
}

/** Fail the job. The database decides whether the charge goes back. */
export async function fail(job: Job, reason: string) {
  console.warn(`job ${job.id}: ${reason}`);
  await sql`select private.fail_job(${job.id}, ${reason})`;
}

/** Where this job's results live: under its owner's folder. */
async function resultsDir(job: Job): Promise<string> {
  return `users/${await storageUid(job.user_id)}/results/${job.id}`;
}

/** functions/.. owned_path: a job reads only files under its owner, or its own legacy folder. */
export function ownedPath(path: unknown, suid: string, jobId: string): path is string {
  if (typeof path !== "string" || !path || path.includes("..") || path.startsWith("/")) return false;
  return path.startsWith(`users/${suid}/`) || path.startsWith(`jobs/${jobId}/`);
}

async function runOf(job: Job) {
  const [run] = await sql`select * from public.runs where id = ${job.run_ref}`;
  return run as Record<string, any> | undefined;
}

async function versionOf(job: Job, run: Record<string, any>) {
  const [g] = await sql`select import_options, versions from public.geometries where id = ${job.geometry_id}`;
  const version = (g?.versions ?? {})[String(run?.geometry_version ?? 0)] ?? {};
  return { options: g?.import_options ?? {}, version };
}

/**
 * Keep one of SimScale's event logs beside the results, and say where on the
 * run: when a mesh fails, its reason is in this log and nowhere else.
 */
async function saveEventLog(job: Job, a: Api, path: string, key: "mesh" | "run"): Promise<void> {
  try {
    const resp = await a.get(path);
    if (!resp.ok) return;
    const dest = `${await resultsDir(job)}/logs/${key}.json`;
    await writeObject(dest, await resp.text(), "application/json");
    if (job.run_ref) {
      await sql`update public.runs set log_paths = log_paths || ${jsonb({ [key]: dest })} where id = ${job.run_ref}`;
    }
  } catch (err) {
    console.warn(`could not save the ${key} log`, err);
  }
}

// ── SUBMIT ───────────────────────────────────────────────────────────────────
/**
 * Send the STEP to SimScale and start its import. Claims the job first, so
 * exactly one caller does this however many times it is asked.
 */
export async function submit(jobId: string): Promise<string> {
  const [claimed] = await sql`select * from private.submit_claim(${jobId})`;
  if (!claimed) return "not claimable";
  const job = claimed as Job;
  try {
    const { missing } = simscaleConfig();
    if (missing.length) throw new SpecError(`The solver is not configured on this server (${missing.join(", ")}).`);
    if (!job.spec_mode) {
      throw new SpecError("This job has no Workbench setup. Runs are started from the Workbench.");
    }
    const run = await runOf(job);
    if (!run?.spec_snapshot) throw new SpecError("This run has no saved setup to send.");
    const suid = await storageUid(job.user_id);
    if (!ownedPath(job.step_path, suid, job.id)) {
      throw new SpecError("This run's geometry does not belong to its owner.");
    }
    const { options, version } = await versionOf(job, run);
    await report(job, "Uploading to the solver", 0.05);

    const a = api();
    const storage = await a.raw("POST", "/storage", { headers: { "Content-Type": "application/json" } });
    if (!storage.ok) throw new Error(`SimScale storage refused: ${storage.status}`);
    const { storageId, url } = await storage.json();
    // ponytail: the STEP is held in memory for the PUT, because SimScale's
    // presigned URL needs a Content-Length. Fine to the 60 MB a raw upload is
    // capped at; a much larger tunnel would want a streamed, sized PUT.
    const step = await objectStream(job.step_path);
    const bytes = new Uint8Array(await new Response(step.body).arrayBuffer());
    const put = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
    if (!put.ok) throw new Error(`SimScale upload refused: ${put.status}`);

    const imported = await a.post("geometryimports", {
      name: `tf-${job.id}`,
      location: { storageId },
      format: "STEP",
      // The version records the unit its STEP was written in; a wrong one
      // scales the car a thousand times.
      inputUnit: version.unit || "m",
      options: {
        facetSplit: Boolean(options.facet_split ?? false),
        sewing: Boolean(options.sewing ?? true),
        improve: Boolean(options.improve ?? true),
        optimizeForLBMSolver: false,
      },
    });
    if (!imported.ok) throw new SpecError("The solver would not import this geometry. " + readableApiError(await imported.text()));
    const { geometryImportId } = await imported.json();
    await recordIds(job, { geometry_import_id: geometryImportId });
    await advance(job, "uploading_geometry", "processing", "Reading the geometry", { progress: 0.12 });
    return "submitted";
  } catch (err) {
    await fail(job, err instanceof SpecError ? err.message : `Could not start the simulation: ${(err as Error).message}`);
    return "failed";
  }
}

// ── POLL: one step for one job ───────────────────────────────────────────────
export async function step(job: Job): Promise<void> {
  const a = api();
  const ids = job.simscale ?? {};

  if (job.status === "cancelling") return cancel(job, a);

  if (job.charged_at && Date.now() - new Date(job.charged_at).getTime() > MAX_RUN_MS) {
    return fail(job, `Gave up waiting at the ${job.status} stage after ${MAX_RUN_MS / 3600000}h. `
      + "The run may still be going in SimScale.");
  }

  switch (job.status) {
    case "pending":
      // Charged, and SUBMIT never claimed it: the router's call was lost.
      await callFunction("submit", { job_id: job.id }).catch(() => undefined);
      return release(job, 60);

    case "uploading_geometry":
      // SUBMIT holds this. Reaching it here means SUBMIT's lease ran out.
      if (ids.geometry_import_id) {
        await advance(job, "uploading_geometry", "processing", "Reading the geometry");
        return;
      }
      return fail(job, "Uploading to the solver did not finish.");

    case "processing": {
      const resp = await a.get(`geometryimports/${ids.geometry_import_id}`);
      if (!resp.ok) throw new Error(`geometry import could not be checked: ${resp.status}`);
      const body = await resp.json();
      const status = String(body.status ?? "").toUpperCase();
      if (status === "FINISHED") {
        await recordIds(job, { geometry_id: body.geometryId });
        await advance(job, "processing", "creating_simulation", "Sending the setup to the solver", { pollInS: 1 });
        return;
      }
      if (status === "FAILED" || status === "CANCELED") return fail(job, geometryImportError(body));
      return release(job);
    }

    case "creating_simulation":
      return createSimulation(job, a);

    case "meshing":
      return watch(job, a, `meshoperations/${ids.mesh_operation_id}`, "Meshing", 0.25, 0.5, async (body) => {
        const meshId = String(body.meshId ?? body.id ?? ids.mesh_operation_id);
        await recordIds(job, { mesh_id: meshId }, { mesh_id: meshId });
        await saveEventLog(job, a, `meshoperations/${ids.mesh_operation_id}/eventlog`, "mesh");
        // Meshing it is not the same as telling the simulation about it.
        await attachMesh(a, ids.simulation_id, meshId);
        const m = await a.get(`meshes/${meshId}`);
        if (m.ok && job.run_ref) {
          const mb = await m.json();
          await sql`update public.runs set mesh = ${jsonb({
            cell_count: mb.numberOfCells ?? null, node_count: mb.numberOfNodes ?? null, name: mb.name ?? null,
          })} where id = ${job.run_ref}`;
        }
        await advance(job, "meshing", "checking", "Checking the setup", { pollInS: 1 });
      });

    case "checking": {
      // Before the solver starts: a setup that cannot run stops here, where
      // only the mesh has been spent.
      await checkSetup(a, ids.simulation_id);
      const run = await runOf(job);
      const started = await a.post(`simulations/${ids.simulation_id}/runs`, { name: run?.name || `tf-${job.id}` });
      if (!started.ok) throw new SpecError("The solver would not start. " + readableApiError(await started.text()));
      const { runId } = await started.json();
      await recordIds(job, { run_id: runId }, { simscale_run_id: runId, simulation_id: ids.simulation_id });
      await a.post(`simulations/${ids.simulation_id}/runs/${runId}/start`, {});
      await advance(job, "checking", "running", "Running the solver");
      return;
    }

    case "running":
      return watch(job, a, `simulations/${ids.simulation_id}/runs/${ids.run_id}`, "Running", 0.5, 0.9, async () => {
        await saveEventLog(job, a, `simulations/${ids.simulation_id}/runs/${ids.run_id}/eventlog`, "run");
        const moved = await advance(job, "running", "downloading_results", "Downloading the results", { pollInS: 30 });
        if (moved) await callFunction("results-stream", { job_id: job.id }).catch(() => undefined);
      });

    case "downloading_results":
      // RESULTS-STREAM's lease ran out without finishing. Start it again; it
      // gives up on the case itself after a few attempts and finishes the
      // run with what it has.
      await callFunction("results-stream", { job_id: job.id }).catch(() => undefined);
      return release(job, 60);
  }
}

/** Map faces, create the simulation, create and start the mesh. */
async function createSimulation(job: Job, a: Api): Promise<void> {
  const ids = job.simscale;
  const run = await runOf(job);
  if (!run?.spec_snapshot) throw new SpecError("This run has no saved setup to send.");
  const { version } = await versionOf(job, run);
  if (!version.faces_path) throw new SpecError("This geometry has no face list, so the setup cannot be sent.");
  const facesJson = await readJson(version.faces_path);
  const map = await stepIdToNames(a, ids.geometry_id);
  const regions = await regionNames(a, ids.geometry_id);
  await writeObject(`${await resultsDir(job)}/simscale_map.json`,
    JSON.stringify({ faces: Object.fromEntries(map), regions }), "application/json");

  if (!ids.simulation_id) {
    const resolved = resolveSpec(structuredClone(run.spec_snapshot), facesJson, map, regions);
    const created = await a.post("simulations", {
      name: `tf-${job.id}`, geometryId: ids.geometry_id, model: resolved, version: "34.0",
    });
    if (!created.ok) {
      const text = await created.text();
      console.error("simulation refused:", text.slice(0, 1500));
      throw new SpecError("The solver would not accept this setup. " + readableApiError(text));
    }
    await recordIds(job, { simulation_id: (await created.json()).simulationId });
  }

  if (!ids.mesh_operation_id) {
    const meshBody = resolveSpec(structuredClone(run.mesh_snapshot ?? {}), facesJson, map, regions);
    // A mesh operation is versioned like a simulation; leaving it out is
    // refused with "invalid-schema-version". 10.0 is current.
    const created = await a.post("meshoperations", {
      name: `tf-mesh-${job.id}`, geometryId: ids.geometry_id, version: "10.0", model: meshBody,
    });
    if (!created.ok) {
      throw new SpecError("The mesher would not accept these settings. " + readableApiError(await created.text()));
    }
    await recordIds(job, { mesh_operation_id: (await created.json()).meshOperationId });
  }

  const started = await a.post(`meshoperations/${ids.mesh_operation_id}/start`, null, { simulationId: ids.simulation_id });
  if (!started.ok) throw new SpecError("The mesher would not start. " + readableApiError(await started.text()));
  await advance(job, "creating_simulation", "meshing", "Meshing");
}

/** One status check on a SimScale operation (poll_operation, one iteration of it). */
async function watch(
  job: Job, a: Api, path: string, label: "Meshing" | "Running", lo: number, hi: number,
  onFinished: (body: any) => Promise<void>,
): Promise<void> {
  const resp = await a.get(path);
  if (!resp.ok) throw new Error(`${label} could not be checked: ${(await resp.text()).slice(0, 200)}`);
  const body = await resp.json();
  const status = String(body.status ?? "").toUpperCase();
  const progress = Number(body.progress ?? 0);
  await report(job, `${label} ${Math.floor(progress * 100)}%`, lo + (hi - lo) * progress);

  if (status === "FINISHED") return onFinished(body);
  if (status === "FAILED") {
    const reason = await firstErrorInEventLog(a, `${path}/eventlog`);
    return fail(job, reason ? `${label} failed. ${reason}` : `${label} failed.`);
  }
  if (status === "CANCELED" || status === "CANCELLED") {
    // Stopped on SimScale's side. Ended as a cancel; no money moves.
    await sql`update public.jobs set status = 'cancelling' where id = ${job.id} and status = ${job.status}::public.job_status`;
    await sql`select private.finish_cancel(${job.id})`;
    return;
  }
  if (status === "READY") {
    const [row] = await sql`update public.jobs set ready_polls = ready_polls + 1 where id = ${job.id} returning ready_polls`;
    if (Number(row?.ready_polls) >= READY_LIMIT) {
      return fail(job, `${label} was created but never started. SimScale still reports it as READY, `
        + "which usually means the start request was accepted and ignored.");
    }
  } else {
    await sql`update public.jobs set ready_polls = 0 where id = ${job.id}`;
  }
  return release(job);
}

/** Wind SimScale down after a cancel. The refund was settled when it was asked for. */
async function cancel(job: Job, a: Api): Promise<void> {
  const ids = job.simscale ?? {};
  try {
    if (ids.run_id) {
      await a.post(`simulations/${ids.simulation_id}/runs/${ids.run_id}/cancel`, {});
    } else if (ids.mesh_operation_id && !ids.mesh_id) {
      await a.post(`meshoperations/${ids.mesh_operation_id}/cancel`, {});
    }
  } catch (err) {
    console.warn(`job ${job.id}: SimScale cancel failed`, err);
  }
  await sql`select private.finish_cancel(${job.id})`;
}

// ── RESULTS-STREAM ───────────────────────────────────────────────────────────
/** Attempts to wait for SimScale to attach files to a FINISHED run (~4 min). */
const LINK_WAIT_ATTEMPTS = 16;
/** Further attempts at the solution package before finishing without it. */
const CASE_ATTEMPTS = 3;
const MAX_PACKAGE_BYTES = 6 * 1024 ** 3;

/**
 * Copy a finished run's results into Storage: the plots read and summed
 * (they are a few KB), the solution field streamed chunk to chunk, never
 * held. Converting it for the viewer is the owner's browser's job.
 */
export async function streamResults(jobId: string): Promise<string> {
  const [claimed] = await sql`
    update public.jobs
       set lease_until = now() + interval '7 minutes', results_attempts = results_attempts + 1,
           next_poll_at = now() + interval '8 minutes'
     where id = ${jobId} and status = 'downloading_results'
       and (lease_until is null or lease_until < now())
    returning *`;
  if (!claimed) return "not claimable";
  const job = claimed as Job;
  const attempts = Number(job.results_attempts);
  const retryIn = (s: number) =>
    sql`update public.jobs set lease_until = null, next_poll_at = now() + make_interval(secs => ${s}) where id = ${job.id}`;
  const a = api();
  const ids = job.simscale;

  const list = await a.get(`simulations/${ids.simulation_id}/runs/${ids.run_id}/results`);
  const items: any[] = list.ok ? ((await list.json())._embedded ?? []) : [];
  // SimScale reports FINISHED before its files exist. Wait for the force plot.
  const ready = items.some((i) => i.category === "FORCE_PLOT" && downloadUrlOf(i));
  if (!ready && attempts < LINK_WAIT_ATTEMPTS) {
    await retryIn(15);
    return "waiting for SimScale to attach the results";
  }

  const run = await runOf(job);
  let plots: any = null;
  let summary: Record<string, any> = {};
  try {
    const factor = symmetryFactor(run?.spec_snapshot);
    plots = wholeCar(await exportPlots(a, items, flowDirection(run?.spec_snapshot)), factor);
    summary = summarise(plots);
    // Said on the run, so the panel can print "whole car, from a half model".
    if (Object.keys(summary).length && factor !== 1) summary.doubled = true;
  } catch (err) {
    console.warn(`job ${job.id}: plot export failed`, err);
  }

  let casePath: string | null = null;
  const solution = downloadUrlOf(items.find((i) => i.type === "SOLUTION_FIELD"));
  // Counted before the attempt, not after: an attempt the runtime kills for
  // its wall clock never reaches a catch, and must still count.
  const caseTries = Number(ids.case_tries ?? 0) + 1;
  if (solution && caseTries <= CASE_ATTEMPTS) {
    await recordIds(job, { case_tries: caseTries });
    try {
      const resp = await a.raw("GET", solution);
      if (!resp.ok || !resp.body) throw new Error(`solution download refused: ${resp.status}`);
      let seen = 0;
      const capped = resp.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          seen += chunk.byteLength;
          if (seen > MAX_PACKAGE_BYTES) ctl.error(new Error("the solution package is over 6 GB"));
          else ctl.enqueue(chunk);
        },
      }));
      casePath = `${await resultsDir(job)}/case.zip`;
      await streamObject(casePath, capped, "application/zip");
    } catch (err) {
      console.warn(`job ${job.id}: the case could not be kept`, err);
      casePath = null;
      if (caseTries < CASE_ATTEMPTS) {
        await retryIn(30);
        return "case download failed, will retry";
      }
    }
  }

  // Past this point the solve is done and paid for: a fault in reading the
  // results must not turn a finished run into a failed one.
  await sql`select private.complete_job(${job.id}, ${plots ? jsonb(plots) : null}, ${jsonb(summary)}, ${casePath})`;
  return "complete";
}
