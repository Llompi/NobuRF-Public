import { describe, expect, it } from 'vitest';
import { idx3 } from '../src/engine/voxelize';
import { rasterise } from '../src/project/rasterise';
import { resolveProject } from '../src/project/resolve';
import { parseProject, ProjectError } from '../src/project/schema';
import { rect, twoPortLineJson } from './project_fixtures';

/** twoPortLineJson with vias (1 mm cells, 1 mm FR-4, the trace 2 mm wide along y at x = 0). */
function withVias(vias: unknown[]): Record<string, any> {
  return { ...twoPortLineJson(), vias };
}
const via = { id: 'V1', x: '0 mm', y: '2 mm', drill: '0.4 mm', between: ['top', 'gnd'] };

/** A three-copper stackup: gnd, an inner plane, top; 1 mm cells. */
function stripline(vias: unknown[]): Record<string, any> {
  const json = twoPortLineJson();
  json.stackup = [
    { type: 'copper', name: 'gnd', material: 'pec' },
    { type: 'dielectric', name: 'core', material: 'FR-4', thickness: '1 mm' },
    { type: 'copper', name: 'mid', material: 'pec' },
    { type: 'dielectric', name: 'pre', material: 'FR-4', thickness: '1 mm' },
    { type: 'copper', name: 'top', material: 'pec' },
  ];
  json.geometry.mid = [{ id: 'plane', op: 'add', polygon: rect('-4 mm', '-half_len', '4 mm', 'half_len') }];
  json.geometry.top.push({ id: 'pad', op: 'add', polygon: rect('2 mm', '1 mm', '4 mm', '3 mm') });
  json.ports = json.ports.map((p: Record<string, unknown>) => ({ ...p, between: ['top', 'mid'] }));
  json.vias = vias;
  return json;
}

describe('vias in the project file', () => {
  it('resolves a via, bottom layer first, with the drill as a radius', () => {
    const r = resolveProject(parseProject(withVias([via])));
    expect(r.vias).toEqual([{ id: 'V1', path: '$.vias[0]', index: 0, xMm: 0, yMm: 2, radiusMm: 0.2, antipadRadiusMm: null, inFence: false, between: ['gnd', 'top'] }]);
  });

  it('a project without vias is unchanged', () => {
    expect(parseProject(twoPortLineJson())).not.toHaveProperty('vias');
    expect(resolveProject(parseProject(twoPortLineJson())).vias).toEqual([]);
  });

  it('a fence puts a via every pitch from the start, the last one that still fits', () => {
    const r = resolveProject(parseProject(withVias([{ ...via, id: 'F', x: '-0.5 mm', y: '-5 mm', to: ['-0.5 mm', '5.5 mm'], pitch: '2 mm' }])));
    expect(r.vias.map((v) => [v.id, v.yMm])).toEqual([['F#1', -5], ['F#2', -3], ['F#3', -1], ['F#4', 1], ['F#5', 3], ['F#6', 5]]);
  });

  it('an antipad cuts a circle at least the antipad wide in every layer in between, and only there', () => {
    const r = resolveProject(parseProject(stripline([{ ...via, x: '3 mm', antipad: '1 mm' }])));
    expect(r.copper.top.map((s) => s.op)).toEqual(['add', 'add', 'add']);
    expect(r.copper.gnd.map((s) => s.op)).toEqual(['add']);
    const cut = r.copper.mid.at(-1)!;
    expect(cut).toMatchObject({ id: 'V1/antipad', op: 'cut' });
    const radii = cut.polygon.map(([x, y]) => Math.hypot(x - 3, y - 2));
    expect(Math.min(...radii)).toBeGreaterThan(0.5 - 1e-9);
    expect(Math.max(...radii)).toBeLessThan(0.51);
  });

  const rejects: Array<[string, unknown, RegExp]> = [
    ['one layer', { ...via, between: ['top', 'top'] }, /two different copper layers/],
    ['a dielectric layer', { ...via, between: ['top', 'core'] }, /not a copper layer/],
    ['an id taken by a port', { ...via, id: 'p1' }, /already used by a port/],
    ['a zero drill', { ...via, drill: '0 mm' }, /must be positive/],
    ['to without pitch', { ...via, to: ['0 mm', '5 mm'] }, /needs both "to" and "pitch"/],
    ['a fence of one', { ...via, to: ['0 mm', '2.5 mm'], pitch: '1 mm' }, /closer to \(x, y\) than one pitch/],
    ['overlapping fence vias', { ...via, to: ['0 mm', '5 mm'], pitch: '0.3 mm' }, /not more than the drill/],
    ['touching fence vias', { ...via, to: ['0 mm', '5 mm'], pitch: via.drill }, /not more than the drill/],
    ['a runaway fence', { ...via, to: ['0 mm', '5 mm'], pitch: '0.001 mm', drill: '0.001 mm' }, /more than 2000/],
    ['an antipad with nothing in between', { ...via, antipad: '1 mm' }, /no copper layer between them/],
    ['an antipad under the drill', { ...via, antipad: '0.3 mm' }, /larger than the drill/],
  ];
  for (const [what, v, message] of rejects) {
    it(`rejects ${what}`, () => {
      const json = withVias([JSON.parse(JSON.stringify(v))]);
      expect(() => parseProject(json)).toThrow(message);
      expect(() => parseProject(json)).toThrow(ProjectError);
    });
  }
});

describe('rasterising vias', () => {
  it('a via under a cell is the PEC Ez column at the nearest node, with a warning', () => {
    const { model, warnings } = rasterise(parseProject(withVias([via])));
    const g = model.grid;
    const N = g.nx * g.ny * g.nz;
    const p = model.ports[0];
    const j = p.j + 9; // y = 2 mm, 9 cells from the port at y = -7 mm
    for (let k = p.k0; k < p.k1; k++) expect(model.eCurl[2 * N + idx3(g, p.i, j, k)]).toBe(0);
    // Its neighbour column stays dielectric.
    expect(model.eCurl[2 * N + idx3(g, p.i + 1, j, p.k0)]).toBeGreaterThan(0);
    expect(warnings.some((w) => /\$\.vias\[0\].*one grid column nearest its center/.test(w))).toBe(true);
  });

  it('a drill wider than the cells fills every node within it, and the edges joining them', () => {
    const { model, warnings } = rasterise(parseProject(withVias([{ ...via, drill: '2.2 mm', y: '0 mm' }])));
    const g = model.grid;
    const N = g.nx * g.ny * g.nz;
    const p = model.ports[0];
    const j = p.j + 7;
    // Nodes within 1.1 mm: the centre and its four neighbours, a plus.
    for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) expect(model.eCurl[2 * N + idx3(g, p.i + di, j + dj, p.k0)]).toBe(0);
    expect(model.eCurl[2 * N + idx3(g, p.i + 1, j + 1, p.k0)]).toBeGreaterThan(0);
    // An Ex edge between two via nodes on the plane between the layers... there is none on one dielectric cell, so check the end planes' copper stays PEC.
    expect(model.eCurl[idx3(g, p.i, j, p.k1)]).toBe(0);
    expect(warnings.some((w) => w.includes('via'))).toBe(false);
  });

  it('removes nothing from the solve when there are no vias', () => {
    const plain = rasterise(parseProject(twoPortLineJson())).model;
    const none = rasterise(parseProject(withVias([]))).model;
    expect(none.signature).toBe(plain.signature);
  });

  it('on a graded mesh the via centre and rim get mesh lines', () => {
    const json = withVias([{ ...via, x: '0.5 mm', drill: '0.6 mm' }]);
    json.mesh = { cell: '1 mm', air_margin_cells: { xy: 2, below: 2, above: 6 }, graded: { edge_cell: '0.25 mm', dielectric_cells: 4, max_growth: 1.4 } };
    const { model, warnings } = rasterise(parseProject(json));
    for (const x of [0.2, 0.5, 0.8]) expect(Array.from(model.mesh.x).some((v) => Math.abs(v - x) < 1e-9)).toBe(true);
    expect(warnings.some((w) => w.includes('one grid column'))).toBe(false);
  });

  it('an antipad leaves the inner plane unconnected; without one the via joins it', () => {
    for (const [antipad, joined] of [[undefined, true], ['1.6 mm', false]] as const) {
      const json = stripline([{ ...via, x: '3 mm', ...(antipad ? { antipad } : {}) }]);
      json.mesh.cell = '0.5 mm';
      const { model } = rasterise(parseProject(json));
      const g = model.grid;
      const N = g.nx * g.ny * g.nz;
      // Ex edge leaving the via node on the mid plane: copper (PEC) when joined.
      const xs = Array.from(model.mesh.x);
      const i = xs.findIndex((v) => Math.abs(v - 3) < 1e-9);
      const jj = Array.from(model.mesh.y).findIndex((v) => Math.abs(v - 2) < 1e-9);
      const kMid = Array.from(model.mesh.z).findIndex((v) => Math.abs(v - 1) < 1e-9);
      expect(model.eCurl[idx3(g, i, jj, kMid)] === 0).toBe(joined);
      expect(model.eCurl[2 * N + idx3(g, i, jj, kMid)]).toBe(0);
    }
  });

  const rejects: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a via off copper at one end', { x: '3.5 mm' }, /does not touch copper of layer "top"; put a pad there/],
    ['a via on a port', { y: '-7 mm' }, /sits on the cells of a port/],
    ['a via off the board', { x: '6 mm' }, /off the board|outside the simulation box/],
  ];
  for (const [what, change, message] of rejects) {
    it(`rejects ${what}`, () => {
      expect(() => rasterise(parseProject(withVias([{ ...via, ...change }])))).toThrow(message);
    });
  }

  it('rejects an antipad the grid cannot resolve, which would still join the via to the plane', () => {
    expect(() => rasterise(parseProject(stripline([{ ...via, x: '3 mm', antipad: '0.8 mm' }])))).toThrow(/antipad does not clear the grid on layer "mid"/);
  });

  it('warns on a drill one to two cells wide that still holds one node', () => {
    for (const drill of ['1 mm', '1.5 mm', '1.9 mm']) {
      const { warnings } = rasterise(parseProject(withVias([{ ...via, y: '0 mm', drill }])));
      expect(warnings.some((w) => w.includes('one grid column'))).toBe(true);
    }
  });

  it('warns when a wide drill holds no node and falls back to one column', () => {
    const { warnings } = rasterise(parseProject(withVias([{ ...via, x: '0.5 mm', y: '2.5 mm', drill: '1.2 mm' }])));
    expect(warnings.some((w) => w.includes('one grid column'))).toBe(true);
  });

  it('a fence gets centre lines only on a graded mesh', () => {
    const json = withVias([{ ...via, x: '0.5 mm', y: '-5 mm', to: ['0.5 mm', '5 mm'], pitch: '2.5 mm', drill: '0.6 mm' }]);
    json.mesh = { cell: '1 mm', air_margin_cells: { xy: 2, below: 2, above: 6 }, graded: { edge_cell: '0.25 mm', dielectric_cells: 4, max_growth: 1.4 } };
    const { model } = rasterise(parseProject(json));
    const has = (lines: Float64Array, v: number) => Array.from(lines).some((x) => Math.abs(x - v) < 1e-9);
    for (const y of [-5, -2.5, 0, 2.5, 5]) expect(has(model.mesh.y, y)).toBe(true);
    expect(has(model.mesh.y, -4.7)).toBe(false);
  });

  it('refuses vias beside a coax connector', () => {
    const json = withVias([via]);
    json.ports[0] = { ...json.ports[0], kind: 'coax_probe' };
    expect(() => parseProject(json)).toThrow(/not supported yet in a project with an SMA connector or coax probe/);
  });

  it('rejects two vias on one column', () => {
    expect(() => rasterise(parseProject(withVias([via, { ...via, id: 'V2', y: '2.2 mm' }])))).toThrow(/share grid edges/);
  });
});
