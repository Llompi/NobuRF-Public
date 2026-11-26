import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveProject } from '../src/project/resolve';
import { parseProject } from '../src/project/schema';
import { copperAt, portsOffCopper } from '../src/workbench/port_check';

const example = () => JSON.parse(readFileSync('examples/patch-5g8-far-field.json', 'utf8'));
const resolved = (doc: unknown) => resolveProject(parseProject(doc));

describe('ports on copper', () => {
  it('passes every example, where the feed line ends exactly at the port', () => {
    for (const name of ['patch-5g8.json', 'patch-5g8-graded.json', 'patch-5g8-far-field.json', 'patch-pair-5g8-steered.json']) {
      expect(portsOffCopper(resolved(JSON.parse(readFileSync(`examples/${name}`, 'utf8'))))).toEqual([]);
    }
  });

  it('names the port and the layer when an import removed the copper under it', () => {
    const doc = example();
    doc.geometry.top = [{ id: 'far', op: 'add', polygon: [['5 mm', '5 mm'], ['8 mm', '5 mm'], ['8 mm', '8 mm'], ['5 mm', '8 mm']] }];
    expect(portsOffCopper(resolved(doc))).toEqual(['Port feed is not on copper on layer "top", so it drives nothing. Move the port or the copper.']);
  });

  it('paints in order: a cut over the port removes it, a later add restores it', () => {
    const square = (op: 'add' | 'cut', h: number) => ({ id: `${op}${h}`, op, polygon: [[-h, -h], [h, -h], [h, h], [-h, h]] as [number, number][] });
    expect(copperAt([square('add', 2), square('cut', 1)], [0, 0])).toBe(false);
    expect(copperAt([square('add', 2), square('cut', 1), square('add', 0.5)], [0, 0])).toBe(true);
    expect(copperAt([square('add', 2), square('cut', 1)], [1, 0])).toBe(true); // a cut keeps its outline's copper
  });
});
