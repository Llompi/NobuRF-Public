import { describe, expect, it } from 'vitest';
import { flatDispatchSize } from '../src/engine/fdtd3d';

describe('flatDispatchSize', () => {
  it('keeps small dispatches one-dimensional', () => {
    expect(flatDispatchSize(1, 65535)).toEqual([1, 1]);
    expect(flatDispatchSize(65535, 65535)).toEqual([65535, 1]);
  });

  it('splits past the per-dimension limit into rows that cover every group', () => {
    const [x, y] = flatDispatchSize(196_608, 65535); // 256x256x192 grid at 64 per group
    expect(x).toBe(65535);
    expect(y).toBe(4);
    expect(x * y).toBeGreaterThanOrEqual(196_608);
  });

  it('narrows rows on request without passing the device limit', () => {
    expect(flatDispatchSize(256, 65535, 7)).toEqual([7, 37]);
    expect(() => flatDispatchSize(256, 5, 7)).toThrow(/dispatch limit/);
  });

  it('rejects dispatches beyond the 2D limit', () => {
    expect(() => flatDispatchSize(10 * 10 + 1, 10)).toThrow(/dispatch limit/);
  });
});
