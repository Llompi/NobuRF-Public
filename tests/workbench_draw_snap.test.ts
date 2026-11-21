import { describe, expect, it } from 'vitest';
import { snapToCorners } from '../src/workbench/draw_tool';

describe('snapToCorners', () => {
  const patch: [number, number][] = [[-12.9, -8.6], [12.9, -8.6], [12.9, 15.8], [-12.9, 15.8]];

  it('puts a feed drawn 0.1 mm short of the patch on the patch edge', () => {
    expect(snapToCorners([1.13, -8.52], patch, [1.5, 1.5])).toEqual([1.1, -8.6]);
  });

  it('falls back to the 0.1 mm grid per axis when no corner is near', () => {
    expect(snapToCorners([3.04, 2.96], patch, [1.5, 1.5])).toEqual([3, 3]);
    expect(snapToCorners([3.04, -8.0], patch, [1.5, 1.5])).toEqual([3, -8.6]);
  });

  it('takes the nearest corner when two are within reach', () => {
    expect(snapToCorners([0, -8.0], [[0, -8.6], [0, -7.7]], [1, 1])).toEqual([0, -7.7]);
  });

  it('only snaps to the grid with no corners (Alt held, or a port)', () => {
    expect(snapToCorners([1.13, -8.52], [], [1.5, 1.5])).toEqual([1.1, -8.5]);
  });
});
