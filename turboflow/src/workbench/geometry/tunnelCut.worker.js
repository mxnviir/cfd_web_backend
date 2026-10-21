// Runs the tunnel cut off the page's thread, so the Workbench keeps drawing
// while OCC works. One engine per worker, loaded on the first job; the page
// throws the whole worker away after every build, which is the only sure way
// to get back the memory an engine fault may have left in a bad state.
//
// The page holds no geometry state across builds: the car's STEP text goes in
// and the five artefacts come out, so a worker that dies mid-cut costs nothing
// but the cut.
import { OcctKernel } from "occt-wasm";
import wasmUrl from "occt-wasm/dist/occt-wasm.wasm?url";
import { prepareTunnel, CutError } from "./cut-core.js";

let kernel = null;

onmessage = async ({ data }) => {
  const say = (stage, text, fraction) => postMessage({ type: "stage", stage, text, fraction });
  try {
    if (!kernel) {
      say("engine", "Loading the geometry engine (first time only)", 0);
      kernel = await OcctKernel.init({ wasm: wasmUrl });
    }
    const t0 = performance.now();
    const out = prepareTunnel(kernel, data.step, data.options, say);
    out.stats.seconds = (performance.now() - t0) / 1000;
    out.stats.memoryMB = Math.round(kernel.getRawModule().HEAP32.buffer.byteLength / 2 ** 20);
    const { step, labels, faces, solids, meta, stats, glb } = out;
    // The GLB is the one large result; its buffer moves rather than copies.
    postMessage({ type: "done", step, labels, faces, solids, meta, stats, glb },
      [glb.buffer]);
  } catch (e) {
    postMessage({
      type: "error",
      // A CutError is a fault in the car, phrased for the person who drew it;
      // anything else is the engine and gets a different sentence.
      carFault: e instanceof CutError,
      message: e instanceof CutError ? e.message
        : `The geometry engine stopped: ${e?.message || e}`,
    });
  } finally {
    try { kernel?.releaseAll(); } catch { /* the page replaces this worker */ }
  }
};
