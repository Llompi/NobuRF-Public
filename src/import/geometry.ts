import type { Vec2 } from '../project/resolve';

/**
 * Planar geometry shared by the Gerber and DXF importers. Everything is in
 * millimetres. Curves become polygons whose chords stay within
 * ARC_CHORD_TOLERANCE_MM of the true curve (the sagitta), so an imported
 * circle is a slightly smaller inscribed polygon.
 */

/** mm rounded to 1 nm, the precision imported coordinates are written with. */
export const roundToNanometre = (mm: number) => Math.round(mm * 1e6) / 1e6 + 0; // + 0 turns -0 into 0

/** Largest distance between a true arc and its chords. */
export const ARC_CHORD_TOLERANCE_MM = 0.01;

/** Path endpoints closer than this are joined when chaining lines and arcs into closed loops. */
export const CHAIN_TOLERANCE_MM = 1e-3;

/** A copper polygon in mm, painted in order: "add" makes copper, "cut" removes it. */
export interface ImportedShape {
  op: 'add' | 'cut';
  polygon: Vec2[];
}

/** An import failure. The message names the file and, where there is one, the line. */
export class ImportError extends Error {}

export function failImport(sourceName: string, line: number | undefined, message: string): never {
  throw new ImportError(line === undefined ? `${sourceName}: ${message}` : `${sourceName}:${line}: ${message}`);
}

export function signedPolygonArea(polygon: Vec2[]): number {
  let twiceArea = 0;
  for (let n = 0; n < polygon.length; n++) {
    const [x0, y0] = polygon[n];
    const [x1, y1] = polygon[(n + 1) % polygon.length];
    twiceArea += x0 * y1 - x1 * y0;
  }
  return twiceArea / 2;
}

export function boundingBox(polygons: Vec2[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = polygons.flat();
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Crossing-number point in polygon (points on an edge may go either way). */
export function pointInPolygon(polygon: Vec2[], [x, y]: Vec2): boolean {
  let inside = false;
  for (let n = 0, prev = polygon.length - 1; n < polygon.length; prev = n++) {
    const [ax, ay] = polygon[prev];
    const [bx, by] = polygon[n];
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  return inside;
}

export const rotatePoint = ([x, y]: Vec2, degrees: number): Vec2 => {
  const a = (degrees * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};

export const translatePolygon = (polygon: Vec2[], [dx, dy]: Vec2): Vec2[] => polygon.map(([x, y]) => [x + dx, y + dy]);

/** Chords needed for `|sweepRadians|` of a circle of `radiusMm` within the chord tolerance. */
function arcChordCount(radiusMm: number, sweepRadians: number): number {
  if (radiusMm <= ARC_CHORD_TOLERANCE_MM) return Math.max(1, Math.ceil(Math.abs(sweepRadians) / (Math.PI / 2)));
  const maxChordAngle = 2 * Math.acos(1 - ARC_CHORD_TOLERANCE_MM / radiusMm);
  return Math.max(1, Math.ceil(Math.abs(sweepRadians) / maxChordAngle));
}

/**
 * Points on an arc from `startAngle` through `sweepRadians` (positive is
 * counter-clockwise), both ends included.
 */
export function arcPoints(center: Vec2, radiusMm: number, startAngle: number, sweepRadians: number): Vec2[] {
  const chords = arcChordCount(radiusMm, sweepRadians);
  return Array.from({ length: chords + 1 }, (_, n): Vec2 => {
    const a = startAngle + (sweepRadians * n) / chords;
    return [center[0] + radiusMm * Math.cos(a), center[1] + radiusMm * Math.sin(a)];
  });
}

/** Inscribed polygon of a circle, at least 8 vertices. */
export function circlePolygon(center: Vec2, radiusMm: number): Vec2[] {
  const vertices = Math.max(8, arcChordCount(radiusMm, 2 * Math.PI));
  return Array.from({ length: vertices }, (_, n): Vec2 => {
    const a = (2 * Math.PI * n) / vertices;
    return [center[0] + radiusMm * Math.cos(a), center[1] + radiusMm * Math.sin(a)];
  });
}

/**
 * The arc from `start` to `end` around `center`, as points after `start` up
 * to and including `end` (the exact `end`, so chained paths meet exactly).
 * A sweep of a full turn draws a whole circle back to `start`.
 */
export function arcPathPoints(start: Vec2, end: Vec2, center: Vec2, sweepRadians: number): Vec2[] {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const points = arcPoints(center, radius, startAngle, sweepRadians).slice(1);
  points[points.length - 1] = end;
  return points;
}

/** Counter-clockwise sweep in (0, 2 pi] from angle a0 to angle a1; equal angles are a full turn. */
export function counterClockwiseSweep(a0: number, a1: number): number {
  const sweep = (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return sweep < 1e-12 ? 2 * Math.PI : sweep;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points: Vec2[]): Vec2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Vec2[]) => {
    const hull: Vec2[] = [];
    for (const p of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

/**
 * A ring sector of an arc stroked with a round pen: the band between radii
 * r - h and r + h over the sweep, without end caps (the caller adds the caps as
 * circles). A full turn is an annulus, drawn as one polygon with a zero-width
 * cut-in from the outer to the inner circle so that it stays a single shape.
 */
export function arcBandPolygon(center: Vec2, radiusMm: number, halfWidthMm: number, startAngle: number, sweepRadians: number): Vec2[] {
  const outer = arcPoints(center, radiusMm + halfWidthMm, startAngle, sweepRadians);
  const inner = arcPoints(center, radiusMm - halfWidthMm, startAngle, sweepRadians).reverse();
  return [...outer, ...inner];
}

/**
 * Join open paths (point lists) end to end into closed loops. A path may be
 * used in either direction. Fails, naming a loose end, if a path cannot be
 * closed. Each loop is returned without its repeated closing point.
 */
export function chainIntoClosedLoops(paths: Vec2[][], sourceName: string, what: string): Vec2[][] {
  const near = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= CHAIN_TOLERANCE_MM;
  const unused = paths.map((p) => [...p]);
  const loops: Vec2[][] = [];
  while (unused.length > 0) {
    const loop = unused.shift()!;
    while (!near(loop[0], loop[loop.length - 1]) || loop.length < 3) {
      const tail = loop[loop.length - 1];
      const next = unused.findIndex((p) => near(p[0], tail) || near(p[p.length - 1], tail));
      if (next < 0) {
        const at = `(${tail[0].toFixed(4)}, ${tail[1].toFixed(4)}) mm`;
        failImport(sourceName, undefined, `${what}: a path ends at ${at} with nothing joined to it; the lines and arcs must form closed loops`);
      }
      const [piece] = unused.splice(next, 1);
      const forward = near(piece[0], tail) ? piece : piece.reverse();
      loop.push(...forward.slice(1));
    }
    loop.pop();
    loops.push(loop);
  }
  return loops;
}

/**
 * Closed contours to shapes by nesting (even-odd): a contour inside an even
 * number of others is copper, one inside an odd number is a hole. Shapes are
 * painted outermost first, so each hole cuts the copper around it.
 */
export function shapesFromNestedContours(contours: Vec2[][]): ImportedShape[] {
  const depth = contours.map((c, n) => contours.filter((other, m) => m !== n && pointInPolygon(other, c[0])).length);
  return contours
    .map((polygon, n) => ({ polygon, depth: depth[n] }))
    .sort((a, b) => a.depth - b.depth)
    .map(({ polygon, depth: d }) => ({ op: d % 2 === 0 ? 'add' : 'cut', polygon }));
}
