import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseProject, type ComponentBetweenLayers, type ComponentOnLayer, type Project } from '../src/project/schema';
import * as actions from '../src/workbench/doc_actions';
import { selectionForErrorPath, selectionKey } from '../src/workbench/selection';
import { componentValueText } from '../src/workbench/tree';

const example = (): Project => JSON.parse(readFileSync('examples/patch-5g8-graded.json', 'utf8'));

describe('workbench components', () => {
  it('adds a valid 50 ohm part between the two lowest copper layers, and removing the last drops the key', () => {
    const { doc, index } = actions.addComponent(example());
    expect(doc.components![index]).toEqual({ id: 'R1', x: '0 mm', y: '0 mm', between: ['gnd', 'top'], r_ohm: 50 });
    expect(() => parseProject(doc)).not.toThrow();
    expect(actions.addComponent(doc).doc.components!.map((c) => c.id)).toEqual(['R1', 'R1_2']);
    expect(actions.removeComponent(doc, index)).not.toHaveProperty('components');
  });

  it('switches placement and back, keeping the name, value and first point', () => {
    const added = actions.addComponent(example()).doc;
    added.components![0] = { ...added.components![0], l_nh: 2, connection: 'series' };
    const onLayer = actions.setComponentPlacement(added, 0, 'layer');
    expect(onLayer.components![0]).toEqual({ id: 'R1', layer: 'top', from: ['0 mm', '0 mm'], to: ['0 mm', '0 mm + 1 mm'], r_ohm: 50, l_nh: 2, connection: 'series' });
    const back = actions.setComponentPlacement(onLayer, 0, 'between');
    expect(back.components![0]).toEqual({ id: 'R1', x: '0 mm', y: '0 mm', between: ['gnd', 'top'], r_ohm: 50, l_nh: 2, connection: 'series' });
  });

  it('renames follow into components: layers, variables, and ids unique among ports and components', () => {
    const doc = actions.addComponent(example()).doc;
    doc.components!.push({ id: 'L1', layer: 'top', from: ['patch_w', '0 mm'], to: ['patch_w + 1 mm', '0 mm'], width: 'patch_w / 10', l_nh: 1 });
    const renamedLayer = actions.renameLayer(doc, doc.stackup.findIndex((l) => l.name === 'top'), 'signal');
    expect((renamedLayer.components![0] as ComponentBetweenLayers).between).toEqual(['gnd', 'signal']);
    expect((renamedLayer.components![1] as ComponentOnLayer).layer).toBe('signal');
    const renamedVariable = actions.renameVariable(doc, 'patch_w', 'w');
    expect(renamedVariable.components![1]).toMatchObject({ from: ['w', '0 mm'], to: ['w + 1 mm', '0 mm'], width: 'w / 10' });
    expect(() => actions.renameComponent(doc, 1, doc.ports[0].id)).toThrow(/already a port, component or via/);
    expect(actions.renameComponent(doc, 1, 'L9').components![1].id).toBe('L9');
    expect(() => actions.renamePort(doc, 0, doc.components![0].id)).toThrow(/already a port, component or via/);
    expect(actions.addPort({ ...doc, components: [{ ...doc.components![0], id: 'port' }] }).doc.ports.at(-1)!.id).not.toBe('port');
  });

  it('maps component errors to the component, and labels values as a schematic does', () => {
    expect(selectionKey(selectionForErrorPath('$.components[2].c_pf'))).toBe('component:2');
    expect(selectionKey(selectionForErrorPath('$.components'))).toBe('components');
    expect(componentValueText({ r_ohm: 50 })).toBe('50 Ω');
    expect(componentValueText({ l_nh: 2.2, c_pf: 1, connection: 'parallel' })).toBe('2.2 nH ∥ 1 pF');
    expect(componentValueText({ r_ohm: 1, l_nh: 3, c_pf: 0.5, connection: 'series' })).toBe('1 Ω + 3 nH + 0.5 pF');
  });
});
