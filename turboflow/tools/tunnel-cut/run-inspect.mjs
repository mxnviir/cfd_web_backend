// Scratch probe: the browser inspect, run in Node on the same engine, on the
// trial car. Run: node run-inspect.mjs <car.step>
import { readFileSync } from "node:fs";
import { OcctKernel } from "occt-wasm";
import { inspectCar } from "../../src/workbench/geometry/inspect-core.js";

const [file] = process.argv.slice(2);
const k = await OcctKernel.init();
const t0 = performance.now();
const out = await inspectCar(k, readFileSync(file, "utf8"), { version: 1, unit: "mm" },
  (stage, text, f) => console.error(`${((performance.now() - t0) / 1000).toFixed(1).padStart(6)}s ${stage}: ${text} (${(f * 100).toFixed(0)}%)`));
console.log(JSON.stringify({
  stats: { ...out.stats, seconds: +((performance.now() - t0) / 1000).toFixed(1) },
  wheels: out.meta.wheels.map((w) => [w.name, w.radius_m, w.cx_m, w.cy_m, w.cz_m, w.face_indices]),
  bbox: out.meta.bbox,
  domain: out.meta.domain,
  symmetry: [out.meta.symmetry_plane_y, out.meta.symmetry_kind],
  frontal: [out.meta.frontal_area_m2, out.meta.frontal_area_half_m2],
  facesJson: {
    version: out.faces.version, unit: out.faces.unit, scale: out.faces.scale_to_m,
    step_id_count: out.faces.step_id_count, faces: out.faces.faces.length,
    adjacency: out.faces.adjacency.length,
    sample: out.faces.faces[0],
  },
  solidsJson: out.solids,
  glbBytes: out.glb.byteLength, thumb: out.thumb?.byteLength ?? null,
  stepBytes: out.step.length,
}, null, 1));
