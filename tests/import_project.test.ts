import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dxfLayerOutline, dxfLayerShapes, parseDxf } from '../src/import/dxf';
import { ImportError } from '../src/import/geometry';
import { parseGerber } from '../src/import/gerber';
import { buildImportedProject, serialiseProject } from '../src/import/project';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { exampleJson } from './project_fixtures';
import { FIXTURES } from './import_helpers';

const fixture = (name: string) => join(FIXTURES, name);
const template = () => JSON.parse(readFileSync(fixture('template.json'), 'utf8'));

describe('noburf import (end to end)', () => {
  it('imports Gerber copper, DXF ground and a Gerber outline into a project that meshes', () => {
    const outPath = join(mkdtempSync(join(tmpdir(), 'noburf-import-')), 'board.json');
    const run = spawnSync('npx', [
      'tsx', 'scripts/noburf.ts', 'import',
      '--stackup', fixture('template.json'),
      '--layer', `top=${fixture('board-F_Cu.gbr')}`,
      '--layer', `gnd=${fixture('board.dxf')}:GND`,
      '--outline', fixture('board-Edge_Cuts.gbr'),
      '--out', outPath,
    ], { encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);

    const text = readFileSync(outPath, 'utf8');
    expect(text).toContain('["9 mm", "4.5 mm"]'); // one point per line
    const project = parseProject(JSON.parse(text));
    expect(project.geometry.top).toHaveLength(16);
    expect(project.geometry.top.at(-1)!.op).toBe('cut');
    expect(project.geometry.gnd).toHaveLength(1);
    // Every coordinate is "<number> mm" with at most 6 decimals (1 nm).
    for (const shape of [...project.geometry.top, ...project.geometry.gnd]) {
      for (const xy of shape.polygon) for (const v of xy) expect(v).toMatch(/^-?\d+(\.\d{1,6})? mm$/);
    }

    const { model, warnings } = rasterise(project);
    // 47 x 30 mm board on 1 mm cells, plus 1 cell of air and 6 PML cells per side.
    expect([model.grid.nx, model.grid.ny]).toEqual([47 + 2 * 7, 30 + 2 * 7]);
    expect(model.topCopper.some((c) => c === 1)).toBe(true);
    // The DXF ground is a plain rectangle; the outline rounds one corner off it.
    expect(warnings).toEqual(['layer "gnd": copper outside the board outline is ignored (8 edges)']);
  });

  it('prints its usage when arguments are missing', () => {
    const run = spawnSync('npx', ['tsx', 'scripts/noburf.ts', 'import', '--out', 'x.json'], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('usage: noburf import --stackup <template.json>');
  });
});

describe('buildImportedProject', () => {
  const drawing = parseDxf(readFileSync(fixture('board.dxf'), 'utf8'), 'board.dxf');

  it('updates only the imported layers and keeps the rest of the template', () => {
    const example = exampleJson();
    const copper = parseGerber(readFileSync(fixture('board-F_Cu.gbr'), 'utf8'), 'top.gbr').shapes;
    const project = buildImportedProject(example, [{ layerName: 'top', sourceName: 'top.gbr', shapes: copper }], undefined);
    expect(project.geometry.gnd).toEqual(example.geometry.gnd);
    expect(project.board).toEqual(example.board);
    expect(project.variables).toEqual(example.variables);
    expect(project.geometry.top.map((s) => s.id)).toEqual(Array.from({ length: 16 }, (_, n) => `top-${n + 1}`));
  });

  it('rounds coordinates to 1 nm', () => {
    const shapes = [{ op: 'add' as const, polygon: [[0.12345649, -1e-9], [1.0000004, 0], [1, 1]] as Array<[number, number]> }];
    const project = buildImportedProject(template(), [
      { layerName: 'top', sourceName: 'a', shapes },
      { layerName: 'gnd', sourceName: 'b', shapes: dxfLayerShapes(drawing, 'GND') },
    ], dxfLayerOutline(drawing, 'OUTLINE'));
    expect(project.geometry.top[0].polygon).toEqual([['0.123456 mm', '0 mm'], ['1 mm', '0 mm'], ['1 mm', '1 mm']]);
    expect(serialiseProject(project)).toContain('["0.123456 mm", "0 mm"]');
  });

  it('refuses a layer imported twice and a layer that is not copper', () => {
    const gnd = { layerName: 'gnd', sourceName: 'b', shapes: dxfLayerShapes(drawing, 'GND') };
    expect(() => buildImportedProject(template(), [gnd, gnd], undefined)).toThrow(ImportError);
    expect(() => buildImportedProject(template(), [gnd, { ...gnd, layerName: 'core' }], dxfLayerOutline(drawing, 'OUTLINE')))
      .toThrow('$.geometry.core: "core" is not a copper layer of the stackup');
  });
});
