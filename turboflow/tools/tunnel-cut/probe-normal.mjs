// Probe: is occt-wasm surfaceNormal orientation-aware (outward for reversed
// faces), or does it return the raw surface normal needing a manual flip?
import { OcctKernel } from "occt-wasm";

const k = await OcctKernel.init();
const box = k.makeBox(10, 20, 30);
const faces = k.getSubShapes(box, "face");
const centre = { x: 5, y: 10, z: 15 };

for (let i = 0; i < faces.length; i++) {
  const f = faces[i];
  const uv = k.uvBounds(f);
  const u = (uv.uMin + uv.uMax) / 2, v = (uv.vMin + uv.vMax) / 2;
  const n = k.surfaceNormal(f, u, v);
  const p = k.pointOnSurface(f, u, v);
  const b = k.getBoundingBox(f, { precise: false });
  const fc = { x: (b.xmin + b.xmax) / 2, y: (b.ymin + b.ymax) / 2, z: (b.zmin + b.zmax) / 2 };
  // outward = away from box centre
  const out = {
    x: fc.x - centre.x, y: fc.y - centre.y, z: fc.z - centre.z,
  };
  const ol = Math.hypot(out.x, out.y, out.z) || 1;
  const dot = (n.x * out.x + n.y * out.y + n.z * out.z) / ol;
  console.log(
    `face ${i} (${k.shapeOrientation(f)}): faceCentre=(${fc.x},${fc.y},${fc.z}) ` +
    `surfaceNormal=(${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}) ` +
    `dotWithOutward=${dot.toFixed(2)}`,
  );
}

// A cylinder inside a solid context: make a solid with a cylindrical hole and
// check the hole's face normal (should point INTO the hole = away from material
// = toward the axis for a hole). Simpler: cylinder face of a standalone solid.
const cyl = k.makeCylinder(5, 8);
const cf = k.getSubShapes(cyl, "face").find((f) => k.surfaceType(f) === "cylinder");
const cuv = k.uvBounds(cf);
const cn = k.surfaceNormal(cf, cuv.uMin + 0.1, (cuv.vMin + cuv.vMax) / 2);
const cp = k.pointOnSurface(cf, cuv.uMin + 0.1, (cuv.vMin + cuv.vMax) / 2);
console.log(`cylinder (${k.shapeOrientation(cf)}): p=(${cp.x.toFixed(2)},${cp.y.toFixed(2)},${cp.z.toFixed(2)}) n=(${cn.x.toFixed(2)},${cn.y.toFixed(2)},${cn.z.toFixed(2)})`);
// outward from the cylinder axis (0,0,z): radial direction at p
const rad = { x: cp.x, y: cp.y, z: 0 };
const rl = Math.hypot(rad.x, rad.y) || 1;
console.log(`dotWithRadialOutward=${((cn.x * rad.x + cn.y * rad.y) / rl).toFixed(2)}`);

k.releaseAll();
console.log("probe done");
