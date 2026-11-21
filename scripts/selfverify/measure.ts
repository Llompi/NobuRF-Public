/**
 * Turning solver records into numbers, and numbers into verdicts. Nothing in
 * here knows the expected answer of a case.
 */
import { FORMAL_ORDER, GCI_SAFETY_THREE_LEVELS, MAX_OBSERVED_ORDER, MIN_OBSERVED_ORDER } from './tolerances';

export type Verdict = 'pass' | 'fail' | 'inconclusive';

/** One check of one case: what was compared, against what, with which allowance and where it comes from. */
export interface Check {
  family: string;
  case: string;
  check: string;
  verdict: Verdict;
  measured: number | null;
  expected: number | null;
  tolerance: number | null;
  /** Where the expected value and the tolerance come from, and anything a reader needs to judge the verdict. */
  note: string;
}

export function compare(fields: Omit<Check, 'verdict'>): Check {
  const { measured, expected, tolerance } = fields;
  // A blown-up solve (NaN, Infinity) is a failure, never "inconclusive".
  if (measured !== null && !Number.isFinite(measured)) return { ...fields, verdict: 'fail' };
  if (measured === null || expected === null || tolerance === null) return { ...fields, verdict: 'inconclusive' };
  return { ...fields, verdict: Math.abs(measured - expected) <= tolerance ? 'pass' : 'fail' };
}

/* ------------------------------------------------------------- spectra */

/** Complex DFT of rec at frequency f, sample n taken at (n + timeOffset) dt, weighted by `window` (or 1). */
export function dft(rec: ArrayLike<number>, dtSec: number, frequencyHz: number, timeOffset: number, window?: ArrayLike<number>): [number, number] {
  let re = 0;
  let im = 0;
  const w = 2 * Math.PI * frequencyHz * dtSec;
  for (let n = 0; n < rec.length; n++) {
    const v = rec[n] * (window ? window[n] : 1);
    re += v * Math.cos(w * (n + timeOffset));
    im -= v * Math.sin(w * (n + timeOffset));
  }
  return [re, im];
}

export function hannWindow(length: number): Float64Array {
  return Float64Array.from({ length }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (length - 1)));
}

/**
 * Peak of the Hann-windowed spectrum within [lo, hi]: a scan at a tenth of a
 * bin, then golden-section search to 1e-6 bin. Returns the frequency and the
 * windowed amplitude there.
 */
export function spectralPeak(rec: ArrayLike<number>, dtSec: number, loHz: number, hiHz: number): { frequencyHz: number; amplitude: number } {
  const window = hannWindow(rec.length);
  const bin = 1 / (rec.length * dtSec);
  const amplitude = (f: number) => Math.hypot(...dft(rec, dtSec, f, 0, window));
  const steps = Math.max(8, Math.ceil(((hiHz - loHz) / bin) * 10));
  let best = loHz;
  let bestAmplitude = -1;
  for (let s = 0; s <= steps; s++) {
    const f = loHz + ((hiHz - loHz) * s) / steps;
    const a = amplitude(f);
    if (a > bestAmplitude) [best, bestAmplitude] = [f, a];
  }
  let [a, b] = [best - (hiHz - loHz) / steps, best + (hiHz - loHz) / steps];
  const g = (Math.sqrt(5) - 1) / 2;
  while (b - a > 1e-6 * bin) {
    const [c, d] = [b - g * (b - a), a + g * (b - a)];
    if (amplitude(c) > amplitude(d)) b = d;
    else a = c;
  }
  const f = (a + b) / 2;
  return { frequencyHz: f, amplitude: amplitude(f) };
}

/* ---------------------------------------------------------- convergence */

/** One solve of a refinement study: a representative cell size and the quantity it gave. */
export interface Level { hMm: number; value: number }

/**
 * Observed order of accuracy from the error against an exact answer at each
 * level: the least-squares slope of ln|error| against ln h. Inconclusive when
 * fewer than three levels have an error above `floor` (the reference's and the
 * extraction's own error), or when the errors change sign (not monotone).
 */
export function observedOrderAgainstExact(levels: Level[], exact: number, floor: number): { order: number | null; reason: string } {
  if (levels.some((l) => !Number.isFinite(l.value))) return { order: Number.NaN, reason: 'a level gave a non-finite result' };
  const usable = levels.filter((l) => Math.abs(l.value - exact) > 10 * floor);
  if (usable.length < 3) return { order: null, reason: `only ${usable.length} levels have an error above ten times the floor ${floor.toExponential(1)}` };
  const signs = new Set(usable.map((l) => Math.sign(l.value - exact)));
  if (signs.size > 1) return { order: null, reason: 'the error changes sign between levels' };
  const xs = usable.map((l) => Math.log(l.hMm));
  const ys = usable.map((l) => Math.log(Math.abs(l.value - exact)));
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let n = 0; n < xs.length; n++) {
    sxy += (xs[n] - mx) * (ys[n] - my);
    sxx += (xs[n] - mx) ** 2;
  }
  return { order: sxy / sxx, reason: `slope of ln|error| over ${usable.length} levels` };
}

/** Verdict on an observed order: below MIN fails (a first-order term), above MAX is inconclusive. */
export function orderVerdict(order: number | null): Verdict {
  if (order === null) return 'inconclusive';
  if (Number.isNaN(order)) return 'fail';
  if (order < MIN_OBSERVED_ORDER) return 'fail';
  if (order > MAX_OBSERVED_ORDER) return 'inconclusive';
  return 'pass';
}

/**
 * Richardson extrapolation from the two finest levels with the formal order,
 * and its uncertainty: the grid convergence index with the three-level safety
 * factor (valid only once the order check has passed).
 */
export function richardson(levels: Level[]): { extrapolated: number; band: number; ratio: number } {
  const sorted = [...levels].sort((a, b) => a.hMm - b.hMm);
  const [fine, coarse] = sorted;
  const ratio = coarse.hMm / fine.hMm;
  const factor = ratio ** FORMAL_ORDER - 1;
  const difference = fine.value - coarse.value;
  return { extrapolated: fine.value + difference / factor, band: (GCI_SAFETY_THREE_LEVELS * Math.abs(difference)) / factor, ratio };
}

/** Discretisation band at the coarser of two levels, formal order assumed, with a given safety factor (Roache's GCI). */
export function twoLevelBand(coarse: Level, fine: Level, safety: number): number {
  const ratio = coarse.hMm / fine.hMm;
  return (safety * Math.abs(fine.value - coarse.value) * ratio ** FORMAL_ORDER) / (ratio ** FORMAL_ORDER - 1);
}
