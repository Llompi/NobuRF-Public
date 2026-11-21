import { interp } from '../engine/port_dft';

/**
 * What a design must achieve. The finish line is "on frequency and below
 * s11_max_db": S11 at the target at or below the limit, and the deepest point
 * of the dip within f_tolerance_pct of the target.
 */
export interface DesignGoal {
  target_ghz: number;
  /** Default -10. */
  s11_max_db: number;
  /** How far the dip may sit from the target, in % of the target. Default 1. */
  f_tolerance_pct: number;
  /** Optional: the S11 <= s11_max_db band around the target must be at least this wide. */
  min_bandwidth_mhz?: number;
  /** Optional: circular polarisation; axial ratio toward +z (boresight) at the target, at most this. */
  max_axial_ratio_db?: number;
}

/** What one solve says about a design, in the goal's terms. */
export interface DesignMetrics {
  /** Frequency of the deepest S11 in the band. */
  f0_ghz: number;
  s11_min_db: number;
  s11_at_target_db: number;
  /** Width of the S11 <= s11_max_db band that contains the target; 0 when the target is not in one. */
  bandwidth_mhz: number;
  /** True when that band runs into the edge of the analysed band, so the true width is larger. */
  bandwidth_open: boolean;
  /** |Z_in| at the target, ohm, when the spectrum carries Z. */
  zin_target_ohm?: number;
  /** Boresight axial ratio and sense at the target, only when the goal asks for it. */
  axial_ratio_db?: number;
  polarisation_sense?: 'RHCP' | 'LHCP';
}

export interface Spectrum {
  fGHz: ArrayLike<number>;
  s11Db: ArrayLike<number>;
  /** Z_in, ohm; optional so S11 alone still gives every other metric. */
  zRe?: ArrayLike<number>;
  zIm?: ArrayLike<number>;
}

export function metricsFromSpectrum(spec: Spectrum, goal: DesignGoal): DesignMetrics {
  const n = spec.fGHz.length;
  const s11AtTarget = interp(spec.fGHz, spec.s11Db, goal.target_ghz);
  let bandwidthMhz = 0;
  let open = false;
  let iMin = -1;
  if (s11AtTarget <= goal.s11_max_db) {
    // Walk out from the target to where S11 crosses the limit, interpolating the crossing.
    let hi = 0;
    while (hi < n && spec.fGHz[hi] < goal.target_ghz) hi++;
    let lo = hi - 1;
    while (hi < n && spec.s11Db[hi] <= goal.s11_max_db) hi++;
    while (lo >= 0 && spec.s11Db[lo] <= goal.s11_max_db) lo--;
    const crossing = (a: number, b: number) => {
      const t = (goal.s11_max_db - spec.s11Db[a]) / (spec.s11Db[b] - spec.s11Db[a]);
      return spec.fGHz[a] + t * (spec.fGHz[b] - spec.fGHz[a]);
    };
    const fHi = hi >= n ? spec.fGHz[n - 1] : crossing(hi - 1, hi);
    const fLo = lo < 0 ? spec.fGHz[0] : crossing(lo + 1, lo);
    open = hi >= n || lo < 0;
    bandwidthMhz = (fHi - fLo) * 1000;
    // The dip is the one whose band holds the target, not a deeper one elsewhere (a second mode).
    for (let m = lo + 1; m < hi; m++) if (iMin < 0 || spec.s11Db[m] < spec.s11Db[iMin]) iMin = m;
  } else {
    // The deepest dip inside the band: a band edge can read lower than a resonance and is not one.
    for (let m = 1; m < n - 1; m++) {
      const isDip = spec.s11Db[m] <= spec.s11Db[m - 1] && spec.s11Db[m] <= spec.s11Db[m + 1];
      if (isDip && (iMin < 0 || spec.s11Db[m] < spec.s11Db[iMin])) iMin = m;
    }
    if (iMin < 0) iMin = spec.s11Db[0] <= spec.s11Db[n - 1] ? 0 : n - 1; // no dip in the band: the lower edge
  }
  const dip = dipVertex(spec, iMin);
  return {
    f0_ghz: dip.fGhz,
    s11_min_db: dip.db,
    s11_at_target_db: s11AtTarget,
    bandwidth_mhz: bandwidthMhz,
    bandwidth_open: open,
    ...(spec.zRe && spec.zIm ? { zin_target_ohm: Math.hypot(interp(spec.fGHz, spec.zRe, goal.target_ghz), interp(spec.fGHz, spec.zIm, goal.target_ghz)) } : {}),
  };
}

/**
 * The dip between samples: the vertex of the parabola through the minimum and
 * its neighbours, so f0 is not stuck on the frequency grid and the depth does
 * not scallop as the dip slides between samples.
 */
function dipVertex(spec: Spectrum, m: number): { fGhz: number; db: number } {
  const atSample = { fGhz: spec.fGHz[m], db: spec.s11Db[m] };
  if (m <= 0 || m >= spec.fGHz.length - 1) return atSample;
  const [a, b, c] = [spec.s11Db[m - 1], spec.s11Db[m], spec.s11Db[m + 1]];
  const curvature = a - 2 * b + c;
  if (!(curvature > 0)) return atSample;
  const offset = (0.5 * (a - c)) / curvature; // in samples, within (-0.5, 0.5)
  const step = offset >= 0 ? spec.fGHz[m + 1] - spec.fGHz[m] : spec.fGHz[m] - spec.fGHz[m - 1];
  return { fGhz: spec.fGHz[m] + offset * step, db: b - 0.25 * (a - c) * offset };
}

/**
 * Boresight axial ratio from the two transverse far-field phasors (theta = 0,
 * phi = 0, where theta-hat is x and phi-hat is y), for the solver's exp(+j w t)
 * convention. E = x - j y is right-hand circular (IEEE: clockwise seen from
 * behind, looking along +z).
 */
export function axialRatio(exRe: number, exIm: number, eyRe: number, eyIm: number): { db: number; sense: 'RHCP' | 'LHCP' } {
  // Components on the circular unit vectors (x -+ j y)/sqrt 2: E_R = (Ex + j Ey)/sqrt 2, E_L = (Ex - j Ey)/sqrt 2.
  const right = Math.hypot(exRe - eyIm, exIm + eyRe) / Math.SQRT2;
  const left = Math.hypot(exRe + eyIm, exIm - eyRe) / Math.SQRT2;
  const ratio = (right + left) / Math.abs(right - left);
  return { db: Math.min(20 * Math.log10(ratio), AXIAL_RATIO_CAP_DB), sense: right >= left ? 'RHCP' : 'LHCP' };
}

/** A linearly polarised antenna has an infinite axial ratio; report it as this. */
export const AXIAL_RATIO_CAP_DB = 40;

/** dB of score per % of frequency error: a 1 % miss costs as much as S11 3 dB above the limit. */
const SCORE_DB_PER_FREQ_PCT = 3;

/**
 * One number to minimise, 0 exactly when the goal is met. Every term is in dB
 * (or dB-equivalent) above its limit, so the optimiser sees progress on each.
 * The frequency term gives a slope where S11 at the target is flat (the dip far away).
 */
export function goalScore(m: DesignMetrics, goal: DesignGoal): number {
  const freqErrPct = (100 * Math.abs(m.f0_ghz - goal.target_ghz)) / goal.target_ghz;
  let score = Math.max(0, m.s11_at_target_db - goal.s11_max_db) + SCORE_DB_PER_FREQ_PCT * Math.max(0, freqErrPct - goal.f_tolerance_pct);
  if (goal.min_bandwidth_mhz) score += (10 * Math.max(0, goal.min_bandwidth_mhz - m.bandwidth_mhz)) / goal.min_bandwidth_mhz;
  if (goal.max_axial_ratio_db !== undefined) score += Math.max(0, (m.axial_ratio_db ?? AXIAL_RATIO_CAP_DB) - goal.max_axial_ratio_db);
  return score;
}

export const goalMet = (m: DesignMetrics, goal: DesignGoal) => goalScore(m, goal) === 0;
