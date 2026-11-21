import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID, timestepSec } from '../src/engine/config';
import { CpuFdtd, pecBoxModel } from '../src/engine/fdtd_cpu';
import { componentImpedance, edgeMedium, lumpedEdgeCoefficients, placeComponents, type ComponentValues } from '../src/engine/lumped';
import { sourceEndStep, sourceParams, sourceValue } from '../src/engine/source';
import type { GridConfig } from '../src/engine/types';
import { idx3 } from '../src/engine/voxelize';
import { parseProject } from '../src/project/schema';
import { rasterise } from '../src/project/rasterise';
import { resolveProject } from '../src/project/resolve';
import { scatteringMatrix, type Complex } from '../src/engine/port_dft';
import { twoPortLineJson } from './project_fixtures';

const control = { maxSteps: 600, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
const exc = { fMinGHz: 1, fMaxGHz: 10, nFreq: 19, z0: 50 };
const values = (v: Partial<ComponentValues>): ComponentValues => ({ resistanceOhm: null, inductanceH: null, capacitanceF: null, connection: 'series', ...v });

describe('lumped component update', () => {
  it('a resistor is the passive lumped port of the same resistance, to float rounding', () => {
    const portModel = rasterise(parseProject(twoPortLineJson())).model;
    const reference = new CpuFdtd(portModel).run(exc, control);
    // Same model, port p2 replaced by a 50 ohm resistor on its column.
    const model = rasterise(parseProject(twoPortLineJson())).model;
    const p2 = model.ports[1];
    for (const ez of p2.ezIndex) {
      // The port column is FR-4 without its loss (the port drops it); give the resistor the same medium.
      model.eDecay[ez] = 1;
      model.eCurl[ez] = model.grid.courant / 4.4;
    }
    const edges = Array.from(p2.ezIndex, (eIndex, n) => ({ eIndex, edgeLength: p2.mesh.cellLength[n], crossSection: p2.mesh.loopLengthX * p2.mesh.loopLengthY }));
    model.lumped = placeComponents(model.eDecay, model.eCurl, model.grid.courant, timestepSec(model.grid), [{ columns: [edges], values: values({ resistanceOhm: 50 }) }]);
    model.ports = [model.ports[0]];
    const run = new CpuFdtd(model).run(exc, control);
    const peak = Math.max(...reference.v.map(Math.abs));
    let worst = 0;
    for (let n = 0; n < control.maxSteps; n++) worst = Math.max(worst, Math.abs(run.v[n] - reference.v[n]));
    expect(worst).toBeLessThan(1e-5 * peak);
  });

  it('a capacitor in parallel adds C dz / (eps0 A) to the edge eps_r', () => {
    const Sc = DEFAULT_GRID.courant;
    const dt = timestepSec(DEFAULT_GRID);
    const dRefM = DEFAULT_GRID.dxMm * 1e-3;
    const c = 0.5e-12;
    const coef = lumpedEdgeCoefficients(Sc, dt, { epsR: 4.4, lossG: 0 }, { edgeLength: 1, columnLength: 3, crossSection: 1 }, values({ capacitanceF: c, connection: 'parallel' }));
    // Three cells in series each hold 3 C; one cell of height dRef and area dRef^2 adds 3 C / (eps0 dRef).
    const addedEps = (3 * c) / (8.8541878128e-12 * dRefM);
    expect(edgeMedium(Sc, coef.ca, coef.cb).epsR).toBeCloseTo(4.4 + addedEps, 3);
  });

  it('rejects zero, negative and missing values', () => {
    const Sc = DEFAULT_GRID.courant;
    const g = { edgeLength: 1, columnLength: 1, crossSection: 1 };
    expect(() => lumpedEdgeCoefficients(Sc, 1e-12, { epsR: 1, lossG: 0 }, g, values({}))).toThrow(/needs a resistance/);
    expect(() => lumpedEdgeCoefficients(Sc, 1e-12, { epsR: 1, lossG: 0 }, g, values({ resistanceOhm: 0 }))).toThrow(/positive/);
    expect(() => lumpedEdgeCoefficients(Sc, 1e-12, { epsR: 1, lossG: 0 }, g, values({ inductanceH: -1e-9 }))).toThrow(/positive/);
  });

  // A closed lossless PEC box with one component column, rung by a short pulse:
  // the energy must not grow for any L and C, even values far outside what an
  // explicit inductor update could take (1 fH steps far below dt).
  const box: GridConfig = { ...DEFAULT_GRID, nx: 12, ny: 12, nz: 8, pmlCells: 0, groundK: 1 };
  const lossless = [
    ['parallel LC', values({ inductanceH: 1e-9, capacitanceF: 1e-12, connection: 'parallel' })],
    ['series LC', values({ inductanceH: 1e-9, capacitanceF: 1e-12 })],
    ['a 1 fH parallel L', values({ inductanceH: 1e-15, connection: 'parallel' })],
    ['a tiny series LC', values({ inductanceH: 1e-15, capacitanceF: 1e-18 })],
    ['a huge series LC', values({ inductanceH: 1e-6, capacitanceF: 1e-9 })],
  ] as const;
  for (const [name, v] of lossless) {
    it(`${name}: a closed lossless box neither gains nor loses energy`, () => {
      const energies = ringBox(box, v);
      // The energy at one instant wobbles by about 10 % on this coarse box (e and h are half a step apart); growth would be orders more.
      expect(Math.max(...energies) / Math.min(...energies)).toBeLessThan(1.35);
    });
  }

  it('a series RL drains the box', () => {
    const bare = ringBox(box, null);
    const drained = ringBox(box, values({ resistanceOhm: 10, inductanceH: 1e-9 }));
    expect(drained.at(-1)!).toBeLessThan(0.15 * bare.at(-1)!);
  });
});

/** Energy every 4000 steps after a pulse on one Ez edge of a PEC box with a vertical component column of 4 Ez edges (none if `v` is null). */
function ringBox(grid: GridConfig, v: ComponentValues | null): number[] {
  const model = pecBoxModel(grid, 1);
  const N = grid.nx * grid.ny * grid.nz;
  const column = [2, 3, 4, 5].map((k) => ({ eIndex: 2 * N + idx3(grid, 6, 6, k), edgeLength: 1, crossSection: 1 }));
  if (v) model.lumped = placeComponents(model.eDecay, model.eCurl, grid.courant, timestepSec(grid), [{ columns: [column], values: v }]);
  const sim = new CpuFdtd(model);
  const dt = timestepSec(grid);
  const pulse = sourceParams({ fMinGHz: 2, fMaxGHz: 30, nFreq: 2, z0: 50 });
  const end = sourceEndStep(pulse, dt);
  const energies: number[] = [];
  for (let n = 0; n < 40_000; n++) {
    sim.updateH();
    sim.updateE();
    if (n < end) sim.e[2 * N + idx3(grid, 4, 5, 3)] += sourceValue(pulse, (n + 0.5) * dt);
    else if (n % 4000 === 0) energies.push(sim.energy());
  }
  return energies;
}

// The two-port line with a lossless substrate, so the port cell and the
// component cell see the same medium (the port drops the dielectric loss).
function losslessLineJson(): Record<string, any> {
  const json = twoPortLineJson();
  json.materials = { lossless: { eps_r: 4.4, tan_delta: 0 } };
  json.stackup[1].material = 'lossless';
  json.analysis.stop = { energy_decay_db: 60, max_steps: 20_000 };
  return json;
}

const c = {
  add: (x: Complex, y: Complex): Complex => [x[0] + y[0], x[1] + y[1]],
  sub: (x: Complex, y: Complex): Complex => [x[0] - y[0], x[1] - y[1]],
  mul: (x: Complex, y: Complex): Complex => [x[0] * y[0] - x[1] * y[1], x[0] * y[1] + x[1] * y[0]],
  div: (x: Complex, y: Complex): Complex => {
    const d = y[0] ** 2 + y[1] ** 2;
    return [(x[0] * y[0] + x[1] * y[1]) / d, (x[1] * y[0] - x[0] * y[1]) / d];
  },
};

describe('a component at the terminals of a measured two-port', () => {
  // Port p2 of the line is one Ez cell (1 mm FR-4, 1 mm cells). Measure the
  // two-port S with both ports, then put a component on p2's cell instead of
  // the port: network theory gives S11 = S11 + S12 S21 GL / (1 - S22 GL)
  // with GL from the component's Z(j omega) in parallel with the cell's own
  // capacitance eps0 eps_r A / l, since the port's current is the H loop
  // around the cell. Every parasitic of the line is inside S, so this tests
  // the component alone, against its ideal circuit.
  const project = parseProject(losslessLineJson());
  const a = project.analysis;
  const lineExc = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const lineControl = { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 };
  const cellCapacitanceF = 8.8541878128e-12 * 4.4 * 1e-3;
  let twoPort: ReturnType<typeof scatteringMatrix> | null = null;
  const measured = () => {
    if (!twoPort) {
      const solver = new CpuFdtd(rasterise(project).model);
      twoPort = scatteringMatrix([0, 1].map((p) => ({ activePort: p, samples: solver.run(lineExc, lineControl, undefined, p) })), [50, 50], lineExc);
    }
    return twoPort;
  };

  const parts = [
    { r_ohm: 20, l_nh: 3, c_pf: 1, connection: 'series' },
    { r_ohm: 200, l_nh: 2, c_pf: 0.5, connection: 'parallel' },
    { l_nh: 1 },
  ];
  for (const part of parts) {
    it(`${JSON.stringify(part)} matches its ideal circuit within 0.005 in S11 from 1 to 10 GHz`, () => {
      const S = measured();
      const json = losslessLineJson();
      json.ports = [json.ports[0]];
      json.components = [{ id: 'Z', x: '0 mm', y: 'half_len', between: ['top', 'gnd'], ...part }];
      const loadedProject = parseProject(json);
      const resolved = resolveProject(loadedProject).components[0];
      const loaded = scatteringMatrix([{ activePort: 0, samples: new CpuFdtd(rasterise(loadedProject).model).run(lineExc, lineControl, undefined, 0) }], [50], lineExc);
      let worst = 0;
      S.fGHz.forEach((fGHz, k) => {
        const w = 2 * Math.PI * fGHz * 1e9;
        const terminal = c.div([1, 0], c.add(c.div([1, 0], componentImpedance(resolved.values, fGHz * 1e9)), [0, w * cellCapacitanceF]));
        const gl = c.div(c.sub(terminal, [50, 0]), c.add(terminal, [50, 0]));
        const s = (i: number, j: number): Complex => [S.re[i][j]![k], S.im[i][j]![k]];
        const predicted = c.add(s(0, 0), c.div(c.mul(c.mul(s(0, 1), s(1, 0)), gl), c.sub([1, 0], c.mul(s(1, 1), gl))));
        worst = Math.max(worst, Math.hypot(loaded.re[0][0]![k] - predicted[0], loaded.im[0][0]![k] - predicted[1]));
      });
      expect(worst).toBeLessThan(5e-3);
    });
  }
});

describe('a component on Djordjevic-Sarkar FR-4', () => {
  // The component pass owns its edges, so they leave the dispersion list and
  // keep the substrate's single-frequency stand-in; the rest of the substrate
  // stays dispersive. The terminal check above then holds on this line too.
  const dispersiveLineJson = () => {
    const json = twoPortLineJson();
    json.materials = { 'FR-4 wideband': { eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 1 } } };
    json.stackup[1].material = 'FR-4 wideband';
    json.analysis.stop = { energy_decay_db: 60, max_steps: 20_000 };
    return json;
  };
  const project = parseProject(dispersiveLineJson());
  const a = project.analysis;
  const lineExc = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const lineControl = { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 };
  const part = { r_ohm: 20, l_nh: 3, c_pf: 1, connection: 'series' };
  const loadedJson = () => {
    const json = dispersiveLineJson();
    json.ports = [json.ports[0]];
    json.components = [{ id: 'Z', x: '0 mm', y: 'half_len', between: ['top', 'gnd'], ...part }];
    return json;
  };

  it('takes its edges out of the dispersion list and leaves the substrate dispersive', () => {
    const model = rasterise(parseProject(loadedJson())).model;
    const dispersive = new Set(model.dispersion!.e!.index);
    expect(dispersive.size).toBeGreaterThan(100);
    for (const edge of model.lumped!.eIndex) expect(dispersive.has(edge)).toBe(false);
  });

  it(`${JSON.stringify(part)} on port 2's cell matches network theory within 0.005 in S11`, () => {
    const solver = new CpuFdtd(rasterise(project).model);
    const S = scatteringMatrix([0, 1].map((p) => ({ activePort: p, samples: solver.run(lineExc, lineControl, undefined, p) })), [50, 50], lineExc);
    const loadedProject = parseProject(loadedJson());
    const values = resolveProject(loadedProject).components[0].values;
    const loaded = scatteringMatrix([{ activePort: 0, samples: new CpuFdtd(rasterise(loadedProject).model).run(lineExc, lineControl, undefined, 0) }], [50], lineExc);
    const cellCapacitanceF = 8.8541878128e-12 * 4.4 * 1e-3;
    let worst = 0;
    S.fGHz.forEach((fGHz, k) => {
      const w = 2 * Math.PI * fGHz * 1e9;
      const terminal = c.div([1, 0], c.add(c.div([1, 0], componentImpedance(values, fGHz * 1e9)), [0, w * cellCapacitanceF]));
      const gl = c.div(c.sub(terminal, [50, 0]), c.add(terminal, [50, 0]));
      const s = (i: number, j: number): Complex => [S.re[i][j]![k], S.im[i][j]![k]];
      const predicted = c.add(s(0, 0), c.div(c.mul(c.mul(s(0, 1), s(1, 0)), gl), c.sub([1, 0], c.mul(s(1, 1), gl))));
      worst = Math.max(worst, Math.hypot(loaded.re[0][0]![k] - predicted[0], loaded.im[0][0]![k] - predicted[1]));
    });
    expect(worst).toBeLessThan(5e-3);
  });
});

