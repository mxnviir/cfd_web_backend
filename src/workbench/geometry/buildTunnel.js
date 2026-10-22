// Build the wind tunnel in the browser, then hand the pieces to the backend.
//
// The geometry service's /prepare does the same job on a Cloud Run container:
// find the wheels, size a tunnel, cut the car out of it, label every wall,
// write five artefacts. The cut is pure geometry, it needs no secret, and it
// is the part that takes minutes - so the Workbench now does it in a Web
// Worker (tunnelCut.worker.js) and keeps the page responsive while it runs.
// What is left for the backend is the part that must not trust the browser:
// reserving the storage paths, checking the bytes that landed, and writing
// the version and the simulation from them.
//
// The flow: createArtifactIntent reserves the paths and marks the geometry
// "preparing"; the worker cuts; the five artefacts upload to the reserved
// paths; the intent is marked consumed; ingestPreparedDomain verifies the
// bytes and writes the version and simulation. If anything fails after the
// intent exists, failDomainBuild records it, so the tree never sits on
// "preparing" forever.
import { db, functions, storage } from "../../lib/firebase";
import { rawVersion } from "../../lib/geometry";

/** The five artefacts, in the order they are uploaded. */
const FILES = ["step", "labels", "glb", "faces", "solids"];

/**
 * Cut the tunnel for `geometry` and set the simulation up from it.
 *
 * `form` is the setup form (symmetry, speed, iterations, fineness, tunnel
 * sizes, wheel search), `simulationId` reuses an existing simulation rather
 * than making another, and `onProgress({ fraction, text })` reports 0 to 1
 * across the whole build: reading the car, the cut, the upload, the ingest.
 */
export async function prepareDomainInBrowser({
  geometry, groupId, simulationId, form, onProgress,
}) {
  const say = (fraction, text) => onProgress?.({ fraction, text });

  // The car, not whatever version is current: once a tunnel exists it becomes
  // the current version, and building around that would put a box around a box.
  const car = rawVersion(geometry)?.version ?? null;
  const stepPath = car?.step_path ?? geometry?.rawPath;
  if (!stepPath) throw new Error("This car has no STEP file to build a tunnel around.");

  say(0.005, "Reading the car");
  const stepBytes = await storage.bytes(stepPath);
  const stepText = new TextDecoder().decode(stepBytes);

  // The car's own face list, so wheel faces found in the STEP text can be
  // mapped onto face indices the viewer can light up. Without it the wheels
  // still work; they just carry no faces to hover.
  let carFaces = null;
  if (car?.faces_path) {
    try {
      const doc = JSON.parse(new TextDecoder().decode(await storage.bytes(car.faces_path)));
      carFaces = Array.isArray(doc?.faces) ? doc.faces : null;
    } catch { carFaces = null; }
  }

  say(0.01, "Reserving the tunnel");
  const intent = (await functions.httpsCallable("createArtifactIntent")({
    ...form,
    geometry_id: geometry.id,
    group_id: groupId,
    simulation_id: simulationId ?? null,
    // The tunnel STEP is about the size of the car's; the GLB and the face
    // lists add their share on top.
    reserve_bytes: stepBytes.byteLength * 3 + 8 * 1024 * 1024,
  })).data;

  let worker = null;
  try {
    worker = new Worker(new URL("./tunnelCut.worker.js", import.meta.url), { type: "module" });
    const cut = await new Promise((resolve, reject) => {
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
      worker.postMessage({
        step: stepText,
        options: {
          ...form,
          // The car as the geometry service re-exported it: turned to face
          // the wind and written in metres. Its stated unit is only a
          // fallback; the cut measures the size first.
          unit: car?.unit ?? geometry?.inputUnit ?? undefined,
          carFaces,
          version: intent.version,
        },
      });
    });

    const blobs = {
      step: new Blob([cut.step], { type: "application/step" }),
      labels: new Blob([cut.labels], { type: "text/csv" }),
      glb: new Blob([cut.glb], { type: "model/gltf-binary" }),
      faces: new Blob([JSON.stringify(cut.faces)], { type: "application/json" }),
      solids: new Blob([JSON.stringify(cut.solids)], { type: "application/json" }),
    };
    for (let i = 0; i < FILES.length; i++) {
      const name = FILES[i];
      await new Promise((resolve, reject) => {
        const task = storage.upload(intent.paths[name], blobs[name]);
        task.on("state_changed",
          (snap) => {
            const frac = snap.totalBytes > 0 ? snap.bytesTransferred / snap.totalBytes : 0;
            say(0.95 + 0.045 * ((i + frac) / FILES.length),
              `Uploading ${name} ${Math.round(frac * 100)}%`);
          },
          reject,
          resolve);
      });
    }

    // The bytes are in place; the intent records that the page did its half.
    // The ingest callable is what actually trusts it, and only the state
    // moves - the paths and the version were written by the server.
    await db.collection("geometries").doc(geometry.id)
      .collection("artifact_intents").doc(intent.token)
      .update({ state: "consumed" });

    say(0.995, "Setting up the simulation");
    const reply = await functions.httpsCallable("ingestPreparedDomain")({
      ...form,
      geometry_id: geometry.id,
      group_id: groupId,
      simulation_id: simulationId ?? null,
      artifacts: intent.paths,
      meta: cut.meta,
    });
    return reply?.data ?? reply;
  } catch (err) {
    // Whatever went wrong after the intent was minted, the geometry must not
    // sit on "preparing": the tree shows the failure and the message with it.
    // The one failure that must NOT be recorded is a refusal because another
    // build is already live - marking that one failed would close the build
    // that is working.
    if (!/already being built/i.test(String(err?.message || err))) {
      try {
        await functions.httpsCallable("failDomainBuild")({
          geometry_id: geometry.id,
          token: intent?.token ?? null,
          error: String(err?.message || err).slice(0, 600),
        });
      } catch { /* the intent may never have been created */ }
    }
    throw err;
  } finally {
    // One engine per build: the kernel's memory goes back with the worker.
    worker?.terminate();
  }
}
