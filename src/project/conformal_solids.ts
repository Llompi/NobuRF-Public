import { CONFORMAL_SOLID_COURANT, COVERAGE_SNAP, effectiveFreeArea } from '../engine/conformal';
import type { MeshLines } from '../engine/mesh';
import { materialSignature, type VoxelModel } from '../engine/voxelize';
import { planeCoverage, type Segment } from './coverage';
import type { Vec2 } from './resolve';

/**
 * Conformal copper of any 3D shape: a closed solid (a wire, a cylinder, a
 * sphere, an imported mesh) is meshed by the exact fraction of each Yee edge
 * and face it covers, on all three face orientations, instead of a staircase
 * of whole cells. It is the same Dey-Mittra rule as the copper planes
 * (conformal.ts, docs/conformal.md), with the coverage taken from a closed
 * triangle surface instead of a flat polygon:
 *
 *   - the free fraction lambda of an edge (the part outside every solid)
 *     scales its curl coefficient (it reads as eps / lambda); 0 is PEC;
 *   - a face the solid cuts divides its H update by its free area, raised to
 *     the effective area of the stability bound (effectiveFreeArea).
 *
 * Coverage is exact for the triangle surface. Every Yee edge and face lies in
 * a mesh plane (x = x_i, y = y_j or z = z_k), and the solid's cross-section
 * there is a set of polygons: the plane cuts each triangle in a segment, and
 * the segments of a closed surface close into loops. coverage.ts already
 * integrates polygons exactly over the edges and faces of a plane, so this
 * module slices and hands over. The solid is closed: copper on its surface
 * counts as copper, so a face of the solid lying on a mesh plane makes that
 * plane's edges PEC, as the staircase does.
 *
 * Inputs in mm, in the model's mesh coordinates. Solids are PEC (no copper
 * loss yet) and must stay clear of the PML, ports, lumped components and
 * frequency-dependent materials; every such clash throws.
 */
export interface TriangleMesh {
  /** x, y, z of each vertex (mm). */
  positions: Float64Array;
  /** Three vertex indices per triangle. */
  triangles: Uint32Array;
}

/** Distances below this (mm) count as on the plane or on a segment, as coverage.ts's tolerance. */
const TOLERANCE_MM = 1e-9;

/**
 * One vertex per position, and no triangle that names a vertex twice: triangles
 * that share a point by value then share it by index, so their sections link.
 * A mesh given as one vertex per triangle (an STL) would otherwise read as
 * loose triangles; a zero-area facet whose corners coincide drops out.
 */
export function weldMesh(mesh: TriangleMesh): TriangleMesh {
  const index = new Map<string, number>();
  const positions: number[] = [];
  const remap = new Uint32Array(mesh.positions.length / 3);
  for (let v = 0; v < remap.length; v++) {
    const key = `${mesh.positions[3 * v]},${mesh.positions[3 * v + 1]},${mesh.positions[3 * v + 2]}`;
    let n = index.get(key);
    if (n === undefined) {
      n = positions.length / 3;
      index.set(key, n);
      positions.push(mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]);
    }
    remap[v] = n;
  }
  const triangles: number[] = [];
  for (let n = 0; n + 2 < mesh.triangles.length; n += 3) {
    const [a, b, c] = [remap[mesh.triangles[n]], remap[mesh.triangles[n + 1]], remap[mesh.triangles[n + 2]]];
    if (a !== b && b !== c && a !== c) triangles.push(a, b, c);
  }
  return { positions: Float64Array.from(positions), triangles: Uint32Array.from(triangles) };
}

/**
 * Throws unless every edge of the surface is shared by exactly two triangles
 * and no triangle names a vertex twice (weldMesh drops those). Slicing an open or torn surface gives open
 * loops, which have no inside.
 */
export function assertClosedMesh(mesh: TriangleMesh): void {
  const { positions: p, triangles: t } = mesh;
  if (t.length === 0 || t.length % 3 !== 0) throw new Error('a solid needs at least one triangle, three indices each');
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
  for (const [key, n] of count) {
    if (n !== 2) throw new Error(`the surface is not closed: edge ${Math.floor(key / nv)}-${key % nv} belongs to ${n} triangle(s), not 2`);
  }
}

/**
 * The cross-section of one solid in the plane `axis` = `at`, as segments in the
 * plane's (u, v) coordinates (axis 0: (y, z); 1: (x, z); 2: (x, y)). `side`
 * decides vertices lying on the plane: -1 counts them above it, which slices
 * just below the plane, and +1 just above. Unioned, the two give the closed
 * section, surface included.
 */
export function slice(mesh: TriangleMesh, candidates: readonly number[], axis: 0 | 1 | 2, at: number, side: -1 | 1): Segment[] {
  const { positions: p, triangles: t } = mesh;
  const [u, v] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const out: Segment[] = [];
  // Both triangles of a mesh edge must get the bitwise same point, or a row through it can count it twice: interpolate from the lower index.
  const point = (a: number, b: number, da: number, db: number): Vec2 => {
    if (a > b) [a, b, da, db] = [b, a, db, da];
    const s = da / (da - db);
    return [p[3 * a + u] + s * (p[3 * b + u] - p[3 * a + u]), p[3 * a + v] + s * (p[3 * b + v] - p[3 * a + v])];
  };
  for (const tri of candidates) {
    const ids = [t[3 * tri], t[3 * tri + 1], t[3 * tri + 2]];
    const d = ids.map((id) => {
      const x = p[3 * id + axis] - at;
      return Math.abs(x) <= TOLERANCE_MM ? 0 : x;
    });
    const above = d.map((x) => x > 0 || (x === 0 && side < 0));
    const nAbove = above.filter(Boolean).length;
    if (nAbove === 0 || nAbove === 3) continue;
    // The lone vertex is on one side, the other two on the other; the segment joins the two crossed edges.
    const lone = above.findIndex((x) => (nAbove === 1 ? x : !x));
    const [b, c] = [(lone + 1) % 3, (lone + 2) % 3];
    out.push({ a: point(ids[lone], ids[b], d[lone], d[b]), b: point(ids[lone], ids[c], d[lone], d[c]) });
  }
  return out;
}

/**
 * Point test of a closed cross-section (`segments`, in a plane's (u, v)): inside
 * by crossing parity of a ray towards +u, or within the tolerance of a segment.
 * Rays are cached per v, since coverage.ts asks along shared rows.
 */
function sectionTest(segments: Segment[]): (u: number, v: number) => boolean {
  const rows = new Map<number, { cross: Float64Array; flat: Array<[number, number]> }>();
  const row = (v: number) => {
    let r = rows.get(v);
    if (r) return r;
    const cross: number[] = [];
    const flat: Array<[number, number]> = [];
    for (const { a, b } of segments) {
      if (Math.abs(a[1] - v) <= TOLERANCE_MM && Math.abs(b[1] - v) <= TOLERANCE_MM) flat.push([Math.min(a[0], b[0]), Math.max(a[0], b[0])]);
      if (a[1] > v !== b[1] > v) cross.push(a[0] + ((v - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    r = { cross: Float64Array.from(cross).sort(), flat };
    rows.set(v, r);
    return r;
  };
  return (u, v) => {
    const { cross, flat } = row(v);
    for (const [lo, hi] of flat) if (u >= lo - TOLERANCE_MM && u <= hi + TOLERANCE_MM) return true;
    // Crossings to the right of u, and whether one is within the tolerance of u (on the boundary).
    let lo = 0;
    let hi = cross.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cross[mid] < u) lo = mid + 1;
      else hi = mid;
    }
    if ((lo < cross.length && cross[lo] - u <= TOLERANCE_MM) || (lo > 0 && u - cross[lo - 1] <= TOLERANCE_MM)) return true;
    return (cross.length - lo) % 2 === 1;
  };
}

/** Covered fraction (0..1) of every E edge and H face of a mesh, 3N each, in the solver's component-major layout. */
export interface SolidCoverage {
  edge: Float32Array;
  face: Float32Array;
}

/** The triangles whose extent along `axis` reaches each node line, so a plane slices only those. */
export function trianglesByLine(mesh: TriangleMesh, lines: Float64Array, axis: number): number[][] {
  const out: number[][] = Array.from({ length: lines.length }, () => []);
  const { positions: p, triangles: t } = mesh;
  for (let tri = 0; tri < t.length / 3; tri++) {
    const xs = [0, 1, 2].map((n) => p[3 * t[3 * tri + n] + axis]);
    const lo = Math.min(...xs) - TOLERANCE_MM;
    const hi = Math.max(...xs) + TOLERANCE_MM;
    for (let n = firstAtOrAbove(lines, lo); n < lines.length && lines[n] <= hi; n++) out[n].push(tri);
  }
  return out;
}

function firstAtOrAbove(lines: Float64Array, value: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Exact coverage of every edge and face of `mesh` by the union of `solids`
 * (closed triangle surfaces, mm). Each edge is read from one plane it lies in:
 * Ey and Ez from x planes, Ex from y planes; each face from its own plane.
 */
export function solidCoverage(lines: MeshLines, given: readonly TriangleMesh[]): SolidCoverage {
  const solids = given.map(weldMesh);
  for (const s of solids) assertClosedMesh(s);
  const [nx, ny, nz] = [lines.x.length, lines.y.length, lines.z.length];
  const N = nx * ny * nz;
  const edge = new Float32Array(3 * N);
  const face = new Float32Array(3 * N);
  const axisLines = [lines.x, lines.y, lines.z];
  const byLine = [0, 1, 2].map((axis) => solids.map((s) => trianglesByLine(s, axisLines[axis], axis)));
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  for (const axis of [0, 1, 2] as const) {
    const [uLines, vLines] = axis === 0 ? [lines.y, lines.z] : axis === 1 ? [lines.x, lines.z] : [lines.x, lines.y];
    const nu = uLines.length;
    for (let n = 0; n < axisLines[axis].length; n++) {
      const plane = axisLines[axis][n];
      const sections: Segment[][] = [];
      solids.forEach((s, m) => {
        const candidates = byLine[axis][m][n];
        if (candidates.length === 0) return;
        const onPlane = candidates.some((tri) => [0, 1, 2].some((q) => Math.abs(s.positions[3 * s.triangles[3 * tri + q] + axis] - plane) <= TOLERANCE_MM));
        for (const side of onPlane ? ([-1, 1] as const) : ([-1] as const)) {
          const segments = slice(s, candidates, axis, plane, side);
          if (segments.length > 0) sections.push(segments);
        }
      });
      if (sections.length === 0) continue;
      const tests = sections.map(sectionTest);
      const cover = planeCoverage(uLines, vLines, sections.flat(), (u, v) => tests.some((test) => test(u, v)));
      for (let q = 0; q < vLines.length; q++) {
        for (let p = 0; p < nu; p++) {
          const col = p + nu * q;
          if (axis === 0) {
            // u = y, v = z: Ey (i, j+1/2, k), Ez (i, j, k+1/2), Hx (i, j+1/2, k+1/2).
            const c = at(n, p, q);
            edge[N + c] = cover.ex[col];
            edge[2 * N + c] = cover.ey[col];
            face[c] = cover.face[col];
          } else if (axis === 1) {
            // u = x, v = z: Ex (i+1/2, j, k), Hy (i+1/2, j, k+1/2).
            const c = at(p, n, q);
            edge[c] = cover.ex[col];
            face[N + c] = cover.face[col];
          } else {
            // u = x, v = y: Hz (i+1/2, j+1/2, k).
            face[2 * N + at(p, q, n)] = cover.face[col];
          }
        }
      }
    }
  }
  return { edge, face };
}

/**
 * Puts conformal PEC solids into a built model: covered edges become PEC,
 * partly covered ones take their free fraction, and every face the solids cut
 * joins the model's conformal face list (conformal.ts). The model must run at
 * CONFORMAL_SOLID_COURANT or below: the update is stable at any Courant number
 * (effectiveFreeArea), but above it the stability floors cost accuracy.
 * Pass every solid in one call: solids from separate calls may not share a
 * cut face or a partly covered edge (it throws).
 *
 * Changes `model` in place and returns it.
 */
export function addConformalSolids(model: VoxelModel, solids: readonly TriangleMesh[]): VoxelModel {
  if (model.thinSheets) throw new Error('add conformal solids before thin sheets: the sheets are built against the model as it stands');
  const { grid, cpml, eCurl, eDecay } = model;
  const { nx, ny, nz, courant: Sc } = grid;
  if (Sc > CONFORMAL_SOLID_COURANT + 1e-12) {
    throw new Error(`conformal solids need a Courant number of ${CONFORMAL_SOLID_COURANT.toFixed(4)} or less (docs/conformal.md); the model runs at ${Sc}`);
  }
  if (model.dispersion?.e || model.dispersion?.h) throw new Error('conformal solids do not support frequency-dependent or magnetic materials yet');
  const N = nx * ny * nz;
  const cover = solidCoverage(model.mesh, solids);
  const snap = (f: number) => (f <= COVERAGE_SNAP ? 0 : f >= 1 - COVERAGE_SNAP ? 1 : f);

  // Nothing the solids touch may be in the PML or hold a port or a lumped component.
  const reserved = new Set<number>();
  for (const port of model.ports) for (const e of port.ezIndex) reserved.add(e);
  for (const e of model.lumped?.eIndex ?? []) reserved.add(e);
  const before = model.conformal;
  const oldPartial = new Set(before?.partialEdges ?? []);
  const oldFaces = new Set(before?.hIndex ?? []);
  const pml = [cpml.x, cpml.y, cpml.z];
  const inPml = (c: number) => {
    const ijk = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    const n = [nx, ny, nz];
    // The slabs hold the first `low` and last `high` node layers; one more layer of margin on each.
    return ijk.some((v, a) => (pml[a].low > 0 && v <= pml[a].low) || (pml[a].high > 0 && v >= n[a] - 1 - pml[a].high));
  };

  // Free fraction of each edge the solids reach.
  const lambda = new Float32Array(3 * N).fill(1);
  const partial: number[] = [];
  for (let e = 0; e < 3 * N; e++) {
    const f = snap(cover.edge[e]);
    if (f === 0) continue;
    const where = `edge ${['Ex', 'Ey', 'Ez'][Math.floor(e / N)]} at cell ${e % N}`;
    if (reserved.has(e)) throw new Error(`a conformal solid reaches a port or lumped component (${where})`);
    if (inPml(e % N)) throw new Error(`a conformal solid reaches the PML (${where}); add air between it and the boundary`);
    if (oldPartial.has(e)) throw new Error(`a conformal solid and a conformal copper plane share a partly covered edge (${where})`);
    lambda[e] = 1 - f;
    if (eCurl[e] === 0) continue;
    if (f === 1) {
      eCurl[e] = 0;
      eDecay[e] = 1;
    } else {
      eCurl[e] *= 1 - f;
      partial.push(e);
    }
  }
  // Faces the solids cut, with their four edges in the order of the H update (fdtd_cpu.ts updateH):
  // h -= Sc * (s1 * (e[0] - e[1]) - s2 * (e[2] - e[3])); eSide is the E update's scale on each edge.
  const { x: X, y: Y, z: Z } = cpml;
  const isFree = (e: number) => eCurl[e] !== 0;
  const cut: Array<{ f: number; a: number; edges: number[]; s1: number; s2: number; eSide: number[] }> = [];
  for (let f = 0; f < 3 * N; f++) {
    const a = 1 - snap(cover.face[f]);
    if (a >= 1) continue;
    const comp = Math.floor(f / N);
    const c = f % N;
    const [i, j, k] = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    // A face on the far side of the mesh has no edges past it; the solver reads those as zero.
    if ((comp !== 0 && i + 1 >= nx) || (comp !== 1 && j + 1 >= ny) || (comp !== 2 && k + 1 >= nz)) continue;
    const edges = comp === 0 ? [2 * N + c + nx, 2 * N + c, N + c + nx * ny, N + c] : comp === 1 ? [c + nx * ny, c, 2 * N + c + 1, 2 * N + c] : [N + c + 1, N + c, c + nx, c];
    // A face with no free edge never changes (all of metal's interior): no correction, nothing to share.
    if (!edges.some(isFree)) continue;
    if (oldFaces.has(f)) throw new Error(`a conformal solid and a conformal copper plane cut the same face (H${'xyz'[comp]} at cell ${c})`);
    if (inPml(c)) throw new Error(`a conformal solid reaches the PML (face H${'xyz'[comp]} at cell ${c}); add air between it and the boundary`);
    cut.push(
      comp === 0 ? { f, a, edges, s1: Y.hDiffScale[j], s2: Z.hDiffScale[k], eSide: [Y.eDiffScale[j + 1], Y.eDiffScale[j], Z.eDiffScale[k + 1], Z.eDiffScale[k]] }
        : comp === 1 ? { f, a, edges, s1: Z.hDiffScale[k], s2: X.hDiffScale[i], eSide: [Z.eDiffScale[k + 1], Z.eDiffScale[k], X.eDiffScale[i + 1], X.eDiffScale[i]] }
          : { f, a, edges, s1: X.hDiffScale[i], s2: Y.hDiffScale[j], eSide: [X.eDiffScale[i + 1], X.eDiffScale[i], Y.eDiffScale[j + 1], Y.eDiffScale[j]] },
    );
  }
  // How many cut faces each free edge borders: its stability slack is shared between them (effectiveFreeArea).
  const sharing = new Map<number, number>();
  for (const { edges } of cut) for (const e of edges) if (isFree(e)) sharing.set(e, (sharing.get(e) ?? 0) + 1);
  const oldEdges = new Set(before?.eIndex ?? []);
  const hIndex: number[] = [];
  const eIndex: number[] = [];
  const coef: number[] = [];
  for (const { f, a, edges, s1, s2, eSide } of cut) {
    for (const e of edges) {
      if (isFree(e) && oldEdges.has(e)) throw new Error(`a conformal solid cuts a face next to conformal copper-plane faces (edge ${e}); keep them a cell apart`);
    }
    const lambdas = edges.map((e) => (isFree(e) ? lambda[e] : 0));
    const entries = edges.map((e, n) => (lambdas[n] > 0 ? ((n < 2 ? s1 : s2) * eSide[n] * eCurl[e]) / (lambdas[n] * Sc) : 0));
    const share = Math.max(1, ...edges.map((e) => (isFree(e) ? sharing.get(e)! : 0)));
    const aEff = effectiveFreeArea(a, lambdas, entries, Sc, share);
    if (aEff >= 1) continue;
    const w = Sc * (1 / aEff - 1);
    hIndex.push(f);
    eIndex.push(...edges);
    coef.push(-w * s1, w * s1, w * s2, -w * s2);
  }

  if (hIndex.length === 0 && partial.length === 0 && !before) {
    model.signature = materialSignature(eDecay, eCurl, model);
    return model;
  }
  const e = Uint32Array.from([...(before?.eIndex ?? []), ...eIndex]);
  model.conformal = {
    hIndex: Uint32Array.from([...(before?.hIndex ?? []), ...hIndex]),
    eIndex: e,
    coef: Float32Array.from([...(before?.coef ?? []), ...coef]),
    eCurl: Float32Array.from(e, (index) => eCurl[index]),
    partialEdges: Uint32Array.from([...oldPartial, ...partial]).sort(),
  };
  model.signature = materialSignature(eDecay, eCurl, model);
  return model;
}

/* ------------------------------------------------------------ shapes */

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

function meshOf(points: Vec3[], triangles: number[]): TriangleMesh {
  return { positions: Float64Array.from(points.flat()), triangles: Uint32Array.from(triangles) };
}

/** Segments around a circle of `radiusMm` so the chord stays within `sagMm` of the arc. */
export function segmentsForSag(radiusMm: number, sagMm: number): number {
  return Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - sagMm / radiusMm))));
}

/** A UV sphere: `rings` bands of latitude, `segments` of longitude. */
export function sphereMesh(centre: Vec3, radiusMm: number, segments: number, rings = Math.ceil(segments / 2)): TriangleMesh {
  const points: Vec3[] = [[centre[0], centre[1], centre[2] + radiusMm], [centre[0], centre[1], centre[2] - radiusMm]];
  for (let r = 1; r < rings; r++) {
    const th = (Math.PI * r) / rings;
    for (let s = 0; s < segments; s++) {
      const ph = (2 * Math.PI * s) / segments;
      points.push([centre[0] + radiusMm * Math.sin(th) * Math.cos(ph), centre[1] + radiusMm * Math.sin(th) * Math.sin(ph), centre[2] + radiusMm * Math.cos(th)]);
    }
  }
  const at = (r: number, s: number) => 2 + (r - 1) * segments + (s % segments);
  const tris: number[] = [];
  for (let s = 0; s < segments; s++) {
    tris.push(0, at(1, s), at(1, s + 1));
    tris.push(1, at(rings - 1, s + 1), at(rings - 1, s));
    for (let r = 1; r + 1 < rings; r++) tris.push(at(r, s), at(r + 1, s), at(r + 1, s + 1), at(r, s), at(r + 1, s + 1), at(r, s + 1));
  }
  return meshOf(points, tris);
}

/**
 * A tube of circular section `radiusMm` along the polyline `path`, its ends
 * capped flat. The section is carried along by parallel transport, so a
 * finely sampled helix gives a smooth wire. Sections stand square to the
 * averaged tangent with no miter, so a sharp bend of angle theta pinches the
 * tube to r cos(theta / 2): sample curves finely. A straight two-point path is a cylinder.
 */
export function tubeMesh(path: readonly Vec3[], radiusMm: number, segments: number): TriangleMesh {
  if (path.length < 2) throw new Error('a tube needs at least two path points');
  for (let n = 1; n < path.length; n++) {
    if (Math.hypot(...sub(path[n], path[n - 1])) <= TOLERANCE_MM) throw new Error(`tube path points ${n - 1} and ${n} coincide`);
  }
  const tangents = path.map((_, n) => unit(sub(path[Math.min(n + 1, path.length - 1)], path[Math.max(n - 1, 0)])));
  // First normal: any direction across the first tangent.
  const t0 = tangents[0];
  let normal = unit(cross(t0, Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
  const points: Vec3[] = [];
  for (let n = 0; n < path.length; n++) {
    const t = tangents[n];
    normal = unit(sub(normal, t.map((x) => x * dot(normal, t)) as Vec3));
    const binormal = cross(t, normal);
    for (let s = 0; s < segments; s++) {
      const ph = (2 * Math.PI * s) / segments;
      const [c, sn] = [Math.cos(ph) * radiusMm, Math.sin(ph) * radiusMm];
      points.push([path[n][0] + c * normal[0] + sn * binormal[0], path[n][1] + c * normal[1] + sn * binormal[1], path[n][2] + c * normal[2] + sn * binormal[2]]);
    }
  }
  const startCap = points.length;
  points.push([...path[0]] as Vec3, [...path[path.length - 1]] as Vec3);
  const at = (n: number, s: number) => n * segments + (s % segments);
  const tris: number[] = [];
  for (let n = 0; n + 1 < path.length; n++) {
    for (let s = 0; s < segments; s++) tris.push(at(n, s), at(n + 1, s), at(n + 1, s + 1), at(n, s), at(n + 1, s + 1), at(n, s + 1));
  }
  const last = path.length - 1;
  for (let s = 0; s < segments; s++) {
    tris.push(startCap, at(0, s + 1), at(0, s));
    tris.push(startCap + 1, at(last, s), at(last, s + 1));
  }
  return meshOf(points, tris);
}

/** An axis-aligned box from corner `lo` to corner `hi`. */
export function boxMesh(lo: Vec3, hi: Vec3): TriangleMesh {
  const points: Vec3[] = [];
  for (let n = 0; n < 8; n++) points.push([n & 1 ? hi[0] : lo[0], n & 2 ? hi[1] : lo[1], n & 4 ? hi[2] : lo[2]]);
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return meshOf(points, quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
}

/**
 * An open strip of `widthMm` along a path, for thin sheets (conformal_sheets.ts):
 * at each point the strip spans `across[n]` (any length, made unit) centred on
 * the path. A helix arm on a cylinder passes the cylinder's axis direction,
 * a flat strip one fixed direction.
 */
export function ribbonMesh(path: readonly Vec3[], across: readonly Vec3[], widthMm: number): TriangleMesh {
  if (path.length < 2 || across.length !== path.length) throw new Error('a ribbon needs two or more points and one width direction per point');
  const points: Vec3[] = [];
  path.forEach((p, n) => {
    const w = unit(across[n]);
    for (const side of [-0.5, 0.5]) points.push([p[0] + side * widthMm * w[0], p[1] + side * widthMm * w[1], p[2] + side * widthMm * w[2]]);
  });
  const triangles: number[] = [];
  for (let n = 0; n + 1 < path.length; n++) triangles.push(2 * n, 2 * n + 2, 2 * n + 3, 2 * n, 2 * n + 3, 2 * n + 1);
  return meshOf(points, triangles);
}

/** Several closed surfaces as one solid: inside is where an odd number of them enclose the point (a box minus a sphere, a shell). */
export function joinMeshes(meshes: readonly TriangleMesh[]): TriangleMesh {
  const positions = new Float64Array(meshes.reduce((n, m) => n + m.positions.length, 0));
  const triangles = new Uint32Array(meshes.reduce((n, m) => n + m.triangles.length, 0));
  let [p, t] = [0, 0];
  for (const m of meshes) {
    positions.set(m.positions, p);
    for (let n = 0; n < m.triangles.length; n++) triangles[t + n] = m.triangles[n] + p / 3;
    p += m.positions.length;
    t += m.triangles.length;
  }
  return { positions, triangles };
}
