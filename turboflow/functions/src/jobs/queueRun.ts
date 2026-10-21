// Queue a run from the Workbench. Build spec 14.6.
//
// This function does not charge. It writes two documents: a `runs` record the
// Workbench watches, and a `jobs` record whose arrival at "pending" is what
// onJobPending charges for and dispatches. Keeping the money in one place is
// the whole reason: an earlier version of this backend charged in one
// function and dispatched in another, and web jobs were billed a hundred
// credits and then sat forever because nothing ran them.
//
// The refusal at the top is the other half of that. A setup with no inlet
// converges to still air and reports a drag of zero, which looks like an
// answer, and the team has paid for it. So a run whose validation is not ok
// is refused before any document is written and before any credit moves.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { db } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { overRateLimit } from "../lib/ratelimit";
import { clampRunParams, chargeFor, listPrice, FINENESS } from "../lib/pricing";
import { checkSimulation } from "../simulations";
import { clampToPaidRun } from "../simulations/clamp";
import type { UserDoc } from "../lib/types";

export const queueRunSchema = z.object({
  simulation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().trim().min(1).max(200).optional(),
});

/**
 * SimScale's 0 to 10 fineness back to the 1 to 5 level the worker prices on.
 *
 * The forward map lives in lib/pricing.ts as FINENESS and is the only place
 * the ladder is written down. Reading it backwards here keeps the two from
 * drifting: a new rung added there is priced correctly here without anyone
 * remembering to change this file.
 */
export function levelForFineness(fineness: number): number {
  const rungs = Object.entries(FINENESS)
    .map(([level, f]) => ({ level: Number(level), f: Number(f) }))
    .sort((a, b) => a.f - b.f);
  const hit = rungs.find((r) => fineness <= r.f + 1e-9);
  return hit ? hit.level : (rungs[rungs.length - 1]?.level ?? 3);
}

/** The inlet speed the worker needs, from the first velocity inlet. */
export function inletSpeed(spec: any): number {
  const inlet = (spec?.boundaryConditions ?? [])
    .find((b: any) => b?.type === "VELOCITY_INLET_V3");
  const v = inlet?.velocity?.value?.value;
  if (!v) return 0;
  return Math.hypot(v.x?.value ?? 0, v.y?.value ?? 0, v.z?.value ?? 0);
}

export const queueRun = onCall(async (request) => {
  const { uid, data } = await guard(request, "runJob", queueRunSchema);

  const simRef = db.collection(COL.simulations).doc(data.simulation_id);
  const sim = await simRef.get();
  if (!sim.exists) throw new HttpsError("not-found", "No such simulation.");

  // Only the owner, or a collaborator with edit. Queuing spends the owner's
  // credits, so "can view" is deliberately not enough.
  if (sim.get("user_id") !== uid) {
    const project = await db.collection(COL.groups).doc(sim.get("group_id")).get();
    if (!project.exists || (project.get("user_id") !== uid
      && (project.get("shared_with") ?? {})[uid] !== "edit")) {
      throw new HttpsError("permission-denied", "You cannot start a run in this project.");
    }
  }

  // How much of somebody else's balance one collaborator may spend.
  //
  // The permission check above is about whether they may queue at all. This is
  // about how often. Without it, "edit" on a shared group is a licence to
  // empty the owner's account at thirty runs an hour.
  const owner = sim.get("user_id") as string;
  if (owner !== uid && await overRateLimit(`${owner}:${uid}`, "collaboratorRun")) {
    throw new HttpsError(
      "resource-exhausted",
      "You have queued several runs on this group recently. Runs here are paid "
      + "for by the group's owner, so there is a limit on how many a "
      + "collaborator can start in an hour. Try again later.",
    );
  }

  const spec = sim.get("spec");
  const meshSpec = sim.get("mesh_spec");
  const geometryId = sim.get("geometry_id");

  // Checked here rather than trusting the stored validation. The stored one
  // is written by a trigger, and a run queued in the second between a bad
  // edit and the trigger catching up would otherwise go through.
  const validation = await checkSimulation({ geometry_id: geometryId, spec, mesh_spec: meshSpec });
  if (!validation.ok) {
    throw new HttpsError(
      "failed-precondition",
      `This setup cannot run yet. ${validation.errors.join(" ")}`,
    );
  }

  const geo = await db.collection(COL.geometries).doc(geometryId).get();
  const version = Number(geo.get("current_version") ?? 0);
  const stepPath = geo.get(`versions.${version}`)?.step_path;
  if (!stepPath) {
    throw new HttpsError(
      "failed-precondition",
      "This geometry has no STEP to send to the solver. Upload it again.",
    );
  }

  const params = clampRunParams({
    iteration_count: spec?.simulationControl?.endTime?.value,
    refine_level: levelForFineness(meshSpec?.sizing?.fineness ?? 5),
    inlet_velocity: inletSpeed(spec),
  });

  const user = (await db.collection(COL.users).doc(sim.get("user_id")).get()).data() as UserDoc | undefined;
  const price = chargeFor(user ?? {}, params);

  // The setup, cut to the run that was just priced.
  //
  // params is what the charge is worked out from, and until now it was also
  // the only thing capped: the snapshots below are what the worker actually
  // posts to SimScale, and they were whatever the simulation document said.
  // Since a client may write that document straight to Firestore, the two had
  // no relationship at all - 200,000 iterations could be bought for the price
  // of 3,000. See simulations/clamp.ts.
  const paid = clampToPaidRun(spec, meshSpec, params);

  const runRef = db.collection(COL.runs).doc();
  const jobRef = db.collection(COL.jobs).doc();

  // A count, not every document.
  //
  // This used to fetch every run of the simulation - each carrying a full spec
  // and mesh snapshot - to work out what number the next one is. On a
  // simulation with fifty runs that is fifty large documents read to produce
  // one integer, on every queue.
  const tally = await db.collection(COL.runs)
    .where("simulation_id", "==", data.simulation_id).count().get();
  const name = data.name ?? `Run ${tally.data().count + 1}`;

  await runRef.set({
    user_id: sim.get("user_id"),
    group_id: sim.get("group_id"),
    simulation_id: data.simulation_id,
    simulation_name: sim.get("name") ?? null,
    geometry_id: geometryId,
    geometry_version: version,
    name,
    kind: "run",
    status: "queued",
    stage_text: "Queued",
    progress: 0,
    credits: price,
    // Who pressed the button, which is not always who pays. Recorded so a
    // charge the owner did not make can be traced to the collaborator who did.
    queued_by: uid,
    job_id: jobRef.id,
    // The setup as it is now. A later edit to the simulation must not change
    // what this result was produced from, or a team compares two runs that
    // claim different settings and were solved with the same ones.
    spec_snapshot: paid.spec,
    mesh_snapshot: paid.meshSpec,
    // Said out loud rather than done quietly. A run that solves 3,000
    // iterations when the panel said 200,000 has to say so, or the next
    // question is why the result does not match the setup.
    clamped: paid.notes,
    simscale: {},
    created_at: FieldValue.serverTimestamp(),
  });

  await jobRef.set({
    user_id: sim.get("user_id"),
    group_id: sim.get("group_id"),
    geometry_id: geometryId,
    simulation_ref: data.simulation_id,
    run_ref: runRef.id,
    source: "workbench",
    spec_mode: true,
    status: "pending",
    step_path: stepPath,
    iteration_count: params.iteration_count,
    refine_level: params.refine_level,
    inlet_velocity: params.inlet_velocity,
    debug_mesh: false,
    created_at: FieldValue.serverTimestamp(),
  });

  return { run_id: runRef.id, job_id: jobRef.id, price, list_price: listPrice(params) };
});
