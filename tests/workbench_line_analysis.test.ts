import { describe, expect, it } from 'vitest';
import type { ScatteringResult } from '../src/engine/port_dft';
import { stepTdr } from '../src/engine/time_domain';
import { lineFromFields } from '../src/workbench/line_analysis';

/** S-parameters of an ideal line section: Z0, eps_eff, loss, length, between zRef ports. */
function idealLine(z0: number, epsEff: number, alphaNpPerMm: number, lengthMm: number, zRef: number, fGHz: number[]): ScatteringResult {
  const g = (z0 - zRef) / (z0 + zRef);
  const n = fGHz.length;
  const s11re = new Float64Array(n), s11im = new Float64Array(n), s21re = new Float64Array(n), s21im = new Float64Array(n);
  fGHz.forEach((f, m) => {
    const beta = (2 * Math.PI * f * Math.sqrt(epsEff)) / 299.792458;
    const mag = Math.exp(-alphaNpPerMm * lengthMm);
    const [pr, pi] = [mag * Math.cos(-beta * lengthMm), mag * Math.sin(-beta * lengthMm)];
    const [p2r, p2i] = [pr * pr - pi * pi, 2 * pr * pi];
    // den = 1 - g^2 P^2
    const [dr, di] = [1 - g * g * p2r, -g * g * p2i];
    const d = dr * dr + di * di;
    const divide = (ar: number, ai: number) => [(ar * dr + ai * di) / d, (ai * dr - ar * di) / d];
    const [a, b] = divide(g * (1 - p2r), -g * p2i);
    const [c, e] = divide(pr * (1 - g * g), pi * (1 - g * g));
    s11re[m] = a; s11im[m] = b; s21re[m] = c; s21im[m] = e;
  });
  return { fGHz: Float64Array.from(fGHz), re: [[s11re, s21re], [s21re, s11re]], im: [[s11im, s21im], [s21im, s11im]], method: 'full', maxPassiveIncidentRatio: 0 };
}

describe('step TDR', () => {
  it('shows a 60 ohm line into a 50 ohm load at 60 ohm, then 50 ohm after the round trip', () => {
    // 30 mm at eps_eff 3: round trip 2 * 30 * sqrt(3) / 299.79 = 0.347 ns.
    const f = Array.from({ length: 400 }, (_, m) => 0.05 + m * 0.05);
    const s = idealLine(60, 3, 0, 30, 50, f);
    const tdr = stepTdr(s.fGHz, s.re[0][0]!, s.im[0][0]!, 50, 1);
    const zAt = (t: number) => tdr.zOhm[tdr.tNs.findIndex((x) => x >= t)];
    expect(zAt(0.17)).toBeCloseTo(60, 0);
    expect(zAt(0.6)).toBeCloseTo(50, 0);
    // About 1.4 / 20 GHz for a Kaiser beta 6 window.
    expect(tdr.riseTimePs).toBeGreaterThan(40);
    expect(tdr.riseTimePs).toBeLessThan(110);
  });
});

describe('line parameters from the fields', () => {
  it('recovers Z0, eps_eff and loss from a standing wave on a graded mesh, beside a ground pour', () => {
    const z0 = 48.5, epsEff = 3.4, alpha = 0.001, f = 5, h = 1.6;
    const xMm = Float64Array.from([-6, -4, -2.5, -1.5, -0.75, 0, 0.75, 1.5, 2.5, 4, 6]);
    const yMm = Float64Array.from({ length: 81 }, (_, k) => -10 + k * 0.25 + (k % 3) * 0.02);
    const nx = xMm.length;
    const gamma: [number, number] = [alpha, (2 * Math.PI * f * Math.sqrt(epsEff)) / 299.792458];
    const ez = { re: new Float32Array(nx * yMm.length), im: new Float32Array(nx * yMm.length) };
    const jy = { re: new Float32Array(nx * yMm.length), im: new Float32Array(nx * yMm.length) };
    const jx = { re: new Float32Array(nx * yMm.length), im: new Float32Array(nx * yMm.length) };
    const eta0 = 376.730313668;
    yMm.forEach((y, k) => {
      // V+ = 1, V- = 0.3 e^{j 0.7}; I = (V+ e^{-gamma y} - V- e^{gamma y}) / Z0.
      const fwd = [Math.exp(-gamma[0] * y) * Math.cos(-gamma[1] * y), Math.exp(-gamma[0] * y) * Math.sin(-gamma[1] * y)];
      const bwdMag = 0.3 * Math.exp(gamma[0] * y);
      const bwd = [bwdMag * Math.cos(gamma[1] * y + 0.7), bwdMag * Math.sin(gamma[1] * y + 0.7)];
      const v = [fwd[0] + bwd[0], fwd[1] + bwd[1]];
      // Normalised units: e = V / h at the centre; the strip current spread over the three middle nodes (dual widths 0.75 each).
      const i = [(fwd[0] - bwd[0]) / z0 * eta0, (fwd[1] - bwd[1]) / z0 * eta0];
      ez.re[5 + nx * k] = v[0] / h;
      ez.im[5 + nx * k] = v[1] / h;
      for (const a of [4, 5, 6]) {
        jy.re[a + nx * k] = i[0] / 2.25;
        jy.im[a + nx * k] = i[1] / 2.25;
      }
      // A top-layer ground pour either side, past a gap, carrying the return current: it must not count.
      for (const a of [0, 1, 9, 10]) {
        jy.re[a + nx * k] = -i[0] / 7;
        jy.im[a + nx * k] = -i[1] / 7;
      }
    });
    const [r] = lineFromFields({ xMm, yMm, substrateMm: h, planes: [{ frequencyGHz: f, ez, jx, jy }], ports: [{ xMm: 0, yMm: -9 }, { xMm: 0, yMm: 9 }] });
    expect(r.z0).toBeCloseTo(z0, 0);
    expect(r.epsEff).toBeCloseTo(epsEff, 1);
    expect(r.lossDbPerMm).toBeCloseTo((alpha * 20) / Math.LN10, 3);
    expect(r.residual).toBeLessThan(0.02);
  });

  it('refuses ports that are not on one straight line', () => {
    const plane = { frequencyGHz: 1, ez: { re: [], im: [] }, jx: { re: [], im: [] }, jy: { re: [], im: [] } };
    expect(() => lineFromFields({ xMm: [0, 1], yMm: [0, 1], substrateMm: 1, planes: [plane], ports: [{ xMm: 0, yMm: 0 }, { xMm: 1, yMm: 5 }] })).toThrow(/parallel to x or y/);
  });
});
