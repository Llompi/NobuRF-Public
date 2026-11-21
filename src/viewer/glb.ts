/**
 * One coloured triangle mesh as a binary glTF 2.0 file (.glb), the format
 * Blender, Windows 3D Viewer, three.js and most CAD viewers open directly.
 * Unlit (KHR_materials_unlit), double-sided, vertex colours: the colours are
 * data, so no lighting should shade them.
 */
import type { LobeMesh } from './lobe_mesh';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const pad4 = (n: number) => (n + 3) & ~3;

export function encodeGlb(mesh: LobeMesh, name: string, scale = 1): Uint8Array {
  const vertices = mesh.positions.length / 3;
  const positions = mesh.positions.map((v) => v * scale);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertices; v++) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[3 * v + k]);
      max[k] = Math.max(max[k], positions[3 * v + k]);
    }
  }
  const views = [positions, mesh.colors, mesh.indices];
  const offsets: number[] = [];
  let binLength = 0;
  for (const view of views) {
    offsets.push(binLength);
    binLength = pad4(binLength + view.byteLength);
  }
  const gltf = {
    asset: { version: '2.0', generator: 'NobuRF' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{ nodes: [0] }],
    // glTF is +y up; the mesh has broadside on +z. Rotate -90 degrees about x so the beam points up in a viewer.
    nodes: [{ mesh: 0, name, rotation: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, material: 0 }] }],
    materials: [{
      name: 'directivity',
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
      extensions: { KHR_materials_unlit: {} },
    }],
    buffers: [{ byteLength: binLength }],
    bufferViews: [
      { buffer: 0, byteOffset: offsets[0], byteLength: positions.byteLength, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: offsets[1], byteLength: mesh.colors.byteLength, target: ARRAY_BUFFER },
      { buffer: 0, byteOffset: offsets[2], byteLength: mesh.indices.byteLength, target: ELEMENT_ARRAY_BUFFER },
    ],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: vertices, type: 'VEC3', min, max },
      { bufferView: 1, componentType: FLOAT, count: vertices, type: 'VEC3' },
      { bufferView: 2, componentType: UNSIGNED_INT, count: mesh.indices.length, type: 'SCALAR' },
    ],
  };
  // The JSON chunk is padded with spaces, the binary chunk with zeros (glTF 2.0, section 4.4).
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_JSON, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(jsonBytes, 20);
  const binStart = 20 + jsonLength;
  view.setUint32(binStart, binLength, true);
  view.setUint32(binStart + 4, CHUNK_BIN, true);
  views.forEach((v, n) => out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), binStart + 8 + offsets[n]));
  return out;
}
