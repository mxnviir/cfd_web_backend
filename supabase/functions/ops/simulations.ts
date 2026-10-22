// Creating, saving and checking a simulation. Ported from
// functions/src/simulations/index.ts. `validation` is the server's verdict
// on a setup and no client can write it: saveSimulation sets it, and a
// direct table write is sent back here by a trigger (revalidateSimulation).
import { sql, OpsError, readJson, jsonb } from "../_shared/core.ts";
import { validateSetup } from "../_shared/logic/validate.ts";
import DEFAULT_MODEL from "../_shared/logic/defaultIncompressible.json" with { type: "json" };
import { DEFAULT_MESH_SPEC } from "../_shared/logic/setup.ts";
import type { Ctx } from "./index.ts";

/** "Incompressible", then "Incompressible 1", "Incompressible 2". */
function nextName(taken: Set<string>, base = "Incompressible"): string {
  if (!taken.has(base)) return base;
  for (let n = 1; n < 1000; n += 1) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  return `${base} ${Date.now()}`;
}

/** The owner, or a collaborator with edit. */
export async function mustEditGroup(uid: string, groupId: string) {
  const [g] = await sql`select user_id, shared_with from public.groups where id = ${groupId}`;
  if (!g) throw new OpsError("not-found", "No such group.");
  if (g.user_id !== uid && (g.shared_with ?? {})[uid] !== "edit") {
    throw new OpsError("permission-denied", "You cannot change this group.");
  }
  return g;
}

/** The geometry, if this caller may use it. A stranger is told it does not exist. */
async function mustReachGeometry(uid: string, geometryId: string | null | undefined) {
  if (!geometryId) return;
  const [g] = await sql`
    select g.user_id, gr.user_id as group_owner, gr.shared_with
      from public.geometries g left join public.groups gr on gr.id = g.group_id
     where g.id = ${geometryId}`;
  if (!g) throw new OpsError("not-found", "No such geometry.");
  if (g.user_id === uid || g.group_owner === uid || (g.shared_with ?? {})[uid]) return;
  throw new OpsError("not-found", "No such geometry.");
}

/**
 * Run the checker, with the pinned geometry version's face list: the only
 * way to catch a boundary condition on a face a CAD edit has since removed.
 */
export async function checkSimulation(sim: { geometry_id?: string | null; spec: any; mesh_spec?: any }) {
  let faceIds: Set<number> | null = null;
  let sliverFaces: Set<number> | null = null;
  if (sim.geometry_id) {
    try {
      const [g] = await sql`select current_version, versions from public.geometries where id = ${sim.geometry_id}`;
      const version = (g?.versions ?? {})[String(g?.current_version)];
      if (version?.faces_path) {
        const faces = ((await readJson(version.faces_path)).faces ?? []) as { index: number; area_m2?: number }[];
        faceIds = new Set(faces.map((f) => f.index));
        sliverFaces = new Set(faces.filter((f) => typeof f.area_m2 === "number" && f.area_m2 < 1e-6).map((f) => f.index));
      }
    } catch (err) {
      // A face list that cannot be read must not make the whole setup look
      // invalid; that one check is skipped.
      console.warn(`could not read the face list for ${sim.geometry_id}`, err);
    }
  }
  return validateSetup(sim.spec, {
    geometryId: sim.geometry_id,
    faceIds,
    sliverFaces,
    smallFeatureTolerance: sim.mesh_spec?.advancedSimmetrixSettings?.smallFeatureTolerance?.value ?? null,
    meshFineness: sim.mesh_spec?.sizing?.fineness ?? null,
  });
}

export async function createSimulation({ caller, data }: Ctx) {
  await mustEditGroup(caller.uid, data.group_id);
  await mustReachGeometry(caller.uid, data.geometry_id);
  const siblings = await sql`select name from public.simulations where group_id = ${data.group_id}`;
  const taken = new Set(siblings.map((s) => String(s.name ?? "")));
  const [s] = await sql`
    insert into public.simulations (user_id, group_id, geometry_id, name, analysis, spec, mesh_spec, primitives)
    values (${caller.uid}, ${data.group_id}, ${data.geometry_id ?? null}, ${data.name ?? nextName(taken)},
            'INCOMPRESSIBLE', ${jsonb(DEFAULT_MODEL)}, ${jsonb(DEFAULT_MESH_SPEC)}, '[]')
    returning id`;
  return { simulation_id: s.id };
}

export async function saveSimulation({ caller, data }: Ctx) {
  const [sim] = await sql`select * from public.simulations where id = ${data.simulation_id}`;
  if (!sim) throw new OpsError("not-found", "No such simulation.");
  if (sim.user_id !== caller.uid) await mustEditGroup(caller.uid, sim.group_id);

  // Whatever this save does not carry is taken from what is stored.
  const validation = await checkSimulation({
    geometry_id: sim.geometry_id,
    spec: data.spec ?? sim.spec,
    mesh_spec: data.mesh_spec ?? sim.mesh_spec,
  });
  const patch: Record<string, unknown> = { validation: jsonb(validation) };
  if (data.spec) patch.spec = jsonb(data.spec);
  if (data.mesh_spec) patch.mesh_spec = jsonb(data.mesh_spec);
  if (data.primitives) patch.primitives = jsonb(data.primitives);
  await sql`update public.simulations set ${sql(patch)} where id = ${data.simulation_id}`;
  return validation;
}

/** Called by the simulations trigger after a client wrote a setup directly. */
export async function revalidateSimulation({ data }: Ctx) {
  const [sim] = await sql`select geometry_id, spec, mesh_spec, validation from public.simulations where id = ${data.simulation_id}`;
  if (!sim?.spec) return { ok: true };
  const validation = await checkSimulation(sim as any);
  if (JSON.stringify(validation) !== JSON.stringify(sim.validation)) {
    await sql`update public.simulations set validation = ${jsonb(validation)} where id = ${data.simulation_id}`;
  }
  return { ok: true };
}
