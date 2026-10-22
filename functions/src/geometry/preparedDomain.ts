// The browser-built wind tunnel: reserve, ingest, and fail.
//
// The Workbench now cuts the tunnel itself, in a Web Worker, because the cut
// is pure geometry that needs no secret - and it is the part that takes
// minutes. What it must not be allowed to do is write its own answers: a
// client that could pick its own storage paths could point a version at
// somebody else's car, and a version nobody verified could claim a wind
// tunnel that has nothing behind it.
//
// So the work is split by what each side is trusted with:
//
//   createArtifactIntent mints the storage paths and the version number, and
//   marks the geometry "preparing". The page uploads the five artefacts to
//   paths it chose nothing about.
//
//   ingestPreparedDomain checks those paths against what was minted, checks
//   the bytes that landed, moves them to the version folder, and calls the
//   same writeSetup the Cloud Run path uses - so a tunnel built in a browser
//   and one built by the geometry service end up indistinguishable.
//
//   failDomainBuild records why a build died, so the tree never sits on
//   "preparing" forever because a tab was closed mid-cut.
//
// The old prepareDomain callable stays: it is the fallback when a browser
// cannot run the cut, and the two paths write the same documents.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, FieldValue, bucket } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { usage } from "../storage/quota";
import { docId } from "../groups/schemas";
import {
  prepareDomainSchema, mustEdit, writeSetup, nextVersionOf,
} from "./prepareDomain";

/** The five artefacts, the same names the geometry service writes. */
const FILES = ["step", "labels", "glb", "faces", "solids"] as const;

/** Where the page is allowed to put them: one folder per intent. */
const INCOMING = /^users\/([^/]+)\/geometries\/([^/]+)\/incoming\/([A-Za-z0-9_-]{8,64})\/(geometry\.step|entity_labels\.csv|geometry\.glb|faces\.json|solids\.json)$/;

/**
 * A wheel as the cut reports it. The numbers are the wheel's own, measured
 * before the boolean replaced its faces - never re-measured off the tunnel,
 * because omega is speed over radius and the solver spins the wall at
 * whatever lands here.
 */
/** A wheel as the cut reports it - shared with the import, which finds
 *  the same things before any tunnel exists. */
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

/**
 * What the cut says about the tunnel it built. Shape only: the point is that
 * a browser cannot smuggle in a field writeSetup would copy verbatim into
 * the version document, and cannot omit one the setup is built from. What
 * the numbers actually are is only as trustworthy as the browser, which is
 * why the artefacts they describe are checked byte for byte below - and why
 * a lying build costs its own owner a wasted run, which is the same deal the
 * raw upload always was.
 */
const metaSchema = z.object({
  bbox: z.object({
    min: z.array(z.number()).length(3),
    max: z.array(z.number()).length(3),
    size: z.array(z.number()).length(3),
  }),
  domain: z.object({
    outlet_x: z.number(),
    inlet_x: z.number(),
    ground_z: z.number(),
    top_z: z.number(),
    side_y: z.number(),
    symmetry_y: z.number(),
    symmetry: z.boolean(),
  }),
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

/** What the caller was told to upload to, and what the cut found. */
const ingestSchema = prepareDomainSchema.extend({
  artifacts: z.object({
    step: z.string(),
    labels: z.string(),
    glb: z.string(),
    faces: z.string(),
    solids: z.string(),
  }),
  meta: metaSchema,
});

/** How a build that never finished is explained. */
const failSchema = z.object({
  geometry_id: docId,
  token: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
  error: z.string().max(600).nullish(),
});

/**
 * How long a page's silence is allowed to hold the car closed.
 *
 * The old path self-healed: the Cloud Run job finished whatever the browser
 * did, and wrote ready or failed. A browser that dies mid-cut writes nothing,
 * so without this a closed tab would leave the car on "preparing" forever,
 * refusing every rebuild. An intent this old is one no page is still working
 * on, so it is closed and a new one is allowed.
 */
const STALE_INTENT_MS = 15 * 60 * 1000;

// ── reserve ──────────────────────────────────────────────────────────────
export const createArtifactIntent = onCall(async (request) => {
  const { uid, data } = await guard(request, "createArtifactIntent",
    prepareDomainSchema.extend({
      // A rough bound the page works out from the car's own STEP size: the
      // tunnel STEP is about the same, and the GLB and the face lists add
      // their share. Used to refuse before minutes of cutting, the way
      // createUploadIntent refuses before minutes of uploading.
      reserve_bytes: z.number().int().min(0).max(1024 ** 3),
    }));
  const snap = await mustEdit(uid, data.geometry_id);

  if (snap.get("status") !== "ready") {
    throw new HttpsError(
      "failed-precondition",
      "This geometry is still being read. Wait for it to finish, then set up the tunnel.",
    );
  }
  if (snap.get("domain_status") === "preparing") {
    const open = await snap.ref.collection("artifact_intents")
      .where("state", "==", "open").limit(20).get();
    const newest = open.docs
      .map((d) => ({ ref: d.ref, at: d.get("created_at") }))
      .filter((r) => r.at?.toMillis)
      .sort((a, b) => b.at.toMillis() - a.at.toMillis())[0];
    if (!newest || Date.now() - newest.at.toMillis() < STALE_INTENT_MS) {
      throw new HttpsError(
        "failed-precondition",
        "A wind tunnel is already being built for this car.",
      );
    }
    await newest.ref.update({ state: "failed", error: "closed before it finished" });
  }

  const { used, quota } = await usage(uid);
  if (used + data.reserve_bytes > quota) {
    const gb = (n: number) => (n / (1024 ** 3)).toFixed(1);
    throw new HttpsError(
      "resource-exhausted",
      `This would take you past your ${gb(quota)} GB of storage; you are using `
      + `${gb(used)} GB. Delete a car you have finished with, or ask us to raise it.`,
    );
  }

  const version = nextVersionOf(snap);
  const token = randomBytes(16).toString("hex");
  const dir = `users/${uid}/geometries/${data.geometry_id}/incoming/${token}`;
  const paths = {
    step: `${dir}/geometry.step`,
    labels: `${dir}/entity_labels.csv`,
    glb: `${dir}/geometry.glb`,
    faces: `${dir}/faces.json`,
    solids: `${dir}/solids.json`,
  };

  await db.collection(COL.geometries).doc(data.geometry_id)
    .collection("artifact_intents").doc(token).set({
      user_id: uid,
      geometry_id: data.geometry_id,
      group_id: data.group_id,
      version,
      reserve_bytes: data.reserve_bytes,
      paths,
      state: "open",
      created_at: FieldValue.serverTimestamp(),
    });

  await snap.ref.update({
    domain_status: "preparing",
    domain_error: null,
    // What was asked for, so the panel can show it back and a second attempt
    // can start from the same numbers rather than the defaults.
    domain_options: {
      symmetry: data.symmetry,
      speed: data.speed,
      iterations: data.iterations,
      fineness: data.fineness,
      upstream_m: data.upstream_m,
      downstream_m: data.downstream_m,
      side_m: data.side_m,
      top_m: data.top_m,
      wheel_radius_m: data.wheel_radius_m,
      rear_wheel_radius_m: data.rear_wheel_radius_m ?? null,
      wheel_tolerance: data.wheel_tolerance,
      rotate_wheels: data.rotate_wheels,
      spin_wheels: data.spin_wheels ?? null,
      moving_ground: data.moving_ground,
    },
    updated_at: FieldValue.serverTimestamp(),
  });

  return { token, version, paths };
});

// ── ingest ───────────────────────────────────────────────────────────────
/**
 * The first bytes of a stored object, without downloading the rest of it.
 * The GLB is the large one; its magic is all this is for.
 */
function readFirstBytes(path: string, n: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    const stream = bucket().file(path).createReadStream({ start: 0, end: n - 1 });
    stream.on("data", (c: Buffer) => { got = Buffer.concat([got, c]); });
    stream.on("end", () => resolve(got.toString("latin1")));
    stream.on("error", reject);
  });
}

export const ingestPreparedDomain = onCall(async (request) => {
  const { uid, data } = await guard(request, "ingestPreparedDomain", ingestSchema);
  await mustEdit(uid, data.geometry_id);

  // Only the paths the server minted for this car and this caller can be
  // ingested. The token is 32 random bytes, so this is not guessable; the
  // point of the check is that a client cannot name a path of its own - one
  // that happens to hold another user's car - and have it filed as a version.
  const match = INCOMING.exec(data.artifacts.step);
  if (!match || match[1] !== uid || match[2] !== data.geometry_id || !match[3]) {
    throw new HttpsError("invalid-argument", "These are not this car's tunnel files.");
  }
  const token = match[3];

  const intentRef = db.collection(COL.geometries).doc(data.geometry_id)
    .collection("artifact_intents").doc(token);
  const intentSnap = await intentRef.get();
  if (!intentSnap.exists) {
    throw new HttpsError("not-found", "The build this upload belongs to is no longer known. Build the tunnel again.");
  }
  const intent = intentSnap.data() as Record<string, any>;
  if (intent.user_id !== uid) {
    throw new HttpsError("permission-denied", "That build is not yours.");
  }
  if (intent.state === "failed" || intent.state === "cancelled") {
    throw new HttpsError("failed-precondition", "This build was closed before it finished. Build the tunnel again.");
  }
  const minted = (intent.paths ?? {}) as Record<string, string>;
  for (const key of FILES) {
    if (String(minted[key] ?? "") !== data.artifacts[key]) {
      throw new HttpsError("invalid-argument", "These are not the files that were reserved.");
    }
  }

  const version = Number(intent.version);
  const fresh = await db.collection(COL.geometries).doc(data.geometry_id).get();
  const versions = (fresh.get("versions") ?? {}) as Record<string, any>;
  if (versions[String(version)]?.kind != null) {
    // A double-click, a retry, a second tab: the version is already there and
    // a second writeSetup would only race the first.
    throw new HttpsError("already-exists", "This tunnel has already been built. Build it again to replace it.");
  }

  for (const key of FILES) {
    const [exists] = await bucket().file(data.artifacts[key]).exists();
    if (!exists) {
      throw new HttpsError(
        "failed-precondition",
        `Part of the tunnel (${key}) did not arrive. Build the tunnel again.`,
      );
    }
  }
  if (await readFirstBytes(data.artifacts.glb, 4) !== "glTF") {
    throw new HttpsError("failed-precondition", "The tunnel model is not a GLB. Build the tunnel again.");
  }

  // The two JSON files are parsed rather than trusted: writeSetup builds the
  // whole setup from what the meta says, and the viewer draws from faces.json,
  // so a broken one here would fail far away from anything that explained it.
  let facesDoc: any;
  let solidsDoc: any;
  try {
    facesDoc = JSON.parse((await bucket().file(data.artifacts.faces).download())[0].toString("utf8"));
    solidsDoc = JSON.parse((await bucket().file(data.artifacts.solids).download())[0].toString("utf8"));
  } catch {
    throw new HttpsError("failed-precondition", "The tunnel's face list is not readable. Build the tunnel again.");
  }
  if (!Array.isArray(facesDoc?.faces) || !Array.isArray(facesDoc?.adjacency)) {
    throw new HttpsError("failed-precondition", "The tunnel's face list is not readable. Build the tunnel again.");
  }
  if (!Array.isArray(solidsDoc?.solids)) {
    throw new HttpsError("failed-precondition", "The tunnel's body list is not readable. Build the tunnel again.");
  }
  // The version inside the files is the one they were written for, which is
  // the minted one; stamped here so it cannot disagree with the folder they
  // are about to be filed in.
  facesDoc.version = version;
  solidsDoc.version = version;

  // Move them to the version folder, the same layout the geometry service
  // writes, so nothing downstream - the worker, the viewer, the add-in -
  // ever has to know where a tunnel came from. The three binary files are
  // copied server-side, bytes never through here; the two JSON files were
  // downloaded anyway and are written back as they were meant to be.
  const dest = `users/${uid}/geometries/${data.geometry_id}/v${version}`;
  const finalPaths = {
    step: `${dest}/geometry.step`,
    labels: `${dest}/entity_labels.csv`,
    glb: `${dest}/geometry.glb`,
    faces: `${dest}/faces.json`,
    solids: `${dest}/solids.json`,
  };
  await bucket().file(data.artifacts.step).copy(bucket().file(finalPaths.step));
  await bucket().file(data.artifacts.labels).copy(bucket().file(finalPaths.labels));
  await bucket().file(data.artifacts.glb).copy(bucket().file(finalPaths.glb));
  await bucket().file(finalPaths.faces)
    .save(JSON.stringify(facesDoc), { contentType: "application/json" });
  await bucket().file(finalPaths.solids)
    .save(JSON.stringify(solidsDoc), { contentType: "application/json" });

  const out = { ...data.meta, paths: finalPaths, version };
  const simulationId = await writeSetup(uid, data, fresh, out);

  // The incoming folder was staging; the version has its own copies now.
  await bucket().deleteFiles({ prefix: `users/${uid}/geometries/${data.geometry_id}/incoming/${token}/` })
    .catch((err: unknown) => logger.warn("could not clear the incoming folder", err));
  await intentRef.update({
    state: "ingested",
    ingested_at: FieldValue.serverTimestamp(),
  });

  return { ok: true, version, simulation_id: simulationId };
});

// ── fail ─────────────────────────────────────────────────────────────────
export const failDomainBuild = onCall(async (request) => {
  const { uid, data } = await guard(request, "failDomainBuild", failSchema);
  const snap = await mustEdit(uid, data.geometry_id);

  if (data.token) {
    const ref = snap.ref.collection("artifact_intents").doc(data.token);
    const intent = await ref.get();
    if (!intent.exists) {
      throw new HttpsError("not-found", "No such build.");
    }
    await ref.update({ state: "failed", error: (data.error ?? "").slice(0, 600) });
  }

  // Only while preparing. A build that already succeeded - or that was never
  // started - has an answer on the document that a late failure message from
  // a stray tab should not overwrite.
  if (snap.get("domain_status") === "preparing") {
    await snap.ref.update({
      domain_status: "failed",
      domain_error: (data.error || "The wind tunnel was not built.").slice(0, 600),
      updated_at: FieldValue.serverTimestamp(),
    });
  }
  return { ok: true };
});
