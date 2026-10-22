// Runs the import off the page's thread, so the Workbench keeps drawing
// while OCC works. Same shape as tunnelCut.worker.js: one engine per worker,
// thrown away after every import, the artefacts posted out and the GLB
// buffer moved rather than copied.
import { OcctKernel } from "occt-wasm";
import wasmUrl from "occt-wasm/dist/occt-wasm.wasm?url";
import { inspectCar } from "./inspect-core.js";
import { CutError } from "./cut-core.js";

let kernel = null;

onmessage = async ({ data }) => {
  const say = (stage, text, fraction) => postMessage({ type: "stage", stage, text, fraction });
  try {
    if (!kernel) {
      say("engine", "Loading the geometry engine (first time only)", 0);
      kernel = await OcctKernel.init({ wasm: wasmUrl });
    }
    const t0 = performance.now();
    const out = await inspectCar(kernel, data.step, data.options, say);
    out.stats.seconds = (performance.now() - t0) / 1000;
    out.stats.memoryMB = Math.round(kernel.getRawModule().HEAP32.buffer.byteLength / 2 ** 20);
    const { step, faces, solids, meta, stats, glb, thumb } = out;
    const transfer = [glb.buffer];
    if (thumb) transfer.push(thumb.buffer);
    postMessage({ type: "done", step, faces, solids, meta, stats, glb, thumb }, transfer);
  } catch (e) {
    postMessage({
      type: "error",
      carFault: e instanceof CutError,
      message: e instanceof CutError ? e.message
        : `The geometry engine stopped: ${e?.message || e}`,
    });
  } finally {
    try { kernel?.releaseAll(); } catch { /* the page replaces this worker */ }
  }
};
