import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';

describe('a board with many lossy copper faces', () => {
  // A hand-drawn 10 GHz patch from a workbench session: copper (not PEC) sheets on a 0.05 mm edge mesh give
  // about 140,000 sheet edges. Its solve failed with "$.stackup: Maximum call stack size exceeded" because the
  // face-loss check spread every face into one Math.max call.
  it('rasterises without overflowing the stack', () => {
    const project = parseProject(JSON.parse(readFileSync(new URL('./fixtures/student/hand-drawn-patch.json', import.meta.url), 'utf8')));
    const { model } = rasterise(project);
    expect(model.sheets!.eIndex.length).toBeGreaterThan(100_000);
  });
});
