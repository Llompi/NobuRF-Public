/**
 * Section a board: keep only what lies inside an axis-aligned rectangle, so a
 * small area of a large imported board (a connector and the traces leaving
 * it) can be solved on its own. Copper and the board outline are clipped to
 * the rectangle; ports, components and vias outside it are removed, a via
 * fence is cut to the vias inside, and anything that refers to a removed port
 * goes with it.
 *
 * Clipping is one half-plane at a time. A concave polygon that leaves and
 * re-enters the rectangle comes back as separate pieces, never as one polygon
 * joined by zero-width runs along the cut: paint() counts a point on an edge
 * as copper, so such a run would be a strip of metal along the new board edge,
 * shorting every trace that reaches it.
 *
 * Coordinates are evaluated (variables included) and written back as plain
 * "<mm> mm" lengths, like an import writes them.
 */
import { evaluate, evaluateLength, ExpressionError, type Quantity } from '../project/expression';
import type { Vec2 } from '../project/resolve';
import type { CopperShape, LumpedComponent, Point, Port, Project, SmaEdgePort, Via } from '../project/schema';
import { ImportError, roundToNanometre, signedPolygonArea } from './geometry';

export interface SectionRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Removed {
  kind: 'port' | 'component' | 'via' | 'differential pair';
  id: string;
}

export interface SectionSummary {
  shapesKept: number;
  shapesClipped: number;
  shapesRemoved: number;
  /** Shapes the cut split into more than one piece. */
  shapesSplit: number;
  removed: Removed[];
  /** Via fences cut down to the vias inside the rectangle. */
  fencesTrimmed: string[];
  /** Things the user should know about the result, as sentences. */
  notes: string[];
}

/** Below this area (mm^2) a clipped polygon paints nothing and is left out. */
const MIN_AREA_MM2 = 1e-9;

/** The rectangle with x0 < x1 and y0 < y1, whichever corners it was given by. */
export function normaliseRect(r: SectionRect): SectionRect {
  return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
}

interface HalfPlane {
  /** Positive strictly inside; zero on the line. */
  side: (p: Vec2) => number;
  /** Position along the line, to order the crossings on it. */
  along: (p: Vec2) => number;
}

/**
 * The parts of a simple polygon on the positive side of a line, each its own
 * polygon. Points on the line count as outside, so an edge lying on the line
 * belongs to no piece; the line between an exit and the entry paired with it
 * closes each piece. Crossings on the line pair up in order (inside the
 * polygon from the 1st to the 2nd, the 3rd to the 4th, ...), as they do on any
 * line through a simple polygon.
 */
function clipHalfPlane(ring: Vec2[], { side, along }: HalfPlane): Vec2[][] {
  const n = ring.length;
  const s = ring.map(side);
  const inside = s.map((v) => v > 0);
  if (inside.every(Boolean)) return [ring];
  if (!inside.some(Boolean)) return [];
  const cross = (a: number, b: number): Vec2 => {
    if (s[b] === 0) return ring[b];
    if (s[a] === 0) return ring[a];
    const t = s[a] / (s[a] - s[b]);
    return [ring[a][0] + t * (ring[b][0] - ring[a][0]), ring[a][1] + t * (ring[b][1] - ring[a][1])];
  };
  // Runs of inside vertices, each from the point where the ring enters to where it leaves.
  const start = inside.indexOf(false);
  const chains: Vec2[][] = [];
  let chain: Vec2[] = [];
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    const prev = (start + k - 1) % n;
    if (inside[i]) {
      if (!inside[prev]) chain = [cross(prev, i)];
      chain.push(ring[i]);
    } else if (inside[prev]) {
      chain.push(cross(prev, i));
      chains.push(chain);
    }
  }
  // Crossings are ordered to 1 nm. Where several share a place, each pairs with one of the other kind: a Gerber
  // region's keyhole bridge (the zero-width cut a CAM tool joins a pour's hole to its outline by) crosses the
  // line twice at one point, an entry and an exit, which close the run before it and open the run after it.
  type Event = { t: number; index: number; entry: boolean };
  const events: Event[] = chains.flatMap((c, index) => [
    { t: roundToNanometre(along(c[0])), index, entry: true },
    { t: roundToNanometre(along(c[c.length - 1])), index, entry: false },
  ]).sort((a, b) => a.t - b.t);
  // Each exit continues at the entry it pairs with on the line.
  const next = new Map<number, number>();
  const unpairable = () => new ImportError('a shape crosses the section edge in a way the clipper cannot pair (is it self-intersecting?)');
  let pending: Event | null = null;
  for (let k = 0; k < events.length;) {
    const group: Event[] = [];
    for (const t = events[k].t; k < events.length && events[k].t === t; k++) group.push(events[k]);
    while (group.length) {
      if (!pending) {
        pending = group.shift()!;
        continue;
      }
      const other = group.findIndex((e) => e.entry !== pending!.entry);
      if (other < 0) throw unpairable();
      const [match] = group.splice(other, 1);
      const [exit, entry] = pending.entry ? [match, pending] : [pending, match];
      next.set(exit.index, entry.index);
      pending = null;
    }
  }
  if (pending) throw unpairable();
  const pieces: Vec2[][] = [];
  const used = new Set<number>();
  for (let first = 0; first < chains.length; first++) {
    if (used.has(first)) continue;
    const piece: Vec2[] = [];
    for (let c: number | undefined = first; c !== undefined && !used.has(c); c = next.get(c)) {
      used.add(c);
      piece.push(...chains[c]);
    }
    pieces.push(piece);
  }
  return pieces;
}

/** The parts of `polygon` inside `rect`, each a separate polygon; empty when none of it is. */
export function clipPolygonToRect(polygon: Vec2[], rect: SectionRect): Vec2[][] {
  const r = normaliseRect(rect);
  const planes: HalfPlane[] = [
    { side: (p) => p[0] - r.x0, along: (p) => p[1] },
    { side: (p) => r.x1 - p[0], along: (p) => p[1] },
    { side: (p) => p[1] - r.y0, along: (p) => p[0] },
    { side: (p) => r.y1 - p[1], along: (p) => p[0] },
  ];
  // Points on the rectangle's edge count as outside while clipping; a polygon wholly inside, edges included,
  // must come back whole, so test that first.
  if (polygon.every(([x, y]) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) return [polygon];
  let pieces = [polygon];
  for (const plane of planes) pieces = pieces.flatMap((p) => clipHalfPlane(p, plane));
  // A guard, not a proof: the pieces' total area must match Sutherland-Hodgman's for the same cut (its zero-width
  // runs add no area). A mismatch means the pairing went wrong, and a wrong board is worse than a refusal; a
  // wrong pairing that happens to keep the area would pass it.
  const expected = sutherlandHodgmanArea(polygon, r);
  const got = pieces.reduce((sum, p) => sum + signedPolygonArea(p), 0);
  if (Math.abs(got - expected) > 1e-9 * Math.max(1, Math.abs(expected))) {
    throw new ImportError(`clipping a shape gave ${got} mm² instead of ${expected} mm² (is it self-intersecting?)`);
  }
  return pieces;
}

function sutherlandHodgmanArea(polygon: Vec2[], r: SectionRect): number {
  const edges: Array<[(p: Vec2) => boolean, (a: Vec2, b: Vec2) => Vec2]> = [
    [(p) => p[0] >= r.x0, (a, b) => [r.x0, a[1] + ((b[1] - a[1]) * (r.x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= r.x1, (a, b) => [r.x1, a[1] + ((b[1] - a[1]) * (r.x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= r.y0, (a, b) => [a[0] + ((b[0] - a[0]) * (r.y0 - a[1])) / (b[1] - a[1]), r.y0]],
    [(p) => p[1] <= r.y1, (a, b) => [a[0] + ((b[0] - a[0]) * (r.y1 - a[1])) / (b[1] - a[1]), r.y1]],
  ];
  let out = polygon;
  for (const [inside, cross] of edges) {
    if (out.length === 0) break;
    const input = out;
    out = [];
    for (let n = 0; n < input.length; n++) {
      const current = input[n];
      const previous = input[(n + input.length - 1) % input.length];
      if (inside(current) !== inside(previous)) out.push(cross(previous, current));
      if (inside(current)) out.push(current);
    }
  }
  return out.length < 3 ? 0 : signedPolygonArea(out);
}

/** Round to 1 nm and drop repeated consecutive points, the closing one included. */
function tidy(polygon: Vec2[]): Vec2[] {
  const rounded = polygon.map(([x, y]): Vec2 => [roundToNanometre(x), roundToNanometre(y)]);
  return rounded.filter(([x, y], n) => {
    const [px, py] = rounded[(n + rounded.length - 1) % rounded.length];
    return rounded.length === 1 || x !== px || y !== py;
  });
}

const sameShape = (a: Vec2[], b: Vec2[]) => a.length === b.length && a.every(([x, y], n) => x === b[n][0] && y === b[n][1]);

const toLength = (mm: number) => `${roundToNanometre(mm)} mm`;
const toPoint = ([x, y]: Vec2): Point => [toLength(x), toLength(y)];
const hasArea = (p: Vec2[]) => p.length >= 3 && Math.abs(signedPolygonArea(p)) >= MIN_AREA_MM2;

/** A length evaluator over the project's variables (bounds are the schema's business, not ours). */
function lengthReader(doc: Project): (source: string, path: string) => number {
  const cache = new Map<string, Quantity>();
  const variable = (name: string, chain: readonly string[]): Quantity => {
    const known = cache.get(name);
    if (known) return known;
    const def = doc.variables?.[name];
    if (!def) throw new ExpressionError(`unknown variable "${name}"`);
    if (chain.includes(name)) throw new ExpressionError(`variables depend on each other in a cycle: ${[...chain, name].join(' -> ')}`);
    const q = evaluate(def.value, (n) => variable(n, [...chain, name]));
    cache.set(name, q);
    return q;
  };
  return (source, path) => {
    try {
      return evaluateLength(source, (n) => variable(n, []));
    } catch (e) {
      if (e instanceof ExpressionError) throw new ImportError(`${path}: ${e.message}`);
      throw e;
    }
  };
}

/** An id with a suffix, cut to the 32 characters ids may have, unused in `taken`. */
function freshId(base: string, taken: Set<string>): string {
  for (let k = 2; ; k++) {
    const suffix = `_${k}`;
    const id = base.slice(0, 32 - suffix.length) + suffix;
    if (!taken.has(id)) return id;
  }
}

/** Box of a polygon: [minX, minY, maxX, maxY]. */
function box(polygon: Vec2[]): [number, number, number, number] {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The project cut down to `rect` (mm), and what was kept and removed. Throws
 * an ImportError when the rectangle misses the board outline, cuts the board
 * into separate pieces, or keeps no copper at all.
 */
export function sectionProject(doc: Project, rect: SectionRect): { doc: Project; summary: SectionSummary } {
  const r = normaliseRect(rect);
  if (!(r.x1 - r.x0 > 0 && r.y1 - r.y0 > 0)) throw new ImportError('the section needs a rectangle with width and height');
  const mm = lengthReader(doc);
  const inside = (x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  const point = (p: [string, string], path: string): Vec2 => [mm(p[0], `${path}[0]`), mm(p[1], `${path}[1]`)];
  const removed: Removed[] = [];
  const notes: string[] = [];

  const oldOutline = doc.board.outline.map((p, n) => point(p, `$.board.outline[${n}]`));
  const outlinePieces = clipPolygonToRect(oldOutline, r).map(tidy).filter(hasArea);
  if (outlinePieces.length === 0) throw new ImportError('the section rectangle does not overlap the board outline');
  if (outlinePieces.length > 1) throw new ImportError(`the section cuts the board into ${outlinePieces.length} separate pieces; a board outline is one polygon, so draw the rectangle over one of them`);
  const outline = outlinePieces[0];

  let shapesKept = 0;
  let shapesClipped = 0;
  let shapesRemoved = 0;
  let shapesSplit = 0;
  const geometry: Record<string, CopperShape[]> = {};
  for (const [layer, shapes] of Object.entries(doc.geometry)) {
    geometry[layer] = [];
    const ids = new Set(shapes.map((s) => s.id));
    shapes.forEach((shape, n) => {
      const original = tidy(shape.polygon.map((p, k) => point(p, `$.geometry.${layer}[${n}].polygon[${k}]`)));
      let pieces: Vec2[][];
      try {
        pieces = clipPolygonToRect(original, r).map(tidy).filter(hasArea);
      } catch (e) {
        throw new ImportError(`$.geometry.${layer}[${n}] (${shape.id}): ${(e as Error).message}`);
      }
      if (pieces.length === 0) return void shapesRemoved++;
      if (pieces.length === 1 && sameShape(pieces[0], original)) {
        shapesKept++;
        geometry[layer].push(shape);
        return;
      }
      shapesClipped++;
      if (pieces.length > 1) shapesSplit++;
      pieces.forEach((piece, k) => {
        const id = k === 0 ? shape.id : freshId(shape.id, ids);
        ids.add(id);
        geometry[layer].push({ ...shape, id, polygon: piece.map(toPoint) });
      });
    });
  }
  if (shapesKept + shapesClipped === 0) throw new ImportError('the section rectangle keeps no copper');

  // An edge-launch connector stays where its board edge has not moved and its position along the edge is kept.
  const [ox0, oy0, ox1, oy1] = box(oldOutline);
  const [nx0, ny0, nx1, ny1] = box(outline);
  const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
  const edgeKept: Record<SmaEdgePort['edge'], boolean> = { x_min: same(ox0, nx0), x_max: same(ox1, nx1), y_min: same(oy0, ny0), y_max: same(oy1, ny1) };
  const ports = doc.ports.filter((port: Port, n) => {
    let keep: boolean;
    if (port.kind === 'sma_edge') {
      const along = port.edge.startsWith('y') ? (port.x === undefined ? null : mm(port.x, `$.ports[${n}].x`)) : (port.y === undefined ? null : mm(port.y, `$.ports[${n}].y`));
      const [lo, hi] = port.edge.startsWith('y') ? [r.x0, r.x1] : [r.y0, r.y1];
      keep = edgeKept[port.edge] && along !== null && along >= lo && along <= hi;
    } else {
      keep = inside(mm(port.x, `$.ports[${n}].x`), mm(port.y, `$.ports[${n}].y`));
    }
    if (!keep) removed.push({ kind: 'port', id: port.id });
    return keep;
  });
  const portIds = new Set(ports.map((p) => p.id));
  if (doc.ports.length && !ports.length) notes.push('No port is left inside the section: add ports before solving.');

  const components = doc.components?.filter((c: LumpedComponent, n) => {
    const keep = 'layer' in c
      ? inside(...point(c.from, `$.components[${n}].from`)) && inside(...point(c.to, `$.components[${n}].to`))
      : inside(mm(c.x, `$.components[${n}].x`), mm(c.y, `$.components[${n}].y`));
    if (!keep) removed.push({ kind: 'component', id: c.id });
    return keep;
  });

  // The whole barrel must fit: a via cut by the section's edge would reach off the new board.
  const fencesTrimmed: string[] = [];
  const vias = doc.vias?.flatMap((v: Via, n): Via[] => {
    const radius = mm(v.drill, `$.vias[${n}].drill`) / 2;
    const fits = ([x, y]: Vec2) => inside(x - radius, y - radius) && inside(x + radius, y + radius);
    const start: Vec2 = [mm(v.x, `$.vias[${n}].x`), mm(v.y, `$.vias[${n}].y`)];
    if (!v.to) {
      if (fits(start)) return [v];
      removed.push({ kind: 'via', id: v.id });
      return [];
    }
    // A fence: its vias as resolve.ts places them, of which a rectangle keeps one unbroken run.
    const end = point(v.to, `$.vias[${n}].to`);
    const pitch = mm(v.pitch!, `$.vias[${n}].pitch`);
    const span = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const count = Math.floor(span / pitch + 1e-9) + 1;
    const at = (m: number): Vec2 => [start[0] + ((end[0] - start[0]) * m * pitch) / span, start[1] + ((end[1] - start[1]) * m * pitch) / span];
    const kept = Array.from({ length: count }, (_, m) => m).filter((m) => fits(at(m)));
    if (kept.length === count) return [v];
    if (kept.length === 0) {
      removed.push({ kind: 'via', id: v.id });
      return [];
    }
    fencesTrimmed.push(v.id);
    const first = at(kept[0]);
    const trimmed: Via = { ...v, x: toLength(first[0]), y: toLength(first[1]) };
    if (kept.length === 1) {
      delete trimmed.to;
      delete trimmed.pitch;
    } else {
      // The end goes half a pitch past the last via kept: resolve.ts counts floor(span / pitch) + 1 vias, and an
      // end on the last via itself, rounded to 1 nm, can fall a hair short of a whole pitch and lose that via.
      const reach = (kept.length - 1 + 0.5) * pitch;
      trimmed.to = toPoint([first[0] + ((end[0] - start[0]) * reach) / span, first[1] + ((end[1] - start[1]) * reach) / span]);
    }
    return [trimmed];
  });

  const pairs = doc.outputs.differential_pairs?.filter((pair) => {
    const keep = portIds.has(pair.positive) && portIds.has(pair.negative);
    if (!keep) removed.push({ kind: 'differential pair', id: pair.id });
    return keep;
  });

  const next: Project = {
    ...doc,
    board: { outline: outline.map(toPoint) },
    geometry,
    ports,
    analysis: { ...doc.analysis },
    outputs: { ...doc.outputs },
  };
  if (components) next.components = components;
  if (vias) next.vias = vias;
  if (doc.analysis.excite) {
    const excite = doc.analysis.excite.filter((id) => portIds.has(id));
    if (excite.length) next.analysis.excite = excite;
    else {
      // An absent excite means every port: say so rather than let the meaning change quietly.
      delete next.analysis.excite;
      if (ports.length) notes.push('None of the excited ports is inside the section, so every remaining port is now excited.');
    }
  }
  if (pairs) {
    if (pairs.length) next.outputs.differential_pairs = pairs;
    else delete next.outputs.differential_pairs;
  }
  return { doc: next, summary: { shapesKept, shapesClipped, shapesRemoved, shapesSplit, removed, fencesTrimmed, notes } };
}

/** The removed items as a phrase: a few named, many counted ("ports p2, n2; 160 vias"). */
export function describeRemoved(removed: Removed[]): string {
  const byKind = new Map<string, string[]>();
  for (const { kind, id } of removed) byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
  return [...byKind].map(([kind, ids]) => {
    const plural = ids.length === 1 ? kind : `${kind}s`;
    return ids.length <= 4 ? `${plural} ${ids.join(', ')}` : `${ids.length} ${plural}`;
  }).join('; ');
}
