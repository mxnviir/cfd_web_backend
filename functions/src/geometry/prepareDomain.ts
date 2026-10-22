// The pieces every tunnel build shares, whichever side built it.
//
// The wind tunnel was built by the geometry service on Cloud Run from the
// beginning: the old backend called it and waited, and it wrote the version
// and the simulation. The cut now runs in the browser - the same OCC engine
// in a Web Worker, no container - and what is left here is the half both
// paths need: the schema of what a person actually chooses, the ownership
// check, the version numbering, and writeSetup, which turns a built tunnel
// into a version document and a simulation.
//
// The old Cloud Run path is gone, and its callable went with it: the
// Workbench calls createArtifactIntent / ingestPreparedDomain in
// preparedDomain.ts, and nothing else ever called the old one.
import { HttpsError } from "firebase-functions/v2/https";
import { z } from "zod";
import { db, FieldValue } from "../lib/admin";
import { COL } from "../lib/config";
import { docId } from "../groups/schemas";
import { autoSpec, meshSpecFor } from "../simulations/autoSpec";
import { DEFAULT_MESH_SPEC, checkSimulation } from "../simulations";

/**
 * What a person actually chooses.
 *
 * Everything else about the tunnel is derived from the car. These are the
 * numbers that are a judgement rather than a measurement, and the defaults
 * are the ones the Fusion add-in has used on every real car so far.
 */
export const prepareDomainSchema = z.object({
  geometry_id: docId,
  group_id: docId,
  /** Reuse this simulation rather than making another. */
  simulation_id: docId.nullish(),
  /** Half the car against a symmetry plane. Quarter the cells, same answer. */
  symmetry: z.boolean().default(true),
  /** Freestream speed in m/s. A STEM Racing car is tested near 20. */
  speed: z.number().min(1).max(100).default(20),
  iterations: z.number().int().min(100).max(3000).default(1000),
  /** SimScale's 0-10 mesh fineness. Only 9.0 to 10.0 is priced; see FINENESS. */
  fineness: z.number().min(0).max(10).default(9.5),
  /** Tunnel offsets from the car, in metres. */
  upstream_m: z.number().min(0.05).max(50).default(1.5),
  downstream_m: z.number().min(0.05).max(50).default(0.5),
  side_m: z.number().min(0.01).max(10).default(0.3),
  top_m: z.number().min(0.01).max(10).default(0.3),
  /** What a wheel looks like, for the automatic search. */
  wheel_radius_m: z.number().min(0.001).max(1).default(0.014125),
  /**
   * A second size, when the rear wheels are not the front ones.
   *
   * One radius with an eight per cent tolerance cannot cover 14.1 mm and
   * 17 mm at once, and widening the tolerance until it does starts matching
   * the axle. Null means the car has one size of wheel.
   */
  rear_wheel_radius_m: z.number().min(0.001).max(1).nullish(),
  wheel_tolerance: z.number().min(0).max(0.5).default(0.08),
  /**
   * Spin every wheel found, at the speed the road is going past it.
   *
   * This is the faithful model: a car whose wheels are held still has a
   * stationary cylinder sitting in its own wake, and on a car this size the
   * wheels are a large part of the drag. It was off for a while because
   * a spinning wall was one more thing to be wrong while the rest of the path
   * was being proved out, and the speed it spun at came off the wrong face.
   * Both are fixed and tested, so it is back on.
   */
  rotate_wheels: z.boolean().default(true),
  /**
   * Which of them, by name.
   *
   * Null - the usual case - means all of them. A list means only the wheels
   * named in it turn and the rest stay walls, which is what you want when one
   * wheel has been detected wrongly, or to see what the spin is worth by
   * running the same car twice.
   *
   * By name rather than by index because the two passes that find wheels are
   * separate: the list shown in the Workbench came from the import, and the
   * tunnel is cut later, possibly with a different search radius typed in
   * between. Names are positions - "Front left" - so they mean the same wheel
   * in both. A name that matches nothing simply spins nothing.
   */
  spin_wheels: z.array(z.string().max(40)).max(20).nullish(),
  moving_ground: z.boolean().default(true),
  /** Wheels the user picked in the viewer, which override the search. */
  wheels: z.array(z.object({
    name: z.string().max(40).optional(),
    radius_m: z.number().min(0.001).max(1),
    cx_m: z.number(), cy_m: z.number(), cz_m: z.number(),
    face_indices: z.array(z.number().int().min(0)).max(5000).optional(),
  })).max(20).nullish(),
});

export type PrepareDomainInput = z.infer<typeof prepareDomainSchema>;

/** The owner, or someone with edit on the project it belongs to. */
export async function mustEdit(uid: string, geometryId: string) {
  const snap = await db.collection(COL.geometries).doc(geometryId).get();
  if (!snap.exists) throw new HttpsError("not-found", "No such geometry.");
  if (snap.get("user_id") !== uid) {
    const pid = snap.get("group_id");
    const project = pid ? await db.collection(COL.groups).doc(pid).get() : null;
    if (!project?.exists
      || (project.get("user_id") !== uid && (project.get("shared_with") ?? {})[uid] !== "edit")) {
      throw new HttpsError("permission-denied", "That geometry is not yours.");
    }
  }
  return snap;
}

/**
 * The newest version that is the car, not a tunnel built around it.
 *
 * Once a tunnel exists it is the current version, so reading current_version
 * meant a second run built a wind tunnel around the first wind tunnel - a
 * box around a box, with the car sealed inside. The source is always the
 * newest version that is not itself a flow domain.
 */
export function rawVersionOf(snap: FirebaseFirestore.DocumentSnapshot): number {
  const versions = (snap.get("versions") ?? {}) as Record<string, any>;
  return Object.keys(versions)
    .map(Number)
    .filter((n) => Number.isFinite(n) && versions[String(n)]?.kind !== "flow_domain")
    .sort((a, b) => b - a)[0] ?? Number(snap.get("current_version") ?? 1);
}

/**
 * The number the next tunnel is filed under, whatever the last one was.
 *
 * A tunnel is a version, so changing from a half model to a full one leaves
 * the old one where it is and any run already queued against it keeps
 * solving what it was queued with.
 */
export function nextVersionOf(snap: FirebaseFirestore.DocumentSnapshot): number {
  return Math.max(Number(snap.get("current_version") ?? 0), rawVersionOf(snap)) + 1;
}

/**
 * Write the tunnel as a version, and the setup built from it as a simulation.
 *
 * The order matters. The version is written first and made current, because
 * the simulation points at whatever is current and the run that follows reads
 * its STEP from there: a simulation created against a version that is not yet
 * the current one would be queued against the raw car.
 *
 * Called by ingestPreparedDomain with the artefacts the browser uploaded, and
 * written so it could not tell: everything it reads is the same shape the
 * geometry service used to return.
 */
export async function writeSetup(
  owner: string,
  input: PrepareDomainInput,
  snap: FirebaseFirestore.DocumentSnapshot,
  out: any,
): Promise<string> {
  const version = out.version as number;
  // Which wheels were asked to turn. No list means all of them; a list means
  // those and no others. Marked here rather than in autoSpec so the version
  // records what was decided, and the panel can show it back without having to
  // read the spec.
  const picked = input.spin_wheels;
  const wheels: any[] = (out.wheels ?? []).map((w: any) => ({
    ...w,
    spin: Array.isArray(picked) ? picked.includes(String(w.name ?? "")) : true,
  }));
  const area = Number(out.frontal_area_m2 ?? 0);
  const length = Number(out.reference_length_m ?? 0);
  const bbox = out.bbox ?? {};
  const domain = out.domain ?? {};

  await snap.ref.update({
    current_version: version,
    domain_status: "ready",
    domain_error: null,
    [`versions.${version}`]: {
      glb_path: out.paths?.glb ?? null,
      faces_path: out.paths?.faces ?? null,
      solids_path: out.paths?.solids ?? null,
      step_path: out.paths?.step ?? null,
      label_path: out.paths?.labels ?? null,
      // Kept, not dropped. The panel shows which walls were found and how many
      // wheels; without these the only way to know whether the tunnel came out
      // right is to pay for a run.
      bbox,
      domain,
      wheels,
      // The same wheels as they sit on the car, with face indices into the
      // car's own model. The viewer draws the car and never the tunnel - the
      // tunnel's model is a block with a car-shaped hole in it - so this is
      // the list the panel can light up when you hover a wheel. The names
      // match one for one; only the face numbering differs.
      car_wheels: out.car_wheels ?? [],
      labels: out.labels ?? {},
      label_counts: out.label_counts ?? {},
      missing_labels: out.missing_labels ?? [],
      // Faces the worker cannot name to the solver. A boundary condition on
      // one of these fails the run at queue time rather than solving wrongly,
      // which is the right way round - but it is better said here.
      unresolvable_faces: out.unresolvable_faces ?? [],
      // How much of this model is fragments rather than shape. A car whose
      // bodywork is shattered into sub-millimetre patches meshes for ten
      // minutes and is then refused by the solver, one fragment at a time, so
      // it is worth saying before anyone spends a run.
      slivers: out.slivers ?? null,
      kind: "flow_domain",
      symmetry: !!input.symmetry,
      // Where the mirror plane went, and whether the cut was sure. A car
      // with slab sides cannot be told from a half of itself by any measure of
      // its geometry, and the panel says so rather than the run quietly
      // solving a quarter of a car.
      symmetry_plane_y: out.symmetry_plane_y ?? null,
      symmetry_kind: out.symmetry_kind ?? null,
      solid_count: out.solid_count ?? null,
      face_count: out.face_count ?? null,
      triangle_count: out.triangle_count ?? null,
      // The shadow over exactly the width of tunnel that was built. A half
      // tunnel reports half the force and needs half the area with it, or the
      // coefficient comes out at twice what it should be.
      frontal_area_m2: area,
      reference_length_m: length,
      rotated_deg: out.rotated_deg ?? 0,
      unit: out.unit ?? null,
      features: [],
      at: FieldValue.serverTimestamp(),
    },
    updated_at: FieldValue.serverTimestamp(),
  });

  const spec = autoSpec(out.labels ?? {}, wheels, {
    speed: input.speed,
    iterations: input.iterations,
    frontalArea: area,
    referenceLength: length,
    centreOfRotation: momentCentre(bbox, domain),
    rotateWheels: input.rotate_wheels,
    movingGround: input.moving_ground,
  });
  const meshSpec = meshSpecFor(
    out.labels ?? {}, wheels, input.fineness, DEFAULT_MESH_SPEC,
    // The shattered faces, meshed coarsely rather than chased.
    Array.isArray(out.slivers?.faces) ? out.slivers.faces : []);
  const validation = await checkSimulation({
    geometry_id: snap.id, spec, mesh_spec: meshSpec,
  });

  const patch = {
    geometry_id: snap.id,
    geometry_version: version,
    analysis: "INCOMPRESSIBLE",
    spec,
    mesh_spec: meshSpec,
    validation,
    setup_source: "automatic",
    updated_at: FieldValue.serverTimestamp(),
  };

  if (input.simulation_id) {
    const ref = db.collection(COL.simulations).doc(input.simulation_id);
    const existing = await ref.get();
    if (existing.exists && existing.get("user_id") === owner) {
      await ref.update(patch);
      return ref.id;
    }
  }

  // A name that is not already taken in this group.
  //
  // A group holds as many simulations as you like, and this names each one
  // after its car - so importing the same car twice, or two cars exported
  // under the same name, gave two rows reading exactly the same thing with no
  // way to tell which was which.
  const siblings = await db.collection(COL.simulations)
    .where("group_id", "==", input.group_id).get();
  const taken = new Set(siblings.docs.map((d) => String(d.get("name") ?? "")));
  const base = String(snap.get("name") || "Simulation");
  let name = base;
  for (let n = 2; taken.has(name) && n < 500; n += 1) name = `${base} ${n}`;

  const ref = db.collection(COL.simulations).doc();
  await ref.set({
    user_id: owner,
    group_id: input.group_id,
    name,
    primitives: [],
    created_at: FieldValue.serverTimestamp(),
    ...patch,
  });
  return ref.id;
}

/**
 * Where moments are taken about.
 *
 * The middle of the car at road level, which is the convention for a vehicle
 * and the only choice that means the same thing on two different cars. The
 * Fusion path hardcodes (0.1, 0, 0.014), which is right for exactly one model.
 *
 * Across the car it is the mirror plane when there is one, not the middle of
 * what was modelled. Half a tunnel reports half of every force and moment, and
 * the whole car's figures are recovered by doubling. That is exact for drag,
 * lift and pitch wherever the centre sits, and exact for roll and yaw only if
 * the centre is on the plane the car was mirrored about: off it by d, a
 * symmetric car carrying lift L rolls at -2dL instead of not at all, and that
 * is the number the run would report. On a model drawn as half a car the
 * middle of the bounding box is not the plane - it is halfway out to the wheel.
 */
export function momentCentre(bbox: any, domain: any): { x: number; y: number; z: number } {
  const min = Array.isArray(bbox?.min) ? bbox.min : [0, 0, 0];
  const max = Array.isArray(bbox?.max) ? bbox.max : [0, 0, 0];
  const mid = (i: number) => (Number(min[i]) + Number(max[i])) / 2;
  const ground = Number(domain?.ground_z);
  const plane = Number(domain?.symmetry_y);
  return {
    x: round6(mid(0)),
    y: round6(domain?.symmetry && Number.isFinite(plane) ? plane : mid(1)),
    z: round6(Number.isFinite(ground) ? ground : mid(2)),
  };
}

const round6 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : 0);
