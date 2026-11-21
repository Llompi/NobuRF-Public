import { describe, expect, it } from 'vitest';
import { assertGeometry, buildOpenHelix, circularComponents, onArm, type OpenHelixGeometry } from '../scripts/validate/open_helix_model';

const geometry: OpenHelixGeometry = {
  radiusMm: 19.3, pitchDeg: 10.5, armWidthMm: 14.6, armWrapDeg: 170,
  diskTraceWidthMm: 4, diskThicknessMm: 1.6, diskEpsR: 4.4, diskTanDelta: 0.02, copperConductivitySPerM: null,
};

describe('open helix model', () => {
  it('splits a wave into its circular hands and axial ratio', () => {
    // E = theta - j phi is IEEE right-hand for exp(+j w t) with r = theta x phi.
    const right = circularComponents([1, 0], [0, -1]);
    expect(right.right).toBeCloseTo(Math.SQRT2, 12);
    expect(right.left).toBeCloseTo(0, 12);
    expect(right.axialRatioDb).toBeCloseTo(0, 9);
    const left = circularComponents([1, 0], [0, 1]);
    expect(left.left).toBeCloseTo(Math.SQRT2, 12);
    // Linear: equal hands, minor axis 0, axial ratio infinite.
    const linear = circularComponents([1, 0], [0, 0]);
    expect(linear.right).toBeCloseTo(linear.left, 12);
    expect(linear.axialRatioDb).toBe(Infinity);
    // Elliptical, E_phi half of E_theta in quadrature: axial ratio 2 (6.02 dB).
    expect(circularComponents([1, 0], [0, -0.5]).axialRatioDb).toBeCloseTo(20 * Math.log10(2), 9);
  });

  it('keeps both 180 degree symmetries of the two-dipole helix', () => {
    for (const [x, y, z] of [[19.3, 3, 5], [-10, 16.5, 12], [0, -19.3, -8], [13.6, 13.6, 20]]) {
      const here = onArm(geometry, x, y, z);
      expect(onArm(geometry, x, -y, -z)).toBe(here);
      expect(onArm(geometry, -x, -y, z)).toBe(here);
    }
    // Pitch: one radian past the arm start the lower edge has climbed R tan(alpha) above the disk.
    const start = -2 / 19.3;
    const lower = 0.8 + 19.3 * Math.tan((10.5 * Math.PI) / 180);
    const [px, py] = [19.3 * Math.cos(start + 1), 19.3 * Math.sin(start + 1)];
    expect(onArm(geometry, px, py, lower + 0.05)).toBe(true);
    expect(onArm(geometry, px, py, lower - 0.05)).toBe(false);
    expect(onArm(geometry, px, py, lower + 14.6 / Math.cos((10.5 * Math.PI) / 180) - 0.05)).toBe(true);
    expect(onArm(geometry, px, py, lower + 14.6 / Math.cos((10.5 * Math.PI) / 180) + 0.05)).toBe(false);
    // The arm starts on the top trace's end at phi = 0, just above the disk.
    expect(onArm(geometry, 19.3, 0, 1.0)).toBe(true);
    expect(onArm(geometry, 19.3, 0, 30)).toBe(false);
  });

  it('refuses arms that would overlap the other dipole', () => {
    expect(() => assertGeometry({ ...geometry, armWrapDeg: 180 })).toThrow(/overlap/);
    expect(() => assertGeometry({ ...geometry, radiusMm: 0 })).toThrow(/radiusMm/);
  });

  it('builds a port between the two traces with copper on the cylinder', () => {
    const built = buildOpenHelix(geometry, { cellMm: 2, coarseCellMm: 4, paddingMm: 24, pmlCells: 4, maxGrowth: 1.3 });
    const port = built.model.ports[0];
    expect(built.model.mesh.z[port.k1] - built.model.mesh.z[port.k0]).toBeCloseTo(1.6, 9);
    expect(built.armLengthMm).toBeCloseTo((19.3 * Math.PI * 170) / 180 / Math.cos((10.5 * Math.PI) / 180), 9);
    expect(built.copperFaces).toBeGreaterThan(500);
  });
});
