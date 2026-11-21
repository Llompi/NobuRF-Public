import type { Vec2 } from './resolve';

/**
 * Exact copper coverage of the Yee edges and faces of one copper plane, for
 * the conformal sheet model (src/engine/conformal.ts).
 *
 * The copper is given as a point test `covered(x, y)` (the painted shapes,
 * clipped to the board) and the polygon segments that bound it. Between two
 * consecutive crossings of a segment, `covered` is constant along a line, so
 * the covered length of an edge is exact: cut the edge at every crossing and
 * test the midpoint of each piece. The covered area of a face is the integral
 * of the covered length of vertical lines across it. Cut at every vertex, at
 * every crossing of a segment with the face's top and bottom, and at every
 * crossing of two segments, the covered length is linear in x on each piece,
 * so the midpoint rule is exact there too. Testing midpoints with the same
 * `covered` as the staircase rasteriser keeps its rules for rims, cuts and the
 * board edge, including copper edges lying on a mesh line.
 *
 * Only faces that a segment reaches need this. Every other face, and every
 * edge of no such face, lies wholly on one side of all segments, and its centre
 * decides it.
 */
export interface PlaneCoverage {
  /** Covered fraction (0..1) of Ex (i+1/2, j), Ey (i, j+1/2) and the z face (i+1/2, j+1/2), indexed i + nx * j. */
  ex: Float64Array;
  ey: Float64Array;
  face: Float64Array;
}

export interface Segment {
  a: Vec2;
  b: Vec2;
}

/** Distances below this (mm) count as touching, as the rasteriser's EDGE_TOLERANCE_MM. */
const TOLERANCE_MM = 1e-9;

export function polygonSegments(polygon: Vec2[]): Segment[] {
  return polygon.map((a, n) => ({ a, b: polygon[(n + 1) % polygon.length] }));
}

/** Index of the last line at or below `value` (clamped to the first cell). */
function cellBelow(lines: Float64Array, value: number): number {
  let lo = 0;
  let hi = lines.length - 2;
  if (value <= lines[0]) return 0;
  if (value >= lines[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Whether segment s reaches the closed rectangle [x0, x1] x [y0, y1] (Liang-Barsky clip). */
function segmentTouchesBox(s: Segment, x0: number, x1: number, y0: number, y1: number): boolean {
  const [ax, ay] = s.a;
  const dx = s.b[0] - ax;
  const dy = s.b[1] - ay;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-300) return q >= -TOLERANCE_MM;
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    return t0 <= t1 + 1e-12;
  };
  return clip(-dx, ax - (x0 - TOLERANCE_MM)) && clip(dx, x1 + TOLERANCE_MM - ax) && clip(-dy, ay - (y0 - TOLERANCE_MM)) && clip(dy, y1 + TOLERANCE_MM - ay);
}

/**
 * Where the segments cross the axis-aligned line `axis` = `at` (axis 1: the
 * horizontal line y = at, coordinates returned in x; axis 0: the vertical line
 * x = at, returned in y). A segment lying on the line gives its two ends.
 */
function crossings(segments: Segment[], axis: 0 | 1, at: number, out: number[]): void {
  const other = axis === 1 ? 0 : 1;
  for (const { a, b } of segments) {
    const da = a[axis] - at;
    const db = b[axis] - at;
    if (Math.abs(da) <= TOLERANCE_MM && Math.abs(db) <= TOLERANCE_MM) {
      out.push(a[other], b[other]);
    } else if (da * db <= 0) {
      out.push(a[other] + ((b[other] - a[other]) * da) / (da - db));
    }
  }
}

/** Covered length of the axis-aligned edge from `lo` to `hi` on the line `axis` = `at` (see crossings for the axis convention). */
function coveredLength(segments: Segment[], covered: (x: number, y: number) => boolean, axis: 0 | 1, at: number, lo: number, hi: number): number {
  const cuts = [lo, hi];
  crossings(segments, axis, at, cuts);
  const ts = cuts.filter((t) => t > lo && t < hi);
  ts.push(lo, hi);
  ts.sort((p, q) => p - q);
  let length = 0;
  for (let n = 1; n < ts.length; n++) {
    const piece = ts[n] - ts[n - 1];
    if (piece <= TOLERANCE_MM * 1e-3) continue;
    const mid = (ts[n] + ts[n - 1]) / 2;
    if (axis === 1 ? covered(mid, at) : covered(at, mid)) length += piece;
  }
  return length;
}

/** Covered area of the face [x0, x1] x [y0, y1]: the covered length of vertical lines, exact by pieces (see the module comment). */
function coveredArea(segments: Segment[], covered: (x: number, y: number) => boolean, x0: number, x1: number, y0: number, y1: number): number {
  const xs = [x0, x1];
  for (const { a, b } of segments) xs.push(a[0], b[0]);
  crossings(segments, 1, y0, xs);
  crossings(segments, 1, y1, xs);
  for (let p = 0; p < segments.length; p++) {
    for (let q = p + 1; q < segments.length; q++) {
      const x = intersectionX(segments[p], segments[q]);
      if (x !== null) xs.push(x);
    }
  }
  const cuts = xs.filter((x) => x > x0 && x < x1);
  cuts.push(x0, x1);
  cuts.sort((p, q) => p - q);
  let area = 0;
  for (let n = 1; n < cuts.length; n++) {
    const width = cuts[n] - cuts[n - 1];
    if (width <= TOLERANCE_MM * 1e-3) continue;
    area += width * coveredLength(segments, covered, 0, (cuts[n] + cuts[n - 1]) / 2, y0, y1);
  }
  return area;
}

/** x of the point where two segments cross, or null if they do not (or are parallel). */
function intersectionX(s: Segment, t: Segment): number | null {
  const [px, py] = s.a;
  const [rx, ry] = [s.b[0] - px, s.b[1] - py];
  const [qx, qy] = t.a;
  const [sx, sy] = [t.b[0] - qx, t.b[1] - qy];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-300) return null;
  const u = ((qx - px) * sy - (qy - py) * sx) / den;
  const v = ((qx - px) * ry - (qy - py) * rx) / den;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? px + u * rx : null;
}

/**
 * Coverage of every edge and z face of a plane with node lines `xLines` and
 * `yLines` (nx and ny of them). Edges and faces past the last line are 0.
 */
export function planeCoverage(xLines: Float64Array, yLines: Float64Array, segments: Segment[], covered: (x: number, y: number) => boolean): PlaneCoverage {
  const nx = xLines.length;
  const ny = yLines.length;
  const ex = new Float64Array(nx * ny);
  const ey = new Float64Array(nx * ny);
  const face = new Float64Array(nx * ny);
  // Segments reaching each face that any segment reaches.
  const near = new Map<number, Segment[]>();
  for (const s of segments) {
    const [i0, i1] = [cellBelow(xLines, Math.min(s.a[0], s.b[0]) - TOLERANCE_MM), cellBelow(xLines, Math.max(s.a[0], s.b[0]) + TOLERANCE_MM)];
    const [j0, j1] = [cellBelow(yLines, Math.min(s.a[1], s.b[1]) - TOLERANCE_MM), cellBelow(yLines, Math.max(s.a[1], s.b[1]) + TOLERANCE_MM)];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!segmentTouchesBox(s, xLines[i], xLines[i + 1], yLines[j], yLines[j + 1])) continue;
        const col = i + nx * j;
        const list = near.get(col);
        if (list) list.push(s);
        else near.set(col, [s]);
      }
    }
  }
  // Centre rule everywhere first; the faces in `near` and their edges are then computed exactly.
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const col = i + nx * j;
      const [xm, ym] = [i + 1 < nx ? (xLines[i] + xLines[i + 1]) / 2 : NaN, j + 1 < ny ? (yLines[j] + yLines[j + 1]) / 2 : NaN];
      if (i + 1 < nx) ex[col] = covered(xm, yLines[j]) ? 1 : 0;
      if (j + 1 < ny) ey[col] = covered(xLines[i], ym) ? 1 : 0;
      if (i + 1 < nx && j + 1 < ny) face[col] = covered(xm, ym) ? 1 : 0;
    }
  }
  const edgeSegments = new Map<number, Segment[]>();
  const addEdge = (key: number, list: Segment[]) => {
    const known = edgeSegments.get(key);
    edgeSegments.set(key, known ? [...new Set([...known, ...list])] : list);
  };
  for (const [col, list] of near) {
    const i = col % nx;
    const j = (col - i) / nx;
    const [x0, x1, y0, y1] = [xLines[i], xLines[i + 1], yLines[j], yLines[j + 1]];
    face[col] = coveredArea(list, covered, x0, x1, y0, y1) / ((x1 - x0) * (y1 - y0));
    // Edge keys: 2 * col for Ex, 2 * col + 1 for Ey.
    addEdge(2 * col, list);
    addEdge(2 * (col + nx), list);
    addEdge(2 * col + 1, list);
    addEdge(2 * (col + 1) + 1, list);
  }
  for (const [key, list] of edgeSegments) {
    const col = key >> 1;
    const i = col % nx;
    const j = (col - i) / nx;
    if (key & 1) {
      if (j + 1 < ny) ey[col] = coveredLength(list, covered, 0, xLines[i], yLines[j], yLines[j + 1]) / (yLines[j + 1] - yLines[j]);
    } else if (i + 1 < nx) {
      ex[col] = coveredLength(list, covered, 1, yLines[j], xLines[i], xLines[i + 1]) / (xLines[i + 1] - xLines[i]);
    }
  }
  return { ex, ey, face };
}
