import { describe, expect, it } from 'vitest';
import { VOLUME_DFT_COMPONENTS, volumeDftIndex, volumeDftLength, type VolumeDftComponent } from '../src/engine/volume_dft';
import { cutComponent, cutGrid, cutVector, magnitude, nearestCutIndex } from '../src/workbench/field_cut';
import type { FieldMaps } from '../src/workbench/solve';
import { VOLUME_BUDGET_BYTES, volumeFrequencies } from '../src/workbench/solve';

/** Graded lines, so the interpolation weights are not all one half. */
const xMm = Float64Array.from([0, 1, 2.5, 3, 4.5, 6, 6.2]);
const yMm = Float64Array.from([-2, -1, 0, 0.5, 2]);
const zMm = Float64Array.from([0, 0.4, 0.8, 1.6, 3]);
const mid = (lines: Float64Array, n: number) => (lines[n] + lines[Math.min(n + 1, lines.length - 1)]) / 2;
const HALF: Record<VolumeDftComponent, string> = { ex: 'x', ey: 'y', ez: 'z', hx: 'yz', hy: 'xz', hz: 'xy' };

/** A field linear in x, y, z (different per component), sampled at each component's own Yee position. */
const linear = (c: number, x: number, y: number, z: number) => (c + 1) * (1 + 0.5 * x - 0.25 * y + 2 * z);

function syntheticFields(): FieldMaps {
  const layout = { nx: xMm.length, ny: yMm.length, nz: zMm.length, frequencies: 2 };
  const accumulators = new Float32Array(volumeDftLength(layout));
  for (let f = 0; f < layout.frequencies; f++) {
    VOLUME_DFT_COMPONENTS.forEach((component, c) => {
      for (let k = 0; k < layout.nz; k++) for (let j = 0; j < layout.ny; j++) for (let i = 0; i < layout.nx; i++) {
        const x = HALF[component].includes('x') ? mid(xMm, i) : xMm[i];
        const y = HALF[component].includes('y') ? mid(yMm, j) : yMm[j];
        const z = HALF[component].includes('z') ? mid(zMm, k) : zMm[k];
        const at = volumeDftIndex(layout, f, component, i, j, k);
        accumulators[at] = linear(c, x, y, z) * (f + 1);
        accumulators[at + 1] = -linear(c, x, y, z);
      }
    });
  }
  return {
    xMm, yMm, pml: { xLow: 1, xHigh: 1, yLow: 1, yHigh: 1 },
    ezLayer: 'sub', ezZMm: 0.4, copperLayer: 'top', copperZMm: 0.8, copperMask: new Uint8Array(0), planes: [],
    volume: { zMm, pmlZ: { low: 1, high: 1 }, frequencies: 2, accumulators },
    volumeSkipped: null,
    volumeAsked: true,
  };
}

describe('field cuts', () => {
  const fields = syntheticFields();
  const volume = fields.volume!;

  it('puts every component on the nodes exactly for a linear field, on every plane', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const cut = { axis, index: 2 };
      const grid = cutGrid(fields, volume, cut);
      VOLUME_DFT_COMPONENTS.forEach((component, c) => {
        const values = cutComponent(fields, volume, 1, cut, component);
        for (let b = 0; b < grid.vMm.length; b++) for (let a = 0; a < grid.uMm.length; a++) {
          const p = { x: 0, y: 0, z: 0 };
          p[axis] = grid.atMm;
          p[grid.u] = grid.uMm[a];
          p[grid.v] = grid.vMm[b];
          const n = a + grid.uMm.length * b;
          expect(values.re[n]).toBeCloseTo(2 * linear(c, p.x, p.y, p.z), 4);
          expect(values.im[n]).toBeCloseTo(-linear(c, p.x, p.y, p.z), 4);
        }
      });
    }
  });

  it('leaves the PML out and names the in-plane axes', () => {
    const grid = cutGrid(fields, volume, { axis: 'y', index: 1 });
    expect([grid.u, grid.v]).toEqual(['x', 'z']);
    expect(Array.from(grid.uMm)).toEqual(Array.from(xMm.slice(1, -1)));
    expect(Array.from(grid.vMm)).toEqual(Array.from(zMm.slice(1, -1)));
    expect(grid.atMm).toBe(yMm[1]);
    expect(() => cutGrid(fields, volume, { axis: 'z', index: 0 })).toThrow(/outside/);
    expect(() => cutComponent(fields, volume, 2, { axis: 'z', index: 2 }, 'ex')).toThrow(/no field volume/);
    expect(nearestCutIndex(fields, volume, 'x', 100)).toBe(xMm.length - 2);
  });

  it('|E| is the root sum of the three components’ |phasor|²', () => {
    const cut = { axis: 'z' as const, index: 2 };
    const vector = cutVector(fields, volume, 0, cut, 'e');
    const mag = magnitude(vector);
    const n = 3;
    const expected = Math.hypot(...(['x', 'y', 'z'] as const).flatMap((a) => [vector[a].re[n], vector[a].im[n]]));
    expect(mag[n]).toBeCloseTo(expected, 5);
  });

  it('keeps as many frequencies as fit the memory budget', () => {
    const small = { nx: 66, ny: 66, nz: 48 };
    expect(volumeFrequencies(small, 4)).toBe(4);
    // 1.4 M nodes need 64.6 MiB per frequency: over the budget even for one.
    const large = { nx: 120, ny: 120, nz: 98 };
    expect(48 * large.nx * large.ny * large.nz).toBeGreaterThan(VOLUME_BUDGET_BYTES);
    expect(volumeFrequencies(large, 4)).toBe(0);
    const middle = { nx: 100, ny: 100, nz: 60 };
    expect(volumeFrequencies(middle, 4)).toBe(2);
  });
});
