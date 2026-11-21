import { describe, expect, it } from 'vitest';
import { C0, DEFAULT_GRID, ENERGY_STOP_RUN, timestepSec } from '../src/engine/config';
import { DEFAULT_CPML_GRADING } from '../src/engine/cpml';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { baselineGeometry } from '../src/engine/geometry';
import type { GridConfig, MicroGeometryDSL } from '../src/engine/types';
import { lossTangentSigmaDtOverEps0, voxelize } from '../src/engine/voxelize';
import { dft, pmlReflectionDb, temLine } from '../scripts/validate/tem_line';

// Box-sized CPU runs take 5-10 s each. Skip with SKIP_SLOW=1.
const slow = process.env.SKIP_SLOW ? it.skip : it;

const bandGHz = (lo: number, hi: number, step: number) => {
  const f: number[] = [];
  for (let x = lo; x <= hi + 1e-9; x += step) f.push(x * 1e9);
  return f;
};

describe('CPML absorbing boundary', () => {
  // The spec's exit test: below -40 dB across the patch band with 8 to 10 cells.
  // The old 8-cell sponge measured -21 dB on this same harness.
  it('reflects below -40 dB across 4.5-7.5 GHz at normal incidence with 8 cells', () => {
    const worst = Math.max(...pmlReflectionDb(8, bandGHz(4.5, 7.5, 0.25)));
    expect(worst).toBeLessThan(-40);
  });

  it('gets better with thickness (a sign or index slip would not)', () => {
    const f = bandGHz(4.5, 7.5, 0.5);
    const thin = Math.max(...pmlReflectionDb(4, f));
    const thick = Math.max(...pmlReflectionDb(10, f));
    expect(thick).toBeLessThan(thin - 10);
  });

  // kappa > 1 scales each difference by its own axis; a swapped axis reflects at -5 dB.
  it('stays below -40 dB with coordinate stretching (kappaMax 5)', () => {
    const grading = { ...DEFAULT_CPML_GRADING, kappaMax: 5 };
    expect(Math.max(...pmlReflectionDb(10, bandGHz(4.5, 7.5, 0.5), grading))).toBeLessThan(-40);
  });

  slow('absorbs a dipole next to a board, from every direction, corners included', () => {
    const m = voxelize(smallPatch(), SMALL_GRID);
    const s = new CpuFdtd(m);
    const N = s.N;
    const c = 24 + 48 * (24 + 48 * 20); // above the patch
    let peak = 0;
    for (let n = 0; n < 1500; n++) {
      s.updateH();
      s.updateE();
      const u = (n - 40) / 12;
      s.e[2 * N + c] += -u * Math.exp(-u * u);
      if (n % 50 === 0) peak = Math.max(peak, s.energy());
    }
    expect(s.energy()).toBeLessThan(peak * 1e-4);
  });
});

describe('dielectric loss', () => {
  it('a plane wave in lossy FR-4 decays at the analytic rate (exact complex k, within 1 %)', () => {
    const epsR = 4.4, tanDelta = 0.02, fRef = 6e9;
    const dt = timestepSec({ ...DEFAULT_GRID, dxMm: 0.5 });
    const sigma = lossTangentSigmaDtOverEps0(epsR, tanDelta, fRef, dt);
    const probes = [400, 600];
    // Long enough for the pulse and its echo off the x = 0 wall to pass both probes.
    const steps = 4000;
    const line = temLine(4000, { kind: 'none' }, probes, steps, { epsR, sigmaDtOverEps0: sigma });
    const d = (probes[1] - probes[0]) * 0.5e-3;
    for (const f of [5e9, 6e9, 7e9]) {
      const [ar, ai] = dft(line.rec[0], dt, f);
      const [br, bi] = dft(line.rec[1], dt, f);
      const measured = Math.log(Math.hypot(ar, ai) / Math.hypot(br, bi)) / d; // Np/m
      // k = (w/c) sqrt(eps_r - j sigma/(w eps0)), with sigma/(w eps0) = eps_r tanDelta fRef/f.
      const w = 2 * Math.PI * f;
      const re = epsR, im = -epsR * tanDelta * (fRef / f);
      const mod = Math.hypot(re, im);
      const sqrtIm = -Math.sqrt((mod - re) / 2); // imaginary part of the principal sqrt
      const alpha = -(w / C0) * sqrtIm;
      expect(Math.abs(measured - alpha) / alpha).toBeLessThan(0.01);
    }
  });
});

describe('energy stop', () => {
  it('rejects a run control that cannot work', () => {
    const m = voxelize(smallPatch(), SMALL_GRID);
    const bad = { maxSteps: 100, stopAtEnergyDecayDb: 50, energyCheckEverySteps: 0 };
    expect(() => new CpuFdtd(m).run(DEFAULT_EXCITATION_SMALL, bad)).toThrow(/energyCheckEverySteps/);
  });

  slow('ends on a check boundary once the energy is 50 dB down, and matches a fixed run of that length', () => {
    const m = voxelize(smallPatch(), SMALL_GRID);
    const stopped = new CpuFdtd(m).run(DEFAULT_EXCITATION_SMALL, ENERGY_STOP_RUN);
    expect(stopped.stoppedOnEnergy).toBe(true);
    expect(stopped.energyDecayDb).toBeGreaterThanOrEqual(50);
    expect(stopped.v.length % ENERGY_STOP_RUN.energyCheckEverySteps).toBe(0);
    const fixed = new CpuFdtd(m).run(DEFAULT_EXCITATION_SMALL, {
      maxSteps: stopped.v.length, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100,
    });
    expect(fixed.stoppedOnEnergy).toBe(false);
    expect(Array.from(fixed.v)).toEqual(Array.from(stopped.v));
  });
});

const DEFAULT_EXCITATION_SMALL = { fMinGHz: 4.5, fMaxGHz: 7.5, nFreq: 31, z0: 50 };
const SMALL_GRID: GridConfig = { ...DEFAULT_GRID, nx: 48, ny: 48, nz: 32, groundK: 10 };

/** A patch small enough for a 48 x 48 cell box with an 8-cell PML. */
function smallPatch(): MicroGeometryDSL {
  const g = baselineGeometry();
  return {
    ...g,
    ground: { w_mm: 14, l_mm: 14 },
    patch: { w_mm: 8, l_mm: 6 },
    feed: { ...g.feed, len_mm: 1.5, w_mm: 1.5, inset_depth_mm: 0 },
    substrate: { ...g.substrate, tan_delta: 0.02 },
  };
}
