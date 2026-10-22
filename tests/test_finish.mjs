// The FINISH step: a case.zip in, the viewer's files out.
//
// Runs src/workbench/results/openfoam.js - the code the owner's browser runs
// on first view of a finished run - against the synthetic OpenFOAM case the
// SimScale mock serves (supabase/functions/simscale-mock/case.ts): a box
// tunnel around a box car, deflated, the shape SimScale's packages have.
// Every byte is read through the same read(start, end) the browser uses for
// Range requests, and the GLB is loaded back with three's GLTFLoader, which
// is what the viewer opens it with.
//
// Run: node tests/test_finish.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { convertCase, listZip, neededEntries } from "../src/workbench/results/openfoam.js";

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks += 1; };

const b64 = readFileSync(new URL("../supabase/functions/simscale-mock/case.ts", import.meta.url), "utf8")
  .match(/"([^"]+)"/)[1];
const zip = new Uint8Array(Buffer.from(b64, "base64"));
const reads = [];
const read = async (start, end) => { reads.push([start, end]); return zip.slice(start, end); };

const entries = await listZip(read, zip.length);
ok(entries.has("constant/polyMesh/points") && entries.has("100/p"), "the zip directory is read");
const need = neededEntries(entries);
ok(need.time === "100", "the last written time is the one read, not 50");
ok(Object.keys(need.fields).sort().join() === "U,p", "only the fields the case has are read");

const progress = [];
const { glb, surface } = await convertCase(read, zip.length, (f, label) => progress.push([f, label]));

// The car is the six inner sides, each 6 x 6 quads; the tunnel's six walls are left out.
ok(surface.triangleCount === 6 * 36 * 2, `the car's 216 quads become 432 triangles (${surface.triangleCount})`);
ok(surface.vertexCount === 6 * 49, `every side keeps its own 49 points (${surface.vertexCount})`);
const xs = surface.positions.filter((_, i) => i % 3 === 0);
ok(Math.min(...xs) >= -0.2 - 1e-6 && Math.max(...xs) <= 0.2 + 1e-6, "no tunnel wall point is in the surface");

const { p, U } = surface.fields;
ok(p && U, "both fields come out");
ok(p.values.length === surface.vertexCount && U.values.length === surface.vertexCount, "one value per vertex");
ok(p.values.every(Number.isFinite), "every vertex has a pressure");
ok(p.min < p.max && p.min > -5 && p.max < 25, `pressure spans the case's values (${p.min}..${p.max})`);
ok(U.min > 18 && U.max < 22, `velocity is a magnitude, about 20 m/s (${U.min}..${U.max})`);

ok(new TextDecoder().decode(glb.subarray(0, 4)) === "glTF", "the model is a GLB");
const gltf = await new Promise((res, rej) =>
  new GLTFLoader().parse(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), "", res, rej));
let mesh = null;
gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
ok(mesh, "GLTFLoader finds the mesh");
ok(mesh.geometry.getAttribute("position").count === surface.vertexCount,
  "the loaded model has exactly as many points as each field has values");

// An earlier time and the solver's settings are in the package and not
// needed: their bytes are never asked for. On a real case the volume
// solution is most of the gigabyte, and it is skipped the same way.
const notRead = ["50/p", "system/controlDict"].map((n) => entries.get(n).offset);
ok(!reads.some(([a]) => notRead.includes(a)), "entries the surface does not need are never fetched");
ok(progress.at(-1)[0] > 0.9, "progress is reported to the end");

console.log(`finish: ${checks} checks, a case becomes the viewer's model and fields`);
