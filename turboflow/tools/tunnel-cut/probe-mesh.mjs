// Probe: are meshShape vertices per-face contiguous? Are normals outward for
// reversed faces? Is triangle winding already orientation-corrected?
import { OcctKernel } from "occt-wasm";

const k = await OcctKernel.init();
const box = k.makeBox(10, 20, 30);
const cyl = k.translate(k.makeCylinder(5, 8), 5, 10, 30);
const shape = k.makeCompound([box, cyl]);
const mesh = k.meshShape(shape, { linearDeflection: 0.1, angularDeflection: 0.3 });
const faces = k.getSubShapes(shape, "face");
const nGroups = mesh.faceCount;

let contiguous = true;
const ranges = [];
for (let g = 0; g < nGroups; g++) {
  const t0 = mesh.faceGroups[g * 3], tc = mesh.faceGroups[g * 3 + 1];
  let lo = Infinity, hi = -Infinity;
  for (let t = t0; t < t0 + tc; t++) {
    for (let j = 0; j < 3; j++) {
      const vi = mesh.indices[t * 3 + j];
      lo = Math.min(lo, vi); hi = Math.max(hi, vi);
    }
  }
  ranges.push([lo, hi - lo + 1]);
  if (hi - lo + 1 !== tc * 3 && false) contiguous = false;
}
// Check non-overlap and contiguity across groups.
let ok = true;
let expect = 0;
for (let g = 0; g < nGroups; g++) {
  const [lo, cnt] = ranges[g];
  if (lo !== expect) { ok = false; console.log(`group ${g}: lo=${lo} expected=${expect}`); }
  expect += cnt;
}
console.log("vertices per-face contiguous & non-overlapping:", ok, "total:", expect, "vertexCount:", mesh.vertexCount);
console.log("ranges:", JSON.stringify(ranges));

// Normals: geometric normal of first triangle vs stored normal, per face,
// and whether it points outward from the shape centre.
const P = mesh.positions, N = mesh.normals;
for (let g = 0; g < nGroups; g++) {
  const t0 = mesh.faceGroups[g * 3];
  const a = mesh.indices[t0 * 3], b = mesh.indices[t0 * 3 + 1], c = mesh.indices[t0 * 3 + 2];
  const ax = P[a*3], ay = P[a*3+1], az = P[a*3+2];
  const ux = P[b*3]-ax, uy = P[b*3+1]-ay, uz = P[b*3+2]-az;
  const wx = P[c*3]-ax, wy = P[c*3+1]-ay, wz = P[c*3+2]-az;
  const gx = uy*wz-uz*wy, gy = uz*wx-ux*wz, gz = ux*wy-uy*wx;
  const gl = Math.hypot(gx,gy,gz) || 1;
  const nx = N[a*3], ny = N[a*3+1], nz = N[a*3+2];
  const dot = (gx*nx+gy*ny+gz*nz)/gl;
  // outward test: from triangle centroid toward shape bbox centre should be inward,
  // so outward normal points away from centre.
  const cx = (ax+P[b*3]+P[c*3])/3, cy=(ay+P[b*3+1]+ay+P[c*3+1])/3, cz=(az+P[b*3+2]+P[c*3+2])/3;
  const centre = { x: 5, y: 10, z: 15 };
  const out = (cx-centre.x)*gx + (cy-centre.y)*gy + (cz-centre.z)*gz;
  console.log(`face ${g} (${k.surfaceType(faces[g])}, ${k.shapeOrientation(faces[g])}): storedNormal·geomNormal=${dot.toFixed(3)} geomNormal·awayFromCentre=${(out/gl).toFixed(3)}`);
}
k.releaseAll();
console.log("probe done");
