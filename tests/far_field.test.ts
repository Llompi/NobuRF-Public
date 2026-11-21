import { describe, expect, it } from 'vitest';
import { apertureFarField } from '../src/engine/far_field';
import { instantaneousField, planePhasor, phasorMagnitude } from '../src/engine/field_phasor';

describe('planePhasor', () => {
  it('recovers amplitude and phase of a sampled sinusoid', () => {
    const f = 5.8e9;
    const dt = 1e-12 * 12;
    const frames: Float32Array[] = [];
    const times: number[] = [];
    // Two cells: cos(wt) and sin(wt), over a whole number of periods.
    const samples = Math.round((40 / f) / dt);
    for (let n = 0; n < samples; n++) {
      const t = n * dt;
      frames.push(Float32Array.of(Math.cos(2 * Math.PI * f * t), Math.sin(2 * Math.PI * f * t)));
      times.push(t);
    }
    const p = planePhasor(frames, times, f);
    const mag = phasorMagnitude(p);
    expect(mag[1] / mag[0]).toBeCloseTo(1, 2);
    // sin lags cos by 90 degrees: Re{P e^{j0}} is max for the cos cell.
    const now = instantaneousField(p, 0, new Float32Array(2));
    expect(now[0]).toBeGreaterThan(Math.abs(now[1]) * 20);
  });

  it('fails fast on empty input', () => {
    expect(() => planePhasor([], [], 1e9)).toThrow(/no frames/);
  });
});

describe('apertureFarField', () => {
  it('matches 4*pi*A/lambda^2 for a uniform 3-wavelength aperture, beam at broadside', () => {
    const f = 30e9; // lambda = 10 mm
    const nx = 120, ny = 120, dxMm = 0.5;
    const ex = { re: new Float32Array(nx * ny), im: new Float32Array(nx * ny) };
    const ey = { re: new Float32Array(nx * ny), im: new Float32Array(nx * ny) };
    // 60 x 60 cells = 30 mm x 30 mm, uniform Ex.
    for (let j = 30; j < 90; j++) for (let i = 30; i < 90; i++) ex.re[j * nx + i] = 1;
    const pattern = apertureFarField(ex, ey, { nx, ny, dxMm, borderCells: 0 }, f, { thetaSteps: 91, phiSteps: 72 });
    const expected = 10 * Math.log10(4 * Math.PI * 9);
    expect(pattern.peakThetaDeg).toBe(0);
    expect(Math.abs(pattern.peakDbi - expected)).toBeLessThan(0.5);
  });

  it('throws on an empty aperture', () => {
    const z = { re: new Float32Array(16), im: new Float32Array(16) };
    expect(() => apertureFarField(z, z, { nx: 4, ny: 4, dxMm: 1, borderCells: 0 }, 1e9)).toThrow(/no radiated power/);
  });
});
