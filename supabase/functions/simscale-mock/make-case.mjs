// Writes case.ts: a tiny OpenFOAM case, zipped, for the SimScale mock to
// serve as a run's SOLUTION_FIELD. The shape is what SimScale sends - a
// case.foam, constant/polyMesh, and a directory per written time - with a
// box tunnel (six walls flat on the bounding box) around a box car
// (subdivided, so the viewer has something to colour).
//
//   node supabase/functions/simscale-mock/make-case.mjs
import { deflateRawSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const header = (cls, obj) =>
  `FoamFile\n{\n    version 2.0;\n    format ascii;\n    class ${cls};\n    object ${obj};\n}\n\n`;

const points = [];
const faces = [];
const patches = [];
const pt = (x, y, z) => points.push([x, y, z]) - 1;

// The tunnel: one quad per wall, on the bounding box.
const T = [[-1, -0.5, 0], [1, 0.5, 0.6]];
const corner = (i, j, k) => pt(T[i][0], T[j][1], T[k][2]);
const c = [];
for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) c[i * 4 + j * 2 + k] = corner(i, j, k);
const walls = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];

// The car: a box lifted off the floor, each side split into N x N quads.
const N = 6;
const B = [[-0.2, -0.08, 0.02], [0.2, 0.08, 0.12]];
const sides = [
  [0, 0, [1, 2]], [0, 1, [1, 2]], [1, 0, [0, 2]], [1, 1, [0, 2]], [2, 0, [0, 1]], [2, 1, [0, 1]],
];

let start = 0;
const patch = (fs) => {
  patches.push({ name: `face${patches.length + 1}`, start, n: fs.length });
  faces.push(...fs);
  start += fs.length;
};
for (const w of walls) patch([w]);
for (const [axis, side, [u, v]] of sides) {
  const grid = [];
  for (let a = 0; a <= N; a++) {
    grid.push([]);
    for (let b = 0; b <= N; b++) {
      const p = [0, 0, 0];
      p[axis] = B[side][axis];
      p[u] = B[0][u] + (B[1][u] - B[0][u]) * (a / N);
      p[v] = B[0][v] + (B[1][v] - B[0][v]) * (b / N);
      grid[a].push(pt(...p));
    }
  }
  const fs = [];
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
    fs.push([grid[a][b], grid[a + 1][b], grid[a + 1][b + 1], grid[a][b + 1]]);
  }
  patch(fs);
}

const centre = (f) => [0, 1, 2].map((ax) => f.reduce((s, i) => s + points[i][ax], 0) / f.length);
const pField = (f) => { const [x, , z] = centre(f); return +(40 * (0.2 - x) - 10 * z).toFixed(4); };
const uField = (f) => { const [x, y, z] = centre(f); return [+(-20 + 5 * x).toFixed(4), +(3 * y).toFixed(4), +(2 * z).toFixed(4)]; };

const list = (items, fmt) => `${items.length}\n(\n${items.map(fmt).join("\n")}\n)\n`;
const boundary = (fmt, kind) => patches.map((p) => {
  const fs = faces.slice(p.start, p.start + p.n);
  return `    ${p.name}\n    {\n        type calculated;\n        value nonuniform List<${kind}> ${list(fs, fmt)}    ;\n    }`;
}).join("\n");

const files = {
  "case.foam": "",
  "system/controlDict": header("dictionary", "controlDict") + "application simpleFoam;\nendTime 100;\n",
  "constant/polyMesh/points": header("vectorField", "points") + list(points, (p) => `(${p.join(" ")})`),
  "constant/polyMesh/faces": header("faceList", "faces") + list(faces, (f) => `${f.length}(${f.join(" ")})`),
  "constant/polyMesh/owner": header("labelList", "owner") + list(faces, () => "0"),
  "constant/polyMesh/neighbour": header("labelList", "neighbour") + "0\n(\n)\n",
  "constant/polyMesh/boundary": header("polyBoundaryMesh", "boundary")
    + list(patches, (p) => `    ${p.name}\n    {\n        type patch;\n        nFaces ${p.n};\n        startFace ${p.start};\n    }`),
  "50/p": header("volScalarField", "p") + "dimensions [0 2 -2 0 0 0 0];\ninternalField uniform 0;\nboundaryField\n{\n"
    + boundary(() => "0", "scalar") + "\n}\n",
  "100/p": header("volScalarField", "p") + "dimensions [0 2 -2 0 0 0 0];\ninternalField uniform 0;\nboundaryField\n{\n"
    + boundary(pField, "scalar") + "\n}\n",
  "100/U": header("volVectorField", "U") + "dimensions [0 1 -1 0 0 0 0];\ninternalField uniform (0 0 0);\nboundaryField\n{\n"
    + boundary((f) => `(${uField(f).join(" ")})`, "vector") + "\n}\n",
};

// A zip with deflated entries, as SimScale's packages are.
const parts = [];
const central = [];
let offset = 0;
for (const [name, text] of Object.entries(files)) {
  const raw = Buffer.from(text, "utf8");
  const data = deflateRawSync(raw);
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); local.writeUInt32LE(0, 10); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
  parts.push(local, nameBuf, data);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(8, 10); cen.writeUInt32LE(0, 12); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
  central.push(cen, nameBuf);
  offset += 30 + nameBuf.length + data.length;
}
const cdSize = central.reduce((s, b) => s + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...parts, ...central, end]);

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, "case.ts"),
  "// Generated by make-case.mjs: a synthetic OpenFOAM case, zipped and base64'd.\n"
  + `export const CASE_ZIP_B64 = "${zip.toString("base64")}";\n`);
console.log(`case.ts: ${zip.length} bytes zipped, ${faces.length} faces in ${patches.length} patches`);
