// occt-wasm locates its own .wasm; pre-bundling it would move the JS away
// from the binary. Workers are ES modules so they can import cut-core.js.
export default {
  optimizeDeps: { exclude: ["occt-wasm"] },
  worker: { format: "es" },
};
