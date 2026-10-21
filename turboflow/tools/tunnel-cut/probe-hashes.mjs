// Probe: meshShape faceGroups layout and hash matching against subShapeHashes.
import { OcctKernel } from "occt-wasm";

const k = await OcctKernel.init();

// A box (6 faces) plus a cylinder on top (3 faces) = 9 faces, two solids.
const box = k.makeBox(10, 20, 30);
const cyl = k.translate(k.makeCylinder(5, 8), 5, 10, 30);
const shape = k.makeCompound([box, cyl]);

const mesh = k.meshShape(shape, { linearDeflection: 0.1, angularDeflection: 0.3 });
console.log("vertexCount", mesh.vertexCount, "triangleCount", mesh.triangleCount);
console.log("faceCount field:", mesh.faceCount, "faceGroups.length:", mesh.faceGroups?.length);

const faces = k.getSubShapes(shape, "face");
console.log("getSubShapes faces:", faces.length);

for (const ub of [0x7fffffff, 0xffffffff, 2 ** 31 - 1, 2 ** 32 - 1]) {
  const hashes = k.subShapeHashes(shape, "face", ub);
  let match = 0, order = 0;
  const byHash = new Map(hashes.map((h, i) => [h, i]));
  for (let g = 0; g < (mesh.faceCount ?? 0); g++) {
    const hash = mesh.faceGroups[g * 3 + 2];
    if (byHash.has(hash)) {
      match++;
      if (byHash.get(hash) === g) order++;
    }
  }
  console.log(`ub=${ub}: groups=${mesh.faceCount} matched=${match} in-order=${order}`);
}

// Show the first few groups and the hash list for eyeballing.
const n = Math.min(mesh.faceCount ?? 0, 12);
for (let g = 0; g < n; g++) {
  console.log(`group ${g}: triStart=${mesh.faceGroups[g * 3]} triCount=${mesh.faceGroups[g * 3 + 1]} hash=${mesh.faceGroups[g * 3 + 2]}`);
}
const hashes = k.subShapeHashes(shape, "face", 0x7fffffff);
console.log("subShapeHashes:", [...hashes].join(","));

// Check the tail garbage hypothesis: entries past 3*faceCount.
const total = mesh.faceGroups.length;
console.log("faceGroups total ints:", total, "= 3*faceCount?", total === 3 * (mesh.faceCount ?? 0), "= 4*faceCount?", total === 4 * (mesh.faceCount ?? 0));

// surfaceType / orientation / cylinder data on the cylinder side face.
const sideFace = faces[6]; // guess; will print types
for (let i = 0; i < faces.length; i++) {
  const t = k.surfaceType(faces[i]);
  const o = k.shapeOrientation(faces[i]);
  const cyl = k.getFaceCylinderData(faces[i]);
  console.log(`face ${i}: type=${t} orientation=${o} cyl=${cyl ? cyl.radius : "-"}`);
}

// uvBounds + pointOnSurface + surfaceNormal on a cylinder face.
const cylFace = faces.find((f) => k.surfaceType(f) === "cylinder");
if (cylFace) {
  const uv = k.uvBounds(cylFace);
  console.log("uvBounds:", JSON.stringify(uv));
  const p1 = k.pointOnSurface(cylFace, uv.uMin + (uv.uMax - uv.uMin) * 0.25, uv.vMin + (uv.vMax - uv.vMin) * 0.5);
  const n1 = k.surfaceNormal(cylFace, uv.uMin + (uv.uMax - uv.uMin) * 0.25, uv.vMin + (uv.vMax - uv.vMin) * 0.5);
  const p2 = k.pointOnSurface(cylFace, uv.uMin + (uv.uMax - uv.uMin) * 0.75, uv.vMin + (uv.vMax - uv.vMin) * 0.5);
  const n2 = k.surfaceNormal(cylFace, uv.uMin + (uv.uMax - uv.uMin) * 0.75, uv.vMin + (uv.vMax - uv.vMin) * 0.5);
  console.log("p1", JSON.stringify(p1), "n1", JSON.stringify(n1));
  console.log("p2", JSON.stringify(p2), "n2", JSON.stringify(n2));
  const cross = [
    n1.y * n2.z - n1.z * n2.y,
    n1.z * n2.x - n1.x * n2.z,
    n1.x * n2.y - n1.y * n2.x,
  ];
  console.log("cross(n1,n2):", JSON.stringify(cross));
  const r = k.getFaceCylinderData(cylFace).radius;
  console.log("axis point guess p1 - r*n1:", JSON.stringify({ x: p1.x - r * n1.x, y: p1.y - r * n1.y, z: p1.z - r * n1.z }));
}

k.releaseAll();
console.log("probe done");
