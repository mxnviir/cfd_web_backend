// FINISH: the first time a finished run's owner opens it, turn SimScale's
// case into the viewer's files and file them on the run.
//
// The pipeline copies the case into Storage untouched; this is the
// conversion the Cloud Run worker used to do with pyvista. It runs once:
// the files are uploaded beside the case (the storage policy lets the owner
// write them only while the run has none), finishResults points the run at
// them, and every later view - the owner's or a collaborator's - loads them
// as they are.
import { storage, functions } from "../../lib/backend";
import { RESULT_FIELDS } from "./openfoam.js";

/** An upload that is already there is one an earlier attempt made: fine. */
const put = (path, blob) => storage.upload(path, blob).catch((err) => {
  if (!/already exists|duplicate|409/i.test(err?.message ?? "")) throw err;
});

export async function finishRun(run, onProgress = () => {}) {
  const dir = run.casePath.replace(/\/case\.zip$/, "");
  const [url, size] = await Promise.all([storage.url(run.casePath), storage.size(run.casePath)]);
  const worker = new Worker(new URL("./finish.worker.js", import.meta.url), { type: "module" });
  const out = await new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.progress) onProgress(data.progress.fraction * 0.9, data.progress.text);
      if (data.error) reject(new Error(data.error));
      if (data.done) resolve(data.done);
    };
    worker.onerror = (e) => reject(new Error(e.message || "The conversion stopped."));
    worker.postMessage({ url, size });
  }).finally(() => worker.terminate());

  onProgress(0.92, "Saving the 3D results");
  const fields = {};
  for (const [name, f] of Object.entries(out.fields)) {
    const path = `${dir}/fields/${name}.bin`;
    await put(path, new Blob([f.values], { type: "application/octet-stream" }));
    fields[name] = { label: RESULT_FIELDS[name] ?? name, path, min: f.min, max: f.max };
  }
  const manifest = {
    jobId: run.jobId, vertexCount: out.vertexCount, triangleCount: out.triangleCount,
    glb: `${dir}/results.glb`, fields, case: run.casePath,
  };
  await put(`${dir}/fields.json`, new Blob([JSON.stringify(manifest)], { type: "application/json" }));
  // The model last: finishResults checks it is there, so an attempt that
  // dies part-way is retried rather than filed half-done.
  await put(`${dir}/results.glb`, new Blob([out.glb], { type: "model/gltf-binary" }));
  onProgress(0.98, "Filing them on the run");
  await functions.httpsCallable("finishResults")({ run_id: run.id });
  onProgress(1, "Done");
}
