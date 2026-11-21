import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCITATION, DEFAULT_GRID, ETA0, timestepSec } from '../src/engine/config';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { baselineGeometry } from '../src/engine/geometry';
import { sourceParams, sourceValue } from '../src/engine/source';
import type { GridConfig, MicroGeometryDSL } from '../src/engine/types';
import { idx3, portCoefficients, voxelize } from '../src/engine/voxelize';

const N = DEFAULT_GRID.nx * DEFAULT_GRID.ny * DEFAULT_GRID.nz;

describe('lumped port kinds', () => {
  it('line is the default: one column of series cells at the feed centre', () => {
    const m = voxelize(baselineGeometry(), DEFAULT_GRID);
    expect(m.ports[0]).toMatchObject({ i: DEFAULT_GRID.nx / 2, columns: 1, seriesCells: 3, cells: 3 });
    expect(voxelize(baselineGeometry(), DEFAULT_GRID, 50, 'line').ports[0]).toEqual(m.ports[0]);
  });

  it('strip puts a column on every node across the feed width, the line column in the centre', () => {
    const line = voxelize(baselineGeometry(), DEFAULT_GRID).ports[0];
    const strip = voxelize(baselineGeometry(), DEFAULT_GRID, 50, 'strip');
    const p = strip.ports[0];
    // 2.5 mm feed on 0.5 mm cells: nodes at x = -1, -0.5, 0, 0.5, 1 mm.
    expect(p).toMatchObject({ i: line.i, j: line.j, k0: line.k0, k1: line.k1, columns: 5, seriesCells: 3, cells: 15 });
    for (let column = 0; column < p.columns; column++) {
      for (let n = 0; n < p.seriesCells; n++) {
        const ez = p.ezIndex[column * p.seriesCells + n];
        expect(ez).toBe(2 * N + idx3(DEFAULT_GRID, p.i - 2 + column, p.j, p.k0 + n));
        expect(strip.eCurl[ez]).toBe(0);
        expect(strip.eDecay[ez]).toBe(1);
      }
    }
    expect(Array.from(p.ezIndex.subarray(2 * p.seriesCells, 3 * p.seriesCells))).toEqual(Array.from(line.ezIndex));
  });

  it('strip shares z0 between its columns: each cell holds z0 * columns / seriesCells', () => {
    const Sc = DEFAULT_GRID.courant;
    expect(portCoefficients(Sc, 4.4, 50, 3, 5)).toEqual(portCoefficients(Sc, 4.4, 250, 3));
    const strip = voxelize(baselineGeometry(), DEFAULT_GRID, 50, 'strip').ports[0];
    expect({ ca: strip.ca, cb: strip.cb, cs: strip.cs }).toEqual(portCoefficients(Sc, 4.4, 50, 3, 5));
    // The line port keeps its coefficients bit for bit.
    const line = voxelize(baselineGeometry(), DEFAULT_GRID).ports[0];
    expect({ ca: line.ca, cb: line.cb, cs: line.cs }).toEqual(portCoefficients(Sc, 4.4, 50, 3));
  });

  it('strip V is the centre column and I is the Ampere loop around the whole strip', () => {
    const grid: GridConfig = { ...DEFAULT_GRID, nx: 48, ny: 48, nz: 32, groundK: 10 };
    const m = voxelize(smallPatch(), grid, 50, 'strip');
    const p = m.ports[0];
    expect(p.columns).toBe(3); // 1.5 mm feed
    const s = new CpuFdtd(m);
    const n3 = s.N;
    const sp = sourceParams(DEFAULT_EXCITATION);
    const dt = timestepSec(grid);
    const kMid = p.k0 + (p.seriesCells >> 1);
    const iLow = p.i - (p.columns >> 1);
    const iHigh = p.i + (p.columns >> 1);
    let peakCurrent = 0;
    let worstLoopError = 0;
    for (let n = 0; n < 200; n++) {
      s.updateH();
      s.updateE();
      const [v, current] = s.updatePort(sourceValue(sp, (n + 0.5) * dt), 0)[0];
      let centre = 0;
      for (let k = p.k0; k < p.k1; k++) centre += s.e[2 * n3 + idx3(grid, p.i, p.j, k)];
      expect(v).toBe(-centre);
      // Loop at the middle cell around nodes iLow..iHigh: Hy on the two short sides, Hx along the long ones.
      const h = s.h;
      let loop = h[n3 + idx3(grid, iHigh, p.j, kMid)] - h[n3 + idx3(grid, iLow - 1, p.j, kMid)];
      for (let i = iLow; i <= iHigh; i++) loop -= h[idx3(grid, i, p.j, kMid)] - h[idx3(grid, i, p.j - 1, kMid)];
      worstLoopError = Math.max(worstLoopError, Math.abs(current - loop / ETA0));
      peakCurrent = Math.max(peakCurrent, Math.abs(current));
    }
    expect(peakCurrent).toBeGreaterThan(0);
    // Float32 rounding only: the per-column loops telescope to the outer loop.
    expect(worstLoopError).toBeLessThan(1e-5 * peakCurrent);
  });
});

/** A patch small enough for a 48 x 48 cell box with an 8-cell PML (as in cpml.test.ts). */
function smallPatch(): MicroGeometryDSL {
  const g = baselineGeometry();
  return {
    ...g,
    ground: { w_mm: 14, l_mm: 14 },
    patch: { w_mm: 8, l_mm: 6 },
    feed: { ...g.feed, len_mm: 1.5, w_mm: 1.5, inset_depth_mm: 0 },
  };
}
