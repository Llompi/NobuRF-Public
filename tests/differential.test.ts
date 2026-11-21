import { describe, expect, it } from 'vitest';
import { analyseDifferential, mixedModeScattering, modeTerm, proposePairs, type PairSpec } from '../src/engine/differential';
import type { ScatteringResult } from '../src/engine/port_dft';

type C = [number, number];
const C_MM_PER_NS = 299.792458;

/** S11 and S21 of a lossless line section of impedance z, eps_eff and length, between zRef ports. */
function lineS(z: number, zRef: number, epsEff: number, lengthMm: number, fGHz: number): { s11: C; s21: C } {
  const g = (z - zRef) / (z + zRef);
  const theta = (2 * Math.PI * fGHz * Math.sqrt(epsEff) * lengthMm) / C_MM_PER_NS;
  const p: C = [Math.cos(theta), -Math.sin(theta)];
  const p2: C = [p[0] * p[0] - p[1] * p[1], 2 * p[0] * p[1]];
  const den: C = [1 - g * g * p2[0], -g * g * p2[1]];
  const d = den[0] ** 2 + den[1] ** 2;
  const div = (a: C): C => [(a[0] * den[0] + a[1] * den[1]) / d, (a[1] * den[0] - a[0] * den[1]) / d];
  return { s11: div([g * (1 - p2[0]), -g * p2[1]]), s21: div([p[0] * (1 - g * g), p[1] * (1 - g * g)]) };
}

const band = (n: number, df: number) => Array.from({ length: n }, (_, m) => (m + 1) * df);

/** A 4-port S from a function giving S_ij at each frequency, ports in the order given. */
function fourPort(fGHz: number[], at: (i: number, j: number, f: number) => C): ScatteringResult {
  const re = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => Float64Array.from(fGHz, (f) => at(i, j, f)[0])));
  const im = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => Float64Array.from(fGHz, (f) => at(i, j, f)[1])));
  return { fGHz: Float64Array.from(fGHz), re, im, method: 'full', maxPassiveIncidentRatio: 0 };
}

/**
 * Symmetric lossless coupled line, ports P1 = 0, N1 = 1, P2 = 2, N2 = 3, in
 * the even/odd form of Pozar (Microwave Engineering, 4th ed., section 7.6):
 * reflection (Ge + Go) / 2, near-end coupling (Ge - Go) / 2, through
 * (Te + To) / 2, far-end coupling (Te - To) / 2, each mode a line of its own
 * impedance and eps_eff seen from Z0 ports.
 */
function coupledLine(fGHz: number[], z0: number, ze: number, zo: number, epsE: number, epsO: number, lengthMm: number): ScatteringResult {
  return fourPort(fGHz, (i, j, f) => {
    const e = lineS(ze, z0, epsE, lengthMm, f);
    const o = lineS(zo, z0, epsO, lengthMm, f);
    const sameEnd = (i < 2) === (j < 2);
    const sameLine = i % 2 === j % 2;
    const [ev, od] = sameEnd ? [e.s11, o.s11] : [e.s21, o.s21];
    const sign = sameLine ? 1 : -1;
    return [(ev[0] + sign * od[0]) / 2, (ev[1] + sign * od[1]) / 2];
  });
}

const PAIRS: PairSpec[] = [{ id: 'D1', positive: 0, negative: 1 }, { id: 'D2', positive: 2, negative: 3 }];
const close = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => Array.from(a).every((x, m) => Math.abs(x - b[m]) < tol);

describe('mixed-mode S of a coupled line', () => {
  // Edge-coupled microstrip-like numbers: Ze 60, Zo 45 ohm; the even mode is the slower one, as in microstrip.
  const f = band(200, 0.05);
  const s = coupledLine(f, 50, 60, 45, 3.4, 2.9, 40);

  it('turns into the odd-mode line for Sdd and the even-mode line for Scc, with no conversion', () => {
    const mm = mixedModeScattering(s, [50, 50, 50, 50], PAIRS);
    expect(mm.differentialOhm).toEqual([100, 100]);
    expect(mm.commonOhm).toEqual([25, 25]);
    // Odd mode: a line of 2 Zo on a 2 Z0 reference; even mode: Ze / 2 on Z0 / 2. Both reduce to Zo, Ze on Z0.
    const odd = f.map((x) => lineS(45, 50, 2.9, 40, x));
    const even = f.map((x) => lineS(60, 50, 3.4, 40, x));
    const sdd21 = modeTerm(mm, 'dd', 1, 0);
    const sdd11 = modeTerm(mm, 'dd', 0, 0);
    const scc21 = modeTerm(mm, 'cc', 1, 0);
    expect(close(sdd21.re, odd.map((x) => x.s21[0]), 1e-12)).toBe(true);
    expect(close(sdd11.im, odd.map((x) => x.s11[1]), 1e-12)).toBe(true);
    expect(close(scc21.im, even.map((x) => x.s21[1]), 1e-12)).toBe(true);
    for (const block of ['cd', 'dc'] as const) {
      for (const [to, from] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const t = modeTerm(mm, block, to, from);
        expect(Math.max(...t.re.map(Math.abs), ...t.im.map(Math.abs))).toBeLessThan(1e-14);
      }
    }
  });

  it('matches perfectly when the differential reference is 2 Zo and the common reference Ze / 2', () => {
    const mm = mixedModeScattering(s, [50, 50, 50, 50], PAIRS.map((p) => ({ ...p, differentialOhm: 90, commonOhm: 30 })));
    for (const block of ['dd', 'cc'] as const) {
      const r = modeTerm(mm, block, 0, 0);
      const t = modeTerm(mm, block, 1, 0);
      expect(Math.max(...r.re.map((x, m) => Math.hypot(x, r.im[m])))).toBeLessThan(1e-9);
      expect(Math.min(...t.re.map((x, m) => Math.hypot(x, t.im[m])))).toBeGreaterThan(1 - 1e-9);
    }
  });

  it('reads 90 ohm differential and 30 ohm common impedance from the TDR, and no skew', () => {
    const report = analyseDifferential(s, [50, 50, 50, 50], PAIRS);
    const end = report.ends[0];
    // Middle-half median: the line's impedance; the Kaiser window's ripple is well under 1 %.
    expect(end.lineDifferentialOhm!.median).toBeCloseTo(90, 0);
    expect(end.lineCommonOhm!.median).toBeCloseTo(30, 0);
    const [through] = report.throughs;
    // Odd-mode delay: 40 mm at eps_eff 2.9.
    expect(through.timing!.differentialDelayNs).toBeCloseTo((40 * Math.sqrt(2.9)) / C_MM_PER_NS, 3);
    expect(Math.abs(through.timing!.skewPs)).toBeLessThan(0.01);
    expect(Math.abs(through.skewFromConversionPs!.median)).toBeLessThan(1e-9);
  });
});

describe('skew', () => {
  // Two uncoupled 50 ohm lines, the negative one 2 mm longer: 2 * sqrt(3) / c = 11.56 ps later.
  const f = band(400, 0.05);
  const lengths = [30, 32];
  const s = fourPort(f, (i, j, x) => {
    if (i % 2 !== j % 2) return [0, 0];
    const line = lineS(50, 50, 3, lengths[i % 2], x);
    return (i < 2) === (j < 2) ? line.s11 : line.s21;
  });
  const expected = (1000 * (lengths[0] - lengths[1]) * Math.sqrt(3)) / C_MM_PER_NS;

  it('is the difference of the 50 % crossings, positive line minus negative', () => {
    const [through] = analyseDifferential(s, [50, 50, 50, 50], PAIRS).throughs;
    expect(through.timing!.skewPs).toBeCloseTo(expected, 1);
    expect(through.timing!.positiveDelayNs).toBeCloseTo((30 * Math.sqrt(3)) / C_MM_PER_NS, 4);
  });

  it('agrees with the skew read from mode conversion, Im(Scd21 / Sdd21) = -tan(pi f skew)', () => {
    const [through] = analyseDifferential(s, [50, 50, 50, 50], PAIRS).throughs;
    const c = through.skewFromConversionPs!;
    expect(c.median).toBeCloseTo(expected, 6);
    expect(c.max - c.min).toBeLessThan(1e-6);
  });

  it('flips sign when the lines swap polarity', () => {
    const [through] = analyseDifferential(s, [50, 50, 50, 50], [{ id: 'D1', positive: 1, negative: 0 }, { id: 'D2', positive: 3, negative: 2 }]).throughs;
    expect(through.timing!.skewPs).toBeCloseTo(-expected, 1);
    expect(through.skewFromConversionPs!.median).toBeCloseTo(-expected, 6);
  });
});

describe('pairing', () => {
  const f = band(50, 0.1);
  // File order pa, pb, na, nb: the positive line runs a -> b at y = 0, the negative at y = 0.3 mm.
  const line = coupledLine(f, 50, 60, 45, 3.4, 2.9, 40);
  const order = [0, 2, 1, 3]; // file port -> coupled-line port (P1 0, N1 1, P2 2, N2 3)
  const s = fourPort(f, (i, j, x) => {
    const m = f.indexOf(x);
    return [line.re[order[i]][order[j]]![m], line.im[order[i]][order[j]]![m]];
  });
  const ids = ['pa', 'pb', 'na', 'nb'];
  const at = [{ xMm: 0, yMm: 0 }, { xMm: 40, yMm: 0 }, { xMm: 0, yMm: 0.3 }, { xMm: 40, yMm: 0.3 }];

  it('finds the lines from the S-matrix and the ends from where the ports sit', () => {
    expect(proposePairs(s, ids, at)).toEqual({ pairs: [
      { id: 'D1', positive: 'pa', negative: 'na' },
      { id: 'D2', positive: 'pb', negative: 'nb' },
    ] });
  });

  it('declines when the port positions do not put the ends side by side', () => {
    const crossed = [{ xMm: 0, yMm: 0 }, { xMm: 40, yMm: 0 }, { xMm: 40, yMm: 0.3 }, { xMm: 0, yMm: 0.3 }];
    // na sits next to pb, nb next to pa: still two ends, paired the other way round.
    expect(proposePairs(s, ids, crossed)).toEqual({ pairs: [
      { id: 'D1', positive: 'pa', negative: 'nb' },
      { id: 'D2', positive: 'pb', negative: 'na' },
    ] });
    expect(proposePairs(s, ids, [at[0], at[0], at[0], at[0]].map((p, n) => ({ ...p, xMm: n * 100 })))).toHaveProperty('reason');
  });

  it('needs an even number of ports, at least four', () => {
    expect(proposePairs({ ...s, re: s.re.slice(0, 3), im: s.im.slice(0, 3) }, ids.slice(0, 3), at.slice(0, 3))).toHaveProperty('reason');
  });
});

describe('input checks', () => {
  const s = coupledLine(band(10, 0.1), 50, 60, 45, 3.4, 2.9, 40);
  it('refuses a port in two pairs, a missing column, or mismatched line references', () => {
    expect(() => mixedModeScattering(s, [50, 50, 50, 50], [{ id: 'D1', positive: 0, negative: 1 }, { id: 'D2', positive: 1, negative: 3 }])).toThrow(/exactly one pair/);
    expect(() => mixedModeScattering({ ...s, re: s.re.map((r) => [...r.slice(0, 3), null]) }, [50, 50, 50, 50], PAIRS)).toThrow(/every port excited/);
    expect(() => mixedModeScattering(s, [50, 45, 50, 50], PAIRS)).toThrow(/same reference impedance/);
    expect(() => mixedModeScattering(s, [50, 50, 50, 50], [{ ...PAIRS[0], differentialOhm: 0 }, PAIRS[1]])).toThrow(/above 0/);
  });
});

describe('skew from mode conversion beyond a quarter turn', () => {
  it('stays unwrapped for a 40 ps skew on a 10 GHz band', () => {
    const f = band(200, 0.05);
    const lengths = [30, 30 + (0.04 * C_MM_PER_NS) / Math.sqrt(3)];
    const s = fourPort(f, (i, j, x) => {
      if (i % 2 !== j % 2) return [0, 0];
      const line = lineS(50, 50, 3, lengths[i % 2], x);
      return (i < 2) === (j < 2) ? line.s11 : line.s21;
    });
    const [through] = analyseDifferential(s, [50, 50, 50, 50], PAIRS).throughs;
    expect(through.timing!.skewPs).toBeCloseTo(-40, 0);
    expect(through.skewFromConversionPs!.min).toBeCloseTo(-40, 3);
    expect(through.skewFromConversionPs!.max).toBeCloseTo(-40, 3);
  });
});
