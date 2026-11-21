import { describe, expect, it } from 'vitest';
import { dbMicroampPerMetre, dbMicrovoltPerMetre, driveScale, FCC_CLASS_A_10M, FCC_CLASS_B_3M, limitAt } from '../src/engine/emc';
import { scanDb, scanWindow } from '../src/workbench/emissions_view';
import type { ScanPlane } from '../src/engine/near_field';

describe('emissions units', () => {
  it('scales a 1 V source behind 50 ohm (2.5 mW available, +3.98 dBm) to the drive', () => {
    expect(driveScale(10 * Math.log10(2.5), 50)).toBeCloseTo(1, 12);
    // 20 dB less power is a tenth of the field.
    expect(driveScale(10 * Math.log10(2.5) - 20, 50)).toBeCloseTo(0.1, 12);
  });

  it('quotes RMS: 1 V/m peak is 0.707 V/m RMS, 117.0 dBµV/m', () => {
    expect(dbMicrovoltPerMetre(Math.SQRT2)).toBeCloseTo(120, 12);
    expect(dbMicrovoltPerMetre(1)).toBeCloseTo(116.99, 2);
    expect(dbMicroampPerMetre(Math.SQRT2 * 1e-6)).toBeCloseTo(0, 12);
  });

  it('reads the FCC 15.109 tables at their band edges', () => {
    expect(limitAt(FCC_CLASS_B_3M, 20)).toBeNull();
    expect(limitAt(FCC_CLASS_B_3M, 30)).toBe(40);
    expect(limitAt(FCC_CLASS_B_3M, 100)).toBe(43.5);
    expect(limitAt(FCC_CLASS_B_3M, 500)).toBe(46);
    expect(limitAt(FCC_CLASS_B_3M, 5800)).toBe(54);
    // 300 µV/m and 500 µV/m in dB(µV/m).
    expect(limitAt(FCC_CLASS_A_10M, 5800)).toBeCloseTo(20 * Math.log10(300), 1);
    expect(limitAt(FCC_CLASS_B_3M, 5800)).toBeCloseTo(20 * Math.log10(500), 1);
  });
});

describe('near-field map values', () => {
  const plane = (): ScanPlane => {
    const c = () => ({ re: new Float32Array(2), im: new Float32Array(2) });
    return { ex: c(), ey: c(), ez: c(), hx: c(), hy: c(), hz: c() };
  };

  it('takes |H| as the root sum of squares of the components\' magnitudes, in dBµA/m RMS', () => {
    const p = plane();
    p.hx.re[0] = 3e-6;
    p.hy.im[0] = 4e-6; // |H| = 5 µA/m peak
    const db = scanDb(p, 'h', 1);
    expect(db[0]).toBeCloseTo(20 * Math.log10(5 / Math.SQRT2), 6);
    expect(scanDb(p, 'hx', 1)[0]).toBeCloseTo(20 * Math.log10(3 / Math.SQRT2), 6);
    // The drive scale multiplies the field: 10x is +20 dB.
    expect(scanDb(p, 'h', 10)[0] - db[0]).toBeCloseTo(20, 9);
    expect(db[1]).toBe(-Infinity);
  });

  it('keeps the scan stencil out of the PML and off the grid edge', () => {
    const lines = Float64Array.from({ length: 30 }, (_, n) => n);
    expect(scanWindow({ xMm: lines, yMm: lines, pml: { xLow: 8, xHigh: 8, yLow: 6, yHigh: 0 } })).toEqual({ i0: 9, i1: 20, j0: 7, j1: 28 });
  });
});
