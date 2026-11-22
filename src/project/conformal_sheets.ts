import { CONFORMAL_SOLID_COURANT, COVERAGE_SNAP } from '../engine/conformal';
import type { MeshLines } from '../engine/mesh';
import { rimBetaRange, rimGrowCells, rimTieScale, type SheetRimTable } from '../engine/sheet_rim';
import RIM_TABLE from '../engine/sheet_rim_table.json';
import { GHOST, packRows, type ThinSheetUpdate } from '../engine/thin_sheets';
import { materialSignature, sheetFaceLoss, type VoxelModel } from '../engine/voxelize';
import type { Segment } from './coverage';
import { joinMeshes, slice, trianglesByLine, weldMesh, type TriangleMesh } from './conformal_solids';
import type { Vec2 } from './resolve';

/**
 * Thin copper sheets of any shape: a zero-thickness PEC surface, open or
 * closed, given as a triangle mesh that need not lie on any mesh plane (the
 * arms of a helix wrapped on a cylinder, a bent flex strip).
 *
 * A sheet off the mesh planes crosses Yee edges at single points, so it
 * covers no length and no area: the coverage rule of conformal copper planes
 * and solids would not see it. What it does is separate: a face it crosses
 * holds two fields, one on each side, and an edge it crosses holds a voltage
 * on each side. This is the finite integration of the cut cell (Weiland's
 * partially filled cells; Yu and Mittra's thin-PEC conformal FDTD keeps one H
 * per side the same way):
 *
 *   - each face is split by the sheet's trace into regions; region R holds
 *     its own H with area fraction a_R, and its Faraday law sums the voltages
 *     of the edge pieces on its boundary (the sheet itself has no tangential
 *     E, so it adds nothing);
 *   - each crossed edge is split into pieces; piece p holds its own voltage
 *     with length fraction lambda_p, and its Ampere law reads, on each of its
 *     four faces, the region it borders.
 *
 * Both laws use the same incidence, so the update stays symmetric, which is
 * what the stability bound below needs. A face's own H slot holds its largest
 * region and an edge's own E slot its longest piece; the others live in ghost
 * arrays (thin_sheets.ts). A trace that ends inside a face (the edge of a
 * strip) splits nothing there: the field goes round the end.
 *
 * Rims. A free edge of the sheet that ends inside a face splits nothing
 * there, so on its own the update sees the sheet only up to the last edge it
 * crosses: whole cells, blind to where the rim lies inside the next one. In
 * the cross-section across a rim the update is a 5-point problem in which
 * each crossed edge ties its two ends to the sheet (its two pieces, 1/s and
 * 1/(1 - s) for a crossing at fraction s); src/engine/sheet_rim.ts solves it
 * and finds where its rim sits in the continuum. Scaling the ties of the last
 * crossed edge by beta moves that rim continuously (beta > 1 out, < 1 in):
 * the edge's pieces carry beta times their capacitance (curl coefficient /
 * beta) and the faces along the rim through that edge (the ones whose
 * regions tie its ends in the other polarisation) beta times less area. The
 * range of beta is the narrowest in log beta whose rims span one cell
 * (rimBetaRange: 0.25 to 4 for a sheet mid-cell, 0.045 to 22 at s = 0.01,
 * where ties of 1/s are stiff), and the sheet is first grown past its rims
 * (rimGrowthCells: 0.41 cell mid-cell, 0.17 at s = 0.01) so that wherever the
 * true rim falls in its cell it lies within that reach of the last crossed
 * edge; beta is then read off the table for each rim face from the true
 * rim's distance. It follows Railton's modified material parameters for
 * small structures (IEEE TAP 53(12), 2005) and the use of static edge
 * solutions in FDTD by Shorthouse and Railton (IEEE MTT 40(5), 1992); here
 * the static solution is that of the discrete problem, so the correction
 * moves the discrete rim rather than imposing a field shape. Both are
 * positive mass changes, so the
 * stability bound below covers them unchanged.
 *
 * Stability. The update is leapfrog on the symmetric operator B^T B. Faces
 * the sheet does not touch keep their uncut rows, so their part is at most
 * 12 |y|^2 over the uncrossed edges (the uncut Yee bound, docs/conformal.md).
 * Each region R gets a Cauchy-Schwarz bound with weights s = L - 12 on
 * uncrossed edges and s = L on pieces (L = 0.98 * 4 / Sc^2), which holds the
 * whole operator under L when every unknown q has sum over its regions of
 * G_R <= 1, G_R = sum over R's unknowns of b_Rq^2 / s_q, and
 * b_Rq^2 = hs * es * (eCurl_q / Sc) / a_R. So each region uses the effective
 * area a_eff = max(a_R, m * sum hs es (eCurl_q / Sc) / s_q), m the most
 * regions any of its unknowns borders. A small region bounded by short pieces
 * keeps its own small area; only a sliver along a whole uncut edge is raised.
 * With sub-cell rims ('snap' keeps the plain rule), each raised region is
 * then lowered again, one at a time, to the least area
 * that keeps every one of its unknowns' sums at or below 1 given the others:
 * the condition still holds after every step, and regions next to slivers or
 * rim ties keep much more of their own area.
 */
export interface SheetMeshOptions {
  /**
   * Tiny shift (mm) applied to every sheet so no vertex lies on a mesh plane
   * and no trace runs through a mesh node (general position). The default is
   * far below any feature; set it to [0, 0, 0] only for meshes known clear.
   */
  nudgeMm?: [number, number, number];
  /**
   * 'subcell' (default) places each free edge where it lies inside its cell
   * (module comment, "Rims"); 'snap' leaves it at the last edge the sheet
   * crosses, the update before sub-cell rims (for comparison).
   */
  rims?: 'subcell' | 'snap';
}

/** How far sheets are grown past their rims, in cells, for a sheet at fraction s across its cell (rimGrowCells). */
export const rimGrowthCells = (s: number) => rimGrowCells(RIM_TABLE as SheetRimTable, s);

const TOLERANCE_MM = 1e-9;
const DEFAULT_NUDGE: [number, number, number] = [1.37e-7, -2.11e-7, 1.73e-7];

/** Throws unless every triangle edge belongs to one or two triangles (an open or closed surface, no fins). */
export function assertSheetMesh(mesh: TriangleMesh): void {
  const { positions: p, triangles: t } = mesh;
  if (t.length === 0 || t.length % 3 !== 0) throw new Error('a sheet needs at least one triangle, three indices each');
  const nv = p.length / 3;
  const count = new Map<number, number>();
  for (let n = 0; n < t.length; n += 3) {
    const [a, b, c] = [t[n], t[n + 1], t[n + 2]];
    if (a >= nv || b >= nv || c >= nv) throw new Error(`triangle ${n / 3} names a vertex that does not exist`);
    if (a === b || b === c || a === c) throw new Error(`triangle ${n / 3} repeats a vertex`);
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = Math.min(u, v) * nv + Math.max(u, v);
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of count) if (n > 2) throw new Error(`sheet edge ${Math.floor(key / nv)}-${key % nv} belongs to ${n} triangles; sheets may not branch`);
}

/** The plane's (u, v) axes for mesh planes normal to `axis`. */
const planeAxes = (axis: number): [number, number] => (axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]);

/** Where a segment crosses the line `along`-axis coordinate (in plane coords, 0 = u, 1 = v) at `at`: the other coordinate, or null. */
function crossAt(s: Segment, coord: 0 | 1, at: number): number | null {
  const da = s.a[coord] - at;
  const db = s.b[coord] - at;
  if (da === 0 && db === 0) return null;
  if ((da > 0) === (db > 0) && da !== 0 && db !== 0) return null;
  if (da === 0 || db === 0) {
    // An end exactly on the line: count it once, by the half-open rule (the end above the line counts).
    const other = da === 0 ? db : da;
    if (other <= 0) return null;
  }
  const o = coord === 0 ? 1 : 0;
  return s.a[o] + ((s.b[o] - s.a[o]) * da) / (da - db);
}

/** Liang-Barsky clip of a segment to [u0,u1] x [v0,v1]; null when it misses. */
function clip(s: Segment, u0: number, u1: number, v0: number, v1: number): Segment | null {
  const [ax, ay] = s.a;
  const dx = s.b[0] - ax;
  const dy = s.b[1] - ay;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, ax - u0], [dx, u1 - ax], [-dy, ay - v0], [dy, v1 - ay]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  if (t1 - t0 <= 0) return null;
  const at = (t: number): Vec2 => (t === 0 ? s.a : t === 1 ? s.b : [ax + t * dx, ay + t * dy]);
  return { a: at(t0), b: at(t1) };
}

const shoelace = (p: Vec2[]) => {
  let s = 0;
  for (let n = 0; n < p.length; n++) {
    const [a, b] = [p[n], p[(n + 1) % p.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};

function insidePolygon(p: Vec2[], x: number, y: number): boolean {
  let odd = false;
  for (let n = 0, prev = p.length - 1; n < p.length; prev = n++) {
    const [a, b] = [p[prev], p[n]];
    if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) odd = !odd;
  }
  return odd;
}

function distanceToSegment([x, y]: Vec2, a: Vec2, b: Vec2): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

/** Index n of the polygon edge (p[n], p[n+1]) that `q` lies on, or -1. */
function edgeOf(p: Vec2[], q: Vec2, tol: number): number {
  let best = -1;
  let bestD = tol;
  for (let n = 0; n < p.length; n++) {
    const d = distanceToSegment(q, p[n], p[(n + 1) % p.length]);
    if (d <= bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/**
 * The regions a face [u0,u1] x [v0,v1] is split into by `segments` (the
 * sheet traces in its plane): polygons, one per region. Traces are linked
 * into chains; a chain from boundary to boundary splits the region holding
 * it, a chain ending inside the face splits nothing.
 */
export function faceRegions(segments: Segment[], u0: number, u1: number, v0: number, v1: number): Vec2[][] {
  const clipped: Segment[] = [];
  for (const s of segments) {
    const c = clip(s, u0, u1, v0, v1);
    if (c) clipped.push(c);
  }
  const tol = TOLERANCE_MM * Math.max(1, u1 - u0, v1 - v0) * 10;
  const onBoundary = ([x, y]: Vec2) => Math.min(Math.abs(x - u0), Math.abs(x - u1), Math.abs(y - v0), Math.abs(y - v1)) <= tol;
  // Link clipped pieces at shared ends (bitwise equal: slice() interpolates each mesh edge one way).
  const key = (p: Vec2) => `${p[0]},${p[1]}`;
  const ends = new Map<string, number[]>();
  clipped.forEach((s, n) => {
    for (const p of [s.a, s.b]) {
      const k = key(p);
      const list = ends.get(k);
      if (list) list.push(n);
      else ends.set(k, [n]);
    }
  });
  for (const [k, list] of ends) if (list.length > 2) throw new Error(`sheet traces branch at (${k}); sheets may not meet or cross`);
  const used = new Uint8Array(clipped.length);
  const chains: Vec2[][] = [];
  const walk = (from: number, start: Vec2): Vec2[] => {
    const chain: Vec2[] = [start];
    let seg = from;
    let at = start;
    while (seg >= 0 && !used[seg]) {
      used[seg] = 1;
      const s = clipped[seg];
      const next = key(s.a) === key(at) ? s.b : s.a;
      chain.push(next);
      at = next;
      seg = (ends.get(key(next)) ?? []).find((m) => !used[m]) ?? -1;
    }
    return chain;
  };
  // Open chains start at an end used once; closed loops would have none and split nothing (a sheet smaller than a face).
  for (const [k, list] of ends) {
    if (list.length !== 1 || used[list[0]]) continue;
    const s = clipped[list[0]];
    chains.push(walk(list[0], key(s.a) === k ? s.a : s.b));
  }
  let regions: Vec2[][] = [[[u0, v0], [u1, v0], [u1, v1], [u0, v1]]];
  for (const chain of chains) {
    const [a, b] = [chain[0], chain[chain.length - 1]];
    if (!onBoundary(a) || !onBoundary(b) || key(a) === key(b)) continue;
    // The region holding the chain: test a point on its first piece (inside the face, off every other trace).
    const probe: Vec2 = [(chain[0][0] + chain[1][0]) / 2, (chain[0][1] + chain[1][1]) / 2];
    const holder = regions.findIndex((r) => insidePolygon(r, probe[0], probe[1]));
    if (holder < 0) throw new Error('a sheet trace lies on a face boundary; move the sheet off the mesh lines');
    let poly = regions[holder].slice();
    for (const p of [a, b]) {
      const n = edgeOf(poly, p, tol);
      if (n < 0) throw new Error('sheet traces cross inside a face; sheets may not meet or cross');
      poly.splice(n + 1, 0, p);
    }
    const ia = poly.findIndex((p) => key(p) === key(a));
    const ib = poly.findIndex((p) => key(p) === key(b));
    const forward = (i: number, j: number) => {
      const out: Vec2[] = [];
      for (let n = i; ; n = (n + 1) % poly.length) {
        out.push(poly[n]);
        if (n === j) break;
      }
      return out;
    };
    const inner = chain.slice(1, -1);
    const one = [...forward(ia, ib), ...inner.slice().reverse()];
    const two = [...forward(ib, ia), ...inner];
    poly = [];
    regions = [...regions.slice(0, holder), one, two, ...regions.slice(holder + 1)];
  }
  return regions;
}

/** E-buffer index of each of the four edges of face f, with the incidence sign of the H update (fdtd_cpu.ts updateH). */
interface Incidence {
  edges: [number, number, number, number];
  sign: [number, number, number, number];
  /** H-side scale per edge (hDiffScale at the face) and E-side scale per edge (eDiffScale at the edge). */
  hs: [number, number, number, number];
  es: [number, number, number, number];
}

function incidence(model: VoxelModel, f: number): Incidence {
  const { nx, ny, nz } = model.grid;
  const N = nx * ny * nz;
  const { x: X, y: Y, z: Z } = model.cpml;
  const comp = Math.floor(f / N);
  const c = f % N;
  const [i, j, k] = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
  // h -= Sc * row: Hx row = ky (ez(j+1) - ez) - kz (ey(k+1) - ey); Hy = kz (ex(k+1) - ex) - kx (ez(i+1) - ez); Hz = kx (ey(i+1) - ey) - ky (ex(j+1) - ex).
  if (comp === 0) return { edges: [2 * N + c + nx, 2 * N + c, N + c + nx * ny, N + c], sign: [1, -1, -1, 1], hs: [Y.hDiffScale[j], Y.hDiffScale[j], Z.hDiffScale[k], Z.hDiffScale[k]], es: [Y.eDiffScale[j + 1], Y.eDiffScale[j], Z.eDiffScale[k + 1], Z.eDiffScale[k]] };
  if (comp === 1) return { edges: [c + nx * ny, c, 2 * N + c + 1, 2 * N + c], sign: [1, -1, -1, 1], hs: [Z.hDiffScale[k], Z.hDiffScale[k], X.hDiffScale[i], X.hDiffScale[i]], es: [Z.eDiffScale[k + 1], Z.eDiffScale[k], X.eDiffScale[i + 1], X.eDiffScale[i]] };
  return { edges: [N + c + 1, N + c, c + nx, c], sign: [1, -1, -1, 1], hs: [X.hDiffScale[i], X.hDiffScale[i], Y.hDiffScale[j], Y.hDiffScale[j]], es: [X.eDiffScale[i + 1], X.eDiffScale[i], Y.eDiffScale[j + 1], Y.eDiffScale[j]] };
}

/** One E unknown: an edge's own slot (index < 3N) or a ghost (GHOST + n), and its length fraction. */
interface Piece { unknown: number; lambda: number; lo: number; hi: number }
/** One H unknown: a face's own slot or a ghost, its area fraction, and the E unknowns on its boundary with their incidence. */
interface Region { unknown: number; area: number; terms: Array<{ unknown: number; sign: number; hs: number; es: number; edge: number }> }

/**
 * Adds thin PEC sheets (triangle meshes, mm, model coordinates) to a built
 * model. The model must have no PML, port, lumped component, conformal copper
 * or frequency-dependent material where the sheets cross it, and its
 * crossed edges must be lossless (eDecay 1); each of these throws.
 */
export function addConformalSheets(model: VoxelModel, sheets: readonly TriangleMesh[], options: SheetMeshOptions = {}): VoxelModel {
  if (model.thinSheets) throw new Error('the model already has thin sheets; pass every sheet in one call');
  if (model.dispersion?.e || model.dispersion?.h) throw new Error('thin sheets do not support frequency-dependent or magnetic materials yet, and a lossy dielectric is frequency-dependent by default; give it dispersion { "model": "conductivity" }');
  const nudge = options.nudgeMm ?? DEFAULT_NUDGE;
  const subcellRims = (options.rims ?? 'subcell') === 'subcell';
  const placed = sheets.map((s) => {
    const welded = weldMesh(s);
    assertSheetMesh(welded);
    const positions = Float64Array.from(welded.positions, (v, n) => v + nudge[n % 3]);
    return { positions, triangles: welded.triangles };
  });

  const { grid, eCurl, eDecay } = model;
  const { nx, ny, nz, courant: Sc } = grid;
  if (Sc > CONFORMAL_SOLID_COURANT + 1e-12) {
    throw new Error(`thin sheets need a Courant number of ${CONFORMAL_SOLID_COURANT.toFixed(4)} or less, as conformal solids (docs/conformal.md); the model runs at ${Sc}`);
  }
  const N = nx * ny * nz;
  const lines: MeshLines = model.mesh;
  const axisLines = [lines.x, lines.y, lines.z];
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  // The sheets the grid sees: grown past their rims for the sub-cell correction (module comment).
  const moved = subcellRims ? growRims(placed, axisLines, rimGrowthCells) : placed;

  // Plane traces: segments of every sheet in every mesh plane.
  const tracesOf = (meshes: TriangleMesh[]) => {
    const byLine = [0, 1, 2].map((axis) => meshes.map((s) => trianglesByLine(s, axisLines[axis], axis)));
    return (axis: 0 | 1 | 2, n: number): Segment[] =>
      meshes.flatMap((s, m) => (byLine[axis][m][n].length ? slice(s, byLine[axis][m][n], axis, axisLines[axis][n], -1) : []));
  };
  const traces = tracesOf(moved);
  // Free ends of the true (ungrown) sheets' traces, per plane: where the rims really are.
  const trueTraces = tracesOf(placed);
  const trueEndsCache = new Map<number, Vec2[]>();
  const trueEnds = (axis: 0 | 1 | 2, n: number): Vec2[] => {
    const key = axis * 1e7 + n;
    let list = trueEndsCache.get(key);
    if (!list) {
      const count = new Map<string, { p: Vec2; n: number }>();
      for (const s of trueTraces(axis, n)) for (const p of [s.a, s.b]) {
        const k = `${p[0]},${p[1]}`;
        const c = count.get(k);
        if (c) c.n++;
        else count.set(k, { p, n: 1 });
      }
      list = [...count.values()].filter((c) => c.n === 1).map((c) => c.p);
      trueEndsCache.set(key, list);
    }
    return list;
  };

  // Crossings of every edge, along its own axis (mm): Ey, Ez read in x planes, Ex in y planes.
  const crossings = new Map<number, number[]>();
  const record = (edge: number, value: number) => {
    const list = crossings.get(edge);
    if (list) list.push(value);
    else crossings.set(edge, [value]);
  };
  for (const axis of [0, 1] as const) {
    for (let n = 0; n < axisLines[axis].length; n++) {
      const segs = traces(axis, n);
      if (segs.length === 0) continue;
      const [uAxis, vAxis] = planeAxes(axis);
      const [uLines, vLines] = [axisLines[uAxis], axisLines[vAxis]];
      // Edges along u (at v = vLines[q]) and, in x planes, along v (at u = uLines[p]).
      for (const s of segs) {
        for (let q = 0; q < vLines.length; q++) {
          const u = crossAt(s, 1, vLines[q]);
          if (u === null || u <= uLines[0] || u >= uLines[uLines.length - 1]) continue;
          const p = cellIndex(uLines, u);
          // u edge: x planes -> Ey (i = n, j = p, k = q); y planes -> Ex (i = p, j = n, k = q).
          record(axis === 0 ? N + at(n, p, q) : at(p, n, q), u);
        }
        if (axis !== 0) continue;
        for (let p = 0; p < uLines.length; p++) {
          const v = crossAt(s, 0, uLines[p]);
          if (v === null || v <= vLines[0] || v >= vLines[vLines.length - 1]) continue;
          record(2 * N + at(n, p, cellIndex(vLines, v)), v);
        }
      }
    }
  }
  const edgeStart = (e: number) => {
    const comp = Math.floor(e / N);
    const c = e % N;
    const ijk = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    return [axisLines[comp][ijk[comp]], axisLines[comp][ijk[comp] + 1]];
  };

  // Pieces of every crossed edge. A PEC edge stays PEC; its pieces carry nothing.
  let ghostE = 0;
  const pieces = new Map<number, Piece[]>();
  const partial = new Set(model.conformal?.partialEdges ?? []);
  const reserved = new Set<number>();
  for (const port of model.ports) for (const e of port.ezIndex) reserved.add(e);
  for (const e of model.lumped?.eIndex ?? []) reserved.add(e);
  for (const [e, list] of crossings) {
    if (reserved.has(e)) throw new Error(`a thin sheet crosses a port or lumped component edge (${e})`);
    if (partial.has(e)) throw new Error(`a thin sheet crosses a partly covered conformal edge (${e})`);
    const [lo, hi] = edgeStart(e);
    const cuts = list.sort((p, q) => p - q);
    const bounds = [lo, ...cuts, hi];
    const ps: Piece[] = [];
    for (let n = 0; n + 1 < bounds.length; n++) ps.push({ unknown: -1, lambda: (bounds[n + 1] - bounds[n]) / (hi - lo), lo: bounds[n], hi: bounds[n + 1] });
    if (eCurl[e] !== 0) {
      if (eDecay[e] !== 1) throw new Error(`a thin sheet crosses a lossy edge (${e}); thin sheets need lossless media`);
      const own = ps.reduce((best, p, n) => (p.lambda > ps[best].lambda ? n : best), 0);
      // A piece a hair long (the sheet on a node, within the nudge) is shorted by it, as covered edges are.
      ps.forEach((p, n) => { p.unknown = n === own ? e : p.lambda <= COVERAGE_SNAP ? -1 : GHOST + ghostE++; });
    }
    pieces.set(e, ps);
  }

  // Faces: regions of every face a trace reaches, in all three plane orientations.
  // Rim faces: a trace enters across a crossed edge and ends inside; t is where the true rim lies past that edge, in cells along the trace.
  const rimFaces: Array<{ edge: number; axis: number; t: number }> = [];
  let ghostH = 0;
  const regionsOf = new Map<number, Region[]>();
  const baseCurl = (e: number) => eCurl[e];
  const pml = [model.cpml.x, model.cpml.y, model.cpml.z];
  const inPml = (ijk: number[]) => ijk.some((v, a) => (pml[a].low > 0 && v <= pml[a].low) || (pml[a].high > 0 && v >= [nx, ny, nz][a] - 1 - pml[a].high));
  for (const axis of [0, 1, 2] as const) {
    const [uAxis, vAxis] = planeAxes(axis);
    const [uLines, vLines] = [axisLines[uAxis], axisLines[vAxis]];
    for (let n = 0; n < axisLines[axis].length; n++) {
      const segs = traces(axis, n);
      if (segs.length === 0) continue;
      // Segments per face they reach.
      const near = new Map<number, Segment[]>();
      for (const s of segs) {
        const [p0, p1] = [cellIndex(uLines, Math.min(s.a[0], s.b[0])), cellIndex(uLines, Math.max(s.a[0], s.b[0]))];
        const [q0, q1] = [cellIndex(vLines, Math.min(s.a[1], s.b[1])), cellIndex(vLines, Math.max(s.a[1], s.b[1]))];
        for (let q = q0; q <= q1; q++) for (let p = p0; p <= p1; p++) {
          const col = p + uLines.length * q;
          const list = near.get(col);
          if (list) list.push(s);
          else near.set(col, [s]);
        }
      }
      for (const [col, list] of near) {
        const p = col % uLines.length;
        const q = (col - p) / uLines.length;
        if (p + 1 >= uLines.length || q + 1 >= vLines.length) continue;
        const ijk = axis === 0 ? [n, p, q] : axis === 1 ? [p, n, q] : [p, q, n];
        const f = axis * N + at(ijk[0], ijk[1], ijk[2]);
        const inc = incidence(model, f);
        const crossed = inc.edges.some((e) => pieces.has(e));
        const polys = faceRegions(list, uLines[p], uLines[p + 1], vLines[q], vLines[q + 1]);
        if (!crossed && polys.length === 1) continue;
        if (inPml(ijk)) throw new Error(`a thin sheet reaches the PML (face H${'xyz'[axis]} at cell ${f % N}); add air between it and the boundary`);
        if (ijk.some((v, a) => a !== axis && v + 1 >= [nx, ny, nz][a])) throw new Error('a thin sheet reaches the far side of the mesh');
        const faceArea = (uLines[p + 1] - uLines[p]) * (vLines[q + 1] - vLines[q]);
        const areas = polys.map((poly) => Math.abs(shoelace(poly)) / faceArea);
        const own = areas.reduce((best, a, m) => (a > areas[best] ? m : best), 0);
        const regions: Region[] = polys.map((_, m) => ({ unknown: m === own ? f : GHOST + ghostH++, area: areas[m], terms: [] }));
        // Each edge (or piece) of the face joins the region whose boundary holds its midpoint.
        // Far below the nudge, far above rounding: a trace 1e-7 mm from an edge leaves that edge on the sliver's side only.
        const tol = TOLERANCE_MM * Math.max(1, uLines[p + 1] - uLines[p], vLines[q + 1] - vLines[q]);
        inc.edges.forEach((e, slot) => {
          const comp = Math.floor(e / N);
          // Slots 0 and 2 are the far edge of each pair (incidence), 1 and 3 the near one.
          const far = slot % 2 === 0 ? 1 : 0;
          const fixedU = comp === uAxis ? null : uLines[p + far];
          const fixedV = comp === vAxis ? null : vLines[q + far];
          const ps = pieces.get(e) ?? [{ unknown: eCurl[e] === 0 ? -1 : e, lambda: 1, lo: edgeStart(e)[0], hi: edgeStart(e)[1] }];
          for (const piece of ps) {
            if (piece.unknown === -1) continue;
            const mid = (piece.lo + piece.hi) / 2;
            const point: Vec2 = fixedU === null ? [mid, fixedV!] : [fixedU, mid];
            const owners = polys.map((poly, m) => (edgeOf(poly, point, tol) >= 0 ? m : -1)).filter((m) => m >= 0);
            if (owners.length !== 1) throw new Error(`a thin sheet meets face ${f} where its trace and edge crossings disagree (${owners.length} regions); refine the mesh or move the sheet`);
            regions[owners[0]].terms.push({ unknown: piece.unknown, sign: inc.sign[slot], hs: inc.hs[slot], es: inc.es[slot], edge: e });
          }
        });
        regionsOf.set(f, regions);
        if (subcellRims && polys.length === 1) {
          const [u0, u1, v0, v1] = [uLines[p], uLines[p + 1], vLines[q], vLines[q + 1]];
          for (const [P, Q] of danglingChains(list, u0, u1, v0, v1)) {
            const t = trueRimFraction(P, Q, u0, u1, v0, v1, trueEnds(axis, n));
            if (t === null) continue;
            const tol = 1e-6 * Math.max(u1 - u0, v1 - v0);
            inc.edges.forEach((e, slot) => {
              const comp = Math.floor(e / N);
              const far = slot % 2 === 0 ? 1 : 0;
              const onEdge = comp === uAxis ? Math.abs(P[1] - vLines[q + far]) < tol : Math.abs(P[0] - uLines[p + far]) < tol;
              if (onEdge && pieces.has(e)) rimFaces.push({ edge: e, axis, t });
            });
          }
        }
      }
    }
  }
  if (regionsOf.size === 0 && pieces.size === 0) return model;

  // A region a hair wide runs along an edge (or piece) the sheet lies on (a sheet on a mesh plane, within the
  // nudge): that edge is under the copper, so it is PEC, as on a copper plane, and the sliver's H drops out.
  const shortedPieces = new Set<number>();
  for (const regions of regionsOf.values()) for (const r of regions) if (r.area <= COVERAGE_SNAP) for (const t of r.terms) shortedPieces.add(t.unknown);
  const shorted = new Set<number>();
  for (const unknown of shortedPieces) {
    if (unknown < GHOST && !pieces.has(unknown)) shorted.add(unknown);
  }
  for (const [e, ps] of pieces) {
    for (const p of ps) if (shortedPieces.has(p.unknown)) p.unknown = -1;
    if (eCurl[e] === 0) continue;
    if (ps.every((p) => p.unknown === -1)) shorted.add(e);
    else if (!ps.some((p) => p.unknown === e)) throw new Error(`a thin sheet runs along part of edge ${e} and crosses the rest; move the sheet off the mesh line`);
  }
  for (const e of shorted) if (reserved.has(e)) throw new Error(`a thin sheet lies on a port or lumped component edge (${e})`);
  for (const regions of regionsOf.values()) for (const r of regions) r.terms = r.terms.filter((t) => !shorted.has(t.edge) && !shortedPieces.has(t.unknown));
  // The bound takes the faces a sheet leaves alone as uncut (12 |y|^2); conformal faces are not, so they may share no edge.
  const conformalEdges = new Set(model.conformal?.eIndex ?? []);
  const conformalFaces = new Set(model.conformal?.hIndex ?? []);
  for (const [f, regions] of regionsOf) {
    if (conformalFaces.has(f)) throw new Error(`a thin sheet crosses a conformal copper face (${f})`);
    for (const r of regions) for (const t of r.terms) if (conformalEdges.has(t.edge)) throw new Error(`a thin sheet comes within a cell of conformal copper (edge ${t.edge}); keep them a cell apart`);
  }
  // Face loss, ports and lumped components act on own slots only; next to a sheet they would miss the ghosts.
  const lossyFaces = new Set(sheetFaceLoss(model).hIndex);
  for (const [f, regions] of regionsOf) {
    if (lossyFaces.has(f)) throw new Error(`a thin sheet cuts a face of lossy copper (${f}); thin sheets need PEC copper around them`);
    for (const r of regions) for (const t of r.terms) if (reserved.has(t.edge)) throw new Error(`a thin sheet comes within a cell of a port or lumped component (edge ${t.edge}); keep them a cell apart`);
  }
  // Every face of a crossed edge must hold regions, or the edge's pieces and the faces' H would not see each other.
  for (const [e, ps] of pieces) {
    if (ps.every((p) => p.unknown === -1)) continue;
    const comp = Math.floor(e / N);
    const c = e % N;
    const ijk = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    for (const normal of [0, 1, 2]) {
      if (normal === comp) continue;
      const side = 3 - normal - comp;
      for (const back of [0, 1]) {
        const cell = ijk.slice();
        cell[side] -= back;
        if (cell[side] < 0 || cell[side] + 1 >= [nx, ny, nz][side]) continue;
        const f = normal * N + at(cell[0], cell[1], cell[2]);
        if (!regionsOf.has(f)) throw new Error(`a thin sheet crosses edge ${e} but its trace misses face ${f} (a grazing sheet); move the sheet slightly`);
      }
    }
  }

  // Every check is done: from here on the model changes.
  for (const e of shorted) eCurl[e] = 0;

  // Scale the own slot of every crossed edge by its piece; remember the uncut coefficient for the ghosts.
  const base = new Map<number, number>();
  for (const [e, ps] of pieces) {
    base.set(e, eCurl[e]);
    const own = ps.find((p) => p.unknown === e);
    if (own) eCurl[e] *= own.lambda;
  }
  // Rim ties (module comment): beta per rim face from the true rim; an edge takes the geometric mean over its rim faces,
  // a face along the rim the mean over the rim edges it holds.
  const edgeBeta = new Map<number, number>();
  const faceLogs = new Map<number, number[]>();
  const edgeLogs = new Map<number, number[]>();
  const push = (m: Map<number, number[]>, k: number, v: number) => (m.get(k) ?? m.set(k, []).get(k)!).push(v);
  let clampedRims = 0;
  for (const { edge: e, axis, t } of rimFaces) {
    const ps = pieces.get(e)!;
    // One crossing, both pieces live: the case the half-plane table describes.
    if (ps.length !== 2 || ps.some((p) => p.unknown === -1)) continue;
    const [betaLo, betaHi] = rimBetaRange(RIM_TABLE as SheetRimTable, ps[0].lambda);
    const wanted = rimTieScale(RIM_TABLE as SheetRimTable, ps[0].lambda, t);
    const beta = Math.min(betaHi, Math.max(betaLo, wanted));
    if (Math.abs(Math.log(wanted / beta)) > 1e-6) clampedRims++;
    const logBeta = Math.log(beta);
    push(edgeLogs, e, logBeta);
    const comp = Math.floor(e / N);
    const normal = 3 - axis - comp;
    const c = e % N;
    const ijk = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    for (const back of [0, 1]) {
      const cell = ijk.slice();
      cell[axis] -= back;
      if (cell[axis] < 0) continue;
      const f = normal * N + at(cell[0], cell[1], cell[2]);
      if (regionsOf.get(f)?.length === 2) push(faceLogs, f, logBeta);
    }
  }
  const geometricMean = (logs: number[]) => Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length);
  for (const [f, logs] of faceLogs) for (const r of regionsOf.get(f)!) r.area /= geometricMean(logs);
  for (const [e, logs] of edgeLogs) {
    const beta = geometricMean(logs);
    edgeBeta.set(e, beta);
    eCurl[e] /= beta;
  }
  const lambdaOf = new Map<number, number>();
  for (const [e, ps] of pieces) for (const p of ps) if (p.unknown >= 0) lambdaOf.set(p.unknown, p.lambda / (edgeBeta.get(e) ?? 1));
  const curlOf = (unknown: number, edge: number) => (base.get(edge) ?? baseCurl(edge)) * (lambdaOf.get(unknown) ?? 1);

  // Stability: regions each unknown borders, then effective areas (module comment).
  const L = (0.98 * 4) / (Sc * Sc);
  const borders = new Map<number, number>();
  for (const regions of regionsOf.values()) for (const r of regions) for (const t of r.terms) borders.set(t.unknown, (borders.get(t.unknown) ?? 0) + 1);
  const aEff = new Map<Region, number>();
  const loadOf = new Map<Region, number>();
  for (const regions of regionsOf.values()) {
    for (const r of regions) {
      let load = 0;
      let m = 1;
      for (const t of r.terms) {
        const isPiece = pieces.has(t.edge);
        const s = isPiece ? L : L - 12;
        load += (t.hs * t.es * (curlOf(t.unknown, t.edge) / Sc)) / s;
        m = Math.max(m, borders.get(t.unknown)!);
      }
      aEff.set(r, Math.max(r.area, m * load, COVERAGE_SNAP));
      loadOf.set(r, load);
    }
  }
  // Lower each raised region to the least area that keeps its unknowns' sums <= 1, the others as they stand.
  const sums = new Map<number, number>();
  for (const [r, a] of aEff) for (const t of r.terms) sums.set(t.unknown, (sums.get(t.unknown) ?? 0) + loadOf.get(r)! / a);
  for (const [r, a] of subcellRims ? aEff : []) {
    const floor = Math.max(r.area, COVERAGE_SNAP);
    if (a <= floor) continue;
    const load = loadOf.get(r)!;
    let slack = Infinity;
    for (const t of r.terms) slack = Math.min(slack, 1 - sums.get(t.unknown)! + load / a);
    const lowered = Math.max(floor, load / slack);
    if (!(lowered < a)) continue;
    for (const t of r.terms) sums.set(t.unknown, sums.get(t.unknown)! + load / lowered - load / a);
    aEff.set(r, lowered);
  }

  // H rows: each region's own Faraday law over its effective area; an own slot first undoes the main kernel's row.
  const hRows: Array<{ target: number; terms: Map<number, number> }> = [];
  const add = (terms: Map<number, number>, k: number, v: number) => terms.set(k, (terms.get(k) ?? 0) + v);
  for (const [f, regions] of regionsOf) {
    for (const r of regions) {
      const terms = new Map<number, number>();
      const w = Sc / aEff.get(r)!;
      for (const t of r.terms) add(terms, t.unknown, -w * t.sign * t.hs);
      if (r.unknown === f) {
        const inc = incidence(model, f);
        inc.edges.forEach((e, slot) => { if (eCurl[e] !== 0) add(terms, e, Sc * inc.sign[slot] * inc.hs[slot]); });
      }
      hRows.push({ target: r.unknown, terms });
    }
  }

  // E rows: each E unknown next to a region reads, on each of its faces, the region it borders.
  // e += curl * sum over faces of sign * es * h(region); an own slot first undoes the main kernel's own-H terms.
  const eTerms = new Map<number, Map<number, number>>();
  const edgeOfUnknown = new Map<number, number>();
  for (const [f, regions] of regionsOf) {
    for (const r of regions) {
      for (const t of r.terms) {
        edgeOfUnknown.set(t.unknown, t.edge);
        const terms = eTerms.get(t.unknown) ?? eTerms.set(t.unknown, new Map()).get(t.unknown)!;
        const c = curlOf(t.unknown, t.edge);
        add(terms, r.unknown, c * t.sign * t.es);
        if (t.unknown === t.edge) add(terms, f, -c * t.sign * t.es);
      }
    }
  }
  const eRows = [...eTerms].map(([target, terms]) => ({ target, terms: new Map([...terms].filter(([, v]) => v !== 0)) })).filter((r) => r.terms.size > 0);

  const update: ThinSheetUpdate = {
    ghostE,
    ghostH,
    h: packRows(hRows),
    e: packRows(eRows),
    crossedEdges: Uint32Array.from([...pieces.keys()].filter((e) => eCurl[e] !== 0)).sort(),
    clampedRims,
  };
  model.thinSheets = update;
  model.signature = materialSignature(eDecay, eCurl, model);
  return model;
}

/**
 * The sheet grown past its free edges, within its own surface: every
 * boundary vertex moves along the outward in-surface normal of its boundary
 * edges by cells(s) of the local cell size along that direction (mitred, at
 * most twice that at sharp corners), s being where the vertex sits across
 * its cell along the axis nearest the sheet's normal. Closed sheets come
 * back unchanged. Throws where grown rims would meet (a narrow hole, slot or
 * notch, or two sheets close side by side) or a rim is degenerate.
 */
function growRims(sheets: TriangleMesh[], axisLines: Float64Array[], cells: (s: number) => number): TriangleMesh[] {
  // All sheets at once (vertex sets stay disjoint), so grown rims of different sheets are checked against each other too.
  const { positions: p, triangles: t } = joinMeshes(sheets);
  const nv = p.length / 3;
  const uses = new Map<number, { a: number; b: number; c: number; n: number }>();
  for (let n = 0; n < t.length; n += 3) {
    const tri = [t[n], t[n + 1], t[n + 2]];
    for (let m = 0; m < 3; m++) {
      const [a, b, c] = [tri[m], tri[(m + 1) % 3], tri[(m + 2) % 3]];
      const key = Math.min(a, b) * nv + Math.max(a, b);
      const use = uses.get(key);
      if (use) use.n++;
      else uses.set(key, { a, b, c, n: 1 });
    }
  }
  const v = (i: number): number[] => [p[3 * i], p[3 * i + 1], p[3 * i + 2]];
  const sub = (x: number[], y: number[]) => x.map((q, i) => q - y[i]);
  const cross = (x: number[], y: number[]) => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  const dot = (x: number[], y: number[]) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const degenerate = (): never => {
    throw new Error("a thin sheet has a degenerate rim (a zero-area triangle on its boundary, or two parts touching at one vertex), so its rims cannot be grown; fix the mesh or use rims: 'snap'");
  };
  const unit = (x: number[]) => {
    const l = Math.hypot(x[0], x[1], x[2]);
    if (!(l > 0)) degenerate();
    return x.map((q) => q / l);
  };
  const outward = new Map<number, number[][]>();
  const normalOf = new Map<number, number[]>();
  const rims: Array<{ a: number; b: number; out: number[] }> = [];
  for (const { a, b, c, n } of uses.values()) {
    if (n !== 1) continue;
    const edge = sub(v(b), v(a));
    const normal = cross(edge, sub(v(c), v(a)));
    let out = unit(cross(edge, normal));
    if (dot(out, sub(v(c), v(a))) > 0) out = out.map((q) => -q);
    rims.push({ a, b, out });
    for (const i of [a, b]) {
      (outward.get(i) ?? outward.set(i, []).get(i)!).push(out);
      normalOf.set(i, normal);
    }
  }
  if (outward.size === 0) return sheets;
  const moves = new Map<number, { dir: number[]; step: number }>();
  for (const [i, outs] of outward) {
    if (outs.length !== 2) degenerate();
    const dir = unit(outs.reduce((s, o) => s.map((q, k) => q + o[k]), [0, 0, 0]));
    const mitre = 1 / Math.max(0.5, Math.min(...outs.map((o) => dot(o, dir))));
    const dominant = (x: number[]) => [0, 1, 2].reduce((best, k) => (Math.abs(x[k]) > Math.abs(x[best]) ? k : best), 0);
    const across = dominant(normalOf.get(i)!);
    const acrossLines = axisLines[across];
    const at = cellIndex(acrossLines, p[3 * i + across]);
    const s = Math.min(1 - 1e-6, Math.max(1e-6, (p[3 * i + across] - acrossLines[at]) / (acrossLines[at + 1] - acrossLines[at])));
    const axis = dominant(dir);
    const lines = axisLines[axis];
    const cell = cellIndex(lines, p[3 * i + axis]);
    moves.set(i, { dir, step: cells(s) * (lines[cell + 1] - lines[cell]) * mitre });
  }
  // A hole, slot or notch narrower than the two rims' growth would close or fold over itself: refuse it.
  for (const [i, { dir, step }] of moves) {
    for (const { a, b, out } of rims) {
      if (a === i || b === i || dot(out, dir) > -0.5) continue;
      const ab = sub(v(b), v(a));
      const along = Math.max(0, Math.min(1, dot(sub(v(i), v(a)), ab) / dot(ab, ab)));
      const w = sub(ab.map((q, k) => v(a)[k] + along * q), v(i));
      const gap = Math.hypot(w[0], w[1], w[2]);
      // How fast the vertex and that rim close in on each other along the line between them.
      const otherStep = (1 - along) * moves.get(a)!.step + along * moves.get(b)!.step;
      const closing = (step * dot(w, dir) - otherStep * dot(w, out)) / gap;
      if (dot(w, dir) > 0.5 * gap && gap <= closing) {
        throw new Error(`thin sheets leave a hole, slot, notch or gap ${gap.toFixed(4)} mm across near (${v(i).map((q) => q.toFixed(3)).join(', ')}), narrower than its grown rims need; refine the mesh or use rims: 'snap'`);
      }
    }
  }
  const positions = Float64Array.from(p);
  for (const [i, { dir, step }] of moves) for (let k = 0; k < 3; k++) positions[3 * i + k] += step * dir[k];
  let at = 0;
  return sheets.map((sheet) => {
    const grown = { positions: positions.slice(at, at + sheet.positions.length), triangles: sheet.triangles };
    at += sheet.positions.length;
    return grown;
  });
}

/** Chains of traces in a face that enter across its boundary and end inside it: [entry, end]. */
function danglingChains(segments: Segment[], u0: number, u1: number, v0: number, v1: number): Array<[Vec2, Vec2]> {
  const clipped: Segment[] = [];
  for (const s of segments) {
    const c = clip(s, u0, u1, v0, v1);
    if (c) clipped.push(c);
  }
  const tol = TOLERANCE_MM * Math.max(1, u1 - u0, v1 - v0) * 10;
  const onBoundary = ([x, y]: Vec2) => Math.min(Math.abs(x - u0), Math.abs(x - u1), Math.abs(y - v0), Math.abs(y - v1)) <= tol;
  const key = (p: Vec2) => `${p[0]},${p[1]}`;
  const ends = new Map<string, number[]>();
  clipped.forEach((s, n) => {
    for (const p of [s.a, s.b]) {
      const list = ends.get(key(p));
      if (list) list.push(n);
      else ends.set(key(p), [n]);
    }
  });
  const used = new Uint8Array(clipped.length);
  const out: Array<[Vec2, Vec2]> = [];
  for (const [k, list] of ends) {
    if (list.length !== 1 || used[list[0]]) continue;
    let seg = list[0];
    const start = key(clipped[seg].a) === k ? clipped[seg].a : clipped[seg].b;
    let at = start;
    while (seg >= 0 && !used[seg]) {
      used[seg] = 1;
      const s = clipped[seg];
      at = key(s.a) === key(at) ? s.b : s.a;
      seg = (ends.get(key(at)) ?? []).find((m) => !used[m]) ?? -1;
    }
    const [a, b] = [onBoundary(start), onBoundary(at)];
    if (a && !b) out.push([start, at]);
    else if (b && !a) out.push([at, start]);
  }
  return out;
}

/**
 * Where the true rim lies along a (grown) trace that enters a face at P and
 * ends at Q inside it: the distance from P to the true sheet's free end on
 * that line, over the distance from P across the face along PQ. Growing moves
 * a rim outwards, so its true end lies on PQ short of Q: of the true ends near
 * the line, the one nearest Q from behind (the far rim of a narrow strip also
 * lies on the line, further back). Negative when the true rim is short of P;
 * null when no true end lies near the line (the grown part of a sheet past an
 * end rim).
 */
function trueRimFraction(P: Vec2, Q: Vec2, u0: number, u1: number, v0: number, v1: number, ends: Vec2[]): number | null {
  const d: Vec2 = [Q[0] - P[0], Q[1] - P[1]];
  const len = Math.hypot(d[0], d[1]);
  const dir: Vec2 = [d[0] / len, d[1] / len];
  let across = Infinity;
  for (const [a, lo, hi] of [[0, u0, u1], [1, v0, v1]] as const) {
    if (dir[a] > 0) across = Math.min(across, (hi - P[a]) / dir[a]);
    else if (dir[a] < 0) across = Math.min(across, (lo - P[a]) / dir[a]);
  }
  if (!(len > 0 && across > 0 && across < Infinity)) throw new Error(`a thin sheet's rim trace is degenerate in a face at (${P.join(', ')}) (zero length, or along the face boundary); move the sheet off the mesh line or use rims: 'snap'`);
  const ahead = len + 1e-6 * across;
  let along: number | null = null;
  for (const e of ends) {
    const w = [e[0] - P[0], e[1] - P[1]];
    const a = w[0] * dir[0] + w[1] * dir[1];
    const off = Math.abs(w[0] * dir[1] - w[1] * dir[0]);
    if (off < 0.5 * across && a <= ahead && a > -1.5 * across && (along === null || a > along)) along = a;
  }
  return along === null ? null : along / across;
}

/** Index of the cell [lines[n], lines[n+1]) holding value (clamped). */
function cellIndex(lines: Float64Array, value: number): number {
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
