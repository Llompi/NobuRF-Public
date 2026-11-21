import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { projectFor, tuningDesignFromProject, unboundedVariables } from '../src/design/design_file';
import { resolveProject } from '../src/project/resolve';
import { parseProject, type CopperShape, type Project } from '../src/project/schema';
import * as actions from '../src/workbench/doc_actions';

const example = (): Project => JSON.parse(readFileSync('examples/patch-5g8-graded.json', 'utf8'));
const goal = { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 };
type Corner = [string, string];

/** The example with a plain rectangle added on top, as the mouse tool or an import would write it. */
function withRectangle(polygon: Corner[], id = 'top_shape', op: 'add' | 'cut' = 'add'): { doc: Project; index: number } {
  const doc = example();
  doc.geometry.top.push({ id, op, polygon });
  return { doc, index: doc.geometry.top.length - 1 };
}
const SMALL: Corner[] = [['3 mm', '-9 mm'], ['3 mm', '-6.5 mm'], ['5.25 mm', '-6.5 mm'], ['5.25 mm', '-9 mm']];

const corners = (doc: Project, index: number) => resolveProject(parseProject(doc)).copper.top[index].polygon;

/** The example with the rectangle made editable and given limits on its sizes. */
function editableWithLimits(): { doc: Project; index: number } {
  const { doc, index } = withRectangle(SMALL);
  const { doc: next } = actions.makeRectangleEditable(doc, 'top', index);
  Object.assign(next.variables.top_shape_dx, { min: '1 mm', max: '3 mm' });
  Object.assign(next.variables.top_shape_dy, { min: '1 mm', max: '3 mm' });
  return { doc: next, index };
}

describe('make a rectangle editable', () => {
  it('drives the rectangle by its sizes and a locked lower-left corner, and leaves the limits to the user', () => {
    const { doc, index } = withRectangle(SMALL);
    expect(actions.canMakeEditable(doc.geometry.top[index])).toBe(true);
    const { doc: next, variables } = actions.makeRectangleEditable(doc, 'top', index);
    expect(variables).toEqual(['top_shape_x', 'top_shape_dx', 'top_shape_y', 'top_shape_dy']);
    expect(next.variables.top_shape_dx).toEqual({ value: '2.25 mm' });
    expect(next.variables.top_shape_dy).toEqual({ value: '2.5 mm' });
    expect(next.variables.top_shape_x).toEqual({ value: '3 mm', locked: true });
    expect(next.variables.top_shape_y).toEqual({ value: '-9 mm', locked: true });
    expect(unboundedVariables(parseProject(next))).toEqual(expect.arrayContaining(['top_shape_dx', 'top_shape_dy']));
    expect(doc.geometry.top[index].polygon[0]).toEqual(['3 mm', '-9 mm']); // the input is not changed
  });

  it('keeps every corner of an imported rectangle at its 1 nm coordinates, in either winding', () => {
    const odd: Corner[] = [['-12.345677 mm', '-0.000001 mm'], ['7.000003 mm', '-0.000001 mm'], ['7.000003 mm', '4.999999 mm'], ['-12.345677 mm', '4.999999 mm']];
    for (const polygon of [odd, [...odd].reverse()]) {
      const { doc, index } = withRectangle(polygon, 'top-1');
      const { doc: next } = actions.makeRectangleEditable(doc, 'top', index);
      const after = corners(next, index).map(([x, y]) => [Math.round(x * 1e6), Math.round(y * 1e6)]);
      expect(after).toEqual(corners(doc, index).map(([x, y]) => [Math.round(x * 1e6), Math.round(y * 1e6)]));
      expect(corners(next, index)[polygon === odd ? 0 : 3]).toEqual(corners(doc, index)[polygon === odd ? 0 : 3]); // the anchor corner is exact
    }
  });

  it('keeps the chosen part fixed: an edge, or the middle', () => {
    const { doc, index } = withRectangle(SMALL);
    const { doc: next } = actions.makeRectangleEditable(doc, 'top', index, { x: 'max', y: 'mid' });
    expect(next.variables.top_shape_x).toEqual({ value: '5.25 mm', locked: true });
    expect(next.variables.top_shape_y).toEqual({ value: '-7.75 mm', locked: true });
    expect(corners(next, index)).toEqual(corners(doc, index));
    next.variables.top_shape_dx.value = '3 mm';
    next.variables.top_shape_dy.value = '3.5 mm';
    const p = corners(next, index);
    expect(Math.max(...p.map((c) => c[0]))).toBe(5.25);
    expect(Math.min(...p.map((c) => c[0]))).toBeCloseTo(2.25, 9);
    expect(Math.min(...p.map((c) => c[1]))).toBeCloseTo(-9.5, 9);
    expect(Math.max(...p.map((c) => c[1]))).toBeCloseTo(-6, 9);
  });

  it('attaches an edge touching a patch to the patch edge, so it follows when the patch changes', () => {
    const { doc, index } = withRectangle([['3 mm', '-9 mm'], ['5 mm', '-9 mm'], ['5 mm', '-6.2 mm'], ['3 mm', '-6.2 mm']]); // up to the patch's lower edge
    const { doc: next, variables, notes } = actions.makeRectangleEditable(doc, 'top', index);
    expect(variables).toEqual(['top_shape_x', 'top_shape_dx', 'top_shape_dy']); // the top edge is the patch's, no _y
    expect(notes.map((n) => n.text)).toEqual(['nothing touches it along x; kept its left edge', 'attached its top edge to shape "patch", so it follows it']);
    expect(next.geometry.top[index].polygon[2][1]).toBe('(-patch_l / 2)');
    expect(corners(next, index)).toEqual(corners(doc, index));
    next.variables.patch_l.value = '14 mm';
    const ys = corners(next, index).map((c) => c[1]);
    expect(Math.max(...ys)).toBeCloseTo(-7, 9); // still on the patch edge
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2.8, 9);
  });

  /** The example without its own feed line, so a drawn one is the only copper between the port and the patch. */
  function withoutFeed(polygon: Corner[]): { doc: Project; index: number } {
    const made = withRectangle(polygon, 'line');
    made.doc.geometry.top = made.doc.geometry.top.filter((s) => s.id !== 'feed');
    return { doc: made.doc, index: made.doc.geometry.top.length - 1 };
  }

  it('keeps a feed on both its port and its patch: its length follows them and is not tuned', () => {
    const { doc, index } = withoutFeed([['-1 mm', '-10 mm'], ['1 mm', '-10 mm'], ['1 mm', '-6.2 mm'], ['-1 mm', '-6.2 mm']]);
    const { doc: next, variables, notes } = actions.makeRectangleEditable(doc, 'top', index);
    expect(variables).toEqual(['line_x', 'line_dx']); // no length variable
    expect(next.geometry.top[index].polygon).toEqual([
      ['line_x', '(port_y)'], ['line_x + line_dx', '(port_y)'], ['line_x + line_dx', '(-patch_l / 2)'], ['line_x', '(-patch_l / 2)'],
    ]);
    expect(notes[1]).toEqual({ kind: 'info', text: 'its bottom and top edges touch port "feed" and shape "patch", so its size along y is not tuned; it follows port "feed" and shape "patch"' });
    next.variables.patch_l.value = '10 mm';
    next.variables.port_y.value = '-11 mm';
    const ys = corners(next, index).map((c) => c[1]);
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([-11, -5]);
    next.variables.line_dx = { value: '2 mm', min: '1 mm', max: '3 mm' };
    next.variables.feed_w.locked = true; // the removed feed was its only use
    expect(() => tuningDesignFromProject(parseProject(next), goal)).not.toThrow();
  });

  it('attaches to a port standing on an edge, and keeps the edge nearer a port inside the rectangle', () => {
    const onEdge = withoutFeed([['-1 mm', '-10 mm'], ['1 mm', '-10 mm'], ['1 mm', '-8 mm'], ['-1 mm', '-8 mm']]);
    const made = actions.makeRectangleEditable(onEdge.doc, 'top', onEdge.index);
    expect(made.notes.map((n) => n.text)).toContain('attached its bottom edge to port "feed", so it follows it');
    expect(made.doc.geometry.top[onEdge.index].polygon[0][1]).toBe('(port_y)');
    const inside = withoutFeed([['-1 mm', '-10.5 mm'], ['1 mm', '-10.5 mm'], ['1 mm', '-7 mm'], ['-1 mm', '-7 mm']]);
    const kept = actions.makeRectangleEditable(inside.doc, 'top', inside.index);
    expect(kept.notes.map((n) => n.text)).toContain('kept its bottom edge, the one nearer port "feed"; a large change can leave the port off the copper');
    expect(kept.variables).toContain('line_y');
  });

  it('never moves ground copper with a port, nor attaches to cuts or a duplicate lying on top', () => {
    const doc = example();
    doc.geometry.gnd.push({ id: 'pad', op: 'add', polygon: [['-1 mm', '-10 mm'], ['1 mm', '-10 mm'], ['1 mm', '-8 mm'], ['-1 mm', '-8 mm']] });
    const gnd = actions.makeRectangleEditable(doc, 'gnd', doc.geometry.gnd.length - 1);
    expect(JSON.stringify(gnd.doc.geometry.gnd.at(-1))).not.toContain('port_y');
    const { doc: withCut, index } = withRectangle(SMALL);
    withCut.geometry.top.push({ id: 'notch', op: 'cut', polygon: [['5.25 mm', '-9 mm'], ['6 mm', '-9 mm'], ['6 mm', '-8 mm'], ['5.25 mm', '-8 mm']] });
    expect(actions.makeRectangleEditable(withCut, 'top', index).notes.map((n) => n.text)).toContain('nothing touches it along x; kept its left edge');
    const { doc: dup } = actions.duplicateShape(withRectangle(SMALL).doc, 'top', index);
    expect(actions.makeRectangleEditable(dup, 'top', index + 1).variables).toHaveLength(4);
  });

  it('attaches nothing when the anchor is chosen, and says so when the project cannot be traced', () => {
    const { doc, index } = withRectangle([['3 mm', '-9 mm'], ['5 mm', '-9 mm'], ['5 mm', '-6.2 mm'], ['3 mm', '-6.2 mm']]);
    const chosen = actions.makeRectangleEditable(doc, 'top', index, { x: 'min', y: 'min' });
    expect(chosen.notes).toEqual([]);
    expect(chosen.variables).toHaveLength(4);
    doc.ports.push({ ...doc.ports[0] }); // a duplicate port id: the project does not resolve
    expect(actions.makeRectangleEditable(doc, 'top', index).notes[0].kind).toBe('warning');
  });

  it('resizes from the lower-left corner, and a size outside the range the user set is refused', () => {
    const { doc, index } = editableWithLimits();
    doc.variables.top_shape_dx.value = '2.5 mm';
    const xs = corners(doc, index).map((p) => p[0]);
    expect(Math.min(...xs)).toBe(3);
    expect(Math.max(...xs)).toBeCloseTo(5.5, 9);
    doc.variables.top_shape_dx.value = '4 mm';
    expect(() => resolveProject(parseProject(doc))).toThrow(/above its max/);
  });

  it('accepts a closed five-corner outline, cut shapes and mixed units', () => {
    const closed: Corner[] = [...SMALL, SMALL[0]];
    expect(actions.canMakeEditable({ id: 'c', op: 'add', polygon: closed })).toBe(true);
    const { doc, index } = withRectangle(SMALL, 'slot', 'cut');
    expect(actions.makeRectangleEditable(doc, 'top', index).doc.geometry.top[index].op).toBe('cut');
    const mixed: Corner[] = [['0 mm', '0 mm'], ['100 mil', '0 mm'], ['2.54 mm', '1 mm'], ['0 mm', '1 mm']];
    expect(actions.canMakeEditable({ id: 'm', op: 'add', polygon: mixed })).toBe(true);
  });

  it('names variables after imported shapes, whose ids are not variable names', () => {
    const { doc, index } = withRectangle(SMALL, 'top-3');
    expect(actions.makeRectangleEditable(doc, 'top', index).variables).toContain('top_3_dx');
    expect(actions.makeRectangleEditable(withRectangle(SMALL, '1').doc, 'top', index).variables).toContain('shape_1_dx');
    const { doc: first } = actions.makeRectangleEditable(doc, 'top', index);
    first.geometry.top.push({ ...structuredClone(doc.geometry.top[index]), id: 'top_3' }); // a second shape whose names would clash
    expect(actions.makeRectangleEditable(first, 'top', index + 1).variables).toContain('top_3_dx_2');
  });

  it('leaves shapes already sized by variables, and other outlines, alone', () => {
    const doc = example();
    for (const shape of doc.geometry.top) expect(actions.canMakeEditable(shape)).toBe(false); // the template patch uses patch_w
    const shape = (polygon: Corner[]): CopperShape => ({ id: 's', op: 'add', polygon });
    expect(actions.canMakeEditable(shape([['0 mm', '0 mm'], ['2 mm', '0 mm'], ['0 mm', '2 mm']]))).toBe(false);
    expect(actions.canMakeEditable(shape([['0 mm', '-1 mm'], ['1 mm', '0 mm'], ['0 mm', '1 mm'], ['-1 mm', '0 mm']]))).toBe(false);
    expect(() => actions.makeRectangleEditable(doc, 'top', 0)).toThrow(/already sized by variables/);
  });
});

describe('tuning a project from the workbench', () => {
  it('tunes exactly the unlocked length variables, within the limits the user set, on the project mesh', () => {
    const { doc } = editableWithLimits();
    const design = tuningDesignFromProject(parseProject(doc), goal);
    expect(design.goal).toEqual(goal);
    expect(design.features).toEqual({});
    expect(design.search).toEqual({ mesh: design.project.mesh, energy_decay_db: 30 });
    expect(() => projectFor(design, { enabled: [], values: { top_shape_dx: 2.5 } }, 'search')).not.toThrow();
    expect(() => projectFor(design, { enabled: [], values: { top_shape_dx: 5 } }, 'search')).toThrow(/above its max/);
    expect(() => projectFor(design, { enabled: [], values: { top_shape_x: 4 } }, 'search')).toThrow(/locked/);
  });

  it('works on every one-port example once its free variables have limits', () => {
    for (const file of readdirSync('examples').filter((f) => f.endsWith('.json'))) {
      const json = JSON.parse(readFileSync(`examples/${file}`, 'utf8'));
      if (json.noburf_project === undefined || json.ports?.length !== 1) continue;
      let project: Project;
      try {
        project = parseProject(json);
      } catch {
        continue; // an example that needs raw imports resolved elsewhere
      }
      const target = (project.analysis.f_min_ghz + project.analysis.f_max_ghz) / 2;
      try {
        tuningDesignFromProject(project, { ...goal, target_ghz: target });
      } catch (error) {
        // Only the refusals that name the user's own variables are allowed here, never a mesh or schema error.
        expect((error as Error).message, file).toMatch(/set a min and a max|computed from other variables|nothing to tune|nothing uses|sets? the mesh/);
      }
    }
  });

  it('refuses a variable without both limits instead of guessing them', () => {
    const doc = example();
    doc.variables.gap = { value: '1 mm', min: '0.2 mm' };
    doc.geometry.top[0].polygon[0][0] = `${doc.geometry.top[0].polygon[0][0]} - gap`;
    expect(unboundedVariables(parseProject(doc))).toEqual(['gap']);
    expect(() => tuningDesignFromProject(parseProject(doc), goal)).toThrow(/set a min and a max on "gap"/);
    doc.variables.gap.locked = true;
    expect(unboundedVariables(parseProject(doc))).toEqual([]);
    expect(() => tuningDesignFromProject(parseProject(doc), goal)).not.toThrow();
  });

  it('refuses computed, board-sizing and unused variables', () => {
    const derived = example();
    derived.variables.half = { value: 'patch_w / 2', min: '1 mm', max: '10 mm' };
    derived.geometry.top[0].polygon[0][0] = `${derived.geometry.top[0].polygon[0][0]} + half - half`;
    expect(() => tuningDesignFromProject(parseProject(derived), goal)).toThrow(/"half" is computed from other variables/);
    const cell = example();
    cell.variables.c = { value: '1 mm', min: '0.5 mm', max: '2 mm' };
    cell.mesh.cell = 'c';
    expect(() => tuningDesignFromProject(parseProject(cell), goal)).toThrow(/"c" sets the mesh/);
    const unused = example();
    unused.variables.spare = { value: '1 mm', min: '0.5 mm', max: '2 mm' };
    expect(() => tuningDesignFromProject(parseProject(unused), goal)).toThrow(/nothing uses "spare"/);
  });

  it('refuses a target outside the band, nothing to tune, more than one port, and axial ratio without a far field', () => {
    expect(() => tuningDesignFromProject(parseProject(example()), { ...goal, target_ghz: 9 })).toThrow(/outside the project's band/);
    expect(() => tuningDesignFromProject(parseProject(example()), { ...goal, max_axial_ratio_db: 3 })).toThrow(/far_field_ghz/);
    const locked = example();
    for (const v of Object.values(locked.variables)) v.locked = true;
    expect(() => tuningDesignFromProject(parseProject(locked), goal)).toThrow(/nothing to tune/);
    const twoPorts = example();
    twoPorts.ports.push({ ...twoPorts.ports[0], id: 'p2' } as Project['ports'][number]);
    expect(() => tuningDesignFromProject(parseProject(twoPorts), goal)).toThrow(/one port/);
  });
});
