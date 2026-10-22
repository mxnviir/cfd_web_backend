// Queueing, cancelling and refunding a run, and filing its viewer files.
//
// queueRun is the one place a run is paid for. It writes the run and the job
// and calls private.charge_job inside one transaction, so a run is never
// created without its charge and never charged without its run: a short
// balance rolls the whole thing back. Starting the work is SUBMIT's, called
// once the charge has committed; POLL starts any job that call missed.
import {
  sql, OpsError, overRateLimit, callFunction, objectExists, firstBytes, readJson, storageUid,
  jsonb,
} from "../_shared/core.ts";
import { clampRunParams, listPrice } from "../_shared/logic/pricing.ts";
import { levelForFineness, inletSpeed } from "../_shared/logic/setup.ts";
import { clampToPaidRun } from "../_shared/logic/clamp.ts";
import { checkSimulation } from "./simulations.ts";
import type { Ctx } from "./index.ts";

/** Owner, or a collaborator with edit. */
async function mayRunIn(uid: string, ownerId: string, groupId: string | null) {
  if (ownerId === uid) return;
  const [g] = groupId ? await sql`select user_id, shared_with from public.groups where id = ${groupId}` : [];
  if (!g || (g.user_id !== uid && (g.shared_with ?? {})[uid] !== "edit")) {
    throw new OpsError("permission-denied", "You cannot start a run in this project.");
  }
}

export async function queueRun({ caller, data }: Ctx) {
  const [sim] = await sql`select * from public.simulations where id = ${data.simulation_id}`;
  if (!sim) throw new OpsError("not-found", "No such simulation.");
  await mayRunIn(caller.uid, sim.user_id, sim.group_id);

  // Queueing spends the owner's credits. A collaborator gets a ceiling on how
  // often; the owner's own hourly limit applies on top.
  const owner = sim.user_id as string;
  if (owner !== caller.uid && await overRateLimit(`${owner}:${caller.uid}`, "collaboratorRun")) {
    throw new OpsError("resource-exhausted",
      "You have queued several runs on this group recently. Runs here are paid for by the group's owner, "
      + "so there is a limit on how many a collaborator can start in an hour. Try again later.");
  }
  if (await overRateLimit(owner, "runJob")) {
    throw new OpsError("resource-exhausted", "Too many runs queued in the last hour. Wait a little and try again.");
  }

  // Checked now rather than trusting the stored verdict, which a trigger
  // writes a moment after an edit.
  const validation = await checkSimulation({ geometry_id: sim.geometry_id, spec: sim.spec, mesh_spec: sim.mesh_spec });
  if (!validation.ok) {
    throw new OpsError("failed-precondition", `This setup cannot run yet. ${validation.errors.join(" ")}`);
  }

  const [geo] = await sql`select current_version, versions from public.geometries where id = ${sim.geometry_id}`;
  const version = Number(geo?.current_version ?? 0);
  const versionDoc = (geo?.versions ?? {})[String(version)] ?? {};
  if (!versionDoc.step_path) {
    throw new OpsError("failed-precondition", "This geometry has no STEP to send to the solver. Upload it again.");
  }

  const params = clampRunParams({
    iteration_count: sim.spec?.simulationControl?.endTime?.value,
    refine_level: levelForFineness(sim.mesh_spec?.sizing?.fineness ?? 5),
    inlet_velocity: inletSpeed(sim.spec),
  });
  // What SimScale is sent, cut to the run that was priced (simulations/clamp.ts).
  const paid = clampToPaidRun(sim.spec, sim.mesh_spec, params);

  const [{ count }] = await sql`select count(*)::int as count from public.runs where simulation_id = ${sim.id}`;
  const name = data.name ?? `Run ${count + 1}`;

  const { runId, jobId, price } = await sql.begin(async (tx) => {
    const [ids] = await tx`select public.gen_id() as run_id, public.gen_id() as job_id`;
    await tx`
      insert into public.runs (id, user_id, group_id, simulation_id, simulation_name, geometry_id, geometry_version,
                               name, kind, status, stage_text, progress, queued_by, job_id,
                               spec_snapshot, mesh_snapshot, clamped)
      values (${ids.run_id}, ${owner}, ${sim.group_id}, ${sim.id}, ${sim.name}, ${sim.geometry_id}, ${version},
              ${name}, 'run', 'queued', 'Queued', 0, ${caller.uid}, ${ids.job_id},
              ${jsonb(paid.spec)}, ${jsonb(paid.meshSpec)}, ${jsonb(paid.notes ?? [])})`;
    await tx`
      insert into public.jobs (id, user_id, group_id, geometry_id, simulation_ref, run_ref, source, spec_mode,
                               status, step_path, label_path, iteration_count, refine_level, inlet_velocity,
                               debug_mesh, mesh_cells_m, fineness, next_poll_at)
      values (${ids.job_id}, ${owner}, ${sim.group_id}, ${sim.geometry_id}, ${sim.id}, ${ids.run_id}, 'workbench', true,
              'pending', ${versionDoc.step_path}, ${versionDoc.label_path ?? null}, ${params.iteration_count},
              ${params.refine_level}, ${params.inlet_velocity}, false, ${params.mesh_cells_m}, ${params.fineness},
              now() + interval '90 seconds')`;
    const [{ amount }] = await tx`select private.charge_job(${ids.job_id}) as amount`;
    await tx`update public.runs set credits = ${amount} where id = ${ids.run_id}`;
    return { runId: ids.run_id as string, jobId: ids.job_id as string, price: amount as number };
  });

  await callFunction("submit", { job_id: jobId }).catch((err) => console.warn(`submit ${jobId} not reached`, err));
  await notifyDiscord(jobId, price, params);
  return { run_id: runId, job_id: jobId, price, list_price: listPrice(params) };
}

/** The new-run ping, if a webhook is configured. Strings cut short. */
async function notifyDiscord(jobId: string, credits: number, params: { refine_level: number; iteration_count: number }) {
  const hook = Deno.env.get("DISCORD_WEBHOOK_URL") ?? "";
  if (!hook || ["unset", "REPLACE_ME"].includes(hook)) return;
  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: "New simulation job", color: 0x3b82f6, timestamp: new Date().toISOString(),
          fields: [
            { name: "Job", value: jobId.slice(0, 40), inline: true },
            { name: "Credits", value: String(credits), inline: true },
            { name: "Level", value: String(params.refine_level), inline: true },
            { name: "Iterations", value: String(params.iteration_count), inline: true },
          ],
        }],
      }),
    });
  } catch (err) {
    console.warn(`job ${jobId}: Discord ping failed`, err);
  }
}

export async function cancelRun({ caller, data }: Ctx) {
  const [result] = await sql`select private.cancel_run(${data.run_id}, ${caller.uid}) as r`;
  // A run the pipeline holds is wound down by the next POLL tick.
  return result.r;
}

export async function refundJob({ caller, data }: Ctx) {
  const [result] = await sql`select private.refund_job(${data.job_id}, ${caller.uid}) as r`;
  return result.r;
}

/**
 * File the viewer files the owner's browser made from a finished run's case
 * (the FINISH step). The browser can only have uploaded them to this job's
 * results folder, once, after the run completed (rls.may_upload); this
 * checks they are what they claim to be and points the run at them.
 */
export async function finishResults({ caller, data }: Ctx) {
  const [run] = await sql`select id, job_id, user_id from public.runs where id = ${data.run_id}`;
  if (!run || run.user_id !== caller.uid) {
    throw new OpsError("permission-denied", "Only the run's owner converts its results.");
  }
  const [job] = await sql`select id, status, case_path, results_glb_path from public.jobs where id = ${run.job_id}`;
  if (job?.status !== "complete" || !job.case_path) {
    throw new OpsError("failed-precondition", "This run has no results to convert.");
  }
  if (job.results_glb_path) return { ok: true, already: true };

  const dir = `users/${await storageUid(caller.uid)}/results/${job.id}`;
  const glb = `${dir}/results.glb`;
  if (!(await objectExists(glb)) || new TextDecoder("latin1").decode(await firstBytes(glb, 4)) !== "glTF") {
    throw new OpsError("failed-precondition", "The converted model did not arrive.");
  }
  const manifest = await readJson(`${dir}/fields.json`).catch(() => null);
  const fields: Record<string, any> = {};
  for (const [name, f] of Object.entries((manifest?.fields ?? {}) as Record<string, any>)) {
    // Only fields that point inside this run's own folder and exist.
    if (/^[A-Za-z]{1,40}$/.test(name) && f?.path === `${dir}/fields/${name}.bin` && await objectExists(f.path)) {
      fields[name] = {
        label: String(f.label ?? name).slice(0, 60), path: f.path,
        min: Number(f.min) || 0, max: Number(f.max) || 0,
      };
    }
  }
  await sql.begin(async (tx) => {
    await tx`update public.jobs set results_glb_path = ${glb}, results_fields = ${jsonb(fields)} where id = ${job.id}`;
    await tx`update public.runs set results_glb_path = ${glb}, results_fields = ${jsonb(fields)} where id = ${run.id}`;
  });
  return { ok: true, results_glb_path: glb, fields: Object.keys(fields) };
}
