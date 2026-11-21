import { describe, expect, it } from 'vitest';
import { portSpectrum, s11FromZ, S11_FLOOR_DB } from '../src/engine/port_dft';
import type { ExcitationConfig } from '../src/engine/types';

const exc: ExcitationConfig = { fMinGHz: 4, fMaxGHz: 8, nFreq: 41, z0: 50 };
const dt = 1e-12;

function pulse(t: number) {
  const tau = 1e-10, t0 = 4e-10;
  const u = (t - t0) / tau;
  return Math.exp(-u * u) * Math.sin(2 * Math.PI * 6e9 * (t - t0));
}

describe('port DFT', () => {
  it('a matched 50 ohm resistor gives Z = 50 and S11 at the floor', () => {
    const n = 3000;
    const v = new Float32Array(n), i = new Float32Array(n);
    // V sampled at (k+1)dt, I at (k+1/2)dt: build both from the same continuous signal.
    for (let k = 0; k < n; k++) {
      v[k] = pulse((k + 1) * dt);
      i[k] = pulse((k + 0.5) * dt) / 50;
    }
    const s = portSpectrum({ v, i, dtSec: dt }, exc);
    for (let m = 0; m < exc.nFreq; m++) {
      expect(s.zRe[m]).toBeCloseTo(50, 1);
      expect(Math.abs(s.zIm[m])).toBeLessThan(0.1);
      expect(s.s11Db[m]).toBeLessThan(-40);
    }
  });

  it('recovers a pure delay as phase (checks the half-step timing)', () => {
    const n = 3000;
    const delay = 20e-12;
    const v = new Float32Array(n), i = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      v[k] = pulse((k + 1) * dt);
      i[k] = pulse((k + 0.5) * dt - delay) / 100;
    }
    const s = portSpectrum({ v, i, dtSec: dt }, exc);
    for (let m = 0; m < exc.nFreq; m++) {
      const f = s.fGHz[m] * 1e9;
      const mag = Math.hypot(s.zRe[m], s.zIm[m]);
      const ph = Math.atan2(s.zIm[m], s.zRe[m]);
      expect(mag).toBeCloseTo(100, 0);
      expect(ph).toBeCloseTo(2 * Math.PI * f * delay, 2);
    }
  });

  it('s11FromZ edge cases', () => {
    expect(s11FromZ(50, 0, 50)).toBe(S11_FLOOR_DB);
    expect(s11FromZ(Infinity, 0, 50)).toBe(0);
    expect(s11FromZ(0, 0, 50)).toBeCloseTo(0, 6); // short: total reflection
    expect(s11FromZ(150, 0, 50)).toBeCloseTo(20 * Math.log10(0.5), 6);
  });
});
