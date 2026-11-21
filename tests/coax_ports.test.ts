import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { solveProjectText } from '../scripts/noburf';
import { addCoaxFeeds, coaxCalibrationModel, solvePorts } from '../src/engine/coax_feed';
import { renormaliseScattering, type ScatteringResult } from '../src/engine/port_dft';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { idx3 } from '../src/engine/voxelize';
import { probePatchJson, rect, smaEdgeLineJson, smaThroughLineJson } from './project_fixtures';

const slow = process.env.SKIP_SLOW ? it.skip : it;

/** A two-port S-matrix at one frequency from [[S11, S12], [S21, S22]] as [re, im] pairs. */
function matrix(entries: Array<Array<[number, number]>>): ScatteringResult {
  return {
    fGHz: Float64Array.of(1),
    re: entries.map((row) => row.map(([re]) => Float64Array.of(re))),
    im: entries.map((row) => row.map(([, im]) => Float64Array.of(im))),
    method: 'full',
    maxPassiveIncidentRatio: 0,
  };
}

/** S of a shunt resistor R between two ports with real reference impedances, from the circuit. */
function shunt(r: number, ra: number, rb: number): ScatteringResult {
  const parallel = (x: number, y: number) => (x * y) / (x + y);
  const s11 = (parallel(r, rb) - ra) / (parallel(r, rb) + ra);
  const s22 = (parallel(r, ra) - rb) / (parallel(r, ra) + rb);
  // V at the node for a = 1 at port 1: V = (1 + S11) sqrt(Ra); b2 = V / sqrt(Rb) (port 2 matched).
  const s21 = ((1 + s11) * Math.sqrt(ra)) / Math.sqrt(rb);
  return matrix([[[s11, 0], [s21, 0]], [[s21, 0], [s22, 0]]]);
}

const db = (re: number, im: number) => 20 * Math.log10(Math.hypot(re, im));

describe('renormaliseScattering', () => {
  it('moves a shunt resistor between reference impedances, and back', () => {
    const at46 = shunt(80, 46, 47);
    const at50 = renormaliseScattering(at46, [46, 47], [50, 50]);
    const expected = shunt(80, 50, 50);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      expect(at50.re[i][j]![0]).toBeCloseTo(expected.re[i][j]![0], 12);
      expect(at50.im[i][j]![0]).toBeCloseTo(0, 12);
    }
    const back = renormaliseScattering(at50, [50, 50], [46, 47]);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) expect(back.re[i][j]![0]).toBeCloseTo(at46.re[i][j]![0], 12);
  });

  it('refuses a matrix with an unexcited column', () => {
    const s = shunt(80, 50, 50);
    s.re[0][1] = null;
    expect(() => renormaliseScattering(s, [50, 50], [46, 46])).toThrow(/every port excited/);
  });
});

describe('coax feeds on any edge, several at once, and through the ground', () => {
  it('meshes an SMA on the x_max edge, its coax running out along +x', () => {
    const json = smaEdgeLineJson();
    // The line turned to run along x, to the board's x_max edge at 4 mm.
    json.geometry.top[0].polygon = rect('-4 mm', '-1 mm', '4 mm', '1 mm');
    json.ports[0] = { id: 'sma', kind: 'sma_edge', edge: 'x_max', y: '0 mm', between: ['top', 'gnd'], reference_impedance_ohm: 50 };
    const { model, coaxPorts } = rasterise(parseProject(json));
    expect(coaxPorts).toHaveLength(1);
    const spec = coaxPorts[0].spec;
    expect(spec).toMatchObject({ runAxis: 0, outward: 1, flangeMm: 4 });
    for (const d of [0, 6, 10, 14]) expect(model.mesh.x.some((x) => Math.abs(x - (4 + d)) < 1e-9)).toBe(true);
    // The far end of the coax run is inside the box, past the source.
    expect(model.mesh.x.at(-1)! - model.cpml.faces.xHigh).toBeGreaterThan(4 + 16);
    // The stand-in port's column gets the substrate back, as on y_min, not the air past the edge.
    const standInEpsR = (board: typeof model, specs: typeof spec[]) => {
      const { model: fed } = addCoaxFeeds(board, specs, [0]);
      return Array.from(board.ports[0].ezIndex, (c) => board.grid.courant / fed.eCurl[c]);
    };
    const yMin = rasterise(parseProject(smaEdgeLineJson()));
    const reference = standInEpsR(yMin.model, [yMin.coaxPorts[0].spec]);
    standInEpsR(model, [spec]).forEach((epsR, n) => expect(epsR).toBeCloseTo(reference[n], 4));
    for (const epsR of reference) expect(epsR).toBeCloseTo(3.31, 2);
  });

  it('meshes an SMA on each end of a line, with the air widened on both y faces', () => {
    const { model, coaxPorts } = rasterise(parseProject(smaThroughLineJson()));
    expect(coaxPorts.map((c) => [c.port, c.spec.outward, c.spec.flangeMm])).toEqual([[0, -1, -7], [1, 1, 7]]);
    // One lumped stand-in per port until solvePorts swaps them for the connectors.
    expect(model.ports).toHaveLength(2);
    const { feeds } = addCoaxFeeds(model, coaxPorts.map((c) => c.spec), [0, 1]);
    expect(feeds[0].probes[1].impedanceOhm).toBeCloseTo(feeds[1].probes[1].impedanceOhm, 6);
  });

  it('puts a coax probe below the ground plane, cuts the anti-pad and runs the pin up to the patch', () => {
    const { model, coaxPorts } = rasterise(parseProject(probePatchJson('coax_probe')));
    const spec = coaxPorts[0].spec;
    expect(spec).toMatchObject({ runAxis: 2, outward: -1, flangeMm: 0, axisMm: [0, -2.5], antiPad: true });
    expect(spec.pinOverhangMm).toBeCloseTo(1.6, 12);
    const { model: fed } = addCoaxFeeds(model, [spec], [0]);
    const { grid, mesh } = fed;
    const N = grid.nx * grid.ny * grid.nz;
    const node = (lines: Float64Array, v: number) => lines.findIndex((l) => Math.abs(l - v) < 1e-9);
    const [i0, j0, kGround] = [node(mesh.x, 0), node(mesh.y, -2.5), node(mesh.z, 0)];
    const kTop = node(mesh.z, 1.6);
    expect(Math.min(i0, j0, kGround, kTop)).toBeGreaterThanOrEqual(0);
    const ex = (i: number, j: number, k: number) => fed.eCurl[idx3(grid, i, j, k)];
    const ez = (i: number, j: number, k: number) => fed.eCurl[2 * N + idx3(grid, i, j, k)];
    // Ground copper (Ex) in the bore, 1.25 mm from the axis, is cut; in the body wall, 2.5 mm out, it stays.
    const iBore = node(mesh.x, 1.25);
    const iWall = node(mesh.x, 2.5);
    expect(model.eCurl[idx3(grid, iBore, j0, kGround)]).toBe(0);
    expect(ex(iBore, j0, kGround)).toBeGreaterThan(0);
    expect(ex(iWall, j0, kGround)).toBe(0);
    // The pin is metal from the ground plane to the patch.
    for (let k = kGround; k < kTop; k++) expect(ez(i0, j0, k)).toBe(0);
  });

  it('builds the calibration coax for a probe whose run lattice does not reach the flange', () => {
    // The calibration model cuts the coax past the near probe and extends it with uniform cells,
    // so the flange need not fall on one of its lines (Chang 1986 29.5 x 19.5 mm on a graded mesh).
    const json = JSON.parse(readFileSync(new URL('../examples/benchmarks/graded/chang1986-29.5x19.5.json', import.meta.url), 'utf8'));
    Object.assign(json.ports[0], { kind: 'coax_probe', between: ['top', 'gnd'] });
    const { model, coaxPorts } = rasterise(parseProject(json));
    const { model: fed, feeds } = addCoaxFeeds(model, [coaxPorts[0].spec], [0]);
    const { model: cal } = coaxCalibrationModel(fed, feeds[0]);
    expect(Array.from(cal.mesh.z).some((z) => Math.abs(z) < 1e-6)).toBe(false);
  });

  it.each([
    ['a PEC z_min wall', (j: any) => { j.boundaries.z_min = { type: 'pec' }; }, /\$\.boundaries\.z_min: must be a PML for the coax_probe port "probe"/],
    ['the layers swapped', (j: any) => { j.ports[0].between = ['gnd', 'top']; }, /\$\.ports\[0\]\.between: must be \[a copper layer above, the bottom copper layer\]/],
  ])('refuses a coax probe with %s', (_, edit, error) => {
    const json = probePatchJson('coax_probe');
    edit(json);
    expect(() => rasterise(parseProject(json))).toThrow(error);
  });

  it('refuses a coax probe whose body runs into an SMA, and passes one clear of it', () => {
    const near = smaEdgeLineJson();
    near.boundaries.z_min = { type: 'pml', cells: 6 };
    near.ports.push({ id: 'probe', kind: 'coax_probe', x: '0 mm', y: 'half_len', between: ['top', 'gnd'], reference_impedance_ohm: 50 });
    const clear = structuredClone(near);
    near.ports[1].y = '-half_len + 2 mm'; // its body, 3.175 mm each side, reaches under the SMA's body past the edge
    expect(() => rasterise(parseProject(near))).toThrow(/\$\.ports\[1\]: the connector of port "probe" overlaps the one of port "sma"/);
    expect(rasterise(parseProject(clear)).coaxPorts).toHaveLength(2);
  });

  it('needs every port excited when a coax feed shares the board with other ports', async () => {
    const json = smaThroughLineJson();
    const { model, coaxPorts } = rasterise(parseProject(json));
    const exc = { fMinGHz: 2, fMaxGHz: 8, nFreq: 3, z0: 50 };
    await expect(solvePorts(model, coaxPorts, [50, 50], [0], exc, { maxSteps: 10, stopAtEnergyDecayDb: null, energyCheckEverySteps: 10 }))
      .rejects.toThrow(/every port must be excited/);
  });

  it('reports progress for every run, calibration runs included', async () => {
    const { model, coaxPorts } = rasterise(parseProject(smaEdgeLineJson()));
    const exc = { fMinGHz: 2, fMaxGHz: 8, nFreq: 3, z0: 50 };
    const seen: string[] = [];
    await solvePorts(model, coaxPorts, [50], [0], exc, { maxSteps: 200, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 }, {
      onProgress: (run, runs, steps) => seen.push(`${run}/${runs}@${steps}`),
    });
    expect(seen).toEqual(['0/2@100', '0/2@200', '1/2@100', '1/2@200']);
  }, 120_000);

  slow('passes a through line between two SMAs: low loss, reciprocal, passive', async () => {
    const solved = await solveProjectText(JSON.stringify(smaThroughLineJson()), 'p.json', false);
    const s = solved.scattering!;
    expect(s.method).toBe('full');
    for (let m = 0; m < s.fGHz.length; m++) {
      const [s11, s21, s12] = [[0, 0], [1, 0], [0, 1]].map(([i, j]) => [s.re[i][j]![m], s.im[i][j]![m]] as [number, number]);
      expect(db(...s21)).toBeGreaterThan(-1.5);
      expect(Math.hypot(s21[0] - s12[0], s21[1] - s12[1])).toBeLessThan(0.02);
      expect(Math.hypot(...s11) ** 2 + Math.hypot(...s21) ** 2).toBeLessThan(1.01);
    }
  }, 1_800_000);

  slow('passes a through line down to 0.3 GHz, taking the passive far-end reflection as zero where the probes cannot split it', async () => {
    const json = smaThroughLineJson();
    json.analysis = { ...json.analysis, f_min_ghz: 0.3, f_max_ghz: 4.2, n_freq: 14 };
    json.outputs = { ...json.outputs, zin_at_ghz: [2] };
    const solved = await solveProjectText(JSON.stringify(json), 'p.json', false);
    const s = solved.scattering!;
    expect(solved.warnings.filter((w) => /too close in wavelengths/.test(w))).toHaveLength(2);
    for (let m = 0; m < s.fGHz.length; m++) {
      expect(db(s.re[1][0]![m], s.im[1][0]![m])).toBeGreaterThan(-1.5);
      expect(Math.hypot(s.re[1][0]![m] - s.re[0][1]![m], s.im[1][0]![m] - s.im[0][1]![m])).toBeLessThan(0.02);
    }
  }, 1_800_000);

  slow('mixes an SMA and a lumped port on one line: reciprocal S21', async () => {
    const json = smaThroughLineJson();
    json.ports[1] = { id: 'out', x: '0 mm', y: 'half_len', between: ['top', 'gnd'], reference_impedance_ohm: 50 };
    const solved = await solveProjectText(JSON.stringify(json), 'p.json', false);
    const s = solved.scattering!;
    for (let m = 0; m < s.fGHz.length; m++) {
      expect(db(s.re[1][0]![m], s.im[1][0]![m])).toBeGreaterThan(-3);
      expect(Math.hypot(s.re[1][0]![m] - s.re[0][1]![m], s.im[1][0]![m] - s.im[0][1]![m])).toBeLessThan(0.03);
    }
  }, 1_800_000);

  slow('feeds a patch through the ground with a coax probe near where a lumped port puts the resonance', async () => {
    const dip = async (kind: 'coax_probe' | 'lumped') => {
      const { spec } = await solveProjectText(JSON.stringify(probePatchJson(kind)), 'p.json', false);
      const m = spec.s11Db.indexOf(Math.min(...spec.s11Db));
      return { fGHz: spec.fGHz[m], s11Db: spec.s11Db[m] };
    };
    const [probe, lumped] = [await dip('coax_probe'), await dip('lumped')];
    expect(probe.s11Db).toBeLessThan(-6);
    expect(Math.abs(probe.fGHz - lumped.fGHz) / lumped.fGHz).toBeLessThan(0.03);
  }, 1_800_000);
});
