import { describe, expect, it } from 'vitest';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

describe('mesh size limit', () => {
  it('refuses a uniform mesh over the cell limit before building it', () => {
    const json = smallProjectJson();
    json.mesh.cell = '1 um';
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.mesh\.cell: the mesh would have .* cells, more than the 50M limit/);
  });

  it('refuses a graded mesh over the cell limit', () => {
    const json = smallProjectJson();
    json.mesh.cell = '0.001 mm';
    json.mesh.graded = { edge_cell: '0.0005 mm', dielectric_cells: 3, max_growth: 1.3 };
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.mesh\.graded: the mesh would have .* more than the 50M limit/);
  });
});

describe('tiny cell warning', () => {
  it('warns when the smallest cell is a tiny fraction of the wavelength, and not for the fixture', () => {
    const json = smallProjectJson();
    json.mesh.graded = { edge_cell: '0.0001 mm', dielectric_cells: 3, max_growth: 1.3 };
    // The smallest cell is edge_cell, or a few % under it beside a corrected copper edge's line.
    expect(rasterise(parseProject(json)).warnings.join('\n')).toMatch(/smallest cell (0\.0001\d*|0\.00009[5-9]\d*) mm is under 1\/2000 of the wavelength/);
    expect(rasterise(parseProject(smallProjectJson())).warnings.join('\n')).not.toMatch(/of the wavelength/);
  }, 30_000);
});
