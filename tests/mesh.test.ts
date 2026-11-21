import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID, timestepSec } from '../src/engine/config';
import { buildCpml, uniformFaces } from '../src/engine/cpml';
import { CpuFdtd, pecBoxModel } from '../src/engine/fdtd_cpu';
import { cellWidth, dualWidth, gradedLines, mergeFixedLines, smallestCell, uniformLines, type MeshLines } from '../src/engine/mesh';
import type { GridConfig } from '../src/engine/types';

const widths = (lines: Float64Array) => Array.from(lines.subarray(1), (v, n) => v - lines[n]);

describe('mesh lines', () => {
  it('cell and dual widths on a uniform mesh are the cell size, including both ends', () => {
    const lines = uniformLines(5, -1, 0.5);
    expect(Array.from(lines)).toEqual([-1, -0.5, 0, 0.5, 1]);
    for (let i = 0; i < 5; i++) {
      expect(cellWidth(lines, i)).toBe(0.5);
      expect(dualWidth(lines, i)).toBe(0.5);
    }
  });

  it('dual width is the mean of the cells on either side of a node', () => {
    const lines = Float64Array.from([0, 1, 3, 6]);
    expect([0, 1, 2, 3].map((i) => dualWidth(lines, i))).toEqual([1, 1.5, 2.5, 3]);
  });

  it('graded lines keep every fixed line, respect the size limits and grow smoothly', () => {
    const intervals = [
      { start: -10, end: 0, maxCellMm: 2 },
      { start: 0, end: 0.3, maxCellMm: 2 }, // a narrow gap forces small cells around it
      { start: 0.3, end: 20, maxCellMm: 2 },
      { start: 20, end: 21.5, maxCellMm: 0.5 }, // a thin layer with its own limit
    ];
    const lines = gradedLines(intervals, { maxCellMm: 2, maxGrowth: 1.3 });
    for (const v of [-10, 0, 0.3, 20, 21.5]) expect(lines).toContain(v);
    const w = widths(lines);
    expect(Math.max(...w)).toBeLessThanOrEqual(2 + 1e-9);
    expect(Math.min(...w)).toBeGreaterThan(0.29);
    const inLayer = Array.from(lines).filter((v) => v >= 20 && v <= 21.5);
    expect(inLayer.length - 1).toBeGreaterThanOrEqual(3);
    for (let n = 1; n < w.length; n++) expect(Math.max(w[n] / w[n - 1], w[n - 1] / w[n])).toBeLessThan(1.3 * 1.15);
  });

  it('a refinement point shrinks cells near it', () => {
    const lines = gradedLines([{ start: 0, end: 10, maxCellMm: 1 }], { maxCellMm: 1, maxGrowth: 1.2 }, [{ at: 5, cellMm: 0.1 }]);
    const w = widths(lines);
    const near = w.filter((_, n) => Math.abs((lines[n] + lines[n + 1]) / 2 - 5) < 0.15);
    expect(Math.max(...near)).toBeLessThanOrEqual(0.1 * 1.25);
    expect(Math.max(...w)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('rejects intervals that are empty or do not touch', () => {
    expect(() => gradedLines([{ start: 0, end: 0, maxCellMm: 1 }], { maxCellMm: 1, maxGrowth: 1.3 })).toThrow(/empty/);
    expect(() => gradedLines([{ start: 0, end: 1, maxCellMm: 1 }, { start: 2, end: 3, maxCellMm: 1 }], { maxCellMm: 1, maxGrowth: 1.3 })).toThrow(/touch/);
    expect(() => gradedLines([{ start: 0, end: 1, maxCellMm: 1 }], { maxCellMm: 1, maxGrowth: 1 })).toThrow(/maxGrowth/);
  });

  it('merges fixed lines closer than the merge distance to their middle and reports them', () => {
    const { lines, merged } = mergeFixedLines([3, 1, 1.05, 1, 2], 0.1);
    expect(lines).toEqual([1.025, 2, 3]);
    expect(merged).toEqual([[1.025, 1], [1.025, 1.05]]);
  });

  it('merging keeps a pinned line exactly, else the middle of the preferred ones', () => {
    expect(mergeFixedLines([0, 0.05, 2], 0.1, { pinned: [0] }).lines).toEqual([0, 2]);
    expect(mergeFixedLines([1, 1.04, 1.08], 0.1, { preferred: [1.08] }).lines).toEqual([1.08]);
    expect(() => mergeFixedLines([0, 0.05], 0.1, { pinned: [0, 0.05] })).toThrow(/both stay exact/);
    // Mirrored input gives mirrored output (the old rule kept the first line of a pair).
    const values = [0.3, 0.33, 1, 1.07, 1.13, 4];
    const forward = mergeFixedLines(values, 0.08).lines;
    const mirrored = mergeFixedLines(values.map((v) => 5 - v), 0.08).lines.map((v) => 5 - v).reverse();
    forward.forEach((v, n) => expect(mirrored[n]).toBeCloseTo(v, 12));
  });

  it('a staircase of close lines keeps its ports and pins on lines, every gap at least the merge distance', () => {
    const gaps = (lines: number[]) => lines.slice(1).map((v, n) => v - lines[n]);
    // A port in the middle of a staircase stays exact; the lines either side space out from it.
    const port = mergeFixedLines([0, 0.06, 0.12, 0.18, 0.24], 0.07, { preferred: [0.12] });
    expect(port.lines).toContain(0.12);
    gaps(port.lines).forEach((g) => expect(g).toBeGreaterThanOrEqual(0.07));
    // Two ports closer than the merge distance share a line between them, and both are reported.
    const two = mergeFixedLines([0, 0.06, 0.11, 0.12, 0.18, 0.24], 0.07, { preferred: [0.11, 0.12] });
    expect(two.lines[1]).toBeCloseTo(0.115, 12);
    expect(two.merged.map(([, from]) => from)).toEqual(expect.arrayContaining([0.11, 0.12]));
    gaps(two.lines).forEach((g) => expect(g).toBeGreaterThanOrEqual(0.07));
    // A long even staircase becomes even lines from its first to its last.
    const stairs = mergeFixedLines(Array.from({ length: 11 }, (_, n) => n * 0.2), 0.25).lines;
    expect(stairs).toHaveLength(9);
    gaps(stairs).forEach((g) => expect(g).toBeCloseTo(0.25, 12));
  });

  it('graded lines do not depend on which way the axis runs', () => {
    // Short intervals of uneven length next to each other: the end-cell rounds used to depend on
    // the order the intervals were visited in, and a mirrored axis got a different mesh (self-verify, rot90).
    let seed = 7;
    const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 20; trial++) {
      const ends = [0];
      for (let n = 0; n < 8; n++) ends.push(ends.at(-1)! + (next() < 0.5 ? 0.1 + next() * 0.6 : 1 + next() * 6));
      const intervals = ends.slice(1).map((end, n) => ({ start: ends[n], end, maxCellMm: 1.2 }));
      const refinements = ends.map((at) => ({ at, cellMm: 0.2 + next() * 0.1 }));
      const options = { maxCellMm: 1.2, maxGrowth: 1.2 + next() * 0.3 };
      const forward = gradedLines(intervals, options, refinements);
      const top = ends.at(-1)!;
      const mirrored = gradedLines(
        intervals.map(({ start, end, maxCellMm }) => ({ start: top - end, end: top - start, maxCellMm })).reverse(),
        options, refinements.map(({ at, cellMm }) => ({ at: top - at, cellMm })),
      );
      expect(mirrored.length).toBe(forward.length);
      const back = Array.from(mirrored, (v) => top - v).reverse();
      forward.forEach((v, n) => expect(Math.abs(back[n] - v)).toBeLessThan(1e-9));
    }
  });

  it('graded lines keep neighbouring cells within about the growth limit without a cascade', () => {
    // Two short intervals side by side, each cut into whole cells: the old end-cell rule made
    // each one's rounding shrink the other's cells, round after round (0.27 mm -> 0.11 mm here).
    const intervals = [
      { start: 0, end: 5, maxCellMm: 1.2 },
      { start: 5, end: 5.7956, maxCellMm: 1.2 },
      { start: 5.7956, end: 6.4737, maxCellMm: 1.2 },
      { start: 6.4737, end: 12, maxCellMm: 1.2 },
    ];
    const refinements = [5, 5.7956, 6.4737].map((at) => ({ at, cellMm: 0.27 }));
    const w = widths(gradedLines(intervals, { maxCellMm: 1.2, maxGrowth: 1.3 }, refinements));
    expect(Math.min(...w)).toBeGreaterThan(0.2);
    for (let n = 1; n < w.length; n++) expect(Math.max(w[n] / w[n - 1], w[n - 1] / w[n])).toBeLessThan(1.3 * 1.05);
    // A lattice of equal short intervals keeps its equal cells.
    const lattice = Array.from({ length: 20 }, (_, n) => ({ start: n * 0.12, end: (n + 1) * 0.12, maxCellMm: 1 }));
    const latticeCells = widths(gradedLines(lattice, { maxCellMm: 1, maxGrowth: 1.3 }));
    for (const cell of latticeCells) expect(cell).toBeCloseTo(0.12, 9);
  });

  it('buildCpml insists that grid.dxMm is the smallest cell', () => {
    const grid: GridConfig = { ...DEFAULT_GRID, nx: 12, ny: 12, nz: 12, dxMm: 1, pmlCells: 0 };
    const mesh: MeshLines = { x: Float64Array.from({ length: 12 }, (_, i) => i * 1.5), y: uniformLines(12, 0, 1), z: uniformLines(12, 0, 1) };
    expect(() => buildCpml(grid, uniformFaces(0), undefined, mesh)).not.toThrow();
    expect(() => buildCpml({ ...grid, dxMm: 0.5 }, uniformFaces(0), undefined, mesh)).toThrow(/smallest mesh cell/);
    expect(() => buildCpml({ ...grid, nx: 13 }, uniformFaces(0), undefined, mesh)).toThrow(/nodes/);
  });
});

describe('graded mesh solver', () => {
  /**
   * PEC cavity, 20 x 30 mm in x and y, graded in both: TM110 depends on the
   * box size only, so a correct graded update must ring at the analytic
   * frequency even though no cell is the reference size everywhere.
   */
  it('closed cavity with graded x and y rings at the analytic TM110 frequency', () => {
    // The box's high wall sits one cell (the last width) past the last node.
    const graded = (lengthMm: number) => {
      const lines = gradedLines(
        [{ start: 0, end: lengthMm, maxCellMm: 1.5 }],
        { maxCellMm: 1.5, maxGrowth: 1.25 },
        [{ at: lengthMm / 3, cellMm: 0.5 }],
      );
      return lines.subarray(0, lines.length - 1);
    };
    const mesh: MeshLines = { x: graded(20), y: graded(30), z: uniformLines(6, 0, 1) };
    for (const axis of ['x', 'y'] as const) {
      const l = mesh[axis];
      expect(l.at(-1)! + cellWidth(l, l.length - 1)).toBeCloseTo(axis === 'x' ? 20 : 30, 9);
    }
    const [nx, ny, nz] = [mesh.x.length, mesh.y.length, mesh.z.length];
    const g: GridConfig = { ...DEFAULT_GRID, nx, ny, nz, dxMm: smallestCell(mesh), pmlCells: 0, groundK: 1 };
    const model = { ...pecBoxModel(g, 1), mesh };
    model.cpml = buildCpml(g, uniformFaces(0), undefined, mesh);
    const s = new CpuFdtd(model);
    const N = nx * ny * nz;
    const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
    const src = at(Math.round(nx / 4), Math.round(ny / 4), 3);
    const prb = at(Math.round((2 * nx) / 3), Math.round((2 * ny) / 3), 2);
    const T = 8000;
    const rec = new Float64Array(T);
    for (let n = 0; n < T; n++) {
      s.updateH();
      s.updateE();
      if (n < 120) s.e[2 * N + src] += Math.exp(-(((n - 60) / 20) ** 2));
      rec[n] = s.e[2 * N + prb];
    }
    // Bounded: a graded update that is not symmetric would grow without limit.
    expect(Math.max(...rec.subarray(T - 500).map(Math.abs))).toBeLessThan(10 * Math.max(...rec.subarray(0, 500).map(Math.abs)) + 1);
    const dt = timestepSec(g);
    const theory = (299_792_458 / 2) * Math.sqrt(1 / 0.02 ** 2 + 1 / 0.03 ** 2);
    let best = 0, bestF = 0;
    for (let f = 7e9; f < 11e9; f += 5e6) {
      let re = 0, im = 0;
      for (let n = 0; n < T; n++) {
        re += rec[n] * Math.cos(2 * Math.PI * f * n * dt);
        im += rec[n] * Math.sin(2 * Math.PI * f * n * dt);
      }
      if (re * re + im * im > best) { best = re * re + im * im; bestF = f; }
    }
    expect(Math.abs(bestF - theory) / theory).toBeLessThan(0.005);
  });
});
