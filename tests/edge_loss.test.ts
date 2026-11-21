import { describe, expect, it } from 'vitest';
import { edgeLossFactor, idx3, surfaceResistanceOhm, YEE_EDGE_CUTOFF_CELLS, YEE_EDGE_LOSS_SHARE } from '../src/engine/voxelize';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { yeeEdgeConstants } from '../scripts/validate/yee_edge_constants';
import { smallProjectJson } from './project_fixtures';

describe('conductor loss at copper edges', () => {
  it('derives the grid constants from a discrete half-plane', () => {
    // A small grid; the cutoff converges from below as the summed reach grows (0.2709 at L = 360).
    const { cutoffCells, edgeShare } = yeeEdgeConstants(90);
    expect(edgeShare / YEE_EDGE_LOSS_SHARE).toBeCloseTo(1, 2);
    expect(cutoffCells / YEE_EDGE_CUTOFF_CELLS).toBeGreaterThan(0.97);
    expect(cutoffCells).toBeLessThan(YEE_EDGE_CUTOFF_CELLS);
  });

  it('adds the loss between the grid cutoff and the copper cutoff, and grows with the cell', () => {
    // The copper cutoff is t / (4 pi e^pi): 35 um -> 0.120 um.
    const copperCutoffMm = 0.035 / (4 * Math.PI * Math.exp(Math.PI));
    expect(edgeLossFactor(0.1, 0.035)).toBeCloseTo(1 + Math.log((YEE_EDGE_CUTOFF_CELLS * 0.1) / copperCutoffMm) / YEE_EDGE_LOSS_SHARE, 12);
    expect(edgeLossFactor(0.2, 0.035) - edgeLossFactor(0.1, 0.035)).toBeCloseTo(Math.log(2) / YEE_EDGE_LOSS_SHARE, 12);
    // Thinner copper crowds more.
    expect(edgeLossFactor(0.1, 0.005)).toBeGreaterThan(edgeLossFactor(0.1, 0.035));
    // A cell finer than the copper's own cutoff adds nothing.
    expect(edgeLossFactor(1e-7, 0.035)).toBe(1);
    expect(() => edgeLossFactor(0.1, 0)).toThrow(/thickness/);
  });

  it('raises Rs on the outermost copper edges along each boundary, and only there', () => {
    const json = smallProjectJson();
    for (const layer of json.stackup) if (layer.type === 'copper') layer.material = 'copper';
    json.stackup[2].thickness = '18 um';
    const { model } = rasterise(parseProject(json));
    const { grid, mesh, sheets } = model;
    const N = grid.nx * grid.ny * grid.nz;
    const rs = surfaceResistanceOhm(5.8e7, 12e9);
    const rsAt = new Map(Array.from(sheets!.eIndex, (e, s) => [e, sheets!.rsOhm[s]]));
    const node = (lines: Float64Array, v: number) => lines.findIndex((l) => Math.abs(l - v) < 1e-9);
    const kTop = node(mesh.z, 1);
    const [iEdge, iInside, jMid] = [node(mesh.x, 3), node(mesh.x, 2), node(mesh.y, 0)];
    const ey = (i: number) => N + idx3(grid, i, jMid, kTop);
    // The patch's x = +3 mm edge: Ey there runs along the boundary and takes the factor; one cell in, plain Rs.
    expect(rsAt.get(ey(iEdge))! / rs).toBeCloseTo(edgeLossFactor(1, 0.018), 5);
    expect(rsAt.get(ey(iInside))! / rs).toBeCloseTo(1, 6);
    // Ex at that edge runs across the boundary: no factor.
    expect(rsAt.get(idx3(grid, iEdge - 1, jMid, kTop))! / rs).toBeCloseTo(1, 6);
  });

  it('warns when copper is thinner than three skin depths', () => {
    const copperProject = (topThickness: string) => {
      const json = smallProjectJson();
      for (const layer of json.stackup) if (layer.type === 'copper') layer.material = 'copper';
      json.stackup[2].thickness = topThickness;
      return rasterise(parseProject(json)).warnings.join('\n');
    };
    expect(copperProject('0.001 mm')).toMatch(/layer "top": 0\.001 mm is under 3 skin depths/);
    expect(copperProject('0.035 mm')).not.toMatch(/skin depths/);
  });

  it('refuses a non-positive copper thickness', () => {
    const json = smallProjectJson();
    json.stackup[2].thickness = '0 mm';
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.stackup\[2\]\.thickness/);
  });
});
