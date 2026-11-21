/**
 * The 3D radiation lobe: the directivity pattern as a closed surface whose
 * radius is the level in dB above a floor `rangeDb` below the peak (the peak
 * at radius 1, the floor at the origin), coloured on the magnitude scale. One
 * mesh for the viewer (scene3d.ts) and the glTF export (glb.ts).
 */
import { MAGNITUDE_SCALE, linearLut } from './colormap';

export interface LobeMesh {
  /** x, y, z per vertex; +z is broadside. Peak at radius 1. */
  positions: Float32Array;
  /** Linear RGB per vertex, 0..1. */
  colors: Float32Array;
  /** Triangles, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

const MAGNITUDE_LUT = linearLut(MAGNITUDE_SCALE);

/**
 * `thetaDeg` must run 0..180 or 0..90 inclusive (a hemisphere pattern gives an
 * open bowl), `phiDeg` 0..360 exclusive; `levelDb` at [t * phiCount + p].
 */
export function lobeMesh(thetaDeg: ArrayLike<number>, phiDeg: ArrayLike<number>, levelDb: ArrayLike<number>, rangeDb: number): LobeMesh {
  const nt = thetaDeg.length;
  const np = phiDeg.length;
  if (levelDb.length !== nt * np) throw new Error(`lobeMesh: ${levelDb.length} levels for a ${nt} x ${np} grid`);
  let peak = -Infinity;
  for (let n = 0; n < levelDb.length; n++) peak = Math.max(peak, levelDb[n]);
  // The seam column (phi = 360) repeats phi = 0 so the colours and normals do not wrap across the mesh.
  const columns = np + 1;
  const positions = new Float32Array(nt * columns * 3);
  const colors = new Float32Array(nt * columns * 3);
  for (let t = 0; t < nt; t++) {
    const theta = (thetaDeg[t] * Math.PI) / 180;
    for (let c = 0; c < columns; c++) {
      const phi = ((c === np ? 360 : phiDeg[c]) * Math.PI) / 180;
      const level = Math.max(0, (levelDb[t * np + (c % np)] - (peak - rangeDb)) / rangeDb);
      const v = t * columns + c;
      positions[3 * v] = level * Math.sin(theta) * Math.cos(phi);
      positions[3 * v + 1] = level * Math.sin(theta) * Math.sin(phi);
      positions[3 * v + 2] = level * Math.cos(theta);
      const lut = 3 * Math.round(level * 255);
      colors.set(MAGNITUDE_LUT.subarray(lut, lut + 3), 3 * v);
    }
  }
  const indices = new Uint32Array((nt - 1) * np * 6);
  let n = 0;
  for (let t = 0; t < nt - 1; t++) {
    for (let c = 0; c < np; c++) {
      const a = t * columns + c;
      // (a, a + columns, a + 1) steps along theta then phi: theta_hat x phi_hat = r_hat, so it faces outward.
      indices.set([a, a + columns, a + 1, a + 1, a + columns, a + columns + 1], n);
      n += 6;
    }
  }
  return { positions, colors, indices };
}
