import { VALUES_PER_SAMPLE_FREQUENCY, type HuygensSurface } from './huygens_box';
import { equivalentCurrents, patternResult, radiationPattern, sourcePhasor, type Complex, type FarFieldAngles, type FarFieldResult, type PatternFields } from './near_to_far';
import type { BoxSources } from './near_field';
import { divide, portPhasors } from './port_dft';
import type { ExcitationConfig, PortSamples } from './types';

/**
 * The far field of a multi-port antenna (an array) driven at every port at
 * once, from one solver run per port.
 *
 * Run m drives port m with a 1 V peak source behind its reference
 * resistance; every other port is that resistance alone, a matched load. The
 * fields of run m are port m's embedded element pattern: the pattern of that
 * element in place, with the currents it induces on its neighbors and the
 * power they absorb. Maxwell's equations are linear and the ports are linear
 * networks, so driving the ports with sources w_m at once gives
 *   fields = sum_m w_m fields_m,
 * exactly, coupling included. Nothing here multiplies an isolated element by
 * an array factor.
 *
 * So at each frequency the box DFTs of the runs, each per volt of its own
 * source, are summed with the drives as weights, and P_rad is the flux of the
 * summed fields, cross terms included. The pattern is linear in the box
 * fields too, so it is the same weighted sum of each run's own pattern
 * (prepareArray transforms each run once), which lets new drives re-sum the
 * patterns instead of transforming the box again. Every port's V and I are
 * summed the same way, and from them:
 *   P_acc = sum_k 1/2 Re(V_k I_k*)
 *   P_inc = sum_k |a_k|^2 / 2,  a_k = (V_k + Z0_k I_k) / (2 sqrt Z0_k)
 * P_inc is the power the sources send in, |w_m|^2 / (8 Z0_m) each up to the
 * lumped port's discretization; reading it from the port waves keeps
 * P_acc = P_inc - sum |b_k|^2 / 2 exact, as 1 - |S11|^2 is for one port.
 * Gain is 4 pi U / P_acc, realized gain 4 pi U / P_inc: the power reflected
 * at a driven port, or coupled out through any port, counts against realized
 * gain only (the convention of commercial full-wave tools). Each port's
 * active reflection coefficient b_k / a_k comes from the same V and I.
 */

/** One run's far-field record: the port it drove and its samples. */
export interface ElementRun {
  /** Index of the driven port in the project's port list. */
  port: number;
  /** Box DFTs of this run, in huygens_box.ts layout. */
  accumulators: ArrayLike<number>;
  samples: Pick<PortSamples, 'v' | 'i' | 'ports' | 'dtSec'>;
}

/** One port's drive: its source's peak amplitude (relative; only ratios matter for gain) and phase. */
export interface PortDrive {
  amplitude: number;
  phaseDeg: number;
}

export interface ArrayFarFieldResult extends FarFieldResult {
  /** Watts: sum of |a|^2 / 2 over the ports, the power the sources send in. */
  incidentPowerW: number;
  /**
   * Per port (project order): its active reflection coefficient b/a, the wave
   * leaving it over the wave its source sends in, with every port driven at
   * once, and that in dB; both null for a port with no drive.
   * `outgoingPowerW` is |b|^2 / 2, the power leaving through that port's
   * reference resistance.
   */
  ports: Array<{ activeReflection: Complex | null; activeReflectionDb: number | null; outgoingPowerW: number }>;
}

/** The far-field record of an array: every run, and every port's reference impedance. */
export interface ArrayRecord {
  surface: HuygensSurface;
  frequenciesHz: readonly number[];
  runs: ElementRun[];
  /** The excitation of every run (its source waveform). */
  exc: ExcitationConfig;
  referenceImpedancesOhm: number[];
  angles?: FarFieldAngles;
}

/**
 * An array record ready for any drives. Per frequency and run: the source's DFT, the pattern per volt of that source and
 * every port's V and I. The runs keep their box DFTs (P_rad needs the summed box) but not their time samples.
 */
export interface PreparedArray {
  surface: HuygensSurface;
  frequenciesHz: readonly number[];
  referenceImpedancesOhm: number[];
  runs: Array<Pick<ElementRun, 'port' | 'accumulators'>>;
  sourcePhasors: Complex[][];
  elementPatterns: PatternFields[][];
  portPhasors: Array<Array<Array<{ v: Complex; i: Complex }>>>;
}

export const isZero = ([re, im]: Complex) => re === 0 && im === 0;

/** A port's drive as a phasor, amplitude at phase; null (off, a load) is zero. */
export function drivePhasor(drive: PortDrive | null): Complex {
  if (!drive) return [0, 0];
  const phase = (drive.phaseDeg * Math.PI) / 180;
  return [drive.amplitude * Math.cos(phase), drive.amplitude * Math.sin(phase)];
}

/** Checks an array record and transforms each run's box once at every frequency (the costly part; arrayFarFieldAt only sums). */
export function prepareArray(record: ArrayRecord): PreparedArray {
  const { surface, frequenciesHz, runs, exc, referenceImpedancesOhm, angles } = record;
  if (runs.length === 0) throw new Error('prepareArray: no runs');
  const frequencyCount = frequenciesHz.length;
  referenceImpedancesOhm.forEach((referenceOhm, k) => {
    if (!(referenceOhm > 0 && Number.isFinite(referenceOhm))) throw new Error(`prepareArray: port ${k} has reference impedance ${referenceOhm} ohm`);
  });
  runs.forEach((run, m) => {
    if (!Number.isInteger(run.port) || run.port < 0 || run.port >= referenceImpedancesOhm.length) throw new Error(`prepareArray: run ${m} drives port ${run.port}, not one of the ${referenceImpedancesOhm.length} ports`);
    if (runs.findIndex((other) => other.port === run.port) !== m) throw new Error(`prepareArray: port ${run.port} has more than one run`);
    const expected = surface.count * frequencyCount * VALUES_PER_SAMPLE_FREQUENCY;
    if (run.accumulators.length !== expected) throw new Error(`prepareArray: run ${m} has ${run.accumulators.length} box DFT values, expected ${expected}`);
    if (run.samples.ports.length !== referenceImpedancesOhm.length) throw new Error(`prepareArray: run ${m} recorded ${run.samples.ports.length} ports, expected ${referenceImpedancesOhm.length}`);
  });
  const sourcePhasors = frequenciesHz.map((frequencyHz) => runs.map((run) => {
    const source = sourcePhasor(exc, run.samples.dtSec, run.samples.v.length, frequencyHz);
    if (!(Math.hypot(...source) > 0)) throw new Error(`the source has no content at ${frequencyHz / 1e9} GHz`);
    return source;
  }));
  const elementPatterns = frequenciesHz.map((frequencyHz, n) => runs.map((run, m) =>
    radiationPattern(surface, equivalentCurrents(surface, run.accumulators, n, frequencyCount, sourcePhasors[n][m]), frequencyHz, angles)));
  const portPhasorsAt = frequenciesHz.map((frequencyHz) => runs.map((run) =>
    run.samples.ports.map((port) => portPhasors({ v: port.v, i: port.i, dtSec: run.samples.dtSec }, frequencyHz))));
  return {
    surface, frequenciesHz, referenceImpedancesOhm, runs: runs.map(({ port, accumulators }) => ({ port, accumulators })),
    sourcePhasors, elementPatterns, portPhasors: portPhasorsAt,
  };
}

/**
 * The array's far field at frequenciesHz[frequencyIndex] with every port
 * driven at once (drives in project port order; null: off, a load), and the
 * box currents behind it (near_field.ts reads them for the field at a finite
 * distance).
 */
export function arrayFarFieldAt(array: PreparedArray, drives: Array<PortDrive | null>, frequencyIndex: number): { result: ArrayFarFieldResult; sources: BoxSources } {
  const { surface, frequenciesHz, runs, referenceImpedancesOhm } = array;
  const frequencyCount = frequenciesHz.length;
  const frequencyHz = frequenciesHz[frequencyIndex];
  if (frequencyHz === undefined) throw new Error(`arrayFarFieldAt: no frequency ${frequencyIndex} (${frequencyCount} solved)`);
  if (drives.length !== referenceImpedancesOhm.length) throw new Error(`arrayFarFieldAt: ${drives.length} drives for ${referenceImpedancesOhm.length} ports`);
  drives.forEach((drive, k) => {
    if (drive && drive.amplitude !== 0 && !runs.some((run) => run.port === k)) throw new Error(`arrayFarFieldAt: port ${k} has a drive but no run to drive it with`);
  });

  // Each run's drive phasor, and its weight per unit of its box DFT: the drive over its own source's DFT.
  const runDrives = runs.map((run) => drivePhasor(drives[run.port]));
  if (runDrives.every(isZero)) throw new Error('arrayFarFieldAt: every port is off; drive at least one');
  const runWeights = runDrives.map((drive, m) => divide(drive, array.sourcePhasors[frequencyIndex][m]));

  // The driven array's box DFT at this frequency, the weighted sum of the runs'.
  const summedBoxDft = new Float64Array(surface.count * VALUES_PER_SAMPLE_FREQUENCY);
  const summedPortV: Complex[] = referenceImpedancesOhm.map(() => [0, 0]);
  const summedPortI: Complex[] = referenceImpedancesOhm.map(() => [0, 0]);
  runs.forEach((run, m) => {
    if (isZero(runWeights[m])) return;
    const [weightRe, weightIm] = runWeights[m];
    for (let s = 0; s < surface.count; s++) {
      const from = (s * frequencyCount + frequencyIndex) * VALUES_PER_SAMPLE_FREQUENCY;
      const to = s * VALUES_PER_SAMPLE_FREQUENCY;
      for (let n = 0; n < VALUES_PER_SAMPLE_FREQUENCY; n += 2) {
        const [re, im] = [run.accumulators[from + n], run.accumulators[from + n + 1]];
        summedBoxDft[to + n] += weightRe * re - weightIm * im;
        summedBoxDft[to + n + 1] += weightRe * im + weightIm * re;
      }
    }
    array.portPhasors[frequencyIndex][m].forEach(({ v, i }, k) => {
      summedPortV[k] = [summedPortV[k][0] + weightRe * v[0] - weightIm * v[1], summedPortV[k][1] + weightRe * v[1] + weightIm * v[0]];
      summedPortI[k] = [summedPortI[k][0] + weightRe * i[0] - weightIm * i[1], summedPortI[k][1] + weightRe * i[1] + weightIm * i[0]];
    });
  });
  // The weights already divide by each run's source, so the sum is per volt of a unit source.
  const currents = equivalentCurrents(surface, summedBoxDft, 0, 1, [1, 0]);
  const fields = summedPatterns(array.elementPatterns[frequencyIndex], runDrives);

  let acceptedPowerW = 0;
  let incidentPowerW = 0;
  const ports = referenceImpedancesOhm.map((referenceOhm, k) => {
    const [vr, vi] = summedPortV[k];
    const [ir, ii] = summedPortI[k];
    acceptedPowerW += 0.5 * (vr * ir + vi * ii);
    // Power waves for a real reference: a = (V + Z0 I) / (2 sqrt Z0), b = (V - Z0 I) / (2 sqrt Z0).
    const root = 2 * Math.sqrt(referenceOhm);
    const a: Complex = [(vr + referenceOhm * ir) / root, (vi + referenceOhm * ii) / root];
    const b: Complex = [(vr - referenceOhm * ir) / root, (vi - referenceOhm * ii) / root];
    incidentPowerW += 0.5 * (a[0] ** 2 + a[1] ** 2);
    const runOfPort = runs.findIndex((run) => run.port === k);
    const activeReflection = runOfPort >= 0 && !isZero(runWeights[runOfPort]) ? divide(b, a) : null;
    return {
      activeReflection,
      activeReflectionDb: activeReflection && 20 * Math.log10(Math.hypot(...activeReflection)),
      outgoingPowerW: 0.5 * (b[0] ** 2 + b[1] ** 2),
    };
  });
  const result = patternResult(fields, { radiatedPowerW: currents.radiatedPowerW, acceptedPowerW, mismatchFactor: acceptedPowerW / incidentPowerW });
  return {
    result: { ...result, incidentPowerW, ports },
    sources: { surface, frequencyHz, currentJ: currents.currentJ, currentM: currents.currentM },
  };
}

/** sum_m drive_m pattern_m: the array's pattern from each run's pattern per volt of its source. */
function summedPatterns(patterns: PatternFields[], runDrives: Complex[]): PatternFields {
  const { frequencyHz, thetaDeg, phiDeg } = patterns[0];
  const directions = patterns[0].rEThetaRe.length;
  const summed = { frequencyHz, thetaDeg, phiDeg, rEThetaRe: new Float64Array(directions), rEThetaIm: new Float64Array(directions), rEPhiRe: new Float64Array(directions), rEPhiIm: new Float64Array(directions) };
  patterns.forEach((pattern, m) => {
    if (isZero(runDrives[m])) return;
    const [driveRe, driveIm] = runDrives[m];
    for (let d = 0; d < directions; d++) {
      summed.rEThetaRe[d] += driveRe * pattern.rEThetaRe[d] - driveIm * pattern.rEThetaIm[d];
      summed.rEThetaIm[d] += driveRe * pattern.rEThetaIm[d] + driveIm * pattern.rEThetaRe[d];
      summed.rEPhiRe[d] += driveRe * pattern.rEPhiRe[d] - driveIm * pattern.rEPhiIm[d];
      summed.rEPhiIm[d] += driveRe * pattern.rEPhiIm[d] + driveIm * pattern.rEPhiRe[d];
    }
  });
  return summed;
}
