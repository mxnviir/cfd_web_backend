// Turn an uploaded CAD file into something the browser can draw. Build spec 14.3.
//
// Two functions. onGeometryUploaded notices the bytes landing and marks the
// geometry queued; processGeometry does the work by calling the geometry
// service and writing the version it produces.
//
// They are separate because they have different shapes of failure. A Storage
// trigger that took nine minutes would be retried by Eventarc while the first
// attempt was still running, and two tessellations of the same car racing each
// other would both write versions.{n}. An HTTP function invoked once is easier
// to reason about, and the queue in front of it is what stops a flood.
import { onRequest } from "firebase-functions/v2/https";
import { onObjectFinalized } from "firebase-functions/v2/storage";
import { logger } from "firebase-functions/v2";
import { GoogleAuth } from "google-auth-library";
import { db, FieldValue } from "../lib/admin";
import { COL, REGION, projectId } from "../lib/config";

/**
 * Where the Storage trigger has to live.
 *
 * A function listening to a bucket must be deployed in the bucket's own
 * region, and this bucket is in us-east1 while everything else is us-central1.
 * Deploying it alongside the rest fails outright with "cannot listen to a
 * bucket in region us-east1", which is at least a loud failure rather than a
 * trigger that silently never fires.
 */
const BUCKET_REGION = process.env.BUCKET_REGION || "us-east1";

/** users/{uid}/geometries/{gid}/raw.{ext} and nothing else. */
const RAW = /^users\/([^/]+)\/geometries\/([^/]+)\/raw\.(step|stp|iges|igs|stl)$/i;

function tessellateUrl(): string {
  const url = process.env.TESSELLATE_URL;
  if (!url) throw new Error("TESSELLATE_URL is not set");
  return url.replace(/\/+$/, "");
}

// ── the bytes landed ─────────────────────────────────────────────────────────
export const onGeometryUploaded = onObjectFinalized(
  // One instance stays warm. Build spec 14.2 asks for the document to reach
  // "queued" within five seconds of the upload finishing, and it does in half
  // a second once the container is up: measured 0.4 s and 2.7 s warm against
  // 10.2 s cold, where all ten seconds were Cloud Run starting a container.
  // A 256 MiB instance sitting idle is a few dollars a month, and the thing it
  // buys is that the first upload of the day is not the slow one.
  { region: BUCKET_REGION, memory: "256MiB", minInstances: 1 },
  async (event) => {
    const match = RAW.exec(event.data.name ?? "");
    if (!match) return;                       // not a raw upload, nothing to do
    const uid = match[1] as string;
    const gid = match[2] as string;

    const ref = db.collection(COL.geometries).doc(gid);
    const snap = await ref.get();
    if (!snap.exists) {
      logger.warn(`upload at ${event.data.name} has no geometry document`);
      return;
    }
    if (snap.get("user_id") !== uid) {
      // The path says one owner and the document says another. The storage
      // rules should make this impossible; if it happens, do not process it.
      logger.error(`owner mismatch for ${gid}: path ${uid}, document ${snap.get("user_id")}`);
      return;
    }
    // Only from "uploading". A re-finalize of the same object, which Eventarc
    // can deliver more than once, must not queue a second tessellation.
    if (snap.get("status") !== "uploading") {
      logger.info(`geometry ${gid} is ${snap.get("status")}, not queueing again`);
      return;
    }

    const version = Number(snap.get("current_version") ?? 0) + 1;
    await ref.update({
      status: "queued",
      size_bytes: Number(event.data.size ?? 0),
      updated_at: FieldValue.serverTimestamp(),
    });

    try {
      await enqueueProcess({ uid, gid, version });
    } catch (err) {
      logger.error(`could not queue processing for ${gid}`, err);
      await ref.update({
        status: "failed",
        error: "Could not start preparing this geometry. Try uploading again.",
        updated_at: FieldValue.serverTimestamp(),
      });
    }
  },
);

/**
 * Call processGeometry, without waiting for it.
 *
 * Cloud Tasks would be the tidier queue, but it needs a queue provisioned per
 * environment and the emulator does not run it the same way. A fire-and-forget
 * authenticated request does the one thing that matters here: the trigger
 * returns immediately so Eventarc does not retry it, and the long work happens
 * in a function with its own timeout.
 */
async function enqueueProcess(body: { uid: string; gid: string; version: number }) {
  const url = `https://${REGION}-${projectId()}.cloudfunctions.net/processGeometry`;
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(url);
  const headers = await client.getRequestHeaders();
  // Not awaited on purpose: this request runs for minutes and the trigger must
  // not hold a Storage event open that long.
  void fetch(url, {
    method: "POST",
    headers: { ...Object.fromEntries(new Headers(headers)), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => logger.warn("processGeometry dispatch failed", err));
}

// ── do the work ──────────────────────────────────────────────────────────────
export const processGeometry = onRequest(
  // Warm for the same reason as the trigger that calls it: it sits in the
  // middle of the chain between a finished upload and a model on screen, and a
  // cold start here is added to every single import.
  { region: REGION, timeoutSeconds: 540, memory: "512MiB", invoker: "private", minInstances: 1 },
  async (req, res) => {
    const { uid, gid, version } = (req.body ?? {}) as
      { uid?: string; gid?: string; version?: number };
    if (!uid || !gid || !version) {
      res.status(400).json({ error: "uid, gid and version are required" });
      return;
    }

    const ref = db.collection(COL.geometries).doc(gid);
    const snap = await ref.get();
    if (!snap.exists || snap.get("user_id") !== uid) {
      res.status(404).json({ error: "no such geometry" });
      return;
    }

    await ref.update({ status: "tessellating", updated_at: FieldValue.serverTimestamp() });

    try {
      const url = `${tessellateUrl()}/inspect`;
      const auth = new GoogleAuth();
      const client = await auth.getIdTokenClient(tessellateUrl());
      const headers = await client.getRequestHeaders();

      const reply = await fetch(url, {
        method: "POST",
        headers: { ...Object.fromEntries(new Headers(headers)), "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_path: snap.get("raw_path"),
          version,
          format: snap.get("format"),
          input_unit: snap.get("input_unit"),
          import_options: snap.get("import_options") ?? {},
          // The service runs as itself here, not as the user, so it needs to
          // be told whose folder this is rather than reading it off a token.
          on_behalf_of: uid,
        }),
      });

      const out = await reply.json().catch(() => ({} as Record<string, unknown>));
      if (!reply.ok) {
        throw new Error(String((out as { error?: string }).error ?? `service returned ${reply.status}`));
      }

      const o = out as Record<string, any>;
      await ref.update({
        status: "ready",
        error: null,
        current_version: version,
        [`versions.${version}`]: {
          glb_path: o.paths?.glb ?? null,
          faces_path: o.paths?.faces ?? null,
          solids_path: o.paths?.solids ?? null,
          step_path: o.paths?.step ?? null,
          thumb_path: o.paths?.thumb ?? null,
          bbox: o.bbox ?? null,
          // Everything /inspect already worked out about the car, kept rather
          // than dropped. The wheels it found and the tunnel it would build
          // are what the automatic setup offers back to the user before they
          // commit to it, and re-deriving them meant a second full import of
          // the same car. All three were being measured and thrown away.
          wheels: o.wheels ?? [],
          domain: o.domain ?? null,
          car_axis: o.car_axis ?? null,
          frontal_area_half_m2: o.frontal_area_half_m2 ?? null,
          kind: "raw",
          solid_count: o.solid_count ?? null,
          face_count: o.face_count ?? null,
          triangle_count: o.triangle_count ?? null,
          frontal_area_m2: o.frontal_area_m2 ?? null,
          reference_length_m: o.bbox?.size?.[0] ?? null,
          rotated_deg: o.rotated_deg ?? 0,
          unit: o.unit ?? null,
          features: [],
          at: FieldValue.serverTimestamp(),
        },
        updated_at: FieldValue.serverTimestamp(),
      });
      res.json({ ok: true, version });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`processGeometry failed for ${gid}`, err);
      await ref.update({
        status: "failed",
        // The service's own message, which says what is wrong with the file
        // rather than that something went wrong. Trimmed so a stack trace
        // cannot fill the document.
        error: message.slice(0, 300),
        updated_at: FieldValue.serverTimestamp(),
      });
      res.status(500).json({ error: message.slice(0, 300) });
    }
  },
);
