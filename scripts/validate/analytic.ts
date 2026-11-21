/**
 * Canonical analytic checks of the NobuRF update kernel (the CPU reference,
 * which the GPU kernels match to ~1e-6 on the full grid; see selftest).
 *
 *   1. PEC cavity resonances vs the analytic formula and vs the exact Yee
 *      (discrete) eigenfrequency, under grid refinement, vacuum and eps_r 4.4.
 *   2. TEM plane wave on a 1D line: numerical phase velocity vs c and vs the
 *      Yee dispersion relation.
 *   3. PEC short: |Gamma| = 1 and phase = pi + 2 k d.
 *   4. CPML (absorbing boundary) reflection vs frequency and thickness.
 *
 *   npx tsx scripts/validate/analytic.ts            -> docs/validation/data/analytic.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { C0, DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { CpuFdtd, pecBoxModel } from '../../src/engine/fdtd_cpu';
import type { GridConfig } from '../../src/engine/types';
import { dft, pmlReflectionDb, reflection, temLine } from './tem_line';

const OUT = new URL('../../docs/validation/data/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const SC = DEFAULT_GRID.courant;

/* ---------------------------------------------------------------- helpers */

/** |DFT| of a record at frequency f (Hann window). */
function dftMag(rec: Float64Array, dt: number, f: number, win: Float64Array): number {
  let re = 0, im = 0;
  const w = 2 * Math.PI * f * dt;
  for (let n = 0; n < rec.length; n++) {
    const v = rec[n] * win[n];
    re += v * Math.cos(w * n);
    im += v * Math.sin(w * n);
  }
  return Math.hypot(re, im);
}

/** Peak frequency near `guess`: coarse scan then golden-section refinement. */
function peakNear(rec: Float64Array, dt: number, guess: number, span: number): number {
  const win = new Float64Array(rec.length);
  for (let n = 0; n < rec.length; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (rec.length - 1));
  let best = guess, bestV = -1;
  const nScan = 400;
  for (let s = 0; s <= nScan; s++) {
    const f = guess - span + (2 * span * s) / nScan;
    const v = dftMag(rec, dt, f, win);
    if (v > bestV) { bestV = v; best = f; }
  }
  let a = best - (2 * span) / nScan, b = best + (2 * span) / nScan;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 60; it++) {
    const c = b - g * (b - a), d = a + g * (b - a);
    if (dftMag(rec, dt, c, win) > dftMag(rec, dt, d, win)) b = d; else a = c;
  }
  return (a + b) / 2;
}

/* --------------------------------------------------------- 1. PEC cavity */

interface CavityMode { name: string; m: number; n: number; p: number }
const MODES: CavityMode[] = [
  { name: 'TM110', m: 1, n: 1, p: 0 },
  { name: 'TE101', m: 1, n: 0, p: 1 },
  { name: 'TE011', m: 0, n: 1, p: 1 },
  { name: 'TM120', m: 1, n: 2, p: 0 },
];

function cavity(A: number, B: number, D: number, dxMm: number, epsR: number, steps: number) {
  const nx = Math.round(A / dxMm), ny = Math.round(B / dxMm), nz = Math.round(D / dxMm);
  const g: GridConfig = { ...DEFAULT_GRID, nx, ny, nz, dxMm, pmlCells: 0, groundK: 1 };
  const N = nx * ny * nz;
  const s = new CpuFdtd(pecBoxModel(g, epsR));
  // Off-symmetry source and probes so every mode in MODES is excited and seen.
  const at = (fx: number, fy: number, fz: number) =>
    Math.floor(fx * nx) + nx * (Math.floor(fy * ny) + ny * Math.floor(fz * nz));
  const src = at(0.23, 0.31, 0.37);
  const prb = [at(0.71, 0.63, 0.29), at(0.41, 0.77, 0.66)];
  const rec = prb.map(() => new Float64Array(steps));
  const dt = timestepSec(g);
  const w = 6;
  for (let n = 0; n < steps; n++) {
    s.updateH();
    s.updateE();
    if (n < 8 * w) {
      const u = (n - 4 * w) / w;
      const a = Math.exp(-u * u);
      s.e[src] += a; s.e[N + src] += 0.7 * a; s.e[2 * N + src] += 0.5 * a;
    }
    for (let q = 0; q < prb.length; q++) {
      const c = prb[q];
      rec[q][n] = s.e[c] + s.e[N + c] + s.e[2 * N + c] + s.h[c] + s.h[N + c] + s.h[2 * N + c];
    }
  }
  const out = MODES.map((md) => {
    const a = A * 1e-3, b = B * 1e-3, d = D * 1e-3;
    const fA = (C0 / (2 * Math.sqrt(epsR))) * Math.hypot(md.m / a, md.n / b, md.p / d);
    // Exact discrete (Yee) eigenfrequency for the same mode on this grid:
    //   sin(w dt/2) / (c dt) = sqrt( sum (sin(k_i dx/2) / dx)^2 ) / sqrt(eps)  [Taflove eq. 4.47]
    const dx = dxMm * 1e-3;
    const sx = Math.sin((md.m * Math.PI * dx) / (2 * a)) / dx;
    const sy = Math.sin((md.n * Math.PI * dx) / (2 * b)) / dx;
    const sz = Math.sin((md.p * Math.PI * dx) / (2 * d)) / dx;
    const rhs = (C0 * dt * Math.sqrt(sx * sx + sy * sy + sz * sz)) / Math.sqrt(epsR);
    const fYee = (2 * Math.asin(rhs)) / (2 * Math.PI * dt);
    // Measure from the probe that sees this mode best.
    let fMeas = 0, bestAmp = -1;
    for (const r of rec) {
      const f = peakNear(r, dt, fYee, Math.max(0.01 * fA, 40e6));
      const win = new Float64Array(r.length).fill(1);
      const amp = dftMag(r, dt, f, win);
      if (amp > bestAmp) { bestAmp = amp; fMeas = f; }
    }
    return {
      mode: md.name, f_analytic_ghz: fA / 1e9, f_yee_ghz: fYee / 1e9, f_fdtd_ghz: fMeas / 1e9,
      err_vs_analytic: (fMeas - fA) / fA, err_vs_yee: (fMeas - fYee) / fYee,
    };
  });
  return { dx_mm: dxMm, eps_r: epsR, cells: N, steps, cells_per_lambda: (C0 / Math.sqrt(epsR) / (out[3].f_analytic_ghz * 1e9)) / (dxMm * 1e-3), modes: out };
}

/* ----------------------------------------------- 2-4. TEM line experiments */

function tem() {
  // Pulse reaches probe 1200 at ~2400 steps; the wall echo is back by ~3100;
  // the echo's second bounce off x = 0 would need ~6900. 5000 sits in between.
  const steps = 5000;
  const probes = [1000, 1200];
  const freqs: number[] = [];
  for (let f = 2e9; f <= 10e9 + 1; f += 0.25e9) freqs.push(f);

  // Reference: a line long enough that nothing comes back within the record.
  const ref = temLine(4000, { kind: 'none' }, probes, steps);
  const dx = 0.5e-3;
  const dt = ref.dt;
  const dispersion = freqs.map((f) => {
    const [ar, ai] = dft(ref.rec[0], dt, f), [br, bi] = dft(ref.rec[1], dt, f);
    let dphi = Math.atan2(ai, ar) - Math.atan2(bi, br);
    const dist = (probes[1] - probes[0]) * dx;
    const k0 = (2 * Math.PI * f) / C0;
    dphi += 2 * Math.PI * Math.round((k0 * dist - dphi) / (2 * Math.PI));
    const kNum = dphi / dist;
    // 1D Yee: sin(k dx/2)/dx = sin(w dt/2)/(c dt)
    const kYee = (2 / dx) * Math.asin((dx / (C0 * dt)) * Math.sin(Math.PI * f * dt));
    return {
      f_ghz: f / 1e9, cells_per_lambda: C0 / f / dx,
      vp_over_c: k0 / kNum, vp_over_c_yee: k0 / kYee,
    };
  });

  // PEC short at x = wallI: Gamma at probe 1200 must be 1 at angle pi - 2 k d.
  const wallI = 1400;
  const pec = temLine(4000, { kind: 'pec', wallI }, probes, steps);
  const gP = reflection(pec.rec[1], ref.rec[1], dt, freqs);
  const d = (wallI - probes[1]) * dx;
  const pecOut = freqs.map((f, q) => {
    const kYee = (2 / dx) * Math.asin((dx / (C0 * dt)) * Math.sin(Math.PI * f * dt));
    const ph = Math.atan2(gP[q][1], gP[q][0]);
    let expect = Math.PI - 2 * kYee * d;
    expect = Math.atan2(Math.sin(expect), Math.cos(expect));
    let err = ph - expect;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    return { f_ghz: f / 1e9, mag: Math.hypot(gP[q][0], gP[q][1]), phase_err_deg: (err * 180) / Math.PI };
  });

  const pml = [4, 6, 8, 10, 16].map((cells) => {
    const db = pmlReflectionDb(cells, freqs);
    return { cells, thickness_mm: cells * 0.5, db: freqs.map((f, q) => ({ f_ghz: f / 1e9, gamma_db: db[q] })) };
  });

  return { dispersion, pec: pecOut, pml, courant: SC };
}

/* ------------------------------------------------------------------- main */

const t0 = performance.now();
const cav = {
  box_mm: [20, 30, 10],
  runs: [
    cavity(20, 30, 10, 1.0, 1, 8000),
    cavity(20, 30, 10, 0.5, 1, 16000),
    cavity(20, 30, 10, 0.25, 1, 32000),
    cavity(20, 30, 10, 0.5, 4.4, 24000),
  ],
};
console.log('cavity done', ((performance.now() - t0) / 1000).toFixed(0), 's');
for (const r of cav.runs) {
  for (const m of r.modes) {
    console.log(`  dx ${r.dx_mm} eps ${r.eps_r} ${m.mode}: analytic ${m.f_analytic_ghz.toFixed(4)} yee ${m.f_yee_ghz.toFixed(4)} fdtd ${m.f_fdtd_ghz.toFixed(4)}  err ${(m.err_vs_analytic * 100).toFixed(3)} %  vsYee ${(m.err_vs_yee * 1e6).toFixed(1)} ppm`);
  }
}
const line = tem();
console.log('tem done', ((performance.now() - t0) / 1000).toFixed(0), 's');
const at = (arr: { f_ghz: number }[], f: number) => arr.find((x) => Math.abs(x.f_ghz - f) < 1e-6);
console.log('  vp/c @5.75', at(line.dispersion, 5.75));
console.log('  pec  @5.75', at(line.pec, 5.75));
for (const p of line.pml) {
  const band = p.db.filter((x) => x.f_ghz >= 4.5 && x.f_ghz <= 7.5);
  console.log(`  CPML ${p.cells} cells: worst ${Math.max(...band.map((x) => x.gamma_db)).toFixed(1)} dB in 4.5-7.5 GHz`);
}
writeFileSync(new URL('analytic.json', OUT), JSON.stringify({ cavity: cav, line }, null, 1));
