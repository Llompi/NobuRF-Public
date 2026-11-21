import { describe, expect, it } from 'vitest';
import { gpuPortLimitExceeded, MAX_PORT_CELLS, MAX_PORTS } from '../src/engine/gpu_limits';

describe('gpuPortLimitExceeded', () => {
  it('accepts the most ports and port cells the GPU engine holds', () => {
    expect(gpuPortLimitExceeded(Array.from({ length: MAX_PORTS }, () => ({ cells: MAX_PORT_CELLS / MAX_PORTS })))).toBeNull();
  });

  it('names the limit a model exceeds', () => {
    expect(gpuPortLimitExceeded(Array.from({ length: MAX_PORTS + 1 }, () => ({ cells: 1 }))))
      .toBe(`the model has ${MAX_PORTS + 1} ports and the GPU engine takes at most ${MAX_PORTS}`);
    expect(gpuPortLimitExceeded([{ cells: MAX_PORT_CELLS + 1 }]))
      .toBe(`the ports span ${MAX_PORT_CELLS + 1} cells together and the GPU engine takes at most ${MAX_PORT_CELLS}`);
  });
});
