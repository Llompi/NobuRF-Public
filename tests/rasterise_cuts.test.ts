import { describe, expect, it } from 'vitest';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

const rect = (x0: string, y0: string, x1: string, y1: string) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** The small patch (6 mm, 1 mm cells) fed 2 mm deep, with an inset notch either side of the feed from `notchStartY` (none if null). */
function insetModel(notchStartY: string | null) {
  const json = smallProjectJson();
  json.geometry.top = [
    { id: 'patch', op: 'add', polygon: rect('-patch / 2', '-patch / 2', 'patch / 2', 'patch / 2') },
    ...(notchStartY === null ? [] : [{ id: 'notch', op: 'cut', polygon: rect('-2 mm', notchStartY, '2 mm', '-1 mm') }]),
    { id: 'feed', op: 'add', polygon: rect('-1 mm', '-patch / 2 - 1 mm', '1 mm', '-1 mm') },
  ];
  return rasterise(parseProject(json)).model;
}

const changedEdges = (a: Float32Array, b: Float32Array) => a.reduce((n, v, k) => n + (v === b[k] ? 0 : 1), 0);

describe('cuts', () => {
  it('a notch drawn from the patch outline opens it, the same as one drawn from below it', () => {
    const fromEdge = insetModel('-patch / 2');
    const fromBelow = insetModel('-patch / 2 - 1 mm');
    const noNotch = insetModel(null);
    expect(Array.from(fromEdge.eCurl)).toEqual(Array.from(fromBelow.eCurl));
    expect(Array.from(fromEdge.eCurl)).not.toEqual(Array.from(noNotch.eCurl));
  });

  it('a slot inside the patch still keeps the copper on its rim', () => {
    const json = smallProjectJson();
    json.geometry.top.push({ id: 'slot', op: 'cut', polygon: rect('-2 mm', '0 mm', '2 mm', '1 mm') });
    const withSlot = rasterise(parseProject(json)).model;
    const plain = rasterise(parseProject(smallProjectJson())).model;
    // 1 mm cells, rim on mesh lines: only the three y edges strictly inside (x = -1, 0, 1) are cut.
    expect(changedEdges(withSlot.eCurl, plain.eCurl)).toBe(3);
  });
});
