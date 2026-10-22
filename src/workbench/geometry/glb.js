// A GLB 2.0 writer for the tunnel mesh, with nothing but the platform in it:
// one mesh, POSITION/NORMAL/_FACEID attributes and uint32 indices, exactly
// what the Workbench's viewer loads (three.js GLTFLoader, which lowercases
// the custom attribute to _faceid and paints a selection over a face's own
// vertex run).
//
// The JSON chunk is padded with spaces and the binary chunk with zeros, both
// to 4-byte alignment. Every component here is 4-byte already, so the binary
// chunk needs no padding.

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const GLB_MAGIC = 0x46546c67;   // "glTF"
const JSON_CHUNK = 0x4e4f534a;   // "JSON"
const BIN_CHUNK = 0x004e4942;    // "BIN\0"

/**
 * `mesh` is what meshByFace returns: positions/normals as Float32Array,
 * faceIds (the per-vertex _FACEID) as Float32Array, indices as Uint32Array.
 * Returns the GLB as a Uint8Array.
 */
export function buildGlb(mesh) {
  const { positions, normals, faceIds, indices } = mesh;
  const count = positions.length / 3;

  const posBytes = positions.byteLength;
  const nrmBytes = normals.byteLength;
  const fidBytes = faceIds.byteLength;
  const idxBytes = indices.byteLength;
  const nrmOff = posBytes;
  const fidOff = nrmOff + nrmBytes;
  const idxOff = fidOff + fidBytes;
  const binLength = idxOff + idxBytes;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }

  const json = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: 0, NORMAL: 1, _FACEID: 2 },
        indices: 3,
        mode: 4,
      }],
    }],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count, type: "VEC3", min, max },
      { bufferView: 1, componentType: FLOAT, count, type: "VEC3" },
      { bufferView: 2, componentType: FLOAT, count, type: "SCALAR" },
      { bufferView: 3, componentType: UNSIGNED_INT, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes },
      { buffer: 0, byteOffset: nrmOff, byteLength: nrmBytes },
      { buffer: 0, byteOffset: fidOff, byteLength: fidBytes },
      { buffer: 0, byteOffset: idxOff, byteLength: idxBytes },
    ],
    buffers: [{ byteLength: binLength }],
  };
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4 !== 0) jsonText += " ";
  const jsonBytes = new TextEncoder().encode(jsonText);

  const total = 12 + 8 + jsonBytes.length + 8 + binLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, JSON_CHUNK, true);
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.length;
  dv.setUint32(binAt, binLength, true);
  dv.setUint32(binAt + 4, BIN_CHUNK, true);
  out.set(new Uint8Array(positions.buffer, positions.byteOffset, posBytes), binAt + 8);
  out.set(new Uint8Array(normals.buffer, normals.byteOffset, nrmBytes), binAt + 8 + nrmOff);
  out.set(new Uint8Array(faceIds.buffer, faceIds.byteOffset, fidBytes), binAt + 8 + fidOff);
  out.set(new Uint8Array(indices.buffer, indices.byteOffset, idxBytes), binAt + 8 + idxOff);
  return out;
}
