/**
 * Rectilinear (tensor-product) mesh: one sorted list of node coordinates per
 * axis. Cell i along an axis spans [lines[i], lines[i+1]]; E tangential to the
 * axis sits on the nodes, H on the cell centres (the Yee layout of cpml.ts).
 *
 * The solver keeps its normalised units (e = E * dRef, h = eta0 * H * dRef,
 * Courant number relative to dRef), where dRef is the smallest cell of the
 * mesh. A difference across a cell of width w is scaled by dRef / w, and one
 * across a dual cell (centre to centre) by dRef / dual width. On a uniform
 * mesh both factors are exactly 1, so uniform results are bit-identical to the
 * cubic-cell solver.
 */
export interface MeshLines {
  /** Node coordinates in mm along x, y, z: nx, ny, nz entries, strictly increasing. */
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

export type Axis = 'x' | 'y' | 'z';
export const AXES: readonly Axis[] = ['x', 'y', 'z'];

export function uniformLines(n: number, originMm: number, cellMm: number): Float64Array {
  return Float64Array.from({ length: n }, (_, i) => originMm + i * cellMm);
}

/**
 * Width of cell i (node i to node i + 1). The last node has no cell above it
 * inside the box; it reuses the width of the cell below, which is what the
 * PEC wall at the high face sees.
 */
export function cellWidth(lines: Float64Array, i: number): number {
  const n = lines.length;
  return i + 1 < n ? lines[i + 1] - lines[i] : lines[n - 1] - lines[n - 2];
}

/** Distance between the cell centres on either side of node i (the cell below node 0 mirrors cell 0). */
export function dualWidth(lines: Float64Array, i: number): number {
  const below = i > 0 ? cellWidth(lines, i - 1) : cellWidth(lines, 0);
  return (below + cellWidth(lines, i)) / 2;
}

function cellWidths(mesh: MeshLines): number[] {
  return AXES.flatMap((axis) => Array.from(mesh[axis].subarray(1), (v, i) => v - mesh[axis][i]));
}

/** Smallest cell width over all three axes: the solver's reference length. */
export function smallestCell(mesh: MeshLines): number {
  return cellWidths(mesh).reduce((a, b) => Math.min(a, b), Infinity);
}

/** Largest cell width over all three axes. */
export function largestCell(mesh: MeshLines): number {
  return cellWidths(mesh).reduce((a, b) => Math.max(a, b), 0);
}

export interface GradingOptions {
  /** Largest cell anywhere. */
  maxCellMm: number;
  /** Ratio limit between neighbouring cells, e.g. 1.3. */
  maxGrowth: number;
}

/** One stretch between two fixed lines and the largest cell it may hold (its own length at most). */
export interface FixedInterval {
  start: number;
  end: number;
  maxCellMm: number;
}

/** A point (e.g. a copper edge) where cells may be at most `cellMm`, growing away from it. */
export interface Refinement {
  at: number;
  cellMm: number;
  /** Cells stay at most cellMm within this distance either side of `at` before they start to grow (0 by default). */
  holdMm?: number;
}

/**
 * Mesh lines between the interval ends (all kept exactly), graded so that
 *   - no cell exceeds the smaller of options.maxCellMm and its interval's own limit,
 *   - cells near a refinement point are at most its cellMm,
 *   - neighbouring cells differ by about options.maxGrowth at most.
 *
 * Method: a size field s(u), the smallest of maxCellMm, each refinement's
 * cell_r + (g - 1) |u - at_r| and each interval's term: its limit inside it,
 * and outside it the cell at its nearer end plus (g - 1) times the distance.
 * Linear growth with slope g - 1 gives a neighbour ratio of about g. Each
 * interval [a, b] gets n = ceil(integral of du / s) cells, placed where the
 * running integral of 1/s crosses k/n of the total, so every cell is at most
 * s and the cells follow the field smoothly.
 *
 * End cells. An interval's end cell starts at its limit. A short interval cut
 * into n whole cells has cells of length / n, below the field everywhere in
 * it (0.3 mm at 0.25 mm makes two 0.15 mm cells), so the cell across its end
 * may come out more than g times larger. Where it does, the neighbour must
 * grow from the actual cell: that end cell is lowered to it and the field
 * rebuilt until no neighbouring cells across an interval end differ by more
 * than g. An interval's own cells always use its limit, so lowering its end
 * never adds cells to it (which would lower the end again, and so on). Each
 * round checks every interval end against the same placement, so the result
 * does not depend on the order of the intervals: mirrored intervals give
 * mirrored lines.
 */
export function gradedLines(intervals: FixedInterval[], options: GradingOptions, refinements: Refinement[] = []): Float64Array {
  if (intervals.length === 0) throw new Error('gradedLines needs at least one interval');
  if (!(options.maxGrowth > 1)) throw new Error(`maxGrowth must be above 1, got ${options.maxGrowth}`);
  for (let n = 0; n < intervals.length; n++) {
    const iv = intervals[n];
    if (!(iv.end > iv.start)) throw new Error(`mesh interval ${n} is empty: [${iv.start}, ${iv.end}] mm`);
    if (n > 0 && Math.abs(iv.start - intervals[n - 1].end) > 1e-12) throw new Error(`mesh intervals ${n - 1} and ${n} do not touch`);
  }
  const growth = options.maxGrowth;
  const slope = growth - 1;
  const limits = intervals.map((iv) => Math.min(options.maxCellMm, iv.maxCellMm, iv.end - iv.start));
  const lowEnds = [...limits];
  const highEnds = [...limits];
  /** The size field at u; `skip` leaves out one interval's term (the field its neighbour sees at a shared end). */
  const sizeAt = (u: number, skip = -1): number => {
    let s = options.maxCellMm;
    for (let j = 0; j < intervals.length; j++) {
      if (j === skip) continue;
      const { start, end } = intervals[j];
      s = Math.min(s, u < start ? lowEnds[j] + slope * (start - u) : u > end ? highEnds[j] + slope * (u - end) : limits[j]);
    }
    for (const r of refinements) s = Math.min(s, r.cellMm + slope * Math.max(0, Math.abs(u - r.at) - (r.holdMm ?? 0)));
    return s;
  };
  // Midpoint samples fine enough that one sample spans at most an eighth of the smallest cell.
  const smallestSize = () => Math.min(...limits, ...lowEnds, ...highEnds, ...refinements.map((r) => r.cellMm));
  /** Lines strictly inside [start, end], where the running integral of 1/s (midpoint rule) crosses k/n of its total. */
  const place = (start: number, end: number, smallest: number): number[] => {
    const samples = Math.min(1 << 20, Math.max(256, Math.ceil((8 * (end - start)) / smallest)));
    const step = (end - start) / samples;
    const cumulative = new Float64Array(samples + 1);
    for (let m = 0; m < samples; m++) cumulative[m + 1] = cumulative[m] + step / sizeAt(start + (m + 0.5) * step);
    const total = cumulative[samples];
    const cells = Math.max(1, Math.ceil(total - 1e-9));
    const inner: number[] = [];
    let m = 0;
    for (let k = 1; k < cells; k++) {
      const target = (k / cells) * total;
      while (cumulative[m + 1] < target) m++;
      inner.push(start + (m + (target - cumulative[m]) / (cumulative[m + 1] - cumulative[m])) * step);
    }
    return inner;
  };
  // Ends only ever fall, to a placed cell, so the rounds end; the bound catches a bug, not a mesh.
  const maxRounds = 4 * intervals.length + 8;
  for (let round = 0; ; round++) {
    if (round === maxRounds) throw new Error(`gradedLines: interval end cells still changing after ${maxRounds} rounds`);
    const smallest = smallestSize();
    const cells = intervals.map(({ start, end }) => {
      const nodes = [start, ...place(start, end, smallest), end];
      return { first: nodes[1] - start, last: end - nodes[nodes.length - 2] };
    });
    let changed = false;
    for (let j = 0; j + 1 < intervals.length; j++) {
      const [below, above] = [cells[j].last, cells[j + 1].first];
      if (below > growth * above && above < lowEnds[j + 1]) [lowEnds[j + 1], changed] = [above, true];
      if (above > growth * below && below < highEnds[j]) [highEnds[j], changed] = [below, true];
    }
    if (!changed) break;
  }

  const smallest = smallestSize();
  const lines: number[] = [intervals[0].start];
  for (const { start, end } of intervals) lines.push(...place(start, end, smallest), end);
  return Float64Array.from(lines);
}

/**
 * Sorted fixed coordinates with near-duplicates merged, so that no two lines
 * end up closer than `mergeMm`. Lines closer than `mergeMm` to a neighbour
 * form a group (a chain of close lines is one group). A group no longer than
 * `mergeMm` becomes one line: the `pinned` value it holds (a board end, which
 * must stay exact), else the middle of the `preferred` values it holds (a
 * port, which then stays on its copper when it is the only one), else the
 * middle of its first and last line. A longer chain (a staircase of close
 * edges) keeps anchors: its pinned and preferred values and its first and
 * last line, where anchors closer than `mergeMm` merge by the same rule
 * (pin, else middle of preferred, else middle). Between anchors it puts
 * evenly spaced lines at least `mergeMm` apart. Two ports closer than
 * `mergeMm` therefore share a line between them, and both are reported as
 * moved. Two pins closer than `mergeMm` throw. Middles and even spacing,
 * rather than the first or last line, keep the result the same under a
 * mirror. Returns the merged list and, for each line that moved, [where it
 * went, where it was], so the caller can warn.
 */
export function mergeFixedLines(
  values: number[], mergeMm: number, { pinned = [], preferred = [] }: { pinned?: number[]; preferred?: number[] } = {},
): { lines: number[]; merged: Array<[number, number]> } {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const middle = (group: number[]) => (group.length === 0 ? undefined : (group[0] + group[group.length - 1]) / 2);
  /** One line for values within `mergeMm` of each other: the pin, else the middle of the preferred, else the middle. */
  const oneLine = (group: number[]): number => {
    const pin = group.filter((v) => pinned.includes(v));
    if (pin.length > 1) throw new Error(`mesh lines ${pin.join(' and ')} must both stay exact but are closer than ${mergeMm} mm`);
    return pin[0] ?? middle(group.filter((v) => preferred.includes(v))) ?? middle(group)!;
  };
  /** Runs of sorted values whose neighbours are at most `mergeMm` apart. */
  const chains = (list: number[]): number[][] => {
    const out: number[][] = [];
    for (const v of list) {
      const run = out[out.length - 1];
      if (run && v - run[run.length - 1] <= mergeMm) run.push(v);
      else out.push([v]);
    }
    return out;
  };
  const lines: number[] = [];
  const merged: Array<[number, number]> = [];
  for (const group of chains(sorted)) {
    let kept: number[];
    if (group[group.length - 1] - group[0] <= mergeMm) {
      kept = [oneLine(group)];
    } else {
      // Anchors more than mergeMm apart (each merged anchor lies within its run, so runs stay apart), then even fill.
      const anchorValues = group.filter((v, n) => n === 0 || n === group.length - 1 || pinned.includes(v) || preferred.includes(v));
      const anchors = chains(anchorValues).map(oneLine);
      kept = [anchors[0]];
      for (let n = 1; n < anchors.length; n++) {
        const [a, b] = [anchors[n - 1], anchors[n]];
        const gaps = Math.max(1, Math.floor((b - a) / mergeMm));
        for (let m = 1; m <= gaps; m++) kept.push(m === gaps ? b : a + ((b - a) * m) / gaps);
      }
    }
    lines.push(...kept);
    for (const v of group) if (!kept.includes(v)) merged.push([kept.reduce((u, w) => (Math.abs(w - v) < Math.abs(u - v) ? w : u)), v]);
  }
  return { lines, merged };
}
