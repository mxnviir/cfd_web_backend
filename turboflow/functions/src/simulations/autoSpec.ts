// A complete Incompressible setup, built from a labelled wind tunnel.
//
// This is the whole of "set up a simulation automatically". Everything it
// needs is already known by the time a tunnel exists: /prepare says which
// faces are the inlet, the outlet, the road, the walls and each wheel, and it
// measures the car's shadow over the width of tunnel it built. The only two
// things a person has to supply are how fast the car is going and how long to
// solve for.
//
// Pure on purpose - no Firestore, no network, no clock. The panels a user then
// opens edit what comes out of here, so this has to produce exactly the shapes
// the hand-built path produces, and the cheapest way to be sure of that is to
// run it in a test. See tests/test_auto_spec.mjs.
import { UNITS } from "../lib/units";
import DEFAULT_MODEL from "./defaultIncompressible.json";

/** Face indices on the flow region, grouped by what /prepare decided they are. */
export interface DomainLabels {
  inlet?: number[];
  outlet?: number[];
  ground?: number[];
  top?: number[];
  side?: number[];
  symmetry?: number[];
  car_no_slip?: number[];
  [other: string]: number[] | undefined;
}

export interface Wheel {
  name?: string;
  radius_m: number;
  cx_m: number;
  cy_m: number;
  cz_m: number;
  /** How far this wheel reaches along its own axle, which is what separates it
   *  from the other wheel on the same axis. Carried for display only. */
  y_lo_m?: number;
  y_hi_m?: number;
  /** False leaves this one wheel still while the others turn. */
  spin?: boolean;
  face_indices: number[];
}

export interface AutoSetupOptions {
  /** Freestream speed in m/s. The car is stationary and the air moves. */
  speed: number;
  /** Iterations for the steady-state solve. */
  iterations: number;
  /** The car's shadow, already clipped to the width of tunnel that was built. */
  frontalArea: number;
  /** The car's length, used as the reference length for moment coefficients. */
  referenceLength: number;
  /** Where moments are taken about. */
  centreOfRotation?: { x: number; y: number; z: number };
  /** Spin the wheels at road speed. False stops all of them; a single wheel is
   *  stopped with `spin: false` on the wheel itself. */
  rotateWheels?: boolean;
  /** Move the road under the car, rather than leaving a floor the air sticks to. */
  movingGround?: boolean;
  /** Turbulence model, if something other than the default is wanted. */
  turbulenceModel?: string;
}

/**
 * Air at 20 C.
 *
 * The same two numbers as src/lib/materials.js, which is the library the
 * Material dialog offers and the only fluid in it that has been checked
 * against SimScale's own. tests/test_auto_spec.mjs pins them to that file, so
 * the automatic setup and the hand-built one cannot end up running different
 * air.
 */
export const AIR = { nu: 1.529e-5, rho: 1.196 };

/**
 * Which way the wind blows.
 *
 * -x, because build_domain puts the inlet at max x and the outlet at min x.
 * Everything downstream agrees with this and has to: the drag direction on the
 * coefficient control is the same vector, and the worker reads the inlet back
 * out of the finished setup to decide which way is drag (flow_direction in
 * simscale_job.py). Runs 11 and 12 on 11 Sep 2026 are the same car with this
 * sign wrong and right.
 */
export const FLOW_DIRECTION = { x: -1, y: 0, z: 0 };

const constant = (value: number) => ({ type: "CONSTANT" as const, value });

const componentVector = (v: { x: number; y: number; z: number }) => ({
  type: "COMPONENT" as const,
  x: constant(v.x),
  y: constant(v.y),
  z: constant(v.z),
});

const scaled = (by: number) => ({
  x: FLOW_DIRECTION.x * by,
  y: FLOW_DIRECTION.y * by,
  z: FLOW_DIRECTION.z * by,
});

const assigned = (faces: number[]) => ({ topologicalReference: { faces } });

/**
 * How fast a wheel turns, and which way.
 *
 * Not a constant, and not "speed over radius" with a sign somebody picked. The
 * wheel is rolling, so the point at the bottom of it has to be moving with the
 * road, and that one condition fixes both numbers.
 *
 * The axle lies along y once orient_to_wind has turned the car, so the axis is
 * (0, 1, 0) and the contact patch sits at r = (0, 0, -R) from the centre. A
 * wall turning at w about that axis moves at w x r there, and
 *
 *   (0, 1, 0) x (0, 0, -R) = (-R, 0, 0)
 *
 * so the patch moves at -wR along x. Matching that to the road gives
 * w = -road.x / R. In the tunnel this service builds - inlet at max x, air and
 * road both running toward -x - that comes out at +speed/R, which is what has
 * always been sent. It is now derived from the same vector the road is given
 * rather than assumed, so the two cannot disagree: a tunnel blowing the other
 * way turns the wheels the other way, instead of driving them backwards at
 * road speed, which nothing downstream would have caught.
 */
export function wheelSpin(
  road: { x: number; y: number; z: number },
  radius: number,
): { axis: { x: number; y: number; z: number }; angularVelocity: number } {
  return {
    axis: { x: 0, y: 1, z: 0 },
    angularVelocity: radius > 0 ? -road.x / radius : 0,
  };
}

/** Deduplicated and sorted, so two labels cannot claim the same face twice. */
function clean(faces: number[] | undefined): number[] {
  return [...new Set(faces ?? [])]
    .filter((f) => Number.isInteger(f) && f >= 0)
    .sort((a, b) => a - b);
}

/**
 * The boundary conditions for a labelled tunnel.
 *
 * A label with no faces produces no boundary condition at all, rather than an
 * empty one. An empty boundary condition is an error in validateSetup, so
 * writing one would mean a full-width tunnel - which has no symmetry plane -
 * could never be queued.
 */
export function boundaryConditions(
  labels: DomainLabels,
  wheels: Wheel[],
  opts: AutoSetupOptions,
): any[] {
  const speed = Math.abs(opts.speed);
  // One vector for the air, the road and the wheels. They are three statements
  // of the same fact - how fast the ground is going past the car, and which
  // way - and writing it out three times is how they drift apart.
  const road = scaled(speed);
  const out: any[] = [];

  const inlet = clean(labels.inlet);
  if (inlet.length) {
    out.push({
      name: "Inlet",
      type: "VELOCITY_INLET_V3",
      velocity: {
        type: "FIXED_VALUE",
        value: { value: componentVector(road), unit: UNITS.mps },
      },
      turbulence: { type: "AUTOMATIC_TURBULENCE" },
      ...assigned(inlet),
    });
  }

  const outlet = clean(labels.outlet);
  if (outlet.length) {
    out.push({
      name: "Outlet",
      type: "PRESSURE_OUTLET_V30",
      gaugePressure: { type: "FIXED_VALUE", value: { value: constant(0), unit: UNITS.Pa } },
      ...assigned(outlet),
    });
  }

  const ground = clean(labels.ground);
  if (ground.length) {
    // A road that moves with the air, not a stationary floor.
    //
    // The car is held still and the air is blown at it, so the road has to
    // move too or a boundary layer grows along the tunnel floor that does not
    // exist in life. It changes the answer under the car, which for a STEM
    // Racing car is most of the answer.
    out.push({
      name: "Road",
      type: "WALL_V34",
      velocity: opts.movingGround === false
        ? { type: "NO_SLIP", turbulenceWall: "WALL_FUNCTION" }
        : {
          type: "MOVING_WALL_VELOCITY",
          turbulenceWall: "WALL_FUNCTION",
          value: { value: road, unit: UNITS.mps },
          // No orientationReference. It belongs to Pacefish, SimScale's
          // lattice-Boltzmann solver, and sending it on an INCOMPRESSIBLE run
          // is refused outright: "Value should not be present when none of the
          // following conditions are met: [analysis.type IS
          // INCOMPRESSIBLE_PACEFISH]". The run fails at spec validation, three
          // minutes in, after the credits are taken.
        },
      ...assigned(ground),
    });
  }

  // The roof and the far wall are slip walls: they are where the tunnel ends,
  // not surfaces the air is meant to stick to.
  const shell: Array<[keyof DomainLabels, string]> = [
    ["top", "Tunnel roof"],
    ["side", "Tunnel wall"],
  ];
  for (const [key, name] of shell) {
    const faces = clean(labels[key]);
    if (faces.length) {
      out.push({ name, type: "WALL_V34", velocity: { type: "SLIP" }, ...assigned(faces) });
    }
  }

  const symmetry = clean(labels.symmetry);
  if (symmetry.length) {
    out.push({ name: "Symmetry plane", type: "SYMMETRY", ...assigned(symmetry) });
  }

  const car = clean(labels.car_no_slip);
  if (car.length) {
    out.push({
      name: "Car",
      type: "WALL_V34",
      velocity: { type: "NO_SLIP", turbulenceWall: "WALL_FUNCTION" },
      ...assigned(car),
    });
  }

  wheels.forEach((wheel, i) => {
    const faces = clean(wheel.face_indices);
    if (!faces.length) return;
    const name = wheel.name || `Wheel ${i + 1}`;
    // Three ways a wheel ends up standing still: the model was set up with no
    // spinning wheels at all, this particular wheel was not one of the ones
    // ticked, or it has no radius - omega is speed over radius, so there is no
    // number to send. In every case it stays a wall rather than being dropped,
    // because a face with no boundary condition at all is the failure this
    // whole path exists to avoid.
    const spin = opts.rotateWheels !== false
      && wheel.spin !== false
      && wheel.radius_m > 0;
    const turn = wheelSpin(road, wheel.radius_m);
    out.push({
      name,
      type: "WALL_V34",
      velocity: spin
        ? {
          type: "ROTATING_WALL_VELOCITY",
          turbulenceWall: "WALL_FUNCTION",
          rotation: {
            // SimScale refuses the whole setup without this: "Missing 'type'
            // property for object 'rotation'". It was absent from the day this
            // file was written and never bit, because rotate_wheels defaulted
            // to false - so the branch that builds a rotating wall had never
            // run against the real API. Turning the wheels back on ran it, and
            // the run died at spec validation three minutes in.
            //
            // patch_wheel_bcs in simscale_job.py has always sent it. That is
            // the Fusion path, which is the one that had ever actually spun a
            // wheel.
            type: "ANGULAR_ROTATION",
            rotationCenter: {
              value: { x: wheel.cx_m, y: wheel.cy_m, z: wheel.cz_m },
              unit: UNITS.m,
            },
            // Axles run along y once orient_to_wind has turned the car.
            rotationAxis: turn.axis,
            angularVelocity: { value: constant(turn.angularVelocity), unit: UNITS.radps },
          },
        }
        : { type: "NO_SLIP", turbulenceWall: "WALL_FUNCTION" },
      ...assigned(faces),
    });
  });

  return out;
}

/**
 * The two result controls, over the car and its wheels.
 *
 * Both, not one. The coefficients are what a team is judged on and the raw
 * newtons are what they can check by hand, and the pair costs the solver
 * nothing beyond writing two more columns.
 */
export function resultControls(
  labels: DomainLabels,
  wheels: Wheel[],
  opts: AutoSetupOptions,
): any[] {
  const faces = clean([
    ...(labels.car_no_slip ?? []),
    ...wheels.flatMap((w) => w.face_indices ?? []),
  ]);
  if (!faces.length) return [];

  const centre = opts.centreOfRotation ?? { x: 0, y: 0, z: 0 };
  const every = { type: "TIME_STEP", writeInterval: 1 };
  const controls: any[] = [{
    type: "FORCES_AND_MOMENTS",
    id: "auto-forces",
    name: "Forces and moments",
    centerOfRotation: { value: centre, unit: UNITS.m },
    writeControl: every,
    // No exportStatistics and no fractionFromEnd: both are Pacefish and Wind
    // Comfort only, and SimScale refuses the whole setup if either is present
    // on an INCOMPRESSIBLE run. They came out one per attempt, because the
    // validator reports the first offending field and stops. See the note on
    // the road above.
    topologicalReference: { faces },
  }];

  // No area, no coefficients. A Cd divided by a made-up reference area is
  // worse than no Cd at all: it is the single number these teams compete on,
  // and a wrong one looks exactly like a right one.
  if (opts.frontalArea > 0) {
    controls.push({
      type: "FORCE_AND_MOMENT_COEFFICIENTS",
      id: "auto-coefficients",
      name: "Drag and lift",
      centerOfRotation: { value: centre, unit: UNITS.m },
      liftDirection: { x: 0, y: 0, z: 1 },
      dragDirection: { ...FLOW_DIRECTION },
      pitchAxisDirection: { x: 0, y: 1, z: 0 },
      freestreamVelocityMagnitude: { value: Math.abs(opts.speed), unit: UNITS.mps },
      referenceLength: { value: opts.referenceLength, unit: UNITS.m },
      referenceArea: { value: opts.frontalArea, unit: UNITS.m2 },
      writeControl: every,
      topologicalReference: { faces },
    });
  }
  return controls;
}

/**
 * The mesher settings, with the refinements the Fusion add-in has always used.
 *
 * Three differences from what a Workbench simulation started with, all of them
 * read off a real mesh operation the add-in created rather than guessed.
 *
 * The car and the wheels get their own surface sizing at the finest setting.
 * Without it the whole model meshes at one size, so the tunnel walls - which
 * are a metre and a half of nothing - get the same cells as the bodywork, and
 * either the wake is under-resolved or the run costs many times what it should.
 *
 * The boundary layers are stated rather than left to the solver: three layers
 * at 0.4 relative thickness growing at 1.5, which is what the add-in asks for
 * and what the drag on a car this size is sensitive to.
 *
 * And the global fineness is on the ladder the rest of the product prices
 * against. FINENESS in lib/pricing maps refine level 1-5 onto 9.0 to 10.0,
 * because that is the part of SimScale's scale a car of this size needs. A
 * Workbench simulation defaulted to 5.0, which is not on the ladder at all: it
 * priced as the cheapest level and meshed far coarser than any run the add-in
 * has ever produced.
 */
export function meshSpecFor(
  labels: DomainLabels,
  wheels: Wheel[],
  fineness: number,
  base: Record<string, any>,
  slivers: number[] = [],
): Record<string, any> {
  // Fragments are meshed coarsely, and excluded from the fine car sizing.
  //
  // A customer car had one 20 mm band of bodywork shattered into 286 faces
  // smaller than half a millimetre square. SimScale meshed for ten minutes and
  // refused: "the mesh element size is too close to the cad tolerance of the
  // following entities", naming one. Coarsening the whole car did not help,
  // and raising the small-feature tolerance from 0.5 mm to 2 mm only moved the
  // complaint to the next fragment half a millimetre away.
  //
  // SimScale's other suggestion is to coarsen the mesh around those entities
  // specifically, which is this. A face must get at least one element, so
  // leaving a fragment in the fine sizing drags the local element size down
  // toward the fragment's own size, and that is what ends up near the
  // tolerance. Told to be coarse there, the mesher stops chasing them.
  //
  // They are taken out of the car refinement rather than covered by both: two
  // surface sizings over one face is not a defined thing to ask for.
  const fragments = clean(slivers);
  const fragmentSet = new Set(fragments);
  const car = clean(labels.car_no_slip).filter((f) => !fragmentSet.has(f));
  const wheelFaces = clean(wheels.flatMap((w) => w.face_indices ?? []))
    .filter((f) => !fragmentSet.has(f));
  // The car is meshed finer than the tunnel, but no longer pinned at 10.
  //
  // 10 was the Fusion add-in's value and it is right when the domain is at
  // 9.5: the point of this refinement is that the tunnel walls, which are a
  // metre and a half of nothing, must not get the same cells as the bodywork.
  // A fixed 10 stops meaning that the moment someone coarsens the mesh to get
  // a run through at all. Asked for 7, they got 7 everywhere except the one
  // surface that matters, and SimScale refused the mesh: "the mesh element
  // size is too close to the cad tolerance of the following entities",
  // pointing at a spot on the bodywork.
  //
  // So it tracks the choice and keeps the same gap the add-in had, half a
  // rung of the 9.0-to-10.0 ladder, and never exceeds what SimScale allows.
  const carFineness = Math.min(10, Math.round((fineness + 0.5) * 10) / 10);
  const surface = (name: string, faces: number[]) => ({
    type: "SURFACE_CUSTOM_SIZING",
    name,
    sizing: {
      type: "AUTOMATIC_V9",
      fineness: carFineness,
      curvature: { type: "AUTOMATIC_CURVATURE" },
    },
    topologicalReference: { faces },
  });

  // Three rungs below the tunnel, floored at 1. Coarse enough that the mesher
  // stops resolving debris, and it is debris: nothing here is a shape anyone
  // drew on purpose.
  const fragmentFineness = Math.max(1, Math.round((fineness - 3) * 10) / 10);

  const refinements: any[] = [];
  if (car.length) refinements.push(surface("Car surface", car));
  if (wheelFaces.length) refinements.push(surface("Wheel surfaces", wheelFaces));
  if (fragments.length) {
    refinements.push({
      type: "SURFACE_CUSTOM_SIZING",
      name: "Fragments",
      sizing: {
        type: "AUTOMATIC_V9",
        fineness: fragmentFineness,
        curvature: { type: "AUTOMATIC_CURVATURE" },
      },
      topologicalReference: { faces: fragments },
    });
  }

  return {
    ...base,
    sizing: {
      ...(base.sizing ?? {}),
      type: "AUTOMATIC_V9",
      fineness: Math.round(fineness * 10) / 10,
      curvature: { type: "AUTOMATIC_CURVATURE" },
    },
    refinements,
    automaticLayerSettings: {
      type: "AUTOMATIC_LAYER_ON",
      layerType: {
        type: "FRACTIONAL_HEIGHT_2",
        numberOfLayers: 3,
        totalRelativeThickness: 0.4,
        growthRate: 1.5,
      },
    },
  };
}

/**
 * The whole setup.
 *
 * Built on top of defaultIncompressible.json rather than written out here, so
 * the numerics, the schemes and the residual controls stay in the one file
 * that owns them and a hand-built simulation and an automatic one solve the
 * same way.
 */
export function autoSpec(
  labels: DomainLabels,
  wheels: Wheel[],
  opts: AutoSetupOptions,
): any {
  const speed = Math.abs(opts.speed);
  const iterations = Math.max(1, Math.round(opts.iterations));
  const spec = JSON.parse(JSON.stringify(DEFAULT_MODEL));

  if (opts.turbulenceModel) spec.turbulenceModel = opts.turbulenceModel;

  spec.materials = {
    fluids: [{
      name: "Air",
      type: "INCOMPRESSIBLE",
      viscosityModel: {
        type: "NEWTONIAN",
        kinematicViscosity: { value: AIR.nu, unit: UNITS.m2ps },
      },
      density: { value: AIR.rho, unit: UNITS.kgpm3 },
      // Left empty on purpose: the worker fills it with the flow region's own
      // name, which is not known until SimScale has imported the geometry.
      topologicalReference: { entities: [], faces: [] },
    }],
  };

  spec.boundaryConditions = boundaryConditions(labels, wheels, opts);
  spec.resultControl = {
    ...(spec.resultControl ?? {}),
    forcesMoments: resultControls(labels, wheels, opts),
  };

  spec.simulationControl = {
    ...spec.simulationControl,
    endTime: { value: iterations, unit: UNITS.s },
    deltaT: { value: 1, unit: UNITS.s },
    // One write, at the end. The field data is the big download and a team
    // wants the converged one; the force traces are written every iteration
    // by the result controls above and are what the plots are drawn from.
    writeControl: { type: "TIME_STEP", writeInterval: iterations },
    // validateSetup warns below twice the end time, and it is right to: a run
    // stopped by its own clock reports whatever it had reached.
    maxRunTime: { value: Math.max(20000, iterations * 20), unit: UNITS.s },
  };

  // Start the whole domain at the freestream rather than at rest. A steady
  // solve reaches the same answer either way, but starting from still air
  // means the first few hundred iterations are spent filling the tunnel.
  spec.initialConditions = {
    ...spec.initialConditions,
    velocity: { global: { value: scaled(speed), unit: UNITS.mps }, subdomains: [] },
  };

  return spec;
}
