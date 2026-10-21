// The browser-built import: reserve, ingest, and fail.
//
// Importing a car used to be the geometry service's job: the bytes landed,
// a trigger noticed them, and a Cloud Run container spent minutes reading the
// STEP and writing back the model. The reading is pure geometry, needs no
// secret, and the Workbench already ships the same occt-wasm engine the
// tunnel cut runs on - so the import now runs in the browser too, and this
// file is the half that must not trust it: reserving the storage paths,
// checking the bytes that landed, and writing the version that makes the car
// appear in the tree.
//
// The three callables mirror the tunnel build's pair exactly, on purpose:
//   createCarIntent  mints the paths and the version, marks the geometry
//                    "queued", and refuses a second import while one is live.
//   ingestCar        checks the paths against what was minted, checks the
//                    bytes, moves them to the version folder, and writes the
//                    same version document processGeometry used to write.
//   failCarImport    records why an import died, so the tree never sits on
//                    "queued" forever because a tab was closed mid-import.
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db, FieldValue, bucket } from "../lib/admin";
import { COL } from "../lib/config";
import { guard } from "../lib/guard";
import { usage } from "../storage/quota";
import { docId } from "../groups/schemas";
import { mustEdit, nextVersionOf } from "./prepareDomain";
import { wheelSchema } from "./preparedDomain";

/**
 * What the browser's inspect says about the car it read. Shape only, for the
 * same reason as the tunnel's meta: a browser cannot smuggle in a field the
 * ingest would copy verbatim, and cannot omit one the version is built from.
 * What the numbers are is only as trustworthy as the browser, which is why
 * the files they describe are verified below before anything is filed.
 */
const carMetaSchema = z.object({
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
  scale_to_m: z.number(),
  wheels: z.array(wheelSchema).max(20),
  frontal_area_m2: z.number().min(0),
  frontal_area_half_m2: z.number().min(0),
  rotated_deg: z.number(),
  face_count: z.number().int().min(0),
  solid_count: z.number().int().min(0),
  triangle_count: z.number().int().min(0),
});

const createCarIntentSchema = z.object({
  geometry_id: docId,
  group_id: docId.nullish(),
  // A rough bound the page works out from the raw file's size: the re-exported
  // STEP runs a few times larger, and the model and the lists add their share.
  reserve_bytes: z.number().int().min(0).max(1024 ** 3),
});

const ingestCarSchema = z.object({
  geometry_id: docId,
  artifacts: z.object({
    step: z.string(),
    glb: z.string(),
    faces: z.string(),
    solids: z.string(),
    // The thumbnail is optional on purpose: the worker draws it onto an
    // OffscreenCanvas, and where there is none the dashboard shows the card
    // without a picture rather than failing the import.
    thumb: z.string().nullish(),
  }),
  meta: carMetaSchema,
});

const failCarSchema = z.object({
  geometry_id: docId,
  token: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
  error: z.string().max(600).nullish(),
});

/**
 * How long a page's silence is allowed to hold the car closed. Without this,
 * a tab closed mid-import would leave the car on "queued" forever, refusing
 * every retry - the browser, unlike the Cloud Run job it replaced, writes
 * nothing when it dies.
 */
const STALE_INTENT_MS = 15 * 60 * 1000;

// ── reserve ──────────────────────────────────────────────────────────────
export const createCarIntent = onCall(async (request) => {
  const { uid, data } = await guard(request, "createCarIntent", createCarIntentSchema);
  const snap = await mustEdit(uid, data.geometry_id);

  const status = snap.get("status");
  if (status === "ready") {
    throw new HttpsError(
      "failed-precondition",
      "This car has already been imported. Re-upload it to import it again.",
    );
  }
  if (status !== "uploading" && status !== "queued" && status !== "failed") {
    throw new HttpsError(
      "failed-precondition",
      "This geometry is not waiting to be imported.",
    );
  }
  if (status === "queued") {
    const open = await snap.ref.collection("artifact_intents")
      .where("state", "==", "open").limit(20).get();
    const newest = open.docs
      .map((d) => ({ ref: d.ref, at: d.get("created_at") }))
      .filter((r) => r.at?.toMillis)
      .sort((a, b) => b.at.toMillis() - a.at.toMillis())[0];
    if (!newest || Date.now() - newest.at.toMillis() < STALE_INTENT_MS) {
      throw new HttpsError(
        "failed-precondition",
        "This car is already being imported.",
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
    glb: `${dir}/model.glb`,
    faces: `${dir}/faces.json`,
    solids: `${dir}/solids.json`,
    thumb: `${dir}/thumb.png`,
  };

  await db.collection(COL.geometries).doc(data.geometry_id)
    .collection("artifact_intents").doc(token).set({
      kind: "car",
      user_id: uid,
      geometry_id: data.geometry_id,
      group_id: data.group_id ?? null,
      version,
      reserve_bytes: data.reserve_bytes,
      paths,
      state: "open",
      created_at: FieldValue.serverTimestamp(),
    });

  await snap.ref.update({
    status: "queued",
    error: null,
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

export const ingestCar = onCall(async (request) => {
  const { uid, data } = await guard(request, "ingestCar", ingestCarSchema);
  await mustEdit(uid, data.geometry_id);

  // Only the paths the server minted for this car and this caller can be
  // ingested. The token is 32 random bytes, so this is not guessable; the
  // point of the check is that a client cannot name a path of its own - one
  // that happens to hold another user's car - and have it filed as a version.
  const match = /^users\/([^/]+)\/geometries\/([^/]+)\/incoming\/([A-Za-z0-9_-]{8,64})\//.exec(data.artifacts.step);
  if (!match || match[1] !== uid || match[2] !== data.geometry_id || !match[3]) {
    throw new HttpsError("invalid-argument", "These are not this car's files.");
  }
  const token = match[3];

  const intentRef = db.collection(COL.geometries).doc(data.geometry_id)
    .collection("artifact_intents").doc(token);
  const intentSnap = await intentRef.get();
  if (!intentSnap.exists) {
    throw new HttpsError("not-found", "The import this upload belongs to is no longer known. Import the car again.");
  }
  const intent = intentSnap.data() as Record<string, any>;
  if (intent.user_id !== uid) {
    throw new HttpsError("permission-denied", "That import is not yours.");
  }
  if (intent.state === "failed" || intent.state === "cancelled") {
    throw new HttpsError("failed-precondition", "This import was closed before it finished. Import the car again.");
  }
  const minted = (intent.paths ?? {}) as Record<string, string>;
  for (const key of ["step", "glb", "faces", "solids"] as const) {
    if (String(minted[key] ?? "") !== data.artifacts[key]) {
      throw new HttpsError("invalid-argument", "These are not the files that were reserved.");
    }
  }

  const version = Number(intent.version);
  const fresh = await db.collection(COL.geometries).doc(data.geometry_id).get();
  const versions = (fresh.get("versions") ?? {}) as Record<string, any>;
  if (versions[String(version)]?.kind != null) {
    // A double-click, a retry, a second tab: the version is already there and
    // a second write would only race the first.
    throw new HttpsError("already-exists", "This car has already been imported. Re-upload it to import it again.");
  }

  for (const key of ["step", "glb", "faces", "solids"] as const) {
    const [exists] = await bucket().file(data.artifacts[key]).exists();
    if (!exists) {
      throw new HttpsError(
        "failed-precondition",
        `Part of the model (${key}) did not arrive. Import the car again.`,
      );
    }
  }
  if (await readFirstBytes(data.artifacts.glb, 4) !== "glTF") {
    throw new HttpsError("failed-precondition", "The model is not a GLB. Import the car again.");
  }

  // The two JSON files are parsed rather than trusted: the viewer draws from
  // faces.json, so a broken one here would fail far away from anything that
  // explained it.
  let facesDoc: any;
  let solidsDoc: any;
  try {
    facesDoc = JSON.parse((await bucket().file(data.artifacts.faces).download())[0].toString("utf8"));
    solidsDoc = JSON.parse((await bucket().file(data.artifacts.solids).download())[0].toString("utf8"));
  } catch {
    throw new HttpsError("failed-precondition", "The model's face list is not readable. Import the car again.");
  }
  if (!Array.isArray(facesDoc?.faces) || !Array.isArray(facesDoc?.adjacency)) {
    throw new HttpsError("failed-precondition", "The model's face list is not readable. Import the car again.");
  }
  if (!Array.isArray(solidsDoc?.solids)) {
    throw new HttpsError("failed-precondition", "The model's body list is not readable. Import the car again.");
  }
  // The version inside the files is the one they were written for, which is
  // the minted one; stamped here so it cannot disagree with the folder they
  // are about to be filed in.
  facesDoc.version = version;
  solidsDoc.version = version;

  // Move them to the version folder, the same layout the geometry service
  // wrote, so nothing downstream - the viewer, the tunnel cut, the worker -
  // ever has to know where a model came from. The binary files are copied
  // server-side, bytes never through here; the two JSON files were downloaded
  // anyway and are written back as they were meant to be.
  const dest = `users/${uid}/geometries/${data.geometry_id}/v${version}`;
  const finalPaths = {
    step: `${dest}/geometry.step`,
    glb: `${dest}/model.glb`,
    faces: `${dest}/faces.json`,
    solids: `${dest}/solids.json`,
    thumb: `${dest}/thumb.png`,
  };
  await bucket().file(data.artifacts.step).copy(bucket().file(finalPaths.step));
  await bucket().file(data.artifacts.glb).copy(bucket().file(finalPaths.glb));
  await bucket().file(finalPaths.faces).save(JSON.stringify(facesDoc), { contentType: "application/json" });
  await bucket().file(finalPaths.solids).save(JSON.stringify(solidsDoc), { contentType: "application/json" });

  // The thumbnail is optional: the page draws it onto an OffscreenCanvas, and
  // where there is none the dashboard shows the card without a picture.
  let thumbPath: string | null = null;
  if (data.artifacts.thumb) {
    const [exists] = await bucket().file(data.artifacts.thumb).exists();
    if (exists) {
      await bucket().file(data.artifacts.thumb).copy(bucket().file(finalPaths.thumb));
      thumbPath = finalPaths.thumb;
    }
  }

  const meta = data.meta;
  await fresh.ref.update({
    current_version: version,
    status: "ready",
    error: null,
    [`versions.${version}`]: {
      glb_path: finalPaths.glb,
      faces_path: finalPaths.faces,
      solids_path: finalPaths.solids,
      step_path: finalPaths.step,
      thumb_path: thumbPath,
      bbox: meta.bbox,
      wheels: meta.wheels,
      domain: meta.domain,
      kind: "raw",
      solid_count: meta.solid_count,
      face_count: meta.face_count,
      triangle_count: meta.triangle_count,
      // The shadow over the whole car and over the half a symmetric tunnel
      // would see, said at import because the alternative is finding out
      // after a run that the coefficient was halved or doubled.
      frontal_area_m2: meta.frontal_area_m2,
      frontal_area_half_m2: meta.frontal_area_half_m2,
      reference_length_m: meta.bbox.size[0],
      rotated_deg: meta.rotated_deg,
      unit: meta.unit,
      features: [],
      at: FieldValue.serverTimestamp(),
    },
    updated_at: FieldValue.serverTimestamp(),
  });

  // The incoming folder was staging; the version has its own copies now.
  await bucket().deleteFiles({ prefix: `users/${uid}/geometries/${data.geometry_id}/incoming/${token}/` })
    .catch((err: unknown) => logger.warn("could not clear the incoming folder", err));
  await intentRef.update({
    state: "ingested",
    ingested_at: FieldValue.serverTimestamp(),
  });

  return { ok: true, version };
});

// ── fail ─────────────────────────────────────────────────────────────────
export const failCarImport = onCall(async (request) => {
  const { uid, data } = await guard(request, "failCarImport", failCarSchema);
  const snap = await mustEdit(uid, data.geometry_id);

  if (data.token) {
    const ref = snap.ref.collection("artifact_intents").doc(data.token);
    const intent = await ref.get();
    if (!intent.exists) {
      throw new HttpsError("not-found", "No such import.");
    }
    await ref.update({ state: "failed", error: (data.error ?? "").slice(0, 600) });
  }

  // Only while an import is actually live. A car that already imported - or
  // whose upload never finished - has an answer on the document that a late
  // failure message from a stray tab should not overwrite.
  const status = snap.get("status");
  if (status === "uploading" || status === "queued") {
    await snap.ref.update({
      status: "failed",
      error: (data.error || "This car could not be imported.").slice(0, 600),
      updated_at: FieldValue.serverTimestamp(),
    });
  }
  return { ok: true };
});
