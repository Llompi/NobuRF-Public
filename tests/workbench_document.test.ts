import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProject, type LumpedPort, type Project } from '../src/project/schema';
import * as actions from '../src/workbench/doc_actions';
import { dipAndBandwidth } from '../src/workbench/results';
import { selectionForErrorPath, selectionKey } from '../src/workbench/selection';
import { getAt, pathString, ProjectStore, setAt } from '../src/workbench/store';

const example = (): Project => JSON.parse(readFileSync('examples/patch-5g8-graded.json', 'utf8')); // the plain edge-fed patch: two copper shapes on top

describe('workbench document store', () => {
  it('reads and writes by JSON path without touching the original', () => {
    const doc = { a: [{ b: 1 }] };
    const next = setAt(doc, ['a', 0, 'b'], 2);
    expect(getAt(next, ['a', 0, 'b'])).toBe(2);
    expect(doc.a[0].b).toBe(1);
    expect(getAt(setAt(next, ['a', 0, 'b'], undefined), ['a', 0])).toEqual({});
    expect(pathString(['ports', 0, 'x'])).toBe('$.ports[0].x');
  });

  it('reports the schema error with its path, and undo restores a valid project', () => {
    const store = new ProjectStore(example(), 'p.json');
    expect(store.validation.error).toBeNull();
    store.set(['variables', 'patch_l', 'value'], '30 mm');
    expect(store.validation.error).toEqual({ path: '$.variables.patch_l.value', message: '"30 mm" is above its max "board_l - 1 mm"' });
    expect(store.lastValid?.project).not.toBeNull();
    store.undo();
    expect(store.validation.error).toBeNull();
    store.redo();
    expect(store.validation.error).not.toBeNull();
  });

  it('tracks unsaved changes against the version last opened or saved', () => {
    const store = new ProjectStore(example(), 'p.json');
    expect(store.dirty).toBe(false);
    store.set(['name'], 'renamed');
    expect(store.dirty).toBe(true);
    store.undo();
    expect(store.dirty).toBe(false); // back to the opened version
    store.redo();
    store.markSaved();
    expect(store.dirty).toBe(false);
    store.undo();
    expect(store.dirty).toBe(true); // the saved file has the new name
    store.load(example(), 'q.json');
    expect(store.dirty).toBe(false);
  });

  it('restores an autosave with its unsaved edits still marked unsaved', () => {
    const edited = { ...example(), name: 'edited' };
    const store = new ProjectStore({}, 'x.json');
    store.load(edited, 'p.json', example());
    expect(store.dirty).toBe(true);
    expect(store.savedDocument).toEqual(example());
    expect(store.canUndo).toBe(false);
  });

  it('ignores an edit that changes nothing, so undo is not cluttered', () => {
    const store = new ProjectStore(example(), 'p.json');
    store.set(['name'], 'patch-5g8-graded');
    expect(store.canUndo).toBe(false);
  });
});

describe('workbench structural edits', () => {
  it('refuses a rename onto a name in use instead of merging the two', () => {
    const doc = example();
    expect(() => actions.renameVariable(doc, 'patch_w', 'patch_l')).toThrow('There is already a variable called "patch_l".');
    expect(() => actions.renameMaterial(doc, Object.keys(doc.materials)[0], 'FR-4')).toThrow(/material called "FR-4"/);
    expect(() => actions.renameLayer(doc, 2, 'gnd')).toThrow(/layer called "gnd"/);
  });

  it('renames a variable in every expression and nowhere else', () => {
    const doc = example();
    doc.stackup[2].name = 'patch_w_layer'; // a layer name that contains the variable name must not change
    doc.geometry.patch_w_layer = doc.geometry.top;
    delete (doc.geometry as Record<string, unknown>).top;
    doc.ports[0].between = ['gnd', 'patch_w_layer'];
    doc.stackup[2] = { ...doc.stackup[2], thickness: 'patch_w / 400' }; // a copper thickness is an expression too
    const next = actions.renameVariable(doc, 'patch_w', 'width');
    expect(() => parseProject(next)).not.toThrow();
    expect(next.variables.width.value).toBe('16 mm');
    expect(next.variables.feed_w.max).toBe('width / 2');
    expect(JSON.stringify(next.geometry)).not.toMatch(/patch_w\b(?!_layer)/);
    expect(next.stackup[2].name).toBe('patch_w_layer');
    expect(next.stackup[2].thickness).toBe('width / 400');
    // The variable keeps its place in the list.
    expect(Object.keys(next.variables).indexOf('width')).toBe(Object.keys(doc.variables).indexOf('patch_w'));
  });

  it('renames a copper layer with its geometry and port references', () => {
    const next = actions.renameLayer(example(), 2, 'l1');
    expect(() => parseProject(next)).not.toThrow();
    expect(next.geometry.l1).toHaveLength(2);
    expect(next.ports[0].between).toEqual(['gnd', 'l1']);
  });

  it('adds parts that keep the project valid', () => {
    let doc = example();
    doc = actions.addVariable(doc).doc;
    doc = actions.addMaterial(doc, 'dielectric').doc;
    doc = actions.addLayerPair(doc).doc;
    doc = actions.addRectangle(doc, 'top').doc;
    doc = actions.duplicateShape(doc, 'top', 0).doc;
    expect(() => parseProject(doc)).not.toThrow();
    expect(doc.geometry.top.map((s) => s.id)).toEqual(['patch', 'patch_2', 'feed', 'top_rect']);
  });

  it('removing a port drops it from the excited list', () => {
    let doc = actions.addPort(example()).doc;
    doc.ports[1] = { ...(doc.ports[1] as LumpedPort), x: '0 mm', y: '0 mm' };
    doc.analysis.excite = ['port'];
    doc = actions.removePort(doc, 1);
    expect(doc.analysis.excite).toBeUndefined();
  });
});

describe('workbench selection', () => {
  it('maps schema error paths to tree items', () => {
    expect(selectionKey(selectionForErrorPath('$.geometry.top[1].polygon[0][1]'))).toBe('shape:top:1');
    expect(selectionKey(selectionForErrorPath('$.variables.patch_l.value'))).toBe('variable:patch_l');
    expect(selectionKey(selectionForErrorPath('$.materials.RT/duroid 6010.2LM.mu_dispersion.poles[0].delta'))).toBe(selectionKey({ kind: 'material', name: 'RT/duroid 6010.2LM' }));
    expect(selectionKey(selectionForErrorPath('$.materials.fr4.dispersion.at_ghz'))).toBe(selectionKey({ kind: 'material', name: 'fr4' }));
    expect(selectionKey(selectionForErrorPath('$.materials.fr4.mu_r'))).toBe(selectionKey({ kind: 'material', name: 'fr4' }));
    expect(selectionKey(selectionForErrorPath('$.outputs.far_field_ghz'))).toBe('analysis');
    expect(selectionKey(selectionForErrorPath('$.boundaries.z_max'))).toBe('boundaries');
  });
});

describe('S11 dip and bandwidth', () => {
  it('interpolates the -10 dB crossings around the dip', () => {
    const f = [5, 5.1, 5.2, 5.3, 5.4];
    const s = [-2, -8, -20, -12, -4];
    const d = dipAndBandwidth(f, s, -10);
    expect(d.f).toBe(5.2);
    expect(d.fLow).toBeCloseTo(5.1 + 0.1 * (2 / 12), 9);
    expect(d.fHigh).toBeCloseTo(5.3 + 0.1 * (2 / 8), 9);
    expect(d.openEnded).toBe(false);
  });

  it('says when nothing reaches the level', () => {
    expect(dipAndBandwidth([1, 2, 3], [-3, -7, -2], -10).bandwidthGHz).toBeNull();
  });
});
