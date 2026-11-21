import { beforeAll, describe, expect, it } from 'vitest';
import { C0, DEFAULT_GRID, ETA0, timestepSec } from '../src/engine/config';
import { shortDipoleModel } from '../src/engine/dipole_model';
import { CpuFdtd, vacuumModel, type StepRecorder } from '../src/engine/fdtd_cpu';
import { HuygensDftRecorder, huygensBoxInsidePml, huygensSurface, type HuygensSurface } from '../src/engine/huygens_box';
import { boxSources, radiatedField, scanPlane, scanPlanesK, VALUES_PER_POINT, type ScanPlane } from '../src/engine/near_field';
import { nearToFarField, sourcePhasor, type FarFieldResult } from '../src/engine/near_to_far';
import { PlaneDftRecorder } from '../src/engine/plane_dft';
import type { ExcitationConfig, GridConfig, PortSamples } from '../src/engine/types';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { exampleJson } from './project_fixtures';

/**
 * The short z dipole of near_to_far.test.ts (1 mm cells, 2-cell port at the
 * centre of a 40 mm vacuum box), its near field checked three ways:
 *   1. the Huygens-box transform (radiatedField) against the closed form, a
 *      2 mm line of uniform current (the port column) with the moment read
 *      off the far field;
 *   2. the solver's own fields on a z plane (scanPlane) against the same;
 *   3. the transform from a small box against the solver's fields on a plane
 *      outside it, which checks the transform with no formula in between.
 *
 * The closed form is a line of Hertzian elements rather than one: 8 to 10 mm
 * from a 2 mm source the end charges' spread changes the 1/r^3 field by 2 to 3 %.
 */

const grid: GridConfig = { ...DEFAULT_GRID, nx: 40, ny: 40, nz: 40, dxMm: 1, groundK: 0, stepsPerRun: 2000 };
const exc: ExcitationConfig = { fMinGHz: 1, fMaxGHz: 5, nFreq: 41, z0: 50 };
const FREQUENCY_HZ = 3e9;
const K = (2 * Math.PI * FREQUENCY_HZ) / C0;
/** The dipole's centre: node (20, 20, 20), between its two Ez cells. */
const DIPOLE_MM = [20, 20, 20];
/** The scan plane: 10 mm above the dipole, kR from 0.63 straight above to 0.75 at the scan's corners. */
const SCAN_K = 30;
/** The port column's length (m) and the Hertzian elements the closed form splits it into. */
const DIPOLE_LENGTH_M = 2e-3;
const LINE_ELEMENTS = 20;

type Complex = [number, number];
type Vector = [Complex, Complex, Complex];

/**
 * Closed-form fields of a z-directed Hertzian dipole of moment p (A m) at the
 * origin, at the point d (m); e^{+j w t} phasors (Balanis, Antenna Theory, 4.2):
 *   E_r     = eta p cos(t) / (2 pi r^2) (1 + 1/(j k r)) e^{-j k r}
 *   E_theta = j eta k p sin(t) / (4 pi r) (1 + 1/(j k r) - 1/(k r)^2) e^{-j k r}
 *   H_phi   = j k p sin(t) / (4 pi r) (1 + 1/(j k r)) e^{-j k r}
 */
function hertzianDipole(p: Complex, d: number[]): { e: Vector; h: Vector } {
  const r = Math.hypot(d[0], d[1], d[2]);
  const rho = Math.hypot(d[0], d[1]);
  const [cosT, sinT] = [d[2] / r, rho / r];
  const [cosP, sinP] = rho > 0 ? [d[0] / rho, d[1] / rho] : [1, 0];
  const x = K * r;
  const mul = (a: Complex, b: Complex): Complex => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const phase: Complex = [Math.cos(x), -Math.sin(x)];
  const pe = mul(p, phase);
  const er = mul(pe, [(ETA0 * cosT) / (2 * Math.PI * r * r), -(ETA0 * cosT) / (2 * Math.PI * r * r * x)]);
  // j (1 - j/x - 1/x^2) = 1/x + j (1 - 1/x^2)
  const et = mul(pe, [((ETA0 * K * sinT) / (4 * Math.PI * r)) / x, ((ETA0 * K * sinT) / (4 * Math.PI * r)) * (1 - 1 / (x * x))]);
  // j (1 - j/x) = 1/x + j
  const hp = mul(pe, [((K * sinT) / (4 * Math.PI * r)) / x, (K * sinT) / (4 * Math.PI * r)]);
  // r_hat = (sinT cosP, sinT sinP, cosT), theta_hat = (cosT cosP, cosT sinP, -sinT), phi_hat = (-sinP, cosP, 0)
  const combine = (rc: number, tc: number): Complex => [er[0] * rc + et[0] * tc, er[1] * rc + et[1] * tc];
  return {
    e: [combine(sinT * cosP, cosT * cosP), combine(sinT * sinP, cosT * sinP), combine(cosT, -sinT)],
    h: [[-sinP * hp[0], -sinP * hp[1]], [cosP * hp[0], cosP * hp[1]], [0, 0]],
  };
}

/** A z line of uniform current, total moment p, centred at the origin: LINE_ELEMENTS Hertzian dipoles. */
function lineDipole(p: Complex, d: number[]): { e: Vector; h: Vector } {
  const sum = { e: [[0, 0], [0, 0], [0, 0]] as Vector, h: [[0, 0], [0, 0], [0, 0]] as Vector };
  for (let n = 0; n < LINE_ELEMENTS; n++) {
    const z = DIPOLE_LENGTH_M * ((n + 0.5) / LINE_ELEMENTS - 0.5);
    const element = hertzianDipole([p[0] / LINE_ELEMENTS, p[1] / LINE_ELEMENTS], [d[0], d[1], d[2] - z]);
    for (const f of ['e', 'h'] as const) for (let c = 0; c < 3; c++) for (let part = 0; part < 2; part++) sum[f][c][part] += element[f][c][part];
  }
  return sum;
}

const magnitude = (v: Vector) => Math.sqrt(v.reduce((sum, [re, im]) => sum + re * re + im * im, 0));
/** |a - b| / |b| for two complex vectors. */
const relativeError = (a: Vector, b: Vector) => magnitude(a.map(([re, im], c) => [re - b[c][0], im - b[c][1]]) as Vector) / magnitude(b);

const scanVectors = (plane: ScanPlane, node: number): { e: Vector; h: Vector } => ({
  e: (['ex', 'ey', 'ez'] as const).map((c) => [plane[c].re[node], plane[c].im[node]]) as Vector,
  h: (['hx', 'hy', 'hz'] as const).map((c) => [plane[c].re[node], plane[c].im[node]]) as Vector,
});

const pointVectors = (values: Float64Array, n: number): { e: Vector; h: Vector } => {
  const at = (c: number): Complex => [values[VALUES_PER_POINT * n + 2 * c], values[VALUES_PER_POINT * n + 2 * c + 1]];
  return { e: [at(0), at(1), at(2)], h: [at(3), at(4), at(5)] };
};

const both = (recorders: StepRecorder[]): StepRecorder => ({ afterStep: (n, sim) => recorders.forEach((r) => r.afterStep(n, sim)) });

describe('near field of a short z dipole', () => {
  const model = shortDipoleModel(grid, 2, exc.z0);
  const dt = timestepSec(grid);
  const frequenciesHz = [FREQUENCY_HZ];
  const defaultBox = huygensSurface(model, huygensBoxInsidePml(model));
  // 10 mm cube around the dipole: the scan plane is 5 cells above its top face.
  const smallBox = huygensSurface(model, { lo: [15, 15, 15], hi: [25, 25, 25] });
  let samples: PortSamples;
  let plane: ScanPlane;
  let far: FarFieldResult;
  let boxAccumulators: Map<HuygensSurface, Float64Array>;
  /** Dipole moment (A m) for a 1 V source, read off the far field broadside: r E_theta = j eta k p / (4 pi). */
  let moment: Complex;

  beforeAll(() => {
    const huygens = [defaultBox, smallBox].map((surface) => new HuygensDftRecorder(surface, frequenciesHz, dt));
    const planes = new PlaneDftRecorder(grid, scanPlanesK(SCAN_K), frequenciesHz, dt);
    samples = new CpuFdtd(model).run(exc, { maxSteps: 4000, stopAtEnergyDecayDb: 60, energyCheckEverySteps: 50 }, both([...huygens, planes]));
    boxAccumulators = new Map([[defaultBox, huygens[0].accumulators], [smallBox, huygens[1].accumulators]]);
    const source = sourcePhasor(exc, dt, samples.v.length, FREQUENCY_HZ);
    plane = scanPlane({
      accumulators: planes.accumulators, layout: { nx: grid.nx, ny: grid.ny, planesK: scanPlanesK(SCAN_K), frequenciesHz },
      frequencyIndex: 0, k: SCAN_K, mesh: model.mesh, dRefMm: grid.dxMm, dtSec: dt, source,
    });
    far = nearToFarField({ surface: defaultBox, accumulators: huygens[0].accumulators, frequenciesHz, samples, exc })[0];
    // theta = 90, phi = 0 (along +x), where theta_hat = -z. The far field's phase is referred to the box centre,
    // half a cell from the dipole's: r E_theta = j eta k p / (4 pi) exp(j k x_hat . (dipole - box centre)).
    const d = far.thetaDeg.indexOf(90) * far.phiDeg.length;
    const shift = -K * (DIPOLE_MM[0] - defaultBox.centreMm[0]) * 1e-3;
    const rETheta: Complex = [
      far.rEThetaRe[d] * Math.cos(shift) - far.rEThetaIm[d] * Math.sin(shift),
      far.rEThetaRe[d] * Math.sin(shift) + far.rEThetaIm[d] * Math.cos(shift),
    ];
    // p = 4 pi r E_theta / (j eta k)
    const s = (4 * Math.PI) / (ETA0 * K);
    moment = [s * rETheta[1], -s * rETheta[0]];
  }, 120_000);

  it('rings down', () => {
    expect(samples.stoppedOnEnergy).toBe(true);
  });

  it('scan plane 10 mm above (kR 0.63): the solver fields match the closed form within 4 %', () => {
    let worstE = 0, worstH = 0;
    for (let j = 14; j <= 26; j += 2) {
      for (let i = 14; i <= 26; i += 2) {
        const node = i + grid.nx * j;
        const d = [i - DIPOLE_MM[0], j - DIPOLE_MM[1], SCAN_K - DIPOLE_MM[2]].map((v) => v * 1e-3);
        const exact = lineDipole(moment, d);
        const solved = scanVectors(plane, node);
        worstE = Math.max(worstE, relativeError(solved.e, exact.e));
        if (i !== 20 || j !== 20) worstH = Math.max(worstH, relativeError(solved.h, exact.h)); // H is 0 straight above
      }
    }
    // Measured: E 3.4 % straight above, H 2.1 %. Half of the E error is the scan's linear interpolation of
    // Ez from k -/+ 1/2 to k across a 1/z^3 field (+1.5 % at 10 cells); the rest is the Yee grid's own
    // near field 10 cells from the source.
    expect(worstE).toBeLessThan(0.04);
    expect(worstH).toBeLessThan(0.03);
  });

  it('box transform at 20 to 60 mm (kR 1.3 to 3.8), all directions: matches the closed form within 0.5 %', () => {
    const sources = boxSources(defaultBox, boxAccumulators.get(defaultBox)!, frequenciesHz, 0, exc, dt, samples.v.length);
    const directions = [[0, 0, 1], [1, 0, 0], [0, 1, 1], [1, 1, 1], [-1, 2, -1], [1, -1, -2]];
    for (const distanceMm of [20, 30, 60]) {
      const points = directions.flatMap((v) => {
        const len = Math.hypot(v[0], v[1], v[2]);
        return v.map((c, a) => DIPOLE_MM[a] + (distanceMm * c) / len);
      });
      const values = radiatedField(sources, points);
      directions.forEach((v, n) => {
        const d = [0, 1, 2].map((a) => (points[3 * n + a] - DIPOLE_MM[a]) * 1e-3);
        const exact = lineDipole(moment, d);
        const got = pointVectors(values, n);
        expect(relativeError(got.e, exact.e), `E at ${distanceMm} mm along (${v})`).toBeLessThan(0.005);
        if (v[0] !== 0 || v[1] !== 0) expect(relativeError(got.h, exact.h), `H at ${distanceMm} mm along (${v})`).toBeLessThan(0.005);
      });
    }
  });

  it('box transform 5 cells outside a small box: matches the solver on the scan plane within 4 %', () => {
    const sources = boxSources(smallBox, boxAccumulators.get(smallBox)!, frequenciesHz, 0, exc, dt, samples.v.length);
    const nodes: number[] = [];
    const points: number[] = [];
    for (let j = 14; j <= 26; j += 3) for (let i = 14; i <= 26; i += 3) {
      nodes.push(i + grid.nx * j);
      points.push(i, j, SCAN_K);
    }
    const values = radiatedField(sources, points);
    let worstE = 0, worstH = 0;
    nodes.forEach((node, n) => {
      const solved = scanVectors(plane, node);
      const got = pointVectors(values, n);
      worstE = Math.max(worstE, relativeError(got.e, solved.e));
      if (magnitude(solved.h) > 0.1 * magnitude(scanVectors(plane, 14 + grid.nx * 20).h)) worstH = Math.max(worstH, relativeError(got.h, solved.h));
    });
    // Measured: E 2.9 %, H 2.4 %: the same gap as the scan plane's to the closed form (above), and the
    // transform matches the closed form to 0.3 %, so this is the scan plane's error, not the transform's.
    expect(worstE).toBeLessThan(0.04);
    expect(worstH).toBeLessThan(0.03);
  });

  it('box transform at 3 m equals the far field divided by r', () => {
    const sources = boxSources(defaultBox, boxAccumulators.get(defaultBox)!, frequenciesHz, 0, exc, dt, samples.v.length);
    const r = 3000;
    // Broadside along +x: theta 90, phi 0, so E is E_theta (-z).
    const values = radiatedField(sources, [defaultBox.centreMm[0] + r, defaultBox.centreMm[1], defaultBox.centreMm[2]]);
    const got = Math.hypot(values[4], values[5]);
    const d = far.thetaDeg.indexOf(90) * far.phiDeg.length;
    const expected = Math.hypot(far.rEThetaRe[d], far.rEThetaIm[d]) / (r * 1e-3);
    // The 1 / (k r)^2 near-field term is 4e-6 of the total at 3 m and 3 GHz.
    expect(Math.abs(got / expected - 1)).toBeLessThan(1e-3);
  });

  it('refuses a point inside the box', () => {
    const sources = boxSources(defaultBox, boxAccumulators.get(defaultBox)!, frequenciesHz, 0, exc, dt, samples.v.length);
    expect(() => radiatedField(sources, [22, 20, 20])).toThrow(/inside the Huygens box/);
  });
});

describe('scan plane Hz from the curl of E', () => {
  it('equals the solver\'s own Hz for a field with horizontal currents', () => {
    // A vacuum box with soft current sources on three horizontal edges, a zero-mean pulse so no charge stays
    // behind: Hz is far from zero on every plane. E starts at 0, as in a real run, so the DFTs of E and H
    // obey the stepped Faraday's law with no start-up term.
    const model = vacuumModel(grid);
    const sim = new CpuFdtd(model);
    const N = grid.nx * grid.ny * grid.nz;
    const cell = (i: number, j: number, k: number) => i + grid.nx * (j + grid.ny * k);
    const sources: Array<[index: number, amplitude: number]> = [[cell(18, 20, 20), 1], [N + cell(21, 19, 20), 0.5], [cell(20, 23, 21), -0.7]];
    const pulse = (n: number) => ((n - 30) / 8) * Math.exp(-(((n - 30) / 8) ** 2));
    const dt = timestepSec(grid);
    const frequencyHz = 6e9;
    const k = 26;
    const layout = { nx: grid.nx, ny: grid.ny, planesK: scanPlanesK(k), frequenciesHz: [frequencyHz] };
    const planes = new PlaneDftRecorder(grid, layout.planesK, layout.frequenciesHz, dt);
    // The solver's Hz on plane k, at its Yee position (i + 1/2, j + 1/2, k), sampled at (n + 1/2) dt.
    const hzRe = new Float64Array(grid.nx * grid.ny);
    const hzIm = new Float64Array(grid.nx * grid.ny);
    for (let n = 0; n < 600; n++) {
      sim.updateH();
      sim.updateE();
      for (const [index, amplitude] of sources) sim.e[index] += amplitude * pulse(n);
      planes.afterStep(n, sim);
      const phase = 2 * Math.PI * frequencyHz * dt * (n + 0.5);
      for (let c = 0; c < grid.nx * grid.ny; c++) {
        const hz = sim.h[2 * N + k * grid.nx * grid.ny + c];
        hzRe[c] += hz * Math.cos(phase);
        hzIm[c] -= hz * Math.sin(phase);
      }
    }
    const plane = scanPlane({ accumulators: planes.accumulators, layout, frequencyIndex: 0, k, mesh: model.mesh, dRefMm: grid.dxMm, dtSec: dt, source: [1, 0] });
    const toAPerM = 1 / (ETA0 * grid.dxMm * 1e-3);
    let error = 0, total = 0;
    for (let j = 12; j < 28; j++) for (let i = 12; i < 28; i++) {
      const node = i + grid.nx * j;
      // The scan puts Hz on the node: the mean of the four Yee values around it.
      const around = [node - 1 - grid.nx, node - grid.nx, node - 1, node];
      const re = (toAPerM * around.reduce((sum, c) => sum + hzRe[c], 0)) / 4;
      const im = (toAPerM * around.reduce((sum, c) => sum + hzIm[c], 0)) / 4;
      error += (plane.hz.re[node] - re) ** 2 + (plane.hz.im[node] - im) ** 2;
      total += re * re + im * im;
    }
    expect(total).toBeGreaterThan(0);
    // Float32 fields: the curl of E and the stepped Hz agree to rounding.
    expect(Math.sqrt(error / total)).toBeLessThan(1e-4);
  });
});

describe('near field of the example patch (1 mm cells)', () => {
  // The scan plane's fields against the transform from a box closed 5 cells over the copper, on a plane 7 cells
  // above that box. No closed form here: the two routes share only the solver run, so agreement checks the
  // scan (interpolation, Hz from the curl) and the transform's near-zone terms on a real board with all six
  // components non-zero, and the far field from the low box checks against the default one.
  const json = exampleJson();
  json.mesh = { cell: '1 mm', air_margin_cells: { xy: 4, below: 4, above: 24 } };
  const project = parseProject(json);
  const { model } = rasterise(project);
  const a = project.analysis;
  const patchExc: ExcitationConfig = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const frequenciesHz = [5.2e9];
  const dt = timestepSec(model.grid);
  const full = huygensBoxInsidePml(model);
  const lowBox = { lo: full.lo, hi: [full.hi[0], full.hi[1], model.patchK + 5] as [number, number, number] };
  const scanK = lowBox.hi[2] + 7;
  const surfaces = [huygensSurface(model, full), huygensSurface(model, lowBox)];
  let planeValues: ScanPlane;
  let transformed: Float64Array;
  let nodes: number[];
  let farResults: FarFieldResult[];

  beforeAll(() => {
    const huygens = surfaces.map((surface) => new HuygensDftRecorder(surface, frequenciesHz, dt));
    const layout = { nx: model.grid.nx, ny: model.grid.ny, planesK: scanPlanesK(scanK), frequenciesHz };
    const planes = new PlaneDftRecorder(model.grid, layout.planesK, frequenciesHz, dt);
    const run = new CpuFdtd(model).run(patchExc, { maxSteps: 6000, stopAtEnergyDecayDb: 40, energyCheckEverySteps: 100 }, both([...huygens, planes]));
    expect(run.stoppedOnEnergy).toBe(true);
    planeValues = scanPlane({
      accumulators: planes.accumulators, layout, frequencyIndex: 0, k: scanK, mesh: model.mesh, dRefMm: model.grid.dxMm, dtSec: dt,
      source: sourcePhasor(patchExc, dt, run.v.length, frequenciesHz[0]),
    });
    farResults = surfaces.map((surface, n) => nearToFarField({ surface, accumulators: huygens[n].accumulators, frequenciesHz, samples: run, exc: patchExc })[0]);
    // Every other node of the plane inside the box's footprint.
    nodes = [];
    const points: number[] = [];
    for (let j = full.lo[1] + 1; j < full.hi[1]; j += 2) for (let i = full.lo[0] + 1; i < full.hi[0]; i += 2) {
      nodes.push(i + model.grid.nx * j);
      points.push(model.mesh.x[i], model.mesh.y[j], model.mesh.z[scanK]);
    }
    transformed = radiatedField(boxSources(surfaces[1], huygens[1].accumulators, frequenciesHz, 0, patchExc, dt, run.v.length), points);
  }, 180_000);

  it('the transform from the low box reproduces the scan plane: RMS error under 0.3 % of the peak', () => {
    let errorE = 0, errorH = 0, peakE = 0, peakH = 0;
    nodes.forEach((node, n) => {
      const solved = scanVectors(planeValues, node);
      const got = pointVectors(transformed, n);
      const diff = (x: Vector, y: Vector) => magnitude(x.map(([re, im], c) => [re - y[c][0], im - y[c][1]]) as Vector) ** 2;
      errorE += diff(got.e, solved.e);
      errorH += diff(got.h, solved.h);
      peakE = Math.max(peakE, magnitude(solved.e));
      peakH = Math.max(peakH, magnitude(solved.h));
    });
    const rmsE = Math.sqrt(errorE / nodes.length) / peakE;
    const rmsH = Math.sqrt(errorH / nodes.length) / peakH;
    console.log(`patch scan vs transform: RMS error E ${(100 * rmsE).toFixed(2)} %, H ${(100 * rmsH).toFixed(2)} % of the peak`);
    // Measured: 0.10 % and 0.09 %.
    expect(rmsE).toBeLessThan(0.003);
    expect(rmsH).toBeLessThan(0.003);
  });

  it('the low box and the default box give the same far field', () => {
    const [fromFull, fromLow] = farResults;
    expect(Math.abs(fromLow.peakDirectivityDbi - fromFull.peakDirectivityDbi)).toBeLessThan(0.05);
    expect(Math.abs(fromLow.radiatedPowerW / fromFull.radiatedPowerW - 1)).toBeLessThan(0.01);
  });
});
