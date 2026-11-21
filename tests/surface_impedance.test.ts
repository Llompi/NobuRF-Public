import { describe, expect, it } from 'vitest';
import { applyFaceLoss } from '../src/engine/fdtd_cpu';
import { dualWidth, cellWidth } from '../src/engine/mesh';
import { nnls } from '../src/engine/nnls';
import {
  fitSurfaceShape, roughnessFactor, shapeImpedance, skinDepthM, surfacePoles, type Roughness,
} from '../src/engine/surface_impedance';
import { FACE_STATE_HEADER, faceLossRate, MAX_FACE_STEP_LOSS, sheetFaceLoss, surfaceResistanceOhm, type FaceLoss } from '../src/engine/voxelize';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

const ETA0 = 376.730313668;
const COPPER = 5.8e7;

describe('copper surface impedance across frequency', () => {
  it('nnls solves a small non-negative problem and clamps a negative component', () => {
    // Unconstrained solution of [[1,0],[0,1],[1,1]] x = [1,-1,0] is (1,-1); with x >= 0 it is (0.5, 0).
    expect(nnls([[1, 0], [0, 1], [1, 1]], [1, -1, 0]).map((v) => +v.toFixed(12))).toEqual([0.5, 0]);
    expect(nnls([[2, 0], [0, 4]], [2, 4]).map((v) => +v.toFixed(12))).toEqual([1, 1]);
    // A zero column (it solves to 0 where x is 0) ends instead of cycling, and NaN input is refused.
    expect(nnls([[1, 0], [0, 0]], [1, 0])).toEqual([1, 0]);
    expect(() => nnls([[1, NaN]], [1])).toThrow(/finite/);
    expect(() => nnls([[1]], [NaN])).toThrow(/finite/);
  });

  it('skin depth of copper is 0.87 um at 5.8 GHz and 2.1 um at 1 GHz', () => {
    expect(skinDepthM(COPPER, 5.8e9) * 1e6).toBeCloseTo(0.8677, 3);
    expect(skinDepthM(COPPER, 1e9) * 1e6).toBeCloseTo(2.0898, 3);
  });

  it('roughness factors match their formulas at a skin depth equal to the roughness', () => {
    const f = 1e9;
    const delta = skinDepthM(COPPER, f) * 1e6;
    // Hammerstad: 1 + (2/pi) atan(1.4) at rms = delta. Groisse: 1 + exp(-(1/2)^1.6).
    expect(roughnessFactor({ model: 'hammerstad', rmsUm: delta }, COPPER, f)).toBeCloseTo(1 + (2 / Math.PI) * Math.atan(1.4), 12);
    expect(roughnessFactor({ model: 'groisse', rmsUm: delta }, COPPER, f)).toBeCloseTo(1 + Math.exp(-(0.5 ** 1.6)), 12);
    // Huray, a = delta: 1 + 1.5 SR / (1 + 1 + 1/2).
    expect(roughnessFactor({ model: 'huray', radiusUm: delta, surfaceRatio: 2 }, COPPER, f)).toBeCloseTo(1 + (1.5 * 2) / 2.5, 12);
    // Smooth at low frequency, and Hammerstad and Groisse saturate at 2 when the foil is much rougher than delta.
    for (const model of ['hammerstad', 'groisse'] as const) {
      expect(roughnessFactor({ model, rmsUm: 1 }, COPPER, 1e6)).toBeLessThan(1.01);
      expect(roughnessFactor({ model, rmsUm: 5 }, COPPER, 100e9)).toBeGreaterThan(1.97);
    }
  });

  const BANDS: Array<[number, number]> = [[1e9, 10e9], [4e9, 8e9], [0.05e9, 20e9], [0.1e9, 40e9]];
  const ROUGH: Array<Roughness | null> = [null, { model: 'hammerstad', rmsUm: 1 }, { model: 'groisse', rmsUm: 1 }, { model: 'huray', radiusUm: 0.5, surfaceRatio: 2 }];

  it('fits smooth copper as (1 + j) Rs sqrt(f / fRef) within 1e-4 in R and 0.3 % in X, and rough copper within 1e-3 in R', () => {
    for (const [lo, hi] of BANDS) {
      const poles = surfacePoles(lo, hi);
      for (const r of ROUGH) {
        const fit = fitSurfaceShape(COPPER, r, lo, hi, 5e9, poles);
        expect(fit.resistanceError).toBeLessThan(r ? 1e-3 : 1e-4);
        if (!r) expect(fit.reactanceError).toBeLessThan(3e-3);
        // Passive and causal by construction: every weight is a non-negative R || L branch.
        expect(Math.min(fit.shape.r0, ...fit.shape.weights)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /**
   * The update itself, across a band. A pulse on a 1D Yee line in float32
   * reflects off a copper wall whose face loss is a fitted smooth-copper shape
   * (Rs 2 ohm at 5 GHz, far lossier than copper so the absorbed share is
   * measurable). The share the wall takes, 1 - |R|^2 against a PEC wall,
   * must follow the exact wall of impedance Zs = (1 + j) Rs sqrt(f / 5 GHz),
   *   1 - |(Zs - eta0) / (Zs + eta0)|^2,
   * from 1 to 20 GHz, where a single-frequency Rs is off by sqrt(f / 5 GHz).
   * On 0.1 mm and on 0.5 mm cells (30 per wavelength at 20 GHz): the
   * high-pass terms see h at E's time, or the reactance would read as a loss
   * error of w dt / 2 (2.4 % at 20 GHz on 0.1 mm cells before that was fixed).
   */
  it.each([[1e-4, 2e-3], [5e-4, 1e-2]])('a copper wall absorbs what (1 + j) Rs(f) absorbs, 1 to 20 GHz (%s m cells, within %s)', (dxM, tolerance) => {
    const Sc = 0.99 / Math.sqrt(3);
    const dt = (Sc * dxM) / 299_792_458;
    const n = 1801;
    const wall = n - 1;
    const lines = Float64Array.from({ length: n }, (_, i) => i * 0.1);
    const eScale = Float64Array.from({ length: n }, (_, i) => 0.1 / dualWidth(lines, i));
    const hScale = Float64Array.from({ length: n }, (_, i) => 0.1 / cellWidth(lines, i));
    const [fMin, fMax, fRef, rsRef] = [1e9, 20e9, 5e9, 2];
    const poles = surfacePoles(fMin, fMax);
    const { shape } = fitSurfaceShape(COPPER, null, fMin, fMax, fRef, poles);
    // The per-face numbers of sheetFaceLoss (voxelize.ts) for one face, written out here; the next test checks their layout.
    const scale = hScale[wall - 1];
    const faces: FaceLoss = {
      hIndex: Uint32Array.of(wall - 1),
      rate: Float32Array.of(faceLossRate(Sc, scale, rsRef * shape.r0)),
      terms: poles.cornerHz.length,
      weight: Float32Array.from(shape.weights, (w) => (Sc * scale * rsRef * w) / ETA0),
      lowPass: Float32Array.from(poles.cornerHz.flatMap((f) => { const r = Math.PI * f * dt; return [(1 - r) / (1 + r), r / (1 + r)]; })),
    };
    const record = (lossy: boolean) => {
      const e = new Float32Array(n);
      const h = new Float32Array(n);
      const carry = new Float32Array(1);
      const state = new Float32Array(FACE_STATE_HEADER + faces.terms);
      const out: number[] = [];
      for (let t = 0; t < 40000; t++) {
        if (lossy) applyFaceLoss(h, faces, carry, state);
        for (let i = 0; i < n - 1; i++) h[i] -= Sc * (e[i + 1] - e[i]) * hScale[i];
        const e1 = e[1];
        for (let i = 1; i < wall; i++) e[i] -= Sc * (h[i] - h[i - 1]) * eScale[i];
        // First-order Mur absorber at the left end, so the record can run long: the wall's low-frequency
        // reflection keeps arriving for several time constants of its slowest term (1 / (2 pi 100 MHz), 8000 steps).
        e[0] = e1 + ((Sc - 1) / (Sc + 1)) * (e[1] - e[0]);
        e[1000] += Math.exp(-(((t - 300) / 40) ** 2));
        // The incident pulse has passed the probe by step 1600; after it only the wall's reflection does.
        if (t >= 1600) out.push(e[1200]);
      }
      return out;
    };
    const dft = (x: number[], f: number) => x.reduce(([re, im], v, k) => [re + v * Math.cos(2 * Math.PI * f * k * dt), im - v * Math.sin(2 * Math.PI * f * k * dt)], [0, 0]);
    const pec = record(false);
    const copper = record(true);
    for (const f of [1e9, 2e9, 5e9, 10e9, 20e9]) {
      const [a, b] = [dft(copper, f), dft(pec, f)];
      const absorbed = 1 - (a[0] ** 2 + a[1] ** 2) / (b[0] ** 2 + b[1] ** 2);
      const rs = rsRef * Math.sqrt(f / fRef);
      // |(Zs - eta0) / (Zs + eta0)|^2 with Zs = rs (1 + j).
      const exact = 1 - ((rs - ETA0) ** 2 + rs ** 2) / ((rs + ETA0) ** 2 + rs ** 2);
      expect(Math.abs(absorbed / exact - 1)).toBeLessThan(tolerance);
    }
  });

  /**
   * The bound sheetFaceLoss enforces. At the grid's Nyquist frequency a step
   * multiplies h by 1 - (rate + 2 sum weight): a wall at MAX_FACE_STEP_LOSS
   * stays bounded over 20000 steps of a pulse rich in Nyquist content, and
   * one at 2.2 times it (just past 2) grows without limit.
   */
  it('a face at MAX_FACE_STEP_LOSS is stable on a 1D line, and one just past twice it is not', () => {
    const Sc = 0.99 / Math.sqrt(3);
    const dt = (Sc * 1e-4) / 299_792_458;
    const n = 400;
    const wall = n - 1;
    const poles = surfacePoles(1e9, 20e9);
    const { shape } = fitSurfaceShape(COPPER, null, 1e9, 20e9, 5e9, poles);
    const run = (stepLoss: number) => {
      // Rs chosen so that rate + 2 sum weight is stepLoss.
      const perOhm = (Sc * (shape.r0 + 2 * shape.weights.reduce((a, b) => a + b, 0))) / ETA0;
      const rs = stepLoss / perOhm;
      const faces: FaceLoss = {
        hIndex: Uint32Array.of(wall - 1),
        rate: Float32Array.of(faceLossRate(Sc, 1, rs * shape.r0)),
        terms: poles.cornerHz.length,
        weight: Float32Array.from(shape.weights, (w) => (Sc * rs * w) / ETA0),
        lowPass: Float32Array.from(poles.cornerHz.flatMap((f) => { const r = Math.PI * f * dt; return [(1 - r) / (1 + r), r / (1 + r)]; })),
      };
      const e = new Float32Array(n);
      const h = new Float32Array(n);
      const carry = new Float32Array(1);
      const state = new Float32Array(FACE_STATE_HEADER + faces.terms);
      let largest = 0;
      for (let t = 0; t < 20000; t++) {
        applyFaceLoss(h, faces, carry, state);
        for (let i = 0; i < n - 1; i++) h[i] -= Sc * (e[i + 1] - e[i]);
        for (let i = 1; i < wall; i++) e[i] -= Sc * (h[i] - h[i - 1]);
        // A Gaussian pulse plus the same pulse alternating in sign each step (the Nyquist frequency).
        if (t < 200) e[100] += Math.exp(-(((t - 60) / 10) ** 2)) * (1 + (t % 2 ? 1 : -1));
        for (let i = 0; i < n; i++) largest = Math.max(largest, Math.abs(e[i]));
      }
      return largest;
    };
    expect(run(MAX_FACE_STEP_LOSS)).toBeLessThan(10);
    expect(run(2.2 * MAX_FACE_STEP_LOSS)).not.toBeLessThan(1e3); // grows, or is NaN
  });

  it('sheetFaceLoss gives each face the shape scaled by its own Rs, and the project carries one shape per conductor', () => {
    const json = smallProjectJson();
    json.materials = { rough: { conductivity_s_per_m: COPPER, roughness: { model: 'hammerstad', rms_um: 1 } } };
    json.stackup[0].material = 'rough';
    json.stackup[2].material = 'copper';
    const { model } = rasterise(parseProject(json));
    const surface = model.sheets!.surface!;
    expect(surface.shapes.length).toBe(2);
    expect(surface.cornerHz).toEqual(surfacePoles(8e9, 16e9).cornerHz);
    // Rough copper loses more at 12 GHz, by Hammerstad's factor.
    const at = (shape: number) => shapeImpedance(surface.shapes[shape], surface, 12e9)[0];
    const [roughShape, smoothShape] = [surface.shapeIndex[0], surface.shapeIndex[surface.shapeIndex.length - 1]];
    expect(at(roughShape) / at(smoothShape)).toBeCloseTo(roughnessFactor({ model: 'hammerstad', rmsUm: 1 }, COPPER, 12e9), 3);
    // Rs carried is smooth copper at the loss reference (12 GHz), times the edge factor; the shape gives sqrt(f / fRef).
    expect(Math.min(...model.sheets!.rsOhm)).toBeCloseTo(surfaceResistanceOhm(COPPER, 12e9), 6);
    expect(at(smoothShape)).toBeCloseTo(1, 4);
    const faces = sheetFaceLoss(model);
    expect(faces.terms).toBe(surface.cornerHz.length);
    expect(faces.weight.length).toBe(faces.hIndex.length * faces.terms);
    expect(Math.min(...faces.weight)).toBeGreaterThanOrEqual(0);
    // The same weights scaled far past copper (as a very rough foil to a THz band on fine cells would make them)
    // would take more than MAX_FACE_STEP_LOSS of H in one step at the grid's highest frequency: refused.
    const huge = { ...model.sheets!, surface: { ...surface, shapes: surface.shapes.map((s) => ({ ...s, weights: s.weights.map((w) => w * 1e4) })) } };
    expect(() => sheetFaceLoss({ ...model, sheets: huge })).toThrow(/in one step at the grid's highest frequency/);
  });
});
