// A run must not be able to buy more compute than it paid for.
//
// queueRun prices a run from two fields - the end time out of the spec and the
// fineness out of the mesh spec - and clampRunParams caps both. Those capped
// numbers went onto the `jobs` document, where they decided the money and
// nothing else. The worker posts `spec_snapshot` and `mesh_snapshot` to
// SimScale verbatim, and those were the simulation document as it stood.
//
// A client writes that document. firestore.rules allows a direct update and
// checks only that `spec` has at most 30 top-level keys; the zod schemas are
// `.passthrough()` throughout and a direct write skips them anyway. So end time
// 200000 with fineness 9.0 was priced as 3000 iterations at level 1 - about 300
// credits - and solved 200000. Mesh refinements were worse: validateSetup never
// looks at them, so a SURFACE_CUSTOM_SIZING at fineness 10 over every face cost
// nothing at all.
//
// The half of this that matters most is the last block: an ordinary setup, the
// one autoSpec builds, has to come through untouched. A clamp that quietly
// coarsens every real run would be a worse bug than the one it fixes.
//
// Run: node tests/test_clamp_paid_run.mjs   (after npm run build:functions)
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const need = (p) => {
  const full = join(root, p);
  if (!existsSync(full)) {
    console.error(`\n  ${p} not found. Run: npm run build:functions`);
    process.exit(1);
  }
  return pathToFileURL(full).href;
};

const { clampToPaidRun, finenessCeiling } =
  await import(need("functions/lib/simulations/clamp.js"));
const { clampRunParams, FINENESS } = await import(need("functions/lib/lib/pricing.js"));
const { autoSpec, meshSpecFor } = await import(need("functions/lib/simulations/autoSpec.js"));
const { DEFAULT_MESH_SPEC } = await import(need("functions/lib/simulations/index.js"));

let checks = 0;
const failures = [];
const ok = (what, cond, detail) => {
  checks += 1;
  if (!cond) failures.push(detail ? `${what}\n     ${detail}` : what);
};
const eq = (what, a, b) => {
  checks += 1;
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) failures.push(`${what}\n     got      ${x}\n     expected ${y}`);
};

/** What queueRun works the price out from, given a setup. */
const priceOf = (spec, mesh, level) => clampRunParams({
  iteration_count: spec?.simulationControl?.endTime?.value,
  refine_level: level,
  inlet_velocity: 20,
});

// ── the attack, as it would be written ──────────────────────────────────────
const greedy = {
  simulationControl: {
    endTime: { value: 200000, unit: "s" },
    deltaT: { value: 1, unit: "s" },
    writeControl: { type: "TIME_STEP", writeInterval: 200000 },
    maxRunTime: { value: 4000000, unit: "s" },
  },
  boundaryConditions: [],
};
const greedyMesh = {
  type: "SIMMETRIX_MESHING_FLUID_V16",
  // Level 1, the cheapest rung on the ladder.
  sizing: { type: "AUTOMATIC_V9", fineness: 9.0 },
  refinements: [
    { type: "SURFACE_CUSTOM_SIZING", name: "everything", sizing: { fineness: 10 },
      topologicalReference: { faces: [1, 2, 3] } },
    { type: "SURFACE_CUSTOM_SIZING", name: "and again", sizing: { fineness: 9.9 },
      topologicalReference: { faces: [4] } },
  ],
  automaticLayerSettings: {
    type: "AUTOMATIC_LAYER_ON",
    layerType: { type: "FRACTIONAL_HEIGHT_2", numberOfLayers: 40, growthRate: 1.5 },
  },
  numOfProcessors: 96,
};

const params = priceOf(greedy, greedyMesh, 1);
eq("the price is worked out from 3000 iterations", params.iteration_count, 3000);

const cut = clampToPaidRun(greedy, greedyMesh, params);

eq("and the solver is asked for 3000, not 200000",
  cut.spec.simulationControl.endTime.value, 3000);
eq("the write interval comes down with it, or the solver writes nothing",
  cut.spec.simulationControl.writeControl.writeInterval, 3000);
ok("the run cannot hold a solver for six weeks",
  cut.spec.simulationControl.maxRunTime.value <= 21600,
  String(cut.spec.simulationControl.maxRunTime.value));

// Level 1 is 9.0 on the ladder, and a car surface is allowed half a rung over
// the tunnel it sits in - which is what autoSpec itself asks for.
eq("a refinement is cut to what level 1 paid for", finenessCeiling({ refine_level: 1 }), 9.5);
eq("the fineness-10 refinement comes down", cut.meshSpec.refinements[0].sizing.fineness, 9.5);
eq("and so does the 9.9 one", cut.meshSpec.refinements[1].sizing.fineness, 9.5);
eq("the refinement keeps everything else about it",
  cut.meshSpec.refinements[0].topologicalReference, { faces: [1, 2, 3] });
eq("forty boundary layers is not a car setup",
  cut.meshSpec.automaticLayerSettings.layerType.numberOfLayers, 10);
eq("nor is a 96-core machine", cut.meshSpec.numOfProcessors, -1);

ok("every cut is written down for the run panel",
  cut.notes.length >= 5, JSON.stringify(cut.notes));
ok("and the first one names the numbers",
  /200000/.test(cut.notes[0]) && /3000/.test(cut.notes[0]), cut.notes[0]);

// The document the user typed is theirs and is not edited under them.
eq("the simulation document is not modified",
  greedy.simulationControl.endTime.value, 200000);
eq("nor is its mesh spec", greedyMesh.refinements[0].sizing.fineness, 10);

// ── refinements as a way to make a huge mesh by volume ──────────────────────
const many = {
  sizing: { fineness: 9.0 },
  refinements: Array.from({ length: 500 }, (_, i) => ({
    type: "SURFACE_CUSTOM_SIZING", sizing: { fineness: 10 },
    topologicalReference: { faces: [i] },
  })),
};
const manyCut = clampToPaidRun({}, many, clampRunParams({ refine_level: 1 }));
ok("five hundred refinements is capped", manyCut.meshSpec.refinements.length === 60,
  String(manyCut.meshSpec.refinements.length));
ok("and the ones that survive are still cut to the priced fineness",
  manyCut.meshSpec.refinements.every((r) => r.sizing.fineness === 9.5));

// ── a fineness above SimScale's own ceiling ─────────────────────────────────
const over = clampToPaidRun({}, { sizing: { fineness: 40 } }, clampRunParams({ refine_level: 5 }));
eq("fineness above 10 is refused by SimScale, so it never leaves here",
  over.meshSpec.sizing.fineness, 10);

// ── nothing to clamp must not crash ────────────────────────────────────────
const empty = clampToPaidRun(null, null, clampRunParams({}));
eq("a null spec survives", empty.spec, null);
eq("a null mesh spec survives", empty.meshSpec, null);
eq("and nothing is claimed to have been cut", empty.notes, []);
const bare = clampToPaidRun({}, {}, clampRunParams({}));
eq("an empty setup is left alone", bare.notes, []);
const junk = clampToPaidRun(
  { simulationControl: { endTime: { value: "not a number" } } },
  { sizing: { fineness: null }, refinements: "not an array" },
  clampRunParams({}));
eq("a non-numeric end time is left for validateSetup to refuse",
  junk.spec.simulationControl.endTime.value, "not a number");
eq("and a refinements field that is not a list is left alone",
  junk.meshSpec.refinements, "not an array");

// ── the case that matters: an ordinary run is untouched ────────────────────
//
// If this fails, every real run is being quietly coarsened, which is a worse
// bug than the one this file exists to close.
const LABELS = {
  inlet: [0], outlet: [1], ground: [2], top: [3], side: [4], symmetry: [5],
  car_no_slip: [10, 11, 12],
};
const WHEELS = [{
  name: "Front left", radius_m: 0.0141, cx_m: 0.19, cy_m: 0.02, cz_m: 0.0141,
  face_indices: [20, 21],
}];

for (const [level, fineness] of Object.entries(FINENESS)) {
  const spec = autoSpec(LABELS, WHEELS, {
    speed: 20, iterations: 1000, frontalArea: 0.0041, referenceLength: 0.242,
  });
  const mesh = meshSpecFor(LABELS, WHEELS, fineness, DEFAULT_MESH_SPEC, [12]);
  const p = clampRunParams({
    iteration_count: spec.simulationControl.endTime.value,
    refine_level: Number(level),
    inlet_velocity: 20,
  });
  const c = clampToPaidRun(spec, mesh, p);
  eq(`an automatic setup at level ${level} is not cut at all`, c.notes, []);
  eq(`and comes through byte for byte at level ${level}`,
    JSON.stringify({ s: c.spec, m: c.meshSpec }), JSON.stringify({ s: spec, m: mesh }));
}

// The coarse rungs the sidebar offers below the priced ladder, which price as
// level 1 and must not be dragged up to it.
for (const coarse of [7.0, 8.0]) {
  const spec = autoSpec(LABELS, WHEELS, {
    speed: 20, iterations: 1000, frontalArea: 0.0041, referenceLength: 0.242,
  });
  const mesh = meshSpecFor(LABELS, WHEELS, coarse, DEFAULT_MESH_SPEC, [12]);
  const c = clampToPaidRun(spec, mesh, clampRunParams({
    iteration_count: 1000, refine_level: 1, inlet_velocity: 20,
  }));
  eq(`a draft mesh at ${coarse} is left where it was`, c.notes, []);
  eq(`and stays coarse at ${coarse}`, c.meshSpec.sizing.fineness, coarse);
}

console.log(failures.length ? "" : `ok  ${checks} checks`);
if (failures.length) {
  console.log(`\nFAIL  ${failures.length} of ${checks}\n`);
  for (const f of failures) console.log("   - " + f);
  process.exit(1);
}
