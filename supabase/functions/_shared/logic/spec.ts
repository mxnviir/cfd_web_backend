// The shape of an Incompressible simulation, as zod. Build spec 14.5.
//
// Narrowed to what TurboFlow offers rather than generated whole from
// SimScale's OpenAPI document. The generated version is thousands of lines
// covering seventeen analysis types, and a schema that accepts fields the
// Workbench cannot produce is not validation, it is a shape with a hole in
// it: the first thing it would let through is a boundary condition for an
// analysis nobody can run.
//
// Unknown keys are kept rather than stripped. SimScale adds fields between
// versions, and a setup saved by a newer Workbench and re-saved by an older
// one must not lose them silently.
import { z } from "zod";
import { UNITS } from "./units.ts";

const finite = z.number().finite();

/** A number with its unit, which is how SimScale carries every quantity. */
const dimensional = (unit: string) =>
  z.object({ value: finite, unit: z.literal(unit) }).passthrough();

const vector = z.object({ x: finite, y: finite, z: finite });

/**
 * A value that may be a constant or, later, a table or a formula.
 *
 * SimScale wraps these as {type: "CONSTANT", value}. Only CONSTANT is
 * accepted today because the panels only offer constants; the wrapper is
 * kept so adding a table is a new member of this union rather than a change
 * to every field that uses it.
 */
const constantScalar = z.object({
  type: z.literal("CONSTANT"), value: finite,
}).passthrough();

/**
 * Three per-component functions plus the discriminator SimScale needs.
 *
 * `type` is optional here and defaulted rather than required, because setups
 * saved before 11 Sep 2026 do not carry it and refusing to load them would
 * turn a solver-side bug into lost work. The worker adds it too, so a setup
 * that reaches SimScale always has it whichever path it came by.
 */
const constantVector = z.object({
  type: z.literal("COMPONENT").default("COMPONENT"),
  x: constantScalar, y: constantScalar, z: constantScalar,
}).passthrough();

const dimensionalVectorFunction = z.object({
  value: constantVector, unit: z.literal(UNITS.mps),
}).passthrough();

/**
 * Which faces a thing applies to.
 *
 * STEP face ids, not SimScale entity names. Names are assigned by SimScale
 * when it imports the geometry and are not known until then, so the setup
 * keeps the ids the user actually clicked and the queue step resolves them.
 * That is also what makes a setup survive a re-upload of the same car.
 */
const assignment = z.object({
  faces: z.array(z.number().int().min(0)).max(20000),
  entities: z.array(z.string().max(200)).max(20000).optional(),
}).passthrough();

// ── turbulence, shared by the inlets ───────────────────────────────────────
const turbulence = z.discriminatedUnion("type", [
  z.object({ type: z.literal("AUTOMATIC_TURBULENCE") }).passthrough(),
  z.object({
    type: z.literal("TURBULENT_INTENSITY_AND_REFERENCE_LENGTH_TURBULENCE"),
    turbulenceIntensity: finite.min(0).max(1).optional(),
    referenceLength: dimensional(UNITS.m).optional(),
  }).passthrough(),
  z.object({
    type: z.literal("FIXED_VALUE_TURBULENCE"),
    turbulentKineticEnergy: dimensional(UNITS.m2ps2).optional(),
    omegaDissipationRate: dimensional(UNITS.perS).optional(),
  }).passthrough(),
]);

// ── boundary conditions ────────────────────────────────────────────────────
const base = { name: z.string().trim().min(1).max(200), topologicalReference: assignment };

const velocityInlet = z.object({
  ...base,
  type: z.literal("VELOCITY_INLET_V3"),
  velocity: z.object({
    type: z.enum([
      "FIXED_VALUE", "FIXED_VALUE_NO_EXPRESSION", "FIXED_MEAN",
      "FLOW_RATE_INLET_VELOCITY", "FLOW_RATE_MEAN_INLET_VELOCITY", "FREESTREAM",
    ]),
    value: dimensionalVectorFunction.optional(),
    flowRate: z.object({
      type: z.enum(["VOLUMETRIC", "MASS"]), value: finite,
    }).passthrough().optional(),
  }).passthrough(),
  turbulence: turbulence.optional(),
}).passthrough();

const velocityOutlet = z.object({
  ...base,
  type: z.literal("VELOCITY_OUTLET_V7"),
  velocity: z.object({
    type: z.enum([
      "FIXED_VALUE", "FIXED_MEAN", "FLOW_RATE_OUTLET_VELOCITY",
      "FLOW_RATE_MEAN_OUTLET_VELOCITY", "STABLE_FLOW_RATE",
    ]),
    value: dimensionalVectorFunction.optional(),
  }).passthrough(),
}).passthrough();

const pressureInlet = z.object({
  ...base,
  type: z.literal("PRESSURE_INLET_V31"),
  gaugePressure: z.object({
    type: z.enum(["TOTAL_PRESSURE", "FIXED_VALUE", "FIXED_MEAN"]),
    value: z.object({ value: constantScalar, unit: z.literal(UNITS.Pa) }).passthrough(),
  }).passthrough(),
  turbulence: turbulence.optional(),
}).passthrough();

const pressureOutlet = z.object({
  ...base,
  type: z.literal("PRESSURE_OUTLET_V30"),
  gaugePressure: z.object({
    type: z.enum(["FIXED_VALUE", "FIXED_MEAN"]),
    value: z.object({ value: constantScalar, unit: z.literal(UNITS.Pa) }).passthrough(),
  }).passthrough(),
}).passthrough();

const wall = z.object({
  ...base,
  type: z.literal("WALL_V34"),
  velocity: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("NO_SLIP"),
      turbulenceWall: z.enum(["WALL_FUNCTION", "FULL_RESOLUTION"]).optional(),
      enableSurfaceRoughness: z.boolean().optional(),
      surfaceRoughness: dimensional(UNITS.m).optional(),
    }).passthrough(),
    z.object({ type: z.literal("SLIP") }).passthrough(),
    z.object({
      type: z.literal("MOVING_WALL_VELOCITY"),
      turbulenceWall: z.enum(["WALL_FUNCTION", "FULL_RESOLUTION"]).optional(),
      value: z.object({ value: vector, unit: z.literal(UNITS.mps) }).passthrough(),
      orientationReference: z.enum(["FLOW_DOMAIN", "GEOMETRY"]).optional(),
    }).passthrough(),
    z.object({
      type: z.literal("ROTATING_WALL_VELOCITY"),
      turbulenceWall: z.enum(["WALL_FUNCTION", "FULL_RESOLUTION"]).optional(),
      rotation: z.object({
        // Required, because SimScale requires it. The schema used to let a
        // rotation through without a type and the run failed at the API
        // instead, after the credits were taken.
        type: z.literal("ANGULAR_ROTATION"),
        rotationCenter: z.object({ value: vector, unit: z.literal(UNITS.m) }).passthrough(),
        rotationAxis: vector,
        angularVelocity: z.object({
          value: constantScalar, unit: z.literal(UNITS.radps),
        }).passthrough(),
      }).passthrough(),
    }).passthrough(),
  ]),
}).passthrough();

const plain = (type: string) => z.object({ ...base, type: z.literal(type) }).passthrough();

export const boundaryCondition = z.discriminatedUnion("type", [
  velocityInlet, velocityOutlet, pressureInlet, pressureOutlet, wall,
  plain("SYMMETRY"), plain("CUSTOM_V37"), plain("FAN"), plain("PERIODIC"),
  plain("WEDGE"), plain("EMPTY_2D"),
]);

/** The types that count as letting flow in, and out. Used by the validator. */
export const INLET_TYPES = ["VELOCITY_INLET_V3", "PRESSURE_INLET_V31"];
export const OUTLET_TYPES = ["VELOCITY_OUTLET_V7", "PRESSURE_OUTLET_V30"];

// ── the rest of the model ──────────────────────────────────────────────────
const fluid = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().max(80).optional(),
  viscosityModel: z.object({
    type: z.string().max(80),
    kinematicViscosity: dimensional(UNITS.m2ps).optional(),
  }).passthrough().optional(),
  density: dimensional(UNITS.kgpm3).optional(),
  topologicalReference: assignment.optional(),
}).passthrough();

const globalValue = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({ global: inner, subdomains: z.array(z.any()).max(200).optional() }).passthrough();

const initialConditions = z.object({
  gaugePressure: globalValue(dimensional(UNITS.Pa)),
  velocity: globalValue(z.object({ value: vector, unit: z.literal(UNITS.mps) }).passthrough()),
  turbulentKineticEnergy: globalValue(dimensional(UNITS.m2ps2)).optional(),
  omegaDissipationRate: globalValue(dimensional(UNITS.perS)).optional(),
  dissipationRate: globalValue(dimensional(UNITS.m2ps3)).optional(),
  nuTilda: globalValue(dimensional(UNITS.m2ps)).optional(),
}).passthrough();

const simulationControl = z.object({
  endTime: dimensional(UNITS.s),
  deltaT: dimensional(UNITS.s),
  writeControl: z.object({
    type: z.string().max(60), writeInterval: z.number().int().positive(),
  }).passthrough(),
  numProcessors: z.number().int().min(-1).max(192),
  maxRunTime: dimensional(UNITS.s),
  potentialFoamInitialization: z.boolean().optional(),
  decomposeAlgorithm: z.object({ type: z.string().max(60) }).passthrough().optional(),
}).passthrough();

const resultControl = z.object({
  forcesMoments: z.array(z.any()).max(50).optional(),
  surfaceData: z.array(z.any()).max(50).optional(),
  scalarTransport: z.array(z.any()).max(50).optional(),
  probePoints: z.array(z.any()).max(50).optional(),
  fieldCalculations: z.array(z.any()).max(50).optional(),
}).passthrough();

export const incompressibleModel = z.object({
  type: z.literal("INCOMPRESSIBLE"),
  turbulenceModel: z.enum([
    "NONE", "KEPSILON", "REALIZABLEKE", "KOMEGA", "KOMEGASST",
    "SMAGORINSKY", "SPALARTALLMARAS",
  ]),
  timeDependency: z.object({ type: z.enum(["STATIONARY", "TRANSIENT"]) }).passthrough(),
  algorithm: z.enum(["SIMPLE", "PIMPLE", "PISO"]).optional(),
  numOfPassiveSpecies: z.number().int().min(0).max(10).optional(),
  enableAdjointOptimization: z.boolean().optional(),
  model: z.object({}).passthrough().optional(),
  materials: z.object({ fluids: z.array(fluid).max(20) }).passthrough(),
  initialConditions,
  boundaryConditions: z.array(boundaryCondition).max(200),
  advancedConcepts: z.object({}).passthrough().optional(),
  numerics: z.object({}).passthrough(),
  simulationControl,
  resultControl,
}).passthrough();

/** The mesher settings, which SimScale keeps beside the model, not in it. */
export const meshSpec = z.object({
  type: z.string().max(80),
  sizing: z.object({
    type: z.string().max(80),
    fineness: finite.min(0).max(10),
    curvature: z.object({ type: z.string().max(80) }).passthrough().optional(),
  }).passthrough(),
  refinements: z.array(z.any()).max(100),
  automaticLayerSettings: z.object({ type: z.string().max(80) }).passthrough().optional(),
  physicsBasedMeshing: z.boolean().optional(),
  hexCore: z.boolean().optional(),
  numOfProcessors: z.number().int().min(-1).max(192).optional(),
}).passthrough();

/**
 * A save may carry the setup, the mesh settings, or both.
 *
 * `spec` is optional so the Mesh panel can save on its own without having to
 * resend the whole model, and so a panel that only owns half the document
 * cannot overwrite the other half with a stale copy it happened to be holding.
 * The callable fills in whatever is absent from what is already stored.
 */
export const saveSimulationSchema = z.object({
  simulation_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  spec: incompressibleModel.optional(),
  mesh_spec: meshSpec.optional(),
  primitives: z.array(z.any()).max(100).optional(),
}).refine((d) => d.spec !== undefined || d.mesh_spec !== undefined || d.primitives !== undefined,
  { message: "Nothing to save." });

export const createSimulationSchema = z.object({
  group_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  geometry_id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).nullish(),
  name: z.string().trim().min(1).max(200).optional(),
});
