import { describe, expect, it } from 'vitest';
import { analyseDifferential, differentialJson, pairSpecsFromIds, proposePairs } from '../src/engine/differential';
import type { ScatteringResult } from '../src/engine/port_dft';
import { parseTouchstone, touchstoneLines } from '../src/engine/touchstone';
import { rasterise } from '../src/project/rasterise';
import { constantLossDielectrics, resolveProject } from '../src/project/resolve';
import { parseProject, type Project } from '../src/project/schema';
import * as actions from '../src/workbench/doc_actions';
import { newProject } from '../src/workbench/new_project';
import { pairState, solveRelevantText, withPairs } from '../src/workbench/pair_view';
import type { WorkbenchResult } from '../src/workbench/solve';

const pairTemplate = () => newProject({ template: 'pair', name: 'pair', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 0.5 });

describe('differential pair template', () => {
  it('is two 50 ohm strips two widths apart, four ports, paired at both ends, and meshes', () => {
    const p = pairTemplate();
    expect(p.ports.map((q) => q.id)).toEqual(['p1', 'n1', 'p2', 'n2']);
    expect(p.outputs.differential_pairs).toEqual([{ id: 'D1', positive: 'p1', negative: 'n1' }, { id: 'D2', positive: 'p2', negative: 'n2' }]);
    expect(parseFloat(p.variables.gap.value)).toBeCloseTo(2 * parseFloat(p.variables.line_w.value), 2);
    expect(() => rasterise(p)).not.toThrow();
  });

  it('gives a lossy substrate a Djordjevic-Sarkar model with the same eps_r and tan delta at the design frequency, so no DC leak', () => {
    const p = pairTemplate();
    const core = p.stackup.find((l) => l.type === 'dielectric')!;
    expect(p.materials[core.material]).toEqual({ eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 5 } });
    expect(constantLossDielectrics(resolveProject(p))).toEqual([]);
    // The line template keeps the plain loss tangent, and the helper names its layer.
    const line = newProject({ template: 'line', name: 'line', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 0.5 });
    expect(constantLossDielectrics(resolveProject(line))).toEqual(['core']);
    // A lossless substrate needs no model.
    const lossless = newProject({ template: 'pair', name: 'pair', frequencyGHz: 5, substrate: 'air', thicknessMm: 0.5 });
    expect(lossless.stackup.find((l) => l.type === 'dielectric')!.material).toBe('air');
    // A pole model whose poles supply only part of the loss leaves the rest as a constant conductivity: still a leak.
    const withPoles = (delta: number) => parseProject({ ...line, materials: { lam: { eps_r: 4, tan_delta: 0.02, dispersion: { model: 'poles', at_ghz: 5, poles: [{ type: 'debye', delta, f_relax_ghz: 5 }] } } },
      stackup: line.stackup.map((l) => (l.type === 'dielectric' ? { ...l, material: 'lam' } : l)) });
    expect(constantLossDielectrics(resolveProject(withPoles(0.01)))).toEqual(['core']);
    // delta 0.16 at f_relax = f: the pole gives eps'' = 0.08 = 4 x 0.02, all of the loss.
    expect(constantLossDielectrics(resolveProject(withPoles(0.16)))).toEqual([]);
  });
});

describe('outputs.differential_pairs in the project file', () => {
  const withList = (pairs: unknown) => ({ ...pairTemplate(), outputs: { ...pairTemplate().outputs, differential_pairs: pairs } });
  it('takes mode references and refuses unknown ports, a port in two pairs, a repeated id, an empty list', () => {
    expect(parseProject(withList([{ id: 'D1', positive: 'p1', negative: 'n1', differential_ohm: 90, common_ohm: 30 }])).outputs.differential_pairs)
      .toEqual([{ id: 'D1', positive: 'p1', negative: 'n1', differential_ohm: 90, common_ohm: 30 }]);
    expect(() => parseProject(withList([{ id: 'D1', positive: 'p1', negative: 'x' }]))).toThrow(/"x" is not a port id/);
    expect(() => parseProject(withList([{ id: 'D1', positive: 'p1', negative: 'n1' }, { id: 'D2', positive: 'n1', negative: 'n2' }]))).toThrow(/already in pair "D1"/);
    expect(() => parseProject(withList([{ id: 'D1', positive: 'p1', negative: 'n1' }, { id: 'D1', positive: 'p2', negative: 'n2' }]))).toThrow(/used twice/);
    expect(() => parseProject(withList([]))).toThrow(/names no pair/);
    expect(() => parseProject(withList([{ id: 'D1', positive: 'p1', negative: 'n1', differential_ohm: 0 }]))).toThrow(/differential_ohm/);
  });

  it('follows a renamed port, and loses the pair a removed port was in', () => {
    let doc = actions.renamePort(pairTemplate(), 1, 'dm1');
    expect(doc.outputs.differential_pairs![0]).toEqual({ id: 'D1', positive: 'p1', negative: 'dm1' });
    doc = actions.removePort(doc, 3);
    expect(doc.outputs.differential_pairs).toEqual([{ id: 'D1', positive: 'p1', negative: 'dm1' }]);
    doc = actions.removePort(doc, 0);
    expect(doc.outputs.differential_pairs).toBeUndefined();
    expect(() => parseProject(doc)).not.toThrow();
  });

  it('does not make results stale: the pairing is post-processing', () => {
    const p = pairTemplate() as unknown as Record<string, unknown>;
    expect(solveRelevantText(withPairs(p, null))).toBe(solveRelevantText(p));
    expect(solveRelevantText(withPairs(p, [{ id: 'X', positive: 'n1', negative: 'p1' }]))).toBe(solveRelevantText(p));
    const moved = structuredClone(p) as unknown as Project;
    moved.ports[0].reference_impedance_ohm = 45;
    expect(solveRelevantText(moved)).not.toBe(solveRelevantText(p));
  });
});

/** Two ideal uncoupled lines in the template's port order, with skew. */
function twoLines(): ScatteringResult {
  const f = Array.from({ length: 100 }, (_, m) => 0.1 * (m + 1));
  const delays = [0.1, 0.105]; // ns, p line then n line
  const n = 4;
  const re = Array.from({ length: n }, () => Array.from({ length: n }, () => new Float64Array(f.length)));
  const im = Array.from({ length: n }, () => Array.from({ length: n }, () => new Float64Array(f.length)));
  f.forEach((x, m) => {
    for (const [a, b, tau] of [[0, 2, delays[0]], [1, 3, delays[1]]] as const) {
      re[a][b][m] = re[b][a][m] = Math.cos(2 * Math.PI * x * tau);
      im[a][b][m] = im[b][a][m] = -Math.sin(2 * Math.PI * x * tau);
    }
  });
  return { fGHz: Float64Array.from(f), re, im, method: 'full', maxPassiveIncidentRatio: 0 };
}

describe('pair view state', () => {
  const s = twoLines();
  const result = {
    s, portIds: ['p1', 'n1', 'p2', 'n2'], z0: [50, 50, 50, 50],
    ports: [{ xMm: -1, yMm: -9 }, { xMm: 1, yMm: -9 }, { xMm: -1, yMm: 9 }, { xMm: 1, yMm: 9 }].map((p, k) => ({ ...p, id: ['p1', 'n1', 'p2', 'n2'][k], between: ['gnd', 'top'] })),
  } as unknown as WorkbenchResult;

  it('proposes a pairing when the project has none, and uses the project\'s when it has one', () => {
    const doc = pairTemplate() as unknown as Record<string, unknown>;
    const proposed = pairState(result, withPairs(doc, null));
    expect(proposed.kind).toBe('proposed');
    expect(proposed.kind === 'proposed' && proposed.pairs).toEqual([{ id: 'D1', positive: 'p1', negative: 'n1' }, { id: 'D2', positive: 'p2', negative: 'n2' }]);
    const paired = pairState(result, doc);
    expect(paired.kind).toBe('paired');
    expect(paired.kind === 'paired' && paired.report.throughs[0].timing!.skewPs).toBeCloseTo(-5, 1);
  });

  it('says why when the pairing names a port the solve did not have', () => {
    const doc = withPairs(pairTemplate() as unknown as Record<string, unknown>, [{ id: 'D1', positive: 'p1', negative: 'gone' }, { id: 'D2', positive: 'p2', negative: 'n2' }]);
    const state = pairState(result, doc);
    expect(state.kind).toBe('invalid');
    expect(state.kind === 'invalid' && state.reason).toMatch(/"gone" is not a port id.*Solve again/);
  });
});

describe('Touchstone reader', () => {
  it('reads back what touchstoneLines writes, and other formats and units', () => {
    const s = twoLines();
    const text = ['! test', '# GHz S RI R 50', ...touchstoneLines(s)].join('\n');
    const back = parseTouchstone(text, 4);
    expect(back.z0).toBe(50);
    expect(back.s.re[2][0]![7]).toBeCloseTo(s.re[2][0]![7], 9);
    expect(back.s.im[3][1]![42]).toBeCloseTo(s.im[3][1]![42], 9);
    // Two-port order S11 S21 S12 S22, MHz, dB-angle, another reference.
    const two = parseTouchstone('# MHz S DB R 75\n100 -20 0 -1 -90 -2 -90 -30 180\n', 2);
    expect(two.z0).toBe(75);
    expect(two.s.fGHz[0]).toBeCloseTo(0.1, 12);
    expect(two.s.im[1][0]![0]).toBeCloseTo(-(10 ** (-1 / 20)), 12);
    expect(two.s.im[0][1]![0]).toBeCloseTo(-(10 ** (-2 / 20)), 12);
    expect(two.s.re[1][1]![0]).toBeCloseTo(-(10 ** (-30 / 20)), 12);
  });

  it('refuses the wrong port count, non-S data and v2 keywords', () => {
    expect(() => parseTouchstone('# GHz S RI R 50\n1 0 0 0 0 0 0 0 0\n', 4)).toThrow(/port count/);
    expect(() => parseTouchstone('# GHz Y RI R 50\n1 0 0\n', 1)).toThrow(/only S-parameter/);
    expect(() => parseTouchstone('[Version] 2.0\n', 1)).toThrow(/v2/);
  });

  it('feeds the same analysis as the in-memory matrix', () => {
    const s = twoLines();
    const back = parseTouchstone(['# GHz S RI R 50', ...touchstoneLines(s)].join('\n'), 4);
    const specs = pairSpecsFromIds([{ id: 'D1', positive: '1', negative: '2' }, { id: 'D2', positive: '3', negative: '4' }], ['1', '2', '3', '4']);
    expect(analyseDifferential(back.s, [50, 50, 50, 50], specs).throughs[0].timing!.skewPs).toBeCloseTo(-5, 1);
  });
});

describe('review cases', () => {
  it('declines six ports (three lines) instead of failing', () => {
    const s6 = { fGHz: Float64Array.of(1, 2), re: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => new Float64Array(2))), im: Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => new Float64Array(2))), method: 'full' as const, maxPassiveIncidentRatio: 0 };
    for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) { s6.re[a][b].fill(0.9); s6.re[b][a].fill(0.9); }
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(proposePairs(s6, ids, ids.map((_, k) => ({ xMm: k, yMm: 0 })))).toHaveProperty('reason');
  });

  it('stops a two-port file at its noise parameters', () => {
    const text = '# GHz S RI R 50\n1 0 0 1 0 1 0 0 0\n2 0 0 1 0 1 0 0 0\n! noise\n1 1.2 0.3 20 0.4\n2 1.5 0.3 25 0.4\n';
    expect(parseTouchstone(text, 2).s.fGHz).toEqual(Float64Array.of(1, 2));
  });

  it('gives mixed-mode S but no TDR or delay on an unevenly spaced band', () => {
    const s = twoLines();
    const log = { ...s, fGHz: Float64Array.from(s.fGHz, (f, m) => f * (1 + 0.001 * m)) };
    const report = analyseDifferential(log, [50, 50, 50, 50], [{ id: 'D1', positive: 0, negative: 1 }, { id: 'D2', positive: 2, negative: 3 }]);
    expect(report.timeDomainProblem).toMatch(/not evenly spaced/);
    expect(report.throughs[0].timing).toBeNull();
    expect(report.ends[0].differentialTdr).toBeNull();
  });

  it('writes exact zeros as a dB floor, not null', () => {
    const s = twoLines();
    const specs = [{ id: 'D1', positive: 0, negative: 1 }, { id: 'D2', positive: 2, negative: 3 }];
    // Two identical lines: conversion is exactly zero.
    const same = { ...s, re: s.re.map((row, i) => row.map((c, j) => (i % 2 === 1 && j % 2 === 1 ? s.re[i - 1][j - 1] : c))), im: s.im.map((row, i) => row.map((c, j) => (i % 2 === 1 && j % 2 === 1 ? s.im[i - 1][j - 1] : c))) };
    const json = differentialJson(analyseDifferential(same, [50, 50, 50, 50], specs), ['1', '2', '3', '4'], specs, [1]);
    const scd = json.terms.find((t) => t.name === 'Scd21')!;
    expect(scd.max_db).toBe(-300);
    expect(JSON.parse(JSON.stringify(json)).curves.Scd21.every((x: unknown) => typeof x === 'number')).toBe(true);
  });

  it('does not read a line impedance off a line shorter than the TDR rise time', () => {
    // 0.1 ns lines, but a band to 3 GHz only: a rise time of about 330 ps.
    const s = twoLines();
    const cut = (a: Float64Array | null) => a!.subarray(0, 30);
    const short = { ...s, fGHz: s.fGHz.subarray(0, 30), re: s.re.map((r) => r.map(cut)), im: s.im.map((r) => r.map(cut)) };
    const report = analyseDifferential(short, [50, 50, 50, 50], [{ id: 'D1', positive: 0, negative: 1 }, { id: 'D2', positive: 2, negative: 3 }]);
    expect(report.ends[0].lineDifferentialOhm).toBeNull();
    expect(report.throughs[0].timing).not.toBeNull();
  });
});
