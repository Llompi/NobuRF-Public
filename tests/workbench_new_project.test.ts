import { describe, expect, it } from 'vitest';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import * as actions from '../src/workbench/doc_actions';
import { MATERIAL_LIBRARY } from '../src/workbench/material_library';
import { defaultBoardMm, newProject, patchNote, withoutUnusedVariables } from '../src/workbench/new_project';
import { insetDepthMm, patchEdgeResistanceOhm } from '../src/design/patch_template';
import { csvFile, touchstoneFile } from '../src/workbench/export';
import type { WorkbenchResult } from '../src/workbench/solve';
import { snap } from '../src/workbench/draw_tool';

describe('new project templates', () => {
  it.each(['patch', 'line'] as const)('%s: valid, meshes, and keeps only the variables it uses', (template) => {
    const p = newProject({ template, name: 'test', frequencyGHz: 2.45, substrate: 'RO4350B', thicknessMm: 0.762 });
    expect(p.materials).toEqual({ RO4350B: { eps_r: 3.66, tan_delta: 0.0037 } });
    expect(p.stackup[1]).toMatchObject({ material: 'RO4350B', thickness: '0.762 mm' });
    expect(() => rasterise(p)).not.toThrow();
    const used = JSON.stringify({ ...p, variables: {} });
    for (const name of Object.keys(p.variables)) expect(used).toMatch(new RegExp(`\\b${name}\\b`));
    expect(p.ports.length).toBe(template === 'line' ? 2 : 1);
  });

  it('patch: a wide feed on a narrow board is not refused by the removed stub feature\'s bounds', () => {
    // board_w - feed_w < 8 mm: the agent's stub_l max (board_w / 2 - feed_w / 2 - 1 mm) falls below its 3 mm start.
    const p = newProject({ template: 'patch', name: 'narrow', frequencyGHz: 10, substrate: 'RT/duroid 5880', thicknessMm: 1.588, boardWMm: 12 });
    expect(p.variables).not.toHaveProperty('stub_l');
    expect(() => rasterise(p)).not.toThrow();
  });

  it('patch: builds the Balanis Example 14.1 patch, whose 50 ohm feed is wider than a third of the patch', () => {
    const p = newProject({ template: 'patch', name: 'balanis', frequencyGHz: 10, substrate: 'RT/duroid 5880', thicknessMm: 1.588 });
    // Balanis eq. 14-6 to 14-7: W = 11.86 mm, L = 9.06 mm.
    expect(Number.parseFloat(p.variables.patch_w.value)).toBeCloseTo(11.86, 1);
    expect(Number.parseFloat(p.variables.patch_l.value)).toBeCloseTo(9.06, 1);
    expect(Number.parseFloat(p.variables.feed_w.value)).toBeGreaterThan(11.86 / 3);
    // Balanis Examples 14.2 and 14.3: 228 ohm at the edge, a 3.126 mm inset for 50 ohm.
    expect(Number.parseFloat(p.variables.inset_d.value)).toBeCloseTo(3.126, 2);
    expect(p.variables.inset_gap.value).toBe('1 mm');
    expect(p.geometry.top.map((s) => s.id)).toEqual(['patch', 'inset_left', 'inset_right', 'feed', 'inset_feed']);
    expect(() => rasterise(p)).not.toThrow();
  });

  it('patch: edge resistance and inset depth match Balanis Examples 14.2 and 14.3', () => {
    const edge = patchEdgeResistanceOhm(10, 11.86, 9.06);
    expect(edge).toBeCloseTo(228.3, 0);
    expect(insetDepthMm(edge, 9.06, 50)).toBeCloseTo(3.126, 2);
    expect(insetDepthMm(40, 9.06, 50)).toBeNull();
  });

  it('patch: says where its numbers come from, and that both are starting points', () => {
    const note = patchNote({ template: 'patch', frequencyGHz: 10, substrate: 'RT/duroid 5880', thicknessMm: 1.588 });
    expect(note).toMatch(/^Patch 11\.85 mm × 9\.05 mm from the transmission-line model .* edge resistance 22\d Ω, so a 3\.1\d mm inset for 50 Ω/);
    expect(note).toMatch(/the resonance lands a few percent off 10 GHz and the inset depth usually needs adjusting/);
  });

  it('patch: narrows the inset gap on a small patch, so a 28 GHz patch keeps its inset', () => {
    const spec = { template: 'patch' as const, frequencyGHz: 28, substrate: 'RT/duroid 5880', thicknessMm: 0.254 };
    const p = newProject({ ...spec, name: 'mmwave' });
    // A 4.23 mm patch with a 0.78 mm feed: (4.23 - 0.78) / 6 = 0.575 mm each side, above the template's 0.5 mm least gap.
    expect(Number.parseFloat(p.variables.inset_gap.value)).toBeCloseTo(0.575, 2);
    expect(p.geometry.top.map((s) => s.id)).toEqual(['patch', 'inset_left', 'inset_right', 'feed', 'inset_feed']);
    expect(() => rasterise(p)).not.toThrow();
    expect(patchNote(spec)).toMatch(/inset for 50 Ω/);
  });

  it('patch: a board too narrow for an inset gets an edge feed, and the note blames the board', () => {
    const spec = { template: 'patch' as const, frequencyGHz: 10, substrate: 'RT/duroid 5880', thicknessMm: 0.787, boardWMm: 7 };
    const p = newProject({ ...spec, name: 'narrow' });
    expect(p.geometry.top.map((s) => s.id)).toEqual(['patch', 'feed']);
    expect(p.variables.inset_d).toBeUndefined();
    expect(() => rasterise(p)).not.toThrow();
    const note = patchNote(spec);
    expect(note).toMatch(/The 5\.00 mm patch leaves no room for an inset beside the 2\.\d\d mm feed/);
    expect(note).toMatch(/The board holds the patch below the 11\.\d\d mm × 9\.\d\d mm the formulas ask for\. Use a larger board/);
    expect(note).not.toMatch(/few percent|pulls the resonance/);
  });

  it('patch: a board that shortens the patch says the resonance lands high, not a few percent off', () => {
    const note = patchNote({ template: 'patch', frequencyGHz: 10, substrate: 'RT/duroid 5880', thicknessMm: 1.588, boardLMm: 12 });
    expect(note).toMatch(/× 6\.00 mm .* so expect the resonance above 10 GHz\. Use a larger board/);
    expect(note).not.toMatch(/few percent/);
  });

  it('patch: refuses a feed wider than half the patch, without suggesting a board that would not help', () => {
    expect(() => newProject({ template: 'patch', name: 'thick', frequencyGHz: 10, substrate: 'PTFE', thicknessMm: 3.2 }))
      .toThrow(/more than half the .* mm patch\. Use a thinner substrate\.$/);
  });

  it('blank: an empty top layer and no port, and a valid project once copper and a port are added', () => {
    const p = newProject({ template: 'blank', name: 'blank', frequencyGHz: 2.45, substrate: 'RO4350B', thicknessMm: 0.762 });
    expect(p.geometry.top).toEqual([]);
    expect(p.ports).toEqual([]);
    expect(Object.keys(p.variables).sort()).toEqual(['board_l', 'board_w']);
    expect(() => parseProject(p)).toThrow(/at least one port/);
    p.geometry.top = [{ id: 'strip', op: 'add', polygon: [['-1 mm', '-20 mm'], ['1 mm', '-20 mm'], ['1 mm', '20 mm'], ['-1 mm', '20 mm']] }];
    p.ports = [{ id: 'p1', x: '0 mm', y: '-19 mm', between: ['gnd', 'top'], reference_impedance_ohm: 50 }];
    expect(() => rasterise(parseProject(p))).not.toThrow();
  });

  it('sizes the line strip with the 50 ohm width and the board from the frequency', () => {
    const p = newProject({ template: 'line', name: 'line', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 1.6 });
    // Hammerstad: about 3.06 mm on 1.6 mm FR-4.
    expect(parseFloat(p.variables.line_w.value)).toBeCloseTo(3.06, 1);
    expect(defaultBoardMm({ template: 'line', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 1.6 })).toEqual({ w: 23, l: 20 });
  });

  it('takes a given board size over the automatic one', () => {
    const p = newProject({ template: 'patch', name: 'p', frequencyGHz: 5.8, substrate: 'FR-4', thicknessMm: 1.6, boardWMm: 30, boardLMm: 32 });
    expect(p.variables.board_w.value).toBe('30 mm');
    expect(p.variables.board_l.value).toBe('32 mm');
  });

  it('drops variables nothing refers to, including chains of them', () => {
    const p = newProject({ template: 'line', name: 'l', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 1.6 });
    p.variables.a = { value: 'b * 2' };
    p.variables.b = { value: '1 mm' };
    expect(Object.keys(withoutUnusedVariables(p).variables)).not.toContain('a');
    expect(Object.keys(withoutUnusedVariables(p).variables)).not.toContain('b');
  });
});

describe('material library', () => {
  it('has unique names that are not built in, and values the schema accepts', () => {
    const names = MATERIAL_LIBRARY.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    const p = newProject({ template: 'line', name: 'l', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 1.6 });
    let doc = p;
    for (const name of names) doc = actions.useLibraryMaterial(doc, name);
    expect(Object.keys(parseProject(doc).materials).sort()).toEqual([...names].sort());
  });

  it('keeps a project material that already has the name', () => {
    const p = newProject({ template: 'line', name: 'l', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 1.6 });
    p.materials.RO4350B = { eps_r: 3.48, tan_delta: 0.004 };
    expect(actions.useLibraryMaterial(p, 'RO4350B').materials.RO4350B).toEqual({ eps_r: 3.48, tan_delta: 0.004 });
  });
});

describe('board outline edits', () => {
  it('adds and removes outline points', () => {
    const p = newProject({ template: 'line', name: 'l', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 1.6 });
    const more = actions.addPoint(p, 'board', 1);
    expect(more.board.outline.length).toBe(5);
    expect(more.board.outline[2]).toEqual(more.board.outline[1]);
    expect(actions.removePoint(more, 'board', 2).board.outline).toEqual(p.board.outline);
  });
});

describe('result export', () => {
  const twoPort = (complete: boolean): WorkbenchResult => {
    const f = Float64Array.of(1, 2);
    const v = (x: number) => Float64Array.of(x, x);
    return {
      projectName: 'two port', portIds: ['a', 'b'], z0: [50, 50], solver: 'CPU reference solver',
      s: { fGHz: f, re: [[v(0.1), complete ? v(0.9) : null], [v(0.9), complete ? v(0.1) : null]], im: [[v(0), complete ? v(0) : null], [v(0), complete ? v(0) : null]], method: 'full', maxPassiveIncidentRatio: 0 },
      runs: [{ portId: 'a', spectrum: { fGHz: f, zRe: v(50), zIm: v(1) } }],
    } as unknown as WorkbenchResult;
  };

  it('writes Touchstone only for a full matrix', () => {
    const file = touchstoneFile(twoPort(true))!;
    expect(file.fileName).toBe('two_port.s2p');
    expect(file.text.split('\n')[1]).toBe('# GHz S RI R 50');
    expect(touchstoneFile(twoPort(false))).toBeNull();
  });

  it('writes a CSV row per frequency with dB, degrees and Z', () => {
    const lines = csvFile(twoPort(false)).text.trim().split('\n');
    expect(lines[0]).toBe('f GHz,S11 dB (50 ohm),S11 deg (50 ohm),S21 dB (50 ohm),S21 deg (50 ohm),Re Z ohm,Im Z ohm');
    expect(lines.length).toBe(3);
    expect(Number(lines[1].split(',')[1])).toBeCloseTo(-20, 6);
  });
});

describe('port type', () => {
  const lineWithEdgeCopper = () => {
    const p = newProject({ template: 'line', name: 'l', frequencyGHz: 5, substrate: 'FR-4', thicknessMm: 1.6 });
    // The connectors launch onto copper that reaches both board edges.
    p.geometry.top[0].polygon = [['-line_w / 2', '-board_l / 2'], ['line_w / 2', '-board_l / 2'], ['line_w / 2', 'board_l / 2'], ['-line_w / 2', 'board_l / 2']];
    return p;
  };

  it('switches a lumped port to an SMA edge connector and back', () => {
    const p = lineWithEdgeCopper();
    const sma = actions.setPortKind(p, 0, 'sma_edge');
    expect(sma.ports[0]).toEqual({ kind: 'sma_edge', id: 'p1', edge: 'y_min', x: '0 mm', between: ['top', 'gnd'], reference_impedance_ohm: 50 });
    expect(sma.boundaries.y_min).toEqual({ type: 'pml', cells: 8 });
    expect(sma.mesh.graded).toBeDefined();
    const back = actions.setPortKind(sma, 0, 'lumped');
    expect(back.ports[0]).toMatchObject({ id: 'p1', x: '0 mm', between: ['gnd', 'top'] });
    expect(back.ports[0]).not.toHaveProperty('kind');
  });

  it('puts an SMA connector on each end of a two-port line, and the project meshes', () => {
    const p = lineWithEdgeCopper();
    // Each port lands on the board edge nearest it, so the two connectors don't collide.
    const sma = actions.setPortKind(actions.setPortKind(p, 0, 'sma_edge'), 1, 'sma_edge');
    expect(sma.ports.map((port) => (port as { edge: string }).edge)).toEqual(['y_min', 'y_max']);
    expect(sma.ports[1]).toMatchObject({ kind: 'sma_edge', edge: 'y_max', x: '0 mm' });
    expect(sma.boundaries.y_max).toEqual({ type: 'pml', cells: 8 });
    const { coaxPorts } = rasterise(parseProject(sma));
    expect(coaxPorts.map((c) => c.port)).toEqual([0, 1]);
  });

  it('keeps the edge position when an SMA connector becomes a lumped port', () => {
    const sma = actions.setPortKind(actions.setPortKind(lineWithEdgeCopper(), 0, 'sma_edge'), 1, 'sma_edge');
    const back = actions.setPortKind(actions.setPortKind(sma, 0, 'lumped'), 1, 'lumped');
    const ys = back.ports.map((port) => parseFloat((port as { y: string }).y));
    expect(ys[0]).toBeLessThan(0);
    expect(ys[1]).toBeCloseTo(-ys[0], 6);
    expect(() => rasterise(parseProject(back))).not.toThrow();
  });

  it('moves an SMA connector to an x edge with its offset along the new edge as y', () => {
    const sma = actions.setPortKind(lineWithEdgeCopper(), 0, 'sma_edge');
    const moved = actions.setSmaEdge(sma, 0, 'x_max');
    expect(moved.ports[0]).toEqual({ kind: 'sma_edge', id: 'p1', edge: 'x_max', y: '0 mm', between: ['top', 'gnd'], reference_impedance_ohm: 50 });
    expect(moved.boundaries.x_max).toEqual({ type: 'pml', cells: 8 });
  });

  it('switches a lumped port to a coax probe through the bottom copper', () => {
    const p = newProject({ template: 'patch', name: 'p', frequencyGHz: 2.45, substrate: 'FR-4', thicknessMm: 1.6 });
    const probe = actions.setPortKind(p, 0, 'coax_probe');
    expect(probe.ports[0]).toMatchObject({ kind: 'coax_probe', x: p.ports[0].x, y: (p.ports[0] as { y: string }).y, between: ['top', 'gnd'] });
    expect(probe.boundaries.z_min).toEqual({ type: 'pml', cells: 8 });
    expect(rasterise(parseProject(probe)).coaxPorts).toHaveLength(1);
  });
});

describe('drawing with the mouse', () => {
  const blank = () => newProject({ template: 'blank', name: 'drawn', frequencyGHz: 2.45, substrate: 'FR-4', thicknessMm: 1.6 });

  it('snaps to the 0.1 mm grid without float noise', () => {
    expect(snap(1.2345)).toBe(1.2);
    expect(snap(-0.05001)).toBe(-0.1);
    expect(snap(0.30000000000000004)).toBe(0.3);
  });

  it('turns a drawn shape and a clicked port into a project that solves', () => {
    let { doc } = actions.addDrawnShape(blank(), 'top', [[-1, -20], [1, -20], [1, 20], [-1, 20]]);
    ({ doc } = actions.addDrawnShape(doc, 'top', [[-5, 22], [5, 22], [0, 25.5]]));
    expect(doc.geometry.top.map((s) => s.id)).toEqual(['top_shape', 'top_shape_2']);
    expect(doc.geometry.top[0].polygon[0]).toEqual(['-1 mm', '-20 mm']);
    const placed = actions.addPortAt(doc, 'top', [0, -19.5]);
    expect(placed.doc.ports[placed.index]).toMatchObject({ x: '0 mm', y: '-19.5 mm', between: ['gnd', 'top'] });
    expect(() => rasterise(parseProject(placed.doc))).not.toThrow();
  });

  it('places a port on the bottom layer up to the next layer, and refuses a shape with two corners', () => {
    const placed = actions.addPortAt(blank(), 'gnd', [0, 0]);
    expect(placed.doc.ports[placed.index]).toMatchObject({ between: ['gnd', 'top'] });
    expect(() => actions.addDrawnShape(blank(), 'top', [[0, 0], [1, 1]])).toThrow(/three corners/);
  });
});

describe('drawn outlines', () => {
  const blank = () => newProject({ template: 'blank', name: 'drawn', frequencyGHz: 2.45, substrate: 'FR-4', thicknessMm: 1.6 });
  it.each([
    ['three corners in a line', [[0, 0], [1, 1], [2, 2]]],
    ['a bowtie', [[0, 0], [2, 2], [2, 0], [0, 2]]],
    ['a lopsided bowtie', [[0, 0], [4, 2], [4, 0], [0, 3]]],
  ])('refuses %s', (_, points) => {
    expect(() => actions.addDrawnShape(blank(), 'top', points as Array<[number, number]>)).toThrow(/crosses itself or has no area/);
  });
  it.each([
    ['a concave outline', [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]]],
    ['an inset-fed patch, with collinear edges that do not touch', [[0, 0], [1, 0], [1, 1], [2, 1], [2, 0], [3, 0], [3, 2], [0, 2]]],
  ])('accepts %s', (_, points) => {
    expect(() => actions.addDrawnShape(blank(), 'top', points as Array<[number, number]>)).not.toThrow();
  });
  it.each([
    ['collinear edges that overlap', [[0, 0], [3, 0], [3, 1], [2, 1], [2, 0], [1, 0], [1, 2], [0, 2]]],
    ['a corner resting on another edge', [[0, 0], [4, 0], [4, 2], [2, 0.0], [0, 2]]],
  ])('refuses %s', (_, points) => {
    expect(() => actions.addDrawnShape(blank(), 'top', points as Array<[number, number]>)).toThrow(/crosses itself/);
  });
});
