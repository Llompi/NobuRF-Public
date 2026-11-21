import type { ExcitationConfig, PortSamples } from './types';

export interface PortSpectrum {
  fGHz: Float64Array;
  zRe: Float64Array;
  zIm: Float64Array;
  s11Db: Float64Array;
  /** Fraction of peak |V| still present in the last 5 % of the record (ring-down check). */
  residual: number;
}

/** Frequency response at a port, without the V/I ring-down check: what a de-embedded connector feed (coax_feed.ts) also gives. */
export type Spectrum = Omit<PortSpectrum, 'residual'>;

export const S11_FLOOR_DB = -60;

/**
 * Discrete-time Fourier transform of V(t) and I(t) at arbitrary frequencies,
 * then Z_in = V/I and S11 = (Z - Z0)/(Z + Z0).
 *
 * Time stamps differ on purpose: V is sampled after the E update of step n
 * (t = (n+1) dt) and I from H, which lives on the half step (t = (n+1/2) dt).
 * Using the true sample times removes the half-step phase error that would
 * otherwise show up as a spurious reactance growing with frequency.
 *
 * A Tukey taper over the last 20 % of the record limits the ripple from
 * truncating a not-quite-finished ring-down. The taper is applied to V and I
 * alike so their ratio is not biased.
 */
export function portSpectrum(s: Pick<PortSamples, 'v' | 'i' | 'dtSec'>, exc: ExcitationConfig): PortSpectrum {
  const n = s.v.length;
  const nf = bandPoints(exc);
  const fGHz = new Float64Array(nf);
  const zRe = new Float64Array(nf);
  const zIm = new Float64Array(nf);
  const s11Db = new Float64Array(nf);

  const w = tukeyTaper(n);

  for (let m = 0; m < nf; m++) {
    const f = bandFrequencyHz(exc, m);
    fGHz[m] = f / 1e9;
    const { v: [vr, vi], i: [ir, ii] } = weightedPortDft(s, w, f);
    // Z = V / I (complex division)
    const den = ir * ir + ii * ii;
    let zr: number, zi: number;
    if (den < 1e-300) {
      zr = Infinity; zi = 0;
    } else {
      zr = (vr * ir + vi * ii) / den;
      zi = (vi * ir - vr * ii) / den;
    }
    zRe[m] = zr;
    zIm[m] = zi;
    s11Db[m] = s11FromZ(zr, zi, exc.z0);
  }

  let peak = 0;
  for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(s.v[k]));
  let tail = 0;
  for (let k = Math.floor(n * 0.95); k < n; k++) tail = Math.max(tail, Math.abs(s.v[k]));
  return { fGHz, zRe, zIm, s11Db, residual: peak > 0 ? tail / peak : 0 };
}

export const bandPoints = (exc: ExcitationConfig) => Math.max(2, exc.nFreq);

/** Frequency m of the analysis band, in Hz. */
export function bandFrequencyHz(exc: ExcitationConfig, m: number): number {
  return (exc.fMinGHz + ((exc.fMaxGHz - exc.fMinGHz) * m) / (bandPoints(exc) - 1)) * 1e9;
}

/** Weight 1, then a raised-cosine fall over the last 20 % of an n-sample record. */
export function tukeyTaper(n: number): Float64Array {
  const taperStart = Math.floor(n * 0.8);
  const w = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    w[k] = k < taperStart ? 1 : 0.5 * (1 + Math.cos((Math.PI * (k - taperStart)) / Math.max(1, n - 1 - taperStart)));
  }
  return w;
}

/** One solver run for the S-matrix: the port that carried the source and every port's V and I. */
export interface ExcitedRun {
  activePort: number;
  samples: Pick<PortSamples, 'ports' | 'dtSec'>;
}

export interface ScatteringResult {
  fGHz: Float64Array;
  /**
   * re[i][j][m], im[i][j][m]: S_ij at frequency m. Column j is null when port
   * j was not excited.
   */
  re: Array<Array<Float64Array | null>>;
  im: Array<Array<Float64Array | null>>;
  /**
   * "full": every port excited, S = B A^-1 over all runs (exact for the
   * measured waves). "matched_loads": some port not excited, S_ij = b_i / a_j,
   * which assumes a = 0 at every unexcited port.
   */
  method: 'full' | 'matched_loads';
  /** Largest |a| at an unexcited port over |a| at the excited one, over all runs and frequencies: what "matched_loads" neglects. */
  maxPassiveIncidentRatio: number;
}

export type Complex = [re: number, im: number];

/**
 * The scattering matrix over the analysis band from one run per excited
 * port. Power waves of port i, reference impedance z0[i], I into the network:
 *   a = (V + Z0 I) / (2 sqrt Z0),   b = (V - Z0 I) / (2 sqrt Z0).
 * Run j gives column j of the incident matrix A and the outgoing matrix B,
 * and B = S A. An unexcited port is a resistor of Z0 in parallel with its own
 * cell's capacitance (the H loop around the column sees the displacement
 * current too), so its a is small but not zero, a few % at 1 mm cells and
 * 10 GHz. With every port excited, S = B A^-1 removes that error; otherwise
 * S_ij = b_i / a_j. V and I are transformed as in portSpectrum (true sample
 * times, same taper).
 */
export function scatteringMatrix(runs: ExcitedRun[], z0: number[], exc: ExcitationConfig): ScatteringResult {
  for (const r of runs) {
    if (r.samples.ports.length !== z0.length) throw new Error(`run has ${r.samples.ports.length} ports but ${z0.length} reference impedances were given`);
  }
  const tapers = runs.map((r) => tukeyTaper(r.samples.ports[r.activePort].v.length));
  return scatteringFromWaves(runs.map((r) => r.activePort), z0.length, exc, (n, i, f) => {
    const r = runs[n];
    return lumpedPortWaves({ ...r.samples.ports[i], dtSec: r.samples.dtSec }, tapers[n], f, z0[i]);
  });
}

/** Power waves a (incident) and b (outgoing) of a lumped port, I into the network: a = (V + Z0 I) / (2 sqrt Z0), b = (V - Z0 I) / (2 sqrt Z0). */
export function lumpedPortWaves(s: Pick<PortSamples, 'v' | 'i' | 'dtSec'>, taper: ArrayLike<number>, frequencyHz: number, z0: number): { a: Complex; b: Complex } {
  const { v, i: current } = weightedPortDft(s, taper, frequencyHz);
  const scale = 1 / (2 * Math.sqrt(z0));
  return {
    a: [(v[0] + z0 * current[0]) * scale, (v[1] + z0 * current[1]) * scale],
    b: [(v[0] - z0 * current[0]) * scale, (v[1] - z0 * current[1]) * scale],
  };
}

/**
 * S over the band from the power waves of every port in every run, as in
 * scatteringMatrix. `waves(n, i, fHz)` gives port i's a and b in run n, where
 * run n excited port excited[n]; any port type works as long as its waves
 * share one reference time.
 */
export function scatteringFromWaves(
  excited: number[], portCount: number, exc: ExcitationConfig, waves: (run: number, port: number, frequencyHz: number) => { a: Complex; b: Complex },
): ScatteringResult {
  if (new Set(excited).size !== excited.length) throw new Error(`a port is excited twice (${excited.join(', ')})`);
  const full = excited.length === portCount;
  const nf = bandPoints(exc);
  const fGHz = new Float64Array(nf);
  const column = (j: number) => (excited.includes(j) ? new Float64Array(nf) : null);
  const re = Array.from({ length: portCount }, () => Array.from({ length: portCount }, (_, j) => column(j)));
  const im = Array.from({ length: portCount }, () => Array.from({ length: portCount }, (_, j) => column(j)));
  let maxPassiveIncidentRatio = 0;
  for (let m = 0; m < nf; m++) {
    const f = bandFrequencyHz(exc, m);
    fGHz[m] = f / 1e9;
    // a[n][i], b[n][i]: port i in run n.
    const a: Complex[][] = [];
    const b: Complex[][] = [];
    excited.forEach((activePort, n) => {
      const w = Array.from({ length: portCount }, (_, i) => waves(n, i, f));
      a.push(w.map((x) => x.a));
      b.push(w.map((x) => x.b));
      const incident = Math.hypot(...a[n][activePort]);
      if (!(incident > 0)) throw new Error(`port ${activePort} has no incident wave at ${f / 1e9} GHz in its own run`);
      for (let i = 0; i < portCount; i++) {
        if (i !== activePort) maxPassiveIncidentRatio = Math.max(maxPassiveIncidentRatio, Math.hypot(...a[n][i]) / incident);
      }
    });
    // B = S A, where column j of A and B is the run exciting port j. Transposed,
    // A^T S^T = B^T, and row j of A^T is that run's a: so sT[j][i] = S_ij.
    const runOfPort = Array.from({ length: portCount }, (_, j) => excited.indexOf(j));
    const sT = full ? solveComplex(runOfPort.map((n) => a[n]), runOfPort.map((n) => b[n])) : null;
    excited.forEach((j, n) => {
      for (let i = 0; i < portCount; i++) {
        const sij = sT ? sT[j][i] : divide(b[n][i], a[n][j]);
        re[i][j]![m] = sij[0];
        im[i][j]![m] = sij[1];
      }
    });
  }
  return { fGHz, re, im, method: full ? 'full' : 'matched_loads', maxPassiveIncidentRatio };
}

/**
 * S referred to new real reference impedances: from power waves on `from[i]`
 * to power waves on `to[i]`, through the impedance matrix
 *   Z = (I - S~)^-1 (I + S~) R,  S~ = R^1/2 S R^-1/2,
 * then S'~ = (Z - R')(Z + R')^-1 and S' = R'^-1/2 S'~ R'^1/2. Needs every column.
 */
export function renormaliseScattering(s: ScatteringResult, from: number[], to: number[]): ScatteringResult {
  const n = from.length;
  if (s.re.some((row) => row.some((column) => column === null))) throw new Error('renormalising S needs every port excited');
  const re = s.re.map((row) => row.map(() => new Float64Array(s.fGHz.length)));
  const im = s.re.map((row) => row.map(() => new Float64Array(s.fGHz.length)));
  const identity = (i: number, j: number): Complex => [i === j ? 1 : 0, 0];
  for (let m = 0; m < s.fGHz.length; m++) {
    const sTilde = (i: number, j: number): Complex => {
      const k = Math.sqrt(from[i] / from[j]);
      return [s.re[i][j]![m] * k, s.im[i][j]![m] * k];
    };
    const minus = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => subtract(identity(i, j), sTilde(i, j))));
    const plus = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): Complex => [identity(i, j)[0] + sTilde(i, j)[0], sTilde(i, j)[1]]));
    // Z = (I - S~)^-1 (I + S~) R: column j of (I + S~) scaled by R_j.
    const z = solveComplex(minus, plus.map((row) => row.map(([x, y], j): Complex => [x * from[j], y * from[j]])));
    // S'~ (Z + R') = Z - R'  =>  (Z + R')^T S'~^T = (Z - R')^T.
    const transpose = (f: (i: number, j: number) => Complex) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => f(j, i)));
    const sNewT = solveComplex(transpose((i, j) => [z[i][j][0] + (i === j ? to[i] : 0), z[i][j][1]]), transpose((i, j) => [z[i][j][0] - (i === j ? to[i] : 0), z[i][j][1]]));
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const k = Math.sqrt(to[j] / to[i]);
      re[i][j][m] = sNewT[j][i][0] * k;
      im[i][j][m] = sNewT[j][i][1] * k;
    }
  }
  return { ...s, re, im };
}

const subtract = ([ar, ai]: Complex, [br, bi]: Complex): Complex => [ar - br, ai - bi];

export function divide([ar, ai]: Complex, [br, bi]: Complex): Complex {
  const den = br * br + bi * bi;
  return [(ar * br + ai * bi) / den, (ai * br - ar * bi) / den];
}

export const multiply = ([ar, ai]: Complex, [br, bi]: Complex): Complex => [ar * br - ai * bi, ar * bi + ai * br];

/** X with M X = R for a square complex M (Gauss-Jordan, partial pivoting). R has one or more columns. */
export function solveComplex(m: Complex[][], r: Complex[][]): Complex[][] {
  const n = m.length;
  const rows = m.map((row, k) => [...row.map((x): Complex => [...x]), ...r[k].map((x): Complex => [...x])]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let k = col + 1; k < n; k++) if (Math.hypot(...rows[k][col]) > Math.hypot(...rows[pivot][col])) pivot = k;
    if (!(Math.hypot(...rows[pivot][col]) > 0)) throw new Error('incident waves of the runs are linearly dependent; cannot form S = B A^-1');
    [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
    const inverse = divide([1, 0], rows[col][col]);
    rows[col] = rows[col].map((x) => multiply(x, inverse));
    for (let k = 0; k < n; k++) {
      if (k === col) continue;
      const factor = rows[k][col];
      rows[k] = rows[k].map((x, c) => {
        const p = multiply(factor, rows[col][c]);
        return [x[0] - p[0], x[1] - p[1]];
      });
    }
  }
  return rows.map((row) => row.slice(n));
}

export interface PortPhasors {
  v: [re: number, im: number];
  i: [re: number, im: number];
}

/** DFT of V and I at one frequency, each at its true sample time, every sample weighted by `w`. */
function weightedPortDft(s: Pick<PortSamples, 'v' | 'i' | 'dtSec'>, w: ArrayLike<number>, frequencyHz: number): PortPhasors {
  const wdt = 2 * Math.PI * frequencyHz * s.dtSec;
  let vr = 0, vi = 0, ir = 0, ii = 0;
  for (let k = 0; k < s.v.length; k++) {
    const pv = wdt * (k + 1);
    const pi = wdt * (k + 0.5);
    const vk = s.v[k] * w[k];
    const ik = s.i[k] * w[k];
    vr += vk * Math.cos(pv);
    vi -= vk * Math.sin(pv);
    ir += ik * Math.cos(pi);
    ii -= ik * Math.sin(pi);
  }
  return { v: [vr, vi], i: [ir, ii] };
}

/**
 * Untapered V and I phasors at one frequency: the transform the far-field
 * box uses (huygens_box.ts), so port power and box flux share one window.
 */
export function portPhasors(s: Pick<PortSamples, 'v' | 'i' | 'dtSec'>, frequencyHz: number): PortPhasors {
  return weightedPortDft(s, new Float64Array(s.v.length).fill(1), frequencyHz);
}

export function s11FromZ(zr: number, zi: number, z0: number): number {
  if (!Number.isFinite(zr)) return 0; // open circuit: total reflection
  const nr = zr - z0, ni = zi;
  const dr = zr + z0, di = zi;
  const mag2 = (nr * nr + ni * ni) / (dr * dr + di * di);
  const db = 10 * Math.log10(mag2);
  return Number.isFinite(db) ? Math.max(S11_FLOOR_DB, db) : S11_FLOOR_DB;
}

/** Linear interpolation of a sampled curve at x. */
export function interp(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}
