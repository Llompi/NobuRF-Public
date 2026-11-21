/**
 * What antenna engineers read off a far field (near_to_far.ts): co- and
 * cross-polar directivity, the principal-plane cuts, half-power beamwidth and
 * front-to-back ratio.
 *
 * Co- and cross-polar follow Ludwig's third definition (Ludwig 1973), the one
 * antenna ranges and commercial solvers use. For a reference polarisation
 * along y:
 *   co    = E_theta sin(phi) + E_phi cos(phi)
 *   cross = E_theta cos(phi) - E_phi sin(phi)
 * and along x:
 *   co    = E_theta cos(phi) - E_phi sin(phi)
 *   cross = E_theta sin(phi) + E_phi cos(phi)
 * On boresight co is then exactly E_y (or E_x). Both are |.|^2 shares of the
 * total, so D_co + D_cross = D everywhere.
 */
import type { FarFieldResult } from './near_to_far';

export type PolarisationAxis = 'x' | 'y';

/** The pattern grid and fields of a far-field result; what this module reads. */
export type FarFieldPattern = Pick<FarFieldResult, 'thetaDeg' | 'phiDeg' | 'directivityDbi' | 'rEThetaRe' | 'rEThetaIm' | 'rEPhiRe' | 'rEPhiIm'>;

export const toDb = (linear: number): number => 10 * Math.log10(Math.max(linear, 1e-30));
const fromDb = (db: number): number => 10 ** (db / 10);

/** Co- and cross-polar directivity (linear) at every pattern sample. */
export function polarisedDirectivity(r: FarFieldPattern, axis: PolarisationAxis): { co: Float64Array; cross: Float64Array } {
  const np = r.phiDeg.length;
  const co = new Float64Array(r.directivityDbi.length);
  const cross = new Float64Array(r.directivityDbi.length);
  for (let n = 0; n < co.length; n++) {
    const phi = (r.phiDeg[n % np] * Math.PI) / 180;
    const [s, c] = [Math.sin(phi), Math.cos(phi)];
    const yRe = r.rEThetaRe[n] * s + r.rEPhiRe[n] * c;
    const yIm = r.rEThetaIm[n] * s + r.rEPhiIm[n] * c;
    const xRe = r.rEThetaRe[n] * c - r.rEPhiRe[n] * s;
    const xIm = r.rEThetaIm[n] * c - r.rEPhiIm[n] * s;
    const y2 = yRe * yRe + yIm * yIm;
    const x2 = xRe * xRe + xIm * xIm;
    const total = x2 + y2;
    const d = fromDb(r.directivityDbi[n]);
    const [coShare, crossShare] = total > 0 ? (axis === 'y' ? [y2, x2] : [x2, y2]).map((v) => v / total) : [0, 0];
    co[n] = d * coShare;
    cross[n] = d * crossShare;
  }
  return { co, cross };
}

export interface PlaneCut {
  /** Signed angle from +z, -180 to 180 degrees: positive toward phi, negative toward phi + 180. */
  angleDeg: Float64Array;
  value: Float64Array;
}

/**
 * The cut through the vertical plane at azimuth `phiDeg`, as a pattern plot
 * draws it: theta from -180 to 180, negative angles being the half plane at
 * phi + 180. `perSample` is any per-sample array of the pattern grid. Both
 * phi and phi + 180 must be grid azimuths.
 */
export function planeCut(r: Pick<FarFieldPattern, 'thetaDeg' | 'phiDeg'>, perSample: ArrayLike<number>, phiDeg: number): PlaneCut {
  const np = r.phiDeg.length;
  const nt = r.thetaDeg.length;
  const wrapped = ((phiDeg % 360) + 360) % 360;
  const front = r.phiDeg.findIndex((p) => Math.abs(p - wrapped) < 1e-6);
  const back = r.phiDeg.findIndex((p) => Math.abs(p - ((wrapped + 180) % 360)) < 1e-6);
  if (front < 0 || back < 0) throw new Error(`phi = ${phiDeg} deg and phi + 180 are not both on the far-field grid`);
  if (perSample.length !== nt * np) throw new Error(`planeCut: ${perSample.length} samples, grid has ${nt * np}`);
  const angleDeg = new Float64Array(2 * nt - 1);
  const value = new Float64Array(2 * nt - 1);
  for (let t = 0; t < nt; t++) {
    angleDeg[nt - 1 - t] = -r.thetaDeg[t];
    value[nt - 1 - t] = perSample[t * np + back];
    angleDeg[nt - 1 + t] = r.thetaDeg[t];
    value[nt - 1 + t] = perSample[t * np + front];
  }
  return { angleDeg, value };
}

/**
 * Half-power (-3 dB) beamwidth of a cut of linear power around its maximum,
 * in degrees, by linear interpolation between samples. Null when the cut does
 * not fall to half power on both sides of the maximum within the cut.
 */
export function halfPowerBeamwidthDeg(cut: PlaneCut): number | null {
  const n = cut.value.length;
  let peak = 0;
  for (let i = 1; i < n; i++) if (cut.value[i] > cut.value[peak]) peak = i;
  const half = cut.value[peak] / 2;
  const crossing = (direction: 1 | -1): number | null => {
    for (let i = peak; i + direction >= 0 && i + direction < n; i += direction) {
      const [a, b] = [cut.value[i], cut.value[i + direction]];
      if (b <= half) return cut.angleDeg[i] + ((a - half) / (a - b)) * (cut.angleDeg[i + direction] - cut.angleDeg[i]);
    }
    return null;
  };
  const [low, high] = [crossing(-1), crossing(1)];
  return low === null || high === null ? null : high - low;
}

export interface PatternFigures {
  /** Azimuth of the E-plane (holds the polarisation): 0 for x, 90 for y. */
  ePlanePhiDeg: number;
  hPlanePhiDeg: number;
  beamwidthEPlaneDeg: number | null;
  beamwidthHPlaneDeg: number | null;
  /** Directivity toward theta = 0 over theta = 180, dB. */
  frontToBackDb: number;
  /** Cross-polar level on boresight relative to co-polar, dB. */
  boresightCrossPolarDb: number;
}

/** Datasheet figures for a broadside antenna polarised along `axis` (a patch resonant along that axis). */
export function patternFigures(r: FarFieldPattern, axis: PolarisationAxis): PatternFigures {
  const ePlanePhiDeg = axis === 'x' ? 0 : 90;
  const hPlanePhiDeg = axis === 'x' ? 90 : 0;
  const total = r.directivityDbi.map(fromDb);
  const { co, cross } = polarisedDirectivity(r, axis);
  const last = (r.thetaDeg.length - 1) * r.phiDeg.length;
  return {
    ePlanePhiDeg,
    hPlanePhiDeg,
    beamwidthEPlaneDeg: halfPowerBeamwidthDeg(planeCut(r, total, ePlanePhiDeg)),
    beamwidthHPlaneDeg: halfPowerBeamwidthDeg(planeCut(r, total, hPlanePhiDeg)),
    frontToBackDb: r.directivityDbi[0] - r.directivityDbi[last],
    boresightCrossPolarDb: toDb(cross[0]) - toDb(co[0]),
  };
}

/**
 * The linear polarisation on boresight (+z), x or y, whichever is stronger.
 * At theta = 0, phi = 0 the unit vectors are theta_hat = x and phi_hat = y.
 */
export function boresightPolarisation(r: FarFieldPattern): PolarisationAxis {
  const ex2 = r.rEThetaRe[0] ** 2 + r.rEThetaIm[0] ** 2;
  const ey2 = r.rEPhiRe[0] ** 2 + r.rEPhiIm[0] ** 2;
  return ey2 >= ex2 ? 'y' : 'x';
}
