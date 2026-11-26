import { beforeAll, describe, expect, it } from 'vitest';
import { C0, DEFAULT_GRID, timestepSec } from '../src/engine/config';
import { arrayFarFieldAt, prepareArray, type ElementRun, type PortDrive, type PreparedArray } from '../src/engine/array_far_field';
import { shortDipoleArrayModel, shortDipoleModel } from '../src/engine/dipole_model';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { HuygensDftRecorder, huygensBoxInsidePml, huygensSurface, VALUES_PER_SAMPLE_FREQUENCY, type HuygensSurface } from '../src/engine/huygens_box';
import { equivalentCurrents, nearToFarField, radiationPattern, sourcePhasor, type Complex, type FarFieldResult } from '../src/engine/near_to_far';
import { divide, multiply, portPhasors, scatteringMatrix } from '../src/engine/port_dft';
import type { ExcitationConfig, GridConfig, PortSamples } from '../src/engine/types';
import { directivityAt } from './far_field_helpers';

/**
 * Two parallel short z dipoles half a wavelength apart along x, one port
 * each. A Hertzian dipole's far field is fixed by its current alone, so the
 * pair's pattern for any pair of port currents is known in closed form:
 *   U ~ sin^2(theta) |I1 exp(j k x1 u) + I2 exp(j k x2 u)|^2,  u = sin(theta) cos(phi).
 * The test takes the currents from the solve (they differ from the drives by
 * the coupling) and checks the combined full-wave pattern against that.
 */

const FREQUENCY_HZ = 3e9;
const SPACING_CELLS = 50; // 50 mm at 1 mm cells: half a wavelength at 3 GHz
const grid: GridConfig = { ...DEFAULT_GRID, nx: 40 + SPACING_CELLS, ny: 40, nz: 40, dxMm: 1, groundK: 0, stepsPerRun: 4000 };
const exc: ExcitationConfig = { fMinGHz: 1, fMaxGHz: 5, nFreq: 41, z0: 50 };
const control = { maxSteps: 4000, stopAtEnergyDecayDb: 60, energyCheckEverySteps: 50 };
const columns = [(grid.nx >> 1) - SPACING_CELLS / 2, (grid.nx >> 1) + SPACING_CELLS / 2];
const k = (2 * Math.PI * FREQUENCY_HZ) / C0;
const deg = (x: number) => (x * Math.PI) / 180;
const toDb = (x: number) => 10 * Math.log10(x);

const drive = (amplitude: number, phaseDeg = 0): PortDrive => ({ amplitude, phaseDeg });
/** A drive as a complex source voltage. */
const phasorOf = ({ amplitude, phaseDeg }: PortDrive): Complex => [amplitude * Math.cos(deg(phaseDeg)), amplitude * Math.sin(deg(phaseDeg))];

/** Each port's current with both ports driven at once, straight from the runs: I_k = sum_m (w_m / source_m) I_k,m. */
function portCurrents(runs: ElementRun[], drives: PortDrive[]): Complex[] {
  return [0, 1].map((port) => runs.reduce<Complex>((sum, run, m) => {
    const source = sourcePhasor(exc, run.samples.dtSec, run.samples.v.length, FREQUENCY_HZ);
    const { i } = portPhasors({ ...run.samples.ports[port], dtSec: run.samples.dtSec }, FREQUENCY_HZ);
    const [re, im] = multiply(divide(phasorOf(drives[m]), source), i);
    return [sum[0] + re, sum[1] + im];
  }, [0, 0]));
}

/** Closed-form directivity (linear) of two Hertzian z dipoles at x1, x2 (m) carrying currents i1, i2. */
function pairDirectivity(currents: Complex[], xM: number[]) {
  const intensity = (theta: number, phi: number) => {
    const u = Math.sin(theta) * Math.cos(phi);
    let [re, im] = [0, 0];
    currents.forEach(([ir, ii], n) => {
      const [c, s] = [Math.cos(k * xM[n] * u), Math.sin(k * xM[n] * u)];
      re += ir * c - ii * s;
      im += ir * s + ii * c;
    });
    return Math.sin(theta) ** 2 * (re * re + im * im);
  };
  // Power by quadrature over the sphere: fine enough that its error is far below the tolerances.
  const [nt, np] = [720, 720];
  let power = 0;
  for (let t = 0; t < nt; t++) {
    const theta = ((t + 0.5) * Math.PI) / nt;
    for (let p = 0; p < np; p++) power += intensity(theta, ((p + 0.5) * 2 * Math.PI) / np) * Math.sin(theta) * (Math.PI / nt) * ((2 * Math.PI) / np);
  }
  return (thetaDeg: number, phiDeg: number) => (4 * Math.PI * intensity(deg(thetaDeg), deg(phiDeg))) / power;
}

describe('array far field: two short dipoles half a wavelength apart', () => {
  let array: PreparedArray;
  let runs: PortSamples[];
  let recordedRuns: ElementRun[];
  /** The pair's far field with these drives (null: that port off). */
  const combine = (drives: Array<PortDrive | null>) => arrayFarFieldAt(array, drives, 0).result;
  let xM: number[];
  let isolated: FarFieldResult;
  let surface: HuygensSurface;
  beforeAll(() => {
    const model = shortDipoleArrayModel(grid, 2, exc.z0, columns);
    surface = huygensSurface(model, huygensBoxInsidePml(model));
    const dt = timestepSec(model.grid);
    const solver = new CpuFdtd(model);
    const recorded = [0, 1].map((port) => {
      const recorder = new HuygensDftRecorder(surface, [FREQUENCY_HZ], dt);
      return { port, samples: solver.run(exc, control, recorder, port), accumulators: recorder.accumulators };
    });
    runs = recorded.map((r) => r.samples);
    recordedRuns = recorded;
    array = prepareArray({ surface, frequenciesHz: [FREQUENCY_HZ], runs: recorded, exc, referenceImpedancesOhm: [exc.z0, exc.z0] });
    // Node positions on the mesh: a shift shared by both elements leaves the directivity unchanged, so only the spacing matters.
    xM = columns.map((i) => model.mesh.x[i] / 1e3);

    // One dipole alone, the same size of box around it: the reference the array gain is read against.
    const single = shortDipoleModel({ ...grid, nx: 40 }, 2, exc.z0);
    const singleSurface = huygensSurface(single, huygensBoxInsidePml(single));
    const recorder = new HuygensDftRecorder(singleSurface, [FREQUENCY_HZ], timestepSec(single.grid));
    const samples = new CpuFdtd(single).run(exc, control, recorder);
    isolated = nearToFarField({ surface: singleSurface, accumulators: recorder.accumulators, frequenciesHz: [FREQUENCY_HZ], samples, exc })[0];
  }, 300_000);

  it('rings down in both runs', () => {
    expect(runs.every((r) => r.stoppedOnEnergy)).toBe(true);
  });

  it('reproduces the one-port transform with one port driven', () => {
    const r = combine([drive(1), null]);
    expect(r.ports[1].activeReflection).toBeNull();
    // The other port is only a load: it absorbs what couples to it, which counts against realized gain, not gain.
    expect(r.ports[1].outgoingPowerW).toBeGreaterThan(0);
    const accumulators = recordedRuns[0].accumulators;
    const one = nearToFarField({ surface, accumulators, frequenciesHz: [FREQUENCY_HZ], samples: runs[0], exc })[0];
    expect(r.radiatedPowerW / one.radiatedPowerW).toBeCloseTo(1, 12);
    expect(r.peakDirectivityDbi).toBeCloseTo(one.peakDirectivityDbi, 9);
    let worst = 0;
    for (let d = 0; d < r.directivityDbi.length; d++) worst = Math.max(worst, Math.abs(r.directivityDbi[d] - one.directivityDbi[d]));
    expect(worst).toBeLessThan(1e-9);
    // One-port accepted power is 1/2 Re(V I*) at that port; here it also nets what the load takes.
    expect(r.acceptedPowerW).toBeLessThan(one.acceptedPowerW);
  });

  it('takes the flux of the summed fields, cross terms included', () => {
    const both = combine([drive(1), drive(1)]);
    // The flux of the sum equals the sphere integral of the summed far field.
    expect(Math.abs(both.sphereIntegralPowerW / both.radiatedPowerW - 1)).toBeLessThan(0.01);
  });

  const cases: Array<{ name: string; phaseDeg: number; peakPhiDeg: number[] }> = [
    { name: 'in phase: beam broadside to the pair', phaseDeg: 0, peakPhiDeg: [90, 270] },
    // k d cos(phi) + alpha = 0 with k d = pi: alpha = -90 deg steers to cos(phi) = 1/2.
    { name: 'port 2 lagging 90 deg: beam steered to 60 deg off the pair axis', phaseDeg: -90, peakPhiDeg: [60, 300] },
  ];
  for (const c of cases) {
    describe(c.name, () => {
      let r: ReturnType<typeof combine>;
      let closedForm: (thetaDeg: number, phiDeg: number) => number;
      beforeAll(() => {
        const drives = [drive(1), drive(1, c.phaseDeg)];
        r = combine(drives);
        closedForm = pairDirectivity(portCurrents(recordedRuns, drives), xM);
      });

      it('peaks where the array factor puts the beam', () => {
        expect(r.peakThetaDeg).toBe(90);
        expect(c.peakPhiDeg).toContain(r.peakPhiDeg);
      });

      it('matches the closed-form pattern of two Hertzian dipoles with the solved currents', () => {
        let worst = 0;
        for (const thetaDeg of [30, 60, 90, 120]) {
          for (const phiDeg of [0, 30, 60, 90, 135, 180, 270, 300]) {
            const expected = toDb(closedForm(thetaDeg, phiDeg));
            if (expected < -10) continue; // nulls: dB differences there say nothing
            worst = Math.max(worst, Math.abs(directivityAt(r, thetaDeg, phiDeg) - expected));
          }
        }
        expect(worst).toBeLessThan(0.15);
      });

      it('radiates what the ports accept (lossless)', () => {
        expect(Math.abs(r.efficiency - 1)).toBeLessThan(0.01);
      });
    });
  }

  it('gains about 3.7 dB over one dipole broadside: twice the field, the power raised by the mutual resistance at k d = pi', () => {
    const r = combine([drive(1), drive(1)]);
    // Equal currents, k d = pi: D = 3 / (1 + rho), rho = 1.5 (sin x / x + cos x / x^2 - sin x / x^3) = -0.152.
    const x = k * (xM[1] - xM[0]);
    const rho = 1.5 * (Math.sin(x) / x + Math.cos(x) / x ** 2 - Math.sin(x) / x ** 3);
    expect(Math.abs(r.peakDirectivityDbi - toDb(3 / (1 + rho)))).toBeLessThan(0.15);
    expect(Math.abs(r.peakDirectivityDbi - isolated.peakDirectivityDbi - toDb(2 / (1 + rho)))).toBeLessThan(0.15);
  });

  it('gives each port the active reflection the S-matrix predicts', () => {
    const s = scatteringMatrix(runs.map((samples, n) => ({ activePort: n, samples })), [exc.z0, exc.z0], exc);
    const f = s.fGHz.findIndex((x) => Math.abs(x - FREQUENCY_HZ / 1e9) < 1e-9);
    const drives = [drive(1), drive(1, -90)];
    const weights = drives.map(phasorOf);
    const r = combine(drives);
    for (let i = 0; i < 2; i++) {
      // Gamma_i = sum_j S_ij a_j / a_i, with a proportional to the drive (equal Z0).
      let [nr, ni] = [0, 0];
      for (let j = 0; j < 2; j++) {
        const [sr, si] = [s.re[i][j]![f], s.im[i][j]![f]];
        nr += sr * weights[j][0] - si * weights[j][1];
        ni += sr * weights[j][1] + si * weights[j][0];
      }
      const [ar, ai] = weights[i];
      const den = ar * ar + ai * ai;
      const expected = [(nr * ar + ni * ai) / den, (ni * ar - nr * ai) / den];
      const got = r.ports[i].activeReflection!;
      expect(Math.hypot(got[0] - expected[0], got[1] - expected[1])).toBeLessThan(0.01);
    }
  });

  it('keeps accepted, outgoing and incident power in balance at the ports', () => {
    const drives = [drive(1), drive(Math.SQRT1_2, 45)];
    const weights = drives.map(phasorOf);
    const r = combine(drives);
    const outgoing = r.ports.reduce((sum, p) => sum + p.outgoingPowerW, 0);
    expect(Math.abs(r.acceptedPowerW + outgoing - r.incidentPowerW) / r.incidentPowerW).toBeLessThan(1e-9);
    // The incident waves are the sources' |w|^2 / (8 Z0), up to the lumped port's half-step staggering of V and I.
    const fromDrives = weights.reduce((sum, [re, im]) => sum + (re * re + im * im) / (8 * exc.z0), 0);
    expect(Math.abs(r.incidentPowerW / fromDrives - 1)).toBeLessThan(1e-3);
  });

  it('sums the runs\' own patterns to what one transform of the summed box fields gives', () => {
    const drives = [drive(1), drive(Math.SQRT1_2, 45)];
    const r = combine(drives);
    // The box DFTs summed with each run's drive over its source, then transformed once.
    const summed = new Float64Array(surface.count * VALUES_PER_SAMPLE_FREQUENCY);
    recordedRuns.forEach((run, m) => {
      const [wr, wi] = divide(phasorOf(drives[m]), array.sourcePhasors[0][m]);
      for (let n = 0; n < summed.length; n += 2) {
        summed[n] += wr * run.accumulators[n] - wi * run.accumulators[n + 1];
        summed[n + 1] += wr * run.accumulators[n + 1] + wi * run.accumulators[n];
      }
    });
    const direct = radiationPattern(surface, equivalentCurrents(surface, summed, 0, 1, [1, 0]), FREQUENCY_HZ);
    const largest = Math.max(...direct.rEThetaRe.map(Math.abs), ...direct.rEThetaIm.map(Math.abs), ...direct.rEPhiRe.map(Math.abs), ...direct.rEPhiIm.map(Math.abs));
    for (const key of ['rEThetaRe', 'rEThetaIm', 'rEPhiRe', 'rEPhiIm'] as const) {
      const worst = Math.max(...direct[key].map((value, d) => Math.abs(value - r[key][d])));
      expect(worst / largest).toBeLessThan(1e-9);
    }
  });

  it('refuses a record or drives that do not fit its runs, instead of dropping them', () => {
    const record = { surface, frequenciesHz: [FREQUENCY_HZ], exc, referenceImpedancesOhm: [exc.z0, exc.z0] };
    expect(() => prepareArray({ ...record, runs: [recordedRuns[0], { ...recordedRuns[1], port: 7 }] })).toThrow(/run 1 drives port 7/);
    expect(() => prepareArray({ ...record, runs: [recordedRuns[0], { ...recordedRuns[1], port: 0 }] })).toThrow(/port 0 has more than one run/);
    expect(() => prepareArray({ ...record, runs: recordedRuns, referenceImpedancesOhm: [exc.z0, 0] })).toThrow(/port 1 has reference impedance 0/);
    const onlyFirstPort = prepareArray({ ...record, runs: [recordedRuns[0]] });
    expect(() => arrayFarFieldAt(onlyFirstPort, [drive(1), drive(1, 90)], 0)).toThrow(/port 1 has a drive but no run/);
    expect(() => arrayFarFieldAt(array, [drive(1), drive(1)], 1)).toThrow(/no frequency 1/);
  });
});
