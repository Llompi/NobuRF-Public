import { describe, expect, it } from 'vitest';
import { C0, DEFAULT_GRID, timestepSec } from '../src/engine/config';
import { CpuFdtd, pecBoxModel } from '../src/engine/fdtd_cpu';
import type { GridConfig } from '../src/engine/types';

/**
 * Fast regression guard for docs/validation.md: the kernel must reproduce the
 * exact discrete (Yee) eigenfrequency of a PEC cavity, not just land "near"
 * the analytic one. A sign or index slip in an update equation shifts this by
 * percent; numerical round-off alone stays at the ppm level.
 */
describe('validation: kernel is exactly the Yee scheme', () => {
  it('PEC cavity TM110 matches the discrete Yee eigenfrequency to < 20 ppm (eps_r 2.2)', () => {
    const nx = 20, ny = 30, nz = 6, dxMm = 1, epsR = 2.2;
    const g: GridConfig = { ...DEFAULT_GRID, nx, ny, nz, dxMm, pmlCells: 0, groundK: 1 };
    const N = nx * ny * nz;
    const s = new CpuFdtd(pecBoxModel(g, epsR));
    const T = 8000;
    const rec = new Float64Array(T);
    const src = 5 + nx * (7 + ny * 3), prb = 13 + nx * (19 + ny * 2);
    for (let n = 0; n < T; n++) {
      s.updateH();
      s.updateE();
      if (n < 60) s.e[2 * N + src] += Math.exp(-(((n - 30) / 10) ** 2));
      rec[n] = s.e[2 * N + prb];
    }
    const dt = timestepSec(g), dx = dxMm * 1e-3;
    const sx = Math.sin(Math.PI * dx / (2 * nx * dx)) / dx, sy = Math.sin(Math.PI * dx / (2 * ny * dx)) / dx;
    const fYee = Math.asin((C0 * dt * Math.hypot(sx, sy)) / Math.sqrt(epsR)) / (Math.PI * dt);
    // Hann-windowed DFT peak, golden-section refined.
    const mag = (f: number) => {
      let re = 0, im = 0;
      for (let n = 0; n < T; n++) {
        const w = (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (T - 1))) * rec[n];
        re += w * Math.cos(2 * Math.PI * f * n * dt);
        im += w * Math.sin(2 * Math.PI * f * n * dt);
      }
      return Math.hypot(re, im);
    };
    let a = fYee * 0.99, b = fYee * 1.01;
    const gr = (Math.sqrt(5) - 1) / 2;
    for (let it = 0; it < 50; it++) {
      const c = b - gr * (b - a), d = a + gr * (b - a);
      if (mag(c) > mag(d)) b = d; else a = c;
    }
    const f = (a + b) / 2;
    expect(Math.abs(f - fYee) / fYee).toBeLessThan(20e-6);
  });
});
