import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ImportError, signedPolygonArea } from '../src/import/geometry';
import { clipPolygonToRect, describeRemoved, sectionProject } from '../src/import/section';
import type { Vec2 } from '../src/project/resolve';
import { paint, rasterise } from '../src/project/rasterise';
import { resolveProject } from '../src/project/resolve';
import { parseProject, type Project } from '../src/project/schema';

// The detour board: 10 x 20 mm about the origin, ports p1/n1 at y = -9 and p2/n2 at y = +9.
const pairBoard = () => parseProject(JSON.parse(readFileSync('examples/diff-pair-detour.json', 'utf8')));
const area = (p: Vec2[]) => Math.abs(signedPolygonArea(p));
const totalArea = (pieces: Vec2[][]) => pieces.reduce((sum, p) => sum + area(p), 0);
const mmPoints = (points: Vec2[]): [string, string][] => points.map(([x, y]) => [`${x} mm`, `${y} mm`]);
const numeric = (points: [string, string][]): Vec2[] => points.map(([x, y]) => [parseFloat(x), parseFloat(y)]);

// A U: two 1 mm legs (x -2..-1 and 1..2) from y = -9 up to y = 4, joined by a bar from y = 3 to 4.
const U: Vec2[] = [[-2, -9], [-1, -9], [-1, 3], [1, 3], [1, -9], [2, -9], [2, 4], [-2, 4]];

describe('clipPolygonToRect', () => {
  const rect = { x0: 0, y0: 0, x1: 2, y1: 2 };

  it('keeps the part of a square inside the rectangle', () => {
    const pieces = clipPolygonToRect([[1, 1], [3, 1], [3, 3], [1, 3]], rect);
    expect(pieces).toHaveLength(1);
    expect(area(pieces[0])).toBeCloseTo(1, 12);
  });

  it('returns nothing for a polygon outside it', () => {
    expect(clipPolygonToRect([[3, 3], [4, 3], [4, 4], [3, 4]], rect)).toHaveLength(0);
  });

  it('keeps a polygon wholly inside, edges on the rectangle included, unchanged', () => {
    const inner: Vec2[] = [[0, 0], [1.5, 0.5], [1.5, 1.5]];
    expect(clipPolygonToRect(inner, rect)).toEqual([inner]);
  });

  it('splits a concave polygon that leaves and re-enters into separate pieces, no run along the cut', () => {
    const pieces = clipPolygonToRect(U, { x0: -5, y0: -10, x1: 5, y1: 0 });
    expect(pieces).toHaveLength(2);
    expect(pieces.map(area)).toEqual([9, 9]);
    // Between the legs on the cut is no copper: one joined polygon would paint (0, 0) by its zero-width run.
    const shapes = pieces.map((polygon, n) => ({ id: `leg${n}`, op: 'add' as const, polygon }));
    expect(paint(shapes, 0, 0)).toBe(false);
    expect(paint(shapes, -1.5, 0)).toBe(true);
  });

  it('cuts a comb into its teeth, keeping the area', () => {
    // Teeth up from a bar at y 0..1, at x 0..2, 4..6 and 8..10, each up to y = 3; keep y >= 2, x 1..9.
    const comb: Vec2[] = [[0, 0], [10, 0], [10, 3], [8, 3], [8, 1], [6, 1], [6, 3], [4, 3], [4, 1], [2, 1], [2, 3], [0, 3]];
    const pieces = clipPolygonToRect(comb, { x0: 1, y0: 2, x1: 9, y1: 5 });
    expect(pieces).toHaveLength(3);
    expect(totalArea(pieces)).toBeCloseTo(1 + 2 + 1, 12);
  });

  it('cuts a pour whose hole is joined to its outline by a zero-width keyhole bridge, as CAM tools export them', () => {
    // 10 x 10 square with a 2 x 2 hole at 4..6, joined along y = 5 from x = 0; the cut at x = 2 crosses the bridge.
    const keyhole: Vec2[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 5], [4, 5], [4, 6], [6, 6], [6, 4], [4, 4], [4, 5], [0, 5]];
    const pieces = clipPolygonToRect(keyhole, { x0: 2, y0: -1, x1: 11, y1: 11 });
    expect(totalArea(pieces)).toBeCloseTo(8 * 10 - 4, 9);
    const shapes = pieces.map((polygon, n) => ({ id: `p${n}`, op: 'add' as const, polygon }));
    expect(paint(shapes, 5, 5.5)).toBe(false); // the hole stays open
    expect(paint(shapes, 3, 2)).toBe(true);
  });

  it('keeps a shape whose edge lies on the cut as one piece', () => {
    const pieces = clipPolygonToRect([[0, -1], [1, -1], [1, 1], [0, 1]], { x0: 0, y0: 0, x1: 5, y1: 5 });
    expect(pieces).toHaveLength(1);
    expect(area(pieces[0])).toBeCloseTo(1, 12);
  });

  it('accepts the rectangle by any two opposite corners', () => {
    expect(area(clipPolygonToRect([[1, 1], [3, 1], [3, 3], [1, 3]], { x0: 2, y0: 2, x1: 0, y1: 0 })[0])).toBeCloseTo(1, 12);
  });
});

describe('sectionProject', () => {
  it('keeps one end of a differential pair, drops the other, and still meshes', () => {
    const { doc, summary } = sectionProject(pairBoard(), { x0: -5, y0: -10, x1: 5, y1: 0 });
    const project = parseProject(doc);
    expect(project.ports.map((p) => p.id)).toEqual(['p1', 'n1']);
    expect(project.outputs.differential_pairs?.map((p) => p.id)).toEqual(['D1']);
    expect(describeRemoved(summary.removed)).toBe('ports p2, n2; differential pair D2');
    expect(summary.shapesClipped).toBeGreaterThan(0);
    expect(area(numeric(project.board.outline))).toBeCloseTo(100, 9);
    expect(() => rasterise(project)).not.toThrow();
  });

  it('meshes a cut U exactly as two separate legs would', () => {
    const withU = (polygons: Vec2[][]): Project => {
      const doc = pairBoard();
      doc.geometry.top = polygons.map((p, n) => ({ id: `u${n}`, op: 'add', polygon: mmPoints(p) }));
      return doc;
    };
    const rect = { x0: -5, y0: -10, x1: 5, y1: 0 };
    const sectioned = sectionProject(withU([U]), rect).doc;
    expect(sectioned.geometry.top.map((s) => s.id)).toEqual(['u0', 'u0_2']);
    const legs: Vec2[][] = [[[-2, -9], [-1, -9], [-1, 0], [-2, 0]], [[1, -9], [2, -9], [2, 0], [1, 0]]];
    const reference = sectionProject(withU(legs), rect).doc;
    const port = { id: 'p', x: '-1.5 mm', y: '-8 mm', between: ['gnd', 'top'] as [string, string], reference_impedance_ohm: 50 };
    const mesh = (d: Project) => rasterise(parseProject({ ...d, ports: [port], outputs: { ...d.outputs, differential_pairs: undefined } })).model;
    const [a, b] = [mesh(sectioned), mesh(reference)];
    expect(a.eCurl.length).toBe(b.eCurl.length);
    expect(a.eCurl.every((v, n) => v === b.eCurl[n])).toBe(true);
  });

  it('keeps vias whose barrel fits, removes those on the boundary, and trims a fence to the vias inside', () => {
    const doc = pairBoard();
    doc.vias = [
      { id: 'in', x: '0 mm', y: '-5 mm', drill: '0.3 mm', between: ['gnd', 'top'] },
      { id: 'edge', x: '0 mm', y: '-0.1 mm', drill: '0.3 mm', between: ['gnd', 'top'] },
      { id: 'fence', x: '-4 mm', y: '-6 mm', drill: '0.3 mm', between: ['gnd', 'top'], to: ['-4 mm', '6 mm'], pitch: '1 mm' },
    ];
    const { doc: out, summary } = sectionProject(doc, { x0: -5, y0: -10, x1: 5, y1: 0 });
    expect(out.vias!.map((v) => v.id)).toEqual(['in', 'fence']);
    expect(summary.removed).toEqual(expect.arrayContaining([{ kind: 'via', id: 'edge' }]));
    expect(summary.fencesTrimmed).toEqual(['fence']);
    // y -6, -5, ..., -1 fit; y 0 would reach past the cut. The end sits half a pitch past the last via kept.
    expect(out.vias![1]).toMatchObject({ x: '-4 mm', y: '-6 mm', to: ['-4 mm', '-0.5 mm'], pitch: '1 mm' });
  });

  it('trims a diagonal fence so resolve still places every via kept, at any angle', () => {
    for (let k = 0; k < 40; k++) {
      const angle = 0.05 + k * 0.037;
      const pitch = 0.37;
      const doc = pairBoard();
      doc.vias = [{
        id: 'fence', x: '-3 mm', y: '-8 mm', drill: '0.2 mm', between: ['gnd', 'top'],
        to: [`${-3 + 12 * Math.cos(angle)} mm`, `${-8 + 12 * Math.sin(angle)} mm`], pitch: `${pitch} mm`,
      }];
      const { doc: out, summary } = sectionProject(doc, { x0: -5, y0: -10, x1: 4, y1: -3 });
      if (!summary.fencesTrimmed.length) continue;
      // The vias the section kept: those of the original fence whose barrel fits the rectangle.
      const fits = (x: number, y: number) => x - 0.1 >= -5 && x + 0.1 <= 4 && y - 0.1 >= -10 && y + 0.1 <= -3;
      const expected = Array.from({ length: Math.floor(12 / pitch + 1e-9) + 1 }, (_, m) => [-3 + m * pitch * Math.cos(angle), -8 + m * pitch * Math.sin(angle)])
        .filter(([x, y]) => fits(x, y)).length;
      const placed = resolveProject(parseProject(out)).vias.length;
      expect(placed, `angle ${angle.toFixed(3)} rad`).toBe(expected);
    }
  });

  it('removes components outside and keeps those inside', () => {
    const doc = pairBoard();
    doc.components = [
      { id: 'r_in', x: '0 mm', y: '-5 mm', between: ['gnd', 'top'], r_ohm: 50 },
      { id: 'r_out', x: '0 mm', y: '5 mm', between: ['gnd', 'top'], r_ohm: 50 },
    ];
    const { doc: out, summary } = sectionProject(doc, { x0: -5, y0: -10, x1: 5, y1: 0 });
    expect(out.components!.map((c) => c.id)).toEqual(['r_in']);
    expect(summary.removed).toEqual(expect.arrayContaining([{ kind: 'component', id: 'r_out' }]));
  });

  it('keeps an SMA edge port when its board edge stays, and removes it when the edge moves', () => {
    const doc = pairBoard();
    doc.ports = [{ kind: 'sma_edge', id: 'sma', edge: 'y_min', x: '0 mm', between: ['top', 'gnd'], reference_impedance_ohm: 50 }];
    doc.outputs.differential_pairs = undefined;
    expect(sectionProject(doc, { x0: -5, y0: -10, x1: 5, y1: 0 }).doc.ports.map((p) => p.id)).toEqual(['sma']);
    const moved = sectionProject(doc, { x0: -5, y0: -5, x1: 5, y1: 5 });
    expect(moved.doc.ports).toHaveLength(0);
    expect(moved.summary.notes).toEqual(['No port is left inside the section: add ports before solving.']);
  });

  it('says so when the excited ports are all cut away', () => {
    const doc = pairBoard();
    doc.analysis.excite = ['p2'];
    const { doc: out, summary } = sectionProject(doc, { x0: -5, y0: -10, x1: 5, y1: 0 });
    expect(out.analysis.excite).toBeUndefined();
    expect(summary.notes).toContain('None of the excited ports is inside the section, so every remaining port is now excited.');
  });

  it('refuses a rectangle off the board, with no width, or keeping no copper', () => {
    expect(() => sectionProject(pairBoard(), { x0: 20, y0: 20, x1: 30, y1: 30 })).toThrow(ImportError);
    expect(() => sectionProject(pairBoard(), { x0: 1, y0: 0, x1: 1, y1: 5 })).toThrow('width and height');
    const bare = pairBoard();
    for (const layer of Object.keys(bare.geometry)) bare.geometry[layer] = [];
    bare.geometry.top = [{ id: 'far', op: 'add', polygon: mmPoints([[3, 8], [4, 8], [4, 9], [3, 9]]) }];
    expect(() => sectionProject(bare, { x0: -5, y0: -10, x1: 0, y1: 0 })).toThrow('keeps no copper');
  });

  it('refuses a cut that splits the board outline in two', () => {
    const doc = pairBoard();
    doc.board.outline = mmPoints(U);
    expect(() => sectionProject(doc, { x0: -5, y0: -10, x1: 5, y1: 0 })).toThrow('2 separate pieces');
  });
});
