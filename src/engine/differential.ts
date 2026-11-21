/**
 * Differential pairs from a single-ended S-matrix: mixed-mode S-parameters
 * (Sdd, Scc, Scd, Sdc) with a reference impedance per mode, differential and
 * common-mode TDR, delay through the pair and intra-pair skew.
 *
 * Mixed mode (Bockelman and Eisenstadt, IEEE Trans. MTT 43(7), 1995): with
 * power waves on single-ended ports of Z0, the waves of pair k are
 *   a_dk = (a_Pk - a_Nk) / sqrt 2,   a_ck = (a_Pk + a_Nk) / sqrt 2,
 * which are the power waves of Vd = V_P - V_N, Id = (I_P - I_N) / 2 on
 * 2 Z0 and of Vc = (V_P + V_N) / 2, Ic = I_P + I_N on Z0 / 2. So
 * S_mm = M S M^T with the orthogonal M above, and moving to other mode
 * references (90 ohm differential for USB 2.0) is an ordinary renormalisation
 * of the mixed-mode ports. Mixed-mode ports are ordered D1..DK, C1..CK: Sdd is
 * the top-left block, Scc the bottom-right, Scd (differential in, common out)
 * the bottom-left, Sdc the top-right.
 *
 * Skew is measured in the time domain, as the difference of the 50 %
 * crossings of the two lines' step responses (TDT), because on a coupled pair
 * each line's single-ended phase delay mixes the even and odd modes. It is
 * cross-checked against mode conversion: for two matched lines that differ
 * only in delay by d, Scd21 / Sdd21 = -j tan(pi f d), so the imaginary part of
 * that ratio gives d at every frequency. Impedance or loss imbalance between
 * the lines also converts modes and shows up as disagreement between the two.
 */
import { renormaliseScattering, type ScatteringResult } from './port_dft';
import { crossingTimeNs, lowPassStep, stepTdr, type TdrTrace } from './time_domain';

/**
 * Energy decay a solve should reach before its skew and TDR level are
 * trusted. Both rest on the lowest frequencies of the band, which a ring-down
 * cut at 40 dB leaves wrong: on a pair with a 3 mm detour in one line the
 * 50 % crossing skew read -6.5 ps at 40 dB and -10.3 ps at 60 dB, where it
 * agrees with the mode-conversion figure and no longer moves with the rise
 * time (docs/differential-pairs.md).
 */
export const TIMING_ENERGY_DECAY_DB = 60;

/**
 * What a plain loss tangent does to the time-domain results (resolve.ts,
 * constantLossDielectrics): its constant conductivity still conducts at DC,
 * which the TDR reads as a conductance to ground along the line.
 */
export function constantLossNote(layers: string[]): string {
  return `The loss of ${layers.join(', ')} is partly or wholly a constant conductivity, exact at the loss reference frequency but still conducting at DC, ` +
    'so the TDR reads low along the line and lower still at its far end. Give the material a Djordjevic-Sarkar dispersion ' +
    '(the "wideband" materials), whose loss vanishes at DC, for a true TDR level.';
}

export interface PairSpec {
  id: string;
  /** Single-ended port indices of the positive and negative line at this end. */
  positive: number;
  negative: number;
  /** Mode reference impedances, ohm; absent: 2 Z0 and Z0 / 2, the values with no renormalisation. */
  differentialOhm?: number;
  commonOhm?: number;
}

export interface MixedModeResult {
  pairIds: string[];
  /** Ports D1..DK, C1..CK, on the reference impedances below. */
  s: ScatteringResult;
  differentialOhm: number[];
  commonOhm: number[];
}

export type ModeBlock = 'dd' | 'cc' | 'cd' | 'dc';

/** Mixed-mode S of every pair, on each pair's mode references. Every port must belong to exactly one pair. */
export function mixedModeScattering(s: ScatteringResult, z0: number[], pairs: PairSpec[]): MixedModeResult {
  const n = s.re.length;
  if (z0.length !== n) throw new Error(`${n} ports but ${z0.length} reference impedances`);
  if (s.re.some((row) => row.some((column) => column === null))) throw new Error('mixed-mode S needs every port excited');
  if (2 * pairs.length !== n) throw new Error(`${n} ports make ${n / 2} pairs, but ${pairs.length} pairs were given: every port must be in one pair`);
  const used = pairs.flatMap((p) => [p.positive, p.negative]);
  if (new Set(used).size !== n || used.some((i) => !(i >= 0 && i < n))) throw new Error('each port must be in exactly one pair');
  for (const p of pairs) {
    if (z0[p.positive] !== z0[p.negative]) throw new Error(`pair ${p.id}: both lines need the same reference impedance (${z0[p.positive]} and ${z0[p.negative]} Ω)`);
    for (const r of [p.differentialOhm, p.commonOhm]) if (r !== undefined && !(r > 0)) throw new Error(`pair ${p.id}: a mode reference impedance must be above 0 Ω`);
  }
  const k = pairs.length;
  // M[row][port]: row k is D(k+1), row K+k is C(k+1).
  const m = Array.from({ length: n }, () => new Float64Array(n));
  pairs.forEach((p, q) => {
    m[q][p.positive] = Math.SQRT1_2;
    m[q][p.negative] = -Math.SQRT1_2;
    m[k + q][p.positive] = Math.SQRT1_2;
    m[k + q][p.negative] = Math.SQRT1_2;
  });
  const nf = s.fGHz.length;
  const re = Array.from({ length: n }, () => Array.from({ length: n }, () => new Float64Array(nf)));
  const im = Array.from({ length: n }, () => Array.from({ length: n }, () => new Float64Array(nf)));
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      for (let i = 0; i < n; i++) {
        if (m[r][i] === 0) continue;
        for (let j = 0; j < n; j++) {
          const w = m[r][i] * m[c][j];
          if (w === 0) continue;
          const [sr, si] = [s.re[i][j]!, s.im[i][j]!];
          for (let f = 0; f < nf; f++) {
            re[r][c][f] += w * sr[f];
            im[r][c][f] += w * si[f];
          }
        }
      }
    }
  }
  const native = [...pairs.map((p) => 2 * z0[p.positive]), ...pairs.map((p) => z0[p.positive] / 2)];
  const target = [...pairs.map((p) => p.differentialOhm ?? 2 * z0[p.positive]), ...pairs.map((p) => p.commonOhm ?? z0[p.positive] / 2)];
  const mixed: ScatteringResult = { ...s, re, im };
  return {
    pairIds: pairs.map((p) => p.id),
    s: target.every((z, i) => z === native[i]) ? mixed : renormaliseScattering(mixed, native, target),
    differentialOhm: target.slice(0, k),
    commonOhm: target.slice(k),
  };
}

/** One mixed-mode term, e.g. ('cd', 1, 0) for Scd21; pair indices from 0. */
export function modeTerm(mm: MixedModeResult, block: ModeBlock, to: number, from: number): { re: Float64Array; im: Float64Array } {
  const k = mm.pairIds.length;
  const row = to + (block[0] === 'c' ? k : 0);
  const column = from + (block[1] === 'c' ? k : 0);
  return { re: mm.s.re[row][column]!, im: mm.s.im[row][column]! };
}

/** Lines through the pair: a pair end and the other end it transmits to most (largest mean |Sdd|), when both ends agree. */
export function pairThroughs(mm: MixedModeResult): Array<[from: number, to: number]> {
  const k = mm.pairIds.length;
  const mean = (to: number, from: number) => {
    const t = modeTerm(mm, 'dd', to, from);
    return t.re.reduce((sum, x, f) => sum + Math.hypot(x, t.im[f]), 0) / t.re.length;
  };
  const partner = Array.from({ length: k }, (_, i) => {
    let best = -1;
    for (let j = 0; j < k; j++) if (j !== i && (best < 0 || mean(j, i) > mean(best, i))) best = j;
    return best;
  });
  return partner.flatMap((j, i): Array<[number, number]> => (j > i && partner[j] === i ? [[i, j]] : []));
}

export interface ThroughTiming {
  /** 50 % crossings of the step responses, ns: differential, then each line on its own. */
  differentialDelayNs: number;
  positiveDelayNs: number;
  negativeDelayNs: number;
  /** Positive line minus negative line, from the step crossings, ps. */
  skewPs: number;
}

export interface ThroughReport {
  from: string;
  to: string;
  /** Null when a step does not settle into a delay (a network that blocks DC, say), with the reason in timingProblem. */
  timing: ThroughTiming | null;
  timingProblem: string | null;
  /** The same from Im(Scd / Sdd) per frequency: median and range over the frequencies where |Sdd| is above -6 dB, ps. */
  skewFromConversionPs: { median: number; min: number; max: number } | null;
}

export interface PairEndReport {
  id: string;
  differentialOhm: number;
  commonOhm: number;
  /** Differential and common-mode TDR from this end; null when the band is not evenly spaced (see timeDomainProblem). */
  differentialTdr: TdrTrace | null;
  commonTdr: TdrTrace | null;
  /**
   * Differential impedance along the middle half of the line (round-trip
   * times from half to one and a half of the one-way delay), ohm: the
   * median, which reads the line rather than the ports, and the range. Null
   * without a through to time the line by, or when the TDR's rise time is
   * longer than the line's delay, so the port transitions smear over the
   * whole window.
   */
  lineDifferentialOhm: { median: number; min: number; max: number } | null;
  lineCommonOhm: { median: number; min: number; max: number } | null;
}

export interface DifferentialReport {
  mixedMode: MixedModeResult;
  ends: PairEndReport[];
  throughs: ThroughReport[];
  /** Why there is no TDR or delay at all (an unevenly spaced band, as from a log sweep), else null. */
  timeDomainProblem: string | null;
}

/** Whether the band is evenly spaced, which the low-pass transforms assume. */
function evenlySpaced(f: ArrayLike<number>): boolean {
  const df = (f[f.length - 1] - f[0]) / (f.length - 1);
  for (let m = 1; m < f.length; m++) if (Math.abs(f[m] - f[m - 1] - df) > 1e-6 * df) return false;
  return f.length >= 2 && df > 0;
}

/** Everything the pair view and the CLI report, from the single-ended S-matrix. */
export function analyseDifferential(s: ScatteringResult, z0: number[], pairs: PairSpec[]): DifferentialReport {
  const mixedMode = mixedModeScattering(s, z0, pairs);
  // Skew from conversion uses the unrenormalised mixed-mode S, where the tan relation holds for matched lines.
  const native = mixedModeScattering(s, z0, pairs.map(({ differentialOhm: _d, commonOhm: _c, ...p }) => p));
  const f = s.fGHz;
  const df = (f[f.length - 1] - f[0]) / (f.length - 1);
  // Half the span the band's frequency step can tell apart without aliasing.
  const recordNs = 0.5 / df;
  const timeDomainProblem = evenlySpaced(f) ? null : 'the band is not evenly spaced (a log or segmented sweep), and the TDR and step responses need it to be';
  const delay = (re: ArrayLike<number>, im: ArrayLike<number>) => {
    if (timeDomainProblem) throw new Error(timeDomainProblem);
    return crossingTimeNs(lowPassStep(f, re, im, recordNs));
  };

  const throughs = pairThroughs(mixedMode).map(([i, j]): ThroughReport => {
    const dd = modeTerm(mixedMode, 'dd', j, i);
    const [p, q] = [pairs[i], pairs[j]];
    let timing: ThroughTiming | null = null;
    let timingProblem: string | null = null;
    try {
      const positiveDelayNs = delay(s.re[q.positive][p.positive]!, s.im[q.positive][p.positive]!);
      const negativeDelayNs = delay(s.re[q.negative][p.negative]!, s.im[q.negative][p.negative]!);
      timing = { differentialDelayNs: delay(dd.re, dd.im), positiveDelayNs, negativeDelayNs, skewPs: 1000 * (positiveDelayNs - negativeDelayNs) };
    } catch (error) {
      timingProblem = (error as Error).message;
    }
    return {
      from: p.id, to: q.id, timing, timingProblem,
      skewFromConversionPs: skewFromConversion(f, modeTerm(native, 'cd', j, i), modeTerm(native, 'dd', j, i), timing?.skewPs ?? null),
    };
  });

  const ends = pairs.map((p, i): PairEndReport => {
    const dd = modeTerm(mixedMode, 'dd', i, i);
    const cc = modeTerm(mixedMode, 'cc', i, i);
    const differentialTdr = timeDomainProblem ? null : stepTdr(f, dd.re, dd.im, mixedMode.differentialOhm[i], recordNs);
    const commonTdr = timeDomainProblem ? null : stepTdr(f, cc.re, cc.im, mixedMode.commonOhm[i], recordNs);
    const through = throughs.find((t) => t.from === p.id || t.to === p.id);
    const middle = (trace: TdrTrace | null) => {
      if (!trace || !through?.timing) return null;
      const tau = through.timing.differentialDelayNs;
      // The window sits tau / 2 inside each port transition, which spreads about half the rise time either side.
      if (trace.riseTimePs / 1000 > tau) return null;
      const values = Array.from(trace.zOhm).filter((_, n) => trace.tNs[n] >= tau / 2 && trace.tNs[n] <= 1.5 * tau).sort((a, b) => a - b);
      return values.length ? { median: values[Math.floor(values.length / 2)], min: values[0], max: values[values.length - 1] } : null;
    };
    return {
      id: p.id, differentialOhm: mixedMode.differentialOhm[i], commonOhm: mixedMode.commonOhm[i],
      differentialTdr, commonTdr,
      lineDifferentialOhm: middle(differentialTdr),
      lineCommonOhm: middle(commonTdr),
    };
  });
  return { mixedMode, ends, throughs, timeDomainProblem };
}

/**
 * Skew from Im(Scd / Sdd) = -tan(pi f d) at each frequency where |Sdd| is
 * above -6 dB. atan only inverts that while pi f |d| < pi / 2; with a skew
 * from the step responses to go by, only frequencies with pi f |d| < pi / 3
 * are used, so no value has wrapped.
 */
function skewFromConversion(fGHz: ArrayLike<number>, cd: { re: Float64Array; im: Float64Array }, dd: { re: Float64Array; im: Float64Array }, stepSkewPs: number | null) {
  const values: number[] = [];
  const fLimitGHz = stepSkewPs ? 1000 / (3 * Math.abs(stepSkewPs)) : Infinity;
  for (let m = 0; m < fGHz.length; m++) {
    const den = dd.re[m] ** 2 + dd.im[m] ** 2;
    if (!(fGHz[m] > 0) || fGHz[m] > fLimitGHz || den < 0.25) continue;
    // Im(cd / dd) = (cd_im dd_re - cd_re dd_im) / |dd|^2 = -tan(pi f d).
    const ratioIm = (cd.im[m] * dd.re[m] - cd.re[m] * dd.im[m]) / den;
    values.push((1000 * Math.atan(-ratioIm)) / (Math.PI * fGHz[m]));
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { median: values[Math.floor(values.length / 2)], min: values[0], max: values[values.length - 1] };
}

/**
 * A pairing to propose, from the S-matrix and where the ports sit. Lines:
 * each port and the port it transmits to most, when both agree. Pairs of
 * lines: each line, in file order, with the remaining line it couples to
 * most. Ends: of the two lines' ports, the
 * nearer ones form a pair end. Polarity and names follow file order, which
 * the user confirms or swaps. Null, with the reason, when the ports do not
 * read as pairs of lines.
 */
export function proposePairs(s: ScatteringResult, portIds: string[], positionsMm: Array<{ xMm: number; yMm: number }>):
  { pairs: Array<{ id: string; positive: string; negative: string }> } | { reason: string } {
  const n = portIds.length;
  if (n < 4 || n % 4) return { reason: 'Differential pairs need a multiple of four ports: two lines per pair, a port at each end of each.' };
  if (s.re.some((row) => row.some((column) => column === null))) return { reason: 'Pairing needs every port excited.' };
  const mean = (i: number, j: number) => s.re[i][j]!.reduce((sum, x, f) => sum + Math.hypot(x, s.im[i][j]![f]), 0) / s.fGHz.length;
  const partner = Array.from({ length: n }, (_, i) => {
    let best = -1;
    for (let j = 0; j < n; j++) if (j !== i && (best < 0 || mean(j, i) > mean(best, i))) best = j;
    return best;
  });
  if (partner.some((j, i) => partner[j] !== i)) return { reason: 'The ports do not form through lines: some port transmits most to a port that transmits most elsewhere.' };
  const lines = partner.flatMap((j, i): Array<[number, number]> => (j > i ? [[i, j]] : []));
  const coupling = (a: [number, number], b: [number, number]) => (mean(a[0], b[0]) + mean(a[0], b[1]) + mean(a[1], b[0]) + mean(a[1], b[1])) / 4;
  const left = [...lines];
  const linePairs: Array<[[number, number], [number, number]]> = [];
  while (left.length) {
    const a = left.shift()!;
    let best = 0;
    for (let k = 1; k < left.length; k++) if (coupling(a, left[k]) > coupling(a, left[best])) best = k;
    linePairs.push([a, left.splice(best, 1)[0]]);
  }
  const distance = (i: number, j: number) => Math.hypot(positionsMm[i].xMm - positionsMm[j].xMm, positionsMm[i].yMm - positionsMm[j].yMm);
  const pairs: Array<{ id: string; positive: string; negative: string }> = [];
  for (const [a, b] of linePairs) {
    // a[0] sits with whichever end of b is nearer; a[1] with the other.
    const [b0, b1] = distance(a[0], b[0]) <= distance(a[0], b[1]) ? b : [b[1], b[0]];
    if (distance(a[0], b0) >= distance(a[0], a[1])) return { reason: 'The two lines\' ends are not side by side: the nearest port to each end is on the same line.' };
    // The positive line is the one with the first port in file order, at both ends.
    const aPositive = Math.min(...a) < Math.min(...b);
    for (const [p, q] of [[a[0], b0], [a[1], b1]]) {
      const [positive, negative] = aPositive ? [p, q] : [q, p];
      pairs.push({ id: '', positive: portIds[positive], negative: portIds[negative] });
    }
  }
  pairs.sort((x, y) => portIds.indexOf(x.positive) - portIds.indexOf(y.positive));
  pairs.forEach((p, k) => (p.id = `D${k + 1}`));
  return { pairs };
}

/** Pairs written with port ids (as in a project file's outputs.differential_pairs), as port indices. */
export function pairSpecsFromIds(
  defs: ReadonlyArray<{ id: string; positive: string; negative: string; differential_ohm?: number; common_ohm?: number }>, portIds: string[],
): PairSpec[] {
  const index = (id: string) => {
    const n = portIds.indexOf(id);
    if (n < 0) throw new Error(`"${id}" is not a port id (ports: ${portIds.join(', ')})`);
    return n;
  };
  return defs.map((d) => ({
    id: d.id, positive: index(d.positive), negative: index(d.negative),
    ...(d.differential_ohm === undefined ? {} : { differentialOhm: d.differential_ohm }),
    ...(d.common_ohm === undefined ? {} : { commonOhm: d.common_ohm }),
  }));
}

/** dB, floored at -300 so an exact zero (an ideal symmetric model) stays a number in JSON. */
const dbOf = (re: number, im: number) => Math.max(-300, 20 * Math.log10(Math.hypot(re, im)));
const round = (x: number, digits: number) => Number(x.toFixed(digits));
const roundRange = (r: { median: number; min: number; max: number } | null, digits: number) =>
  r && { median: round(r.median, digits), min: round(r.min, digits), max: round(r.max, digits) };

/**
 * The report as plain JSON, for the CLI and agents: every mixed-mode term's
 * range in dB and its value at `atGHz`, the impedance and timing figures,
 * and the dB curves of the terms an engineer reads first (Sdd11, Sdd21,
 * Scd21, Scc11 of each through).
 */
export function differentialJson(report: DifferentialReport, portIds: string[], pairs: PairSpec[], atGHz: number[]) {
  const mm = report.mixedMode;
  const f = mm.s.fGHz;
  const k = mm.pairIds.length;
  const blocks: ModeBlock[] = ['dd', 'cc', 'cd', 'dc'];
  const terms = blocks.flatMap((block) => Array.from({ length: k * k }, (_, n) => {
    const [to, from] = [Math.floor(n / k), n % k];
    const t = modeTerm(mm, block, to, from);
    const db = Array.from(t.re, (x, m) => dbOf(x, t.im[m]));
    const at = atGHz.map((g) => {
      let m = 0;
      for (let q = 1; q < f.length; q++) if (Math.abs(f[q] - g) < Math.abs(f[m] - g)) m = q;
      return { ghz: round(f[m], 6), db: round(db[m], 3), deg: round((180 / Math.PI) * Math.atan2(t.im[m], t.re[m]), 2) };
    });
    return { name: `S${block}${to + 1}${from + 1}`, min_db: round(Math.min(...db), 3), max_db: round(Math.max(...db), 3), at };
  }));
  const curve = (block: ModeBlock, to: number, from: number) => {
    const t = modeTerm(mm, block, to, from);
    return Array.from(t.re, (x, m) => round(dbOf(x, t.im[m]), 3));
  };
  const curves: Record<string, number[]> = { f_ghz: Array.from(f, (x) => round(x, 6)) };
  for (const [i, j] of pairThroughs(mm)) {
    curves[`Sdd${i + 1}${i + 1}`] = curve('dd', i, i);
    curves[`Sdd${j + 1}${i + 1}`] = curve('dd', j, i);
    curves[`Scd${j + 1}${i + 1}`] = curve('cd', j, i);
    curves[`Scc${i + 1}${i + 1}`] = curve('cc', i, i);
  }
  return {
    pairs: pairs.map((p, n) => ({ id: p.id, positive: portIds[p.positive], negative: portIds[p.negative], differential_ohm: mm.differentialOhm[n], common_ohm: mm.commonOhm[n] })),
    throughs: report.throughs.map((t) => ({
      from: t.from, to: t.to,
      ...(t.timing ? {
        differential_delay_ns: round(t.timing.differentialDelayNs, 5),
        positive_delay_ns: round(t.timing.positiveDelayNs, 5),
        negative_delay_ns: round(t.timing.negativeDelayNs, 5),
        skew_ps: round(t.timing.skewPs, 3),
      } : { timing_problem: t.timingProblem }),
      skew_from_conversion_ps: roundRange(t.skewFromConversionPs, 3),
    })),
    time_domain_problem: report.timeDomainProblem,
    ends: report.ends.map((e) => ({
      id: e.id,
      line_differential_ohm: roundRange(e.lineDifferentialOhm, 2),
      line_common_ohm: roundRange(e.lineCommonOhm, 2),
      tdr_rise_time_ps: e.differentialTdr && round(e.differentialTdr.riseTimePs, 1),
    })),
    terms,
    curves,
  };
}

/** One line per through and per pair end, for a terminal. */
export function differentialSummaryLines(report: DifferentialReport): string[] {
  const ps = (ns: number) => `${(1000 * ns).toFixed(1)} ps`;
  return [
    ...report.throughs.map((t) => `${t.from} -> ${t.to}: ` + (t.timing
      ? `differential delay ${ps(t.timing.differentialDelayNs)}, skew ${t.timing.skewPs.toFixed(2)} ps`
      : `no delay: ${t.timingProblem}`)
      + (t.skewFromConversionPs ? ` (${t.skewFromConversionPs.median.toFixed(2)} ps from Scd)` : '')),
    ...report.ends.flatMap((e) => (e.lineDifferentialOhm && e.lineCommonOhm
      ? [`${e.id}: line Zdiff ${e.lineDifferentialOhm.median.toFixed(1)} ohm, Zcomm ${e.lineCommonOhm.median.toFixed(1)} ohm`] : [])),
  ];
}
