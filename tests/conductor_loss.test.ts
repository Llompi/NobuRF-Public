import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCITATION, DEFAULT_GRID, timestepSec } from '../src/engine/config';
import { buildCpml, uniformFaces } from '../src/engine/cpml';
import { applyFaceLoss, CpuFdtd, pecBoxModel } from '../src/engine/fdtd_cpu';
import { cellWidth, dualWidth } from '../src/engine/mesh';
import { faceLossRate, idx3, sheetFaceLoss, surfaceResistanceOhm } from '../src/engine/voxelize';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

describe('conductor loss on copper sheets', () => {
  it('copper surface resistance at 5.8 GHz is 0.020 ohm', () => {
    expect(surfaceResistanceOhm(5.8e7, 5.8e9)).toBeCloseTo(0.01987, 4);
  });

  /**
   * Size, not just sign: a pulse on a 1D Yee line (the same normalised update
   * and mesh scaling as the 3D solver) reflects off a copper wall, a PEC node
   * whose face takes faceLossRate of the H next to it each step, with
   * |Gamma| = (eta0 - Rs) / (eta0 + Rs), on uniform and on graded cells.
   */
  it('a copper face reflects (eta0 - Rs) / (eta0 + Rs)', () => {
    const ETA0 = 376.730313668;
    const Sc = 0.99 / Math.sqrt(3);
    const reflectedPeak = (rsOhm: number | null, graded: boolean) => {
      const widths: number[] = Array(1500).fill(0.1);
      if (graded) {
        for (let n = 1, w = 0.1; n <= 6; n++) widths.push((w *= 1.2));
        widths.push(...Array(100).fill(0.3));
      } else widths.push(...Array(300).fill(0.1));
      const lines = new Float64Array(widths.length + 1);
      widths.forEach((w, i) => (lines[i + 1] = lines[i] + w));
      const n = lines.length;
      const wall = n - 1;
      const dRef = 0.1;
      const eScale = Float64Array.from({ length: n }, (_, i) => dRef / dualWidth(lines, i));
      const hScale = Float64Array.from({ length: n }, (_, i) => dRef / cellWidth(lines, i));
      const faceRate = rsOhm === null ? 0 : faceLossRate(Sc, hScale[wall - 1], rsOhm);
      const e = new Float64Array(n);
      const h = new Float64Array(n);
      let peak = 0;
      for (let t = 0; t < 9000; t++) {
        h[wall - 1] -= faceRate * h[wall - 1];
        for (let i = 0; i < n - 1; i++) h[i] -= Sc * (e[i + 1] - e[i]) * hScale[i];
        for (let i = 1; i < wall; i++) e[i] -= Sc * (h[i] - h[i - 1]) * eScale[i];
        e[1000] += Math.exp(-(((t - 300) / 80) ** 2));
        // The wall's reflection passes the probe between the incident pulse and the far end's reflection.
        if (t > 1500 && t < 3500) peak = Math.max(peak, Math.abs(e[1200]));
      }
      return peak;
    };
    // The share of the pulse the wall takes, 1 - |Gamma|, within 1 % for walls far lossier than copper (0.02 ohm).
    for (const rs of [0.5, 2, 5]) {
      for (const graded of [false, true]) {
        const taken = 1 - reflectedPeak(rs, graded) / reflectedPeak(null, graded);
        expect(Math.abs(taken / (1 - (ETA0 - rs) / (ETA0 + rs)) - 1)).toBeLessThan(0.01);
      }
    }
  });

  /**
   * The point of the face model: a sheet with field on both faces loses on
   * each face by its own field. A PEC box split by a copper sheet across the
   * middle: with both halves excited, the energy left is the sum of what each
   * half keeps alone. A single resistive edge would lose Rs |K_top + K_bottom|^2,
   * a cross term that couples the halves, and would let field through.
   */
  it("a copper sheet loses on each face by that face's own field", () => {
    const grid = { ...DEFAULT_GRID, nx: 12, ny: 12, nz: 17, pmlCells: 0, groundK: 0 };
    const model = pecBoxModel(grid, 1);
    const N = grid.nx * grid.ny * grid.nz;
    const eIndex: number[] = [];
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      const c = idx3(grid, i, j, 8);
      for (const index of [c, N + c]) {
        model.eCurl[index] = 0;
        eIndex.push(index);
      }
    }
    model.sheets = { eIndex: Uint32Array.from(eIndex), normalAxis: new Uint8Array(eIndex.length).fill(2), rsOhm: new Float32Array(eIndex.length).fill(2) };
    const energies = (halves: number[]) => {
      const s = new CpuFdtd(model);
      // Seed Ey peaked at the box centre in x, in the middle of each excited half.
      for (const k of halves) for (let j = 1; j < grid.ny - 1; j++) for (let i = 1; i < grid.nx - 1; i++) {
        s.e[N + idx3(grid, i, j, k)] = Math.sin((Math.PI * i) / (grid.nx - 1));
      }
      const start = s.energy();
      for (let n = 0; n < 3000; n++) { s.updateH(); s.updateE(); }
      return { start, end: s.energy() };
    };
    const [lower, upper, both] = [energies([4]), energies([12]), energies([4, 12])];
    expect(10 * Math.log10(lower.start / lower.end)).toBeGreaterThan(0.5);
    expect(10 * Math.log10(upper.start / upper.end)).toBeGreaterThan(0.5);
    expect(both.end / (lower.end + upper.end)).toBeCloseTo(1, 5);
  });

  /**
   * Loss size in 3D, through sheetFaceLoss, on both faces of one sheet: a PEC
   * box split in z by a lossy sheet, with 1 mm cells below it and 1.5 mm cells
   * above (so the face below and the face above take different rates). The
   * TE101 mode of either half loses energy at
   *   gamma = (2 Rs / (mu0 d)) * (1/d^2) / (1/d^2 + 1/a^2)
   * to the sheet alone (Pozar 6.3, one z wall of a x b x d); the PEC walls take nothing.
   */
  it('a copper sheet takes the TE101 energy rate on the face below and the face above', () => {
    const MU0 = 4e-7 * Math.PI;
    const rsOhm = 2;
    const [nx, ny, kSheet, cellsAbove] = [14, 8, 14, 15];
    const grid = { ...DEFAULT_GRID, nx, ny, nz: kSheet + cellsAbove + 1, dxMm: 1, pmlCells: 0, groundK: 0 };
    const N = grid.nx * grid.ny * grid.nz;
    const lines = (n: number, width: (k: number) => number) => {
      const out = new Float64Array(n);
      for (let k = 1; k < n; k++) out[k] = out[k - 1] + width(k - 1);
      return out;
    };
    const mesh = { x: lines(nx, () => 1), y: lines(ny, () => 1), z: lines(grid.nz, (k) => (k < kSheet ? 1 : 1.5)) };
    const model = { ...pecBoxModel(grid, 1), mesh, cpml: buildCpml(grid, uniformFaces(0), undefined, mesh) };
    // PEC on the high faces too, and no edges past them, so the box is exactly the mesh.
    const dims = [nx, ny, grid.nz];
    for (let k = 0; k < grid.nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const at = [i, j, k];
      for (let along = 0; along < 3; along++) {
        const onWall = at.some((v, axis) => axis !== along && (v === 0 || v === dims[axis] - 1));
        if (onWall || at[along] === dims[along] - 1) model.eCurl[along * N + idx3(grid, i, j, k)] = 0;
      }
    }
    const eIndex: number[] = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = idx3(grid, i, j, kSheet);
      for (const index of [c, N + c]) {
        model.eCurl[index] = 0;
        eIndex.push(index);
      }
    }
    model.sheets = { eIndex: Uint32Array.from(eIndex), normalAxis: new Uint8Array(eIndex.length).fill(2), rsOhm: new Float32Array(eIndex.length).fill(rsOhm) };
    const aMm = nx - 1;
    const energyRate = (kLow: number, kHigh: number) => {
      const s = new CpuFdtd(model);
      const [z0, d] = [mesh.z[kLow], mesh.z[kHigh] - mesh.z[kLow]];
      for (let k = kLow + 1; k < kHigh; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
        s.e[N + idx3(grid, i, j, k)] = Math.sin((Math.PI * mesh.x[i]) / aMm) * Math.sin((Math.PI * (mesh.z[k] - z0)) / d);
      }
      // The slope of ln(energy) fitted over 3000 steps, so the small step-to-step swing between E and H energy averages out.
      const samples: Array<[number, number]> = [];
      for (let n = 1; n <= 3000; n++) {
        s.updateH();
        s.updateE();
        samples.push([n * timestepSec(grid), Math.log(s.energy())]);
      }
      const mean = (f: (p: [number, number]) => number) => samples.reduce((sum, p) => sum + f(p), 0) / samples.length;
      const [tBar, yBar] = [mean(([t]) => t), mean(([, y]) => y)];
      const measured = -mean(([t, y]) => (t - tBar) * (y - yBar)) / mean(([t]) => (t - tBar) ** 2);
      const [dM, aM] = [d * 1e-3, aMm * 1e-3];
      const expected = ((2 * rsOhm) / (MU0 * dM)) * (1 / dM ** 2) / (1 / dM ** 2 + 1 / aM ** 2);
      return measured / expected;
    };
    // Within 3 %: the face H sits half a cell off the wall, and the 1D test bounds the update itself at 1 %.
    expect(Math.abs(energyRate(0, kSheet) - 1)).toBeLessThan(0.03);
    expect(Math.abs(energyRate(kSheet, grid.nz - 1) - 1)).toBeLessThan(0.03);
  });

  /**
   * Copper at 1 GHz on a cell 100x dRef takes about 1.2e-7 of h per step, below
   * float32 h's own spacing: a plain h -= rate * h rounds back to h. The carried
   * remainder makes the component lose what the rate says over many steps,
   * whether h holds its sign or flips it every step as a field does.
   */
  it.each([1e-6, 1e-7, 3e-8])('takes a face loss rate of %s in float32 over many steps', (rate) => {
    const steps = Math.round(0.05 / rate);
    for (const flip of [1, -1]) {
      const h = Float32Array.of(0.7);
      const faces = { hIndex: Uint32Array.of(0), rate: Float32Array.of(rate), terms: 0, weight: new Float32Array(0), lowPass: new Float32Array(0) };
      const carry = new Float32Array(1);
      for (let n = 0; n < steps; n++) {
        applyFaceLoss(h, faces, carry);
        h[0] *= flip;
      }
      const expected = 0.7 * (1 - Math.fround(rate)) ** steps;
      expect(Math.abs(Math.abs(h[0]) / expected - 1)).toBeLessThan(1e-5);
    }
    // Without the carry the smallest rates would lose nothing at all.
    if (rate < 1e-7) expect(Math.fround(0.7 - Math.fround(rate * 0.7))).toBe(Math.fround(0.7));
  });

  it('gives an H component between two sheets the loss of both faces', () => {
    const grid = { ...DEFAULT_GRID, nx: 6, ny: 6, nz: 10, pmlCells: 0, groundK: 0 };
    const model = pecBoxModel(grid, 1);
    const N = grid.nx * grid.ny * grid.nz;
    // Ex edges of one cell, on sheets at k = 4 (Rs 3 ohm) and k = 5 (Rs 7 ohm).
    const [low, high] = [idx3(grid, 2, 2, 4), idx3(grid, 2, 2, 5)];
    model.eCurl[low] = 0;
    model.eCurl[high] = 0;
    model.sheets = { eIndex: Uint32Array.of(low, high), normalAxis: Uint8Array.of(2, 2), rsOhm: Float32Array.of(3, 7) };
    const { hIndex, rate } = sheetFaceLoss(model);
    const rateAt = (index: number) => rate[Array.from(hIndex).indexOf(index)];
    const Sc = grid.courant;
    const [r3, r7] = [faceLossRate(Sc, 1, 3), faceLossRate(Sc, 1, 7)];
    // Hy at k = 4 sits between the sheets; the faces outside them take one rate each.
    expect(hIndex.length).toBe(3);
    expect(rateAt(N + low) / (r3 + r7 - r3 * r7)).toBeCloseTo(1, 6);
    expect(rateAt(N + low - grid.nx * grid.ny) / r3).toBeCloseTo(1, 6);
    expect(rateAt(N + high) / r7).toBeCloseTo(1, 6);
  });

  /** The small patch with its copper layers made of `material`, solved for 1500 steps. */
  function solve(material: string, materials: Record<string, unknown> = {}) {
    const json = smallProjectJson();
    json.materials = materials;
    for (const layer of json.stackup) if (layer.type === 'copper') layer.material = material;
    const { model } = rasterise(parseProject(json));
    const control = { maxSteps: 1500, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
    const solver = new CpuFdtd(model);
    const exc = { ...DEFAULT_EXCITATION, fMinGHz: 8, fMaxGHz: 16 };
    const run = solver.run(exc, control);
    return { model, run, energy: solver.energy() };
  }

  it('copper dissipates, and a near-perfect conductor approaches PEC', () => {
    const pec = solve('pec');
    const copper = solve('copper');
    const nearPec = solve('superconductor_ish', { superconductor_ish: { conductivity_s_per_m: 1e9 } });
    expect(copper.model.signature).not.toBe(pec.model.signature);
    // Same everything but the sheets: losses only remove energy.
    expect(copper.energy).toBeLessThan(pec.energy);
    expect(nearPec.energy).toBeLessThan(pec.energy);
    expect(nearPec.energy).toBeGreaterThan(copper.energy);
    const diff = (a: Float32Array, b: Float32Array) => Math.max(...a.map((v, n) => Math.abs(v - b[n]))) / Math.max(...b.map(Math.abs));
    // Rs scales as 1/sqrt(sigma): 1e9 S/m has 0.24x copper's Rs, so its V(t) sits closer to PEC.
    expect(diff(nearPec.run.v, pec.run.v)).toBeLessThan(diff(copper.run.v, pec.run.v));
    expect(diff(copper.run.v, pec.run.v)).toBeLessThan(0.05);
  });

  it('rejects a conductor as a dielectric and a dielectric as copper', () => {
    const json = smallProjectJson();
    json.materials = { metal: { conductivity_s_per_m: 1e7 } };
    json.stackup[1].material = 'metal';
    expect(() => rasterise(parseProject(json))).toThrow(/is a conductor/);
    const json2 = smallProjectJson();
    json2.stackup[0].material = 'FR-4';
    expect(() => rasterise(parseProject(json2))).toThrow(/needs a conductor/);
  });
});
