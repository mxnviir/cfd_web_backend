// Import a car in the browser, then hand the pieces to the backend.
//
// This is the import half of the same split the tunnel build uses: the
// geometry work (reading the STEP, meshing it, surveying its faces, writing
// the pickable model) runs in a Web Worker on the same occt-wasm engine,
// and the backend keeps the part that must not trust the browser - reserving
// the storage paths, checking the bytes that landed, and writing the version
// that makes the car appear in the tree.
//
// The flow: createCarIntent reserves the paths and marks the geometry
// "queued"; the worker inspects; the artefacts upload to the reserved paths;
// the intent is marked consumed; ingestCar verifies the bytes and writes the
// version. If anything fails after the intent exists, failCarImport records
// it, so the tree never sits on "preparing" forever.
import { db, functions, storage } from "../../lib/backend";

/** The artefacts in upload order; the thumbnail at the end because it is
 *  optional - Node has no canvas, old browsers may not either. */
const FILES = ["step", "glb", "faces", "solids", "thumb"];

/**
 * Inspect `file` (or the raw upload already in storage, for a car whose
 * import was interrupted) and make the geometry ready.
 *
 * `onProgress({ fraction, text })` reports 0 to 1 across the whole import.
 * `unit` is the unit the upload dialog said, which the inspect uses only as a
 * fallback: it measures the model first.
 */
export async function prepareCarInBrowser({
  geometryId, groupId, file, rawPath, unit, onProgress,
}) {
  const say = (fraction, text) => onProgress?.({ fraction, text });

  say(0.005, "Reading the file");
  // The file is still in memory on the upload path; the download only happens
  // when picking the import back up after the tab that started it was closed.
  const stepText = file
    ? await file.text()
    : new TextDecoder().decode(await storage.bytes(rawPath));

  say(0.01, "Reserving the model");
  const intent = (await functions.httpsCallable("createCarIntent")({
    geometry_id: geometryId,
    group_id: groupId ?? null,
    // The re-exported STEP runs a few times the size of the raw file; the
    // model and the lists add their share on top.
    reserve_bytes: (file ? file.size : stepText.length) * 3 + 8 * 1024 * 1024,
  })).data;

  let worker = null;
  try {
    worker = new Worker(new URL("./inspectCar.worker.js", import.meta.url), { type: "module" });
    const out = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.type === "stage") say(data.fraction ?? 0, data.text);
        else if (data.type === "done") resolve(data);
        else if (data.type === "error") {
          const err = new Error(data.message);
          err.carFault = !!data.carFault;
          reject(err);
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || "The geometry worker failed."));
      worker.postMessage({ step: stepText, options: { version: intent.version, unit } });
    });

    const blobs = {
      step: new Blob([out.step], { type: "application/step" }),
      glb: new Blob([out.glb], { type: "model/gltf-binary" }),
      faces: new Blob([JSON.stringify(out.faces)], { type: "application/json" }),
      solids: new Blob([JSON.stringify(out.solids)], { type: "application/json" }),
      thumb: out.thumb ? new Blob([out.thumb], { type: "image/png" }) : null,
    };
    const upload = FILES.filter((n) => blobs[n]);
    for (let i = 0; i < upload.length; i++) {
      const name = upload[i];
      await new Promise((resolve, reject) => {
        const task = storage.upload(intent.paths[name], blobs[name]);
        task.on("state_changed",
          (snap) => {
            const frac = snap.totalBytes > 0 ? snap.bytesTransferred / snap.totalBytes : 0;
            say(0.95 + 0.045 * ((i + frac) / upload.length),
              `Uploading ${name} ${Math.round(frac * 100)}%`);
          },
          reject,
          resolve);
      });
    }

    // The bytes are in place; the intent records that the page did its half.
    // Only the state moves - the paths and the version were written by the
    // server.
    await db.collection("geometries").doc(geometryId)
      .collection("artifact_intents").doc(intent.token)
      .update({ state: "consumed" });

    say(0.995, "Filing the model");
    const reply = await functions.httpsCallable("ingestCar")({
      geometry_id: geometryId,
      artifacts: intent.paths,
      meta: out.meta,
    });
    return reply?.data ?? reply;
  } catch (err) {
    // Whatever went wrong after the intent was minted, the geometry must not
    // sit on "queued": the tree shows the failure and the message with it.
    // The one failure that must NOT be recorded is a refusal because another
    // import is already live - marking that one failed would close the import
    // that is working.
    if (!/already being imported/i.test(String(err?.message || err))) {
      try {
        await functions.httpsCallable("failCarImport")({
          geometry_id: geometryId,
          token: intent?.token ?? null,
          error: String(err?.message || err).slice(0, 600),
        });
      } catch { /* the intent may never have been created */ }
    }
    throw err;
  } finally {
    // One engine per import: the kernel's memory goes back with the worker.
    worker?.terminate();
  }
}
