// Geometry intake: the raw upload, the browser's car import, and the
// browser's tunnel build. Ported from functions/src/geometry.
//
// The browser does the geometry (occt-wasm in a Web Worker); what it is not
// trusted with is choosing paths or writing its own answers. So each build
// is reserve -> upload -> ingest: the server mints the paths and the version
// number (an artifact intent), the page uploads to exactly those paths (the
// storage policy refuses anything else), and the ingest checks the bytes and
// files them as a version.
import { z } from "zod";
import {
  sql, OpsError, objectExists, firstBytes, readJson, writeObject, copyObject, removePrefix, storageUid,
  jsonb,
} from "../_shared/core.ts";
import { autoSpec, meshSpecFor } from "../_shared/logic/autoSpec.ts";
import { docId } from "../_shared/logic/groupSchemas.ts";
import { checkSimulation } from "./simulations.ts";
import { DEFAULT_MESH_SPEC, momentCentre } from "../_shared/logic/setup.ts";
import type { Ctx } from "./index.ts";

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const MAX_RAW_BYTES = 60 * 1024 * 1024;
const FILENAME = { step: "geometry.step", labels: "entity_labels.csv" } as const;
const FORMAT_OF: Record<string, "STEP"> = { step: "STEP", stp: "STEP" };
/** How long a silent page may hold a car on "preparing" or "queued". */
const STALE_INTENT_MS = 15 * 60 * 1000;
const DEFAULT_QUOTA = 5 * 1024 ** 3;

const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

/** Refuse, with a sentence, a reservation that would go over the quota. */
async function mustFit(uid: string, bytes: number) {
  const [u] = await sql`select storage_bytes, storage_quota_bytes from public.users where id = ${uid}`;
  const used = Number(u?.storage_bytes ?? 0);
  const quota = Number(u?.storage_quota_bytes) > 0 ? Number(u.storage_quota_bytes) : DEFAULT_QUOTA;
  if (used + bytes > quota) {
    throw new OpsError("resource-exhausted",
      `This would take you past your ${gb(quota)} GB of storage; you are using ${gb(used)} GB. `
      + "Delete a car you have finished with, or ask us to raise it.");
  }
}

/** Filing a car into a group requires the owner or edit. */
async function mustReachGroup(uid: string, groupId: string | null | undefined) {
  if (!groupId) return;
  const [g] = await sql`select user_id, shared_with from public.groups where id = ${groupId}`;
  if (!g) throw new OpsError("not-found", "No such group.");
  if (g.user_id !== uid && (g.shared_with ?? {})[uid] !== "edit") {
    throw new OpsError("permission-denied", "You cannot add a car to this group.");
  }
}

/** The geometry, if the caller owns it or has edit on its group. */
export async function mustEdit(uid: string, geometryId: string) {
  const [g] = await sql`
    select g.*, gr.user_id as group_owner, gr.shared_with
      from public.geometries g left join public.groups gr on gr.id = g.group_id
     where g.id = ${geometryId}`;
  if (!g) throw new OpsError("not-found", "No such geometry.");
  if (g.user_id !== uid && !(g.group_owner === uid || (g.shared_with ?? {})[uid] === "edit")) {
    throw new OpsError("permission-denied", "That geometry is not yours.");
  }
  return g;
}

/** The newest version that is the car, not a tunnel around it. */
function rawVersionOf(g: any): number {
  const versions = g.versions ?? {};
  return Object.keys(versions).map(Number)
    .filter((n) => Number.isFinite(n) && versions[String(n)]?.kind !== "flow_domain")
    .sort((a, b) => b - a)[0] ?? Number(g.current_version ?? 1);
}

/** The number the next version is filed under. */
function nextVersionOf(g: any): number {
  return Math.max(Number(g.current_version ?? 0), rawVersionOf(g)) + 1;
}

/** Close the newest open intent if it has gone stale; refuse if it is live. */
async function mustNotBeBusy(geometryId: string, kind: "car" | "tunnel", busyMessage: string) {
  const [open] = await sql`
    select token, created_at from public.artifact_intents
     where geometry_id = ${geometryId} and kind = ${kind} and state = 'open'
     order by created_at desc limit 1`;
  if (!open || Date.now() - new Date(open.created_at).getTime() < STALE_INTENT_MS) {
    throw new OpsError("failed-precondition", busyMessage);
  }
  await sql`update public.artifact_intents set state = 'failed', error = 'closed before it finished' where token = ${open.token}`;
}

// ── raw uploads ──────────────────────────────────────────────────────────────
export const createUploadIntentSchema = z.object({
  geometry_id: docId.nullish(),
  group_id: docId.nullish(),
  name: z.string().trim().min(1).max(200),
  size_bytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  kind: z.enum(["step", "labels", "raw"]),
  ext: z.enum(["step", "stp", "iges", "igs", "stl"]).optional(),
  input_unit: z.enum(["m", "cm", "mm", "in", "ft", "yd"]).optional(),
  import_options: z.object({
    facet_split: z.boolean().optional(),
    sewing: z.boolean().optional(),
    improve: z.boolean().optional(),
  }).optional(),
});

export async function createUploadIntent({ caller, data }: Ctx) {
  await mustReachGroup(caller.uid, data.group_id);
  await mustFit(caller.uid, data.size_bytes);
  const suid = await storageUid(caller.uid);

  let id: string = data.geometry_id;
  if (id) {
    const [g] = await sql`select user_id from public.geometries where id = ${id}`;
    if (!g) throw new OpsError("not-found", "That geometry does not exist.");
    if (g.user_id !== caller.uid) throw new OpsError("permission-denied", "That geometry is not yours.");
  } else {
    id = (await sql`select public.gen_id() as id`)[0].id;
  }

  if (data.kind === "raw") {
    if (!data.ext) throw new OpsError("invalid-argument", "Say which kind of file this is.");
    if (!FORMAT_OF[data.ext]) {
      throw new OpsError("invalid-argument", "TurboFlow reads STEP files. Export your model as STEP and try again.");
    }
    if (data.size_bytes > MAX_RAW_BYTES) {
      throw new OpsError("invalid-argument",
        `That file is ${Math.round(data.size_bytes / 1048576)} MB. The limit is 60 MB.`);
    }
    const path = `users/${suid}/geometries/${id}/raw.${data.ext}`;
    const importOptions = {
      facet_split: data.import_options?.facet_split ?? true,
      sewing: data.import_options?.sewing ?? true,
      improve: data.import_options?.improve ?? true,
    };
    // A re-upload to an existing geometry keeps its versions: overwriting
    // them would orphan every tunnel and every run pinned to one.
    await sql`
      insert into public.geometries (id, user_id, group_id, name, format, input_unit, import_options,
                                     raw_path, size_bytes, status, error, prepared_by)
      values (${id}, ${caller.uid}, ${data.group_id ?? null}, ${data.name}, ${FORMAT_OF[data.ext]},
              ${data.input_unit ?? "mm"}, ${jsonb(importOptions)}, ${path}, ${data.size_bytes},
              'uploading', null, 'workbench')
      on conflict (id) do update
        set group_id = excluded.group_id, name = excluded.name, format = excluded.format,
            input_unit = excluded.input_unit, import_options = excluded.import_options,
            raw_path = excluded.raw_path, size_bytes = excluded.size_bytes,
            status = 'uploading', error = null, prepared_by = 'workbench'`;
    return { geometry_id: id, path, max_bytes: MAX_RAW_BYTES };
  }

  const path = `users/${suid}/geometries/${id}/${FILENAME[data.kind as "step" | "labels"]}`;
  await sql`
    insert into public.geometries (id, user_id, group_id, name, size_bytes, step_path, label_path)
    values (${id}, ${caller.uid}, ${data.group_id ?? null}, ${data.name}, ${data.size_bytes},
            ${data.kind === "step" ? path : null}, ${data.kind === "labels" ? path : null})
    on conflict (id) do update
      set group_id = excluded.group_id, name = excluded.name, size_bytes = excluded.size_bytes,
          step_path = coalesce(excluded.step_path, public.geometries.step_path),
          label_path = coalesce(excluded.label_path, public.geometries.label_path)`;
  return { geometry_id: id, path, max_bytes: MAX_UPLOAD_BYTES };
}

// ── shared shapes ────────────────────────────────────────────────────────────
export const wheelSchema = z.object({
  name: z.string().max(40),
  radius_m: z.number(),
  cx_m: z.number(),
  cy_m: z.number(),
  cz_m: z.number(),
  y_lo_m: z.number(),
  y_hi_m: z.number(),
  face_indices: z.array(z.number().int().min(0)).max(20000),
  source: z.string().max(20),
});

const bboxSchema = z.object({
  min: z.array(z.number()).length(3),
  max: z.array(z.number()).length(3),
  size: z.array(z.number()).length(3),
});

const domainSchema = z.object({
  outlet_x: z.number(),
  inlet_x: z.number(),
  ground_z: z.number(),
  top_z: z.number(),
  side_y: z.number(),
  symmetry_y: z.number(),
  symmetry: z.boolean(),
});

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const failSchema = z.object({
  geometry_id: docId,
  token: tokenSchema.nullish(),
  error: z.string().max(600).nullish(),
});

/** Check what the page uploaded against what was reserved, and read the JSON. */
async function verifyArtifacts(
  uid: string, geometryId: string, artifacts: Record<string, string>, keys: readonly string[], noun: string,
) {
  const suid = await storageUid(uid);
  const match = /^users\/([^/]+)\/geometries\/([^/]+)\/incoming\/([A-Za-z0-9_-]{8,64})\//.exec(artifacts.step ?? "");
  if (!match || match[1] !== suid || match[2] !== geometryId) {
    throw new OpsError("invalid-argument", `These are not this car's ${noun} files.`);
  }
  const token = match[3];
  const [intent] = await sql`select * from public.artifact_intents where token = ${token}`;
  if (!intent) {
    throw new OpsError("not-found", `The ${noun} this upload belongs to is no longer known. Start it again.`);
  }
  if (intent.user_id !== uid) throw new OpsError("permission-denied", `That ${noun} is not yours.`);
  if (["failed", "cancelled"].includes(intent.state)) {
    throw new OpsError("failed-precondition", `This ${noun} was closed before it finished. Start it again.`);
  }
  for (const k of keys) {
    if (String(intent.paths?.[k] ?? "") !== artifacts[k]) {
      throw new OpsError("invalid-argument", "These are not the files that were reserved.");
    }
  }
  const version = Number(intent.version);
  const [g] = await sql`select * from public.geometries where id = ${geometryId}`;
  if (g.versions?.[String(version)]?.kind != null) {
    // A double-click, a retry, a second tab: the version is already there.
    throw new OpsError("already-exists", `This ${noun} has already been filed. Start it again to replace it.`);
  }
  for (const k of keys) {
    if (!(await objectExists(artifacts[k]))) {
      throw new OpsError("failed-precondition", `Part of the ${noun} (${k}) did not arrive. Start it again.`);
    }
  }
  if (new TextDecoder("latin1").decode(await firstBytes(artifacts.glb, 4)) !== "glTF") {
    throw new OpsError("failed-precondition", `The ${noun} model is not a GLB. Start it again.`);
  }
  let facesDoc: any;
  let solidsDoc: any;
  try {
    facesDoc = await readJson(artifacts.faces);
    solidsDoc = await readJson(artifacts.solids);
  } catch {
    throw new OpsError("failed-precondition", `The ${noun}'s face list is not readable. Start it again.`);
  }
  if (!Array.isArray(facesDoc?.faces) || !Array.isArray(facesDoc?.adjacency) || !Array.isArray(solidsDoc?.solids)) {
    throw new OpsError("failed-precondition", `The ${noun}'s face list is not readable. Start it again.`);
  }
  facesDoc.version = version;
  solidsDoc.version = version;
  return { token, version, suid, geometry: g, facesDoc, solidsDoc };
}

async function failIntent(uid: string, data: any, liveStatuses: string[], column: "status" | "domain_status",
  errorColumn: "error" | "domain_error", fallback: string) {
  const g = await mustEdit(uid, data.geometry_id);
  if (data.token) {
    const rows = await sql`update public.artifact_intents set state = 'failed', error = ${(data.error ?? "").slice(0, 600)}
                           where token = ${data.token} and geometry_id = ${data.geometry_id} returning token`;
    if (!rows.length) throw new OpsError("not-found", "No such build.");
  }
  // Only while it is live: a late failure from a stray tab must not
  // overwrite an answer the geometry already has.
  if (liveStatuses.includes(String(g[column]))) {
    await sql`update public.geometries set ${sql({ [column]: "failed", [errorColumn]: (data.error || fallback).slice(0, 600) })}
              where id = ${data.geometry_id}`;
  }
  return { ok: true };
}

// ── the car import ───────────────────────────────────────────────────────────
export const createCarIntentSchema = z.object({
  geometry_id: docId,
  group_id: docId.nullish(),
  reserve_bytes: z.number().int().min(0).max(1024 ** 3),
});

export async function createCarIntent({ caller, data }: Ctx) {
  const g = await mustEdit(caller.uid, data.geometry_id);
  if (g.status === "ready") {
    throw new OpsError("failed-precondition", "This car has already been imported. Re-upload it to import it again.");
  }
  if (!["uploading", "queued", "failed"].includes(g.status)) {
    throw new OpsError("failed-precondition", "This geometry is not waiting to be imported.");
  }
  if (g.status === "queued") await mustNotBeBusy(g.id, "car", "This car is already being imported.");
  await mustFit(caller.uid, data.reserve_bytes);

  const suid = await storageUid(caller.uid);
  const version = nextVersionOf(g);
  const token = crypto.randomUUID().replaceAll("-", "");
  const dir = `users/${suid}/geometries/${g.id}/incoming/${token}`;
  const paths = {
    step: `${dir}/geometry.step`, glb: `${dir}/model.glb`, faces: `${dir}/faces.json`,
    solids: `${dir}/solids.json`, thumb: `${dir}/thumb.png`,
  };
  await sql.begin(async (tx) => {
    await tx`insert into public.artifact_intents (token, geometry_id, user_id, group_id, kind, version, reserve_bytes, paths)
             values (${token}, ${g.id}, ${caller.uid}, ${data.group_id ?? null}, 'car', ${version},
                     ${data.reserve_bytes}, ${jsonb(paths)})`;
    await tx`update public.geometries set status = 'queued', error = null where id = ${g.id}`;
  });
  return { token, version, paths };
}

export const ingestCarSchema = z.object({
  geometry_id: docId,
  artifacts: z.object({
    step: z.string(), glb: z.string(), faces: z.string(), solids: z.string(), thumb: z.string().nullish(),
  }),
  meta: z.object({
    bbox: bboxSchema,
    domain: domainSchema,
    unit: z.string().max(8),
    scale_to_m: z.number(),
    wheels: z.array(wheelSchema).max(20),
    frontal_area_m2: z.number().min(0),
    frontal_area_half_m2: z.number().min(0),
    rotated_deg: z.number(),
    face_count: z.number().int().min(0),
    solid_count: z.number().int().min(0),
    triangle_count: z.number().int().min(0),
  }),
});

export async function ingestCar({ caller, data }: Ctx) {
  await mustEdit(caller.uid, data.geometry_id);
  const { token, version, suid, geometry, facesDoc, solidsDoc } = await verifyArtifacts(
    caller.uid, data.geometry_id, data.artifacts, ["step", "glb", "faces", "solids"], "import");

  const dest = `users/${suid}/geometries/${data.geometry_id}/v${version}`;
  const finalPaths = {
    step: `${dest}/geometry.step`, glb: `${dest}/model.glb`, faces: `${dest}/faces.json`,
    solids: `${dest}/solids.json`, thumb: `${dest}/thumb.png`,
  };
  await copyObject(data.artifacts.step, finalPaths.step);
  await copyObject(data.artifacts.glb, finalPaths.glb);
  await writeObject(finalPaths.faces, JSON.stringify(facesDoc), "application/json");
  await writeObject(finalPaths.solids, JSON.stringify(solidsDoc), "application/json");
  let thumbPath: string | null = null;
  if (data.artifacts.thumb && await objectExists(data.artifacts.thumb)) {
    await copyObject(data.artifacts.thumb, finalPaths.thumb);
    thumbPath = finalPaths.thumb;
  }

  const meta = data.meta;
  await sql.begin(async (tx) => {
    await tx`insert into public.geometry_versions (geometry_id, version, user_id, data)
             values (${data.geometry_id}, ${version}, ${geometry.user_id}, ${jsonb({
      glb_path: finalPaths.glb, faces_path: finalPaths.faces, solids_path: finalPaths.solids,
      step_path: finalPaths.step, thumb_path: thumbPath,
      bbox: meta.bbox, wheels: meta.wheels, domain: meta.domain, kind: "raw",
      solid_count: meta.solid_count, face_count: meta.face_count, triangle_count: meta.triangle_count,
      frontal_area_m2: meta.frontal_area_m2, frontal_area_half_m2: meta.frontal_area_half_m2,
      reference_length_m: meta.bbox.size[0], rotated_deg: meta.rotated_deg, unit: meta.unit,
      features: [], at: new Date().toISOString(),
    })})`;
    await tx`update public.geometries set current_version = ${version}, status = 'ready', error = null
             where id = ${data.geometry_id}`;
    await tx`update public.artifact_intents set state = 'ingested', ingested_at = now() where token = ${token}`;
  });
  await removePrefix(`users/${suid}/geometries/${data.geometry_id}/incoming/${token}/`);
  return { ok: true, version };
}

export async function failCarImport({ caller, data }: Ctx) {
  return failIntent(caller.uid, failSchema.parse(data), ["uploading", "queued"], "status", "error",
    "This car could not be imported.");
}

// ── the tunnel ───────────────────────────────────────────────────────────────
/** What a person chooses about the tunnel; everything else comes from the car. */
export const prepareDomainSchema = z.object({
  geometry_id: docId,
  group_id: docId,
  simulation_id: docId.nullish(),
  symmetry: z.boolean().default(true),
  speed: z.number().min(1).max(100).default(20),
  iterations: z.number().int().min(100).max(3000).default(1000),
  fineness: z.number().min(0).max(10).default(9.5),
  upstream_m: z.number().min(0.05).max(50).default(1.5),
  downstream_m: z.number().min(0.05).max(50).default(0.5),
  side_m: z.number().min(0.01).max(10).default(0.3),
  top_m: z.number().min(0.01).max(10).default(0.3),
  wheel_radius_m: z.number().min(0.001).max(1).default(0.014125),
  rear_wheel_radius_m: z.number().min(0.001).max(1).nullish(),
  wheel_tolerance: z.number().min(0).max(0.5).default(0.08),
  rotate_wheels: z.boolean().default(true),
  spin_wheels: z.array(z.string().max(40)).max(20).nullish(),
  moving_ground: z.boolean().default(true),
  wheels: z.array(z.object({
    name: z.string().max(40).optional(),
    radius_m: z.number().min(0.001).max(1),
    cx_m: z.number(), cy_m: z.number(), cz_m: z.number(),
    face_indices: z.array(z.number().int().min(0)).max(5000).optional(),
  })).max(20).nullish(),
});

export const createArtifactIntentSchema = prepareDomainSchema.extend({
  reserve_bytes: z.number().int().min(0).max(1024 ** 3),
});

export async function createArtifactIntent({ caller, data }: Ctx) {
  const g = await mustEdit(caller.uid, data.geometry_id);
  if (g.status !== "ready") {
    throw new OpsError("failed-precondition",
      "This geometry is still being read. Wait for it to finish, then set up the tunnel.");
  }
  if (g.domain_status === "preparing") {
    await mustNotBeBusy(g.id, "tunnel", "A wind tunnel is already being built for this car.");
  }
  await mustFit(caller.uid, data.reserve_bytes);

  const suid = await storageUid(caller.uid);
  const version = nextVersionOf(g);
  const token = crypto.randomUUID().replaceAll("-", "");
  const dir = `users/${suid}/geometries/${g.id}/incoming/${token}`;
  const paths = {
    step: `${dir}/geometry.step`, labels: `${dir}/entity_labels.csv`, glb: `${dir}/geometry.glb`,
    faces: `${dir}/faces.json`, solids: `${dir}/solids.json`,
  };
  const options = {
    symmetry: data.symmetry, speed: data.speed, iterations: data.iterations, fineness: data.fineness,
    upstream_m: data.upstream_m, downstream_m: data.downstream_m, side_m: data.side_m, top_m: data.top_m,
    wheel_radius_m: data.wheel_radius_m, rear_wheel_radius_m: data.rear_wheel_radius_m ?? null,
    wheel_tolerance: data.wheel_tolerance, rotate_wheels: data.rotate_wheels,
    spin_wheels: data.spin_wheels ?? null, moving_ground: data.moving_ground,
  };
  await sql.begin(async (tx) => {
    await tx`insert into public.artifact_intents (token, geometry_id, user_id, group_id, kind, version, reserve_bytes, paths)
             values (${token}, ${g.id}, ${caller.uid}, ${data.group_id}, 'tunnel', ${version},
                     ${data.reserve_bytes}, ${jsonb(paths)})`;
    await tx`update public.geometries set domain_status = 'preparing', domain_error = null,
             domain_options = ${jsonb(options)} where id = ${g.id}`;
  });
  return { token, version, paths };
}

const metaSchema = z.object({
  bbox: bboxSchema,
  domain: domainSchema,
  unit: z.string().max(8),
  labels: z.record(z.string(), z.array(z.number().int()).max(20000)),
  label_counts: z.record(z.string(), z.number().int()),
  missing_labels: z.array(z.string().max(40)),
  wheels: z.array(wheelSchema).max(20),
  car_wheels: z.array(wheelSchema).max(20),
  unresolvable_faces: z.array(z.number().int().min(0)).max(50),
  slivers: z.object({
    count: z.number().int().min(0),
    of: z.number().int().min(0),
    threshold_m2: z.number().nullish(),
    worst_band_m: z.array(z.number()).length(2).nullish(),
    worst_band_count: z.number().int().min(0).nullish(),
    smallest_m2: z.number().nullish(),
    faces: z.array(z.number().int().min(0)),
  }).nullish(),
  symmetry_plane_y: z.number().nullish(),
  symmetry_kind: z.string().max(20).nullish(),
  solid_count: z.number().int().min(0).nullish(),
  face_count: z.number().int().min(0),
  triangle_count: z.number().int().min(0),
  rotated_deg: z.number(),
  frontal_area_m2: z.number().min(0),
  reference_length_m: z.number().min(0),
  void_count: z.number().int().min(0).nullish(),
  void_volumes_m3: z.array(z.number()).nullish(),
  demoted_wheel_faces: z.number().int().min(0).nullish(),
  cut_note: z.string().max(2000).nullish(),
});

export const ingestPreparedDomainSchema = prepareDomainSchema.extend({
  artifacts: z.object({ step: z.string(), labels: z.string(), glb: z.string(), faces: z.string(), solids: z.string() }),
  meta: metaSchema,
});

export async function ingestPreparedDomain({ caller, data }: Ctx) {
  await mustEdit(caller.uid, data.geometry_id);
  const { token, version, suid, geometry, facesDoc, solidsDoc } = await verifyArtifacts(
    caller.uid, data.geometry_id, data.artifacts, ["step", "labels", "glb", "faces", "solids"], "tunnel");

  const dest = `users/${suid}/geometries/${data.geometry_id}/v${version}`;
  const finalPaths = {
    step: `${dest}/geometry.step`, labels: `${dest}/entity_labels.csv`, glb: `${dest}/geometry.glb`,
    faces: `${dest}/faces.json`, solids: `${dest}/solids.json`,
  };
  await copyObject(data.artifacts.step, finalPaths.step);
  await copyObject(data.artifacts.labels, finalPaths.labels);
  await copyObject(data.artifacts.glb, finalPaths.glb);
  await writeObject(finalPaths.faces, JSON.stringify(facesDoc), "application/json");
  await writeObject(finalPaths.solids, JSON.stringify(solidsDoc), "application/json");

  const simulationId = await writeSetup(geometry, data, { ...data.meta, paths: finalPaths, version });
  await sql`update public.artifact_intents set state = 'ingested', ingested_at = now() where token = ${token}`;
  await removePrefix(`users/${suid}/geometries/${data.geometry_id}/incoming/${token}/`);
  return { ok: true, version, simulation_id: simulationId };
}

export async function failDomainBuild({ caller, data }: Ctx) {
  return failIntent(caller.uid, failSchema.parse(data), ["preparing"], "domain_status", "domain_error",
    "The wind tunnel was not built.");
}

/**
 * The tunnel as a version, and the setup built from it as a simulation.
 * The version is filed and made current first, because the simulation points
 * at whatever is current and the run reads its STEP from there.
 */
async function writeSetup(geometry: any, input: any, out: any): Promise<string> {
  const version = out.version as number;
  const picked = input.spin_wheels;
  const wheels = (out.wheels ?? []).map((w: any) => ({
    ...w, spin: Array.isArray(picked) ? picked.includes(String(w.name ?? "")) : true,
  }));
  const area = Number(out.frontal_area_m2 ?? 0);
  const length = Number(out.reference_length_m ?? 0);
  const bbox = out.bbox ?? {};
  const domain = out.domain ?? {};

  await sql.begin(async (tx) => {
    await tx`insert into public.geometry_versions (geometry_id, version, user_id, data)
             values (${geometry.id}, ${version}, ${geometry.user_id}, ${jsonb({
      glb_path: out.paths?.glb ?? null, faces_path: out.paths?.faces ?? null,
      solids_path: out.paths?.solids ?? null, step_path: out.paths?.step ?? null,
      label_path: out.paths?.labels ?? null,
      bbox, domain, wheels, car_wheels: out.car_wheels ?? [],
      labels: out.labels ?? {}, label_counts: out.label_counts ?? {}, missing_labels: out.missing_labels ?? [],
      unresolvable_faces: out.unresolvable_faces ?? [], slivers: out.slivers ?? null,
      kind: "flow_domain", symmetry: !!input.symmetry,
      symmetry_plane_y: out.symmetry_plane_y ?? null, symmetry_kind: out.symmetry_kind ?? null,
      solid_count: out.solid_count ?? null, face_count: out.face_count ?? null,
      triangle_count: out.triangle_count ?? null,
      frontal_area_m2: area, reference_length_m: length, rotated_deg: out.rotated_deg ?? 0,
      unit: out.unit ?? null, features: [], at: new Date().toISOString(),
    })})`;
    await tx`update public.geometries set current_version = ${version}, domain_status = 'ready', domain_error = null
             where id = ${geometry.id}`;
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
  const meshSpec = meshSpecFor(out.labels ?? {}, wheels, input.fineness, DEFAULT_MESH_SPEC,
    Array.isArray(out.slivers?.faces) ? out.slivers.faces : []);
  const validation = await checkSimulation({ geometry_id: geometry.id, spec, mesh_spec: meshSpec });

  const patch = {
    geometry_id: geometry.id,
    geometry_version: version,
    analysis: "INCOMPRESSIBLE",
    spec: jsonb(spec as object),
    mesh_spec: jsonb(meshSpec as object),
    validation: jsonb(validation),
    setup_source: "automatic",
  };
  if (input.simulation_id) {
    const rows = await sql`update public.simulations set ${sql(patch)}
                           where id = ${input.simulation_id} and user_id = ${geometry.user_id} returning id`;
    if (rows.length) return rows[0].id;
  }
  // A name not already taken in this group.
  const siblings = await sql`select name from public.simulations where group_id = ${input.group_id}`;
  const taken = new Set(siblings.map((s) => String(s.name ?? "")));
  const base = String(geometry.name || "Simulation");
  let name = base;
  for (let n = 2; taken.has(name) && n < 500; n += 1) name = `${base} ${n}`;
  const [s] = await sql`insert into public.simulations ${sql({
    ...patch, user_id: geometry.user_id, group_id: input.group_id, name, primitives: jsonb([]),
  })} returning id`;
  return s.id;
}
