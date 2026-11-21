import { describe, expect, it } from 'vitest';
import type { ScatteringResult } from '../src/engine/port_dft';
import { parseProject } from '../src/project/schema';
import { resolveProject } from '../src/project/resolve';
import { energyCheck, largestSingularValue, passivityCheck, reciprocityCheck } from '../src/verify/checks';
import { boardCellSizeMm, meshStudyBlocker } from '../src/verify/accuracy';
import { gciThreeMesh, gciTwoMesh, maxDeltaS, meshConvergence, s11Minimum, scaledMeshJson, type LevelSolve } from '../src/verify/convergence';
import { rasterise } from '../src/project/rasterise';
import { envelopeFindings, envelopeWarnings } from '../src/verify/envelope';
import { smallProjectJson } from './project_fixtures';

const f = Float64Array.of(1, 2, 3, 4, 5);

/** A 1x1 S with |S11| = mags, zero phase. */
function onePort(mags: number[]): ScatteringResult {
  return { fGHz: f, re: [[Float64Array.from(mags)]], im: [[new Float64Array(mags.length)]], method: 'full', maxPassiveIncidentRatio: 0 };
}

/** n-port S, the same matrix at every frequency. */
function constant(m: Array<Array<[number, number]>>): ScatteringResult {
  const at = (i: number, j: number, k: 0 | 1) => Float64Array.from(f, () => m[i][j][k]);
  return {
    fGHz: f, method: 'full', maxPassiveIncidentRatio: 0,
    re: m.map((row, i) => row.map((_, j) => at(i, j, 0))), im: m.map((row, i) => row.map((_, j) => at(i, j, 1))),
  };
}

describe('grid convergence index', () => {
  it('recovers the order and the exact limit of phi = 5 + 0.3 h^p', () => {
    for (const p of [1, 1.5, 2]) {
      const h: [number, number, number] = [1, Math.SQRT2, 2];
      const phi = h.map((x) => 5 + 0.3 * x ** p) as [number, number, number];
      const g = gciThreeMesh(h, phi)!;
      expect(g.behaviour).toBe('monotone');
      expect(g.observedOrder).toBeCloseTo(p, 6);
      expect(g.extrapolated).toBeCloseTo(5, 9);
      // The error bar covers the true error of the finest mesh, with Roache's 1.25 margin.
      expect(g.uncertainty).toBeCloseTo(1.25 * 0.3, 6);
    }
  });

  it('handles unequal refinement ratios (Celik eqs. 3-5)', () => {
    const h: [number, number, number] = [1, 1.3, 2.1];
    const g = gciThreeMesh(h, h.map((x) => 2 - 0.1 * x ** 1.6) as [number, number, number])!;
    expect(g.observedOrder).toBeCloseTo(1.6, 6);
    expect(g.extrapolated).toBeCloseTo(2, 9);
  });

  it('clamps an order above 2 and widens the safety factor to 3 (Eca and Hoekstra 2014)', () => {
    const g = gciThreeMesh([1, 2, 4], [1 + 1e-3, 1 + 1e-1, 1 + 1])!;
    expect(g.behaviour).toBe('high-order');
    expect(g.observedOrder).toBeGreaterThan(3);
    expect(g.order).toBe(2);
    // The order-2 prediction from the coarser change (0.9 / 4 = 0.225) is the floor, above the 0.099 seen.
    expect(g.uncertainty).toBeCloseTo((3 * 0.225) / 3, 9);
  });

  it('does not let two levels that agree by chance zero the bar, nor shrink it', () => {
    const g = gciThreeMesh([1, 2, 4], [5.1, 5.1, 5.5])!;
    // No order was observed: order 2 for the floor, and the unproven-order safety factor.
    expect(g).toMatchObject({ behaviour: 'high-order', order: 2, observedOrder: null, extrapolated: null });
    expect(g.uncertainty).toBeCloseTo((3 * 0.1) / 3, 9); // 0.4 / 4 predicted for the finest pair
    // A near-tie reads as a high observed order and gets the same band, not a jump.
    expect(gciThreeMesh([1, 2, 4], [5.1, 5.1001, 5.5])!.uncertainty).toBeCloseTo(g.uncertainty, 3);
  });

  it('clamps an order below 0.8 with a safety factor of 3, and gives no estimate for NaN', () => {
    const slow = gciThreeMesh([1, 2, 4], [5, 5.99, 7])!;
    expect(slow.behaviour).toBe('low-order');
    expect(slow.order).toBe(0.8);
    expect(slow.uncertainty).toBeCloseTo((3 * 0.99) / (2 ** 0.8 - 1), 9);
    expect(gciThreeMesh([1, 2, 4], [NaN, 1, 2])).toBeNull();
  });

  it('two meshes: first order with a safety factor of 3 (Roache two-grid GCI)', () => {
    const r = Math.SQRT2;
    const g = gciTwoMesh([1, r], [3.2, 3 + 0.2 * r])!;
    expect(g).toMatchObject({ behaviour: 'two-level', order: 1, observedOrder: null, value: 3.2 });
    expect(g.extrapolated).toBeCloseTo(3, 12); // exact for a first-order quantity
    expect(g.uncertainty).toBeCloseTo(3 * 0.2, 12); // three times the finer mesh's true error of 0.2
  });

  it('flags oscillating and diverging levels and widens the bar to 3x the change', () => {
    const osc = gciThreeMesh([1, 1.5, 2], [10, 10.2, 9.9])!;
    expect(osc.behaviour).toBe('oscillatory');
    expect(osc.extrapolated).toBeNull();
    expect(osc.uncertainty).toBeCloseTo(3 * 0.2, 9);
    const div = gciThreeMesh([1, 1.5, 2], [10, 10.5, 10.6])!;
    expect(div.behaviour).toBe('divergent');
    expect(div.uncertainty).toBeCloseTo(3 * 0.6, 9);
  });

  it('reports zero uncertainty when nothing moves', () => {
    expect(gciThreeMesh([1, 2, 3], [4, 4, 4])).toMatchObject({ behaviour: 'unchanged', uncertainty: 0 });
  });
});

describe('mesh levels', () => {
  it('scales every mesh length and keeps physical air and layer sizes', () => {
    const json = smallProjectJson();
    json.mesh.graded = { edge_cell: '0.5 mm', dielectric_cells: 4, max_growth: 1.4 };
    const coarse = scaledMeshJson(json, 2);
    expect(coarse.mesh.cell).toBe('(1 mm) * 2');
    expect(coarse.mesh.graded).toEqual({ edge_cell: '(0.5 mm) * 2', dielectric_cells: 2, max_growth: 1.4 });
    expect(coarse.mesh.air_margin_cells).toEqual({ xy: 1, below: 1, above: 3 });
    expect(coarse.analysis.stop.max_steps).toBe(6000); // a cap: the energy stop ends the run
    expect(scaledMeshJson(json, 0.5).analysis.stop.max_steps).toBe(12000);
    expect(coarse.boundaries).toEqual(json.boundaries); // PML keeps its cells
    expect(json.mesh.cell).toBe('1 mm'); // input untouched
    const fine = parseProject(scaledMeshJson(json, 0.5));
    expect(resolveProject(fine).cellMm).toBeCloseTo(0.5, 12);
    expect(fine.mesh.graded!.dielectric_cells).toBe(8);
  });

  it('finds the |S11| minimum between samples', () => {
    // |S11| = 0.1 + (f - 3.3)^2 sampled at 1..5: the parabola in dB lands near 3.3.
    const s = onePort(Array.from(f, (x) => 0.1 + (x - 3.3) ** 2 / 10));
    expect(s11Minimum(s)!.fGhz).toBeGreaterThan(3);
    expect(s11Minimum(s)!.fGhz).toBeLessThan(3.5);
    expect(s11Minimum(onePort([0.1, 0.2, 0.3, 0.4, 0.5]))).toBeNull(); // on the band edge
    // Two dips: the deepest by default, the nearest when asked.
    const two = onePort([0.9, 0.3, 0.8, 0.2, 0.9]);
    expect(s11Minimum(two)!.fGhz).toBeCloseTo(4, 0);
    expect(s11Minimum(two, 2.2)!.fGhz).toBeCloseTo(2, 0);
  });

  it('measures Delta S as the largest complex change over the band', () => {
    expect(maxDeltaS(onePort([0.5, 0.5, 0.5, 0.5, 0.5]), onePort([0.5, 0.52, 0.5, 0.45, 0.5]))).toBeCloseTo(0.05, 12);
  });

  it('check mode solves one finer mesh; refine mode solves every pass and reports whether S and the resonance settled', async () => {
    // A synthetic solver whose resonance converges at first order: f = 3 + 0.2 h.
    // |S11| in dB is an exact parabola, so the sub-sample minimum is exact too.
    const solveAt = (h: number): LevelSolve => ({ s: onePort(Array.from(f, (x) => 10 ** ((-20 + 2 * (x - (3 + 0.2 * h)) ** 2) / 20))), cells: Math.round(1000 / h ** 3), hMm: h });
    const asked: number[] = [];
    const solveLevel = async (_json: Record<string, any>, scale: number) => { asked.push(scale); return solveAt(scale); };
    const check = await meshConvergence(smallProjectJson(), solveAt(1), solveLevel, { mode: 'check' });
    expect(asked).toEqual([expect.closeTo(Math.SQRT1_2, 12)]);
    expect(check.report.levels.map((l) => l.scale)).toEqual([1, expect.closeTo(Math.SQRT1_2, 12)]);
    expect(check.finest.hMm).toBeCloseTo(Math.SQRT1_2, 12); // the result is the finer mesh's
    expect(check.report.fResGhz).toMatchObject({ behaviour: 'two-level', value: expect.closeTo(3 + 0.2 * Math.SQRT1_2, 9) });
    expect(check.report.fResGhz!.extrapolated).toBeCloseTo(3, 9);

    asked.length = 0;
    const refine = await meshConvergence(smallProjectJson(), solveAt(1), solveLevel, { mode: 'refine', tolerance: 0.02, maxRefinements: 6 });
    expect(asked[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(refine.report.converged).toBe(true);
    const [previous, last] = refine.report.levels.slice(-2);
    expect(last.deltaS).toBeLessThanOrEqual(0.02);
    expect(Math.abs(last.fResGhz! - previous.fResGhz!) / last.fResGhz!).toBeLessThanOrEqual(0.005);
    expect(refine.finest.cells).toBe(solveAt(last.scale).cells);
    expect(refine.report.fResGhz).toMatchObject({ behaviour: 'monotone', value: expect.closeTo(3 + 0.2 * last.scale, 9) });
    expect(refine.report.fResGhz!.extrapolated).toBeCloseTo(3, 6);
  });
});

describe('mesh study scope', () => {
  it('measures h on the board region, which halves when every mesh length halves', () => {
    const json = smallProjectJson();
    json.mesh.graded = { edge_cell: '0.5 mm', dielectric_cells: 2, max_growth: 1.4 };
    const hOf = (j: Record<string, any>) => {
      const p = parseProject(j);
      return boardCellSizeMm(rasterise(p).model.mesh, resolveProject(p));
    };
    expect(hOf(scaledMeshJson(json, 0.5)) / hOf(json)).toBeGreaterThan(0.4);
    expect(hOf(scaledMeshJson(json, 0.5)) / hOf(json)).toBeLessThan(0.6);
  });

  it('refuses uniform meshes and coax feeds, whose levels are not one board refined evenly', () => {
    const json = smallProjectJson();
    expect(meshStudyBlocker(json)).toMatch(/uniform mesh rounds each layer/);
    json.mesh.graded = { edge_cell: '0.5 mm', dielectric_cells: 2, max_growth: 1.4 };
    expect(meshStudyBlocker(json)).toBeNull();
    json.ports[0].kind = 'coax_probe';
    expect(meshStudyBlocker(json)).toMatch(/coax_probe feed/);
  });

  it('rejects levels that are the same mesh on the board', async () => {
    const level = (h: number): LevelSolve => ({ s: onePort([0.9, 0.5, 0.2, 0.5, 0.9]), cells: 1000, hMm: h });
    await expect(meshConvergence(smallProjectJson(), level(1), async () => level(0.99), { mode: 'check' })).rejects.toThrow(/nearly the same on the board/);
  });

  it('fails the study when the first finer mesh fails', async () => {
    const level: LevelSolve = { s: onePort([0.9, 0.5, 0.2, 0.5, 0.9]), cells: 1000, hMm: 1 };
    await expect(meshConvergence(smallProjectJson(), level, async () => { throw new Error('out of memory'); }, { mode: 'check' })).rejects.toThrow(/out of memory/);
  });

  it('refine keeps the finest level that solved when a finer one fails', async () => {
    const solveAt = (h: number): LevelSolve => ({ s: onePort(Array.from(f, (x) => 10 ** ((-20 + 2 * (x - (3 + 0.2 * h)) ** 2) / 20))), cells: 1, hMm: h });
    const r = await meshConvergence(smallProjectJson(), solveAt(1), async (_j, scale) => {
      if (scale < 0.6) throw new Error('too many cells');
      return solveAt(scale);
    }, { mode: 'refine', tolerance: 1e-9 });
    expect(r.report.refineStopped).toMatch(/cells x0.500 failed: too many cells/);
    expect(r.finest.hMm).toBeCloseTo(Math.SQRT1_2, 12);
    expect(r.report.levels).toHaveLength(2);
  });

  it('refine stops at two finer passes by default, and keeps them when a later mesh is no finer', async () => {
    const solveAt = (h: number): LevelSolve => ({ s: onePort(Array.from(f, (x) => 10 ** ((-20 + 2 * (x - (3 + 0.2 * h)) ** 2) / 20))), cells: 1, hMm: h });
    const capped = await meshConvergence(smallProjectJson(), solveAt(1), async (_j, scale) => solveAt(scale), { mode: 'refine', tolerance: 1e-9 });
    expect(capped.report.levels.map((l) => l.scale)).toEqual([1, expect.closeTo(Math.SQRT1_2, 12), expect.closeTo(0.5, 12)]);
    expect(capped.report.converged).toBe(false);
    const stuck = await meshConvergence(smallProjectJson(), solveAt(1), async (_j, scale) => solveAt(Math.max(scale, 0.7)), { mode: 'refine', tolerance: 1e-9 });
    expect(stuck.report.levels).toHaveLength(2);
    expect(stuck.report.refineStopped).toMatch(/nearly the same on the board/);
    expect(stuck.finest.hMm).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('physics checks', () => {
  it('largest singular value: diagonal, unitary and rank-one cases', () => {
    expect(largestSingularValue([[[0.3, 0], [0, 0]], [[0, 0], [0, -0.8]]])).toBeCloseTo(0.8, 9);
    const c = Math.SQRT1_2;
    expect(largestSingularValue([[[0, 0], [c, 0]], [[0, c], [0, 0]]])).toBeCloseTo(c, 9);
    // An ideal hybrid: [[0, -j, -1, 0] ...]/sqrt2 is unitary up to scale; here a 2x2 rotation.
    expect(largestSingularValue([[[c, 0], [0, -c]], [[0, -c], [c, 0]]])).toBeCloseTo(1, 9);
    expect(largestSingularValue([[[0.5, 0], [0.5, 0]], [[0.5, 0], [0.5, 0]]])).toBeCloseTo(1, 9);
  });

  it('passivity flags gain and passes a lossy match', () => {
    expect(passivityCheck(onePort([0.2, 0.9, 1, 0.5, 0.1]))).toMatchObject({ passed: true, marginal: false });
    expect(passivityCheck(onePort([0.2, 1.01, 0.3, 0.5, 0.1]))).toMatchObject({ passed: true, marginal: true });
    const gain = passivityCheck(onePort([0.2, 1.05, 0.3, 0.5, 0.1]));
    expect(gain.passed).toBe(false);
    expect(gain.atGhz).toBe(2);
    // Each column alone passive, together not: only the singular value catches it.
    expect(passivityCheck(constant([[[0.6, 0], [0.6, 0]], [[0.6, 0], [0.6, 0]]])).passed).toBe(false);
  });

  it('reciprocity compares S_ij with S_ji, and needs every port excited', () => {
    expect(reciprocityCheck(constant([[[0.1, 0], [0.7, 0.1]], [[0.7, 0.1], [0.1, 0]]]))!.passed).toBe(true);
    const bad = reciprocityCheck(constant([[[0.1, 0], [0.7, 0.1]], [[0.65, 0.1], [0.1, 0]]]))!;
    expect(bad.passed).toBe(false);
    expect(bad.worst).toBeCloseTo(0.05, 12);
    expect(reciprocityCheck(constant([[[0.1, 0], [0.7, 0.1]], [[0.693, 0.1], [0.1, 0]]]))).toMatchObject({ passed: true, marginal: true });
    expect(reciprocityCheck(onePort([0.1, 0.1, 0.1, 0.1, 0.1]))).toBeNull();
    // With matched loads only some columns were excited, so S_ji may be unknown.
    expect(reciprocityCheck({ ...constant([[[0.1, 0], [0.7, 0.1]], [[0.65, 0.1], [0.1, 0]]]), method: 'matched_loads' })).toBeNull();
  });

  it('energy check fails when any run stopped on the step cap', () => {
    expect(energyCheck([{ energyDecayDb: 52, stoppedOnEnergy: true }], 50).passed).toBe(true);
    expect(energyCheck([{ energyDecayDb: 52, stoppedOnEnergy: true }, { energyDecayDb: 31, stoppedOnEnergy: false }], 50)).toMatchObject({ passed: false, worst: 31 });
  });
});

describe('validated envelope', () => {
  const at = (json: Record<string, any>, fMin: number, fMax: number) => envelopeFindings(resolveProject(parseProject(json)), fMin, fMax);
  /** The fixture patch on 1.6 mm of eps_r 2.2, the Sheen 1990 substrate. */
  const lowEps = () => {
    const json = smallProjectJson();
    json.materials = { duroid: { eps_r: 2.2, tan_delta: 0.001 } };
    json.stackup[1].material = 'duroid';
    json.stackup[1].thickness = '1.6 mm';
    return json;
  };

  it('passes a one-port patch on eps_r 2.2 at 2.4 GHz and flags a thick board above the benchmark band', () => {
    const json = lowEps();
    expect(envelopeWarnings(at(json, 2, 3))).toEqual([]);
    const thick = at(json, 20, 30);
    expect(thick.find((x) => x.parameter.startsWith('thickness'))!.value).toBe(String(Number((1.6 / (299.792458 / 30 / Math.sqrt(2.2))).toPrecision(3))));
    expect(thick.filter((x) => !x.inside).map((x) => x.parameter)).toEqual(['thickness of "core" in wavelengths at 30 GHz', 'band (GHz)']);
    // FR-4 and the alumina of the eps_eff miss are outside: no agreeing measured benchmark has them.
    for (const [material, epsR] of [['FR-4', '4.4'], ['alumina', '9.9']]) {
      json.materials = { alumina: { eps_r: 9.9, tan_delta: 0 } };
      json.stackup[1].material = material;
      expect(envelopeWarnings(at(json, 2, 3))[0]).toMatch(new RegExp(`^outside the validated range: eps_r of "core" is ${epsR} \\(validated: 2.2 to 2.33\\)`));
    }
  });

  it('puts a four-port design such as the Sheen branch-line coupler outside', () => {
    const json = lowEps();
    json.ports = [0, 1, 2, 3].map((n) => ({ ...json.ports[0], id: `p${n}` }));
    expect(at(json, 2, 3).filter((x) => !x.inside).map((x) => [x.parameter, x.value])).toEqual([['ports', '4 (lumped)']]);
  });

  it('gates by feature: a coax feed or lossy copper is outside even at a benchmark frequency', () => {
    const json = lowEps();
    json.ports[0].kind = 'coax_probe';
    expect(at(json, 2, 3).filter((x) => !x.inside).map((x) => x.parameter)).toEqual(['ports']);
    const lossy = lowEps();
    lossy.stackup[0].material = 'copper';
    expect(at(lossy, 2, 3).filter((x) => !x.inside).map((x) => x.parameter)).toEqual(['copper model']);
  });

  it('counts substrates but not air, and flags slanted copper edges', () => {
    const json = lowEps();
    json.stackup[1].thickness = '0.8 mm';
    json.stackup.splice(2, 0, { type: 'dielectric', name: 'gap', material: 'air', thickness: '0.5 mm' });
    expect(envelopeWarnings(at(json, 2, 3))).toEqual([]);
    json.stackup[2].material = 'duroid';
    expect(at(json, 2, 3).filter((x) => !x.inside).map((x) => x.parameter)).toEqual(['substrate layers']);
    const slanted = lowEps();
    slanted.geometry.top[0].polygon = [['-2 mm', '-2 mm'], ['2 mm', '-2 mm'], ['0 mm', '2 mm']];
    expect(at(slanted, 2, 3).filter((x) => !x.inside).map((x) => x.parameter)).toEqual(['copper edges']);
  });
  it('puts frequency-dependent and magnetic materials outside, and takes the wavelength inside them', () => {
    const json = lowEps();
    json.materials = { duroid: { eps_r: 2.2, tan_delta: 0.001, mu_r: 4 } };
    const findings = at(json, 2, 3);
    expect(findings.filter((x) => !x.inside).map((x) => [x.parameter, x.value])).toEqual([['materials', 'frequency-dependent or magnetic: "core"']]);
    // mu_r 4 doubles the index: 1.6 mm over lambda0 / sqrt(2.2 x 4) at 3 GHz.
    expect(findings.find((x) => x.parameter.startsWith('thickness'))!.value).toBe(String(Number((1.6 / (299.792458 / 3 / Math.sqrt(8.8))).toPrecision(3))));
  });
});
