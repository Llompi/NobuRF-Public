import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { boundingBox } from '../src/import/geometry';
import { parseOriginSpec, resolveOrigin } from '../src/import/origin';
import { parseProject } from '../src/project/schema';
import type { Vec2 } from '../src/project/resolve';
import { FIXTURES } from './import_helpers';

const outline: Vec2[] = [[100, -80], [147, -80], [147, -50], [100, -50]];

describe('--origin', () => {
  it('reads a point with units, in any length unit', () => {
    expect(parseOriginSpec('150 mm, -80 mm')).toEqual({ point: [150, -80] });
    expect(parseOriginSpec('1 in,-500 mil')).toEqual({ point: [25.4, -12.7] });
    expect(parseOriginSpec(' outline-center ')).toEqual({ keyword: 'outline-center' });
  });

  it('refuses bare numbers, names and the wrong number of coordinates', () => {
    expect(() => parseOriginSpec('150, -80')).toThrow('--origin "150, -80": "150" has no unit');
    expect(() => parseOriginSpec('board_x, 0 mm')).toThrow('"board_x" is not a unit');
    expect(() => parseOriginSpec('1 mm')).toThrow('expected "<x>, <y>"');
    expect(() => parseOriginSpec('1 mm, 2 mm, 3 mm')).toThrow('expected "<x>, <y>"');
  });

  it('finds the outline corner and centre, and needs an outline for them', () => {
    expect(resolveOrigin({ keyword: 'outline-min' }, outline)).toEqual([100, -80]);
    expect(resolveOrigin({ keyword: 'outline-center' }, outline)).toEqual([123.5, -65]);
    expect(resolveOrigin({ point: [1, 2] }, undefined)).toEqual([1, 2]);
    expect(() => resolveOrigin({ keyword: 'outline-min' }, undefined)).toThrow('needs an imported outline (--outline)');
  });
});

describe('noburf import --origin (end to end)', () => {
  const runImport = (...extra: string[]) => {
    const outPath = join(mkdtempSync(join(tmpdir(), 'noburf-origin-')), 'board.json');
    const run = spawnSync('npx', [
      'tsx', 'scripts/noburf.ts', 'import',
      '--stackup', join(FIXTURES, 'template.json'),
      '--layer', `top=${join(FIXTURES, 'board-F_Cu.gbr')}`,
      '--layer', `gnd=${join(FIXTURES, 'board.dxf')}:GND`,
      '--outline', join(FIXTURES, 'board-Edge_Cuts.gbr'),
      ...extra,
      '--out', outPath,
    ], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    return { project: parseProject(JSON.parse(readFileSync(outPath, 'utf8'))), stdout: run.stdout };
  };
  const millimetres = (polygon: Array<[string, string]>): Vec2[] => polygon.map(([x, y]) => [parseFloat(x), parseFloat(y)]);

  it('moves copper and outline together, and a keyword equals the same point typed out', () => {
    const before = runImport().project;
    const { project: corner, stdout } = runImport('--origin', 'outline-min');
    expect(stdout).toContain('file point (-2, -2) mm is now (0, 0)');
    expect(boundingBox([millimetres(corner.board.outline)])).toEqual({ minX: 0, minY: 0, maxX: 47, maxY: 30 });

    const shiftedBefore = before.geometry.top[0].polygon.map(([x, y]) => [parseFloat(x) + 2, parseFloat(y) + 2]);
    expect(millimetres(corner.geometry.top[0].polygon)).toEqual(shiftedBefore);
    expect(runImport('--origin', '-2 mm, -2 mm').project).toEqual(corner);
    // Everything else comes from the template unchanged.
    expect(corner.ports).toEqual(before.ports);
  });
});
