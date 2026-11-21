import { describe, expect, it } from 'vitest';
import { cavityFrequencyHz, cohnStriplineZ0, ellipticK, yeeCavityFrequencyHz, yeeTemBeta } from '../scripts/selfverify/closed_forms';
import { observedOrderAgainstExact, richardson } from '../scripts/selfverify/measure';
import { seededRng } from '../scripts/selfverify/rng';
import { C0 } from '../src/engine/config';

describe('self-verification closed forms (no solver involved)', () => {
  it('K(k) matches tabulated values', () => {
    expect(ellipticK(0)).toBeCloseTo(Math.PI / 2, 14);
    expect(ellipticK(Math.SQRT1_2)).toBeCloseTo(1.854_074_677_301_372, 13);
    expect(ellipticK(0.9)).toBeCloseTo(2.280_549_138_422_770, 13);
  });

  it("Cohn's stripline Z0 is eta0 / 4 sqrt(eps_r) where k = k' (sinh(pi W / 2b) = 1)", () => {
    const b = 2;
    const w = (2 * b * Math.asinh(1)) / Math.PI;
    expect(cohnStriplineZ0(w, b, 1)).toBeCloseTo(376.730_313_668 / 4, 9);
    expect(cohnStriplineZ0(w, b, 4)).toBeCloseTo(376.730_313_668 / 8, 9);
  });

  it("Cohn's Z0 agrees with Pozar example 3.5 (50 ohm: b 3.2 mm, eps_r 2.2, W 2.66 mm, Pozar's fit good to about 1 %)", () => {
    expect(cohnStriplineZ0(2.66, 3.2, 2.2)).toBeGreaterThan(49);
    expect(cohnStriplineZ0(2.66, 3.2, 2.2)).toBeLessThan(51);
  });

  it("Cohn's Z0 tends to the parallel-plate limit eta0 b / (4 sqrt(eps_r) (W + 2 b ln 2 / pi)) for wide strips", () => {
    const [w, b] = [20, 2];
    const limit = (376.730_313_668 * b) / (4 * (w + (2 * b * Math.LN2) / Math.PI));
    expect(cohnStriplineZ0(w, b, 1) / limit - 1).toBeLessThan(1e-6);
  });

  it('Yee cavity and TEM dispersion tend to the continuum as the cell shrinks', () => {
    const mode = { m: 1, n: 2, p: 1 };
    const sides: [number, number, number] = [0.02, 0.03, 0.01];
    const dx = 1e-5;
    const dt = (0.5 * dx) / C0;
    const yee = yeeCavityFrequencyHz(mode, [2000, 3000, 1000], dx, dt, 2.5);
    expect(yee / cavityFrequencyHz(mode, sides, 2.5) - 1).toBeLessThan(1e-6);
    const f = 5e9;
    expect(yeeTemBeta(f, dx, dt, 2.5) / ((2 * Math.PI * f * Math.sqrt(2.5)) / C0) - 1).toBeLessThan(1e-6);
  });

  it('observed order recovers the exponent of a synthetic error, and Richardson removes a second-order term', () => {
    const levels = [0.4, 0.2, 0.1].map((h) => ({ hMm: h, value: 50 + 3 * h * h }));
    expect(observedOrderAgainstExact(levels, 50, 1e-9).order).toBeCloseTo(2, 10);
    const first = [0.4, 0.2, 0.1].map((h) => ({ hMm: h, value: 50 + 3 * h }));
    expect(observedOrderAgainstExact(first, 50, 1e-9).order).toBeCloseTo(1, 10);
    expect(richardson(levels).extrapolated).toBeCloseTo(50, 10);
  });

  it('seeded streams repeat and forks are independent', () => {
    const a = seededRng('abc');
    const b = seededRng('abc');
    expect(a.uniform(0, 1)).toBe(b.uniform(0, 1));
    expect(seededRng('abc').fork('x').uniform(0, 1)).not.toBe(seededRng('abc').fork('y').uniform(0, 1));
  });
});
