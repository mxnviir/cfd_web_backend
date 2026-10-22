// Groups: create, update, delete, copy, share. Ported from
// functions/src/groups/index.ts. Database records only - nothing here runs
// or charges anything. Delete and copy also touch Storage, Postgres first.
import { sql, OpsError, removePrefix, listPrefix, copyObject, storageUid, jsonb } from "../_shared/core.ts";
import { DEFAULT_CATEGORY } from "../_shared/logic/groupSchemas.ts";
import type { Ctx } from "./index.ts";

/** The group, if the caller owns it. A stranger is told it does not exist. */
async function mustOwn(uid: string, groupId: string) {
  const [g] = await sql`select * from public.groups where id = ${groupId}`;
  if (!g || g.user_id !== uid) throw new OpsError("not-found", "That group does not exist.");
  return g;
}

export async function createGroup({ caller, data }: Ctx) {
  const [g] = await sql`
    insert into public.groups (user_id, name, description, category, tags, unit_system, counts)
    values (${caller.uid}, ${data.name}, ${data.description ?? ""}, ${data.category ?? DEFAULT_CATEGORY},
            ${jsonb(data.tags ?? [])}, ${data.unit_system ?? "SI"},
            ${jsonb({ geometries: 0, simulations: 0, runs: 0 })})
    returning id`;
  return { group_id: g.id };
}

export async function updateGroup({ caller, data }: Ctx) {
  await mustOwn(caller.uid, data.group_id);
  const patch: Record<string, unknown> = {};
  for (const k of ["name", "description", "category", "unit_system"] as const) {
    if (data[k] !== undefined) patch[k] = data[k];
  }
  if (data.tags !== undefined) patch.tags = jsonb(data.tags);
  if (Object.keys(patch).length) await sql`update public.groups set ${sql(patch)} where id = ${data.group_id}`;
  return { ok: true };
}

export async function deleteGroup({ caller, data }: Ctx) {
  await mustOwn(caller.uid, data.group_id);
  const runs = await sql`select id, job_id, status from public.runs where group_id = ${data.group_id}`;
  // A run SimScale is still working on has been paid for. Deleting the group
  // would orphan it.
  const busy = runs.filter((r) => !["finished", "failed", "cancelled"].includes(String(r.status)));
  if (busy.length) {
    throw new OpsError("failed-precondition",
      `Cancel running jobs first. ${busy.length} ${busy.length === 1 ? "run is" : "runs are"} still going.`);
  }
  const geoms = await sql`select id from public.geometries where group_id = ${data.group_id}`;
  const deleted = await sql.begin(async (tx) => {
    const g = await tx`delete from public.geometries where group_id = ${data.group_id} returning id`;
    const s = await tx`delete from public.simulations where group_id = ${data.group_id} returning id`;
    const r = await tx`delete from public.runs where group_id = ${data.group_id} returning id`;
    await tx`delete from public.groups where id = ${data.group_id}`;
    return { geometries: g.length, simulations: s.length, runs: r.length };
  });
  // Storage after Postgres: orphaned bytes cost pennies; rows pointing at
  // files that are gone look like lost work.
  const suid = await storageUid(caller.uid);
  for (const g of geoms) await removePrefix(`users/${suid}/geometries/${g.id}/`);
  for (const r of runs) await removePrefix(`users/${suid}/results/${r.job_id ?? r.id}/`);
  return { ok: true, deleted };
}

/** Path fields pointed at the copy's own folder. */
function swap(v: unknown, oldId: string, newId: string): unknown {
  if (typeof v === "string") return v.replace(`/geometries/${oldId}/`, `/geometries/${newId}/`);
  if (Array.isArray(v)) return v.map((x) => swap(x, oldId, newId));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x, oldId, newId)]));
  }
  return v;
}

export async function copyGroup({ caller, data }: Ctx) {
  const source = await mustOwn(caller.uid, data.group_id);
  const geoms = await sql`select * from public.geometries where group_id = ${data.group_id}`;
  const sims = await sql`select * from public.simulations where group_id = ${data.group_id}`;
  const geomIds = new Map<string, string>();

  const newGroup = await sql.begin(async (tx) => {
    const [g] = await tx`
      insert into public.groups (user_id, name, description, category, tags, unit_system, thumbnail_path, counts)
      values (${caller.uid}, ${data.name ?? `${source.name} copy`}, ${source.description}, ${source.category},
              ${jsonb(source.tags ?? [])}, ${source.unit_system}, ${source.thumbnail_path},
              ${jsonb({ geometries: geoms.length, simulations: sims.length, runs: 0 })})
      returning id`;
    for (const geo of geoms) {
      const [n] = await tx`select public.gen_id() as id`;
      geomIds.set(geo.id, n.id);
      const paths: Record<string, unknown> = {};
      for (const k of ["raw_path", "step_path", "label_path", "glb_path", "source_step_path"]) {
        paths[k] = swap(geo[k], geo.id, n.id);
      }
      await tx`
        insert into public.geometries
          (id, user_id, group_id, name, description, format, input_unit, import_options, raw_path, step_path,
           label_path, glb_path, source_step_path, prepared_by, size_bytes, status, error, current_version,
           domain_status, domain_error, domain_options, bbox, face_count, solid_count, triangle_count, wheel_count)
        values
          (${n.id}, ${caller.uid}, ${g.id}, ${geo.name}, ${geo.description}, ${geo.format}, ${geo.input_unit},
           ${geo.import_options ? jsonb(geo.import_options) : null}, ${paths.raw_path as string}, ${paths.step_path as string},
           ${paths.label_path as string}, ${paths.glb_path as string}, ${paths.source_step_path as string}, ${geo.prepared_by},
           ${geo.size_bytes}, ${geo.status}, ${geo.error}, ${geo.current_version}, ${geo.domain_status}, ${geo.domain_error},
           ${geo.domain_options ? jsonb(geo.domain_options) : null}, ${geo.bbox ? jsonb(geo.bbox) : null},
           ${geo.face_count}, ${geo.solid_count}, ${geo.triangle_count}, ${geo.wheel_count})`;
      const versions = await tx`select version, data from public.geometry_versions where geometry_id = ${geo.id}`;
      for (const v of versions) {
        await tx`insert into public.geometry_versions (geometry_id, version, user_id, data)
                 values (${n.id}, ${v.version}, ${caller.uid}, ${jsonb(swap(v.data, geo.id, n.id) as object)})`;
      }
    }
    for (const s of sims) {
      // A copy has never been validated or run.
      await tx`
        insert into public.simulations
          (user_id, group_id, geometry_id, geometry_version, name, analysis, spec, mesh_spec, setup, primitives, setup_source)
        values
          (${caller.uid}, ${g.id}, ${s.geometry_id ? geomIds.get(s.geometry_id) ?? null : null}, ${s.geometry_version},
           ${s.name}, ${s.analysis}, ${s.spec ? jsonb(s.spec) : null}, ${s.mesh_spec ? jsonb(s.mesh_spec) : null},
           ${s.setup ? jsonb(s.setup) : null}, ${jsonb(s.primitives ?? [])}, ${s.setup_source})`;
    }
    return g.id as string;
  });

  // Server-side copies: the bytes never come through here.
  const suid = await storageUid(caller.uid);
  for (const [oldId, newId] of geomIds) {
    const from = `users/${suid}/geometries/${oldId}/`;
    for (const name of await listPrefix(from)) {
      try {
        await copyObject(name, `users/${suid}/geometries/${newId}/${name.slice(from.length)}`);
      } catch (err) {
        console.warn(`could not copy ${name}`, err);
      }
    }
  }
  return { group_id: newGroup };
}

export async function shareGroup({ caller, data }: Ctx) {
  await mustOwn(caller.uid, data.group_id);
  const [target] = await sql`select id, email from auth.users where lower(email) = lower(${data.email}) limit 1`;
  // No account answers `pending` and says nothing more: this is not a way
  // to find out who has an account.
  if (!target) return { uid: null, email: data.email, permission: data.permission, pending: true };
  if (target.id === caller.uid) throw new OpsError("invalid-argument", "That is your own account.");
  await sql`
    update public.groups
       set shared_with = shared_with || ${jsonb({ [target.id]: data.permission })},
           shared_emails = shared_emails || ${jsonb({ [target.id]: target.email ?? data.email })}
     where id = ${data.group_id}`;
  return { uid: target.id, email: target.email ?? data.email, permission: data.permission };
}

export async function unshareGroup({ caller, data }: Ctx) {
  await mustOwn(caller.uid, data.group_id);
  await sql`
    update public.groups
       set shared_with = shared_with - ${data.uid}::text, shared_emails = shared_emails - ${data.uid}::text
     where id = ${data.group_id}`;
  return { ok: true };
}
