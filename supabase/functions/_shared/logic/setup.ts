// Defaults and small geometry rules shared by the ops router and the tests.
// Pure: no database, no network, so Node can import it as well as Deno.
import { FINENESS } from "./pricing.ts";

/**
 * The mesher settings a new simulation starts with. Each value was set by a
 * run that failed without it: fineness 9.5 is the middle priced rung, -1
 * processors lets SimScale choose within the plan's cap, and the 2 mm small
 * feature tolerance is what got a real customer car with hundreds of
 * sub-millimetre slivers through the mesher.
 */
export const DEFAULT_MESH_SPEC = {
  type: "SIMMETRIX_MESHING_FLUID_V16",
  sizing: { type: "AUTOMATIC_V9", fineness: 9.5, curvature: { type: "AUTOMATIC_CURVATURE" } },
  refinements: [],
  automaticLayerSettings: { type: "AUTOMATIC_LAYER_ON" },
  physicsBasedMeshing: true,
  hexCore: true,
  numOfProcessors: -1,
  advancedSimmetrixSettings: { smallFeatureTolerance: { value: 0.002, unit: "m" } },
};

/** Where moments are taken about: mid-car at road level, on the mirror plane. */
export function momentCentre(bbox: any, domain: any) {
  const min = Array.isArray(bbox?.min) ? bbox.min : [0, 0, 0];
  const max = Array.isArray(bbox?.max) ? bbox.max : [0, 0, 0];
  const mid = (i: number) => (Number(min[i]) + Number(max[i])) / 2;
  const r6 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0);
  const ground = Number(domain?.ground_z);
  const plane = Number(domain?.symmetry_y);
  return {
    x: r6(mid(0)),
    y: r6(domain?.symmetry && Number.isFinite(plane) ? plane : mid(1)),
    z: r6(Number.isFinite(ground) ? ground : mid(2)),
  };
}

/** SimScale's 0-10 fineness back to the 1-5 level runs are priced on, rounding up. */
export function levelForFineness(fineness: number): number {
  const rungs = Object.entries(FINENESS).map(([l, f]) => ({ level: Number(l), f: Number(f) })).sort((a, b) => a.f - b.f);
  return rungs.find((r) => fineness <= r.f + 1e-9)?.level ?? rungs[rungs.length - 1]?.level ?? 3;
}

/** The inlet speed, from the first velocity inlet. */
export function inletSpeed(spec: any): number {
  const v = (spec?.boundaryConditions ?? []).find((b: any) => b?.type === "VELOCITY_INLET_V3")?.velocity?.value?.value;
  return v ? Math.hypot(v.x?.value ?? 0, v.y?.value ?? 0, v.z?.value ?? 0) : 0;
}
