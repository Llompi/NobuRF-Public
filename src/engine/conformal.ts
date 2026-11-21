import type { VoxelModel } from './voxelize';

/**
 * Conformal copper sheets: a copper edge that is not parallel to a mesh line
 * (a slanted trace, a circular patch) is modelled by how much of each Yee edge
 * and face it covers, instead of a staircase of whole cells.
 *
 * The method is Dey and Mittra's conformal PEC FDTD (IEEE Microwave Guided
 * Wave Lett. 7(9), 1997; Taflove and Hagness, Computational Electrodynamics,
 * 3rd ed., section 10.6), written in the finite integration form of
 * Weiland's partially filled cells. Both say the same thing: Faraday's law on
 * a face counts only the part of the face that is not metal, and only the
 * free part of each edge of it, because tangential E is zero on the metal.
 *
 * In this code's variables (e is the edge voltage over the edge's full length,
 * as everywhere else), with lambda the free fraction of an edge and a the free
 * fraction of a face:
 *   - an edge keeps its E update with its curl coefficient times lambda (its
 *     permittivity reads eps / lambda); lambda 0 is a PEC edge as before;
 *   - a face's H update is divided by its free area a.
 * The first is a material coefficient (eCurl, rasterise.ts). The second is
 * this module: a sparse pass after the H update adds (1/a - 1) times that
 * face's curl again, h += sum of coef * e over its four edges.
 *
 * Stability. Dividing by a small a speeds up the face; Dey and Mittra cut
 * the time step for it. Here a model whose copper partly covers any edge
 * runs at a fixed Courant number of 0.5 (CONFORMAL_COURANT, 14 % more steps than the default
 * 0.572), and each face's a is raised to an effective a_eff where the bound
 * proved in docs/conformal.md needs it, as Benkler, Chavannes and Kuster
 * enlarge small cells (IEEE TAP 54(6), 2006). The bound keeps the largest
 * eigenvalue of the update under the leapfrog limit for any copper shape.
 */
export interface ConformalFaces {
  /** H-buffer index of each corrected face, each listed once. */
  hIndex: Uint32Array;
  /** Four per face: the E-buffer index of each of its edges and its coefficient, h += sum(coef * e). */
  eIndex: Uint32Array;
  coef: Float32Array;
  /** eCurl of those edges when the list was built (see activeConformalFaces). */
  eCurl: Float32Array;
  /**
   * E-buffer index of every partly covered edge, ascending: their eCurl is
   * scaled by their free fraction, so it no longer reads as Sc / eps_r. Code
   * that repaints edges from their eCurl (coax_feed.ts) must leave them alone.
   */
  partialEdges: Uint32Array;
}

/** Fractions closer than this to 0 or 1 snap to it, so a copper edge on a mesh line meshes exactly as the staircase does. */
export const COVERAGE_SNAP = 1e-6;

/**
 * Courant number of a model whose conformal copper partly covers any edge
 * (rasterise.ts; copper wholly on mesh lines keeps the default). Below the 3D limit
 * 1/sqrt(3) = 0.577 it leaves stability slack for the cut faces (see
 * effectiveFreeArea); the run takes 14 % more steps than at the default 0.572.
 */
export const CONFORMAL_COURANT = 0.5;

/**
 * Courant number for models with conformal 3D solids or thin sheets
 * (src/project/conformal_solids.ts, conformal_sheets.ts). Either cuts faces of all three orientations, so up to four cut faces share
 * an edge's stability slack instead of two, and at CONFORMAL_COURANT the bound
 * raises so many effective areas that a sphere cavity reads 1.5 % low at ten
 * cells per radius. At 1/3 the floors cost under 0.1 % there
 * (docs/conformal.md); the run takes 1.7 times the steps of the default.
 */
export const CONFORMAL_SOLID_COURANT = 1 / 3;

/** Largest eigenvalue of the uncut Yee operator, in units of Sc^2 / smallest cell^2. */
const YEE_EIGEN_BOUND = 12;

/**
 * The free area a cut face is updated with: its free area `a`, raised where
 * the stability bound in docs/conformal.md needs it. `lambdas` are the free
 * fractions of its edges (0: PEC, not counted) and `entries` the squares of
 * the normalised curl entries of those edges with this face (1 in air on a
 * uniform mesh, 1/eps_r on a dielectric interface, smaller on larger graded
 * cells). With L = 0.98 * 4 / Sc^2 the eigenvalue budget, each free edge has
 * the slack s = (L - 12) + L (1/lambda - 1), and
 *   Delta = 1/a_eff - 1 <= 1 / (2 * sum over free edges of entry / s).
 * At the default Courant number L is 12, so a face with a wholly free edge
 * gets no correction; at CONFORMAL_COURANT every cut face gets one. Returns 1
 * for no correction.
 *
 * `sharing` is the most cut faces any free edge of this face borders. Each
 * edge's slack is split between them, so the bound needs
 * sharing * Delta * G <= 1. Copper planes cut only the faces in their plane,
 * two per edge; a 3D solid can cut all four faces of an edge.
 */
export function effectiveFreeArea(a: number, lambdas: readonly number[], entries: readonly number[], courant: number, sharing = 2): number {
  const budget = (0.98 * 4) / (courant * courant);
  let load = 0;
  for (let n = 0; n < lambdas.length; n++) {
    if (lambdas[n] <= 0) continue;
    const slack = Math.max(0, budget - YEE_EIGEN_BOUND) + budget * (1 / lambdas[n] - 1);
    if (slack <= 0) return 1;
    load += entries[n] / slack;
  }
  if (load === 0) return 1;
  return Math.min(1, Math.max(a, 1 / (1 + 1 / (sharing * load))));
}

/**
 * The faces of `model.conformal` whose edges still have the eCurl they were
 * built with. A later edit that repaints one of them (a coax anti-pad cut
 * through slanted copper) drops that face back to the plain update, which is
 * always stable.
 */
export function activeConformalFaces(model: VoxelModel): ConformalFaces | null {
  const c = model.conformal;
  if (!c || c.hIndex.length === 0) return null;
  const keep: number[] = [];
  for (let f = 0; f < c.hIndex.length; f++) {
    let same = true;
    for (let n = 0; n < 4; n++) if (model.eCurl[c.eIndex[4 * f + n]] !== c.eCurl[4 * f + n]) same = false;
    if (same) keep.push(f);
  }
  if (keep.length === c.hIndex.length) return c;
  if (keep.length === 0) return null;
  const pick4 = <T extends Uint32Array | Float32Array>(a: T, make: (n: number) => T) => {
    const out = make(4 * keep.length);
    keep.forEach((f, m) => out.set(a.subarray(4 * f, 4 * f + 4), 4 * m));
    return out;
  };
  return {
    hIndex: Uint32Array.from(keep, (f) => c.hIndex[f]),
    eIndex: pick4(c.eIndex, (n) => new Uint32Array(n)),
    coef: pick4(c.coef, (n) => new Float32Array(n)),
    eCurl: pick4(c.eCurl, (n) => new Float32Array(n)),
    partialEdges: c.partialEdges,
  };
}

/** h += sum(coef * e) for each listed face: the CPU side of conformal.wgsl. */
export function applyConformalFaces(faces: ConformalFaces, e: Float32Array, h: Float32Array): void {
  const { hIndex, eIndex, coef } = faces;
  for (let f = 0; f < hIndex.length; f++) {
    const q = 4 * f;
    h[hIndex[f]] += coef[q] * e[eIndex[q]] + coef[q + 1] * e[eIndex[q + 1]] + coef[q + 2] * e[eIndex[q + 2]] + coef[q + 3] * e[eIndex[q + 3]];
  }
}
