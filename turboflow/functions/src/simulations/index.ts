// Creating, saving and checking a simulation. Build spec 14.5.
//
// Two ways in, on purpose. saveSimulation is the validated path the Save
// button uses. A direct Firestore write is also allowed by the rules, so an
// autosave keeps working when a callable is slow or the tab is closing, and
// onSimulationWritten re-checks whatever landed. The client cannot write
// `validation` either way, so a green tick always means the server said so.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { logger } from "firebase-functions/v2";
import { FieldValue } from "firebase-admin/firestore";
import { db, bucket } from "../lib/admin";
import { COL, REGION } from "../lib/config";
import { guard } from "../lib/guard";
import { createSimulationSchema, saveSimulationSchema } from "./spec";
import { validateSetup } from "./validate";
import DEFAULT_MODEL from "./defaultIncompressible.json";

/**
 * The mesher settings a new simulation starts with. Build spec 14.5.
 */
export const DEFAULT_MESH_SPEC = {
  type: "SIMMETRIX_MESHING_FLUID_V16",
  sizing: {
    type: "AUTOMATIC_V9",
    // 9.5, which is FINENESS[3] in lib/pricing and what the Fusion add-in
    // has meshed every real car with. 5.0 is not on that ladder at all.
    fineness: 9.5,
    curvature: { type: "AUTOMATIC_CURVATURE" },
  },
  refinements: [],
  automaticLayerSettings: { type: "AUTOMATIC_LAYER_ON" },
  physicsBasedMeshing: true,
  hexCore: true,
  /*
   * -1, meaning "let SimScale choose", and now for a measured reason rather
   * than for want of one.
   *
   * Two runs settled it. At -1, a 258 mm car in the standard 1.5 m tunnel at
   * fineness 9.5 reached 32% of the mesh and died with "the machine ran out of
   * memory ... increase the number of computing cores". Asking for 16 cores
   * then died with "the selected number of cores are not available in your
   * current plan", which is the answer to the plan cap this file used to say
   * was unknown: it is below 16.
   *
   * So the machine is not the lever on this plan. The mesh is: fineness is
   * selectable down to 7 in the sidebar, and a mesh that fits needs no special
   * machine. Raise this only against a plan known to allow it.
   */
  numOfProcessors: -1,
  /*
   * Ignore features below half a millimetre.
   *
   * A car exported from CAD carries slivers far smaller than that: the test
   * car had ten faces under 1e-7 m2. The mesher does not skip them, it fails
   * on them ("MSG_MESH_TOO_COARSE ... entities B1_TE495"), and it failed that
   * way at both Coarse and Moderate. SimScale's own first recommendation for
   * that error is this setting.
   *
   * Raised from 0.5 mm to 2 mm on 13 Sep 2026. A real customer car arrived
   * with 342 of its 640 faces under a quarter of a square millimetre, 1,738 of
   * its 3,328 edges under half a millimetre, and 12 edges of no length at all.
   * At 0.5 mm the mesher still refused it: "the mesh element size is too close
   * to the cad tolerance of the following entities", naming one spot on the
   * bodywork, and it refused the same spot again when the mesh was coarsened
   * from 10 to 7.5. The slivers are in the uploaded file, not made here: the
   * proportions are identical before the import and after the cut.
   *
   * 2 mm is a judgement. It is under 1% of a 258 mm car, so it should not
   * touch a wing edge or a fillet that matters, and it is four times the
   * largest sliver measured on that car.
   */
  advancedSimmetrixSettings: { smallFeatureTolerance: { value: 0.002, unit: "m" } },
};

/** "Incompressible", then "Incompressible 1", "Incompressible 2". */
function nextName(taken: Set<string>, base = "Incompressible"): string {
  if (!taken.has(base)) return base;
  for (let n = 1; n < 1000; n += 1) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
  return `${base} ${Date.now()}`;
}

async function mustReachGroup(uid: string, groupId: string) {
  const snap = await db.collection(COL.groups).doc(groupId).get();
  if (!snap.exists) throw new HttpsError("not-found", "No such group.");
  const shared = snap.get("shared_with") ?? {};
  const mine = snap.get("user_id") === uid;
  if (!mine && shared[uid] !== "edit") {
    throw new HttpsError("permission-denied", "You cannot change this group.");
  }
  return snap;
}

// ── create ────────────────────────────────────────────────────────────────
/**
 * The geometry, if this caller may use it.
 *
 * A simulation carries a geometry_id and nothing checked it. Pointing one at
 * another team's car did not get their geometry solved - the worker refuses a
 * step_path outside the job owner's own prefix - but checkSimulation reads the
 * named geometry and its face list with admin credentials, and reports back
 * things like "uses face 12, which this version of the geometry does not
 * have". That confirms the id exists and discloses its faces.
 */
async function mustReachGeometry(uid: string, geometryId: string | null | undefined) {
  if (!geometryId) return;
  const snap = await db.collection(COL.geometries).doc(geometryId).get();
  if (!snap.exists) throw new HttpsError("not-found", "No such geometry.");
  if (snap.get("user_id") === uid) return;
  const groupId = snap.get("group_id");
  const group = groupId ? await db.collection(COL.groups).doc(groupId).get() : null;
  const shared = group?.get("shared_with") ?? {};
  if (!group?.exists || (group.get("user_id") !== uid && !shared[uid])) {
    // Same message as not-found: telling a stranger the id exists is telling
    // them something.
    throw new HttpsError("not-found", "No such geometry.");
  }
}

export const createSimulation = onCall(async (request) => {
  const { uid, data } = await guard(request, "createSimulation", createSimulationSchema);
  await mustReachGroup(uid, data.group_id);
  await mustReachGeometry(uid, data.geometry_id);

  const siblings = await db.collection(COL.simulations)
    .where("group_id", "==", data.group_id).get();
  const taken = new Set(siblings.docs.map((d) => String(d.get("name") ?? "")));

  const ref = db.collection(COL.simulations).doc();
  await ref.set({
    user_id: uid,
    group_id: data.group_id,
    geometry_id: data.geometry_id ?? null,
    name: data.name ?? nextName(taken),
    analysis: "INCOMPRESSIBLE",
    spec: DEFAULT_MODEL,
    mesh_spec: DEFAULT_MESH_SPEC,
    primitives: [],
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp(),
  });
  return { simulation_id: ref.id };
});

// ── save ──────────────────────────────────────────────────────────────────
export const saveSimulation = onCall(async (request) => {
  const { uid, data } = await guard(request, "saveSimulation", saveSimulationSchema);

  const ref = db.collection(COL.simulations).doc(data.simulation_id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No such simulation.");
  if (snap.get("user_id") !== uid) {
    await mustReachGroup(uid, snap.get("group_id"));
  }

  // Whatever this save does not carry, take from what is stored. A mesh-only
  // save still has to be checked against the setup it will run with.
  const validation = await checkSimulation({
    geometry_id: snap.get("geometry_id"),
    spec: data.spec ?? snap.get("spec"),
    mesh_spec: data.mesh_spec ?? snap.get("mesh_spec"),
  });

  await ref.update({
    ...(data.spec ? { spec: data.spec } : {}),
    ...(data.mesh_spec ? { mesh_spec: data.mesh_spec } : {}),
    ...(data.primitives ? { primitives: data.primitives } : {}),
    validation,
    updated_at: FieldValue.serverTimestamp(),
  });
  return validation;
});

/**
 * Run the checker, having first fetched what it needs to check against.
 *
 * The face list is read from the pinned geometry version's faces.json, which
 * is the only way to catch a boundary condition pointing at a face that a
 * CAD edit has since removed. That one is worth the read: the run would
 * otherwise start, mesh, and fail hours later inside SimScale.
 */
export async function checkSimulation(sim: {
  geometry_id?: string | null; spec: any; mesh_spec?: any;
}) {
  let faceIds: Set<number> | null = null;
  // Faces so small the mesher refuses to mesh them. See validate.ts.
  let sliverFaces: Set<number> | null = null;

  if (sim.geometry_id) {
    try {
      const geo = await db.collection(COL.geometries).doc(sim.geometry_id).get();
      const version = geo.get(`versions.${geo.get("current_version")}`);
      if (version?.faces_path) {
        const [buf] = await bucket().file(version.faces_path).download();
        const parsed = JSON.parse(buf.toString("utf8"));
        const faces = (parsed.faces ?? []) as { index: number; area_m2?: number }[];
        faceIds = new Set(faces.map((f) => f.index));
        // The mesher fails outright on a face below its small-feature
        // tolerance, naming an entity id the user cannot look up. Better to
        // say so while they are still assigning faces.
        sliverFaces = new Set(
          faces.filter((f) => typeof f.area_m2 === "number" && f.area_m2 < 1e-6)
            .map((f) => f.index),
        );
      }
    } catch (err) {
      // A missing or unreadable face list must not make the whole setup
      // look invalid. The face-id check is skipped and everything else
      // still runs.
      logger.warn(`could not read the face list for ${sim.geometry_id}`, err);
    }
  }

  return validateSetup(sim.spec, {
    geometryId: sim.geometry_id,
    faceIds,
    sliverFaces,
    smallFeatureTolerance:
      sim.mesh_spec?.advancedSimmetrixSettings?.smallFeatureTolerance?.value ?? null,
    meshFineness: sim.mesh_spec?.sizing?.fineness ?? null,
  });
}

// ── re-check whatever the client wrote ────────────────────────────────────
export const onSimulationWritten = onDocumentWritten(
  { document: `${COL.simulations}/{simulationId}`, region: REGION },
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;

    const before = event.data?.before;
    const spec = after.get("spec");
    if (!spec) return;

    // Only when something the checker looks at actually changed. Without
    // this the trigger's own write of `validation` fires the trigger again,
    // and the pair of them run forever.
    const watched = ["spec", "mesh_spec", "geometry_id"];
    const changed = !before?.exists
      || watched.some((k) => JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k)));
    if (!changed) return;

    const validation = await checkSimulation({
      geometry_id: after.get("geometry_id"),
      spec,
      mesh_spec: after.get("mesh_spec"),
    });

    if (JSON.stringify(after.get("validation")) === JSON.stringify(validation)) return;
    await after.ref.update({ validation });
  },
);
