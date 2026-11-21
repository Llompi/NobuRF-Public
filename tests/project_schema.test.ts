import { describe, expect, it } from 'vitest';
import { applyProjectEdit, type ProjectEdit } from '../src/project/edits';
import { evaluate, evaluateLength, ExpressionError } from '../src/project/expression';
import { rasterise } from '../src/project/rasterise';
import { parseProject, ProjectError } from '../src/project/schema';
import { exampleJson } from './project_fixtures';

const noVariables = (name: string): never => {
  throw new ExpressionError(`unknown variable "${name}"`);
};

describe('length expressions', () => {
  it.each([
    ['1.5 mm', 1.5, 1],
    ['1.5mm', 1.5, 1],
    ['2', 2, 0],
    ['1 in', 25.4, 1],
    ['10 mil', 0.254, 1],
    ['250 um + 0.25 mm', 0.5, 1],
    ['1 mm + 2 * 3 mm', 7, 1],
    ['(1 mm + 2 mm) * 3', 9, 1],
    ['-(4 mm) / 2', -2, 1],
    ['3 mm * 2 mm', 6, 2],
    ['1e-1 cm', 1, 1],
  ])('%s = %d (length^%d)', (source, value, dim) => {
    const q = evaluate(source, noVariables);
    expect(q.value).toBeCloseTo(value, 12);
    expect(q.dim).toBe(dim);
  });

  it('reads variables through the lookup', () => {
    const vars: Record<string, { value: number; dim: number }> = { w: { value: 16, dim: 1 }, k: { value: 0.5, dim: 0 } };
    expect(evaluateLength('-w / 2 - 1 mm', (n) => vars[n])).toBe(-9);
    expect(evaluateLength('w * k', (n) => vars[n])).toBe(8);
  });

  it.each([
    ['1 mm + 2', /cannot add a length and a plain number/],
    ['1 furlong', /unknown unit "furlong"/],
    ['1 constructor', /unknown unit "constructor"/],
    ['mm', /unit "mm" must follow a number/],
    ['1 mm / 0', /division by zero/],
    ['(1 mm', /missing "\)"/],
    ['1 mm +', /ends unexpectedly/],
    ['1 mm 2', /trailing input/],
    ['1 mm; process.exit()', /unexpected character ";"/],
    ['constructor', /unknown variable "constructor"/],
    ['', /empty expression/],
    ['1e400 mm', /does not evaluate to a finite number/],
    ['1e200 mm * 1e200', /does not evaluate to a finite number/],
    ['('.repeat(20_000) + '1 mm' + ')'.repeat(20_000), /nests parentheses or signs more than 100 deep/],
    ['-'.repeat(20_000) + '1 mm', /nests parentheses or signs more than 100 deep/],
  ])('rejects %j', (source, message) => {
    expect(() => evaluate(source, noVariables)).toThrow(ExpressionError);
    expect(() => evaluate(source, noVariables)).toThrow(message);
  });

  it('requires a length where a length is expected', () => {
    expect(() => evaluateLength('1.5', noVariables)).toThrow(/has no unit/);
    expect(() => evaluateLength('2 mm * 2 mm', noVariables)).toThrow(/length\^2, expected a length/);
  });
});

describe('project schema', () => {
  it('parses the demo project', () => {
    const p = parseProject(exampleJson());
    expect(p.stackup.map((l) => l.name)).toEqual(['gnd', 'core', 'top']);
    expect(p.geometry.top.map((s) => s.id)).toEqual(['patch', 'feed']);
  });

  it.each<[string, (j: Record<string, any>) => void, RegExp]>([
    ['a bare number as a length', (j) => { j.stackup[1].thickness = 1.5; }, /\$\.stackup\[1\]\.thickness: bare number 1\.5 is not a length; write it with a unit, e\.g\. "1\.5 mm"/],
    ['a length without a unit', (j) => { j.mesh.cell = '0.5'; }, /\$\.mesh\.cell: "0\.5" has no unit/],
    ['an unknown key', (j) => { j.mesh.cells = 3; }, /\$\.mesh\.cells: unknown key \(allowed: cell, air_margin_cells, graded, conformal\)/],
    ['an unknown top-level key', (j) => { j.comments = 'hi'; }, /\$\.comments: unknown key/],
    ['a missing key', (j) => { delete j.analysis.n_freq; }, /\$\.analysis\.n_freq: is required/],
    ['a bad unit', (j) => { j.stackup[1].thickness = '1.5 furlong'; }, /\$\.stackup\[1\]\.thickness: unknown unit "furlong"/],
    ['an undefined variable', (j) => { j.geometry.top[0].polygon[0][0] = '-patch_q / 2'; }, /\$\.geometry\.top\[0\]\.polygon\[0\]\[0\]: unknown variable "patch_q"/],
    ['an inherited property as a variable', (j) => { j.ports[0].x = 'toString'; }, /\$\.ports\[0\]\.x: unknown variable "toString"/],
    ['an inherited property as a material', (j) => { j.stackup[1].material = 'toString'; }, /unknown material "toString"/],
    ['a variable cycle', (j) => { j.variables.a = { value: 'b' }; j.variables.b = { value: 'a + 1 mm' }; }, /cycle: a -> b -> a/],
    ['a variable out of range', (j) => { j.variables.patch_w.value = '30 mm'; }, /\$\.variables\.patch_w\.value: "30 mm" is above its max "board_w - 1 mm"/],
    ['a unit as a variable name', (j) => { j.variables.mm = { value: '1' }; }, /\$\.variables\.mm: "mm" is a unit/],
    ['another schema version', (j) => { j.noburf_project = 2; }, /\$\.noburf_project: unsupported schema version 2/],
    ['an unknown material', (j) => { j.stackup[1].material = 'unobtainium'; }, /\$\.stackup\[1\]\.material: unknown material "unobtainium"/],
    ['a conductor as a dielectric', (j) => { j.stackup[1].material = 'copper'; }, /is a conductor/],
    ['a redefined built-in material', (j) => { j.materials['FR-4'] = { eps_r: 4, tan_delta: 0 }; }, /built-in material/],
    ['geometry on a missing layer', (j) => { j.geometry.inner = []; }, /\$\.geometry\.inner: "inner" is not a copper layer/],
    ['a copper layer without geometry', (j) => { delete j.geometry.gnd; }, /copper layer "gnd" has no entry/],
    ['a duplicate shape id', (j) => { j.geometry.top[1].id = 'patch'; }, /duplicate shape id "patch"/],
    ['a degenerate polygon', (j) => { j.geometry.top[0].polygon = [['0 mm', '0 mm'], ['1 mm', '1 mm'], ['2 mm', '2 mm']]; }, /zero area/],
    ['a port on a missing layer', (j) => { j.ports[0].between = ['gnd', 'inner']; }, /\$\.ports\[0\]\.between\[1\]: "inner" is not a copper layer/],
    ['a bad boundary', (j) => { j.boundaries.z_max = { type: 'open' }; }, /\$\.boundaries\.z_max\.type: must be "pml" or "pec"/],
    ['an infinite length', (j) => { j.variables.patch_w.value = '1e400 mm'; }, /\$\.variables\.patch_w\.value: "1e400 mm" does not evaluate to a finite number/],
    ['an infinite vertex', (j) => { j.geometry.top[0].polygon[0][0] = '1e300 mm * 1e300'; }, /\$\.geometry\.top\[0\]\.polygon\[0\]\[0\]: .* finite/],
    ['no air between board and PML', (j) => { j.mesh.air_margin_cells.xy = 0; }, /\$\.mesh\.air_margin_cells\.xy: needs at least 1 cell of air/],
    ['no air above the top copper', (j) => { j.mesh.air_margin_cells.above = 0; }, /\$\.mesh\.air_margin_cells\.above: needs at least 1 cell of air/],
    ['a "__proto__" variable', (j) => { j.variables = JSON.parse('{"__proto__": {"value": "1 mm"}}'); }, /\$\.variables\.__proto__: "__proto__" is a reserved name/],
    ['a "__proto__" geometry layer', (j) => { j.geometry = JSON.parse('{"__proto__": []}'); }, /\$\.geometry\.__proto__: "__proto__" is a reserved name/],
    ['a line break in the name', (j) => { j.name = 'patch\n# GHz S RI R 1'; }, /\$\.name: must not contain control characters/],
    ['a Z_in point outside the band', (j) => { j.outputs.zin_at_ghz = [9]; }, /\$\.outputs\.zin_at_ghz\[0\]: 9 is out of range/],
    ['a far-field point outside the band', (j) => { j.mesh.air_margin_cells.xy = 4; j.outputs.far_field_ghz = [9]; }, /\$\.outputs\.far_field_ghz\[0\]: 9 is out of range/],
    ['an empty far-field list', (j) => { j.mesh.air_margin_cells.xy = 4; j.outputs.far_field_ghz = []; }, /\$\.outputs\.far_field_ghz: needs 1 to 16 frequencies, got 0/],
    ['a far field with a pec face', (j) => { j.mesh.air_margin_cells.xy = 4; j.boundaries.z_min = { type: 'pec' }; j.outputs.far_field_ghz = [5.8]; }, /\$\.boundaries\.z_min: the far field needs a PML on every face/],
    ['a far field without room for its box', (j) => { j.outputs.far_field_ghz = [5.8]; }, /\$\.mesh\.air_margin_cells\.xy: the far field needs at least 4 cells of air/],
    ['an empty near-field scan list', (j) => { j.outputs.near_field_mm = []; }, /\$\.outputs\.near_field_mm: needs 1 to 4 heights, got 0/],
    ['a near-field scan at zero height', (j) => { j.outputs.near_field_mm = [0]; }, /\$\.outputs\.near_field_mm\[0\]: 0 is out of range/],
    ['repeated near-field heights', (j) => { j.outputs.near_field_mm = [3, 3]; }, /\$\.outputs\.near_field_mm: heights repeat in \[3, 3\]/],
  ])('rejects %s', (_name, mutate, message) => {
    const json = exampleJson();
    mutate(json);
    expect(() => parseProject(json)).toThrow(ProjectError);
    expect(() => parseProject(json)).toThrow(message);
  });
});

describe('project edits', () => {
  const base = () => {
    const json = exampleJson();
    json.variables.port_gap = { value: 'feed_w / 2', locked: true }; // a lock on a derived value
    return parseProject(json);
  };
  const notch: ProjectEdit = {
    op: 'add_polygon',
    layer: 'top',
    index: 1, // below the feed line, which is painted last so the notch cannot cut it
    shape: { id: 'inset_notch', op: 'cut', polygon: [['-2.25 mm', '-6.2 mm'], ['2.25 mm', '-6.2 mm'], ['2.25 mm', '-2.2 mm'], ['-2.25 mm', '-2.2 mm']] },
  };

  it.each<[string, ProjectEdit]>([
    ['set_variable', { op: 'set_variable', name: 'patch_l', value: '11.6 mm' }],
    ['add_polygon', notch],
    ['remove_polygon', { op: 'remove_polygon', id: 'patch' }],
    ['move_port', { op: 'move_port', id: 'feed', x: '0 mm', y: '-10 mm' }],
  ])('%s applies, leaves the input alone, and undoes exactly', (_name, edit) => {
    const before = base();
    const snapshot = structuredClone(before);
    const { project, undo } = applyProjectEdit(before, edit);
    expect(project).not.toEqual(before);
    expect(before).toEqual(snapshot);
    expect(applyProjectEdit(project, undo).project).toEqual(before);
  });

  it('an edit changes the rasterised model and its undo restores it', () => {
    const before = base();
    const { project, undo } = applyProjectEdit(before, { op: 'set_variable', name: 'patch_l', value: '11.6 mm' });
    const signature = rasterise(before).model.signature;
    expect(rasterise(project).model.signature).not.toBe(signature);
    expect(rasterise(applyProjectEdit(project, undo).project).model.signature).toBe(signature);
  });

  it('remove_polygon undo puts the shape back at its paint position', () => {
    const { project, undo } = applyProjectEdit(base(), { op: 'remove_polygon', id: 'patch' });
    expect(undo).toMatchObject({ op: 'add_polygon', layer: 'top', index: 0 });
    expect(applyProjectEdit(project, undo).project.geometry.top.map((s) => s.id)).toEqual(['patch', 'feed']);
  });

  it.each<[string, unknown, RegExp]>([
    ['a locked variable', { op: 'set_variable', name: 'board_w', value: '30 mm' }, /edit\.name: variable "board_w" is locked/],
    ['a locked variable (via the variable it depends on)', { op: 'set_variable', name: 'feed_w', value: '2 mm' }, /edit: would change locked variable "port_gap" from 1.25 mm to 1 mm/],
    ['an unknown variable', { op: 'set_variable', name: 'nope', value: '1 mm' }, /no variable "nope"/],
    ['a value out of range', { op: 'set_variable', name: 'patch_w', value: '40 mm' }, /\$\.variables\.patch_w\.value: "40 mm" is above its max/],
    ['a bare number', { op: 'move_port', id: 'feed', x: 0, y: '-10 mm' }, /edit\.x: bare number 0/],
    ['an unknown op', { op: 'rotate', id: 'patch' }, /edit\.op: must be set_variable/],
    ['an unknown key', { op: 'remove_polygon', id: 'patch', why: 'x' }, /edit\.why: unknown key/],
    ['a missing shape', { op: 'remove_polygon', id: 'nope' }, /no shape "nope"/],
    ['a duplicate shape id', { ...notch, shape: { ...notch.shape, id: 'feed' } }, /duplicate shape id "feed"/],
    ['an index past the end', { ...notch, index: 5 }, /edit\.index: 5 is past the end/],
  ])('rejects %s', (_name, edit, message) => {
    expect(() => applyProjectEdit(base(), edit)).toThrow(ProjectError);
    expect(() => applyProjectEdit(base(), edit)).toThrow(message);
  });
});
