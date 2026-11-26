import { C0, ETA0 } from './config';
import { VALUES_PER_SAMPLE_FREQUENCY, type HuygensSurface } from './huygens_box';
import { portPhasors } from './port_dft';
import { sourceParams, sourceValue } from './source';
import type { ExcitationConfig, PortSamples } from './types';

/**
 * Near-to-far-field transform over the closed Huygens box (Taflove & Hagness
 * ch. 8, Balanis ch. 12), from the box DFTs of huygens_box.ts.
 *
 * Equivalent currents on the box, n the outward normal:
 *   J = n x H,  M = -n x E
 * Radiation vectors, for e^{+j w t} phasors (the DFT uses exp(-j w t)):
 *   N = sum J exp(+j k r_hat . r') dA,  L = sum M exp(+j k r_hat . r') dA
 * Far field, dropping exp(-j k r) / r:
 *   r E_theta = -j k / (4 pi) (L_phi + eta0 N_theta)
 *   r E_phi   = +j k / (4 pi) (L_theta - eta0 N_phi)
 *   U = |r E|^2 / (2 eta0)
 *
 * Every phasor (box fields, port V and I) is divided by the DFT of the source
 * voltage at the same frequency, so the results are those of a 1 V peak
 * sinusoidal source behind the port's reference resistance, in volts and
 * watts. The transform does not need that, but it gives the powers real units.
 *
 * Radiated power is the box's Poynting flux, 1/2 Re sum (E x H*) . n dA;
 * directivity is 4 pi U / P_rad. The integral of U over the sphere is
 * reported beside it: the two agree when the transform and the box sampling
 * are consistent. Accepted power is 1/2 Re(V I*) at the port; for a lossless
 * model, efficiency = P_rad / P_acc should be close to 1, which checks the
 * whole chain (port, box DFT, flux). Gain = 4 pi U / P_acc and realised gain
 * = gain (1 - |S11|^2).
 */

export interface FarFieldAngles {
  /** theta from 0 to 180 degrees, inclusive. */
  thetaSteps: number;
  /** phi from 0 to 360 degrees, exclusive. */
  phiSteps: number;
}

/** 5 degree steps. */
export const DEFAULT_FAR_FIELD_ANGLES: FarFieldAngles = { thetaSteps: 37, phiSteps: 72 };

/** Directivity floor in the pattern, so nulls stay finite in JSON. */
const PATTERN_FLOOR_DBI = -100;

export interface FarFieldResult {
  frequencyHz: number;
  thetaDeg: Float64Array;
  phiDeg: Float64Array;
  /** Pattern values at [thetaIndex * phiSteps + phiIndex]. */
  directivityDbi: Float64Array;
  /** r E_theta and r E_phi (volts) for a 1 V source, without exp(-j k r). */
  rEThetaRe: Float64Array;
  rEThetaIm: Float64Array;
  rEPhiRe: Float64Array;
  rEPhiIm: Float64Array;
  /** Watts for a 1 V peak source: box Poynting flux. */
  radiatedPowerW: number;
  /** Watts: integral of U over the sphere (a consistency check on radiatedPowerW). */
  sphereIntegralPowerW: number;
  /** Watts: 1/2 Re(V I*) at the port; for an array, summed over every port. */
  acceptedPowerW: number;
  /** radiatedPowerW / acceptedPowerW. */
  efficiency: number;
  /** Accepted over available power: 1 - |S11|^2 for one port; for an array, 1 - the reflected and coupled share of the incident power. */
  mismatchFactor: number;
  peakDirectivityDbi: number;
  peakThetaDeg: number;
  peakPhiDeg: number;
  peakGainDbi: number;
  peakRealisedGainDbi: number;
}

export type Complex = [re: number, im: number];

const divide = ([ar, ai]: Complex, [br, bi]: Complex): Complex => {
  const den = br * br + bi * bi;
  return [(ar * br + ai * bi) / den, (ai * br - ar * bi) / den];
};

/** DFT of the port source voltage over the run, sampled as the solvers apply it, at (n + 1/2) dt. */
export function sourcePhasor(exc: ExcitationConfig, dtSec: number, steps: number, frequencyHz: number): Complex {
  const params = sourceParams(exc);
  const omegaDt = 2 * Math.PI * frequencyHz * dtSec;
  let re = 0, im = 0;
  for (let n = 0; n < steps; n++) {
    const vs = sourceValue(params, (n + 0.5) * dtSec);
    re += vs * Math.cos(omegaDt * (n + 0.5));
    im -= vs * Math.sin(omegaDt * (n + 0.5));
  }
  return [re, im];
}

export interface NearToFarInput {
  surface: HuygensSurface;
  /** Box DFTs in the layout of huygens_box.ts, for all `frequenciesHz`. */
  accumulators: ArrayLike<number>;
  frequenciesHz: readonly number[];
  /** The run's port samples (V, I) and its excitation. */
  samples: Pick<PortSamples, 'v' | 'i' | 'dtSec'>;
  exc: ExcitationConfig;
  angles?: FarFieldAngles;
}

/** The far field at every frequency of the box DFT. */
export function nearToFarField(input: NearToFarInput): FarFieldResult[] {
  const expected = input.surface.count * input.frequenciesHz.length * VALUES_PER_SAMPLE_FREQUENCY;
  if (input.accumulators.length !== expected) {
    throw new Error(`nearToFarField: ${input.accumulators.length} accumulator values, expected ${expected}`);
  }
  return input.frequenciesHz.map((_, f) => farFieldAtFrequency(input, f));
}

export interface EquivalentCurrents {
  /** J = n x H and M = -n x E per patch, area included (A m and V m), as complex 3-vectors [xRe, xIm, yRe, yIm, zRe, zIm]. */
  currentJ: Float64Array;
  currentM: Float64Array;
  /** Watts: the box's Poynting flux, 1/2 Re sum (E x H*) . n dA. */
  radiatedPowerW: number;
}

/**
 * The equivalent currents on every patch of the box at one frequency, for a
 * 1 V source: the box DFTs divided by `source` (the source voltage's DFT).
 * Shared by the far-field transform here and the near-field one (near_field.ts).
 */
export function equivalentCurrents(
  surface: HuygensSurface, accumulators: ArrayLike<number>, frequencyIndex: number, frequencyCount: number, source: Complex,
): EquivalentCurrents {
  const count = surface.count;
  const currentJ = new Float64Array(6 * count);
  const currentM = new Float64Array(6 * count);
  let radiatedPowerW = 0;
  for (let s = 0; s < count; s++) {
    const base = (s * frequencyCount + frequencyIndex) * VALUES_PER_SAMPLE_FREQUENCY;
    const phasor = (n: number, scale: number): Complex => {
      const [re, im] = divide([accumulators[base + 2 * n], accumulators[base + 2 * n + 1]], source);
      return [re / scale, im / scale];
    };
    const ep = phasor(0, surface.fieldScaleM);
    const eq = phasor(1, surface.fieldScaleM);
    const hp = phasor(2, ETA0 * surface.fieldScaleM);
    const hq = phasor(3, ETA0 * surface.fieldScaleM);
    const area = surface.lengthPM[s] * surface.lengthQM[s];
    const sign = surface.outwardSign[s];
    const a = surface.normalAxis[s];
    const p = (a + 1) % 3;
    const q = (a + 2) % 3;
    // n x p_hat = q_hat, n x q_hat = -p_hat (n = sign a_hat), so
    // J = sign (H_p q_hat - H_q p_hat) and M = -sign (E_p q_hat - E_q p_hat).
    for (let part = 0; part < 2; part++) {
      currentJ[6 * s + 2 * q + part] = sign * hp[part] * area;
      currentJ[6 * s + 2 * p + part] = -sign * hq[part] * area;
      currentM[6 * s + 2 * q + part] = -sign * ep[part] * area;
      currentM[6 * s + 2 * p + part] = sign * eq[part] * area;
    }
    // (E x H*) . a_hat = E_p H_q* - E_q H_p*
    radiatedPowerW += 0.5 * sign * area * (ep[0] * hq[0] + ep[1] * hq[1] - (eq[0] * hp[0] + eq[1] * hp[1]));
  }
  return { currentJ, currentM, radiatedPowerW };
}

function farFieldAtFrequency(input: NearToFarInput, frequencyIndex: number): FarFieldResult {
  const { surface, accumulators, samples, exc } = input;
  const frequencyHz = input.frequenciesHz[frequencyIndex];
  const source = sourcePhasor(exc, samples.dtSec, samples.v.length, frequencyHz);
  if (!(Math.hypot(...source) > 0)) throw new Error(`the source has no content at ${frequencyHz / 1e9} GHz`);
  const currents = equivalentCurrents(surface, accumulators, frequencyIndex, input.frequenciesHz.length, source);

  const port = portPhasors(samples, frequencyHz);
  const v = divide(port.v, source);
  const i = divide(port.i, source);
  const acceptedPowerW = 0.5 * (v[0] * i[0] + v[1] * i[1]);
  const [zRe, zIm] = divide(port.v, port.i);
  const z0 = exc.z0;
  const reflected = ((zRe - z0) ** 2 + zIm ** 2) / ((zRe + z0) ** 2 + zIm ** 2);
  const fields = radiationPattern(surface, currents, frequencyHz, input.angles);
  return patternResult(fields, { radiatedPowerW: currents.radiatedPowerW, acceptedPowerW, mismatchFactor: 1 - reflected });
}

/** The far field in every direction of the grid, before any power is known: r E for the currents' source. */
export interface PatternFields {
  frequencyHz: number;
  thetaDeg: Float64Array;
  phiDeg: Float64Array;
  /** At [thetaIndex * phiSteps + phiIndex], in volts, without exp(-j k r). */
  rEThetaRe: Float64Array;
  rEThetaIm: Float64Array;
  rEPhiRe: Float64Array;
  rEPhiIm: Float64Array;
}

/** r E_theta and r E_phi radiated by the box currents, on the theta/phi grid of `angles`. */
export function radiationPattern(
  surface: HuygensSurface, currents: Pick<EquivalentCurrents, 'currentJ' | 'currentM'>, frequencyHz: number, angles = DEFAULT_FAR_FIELD_ANGLES,
): PatternFields {
  const { thetaSteps, phiSteps } = angles;
  const { currentJ, currentM } = currents;
  const k = (2 * Math.PI * frequencyHz) / C0;
  const count = surface.count;
  const directions = thetaSteps * phiSteps;
  const thetaDeg = Float64Array.from({ length: thetaSteps }, (_, t) => (180 * t) / (thetaSteps - 1));
  const phiDeg = Float64Array.from({ length: phiSteps }, (_, p) => (360 * p) / phiSteps);
  const rEThetaRe = new Float64Array(directions);
  const rEThetaIm = new Float64Array(directions);
  const rEPhiRe = new Float64Array(directions);
  const rEPhiIm = new Float64Array(directions);
  const radiation = new Float64Array(12); // N then L, complex x, y, z
  const centre = surface.centreM;
  for (let t = 0; t < thetaSteps; t++) {
    const theta = (thetaDeg[t] * Math.PI) / 180;
    const [sinT, cosT] = [Math.sin(theta), Math.cos(theta)];
    for (let ph = 0; ph < phiSteps; ph++) {
      const phi = (phiDeg[ph] * Math.PI) / 180;
      const [sinP, cosP] = [Math.sin(phi), Math.cos(phi)];
      const [kx, ky, kz] = [k * sinT * cosP, k * sinT * sinP, k * cosT];
      radiation.fill(0);
      for (let s = 0; s < count; s++) {
        const phase = kx * centre[3 * s] + ky * centre[3 * s + 1] + kz * centre[3 * s + 2];
        const [c, sn] = [Math.cos(phase), Math.sin(phase)];
        for (let axis = 0; axis < 3; axis++) {
          const jr = currentJ[6 * s + 2 * axis], ji = currentJ[6 * s + 2 * axis + 1];
          const mr = currentM[6 * s + 2 * axis], mi = currentM[6 * s + 2 * axis + 1];
          radiation[2 * axis] += jr * c - ji * sn;
          radiation[2 * axis + 1] += jr * sn + ji * c;
          radiation[6 + 2 * axis] += mr * c - mi * sn;
          radiation[6 + 2 * axis + 1] += mr * sn + mi * c;
        }
      }
      // theta_hat = (cosT cosP, cosT sinP, -sinT), phi_hat = (-sinP, cosP, 0)
      const project = (offset: number, part: number) => {
        const [x, y, z] = [radiation[offset + part], radiation[offset + 2 + part], radiation[offset + 4 + part]];
        return [cosT * cosP * x + cosT * sinP * y - sinT * z, -sinP * x + cosP * y];
      };
      const [nThetaRe, nPhiRe] = project(0, 0);
      const [nThetaIm, nPhiIm] = project(0, 1);
      const [lThetaRe, lPhiRe] = project(6, 0);
      const [lThetaIm, lPhiIm] = project(6, 1);
      const aRe = lPhiRe + ETA0 * nThetaRe, aIm = lPhiIm + ETA0 * nThetaIm;
      const bRe = lThetaRe - ETA0 * nPhiRe, bIm = lThetaIm - ETA0 * nPhiIm;
      const scale = k / (4 * Math.PI);
      const d = t * phiSteps + ph;
      // -j scale A and +j scale B
      rEThetaRe[d] = scale * aIm;
      rEThetaIm[d] = -scale * aRe;
      rEPhiRe[d] = -scale * bIm;
      rEPhiIm[d] = scale * bRe;
    }
  }
  return { frequencyHz, thetaDeg, phiDeg, rEThetaRe, rEThetaIm, rEPhiRe, rEPhiIm };
}

/** The powers a pattern is scaled by: radiated (box flux), accepted (at the ports), and accepted over available. */
export interface PatternPowers {
  radiatedPowerW: number;
  acceptedPowerW: number;
  mismatchFactor: number;
}

/**
 * Energy decay (dB) at which the radiation efficiency is good to about
 * ±0.5 % (docs/project-file.md, Far field; validation/openems/array). Below
 * it, efficiency and gain can be off by percents on a poorly matched antenna.
 */
export const EFFICIENCY_ENERGY_DECAY_DB = 70;

/** Directivity, gain and their peaks from the far field and the powers behind it. */
export function patternResult(fields: PatternFields, powers: PatternPowers): FarFieldResult {
  const { frequencyHz, thetaDeg, phiDeg, rEThetaRe, rEThetaIm, rEPhiRe, rEPhiIm } = fields;
  const { radiatedPowerW, acceptedPowerW, mismatchFactor } = powers;
  if (!(radiatedPowerW > 0)) throw new Error(`no power leaves the Huygens box at ${frequencyHz / 1e9} GHz (flux ${radiatedPowerW} W)`);
  if (!(acceptedPowerW > 0)) throw new Error(`the ports accept no power at ${frequencyHz / 1e9} GHz (${acceptedPowerW} W)`);
  const [thetaSteps, phiSteps] = [thetaDeg.length, phiDeg.length];
  const directions = thetaSteps * phiSteps;
  const intensity = new Float64Array(directions);
  for (let d = 0; d < directions; d++) intensity[d] = (rEThetaRe[d] ** 2 + rEThetaIm[d] ** 2 + rEPhiRe[d] ** 2 + rEPhiIm[d] ** 2) / (2 * ETA0);

  const dTheta = Math.PI / (thetaSteps - 1);
  const dPhi = (2 * Math.PI) / phiSteps;
  let sphereIntegralPowerW = 0;
  for (let t = 0; t < thetaSteps; t++) {
    const weight = (t === 0 || t === thetaSteps - 1 ? 0.5 : 1) * Math.sin((thetaDeg[t] * Math.PI) / 180) * dTheta * dPhi;
    for (let ph = 0; ph < phiSteps; ph++) sphereIntegralPowerW += weight * intensity[t * phiSteps + ph];
  }

  const directivityDbi = new Float64Array(directions);
  let peak = 0;
  for (let d = 0; d < directions; d++) {
    directivityDbi[d] = Math.max(PATTERN_FLOOR_DBI, 10 * Math.log10((4 * Math.PI * intensity[d]) / radiatedPowerW));
    // At theta = 0 and 180 every phi is the same direction: only phi = 0 competes, so the peak reads (0, 0), not (0, <noise>).
    const atPole = Math.floor(d / phiSteps) % (thetaSteps - 1) === 0 && d % phiSteps !== 0;
    if (!atPole && intensity[d] > intensity[peak]) peak = d;
  }
  const efficiency = radiatedPowerW / acceptedPowerW;
  const peakGainDbi = 10 * Math.log10((4 * Math.PI * intensity[peak]) / acceptedPowerW);
  return {
    frequencyHz, thetaDeg, phiDeg, directivityDbi, rEThetaRe, rEThetaIm, rEPhiRe, rEPhiIm,
    radiatedPowerW, sphereIntegralPowerW, acceptedPowerW, efficiency, mismatchFactor,
    peakDirectivityDbi: directivityDbi[peak],
    peakThetaDeg: thetaDeg[Math.floor(peak / phiSteps)],
    peakPhiDeg: phiDeg[peak % phiSteps],
    peakGainDbi,
    peakRealisedGainDbi: peakGainDbi + 10 * Math.log10(mismatchFactor),
  };
}
