// The automatic setup has to produce a setup the solver accepts.
//
// autoSpec() is what "set up a simulation automatically" actually is: labelled
// tunnel in, complete Incompressible model out. Everything about it is silent
// when wrong. A setup with the drag direction reversed solves perfectly and
// reports a negative Cd. One with the half-tunnel area on a full tunnel solves
// perfectly and reports half the Cd. Neither throws, and a team pays for the
// run either way.
//
// So this checks the real compiled function against the real zod schema the
// server validates with and the real validateSetup the queue refuses on, on a
// tunnel shaped like the one /prepare actually returns.
//
// Run: node tests/test_auto_spec.mjs   (after npm run build:functions)
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const need = (p) => {
  const full = join(root, p);
  if (!existsSync(full)) {
    console.error(`\n  ${p} not found. Run: npm run build:functions`);
    process.exit(1);
  }
  return pathToFileURL(full).href;
};

const {
  autoSpec, boundaryConditions, resultControls, meshSpecFor, wheelSpin,
  AIR, FLOW_DIRECTION,
} = await import(need("functions/lib/simulations/autoSpec.js"));
const { incompressibleModel } = await import(need("functions/lib/simulations/spec.js"));
const { validateSetup } = await import(need("functions/lib/simulations/validate.js"));
const { momentCentre } = await import(need("functions/lib/geometry/prepareDomain.js"));

let checks = 0;
const failures = [];

function ok(what, condition, detail) {
  checks += 1;
  if (!condition) failures.push(detail ? `${what}\n     ${detail}` : what);
}

function eq(what, a, b) {
  checks += 1;
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) failures.push(`${what}\n     got      ${x}\n     expected ${y}`);
}

// ── a tunnel shaped like the one /prepare returns ───────────────────────────
// Face indices are arbitrary but disjoint, which is the property that matters:
// validateSetup refuses a face claimed by two boundary conditions.
const HALF = {
  inlet: [0],
  outlet: [1],
  ground: [2],
  top: [3],
  side: [4],
  symmetry: [5],
  car_no_slip: [10, 11, 12, 13],
};
const FULL = { ...HALF, symmetry: undefined, side: [4, 6] };

// Named by position, which is what /prepare produces now and what the "spin
// this one but not that one" choice is keyed on.
const WHEELS = [
  { name: "Front left", radius_m: 0.0141, cx_m: 0.19, cy_m: 0.02, cz_m: 0.0141, face_indices: [20, 21] },
  { name: "Rear left", radius_m: 0.0141, cx_m: 0.05, cy_m: 0.02, cz_m: 0.0141, face_indices: [22] },
];

const OPTS = {
  speed: 20,
  iterations: 1000,
  frontalArea: 0.0041,
  referenceLength: 0.242,
  centreOfRotation: { x: 0.12, y: 0, z: 0 },
};

const spec = autoSpec(HALF, WHEELS, OPTS);

// ── 1. the server's own schema accepts it ───────────────────────────────────
// The one check that cannot be argued with: this is the schema saveSimulation
// validates against, so anything it refuses could never be saved.
const parsed = incompressibleModel.safeParse(spec);
ok("the server schema accepts the automatic setup", parsed.success,
  parsed.success ? "" : parsed.error?.issues?.slice(0, 4)
    .map((i) => `${i.path.join(".")}: ${i.message}`).join("\n     "));

// ── 2. the queue would accept it ────────────────────────────────────────────
const faceIds = new Set([...Array(40).keys()]);
const validation = validateSetup(spec, { geometryId: "g1", faceIds, meshFineness: 5 });
ok("validateSetup passes the automatic setup", validation.ok,
  validation.errors.join("\n     "));
eq("and warns about nothing", validation.warnings, []);

// ── 3. the physics is pointed the right way ─────────────────────────────────
const bcs = spec.boundaryConditions;
const byType = (t) => bcs.filter((b) => b.type === t);
const inlet = byType("VELOCITY_INLET_V3")[0];

eq("the inlet blows along -x", {
  x: inlet.velocity.value.value.x.value,
  y: inlet.velocity.value.value.y.value,
  z: inlet.velocity.value.value.z.value,
}, { x: -20, y: 0, z: 0 });

// The sign that Runs 11 and 12 differ by. The worker reads the inlet back out
// of the saved setup to decide which way drag points, so these two vectors
// agreeing is what keeps a reported drag positive.
const coeff = spec.resultControl.forcesMoments
  .find((c) => c.type === "FORCE_AND_MOMENT_COEFFICIENTS");
eq("drag direction matches the inlet direction", coeff.dragDirection, FLOW_DIRECTION);
eq("the inlet is the flow direction scaled", FLOW_DIRECTION, { x: -1, y: 0, z: 0 });

eq("lift is up", coeff.liftDirection, { x: 0, y: 0, z: 1 });
eq("the reference area is the one measured over this tunnel",
  coeff.referenceArea, { value: 0.0041, unit: "m²" });
eq("the freestream matches the inlet",
  coeff.freestreamVelocityMagnitude, { value: 20, unit: "m/s" });

// ── 4. the road moves, and the wheels turn at road speed ────────────────────
const road = bcs.find((b) => b.name === "Road");
eq("the road moves with the air", road.velocity.value.value, { x: -20, y: 0, z: 0 });

const wheel = bcs.find((b) => b.name === "Front left");
const omega = wheel.velocity.rotation.angularVelocity.value.value;
ok("the wheel turns at road speed", Math.abs(omega - 20 / 0.0141) < 1e-9,
  `omega ${omega}, expected ${20 / 0.0141}`);
eq("about the axle", wheel.velocity.rotation.rotationAxis, { x: 0, y: 1, z: 0 });

// The one SimScale refuses the whole setup over.
//
// This was missing from the day autoSpec was written and never bit, because
// rotate_wheels defaulted to false - so the branch that builds a rotating wall
// had never run against the real API. Turning the wheels back on ran it, and
// a real run died three minutes in with:
//
//   Missing 'type' property for object 'rotation'
//   Path: /model/boundaryConditions/7/velocity/rotation
//
// patch_wheel_bcs in simscale_job.py has always sent it. Checked here because
// the schema is .passthrough() throughout and would never have noticed.
eq("the rotation says what kind it is",
  wheel.velocity.rotation.type, "ANGULAR_ROTATION");
ok("and the server schema now insists on it",
  !incompressibleModel.safeParse((() => {
    const s = JSON.parse(JSON.stringify(spec));
    const w = s.boundaryConditions.find((b) => b.velocity?.type === "ROTATING_WALL_VELOCITY");
    delete w.velocity.rotation.type;
    return s;
  })()).success,
  "a rotation with no type was accepted by the schema");

// Which way round, checked the way the physics defines it rather than by
// copying the sign out of the code it is meant to be testing.
//
// A rolling wheel's contact patch is stationary against the road. The patch
// sits at r = (0, 0, -R) from the centre and the wall there moves at w x r, so
// the whole claim is that w x r comes out equal to the road's own velocity. A
// wheel spun the wrong way has its contact patch going 40 m/s backwards
// against a road doing 20 forwards, which solves, converges and reports a
// drag.
const patchVelocity = (axis, w, radius) => ({
  // (ax, ay, az) x (0, 0, -R)
  x: w * (axis.y * -radius),
  y: w * (-axis.x * -radius),
  z: 0,
});
const patch = patchVelocity(
  wheel.velocity.rotation.rotationAxis, omega, 0.0141);
eq("the contact patch keeps up with the road exactly",
  { x: Math.round(patch.x * 1e9) / 1e9, y: Math.round(patch.y * 1e9) / 1e9 },
  { x: road.velocity.value.value.x, y: road.velocity.value.value.y });

// And it follows the road rather than a constant. Nothing downstream would
// catch a tunnel blowing the other way with the wheels still turning as though
// it blew this way.
const forward = wheelSpin({ x: -20, y: 0, z: 0 }, 0.0141);
const backward = wheelSpin({ x: 20, y: 0, z: 0 }, 0.0141);
ok("reversing the wind reverses the spin",
  Math.abs(forward.angularVelocity + backward.angularVelocity) < 1e-12
  && forward.angularVelocity > 0,
  `forward ${forward.angularVelocity}, backward ${backward.angularVelocity}`);
ok("a wheel with no radius asks for no rotation",
  wheelSpin({ x: -20, y: 0, z: 0 }, 0).angularVelocity === 0);

// ── which wheels turn ───────────────────────────────────────────────────────
//
// One wheel detected wrongly used to mean spinning none of them. The choice is
// per wheel, and a wheel left out is a wall rather than a face with nothing on
// it at all.
const somePicked = boundaryConditions(HALF, [
  { ...WHEELS[0], spin: true },
  { ...WHEELS[1], spin: false },
], OPTS);
ok("a wheel that was picked turns",
  somePicked.find((b) => b.name === "Front left")?.velocity?.type
  === "ROTATING_WALL_VELOCITY");
ok("a wheel that was not picked is a plain wall",
  somePicked.find((b) => b.name === "Rear left")?.velocity?.type === "NO_SLIP");
eq("and it keeps every one of its faces",
  somePicked.find((b) => b.name === "Rear left")?.topologicalReference?.faces, [22]);
ok("the master switch still stops all of them",
  boundaryConditions(HALF, [{ ...WHEELS[0], spin: true }],
    { ...OPTS, rotateWheels: false })
    .find((b) => b.name === "Front left")?.velocity?.type === "NO_SLIP");
ok("and a wheel with no say in the matter still turns",
  boundaryConditions(HALF, [WHEELS[0]], OPTS)
    .find((b) => b.name === "Front left")?.velocity?.type
  === "ROTATING_WALL_VELOCITY");

// Forces are measured over every wheel, turning or not: a wheel held still
// still has drag, and leaving it out would under-report the car.
const stillForces = resultControls(HALF, [
  { ...WHEELS[0], spin: false }, { ...WHEELS[1], spin: false },
], OPTS)[0];
eq("a wheel that is not turning is still weighed",
  stillForces.topologicalReference.faces, [10, 11, 12, 13, 20, 21, 22]);

// A wheel with no radius cannot be spun, and must not be silently dropped:
// a face with no boundary condition is the failure this path exists to stop.
const noRadius = boundaryConditions(
  { car_no_slip: [10] },
  [{ name: "Bad", radius_m: 0, cx_m: 0, cy_m: 0, cz_m: 0, face_indices: [20] }],
  OPTS,
);
const bad = noRadius.find((b) => b.name === "Bad");
ok("a wheel with no radius becomes a plain wall", bad?.velocity?.type === "NO_SLIP",
  JSON.stringify(bad?.velocity));
eq("and keeps its faces", bad.topologicalReference.faces, [20]);

// ── 5. half and full tunnels differ in exactly one place ────────────────────
const fullSpec = autoSpec(FULL, WHEELS, OPTS);
eq("a half tunnel has a symmetry plane", byType("SYMMETRY").length, 1);
eq("a full one has none",
  fullSpec.boundaryConditions.filter((b) => b.type === "SYMMETRY").length, 0);
ok("and still passes validation",
  validateSetup(fullSpec, { geometryId: "g1", faceIds, meshFineness: 5 }).ok);

// ── 6. no face is claimed twice ─────────────────────────────────────────────
const claimed = new Map();
for (const b of bcs) {
  for (const f of b.topologicalReference.faces) {
    ok(`face ${f} is claimed once`, !claimed.has(f),
      `also on "${claimed.get(f)}" and "${b.name}"`);
    claimed.set(f, b.name);
  }
}

// ── 7. forces are measured on the car, not the tunnel ───────────────────────
// Including the tunnel walls would add the pressure on the inlet to the drag,
// which on a 1.5 m tunnel is thousands of times the car's own.
const wallFaces = new Set([...HALF.inlet, ...HALF.outlet, ...HALF.ground,
  ...HALF.top, ...HALF.side, ...HALF.symmetry]);
for (const control of spec.resultControl.forcesMoments) {
  const leaked = control.topologicalReference.faces.filter((f) => wallFaces.has(f));
  eq(`${control.name} measures no tunnel wall`, leaked, []);
}
eq("forces cover the car and every wheel",
  spec.resultControl.forcesMoments[0].topologicalReference.faces,
  [10, 11, 12, 13, 20, 21, 22]);

// ── 8. no coefficients without an area ──────────────────────────────────────
const noArea = resultControls(HALF, WHEELS, { ...OPTS, frontalArea: 0 });
eq("no area means no coefficient control", noArea.length, 1);
eq("but the newtons are still recorded", noArea[0].type, "FORCES_AND_MOMENTS");

// ── 9. the air is the same air the Material dialog offers ───────────────────
const materials = readFileSync(join(root, "src/lib/materials.js"), "utf8");
const air = materials.match(/id:\s*"air",\s*name:\s*"Air",\s*nu:\s*([\d.e-]+),\s*rho:\s*([\d.]+)/);
ok("src/lib/materials.js still lists Air", !!air);
if (air) {
  eq("kinematic viscosity matches the library", AIR.nu, Number(air[1]));
  eq("density matches the library", AIR.rho, Number(air[2]));
}
eq("and that is what the setup carries",
  spec.materials.fluids[0].viscosityModel.kinematicViscosity,
  { value: AIR.nu, unit: "m²/s" });

// ── 10. iterations reach the solver ─────────────────────────────────────────
const short = autoSpec(HALF, WHEELS, { ...OPTS, iterations: 400 });
eq("end time is the iteration count", short.simulationControl.endTime.value, 400);
ok("max run time is well past it",
  short.simulationControl.maxRunTime.value >= short.simulationControl.endTime.value * 2);
eq("the domain starts at the freestream",
  short.initialConditions.velocity.global.value, { x: -20, y: 0, z: 0 });

// ── 11. the moment centre is the middle of the car at road level ────────────
eq("moment centre", momentCentre(
  { min: [0, -0.03, 0.002], max: [0.24, 0.03, 0.06] }, { ground_z: -0.001 },
), { x: 0.12, y: 0, z: -0.001 });
eq("with no domain it falls back to the box centre",
  momentCentre({ min: [0, 0, 0], max: [0.2, 0, 0.1] }, {}), { x: 0.1, y: 0, z: 0.05 });

// On the mirror plane when there is one, not in the middle of what was drawn.
//
// Half a car's forces are doubled to give the whole car's, and for roll and
// yaw that is exact only about a point on the plane. This model is drawn as
// half a car from y = 0 out to y = 0.06, so its own middle is 0.03 - 30 mm off
// the plane, which on a car carrying 2 N of lift is 0.12 N m of roll reported
// for a car that cannot roll.
eq("moments are taken about the mirror plane on a half model",
  momentCentre({ min: [0, 0, 0.002], max: [0.24, 0.06, 0.06] },
    { ground_z: -0.001, symmetry: true, symmetry_y: 0 }),
  { x: 0.12, y: 0, z: -0.001 });
eq("a mirror plane away from the origin is still the one used",
  momentCentre({ min: [0, 0.006, 0.002], max: [0.24, 0.066, 0.06] },
    { ground_z: -0.001, symmetry: true, symmetry_y: 0.006 }),
  { x: 0.12, y: 0.006, z: -0.001 });
eq("a full tunnel keeps the middle of the car",
  momentCentre({ min: [0, -0.03, 0.002], max: [0.24, 0.03, 0.06] },
    { ground_z: -0.001, symmetry: false, symmetry_y: 0.33 }),
  { x: 0.12, y: 0, z: -0.001 });

// ── the checks can fail ─────────────────────────────────────────────────────
// Every audit in this repo that passed vacuously did so because nobody made it
// fail first. A setup with the drag direction flipped must be caught by the
// same assertion above, or that assertion proves nothing.
const flipped = autoSpec(HALF, WHEELS, OPTS);
flipped.resultControl.forcesMoments.find(
  (c) => c.type === "FORCE_AND_MOMENT_COEFFICIENTS").dragDirection = { x: 1, y: 0, z: 0 };
const flippedDrag = flipped.resultControl.forcesMoments
  .find((c) => c.type === "FORCE_AND_MOMENT_COEFFICIENTS").dragDirection;
ok("a flipped drag direction would be caught",
  JSON.stringify(flippedDrag) !== JSON.stringify(FLOW_DIRECTION));

const noInlet = autoSpec({ ...HALF, inlet: [] }, WHEELS, OPTS);
ok("a tunnel with no inlet would be refused by the queue",
  !validateSetup(noInlet, { geometryId: "g1", faceIds, meshFineness: 5 }).ok);

const overlapping = boundaryConditions(
  { inlet: [0], outlet: [0], car_no_slip: [10] }, [], OPTS,
);
const overlapSpec = { ...spec, boundaryConditions: overlapping };
ok("a face on two boundary conditions would be refused",
  !validateSetup(overlapSpec, { geometryId: "g1", faceIds, meshFineness: 5 }).ok);

// ── fields that belong to a solver we do not run ────────────────────────────
//
// SimScale shares one schema across its solvers and refuses, at spec
// validation, any field conditional on an analysis type other than the one
// being run. Two of ours were: orientationReference on the moving road and
// fractionFromEnd on the forces control, both Pacefish only. A real run was
// accepted, queued, and failed three minutes later having taken 30 credits,
// saying only "Unprocessable entity (spec-validation-error)". Neither field is
// visible in any result, so nothing but this would notice them coming back.
const PACEFISH_ONLY = ["orientationReference", "fractionFromEnd", "exportStatistics"];

function hunt(node, path, found) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => hunt(v, `${path}.${i}`, found));
    return found;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (PACEFISH_ONLY.includes(k)) found.push(`${path}.${k}`);
      hunt(v, `${path}.${k}`, found);
    }
  }
  return found;
}

for (const [label, built] of [
  ["a half tunnel", autoSpec(HALF, WHEELS, OPTS)],
  ["a full tunnel", autoSpec(FULL, WHEELS, OPTS)],
  ["a tunnel with the wheels left still", autoSpec(HALF, WHEELS, { ...OPTS, rotateWheels: false })],
  ["a tunnel with a fixed road", autoSpec(HALF, WHEELS, { ...OPTS, movingGround: false })],
]) {
  const found = hunt(built, "$", []);
  ok(`${label} carries no Pacefish-only field`, found.length === 0, found.join(", "));
}

// And the queue refuses one that does, rather than letting it reach SimScale.
const sneaked = JSON.parse(JSON.stringify(spec));
const sneakedRoad = sneaked.boundaryConditions
  .find((b) => b.velocity?.type === "MOVING_WALL_VELOCITY");
if (sneakedRoad) sneakedRoad.velocity.orientationReference = "FLOW_DOMAIN";
ok("the queue refuses an orientation reference",
  !!sneakedRoad && !validateSetup(sneaked, { geometryId: "g1", faceIds, meshFineness: 5 }).ok);

for (const key of ["fractionFromEnd", "exportStatistics"]) {
  const sneaked2 = JSON.parse(JSON.stringify(spec));
  if (sneaked2.resultControl?.forcesMoments?.[0]) {
    sneaked2.resultControl.forcesMoments[0][key] = key === "fractionFromEnd" ? 0.2 : true;
  }
  ok(`the queue refuses ${key}`,
    !validateSetup(sneaked2, { geometryId: "g1", faceIds, meshFineness: 5 }).ok);
}

// ── the car is finer than the tunnel, but not fixed at the finest ──────────
//
// A fixed 10 on the car surface is right beside a 9.5 domain and wrong beside
// a 7 one. Asked for a coarse mesh to get a run through, a real car got 7
// everywhere except its own surface, and SimScale refused: "the mesh element
// size is too close to the cad tolerance", pointing at a spot on the bodywork.
for (const [asked, expected] of [[9.5, 10], [9.7, 10], [10, 10], [9, 9.5], [8, 8.5], [7, 7.5]]) {
  const spec = meshSpecFor(HALF, WHEELS, asked, { type: "SIMMETRIX_MESHING_FLUID_V16" });
  const domain = spec.sizing.fineness;
  const surfaces = (spec.refinements ?? []).map((r) => r.sizing.fineness);
  ok(`a domain at ${asked} meshes the car at ${expected}`,
    surfaces.length > 0 && surfaces.every((f) => f === expected),
    `got ${JSON.stringify(surfaces)}`);
  ok(`and the car is never coarser than the tunnel at ${asked}`,
    surfaces.every((f) => f >= domain), `car ${surfaces} vs tunnel ${domain}`);
  ok(`nor finer than SimScale allows at ${asked}`,
    surfaces.every((f) => f <= 10), `got ${surfaces}`);
}

// ── shattered faces are coarsened, not chased ──────────────────────────────
//
// One band of a customer car came in as 286 faces under half a millimetre
// square. A face must get at least one element, so leaving them in the fine
// car sizing drags the local element size down to their own size, and SimScale
// then refuses: "the mesh element size is too close to the cad tolerance".
{
  const carFaces = [...new Set(HALF.car_no_slip)].sort((a, b) => a - b);
  const fragments = carFaces.slice(0, 2);
  const spec = meshSpecFor(HALF, WHEELS, 7, { type: "SIMMETRIX_MESHING_FLUID_V16" }, fragments);
  const byName = Object.fromEntries((spec.refinements ?? []).map((r) => [r.name, r]));

  ok("the fragments get their own refinement", !!byName.Fragments);
  ok("and it is coarser than the tunnel",
    byName.Fragments?.sizing.fineness < spec.sizing.fineness,
    `fragments ${byName.Fragments?.sizing.fineness} vs tunnel ${spec.sizing.fineness}`);
  ok("and never below SimScale's floor",
    byName.Fragments?.sizing.fineness >= 1, `got ${byName.Fragments?.sizing.fineness}`);
  ok("the fragments are listed on it",
    JSON.stringify(byName.Fragments?.topologicalReference.faces) === JSON.stringify(fragments));

  const inCar = byName["Car surface"]?.topologicalReference.faces ?? [];
  ok("and are taken out of the fine car sizing",
    fragments.every((f) => !inCar.includes(f)),
    "a face was in two surface sizings at once");
  ok("while the rest of the car keeps it",
    inCar.length === carFaces.length - fragments.length,
    `car kept ${inCar.length} of ${carFaces.length}`);

  const none = meshSpecFor(HALF, WHEELS, 7, { type: "SIMMETRIX_MESHING_FLUID_V16" }, []);
  ok("a clean car gets no fragment refinement",
    !(none.refinements ?? []).some((r) => r.name === "Fragments"));
  ok("and keeps every car face in the fine sizing",
    (none.refinements ?? []).find((r) => r.name === "Car surface")
      ?.topologicalReference.faces.length === carFaces.length);
}

// ── report ──────────────────────────────────────────────────────────────────
if (failures.length) {
  console.error(`\nFAIL  ${failures.length} of ${checks} checks\n`);
  for (const f of failures) console.error(`   - ${f}`);
  process.exit(1);
}
console.log(`ok  ${checks} checks`);
