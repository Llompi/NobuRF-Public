import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_GRID, timestepSec } from '../src/engine/config';
import { shortDipoleModel } from '../src/engine/dipole_model';
import { apertureFarField } from '../src/engine/far_field';
import { CpuFdtd, type StepRecorder } from '../src/engine/fdtd_cpu';
import { HuygensDftRecorder, huygensBoxInsidePml, huygensSurface } from '../src/engine/huygens_box';
import { gradedLines } from '../src/engine/mesh';
import { nearToFarField, type FarFieldResult } from '../src/engine/near_to_far';
import { portSpectrum } from '../src/engine/port_dft';
import type { ExcitationConfig, GridConfig } from '../src/engine/types';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { exampleJson } from './project_fixtures';

// The 0.5 mm example patch with a far field: a few minutes on the CPU. Skip with SKIP_SLOW=1.
const slow = process.env.SKIP_SLOW ? it.skip : it;

const HERTZIAN_DIRECTIVITY_DBI = 10 * Math.log10(1.5);
const deg = (x: number) => (x * Math.PI) / 180;
const directivityAt = (r: FarFieldResult, thetaDeg: number, phiDeg: number) =>
  r.directivityDbi[r.thetaDeg.indexOf(thetaDeg) * r.phiDeg.length + r.phiDeg.indexOf(phiDeg)];

/** One CPU run of a model with the Huygens box recording at `frequenciesHz`. */
function dipoleFarField(model: ReturnType<typeof shortDipoleModel>, exc: ExcitationConfig, frequenciesHz: number[]) {
  const surface = huygensSurface(model, huygensBoxInsidePml(model));
  const recorder = new HuygensDftRecorder(surface, frequenciesHz, timestepSec(model.grid));
  const samples = new CpuFdtd(model).run(exc, { maxSteps: 4000, stopAtEnergyDecayDb: 60, energyCheckEverySteps: 50 }, recorder);
  return { surface, samples, results: nearToFarField({ surface, accumulators: recorder.accumulators, frequenciesHz, samples, exc }) };
}

describe('near-to-far-field transform: short z dipole in free space', () => {
  // 1 mm cells, a 2-cell port: 2 mm long, lambda/50 at 3 GHz.
  const grid: GridConfig = { ...DEFAULT_GRID, nx: 40, ny: 40, nz: 40, dxMm: 1, groundK: 0, stepsPerRun: 2000 };
  const exc: ExcitationConfig = { fMinGHz: 1, fMaxGHz: 5, nFreq: 41, z0: 50 };
  const model = shortDipoleModel(grid, 2, exc.z0);
  const frequenciesHz = [2e9, 4e9];
  let stoppedOnEnergy = false;
  let results: FarFieldResult[] = [];
  beforeAll(() => {
    const run = dipoleFarField(model, exc, frequenciesHz);
    stoppedOnEnergy = run.samples.stoppedOnEnergy;
    results = run.results;
  });

  it('rings down well inside the step budget', () => {
    expect(stoppedOnEnergy).toBe(true);
  });

  for (const [n, frequencyHz] of frequenciesHz.entries()) {
    describe(`at ${frequencyHz / 1e9} GHz`, () => {
      let r: FarFieldResult;
      beforeAll(() => {
        r = results[n];
      });

      it('has the Hertzian directivity, 1.76 dBi, broadside', () => {
        expect(Math.abs(r.peakDirectivityDbi - HERTZIAN_DIRECTIVITY_DBI)).toBeLessThan(0.2);
        expect(r.peakThetaDeg).toBe(90);
      });

      it('follows sin^2(theta) and is round in phi', () => {
        for (const thetaDeg of [10, 30, 45, 60, 120, 150, 170]) {
          for (const phiDeg of [0, 45, 90, 225]) {
            const expected = HERTZIAN_DIRECTIVITY_DBI + 10 * Math.log10(Math.sin(deg(thetaDeg)) ** 2);
            expect(Math.abs(directivityAt(r, thetaDeg, phiDeg) - expected)).toBeLessThan(0.1);
          }
        }
        // Along the axis there is a deep null.
        expect(directivityAt(r, 0, 0)).toBeLessThan(-30);
      });

      it('radiates only E_theta', () => {
        let theta = 0, phi = 0;
        for (let d = 0; d < r.directivityDbi.length; d++) {
          theta += r.rEThetaRe[d] ** 2 + r.rEThetaIm[d] ** 2;
          phi += r.rEPhiRe[d] ** 2 + r.rEPhiIm[d] ** 2;
        }
        expect(phi / theta).toBeLessThan(1e-4);
      });

      it('radiates what the port accepts (lossless), and the sphere integral matches the box flux', () => {
        expect(Math.abs(r.efficiency - 1)).toBeLessThan(0.005);
        expect(Math.abs(r.sphereIntegralPowerW / r.radiatedPowerW - 1)).toBeLessThan(0.005);
        // Gain = efficiency * directivity.
        expect(r.peakGainDbi).toBeCloseTo(r.peakDirectivityDbi + 10 * Math.log10(r.efficiency), 9);
        // A 1 V source behind 50 ohm makes at most 1/(8 * 50) W available.
        expect(r.acceptedPowerW).toBeLessThan(1 / (8 * exc.z0));
      });
    });
  }

  it('refuses a box that does not enclose the source', () => {
    const c = grid.nx >> 1;
    expect(() => huygensSurface(model, { lo: [10, 10, 10], hi: [c, 29, 29] })).toThrow(/does not enclose the non-air z edge/);
  });

  it('refuses a model with a bare wall', () => {
    const walled = shortDipoleModel(grid, 2, exc.z0);
    walled.cpml.faces = { ...walled.cpml.faces, zLow: 0 };
    expect(() => huygensBoxInsidePml(walled)).toThrow(/needs a PML on every face/);
  });
});

describe('near-to-far-field transform: short dipole on a graded mesh', () => {
  // 0.5 mm cells within 2 mm of the dipole, growing by up to 1.3x per cell to
  // 4 mm. The default box sits where neighbouring cells differ in width (H is
  // interpolated 0.43 / 0.57 to its faces); a small box in the uniform core
  // is the reference. Without the interpolation weights the default box reads
  // about 1 % low in power and 0.07 dB low in directivity.
  const axis = gradedLines(
    [{ start: -40, end: -2, maxCellMm: 4 }, { start: -2, end: 2, maxCellMm: 0.5 }, { start: 2, end: 40, maxCellMm: 4 }],
    { maxCellMm: 4, maxGrowth: 1.3 },
  );
  const n = axis.length;
  const centre = n >> 1;
  const grid: GridConfig = { ...DEFAULT_GRID, nx: n, ny: n, nz: n, dxMm: 0.5, groundK: 0, stepsPerRun: 4000 };
  const exc: ExcitationConfig = { fMinGHz: 1, fMaxGHz: 5, nFreq: 41, z0: 50 };
  // 2 series cells: longer port columns misreport accepted power on a near-reactive dipole (docs/validation.md 4.4).
  const model = shortDipoleModel(grid, 2, exc.z0, { x: axis, y: axis, z: axis });
  const graded = huygensSurface(model, huygensBoxInsidePml(model));
  const core = huygensSurface(model, { lo: [centre - 3, centre - 3, centre - 3], hi: [centre + 3, centre + 3, centre + 3] });
  let fromGraded: FarFieldResult;
  let fromCore: FarFieldResult;
  beforeAll(() => {
    const frequenciesHz = [3e9];
    const recorders = [graded, core].map((surface) => new HuygensDftRecorder(surface, frequenciesHz, timestepSec(grid)));
    const samples = new CpuFdtd(model).run(exc, { maxSteps: 4000, stopAtEnergyDecayDb: 60, energyCheckEverySteps: 50 }, bothRecorders(recorders[0], recorders[1]));
    expect(samples.stoppedOnEnergy).toBe(true);
    [fromGraded, fromCore] = [graded, core].map((surface, m) =>
      nearToFarField({ surface, accumulators: recorders[m].accumulators, frequenciesHz, samples, exc })[0]);
  }, 120_000);

  it('puts the default box on unequal cells and the reference box on equal ones', () => {
    expect(Array.from(graded.hBelowWeight).some((w) => Math.abs(w - 0.5) > 0.05)).toBe(true);
    expect(Array.from(core.hBelowWeight).every((w) => w === 0.5)).toBe(true);
  });

  it('radiates the same power through both boxes', () => {
    expect(Math.abs(fromGraded.radiatedPowerW / fromCore.radiatedPowerW - 1)).toBeLessThan(1e-3);
    expect(Math.abs(fromGraded.sphereIntegralPowerW / fromGraded.radiatedPowerW - 1)).toBeLessThan(0.005);
  });

  it('radiates what the port accepts: checks the dRef field scale, which the box comparison cannot', () => {
    expect(Math.abs(fromGraded.efficiency - 1)).toBeLessThan(0.03);
  });

  it('keeps the Hertzian pattern, 1.76 dBi', () => {
    expect(Math.abs(fromGraded.peakDirectivityDbi - fromCore.peakDirectivityDbi)).toBeLessThan(0.01);
    expect(Math.abs(fromGraded.peakDirectivityDbi - HERTZIAN_DIRECTIVITY_DBI)).toBeLessThan(0.2);
    for (const thetaDeg of [30, 60, 120, 150]) {
      const expected = HERTZIAN_DIRECTIVITY_DBI + 10 * Math.log10(Math.sin(deg(thetaDeg)) ** 2);
      expect(Math.abs(directivityAt(fromGraded, thetaDeg, 45) - expected)).toBeLessThan(0.15);
    }
  });
});

/** Ex and Ey on one z plane, DFT at one frequency: the input of the aperture method. */
class AperturePlaneRecorder implements StepRecorder {
  readonly ex: { re: Float32Array; im: Float32Array };
  readonly ey: { re: Float32Array; im: Float32Array };
  constructor(private readonly grid: GridConfig, private readonly planeK: number, private readonly omegaDt: number) {
    const plane = grid.nx * grid.ny;
    this.ex = { re: new Float32Array(plane), im: new Float32Array(plane) };
    this.ey = { re: new Float32Array(plane), im: new Float32Array(plane) };
  }

  afterStep(stepIndex: number, sim: CpuFdtd): void {
    const plane = this.grid.nx * this.grid.ny;
    const N = plane * this.grid.nz;
    const [c, s] = [Math.cos(this.omegaDt * (stepIndex + 1)), -Math.sin(this.omegaDt * (stepIndex + 1))];
    for (let cell = 0; cell < plane; cell++) {
      const ex = sim.e[this.planeK * plane + cell];
      const ey = sim.e[N + this.planeK * plane + cell];
      this.ex.re[cell] += ex * c;
      this.ex.im[cell] += ex * s;
      this.ey.re[cell] += ey * c;
      this.ey.im[cell] += ey * s;
    }
  }
}

/** Both recorders in one run. */
const bothRecorders = (a: StepRecorder, b: StepRecorder): StepRecorder => ({
  afterStep: (n, sim) => {
    a.afterStep(n, sim);
    b.afterStep(n, sim);
  },
});

/**
 * Solve a project with the Huygens box and an aperture plane recorded at
 * `frequenciesGHz`; the far field and the aperture pattern at the one
 * nearest the S11 minimum.
 */
function patchFarField(json: Record<string, any>, frequenciesGHz: number[]) {
  const project = parseProject(json);
  const { model } = rasterise(project);
  const a = project.analysis;
  const exc: ExcitationConfig = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: project.ports[0].reference_impedance_ohm };
  const dt = timestepSec(model.grid);
  const surface = huygensSurface(model, huygensBoxInsidePml(model));
  const frequenciesHz = frequenciesGHz.map((f) => f * 1e9);
  const huygens = new HuygensDftRecorder(surface, frequenciesHz, dt);
  // A first, cheap pass would find f0; recording a few apertures is cheaper still, so record one per frequency.
  const apertures = frequenciesHz.map((f) => new AperturePlaneRecorder(model.grid, model.patchK + 1, 2 * Math.PI * f * dt));
  const recorder = apertures.reduce<StepRecorder>((all, r) => bothRecorders(all, r), huygens);
  const control = { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 };
  const samples = new CpuFdtd(model).run(exc, control, recorder);
  const spec = portSpectrum(samples, exc);
  let iMin = 0;
  for (let m = 1; m < spec.s11Db.length; m++) if (spec.s11Db[m] < spec.s11Db[iMin]) iMin = m;
  const f0 = spec.fGHz[iMin];
  let nearest = 0;
  for (let n = 1; n < frequenciesGHz.length; n++) if (Math.abs(frequenciesGHz[n] - f0) < Math.abs(frequenciesGHz[nearest] - f0)) nearest = n;
  const results = nearToFarField({ surface, accumulators: huygens.accumulators, frequenciesHz, samples, exc });
  const g = model.grid;
  const aperture = apertureFarField(apertures[nearest].ex, apertures[nearest].ey,
    { nx: g.nx, ny: g.ny, dxMm: g.dxMm, borderCells: g.pmlCells }, frequenciesHz[nearest]);
  return { samples, f0, result: results[nearest], aperture };
}

/** The example patch with room for the Huygens box and a far field requested. */
function patchWithFarField(): Record<string, any> {
  const json = exampleJson();
  json.mesh.air_margin_cells = { xy: 4, below: 4, above: 25 };
  return json;
}

describe('near-to-far-field transform: patch antenna', () => {
  // f0 is 5.15 GHz on this grid (the substrate snaps to 2 cells, 2 mm).
  it('coarse example patch (1 mm cells): broadside, patch-like directivity, efficiency 1', () => {
    const json = patchWithFarField();
    json.mesh.cell = '1 mm';
    json.mesh.air_margin_cells.above = 8;
    json.analysis.stop = { energy_decay_db: 40, max_steps: 6000 };
    const { samples, f0, result: r, aperture } = patchFarField(json, [5.2]);
    console.log(`coarse patch: f0 ${f0} GHz, steps ${samples.v.length}, D ${r.peakDirectivityDbi.toFixed(2)} dBi at (${r.peakThetaDeg}, ${r.peakPhiDeg}), ` +
      `broadside ${directivityAt(r, 0, 0).toFixed(2)} dBi, aperture ${aperture.peakDbi.toFixed(2)} dBi, efficiency ${r.efficiency.toFixed(4)}, ` +
      `sphere/box ${(r.sphereIntegralPowerW / r.radiatedPowerW).toFixed(4)}`);
    expect(samples.stoppedOnEnergy).toBe(true);
    expect(r.peakThetaDeg).toBeLessThanOrEqual(30);
    expect(r.peakDirectivityDbi).toBeGreaterThan(5);
    expect(r.peakDirectivityDbi).toBeLessThan(9);
    expect(Math.abs(r.efficiency - 1)).toBeLessThan(0.02);
    expect(Math.abs(r.sphereIntegralPowerW / r.radiatedPowerW - 1)).toBeLessThan(0.02);
  }, 60_000);

  slow('example patch (0.5 mm cells): 6-8 dBi broadside, efficiency 1, close to the aperture estimate', () => {
    const { samples, f0, result: r, aperture } = patchFarField(patchWithFarField(), [5.25, 5.35, 5.45]);
    const broadside = directivityAt(r, 0, 0);
    console.log(`example patch: f0 ${f0} GHz, steps ${samples.v.length}, D ${r.peakDirectivityDbi.toFixed(2)} dBi at (${r.peakThetaDeg}, ${r.peakPhiDeg}), ` +
      `broadside ${broadside.toFixed(2)} dBi, aperture ${aperture.peakDbi.toFixed(2)} dBi, efficiency ${r.efficiency.toFixed(4)}, ` +
      `sphere/box ${(r.sphereIntegralPowerW / r.radiatedPowerW).toFixed(4)}`);
    expect(samples.stoppedOnEnergy).toBe(true);
    expect(r.peakThetaDeg).toBeLessThanOrEqual(20);
    expect(r.peakDirectivityDbi).toBeGreaterThan(6);
    expect(r.peakDirectivityDbi).toBeLessThan(8);
    expect(Math.abs(r.efficiency - 1)).toBeLessThan(0.02);
    // The aperture estimate (infinite ground, upper hemisphere only) read 0.25 dB above the transform (Nov 2026).
    expect(Math.abs(broadside - aperture.peakDbi)).toBeLessThan(1);
  }, 900_000);
});
