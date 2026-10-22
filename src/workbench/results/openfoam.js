// A finished run's OpenFOAM case, turned into what the viewer draws.
//
// This is the FINISH step of the run pipeline, and it runs in the owner's
// browser: the server copies SimScale's case into Storage untouched, and the
// first time the owner opens the run, this reads it and writes
//
//   results.glb        the car's surface, triangles only
//   fields/<name>.bin  one Float32 per vertex of that surface, per field
//   fields.json        what fields exist, their ranges and paths
//
// - the same three things simscale_job.export_results_for_viewer wrote with
// pyvista on Cloud Run, in the same shapes, so the viewer cannot tell.
//
// A case is a zip of hundreds of MB, most of it the volume solution nobody
// draws. Nothing reads the whole of it: the zip's directory is read from its
// end, and then only the entries the surface needs - the mesh's points, faces,
// owner and boundary, and the last time's fields - are fetched, each by an
// HTTP Range request for exactly its bytes.
//
// Pure: no DOM, no network of its own. `read(start, end)` supplies bytes, so
// the same code runs in a Web Worker against a signed URL and in Node
// against a file.

/** The fields the viewer can colour by, as export_results_for_viewer named them. */
export const RESULT_FIELDS = {
  p: "Pressure", U: "Velocity", k: "Turb. kinetic energy",
  omega: "Specific dissipation", nut: "Turb. viscosity", wallShearStress: "Wall shear stress",
};

// ── the zip ────────────────────────────────────────────────────────────────
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** The central directory: every entry's name, method, sizes and offset. */
export async function listZip(read, size) {
  const tailLen = Math.min(size, 66000);
  const tail = await read(size - tailLen, size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("the results are not a zip");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // Zip64: a package over 4 GB, or with more than 65535 entries.
  if (eocd >= 20 && u32(tail, eocd - 20) === 0x07064b50) {
    const recOffset = u64(tail, eocd - 12);
    const rec = await read(recOffset, recOffset + 56);
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  const cd = await read(cdOffset, cdOffset + cdSize);
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count && u32(cd, p) === 0x02014b50; n++) {
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let usize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let offset = u32(cd, p + 42);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    // Zip64 sizes and offset live in the extra field when the 32-bit ones are full.
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
        if (offset === 0xffffffff) { offset = u64(cd, q); }
      }
      e += 4 + len;
    }
    if (!name.endsWith("/")) entries.set(name, { name, method, csize, usize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One entry's bytes, uncompressed (and un-gzipped, for OpenFOAM's .gz files). */
export async function readEntry(read, entry) {
  const head = await read(entry.offset, entry.offset + 30);
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = await read(start, start + entry.csize);
  let data = entry.method === 8 ? await inflate(raw, "deflate-raw")
    : entry.method === 0 ? raw : null;
  if (!data) throw new Error(`${entry.name} is compressed in a way this cannot read`);
  if (entry.name.endsWith(".gz")) data = await inflate(data, "gzip");
  return data;
}

// ── OpenFOAM files ─────────────────────────────────────────────────────────
const latin1 = (b) => new TextDecoder("latin1").decode(b);

/** The FoamFile header's format: ascii or binary. */
function formatOf(text) {
  const m = /FoamFile\s*\{[^}]*format\s+(\w+)\s*;/.exec(text);
  return m ? m[1] : "ascii";
}

/**
 * The list that starts at `from` in `buf`: `N ( ... )` in ascii, or
 * `N ( <bytes> )` in binary. Returns the values and where the list ended.
 *   kind: "scalar" (1 double), "vector" (3 doubles), "label" (1 int32),
 *         "face" (a list of labels, ascii only - binary faces are compact).
 */
function readList(buf, text, from, kind, binary, labelBytes = 4) {
  const head = /(\d+)\s*\(/g;
  head.lastIndex = from;
  const m = head.exec(text);
  if (!m) throw new Error("expected a list");
  const n = Number(m[1]);
  let pos = m.index + m[0].length;
  if (binary && kind !== "face") {
    const width = kind === "vector" ? 3 : 1;
    const bytes = kind === "label" ? labelBytes : 8;
    const view = new DataView(buf.buffer, buf.byteOffset + pos, n * width * bytes);
    const out = kind === "label" ? new Int32Array(n) : new Float64Array(n * width);
    for (let i = 0; i < n * width; i++) {
      out[i] = kind === "label" ? (bytes === 8 ? Number(view.getBigInt64(i * 8, true)) : view.getInt32(i * 4, true))
        : view.getFloat64(i * 8, true);
    }
    return { values: out, end: pos + n * width * bytes + 1, n };
  }
  if (kind === "face") {
    const faces = new Array(n);
    const re = /(\d+)\s*\(([^)]*)\)/g;
    re.lastIndex = pos;
    for (let i = 0; i < n; i++) {
      const f = re.exec(text);
      faces[i] = f[2].trim().split(/\s+/).map(Number);
      pos = re.lastIndex;
    }
    return { values: faces, end: text.indexOf(")", pos) + 1, n };
  }
  const width = kind === "vector" ? 3 : 1;
  const out = kind === "label" ? new Int32Array(n) : new Float64Array(n * width);
  const close = n === 0 ? text.indexOf(")", pos) : -1;
  if (n === 0) return { values: out, end: close + 1, n };
  const num = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
  num.lastIndex = pos;
  for (let i = 0; i < n * width; i++) out[i] = Number(num.exec(text)[0]);
  return { values: out, end: text.indexOf(")", num.lastIndex) + 1, n };
}

const bodyStart = (text) => {
  const h = text.indexOf("FoamFile");
  return h < 0 ? 0 : text.indexOf("}", h) + 1;
};

export function parsePoints(buf) {
  const text = latin1(buf);
  return readList(buf, text, bodyStart(text), "vector", formatOf(text) === "binary").values;
}

export function parseLabels(buf) {
  const text = latin1(buf);
  const labelBytes = /label=64/.test(text) ? 8 : 4;
  return readList(buf, text, bodyStart(text), "label", formatOf(text) === "binary", labelBytes).values;
}

/** faces: ascii `4(a b c d)` lists, or binary faceCompactList (offsets, then labels). */
export function parseFaces(buf) {
  const text = latin1(buf);
  const from = bodyStart(text);
  if (formatOf(text) !== "binary") return readList(buf, text, from, "face", false).values;
  const labelBytes = /label=64/.test(text) ? 8 : 4;
  const offsets = readList(buf, text, from, "label", true, labelBytes);
  const labels = readList(buf, text, offsets.end, "label", true, labelBytes);
  const faces = new Array(offsets.n - 1);
  for (let i = 0; i < offsets.n - 1; i++) {
    faces[i] = Array.from(labels.values.subarray(offsets.values[i], offsets.values[i + 1]));
  }
  return faces;
}

/** boundary: [{name, start, n}], in file order. */
export function parseBoundary(buf) {
  const text = latin1(buf).slice(bodyStart(latin1(buf)));
  const out = [];
  const re = /(\w[\w.:-]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const n = /nFaces\s+(\d+)/.exec(m[2]);
    const s = /startFace\s+(\d+)/.exec(m[2]);
    if (n && s) out.push({ name: m[1], n: Number(n[1]), start: Number(s[1]) });
  }
  return out;
}

/**
 * A field file: its internal (cell) values, and each patch's face values if
 * the file carries them. A zeroGradient patch writes no value; its faces
 * take their cell's value, which is what the boundary is defined to be.
 */
export function parseField(buf) {
  const text = latin1(buf);
  const binary = formatOf(text) === "binary";
  const vector = /class\s+vol(Vector)Field/.test(text);
  const kind = vector ? "vector" : "scalar";
  const width = vector ? 3 : 1;
  const uniform = (s) => (vector ? s.replace(/[()]/g, " ").trim().split(/\s+/).map(Number) : [Number(s)]);

  const internal = (() => {
    const at = text.search(/internalField\s+/);
    const rest = text.slice(at);
    const u = /^internalField\s+uniform\s+([^;]+);/.exec(rest);
    if (u) return { uniform: uniform(u[1]) };
    return { values: readList(buf, text, at, kind, binary).values };
  })();

  const patches = new Map();
  const bf = text.indexOf("boundaryField");
  const re = /(\w[\w.:-]*)\s*\{/g;
  re.lastIndex = text.indexOf("{", bf) + 1;
  let m;
  while ((m = re.exec(text))) {
    // The patch's own block, by brace depth (a value list holds parentheses, not braces).
    let depth = 1;
    let i = re.lastIndex;
    while (depth && i < text.length) {
      const c = text[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const block = text.slice(re.lastIndex, i - 1);
    const v = /\bvalue\s+(uniform|nonuniform)\s+/.exec(block);
    if (v?.[1] === "uniform") {
      patches.set(m[1], { uniform: uniform(/uniform\s+([^;]+);/.exec(block.slice(v.index))[1]) });
    } else if (v) {
      patches.set(m[1], { values: readList(buf, text, re.lastIndex + v.index + v[0].length, kind, binary).values });
    }
    re.lastIndex = i;
    if (/^\s*}/.test(text.slice(i))) break;
  }
  return { width, internal, patches };
}

// ── the surface ────────────────────────────────────────────────────────────
/** Which entries a case's surface needs: the mesh, and the last time's fields. */
export function neededEntries(entries) {
  const names = [...entries.keys()];
  const prefix = names.find((n) => /(^|\/)case\.foam$/.test(n))?.replace(/case\.foam$/, "") ?? "";
  const at = (rel) => entries.get(prefix + rel) ?? entries.get(`${prefix}${rel}.gz`);
  const times = [...new Set(names.filter((n) => n.startsWith(prefix))
    .map((n) => n.slice(prefix.length).split("/")[0])
    .filter((d) => /^\d+(\.\d+)?(e[-+]?\d+)?$/.test(d) && d !== "0"))]
    .sort((x, y) => Number(x) - Number(y));
  const last = times[times.length - 1];
  if (!last) throw new Error("the case has no solution in it");
  const mesh = {
    points: at("constant/polyMesh/points"),
    faces: at("constant/polyMesh/faces"),
    owner: at("constant/polyMesh/owner"),
    boundary: at("constant/polyMesh/boundary"),
  };
  for (const [k, v] of Object.entries(mesh)) if (!v) throw new Error(`the case has no polyMesh/${k}`);
  const fields = {};
  for (const name of Object.keys(RESULT_FIELDS)) {
    const e = at(`${last}/${name}`);
    if (e) fields[name] = e;
  }
  return { mesh, fields, time: last };
}

/**
 * The car's surface with its fields. The car is every boundary patch that is
 * not a tunnel wall; the walls are the patches lying flat on the domain's
 * bounding box (SimScale names patches face1..faceN, so position is the
 * only thing that tells them apart).
 */
export function buildSurface({ points, faces, owner, boundary, fields }) {
  const bounds = (ids) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) for (let a = 0; a < 3; a++) {
      const v = points[id * 3 + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
    return { lo, hi };
  };
  const patchPoints = (p) => {
    const ids = new Set();
    for (let f = p.start; f < p.start + p.n; f++) for (const id of faces[f]) ids.add(id);
    return ids;
  };
  const withFaces = boundary.filter((p) => p.n > 0).map((p) => ({ ...p, box: bounds(patchPoints(p)) }));
  const lo = [0, 1, 2].map((a) => Math.min(...withFaces.map((p) => p.box.lo[a])));
  const hi = [0, 1, 2].map((a) => Math.max(...withFaces.map((p) => p.box.hi[a])));
  const tol = Math.max(...[0, 1, 2].map((a) => hi[a] - lo[a])) * 1e-6;
  const wall = (p) => [0, 1, 2].some((a) => p.box.hi[a] - p.box.lo[a] <= tol
    && (Math.abs(p.box.lo[a] - lo[a]) <= tol || Math.abs(p.box.hi[a] - hi[a]) <= tol));
  const car = withFaces.filter((p) => !wall(p));
  if (!car.length) throw new Error("nothing in the case is the car");

  // Points used by the car, renumbered from zero; faces fanned into triangles.
  const local = new Map();
  const pos = [];
  const tris = [];
  const faceOf = [];
  for (const p of car) for (let f = p.start; f < p.start + p.n; f++) {
    const ids = faces[f].map((id) => {
      if (!local.has(id)) {
        local.set(id, local.size);
        pos.push(points[id * 3], points[id * 3 + 1], points[id * 3 + 2]);
      }
      return local.get(id);
    });
    faceOf.push({ patch: p, face: f, ids });
    for (let k = 1; k + 1 < ids.length; k++) tris.push(ids[0], ids[k], ids[k + 1]);
  }
  const vertexCount = local.size;

  // Each field: the face values (the patch's own, or its cells'), averaged
  // onto the points they share. Vectors become magnitudes.
  const out = {};
  for (const [name, field] of Object.entries(fields)) {
    const sum = new Float64Array(vertexCount);
    const count = new Uint32Array(vertexCount);
    const valueAt = (p, f) => {
      const patch = field.patches.get(p.name);
      const pick = (src, i) => {
        if (src.uniform) return src.uniform;
        const w = field.width;
        return Array.from(src.values.subarray(i * w, i * w + w));
      };
      if (patch) return pick(patch, f - p.start);
      return pick(field.internal, owner[f]);
    };
    for (const { patch, face, ids } of faceOf) {
      const v = valueAt(patch, face);
      const s = v.length === 3 ? Math.hypot(v[0], v[1], v[2]) : v[0];
      if (!Number.isFinite(s)) continue;
      for (const id of ids) { sum[id] += s; count[id] += 1; }
    }
    const values = new Float32Array(vertexCount);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
      values[i] = count[i] ? sum[i] / count[i] : NaN;
      if (count[i]) { min = Math.min(min, values[i]); max = Math.max(max, values[i]); }
    }
    if (Number.isFinite(min)) out[name] = { values, min, max };
  }
  return {
    positions: new Float32Array(pos),
    indices: vertexCount > 65535 ? new Uint32Array(tris) : new Uint16Array(tris),
    vertexCount,
    triangleCount: tris.length / 3,
    fields: out,
  };
}

// ── GLB ────────────────────────────────────────────────────────────────────
/** A one-mesh glTF binary: positions and triangle indices, nothing else. */
export function toGlb({ positions, indices, vertexCount }) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const a = i % 3;
    if (positions[i] < min[a]) min[a] = positions[i];
    if (positions[i] > max[a]) max[a] = positions[i];
  }
  const pad = (n) => (n + 3) & ~3;
  const posBytes = positions.byteLength;
  const idxBytes = indices.byteLength;
  const bin = new Uint8Array(pad(posBytes) + pad(idxBytes));
  bin.set(new Uint8Array(positions.buffer, positions.byteOffset, posBytes), 0);
  bin.set(new Uint8Array(indices.buffer, indices.byteOffset, idxBytes), pad(posBytes));
  const json = {
    asset: { version: "2.0", generator: "TurboFlow results" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: pad(posBytes), byteLength: idxBytes, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3", min, max },
      { bufferView: 1, componentType: indices instanceof Uint32Array ? 5125 : 5123, count: indices.length, type: "SCALAR" },
    ],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(pad(jsonBytes.length)).fill(0x20);
  jsonPadded.set(jsonBytes);
  jsonBytes = jsonPadded;
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const glb = new Uint8Array(total);
  const dv = new DataView(glb.buffer);
  dv.setUint32(0, 0x46546c67, true);  // "glTF"
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonBytes, 20);
  dv.setUint32(20 + jsonBytes.length, bin.length, true);
  dv.setUint32(24 + jsonBytes.length, 0x004e4942, true); // "BIN\0"
  glb.set(bin, 28 + jsonBytes.length);
  return glb;
}

/** Everything FINISH needs from a case, given a way to read its bytes. */
export async function convertCase(read, size, onProgress = () => {}) {
  onProgress(0.02, "Reading the results package");
  const entries = await listZip(read, size);
  const { mesh, fields: fieldEntries, time } = neededEntries(entries);
  const steps = 4 + Object.keys(fieldEntries).length;
  let done = 0;
  const step = async (label, entry, parse) => {
    onProgress(0.05 + 0.8 * (done / steps), label);
    const value = parse(await readEntry(read, entry));
    done += 1;
    return value;
  };
  const points = await step("Reading the mesh points", mesh.points, parsePoints);
  const faces = await step("Reading the mesh faces", mesh.faces, parseFaces);
  const owner = await step("Reading the mesh cells", mesh.owner, parseLabels);
  const boundary = await step("Reading the boundary", mesh.boundary, parseBoundary);
  const fields = {};
  for (const [name, entry] of Object.entries(fieldEntries)) {
    fields[name] = await step(`Reading ${RESULT_FIELDS[name].toLowerCase()}`, entry, parseField);
  }
  onProgress(0.88, "Building the surface");
  const surface = buildSurface({ points, faces, owner, boundary, fields });
  onProgress(0.95, "Writing the model");
  return { glb: toGlb(surface), surface, time };
}
