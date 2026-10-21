// Runs the cut off the page's thread, so the page keeps drawing while OCC
// works. One engine per worker, loaded on the first job and reused; the page
// throws the whole worker away after anything unexpected, which is the only
// sure way to get back memory an engine fault may have left in a bad state.
import { OcctKernel } from "occt-wasm";
import wasmUrl from "occt-wasm/dist/occt-wasm.wasm?url";
import { prepareTunnel, CutError } from "./cut-core.js";

let kernel = null;

onmessage = async ({ data }) => {
  const say = (stage, text) => postMessage({ type: "stage", stage, text });
  try {
    if (!kernel) {
      say("engine", "Loading the geometry engine (first time only)");
      kernel = await OcctKernel.init({ wasm: wasmUrl });
    }
    const t0 = performance.now();
    const out = prepareTunnel(kernel, data.step, data.options, say);
    out.stats.seconds = (performance.now() - t0) / 1000;
    out.stats.memoryMB = Math.round(kernel.getRawModule().HEAP32.buffer.byteLength / 2 ** 20);
    postMessage({ type: "done", ...out });
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
