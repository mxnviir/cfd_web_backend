// Cut a setup down to the run that was actually paid for.
//
// The hole this closes: a run is priced from two fields and the solver is sent
// the whole document.
//
// queueRun works out the charge with clampRunParams, which caps iterations at
// 3000 and the mesh level at 5. Those capped numbers go onto the `jobs`
// document, where they decide the money and nothing else. What SimScale
// receives is `spec_snapshot` and `mesh_snapshot` - the simulation document as
// it stands, uncapped - because run_spec_mode posts them verbatim, which is the
// whole point of spec mode: the panel showed it, so the solver gets it.
//
// And the client writes that document. firestore.rules allows a direct update
// with `mapOk(spec, 30)`, which counts top-level keys and never looks inside;
// saveSimulation's zod schemas are `.passthrough()` from top to bottom, and a
// direct write skips the callable anyway. So: set endTime to 200000, leave
// fineness at 9.0, pay for 3000 iterations at level 1, and get 200000. The same
// trick works through mesh refinements, which validateSetup does not read at
// all.
//
// So the snapshot is cut to size here, at queue time, before it is written. Not
// in the panel, which is a client, and not in the worker, which would mean the
// run document and the run disagreed.
//
// What is deliberately NOT clamped: the global mesh fineness. levelForFineness
// rounds *up* to the next priced rung, so a mesh asked for at 9.3 is charged as
// 9.5 - the fineness paid for is always at or above the fineness requested, and
// pulling it up to the rung would make the mesh finer than the person asked
// for. Everything below is a lever that costs compute and was priced at zero.
import { FINENESS, LIMITS, type RunParams } from "./pricing.ts";

/** How much finer than the tunnel a surface refinement may be. */
const REFINEMENT_HEADROOM = 0.5;
/** SimScale's own ceiling. Anything above is refused at spec validation. */
const MAX_FINENESS = 10;
/** More than this is not a car setup, it is an attempt to make a big mesh. */
const MAX_REFINEMENTS = 60;
/** Boundary layers. The add-in asks for 3; ten is already generous. */
const MAX_LAYERS = 10;
/**
 * Seconds of solver wall clock.
 *
 * autoSpec asks for max(20000, iterations * 20), which at the 3000-iteration
 * ceiling is 60000. Six hours is twice that and matches MAX_RUN_SECONDS on the
 * Cloud Run job, so the worker's own deadline is the thing that stops a run
 * rather than a number a client chose.
 */
const MAX_RUN_TIME_S = 21600;

export interface Clamped {
  spec: any;
  meshSpec: any;
  /** What was cut, in the words the run panel can show. Empty when nothing was. */
  notes: string[];
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The fineness this run paid for, plus the headroom a car surface is allowed. */
export function finenessCeiling(params: Pick<RunParams, "refine_level">): number {
  const priced = FINENESS[params.refine_level] ?? FINENESS[5] ?? MAX_FINENESS;
  return Math.min(MAX_FINENESS, priced + REFINEMENT_HEADROOM);
}

/**
 * The setup, cut to the run that was priced.
 *
 * Returns copies; the arguments are not touched, because the simulation
 * document keeps whatever the user typed and only the snapshot is trimmed.
 */
export function clampToPaidRun(spec: any, meshSpec: any, params: RunParams): Clamped {
  const notes: string[] = [];
  const out = spec && typeof spec === "object"
    ? JSON.parse(JSON.stringify(spec)) : spec;
  const mesh = meshSpec && typeof meshSpec === "object"
    ? JSON.parse(JSON.stringify(meshSpec)) : meshSpec;

  // ── how long the solver runs ────────────────────────────────────────────
  const control = out?.simulationControl;
  if (control && typeof control === "object") {
    const asked = num(control.endTime?.value);
    const paid = params.iteration_count;
    if (asked != null && asked > paid) {
      control.endTime = { ...control.endTime, value: paid };
      notes.push(`iterations cut from ${asked} to the ${paid} this run paid for`);
    }
    // One write at the end is what autoSpec asks for, and an interval past the
    // end time means the solver never writes at all - so it follows the
    // iterations down rather than being left stranded above them.
    const interval = num(control.writeControl?.writeInterval);
    const end = num(control.endTime?.value) ?? paid;
    if (interval != null && interval > end) {
      control.writeControl = { ...control.writeControl, writeInterval: end };
    }
    const runTime = num(control.maxRunTime?.value);
    if (runTime != null && runTime > MAX_RUN_TIME_S) {
      control.maxRunTime = { ...control.maxRunTime, value: MAX_RUN_TIME_S };
      notes.push(`maximum run time cut from ${runTime} s to ${MAX_RUN_TIME_S} s`);
    }
  }

  // ── how many cells the mesher is allowed to make ────────────────────────
  if (mesh && typeof mesh === "object") {
    const ceiling = finenessCeiling(params);

    const global = num(mesh.sizing?.fineness);
    if (global != null && global > MAX_FINENESS) {
      mesh.sizing = { ...mesh.sizing, fineness: MAX_FINENESS };
      notes.push(`mesh fineness cut from ${global} to ${MAX_FINENESS}`);
    }

    if (Array.isArray(mesh.refinements)) {
      if (mesh.refinements.length > MAX_REFINEMENTS) {
        notes.push(`${mesh.refinements.length} refinements cut to ${MAX_REFINEMENTS}`);
        mesh.refinements = mesh.refinements.slice(0, MAX_REFINEMENTS);
      }
      let pulled = 0;
      mesh.refinements = mesh.refinements.map((r: any) => {
        const f = num(r?.sizing?.fineness);
        if (f == null || f <= ceiling) return r;
        pulled += 1;
        return { ...r, sizing: { ...r.sizing, fineness: ceiling } };
      });
      if (pulled) {
        notes.push(
          `${pulled} mesh refinement${pulled === 1 ? "" : "s"} cut to ${ceiling}, `
          + "which is as fine as this run paid for",
        );
      }
    }

    const layers = num(mesh.automaticLayerSettings?.layerType?.numberOfLayers);
    if (layers != null && layers > MAX_LAYERS) {
      mesh.automaticLayerSettings = {
        ...mesh.automaticLayerSettings,
        layerType: { ...mesh.automaticLayerSettings.layerType, numberOfLayers: MAX_LAYERS },
      };
      notes.push(`boundary layers cut from ${layers} to ${MAX_LAYERS}`);
    }

    // -1 is "let SimScale decide" and is what everything here sends. A number
    // above the plan's cap fails the mesh outright ("the selected number of
    // cores are not available in your current plan"), and a large one is a way
    // to ask for a machine the run did not pay for.
    const cores = num(mesh.numOfProcessors);
    if (cores != null && cores !== -1 && (cores < 1 || cores > 8)) {
      mesh.numOfProcessors = -1;
      notes.push("processor count returned to automatic");
    }
  }

  return { spec: out, meshSpec: mesh, notes };
}

/** The iteration count a spec asks for, before any clamping. */
export function iterationsIn(spec: any): number {
  return num(spec?.simulationControl?.endTime?.value) ?? LIMITS.iterations.default;
}
