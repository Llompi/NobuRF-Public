import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID, assertStableGrid, timestepSec } from '../src/engine/config';
import { CpuFdtd, pecBoxModel, vacuumModel } from '../src/engine/fdtd_cpu';
import { buildCpml } from '../src/engine/cpml';
import type { GridConfig } from '../src/engine/types';
import { dielectricEdge, idx3 } from '../src/engine/voxelize';

const small = (over: Partial<GridConfig> = {}): GridConfig => ({
  ...DEFAULT_GRID, nx: 32, ny: 32, nz: 32, pmlCells: 8, groundK: 10, ...over,
});

describe('CPU reference FDTD', () => {
  // 1,000 steps, Gaussian pulse in empty space, no NaN/Inf, the CPML absorbs it.
  it('is stable for 1,000 steps and the CPML absorbs the pulse', () => {
    const g = small();
    const s = new CpuFdtd(vacuumModel(g));
    const N = s.N;
    const c = 16 + 32 * (16 + 32 * 16);
    const dt = timestepSec(g);
    let peak = 0;
    for (let n = 0; n < 1000; n++) {
      s.updateH();
      s.updateE();
      // Soft, zero-mean source (differentiated Gaussian): no static charge left behind.
      const u = (n - 40) / 12;
      s.e[2 * N + c] += -u * Math.exp(-u * u);
      if (n % 50 === 0) peak = Math.max(peak, s.energy());
    }
    const end = s.energy();
    for (const v of s.e) expect(Number.isFinite(v)).toBe(true);
    for (const v of s.h) expect(Number.isFinite(v)).toBe(true);
    expect(dt).toBeGreaterThan(0);
    // A 32^3 box has 16^3 cells of free space: the pulse leaves within ~100 steps.
    expect(end).toBeLessThan(peak * 1e-6);
  });

  it('weighs energy by eps_r and by the volume an edge stands for, and skips metal', () => {
    const g = small({ nx: 6, ny: 6, nz: 6, pmlCells: 0 });
    const m = vacuumModel(g, { xLow: 0, xHigh: 0, yLow: 0, yHigh: 0, zLow: 0, zHigh: 0 });
    // A graded x axis: cells of 1, 2, 2, 2, 1 (in units of dxMm), so node 1's dual cell is 1.5 wide.
    const d = g.dxMm;
    m.mesh = { ...m.mesh, x: Float64Array.from([0, 1, 3, 5, 7, 8], (v) => v * d) };
    m.cpml = buildCpml(g, m.cpml.faces, undefined, m.mesh);
    const s = new CpuFdtd(m);
    const N = s.N;
    const c = idx3(g, 1, 3, 3);
    const one = (field: Float32Array, at: number) => { s.reset(); field[at] = 1; return s.energy(); };
    expect(one(s.e, c)).toBeCloseTo(2, 6); // Ex: cell width 2 along x
    expect(one(s.e, N + c)).toBeCloseTo(1.5, 6); // Ey: dual width 1.5 across x
    expect(one(s.h, c)).toBeCloseTo(1.5, 6); // Hx: dual width 1.5 along x
    const { decay, curl } = dielectricEdge(g.courant, 4, 0.3);
    [m.eDecay[c], m.eCurl[c]] = [decay, curl];
    expect(one(s.e, c)).toBeCloseTo(8, 5);
    m.eCurl[c] = 0;
    expect(one(s.e, c)).toBe(0);
  });

  // Plan test 2: PEC sheet across z = nz/2 attenuates the field behind it by > 40 dB.
  it('PEC sheet blocks > 40 dB', () => {
    const g = small();
    const m = vacuumModel(g);
    const N = g.nx * g.ny * g.nz;
    const kz = g.nz / 2;
    for (let j = 0; j < g.ny; j++) {
      for (let i = 0; i < g.nx; i++) {
        const c = i + g.nx * (j + g.ny * kz);
        m.eCurl[c] = 0; // Ex tangential
        m.eCurl[N + c] = 0; // Ey tangential
      }
    }
    const s = new CpuFdtd(m);
    const src = 16 + 32 * (16 + 32 * 10);
    let front = 0;
    let back = 0;
    for (let n = 0; n < 400; n++) {
      s.updateH();
      s.updateE();
      const u = (n - 40) / 12;
      s.e[2 * N + src] += -u * Math.exp(-u * u);
      for (let k = 0; k < g.nz; k++) {
        const c = 16 + 32 * (16 + 32 * k);
        const a = Math.abs(s.e[c]) + Math.abs(s.e[N + c]) + Math.abs(s.e[2 * N + c]);
        if (k < kz - 1) front = Math.max(front, a);
        if (k > kz + 1) back = Math.max(back, a);
      }
    }
    const atten = 20 * Math.log10(front / Math.max(back, 1e-30));
    expect(front).toBeGreaterThan(0);
    expect(atten).toBeGreaterThan(40);
  });

  it('closed vacuum cavity rings at the analytic TM110 frequency', () => {
    const nx = 20, ny = 30, nz = 10;
    const g = small({ nx, ny, nz, dxMm: 1, pmlCells: 0, groundK: 2 });
    const N = nx * ny * nz;
    const s = new CpuFdtd(pecBoxModel(g, 1));
    const src = 5 + nx * (7 + ny * 4);
    const prb = 13 + nx * (19 + ny * 6);
    const T = 6000;
    const rec = new Float64Array(T);
    const dt = timestepSec(g);
    for (let n = 0; n < T; n++) {
      s.updateH();
      s.updateE();
      if (n < 60) s.e[2 * N + src] += Math.exp(-(((n - 30) / 10) ** 2));
      rec[n] = s.e[2 * N + prb];
    }
    const theory = (299_792_458 / 2) * Math.sqrt(1 / 0.02 ** 2 + 1 / 0.03 ** 2);
    let best = 0, bestF = 0;
    for (let f = 7e9; f < 11e9; f += 5e6) {
      let re = 0, im = 0;
      for (let n = 0; n < T; n++) {
        re += rec[n] * Math.cos(2 * Math.PI * f * n * dt);
        im += rec[n] * Math.sin(2 * Math.PI * f * n * dt);
      }
      if (re * re + im * im > best) { best = re * re + im * im; bestF = f; }
    }
    expect(Math.abs(bestF - theory) / theory).toBeLessThan(0.005);
  });

  it('rejects unstable configurations', () => {
    expect(() => assertStableGrid(small({ courant: 0.6 }))).toThrow(/Courant/);
    expect(() => assertStableGrid(small({ pmlCells: 15 }))).toThrow(/too small/);
    expect(() => assertStableGrid(small())).not.toThrow();
  });
});
