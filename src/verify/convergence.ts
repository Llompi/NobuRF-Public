/**
 * Mesh convergence: how far a result is from the answer an infinitely fine
 * mesh would give, estimated by solving the same project on finer meshes.
 * This is mesh discretisation uncertainty only: it excludes the error of the
 * port model and the material model, which only measurement shows.
 *
 * Levels refine upward from the project's mesh (cells / r per pass, r = sqrt
 * 2 nominal). Never coarser: a coarser mesh merges copper edges closer than
 * a quarter edge cell, rounds dielectric layers to fewer cells and can drop a
 * narrow port, so it would be a different board, not the same one on a
 * coarser grid.
 *   "check":  one finer mesh. Two-level band (below).
 *   "refine": two finer meshes, then "settled" when the last pass moved S
 *             less than the Delta S tolerance (the "maximum Delta S" of
 *             adaptive FEM solvers) AND the resonance less than 0.5 %. It
 *             does not stop after one settled pass: one pass can settle by
 *             chance, so both always run, and three levels give the band
 *             an observed order.
 * Either way the result reported is the finest mesh's.
 *
 * Error band, on scalar features only (resonance frequency, |S11| at the dip),
 * never pointwise on S(f), which near a resonance mostly measures the shift:
 * - Two levels: U = 3 |phi1 - phi2| / (r - 1), Roache's two-grid GCI with
 *   safety factor 3 and order 1 (P. J. Roache, "Perspective: a method for
 *   uniform reporting of grid refinement studies", J. Fluids Eng. 116,
 *   1994, pp. 405-413). Order 1, not the Yee scheme's formal 2, because
 *   staircased metal edges lower FDTD's order (J. Haggblad and O. Runborg,
 *   "Accuracy of staircase approximations in finite-difference methods for
 *   wave propagation", Numer. Math., 2014; an observed 1 to 1.5 is typical).
 * - Three or more levels: the Grid Convergence Index with the procedure of
 *   I. B. Celik et al., J. Fluids Eng. 130(7), 2008, 078001 (observed order
 *   by fixed-point iteration, eqs. 3a-c, unequal ratios allowed; eq. 4
 *   extrapolation; eq. 6 GCI), with the order limits of L. Eca and M.
 *   Hoekstra, "A procedure for the estimation of the numerical uncertainty
 *   of CFD calculations based on grid refinement studies", J. Comput.
 *   Phys. 262, 2014, pp. 104-130: an observed order within [0.8, 2] uses
 *   Fs = 1.25; outside it the order is clamped into that range and Fs = 3.
 *   Behaviour classes follow F. Stern et al., J. Fluids Eng. 123(4), 2001,
 *   pp. 793-802 (R = eps21 / eps32: monotone for 0 < R < 1); outside
 *   monotone convergence the band is 3x the largest change seen, a rough
 *   bound, flagged.
 *
 * h is Celik's representative cell size (volume / cells)^(1/3), measured on
 * the board region, not the nominal scale: whole-cell rounding and lines
 * fixed at copper edges keep the real ratio from being sqrt 2, and the
 * ratio sets the size of the band.
 */
import type { ScatteringResult } from '../engine/port_dft';

/** One solved mesh level, whatever the solver (CLI, workbench worker). */
export interface LevelSolve {
  /** S over the analysis band: a 1x1 matrix for a one-port project. */
  s: ScatteringResult;
  cells: number;
  /** Representative cell size of the board region, mm: (volume / cells)^(1/3). */
  hMm: number;
}

export type SolveLevel = (projectJson: Record<string, any>, scale: number) => Promise<LevelSolve>;

export type Behaviour = 'two-level' | 'monotone' | 'low-order' | 'high-order' | 'oscillatory' | 'divergent' | 'unchanged';

export interface GciEstimate {
  /** On the finest mesh. */
  value: number;
  /** Richardson extrapolation to zero cell size with the order used; null when the levels do not converge monotonically. */
  extrapolated: number | null;
  /** The order the band uses (observed and clamped, or 1 for two levels); null when none applies. */
  order: number | null;
  /** The observed order before clamping; null with two levels or non-monotone levels. */
  observedOrder: number | null;
  /** Error band on `value`, same unit. */
  uncertainty: number;
  behaviour: Behaviour;
}

export interface MeshLevel {
  /** Mesh lengths relative to the project's mesh: 1 is the project's own, < 1 finer. */
  scale: number;
  cells: number;
  /** The h of the GCI. */
  hMm: number;
  /**
   * One-port only: frequency and |S11| (linear) of the dip, parabola-refined.
   * The dip is the one nearest the finest level's deepest, so a mode that
   * swaps places with another on a coarser mesh is not mistaken for it. Null
   * when that dip is on a band edge.
   */
  fResGhz: number | null;
  s11Min: number | null;
  /** Largest |S_ij(f) - S_ij(f) on the previous (coarser) level| over the band; null on the first level. */
  deltaS: number | null;
}

export interface ConvergenceReport {
  mode: 'check' | 'refine';
  ratio: number;
  tolerance: number;
  /** Project mesh first, finest last; the last is the mesh the reported result comes from. */
  levels: MeshLevel[];
  /** The last pass moved S by at most the tolerance and the resonance by at most 0.5 %. */
  converged: boolean;
  fResGhz: GciEstimate | null;
  /** Linear |S11| at the dip: its band in dB would explode for deep dips. */
  s11Min: GciEstimate | null;
  /** Why refining stopped before converging or the pass limit (a finer mesh failed). */
  refineStopped: string | null;
}

export const DEFAULT_RATIO = Math.SQRT2;
/** The usual default for "maximum delta S" in commercial adaptive meshing. */
export const DEFAULT_DELTA_S = 0.02;
/** Resonance shift in the last pass below which it counts as settled. */
export const RESONANCE_TOLERANCE = 0.005;
export const DEFAULT_MAX_REFINEMENTS = 2;
/** Eca and Hoekstra's accepted range of observed order. */
const MIN_ORDER = 0.8;
const MAX_ORDER = 2;
/** Order assumed with two levels: staircased edges, not the formal 2. */
const TWO_LEVEL_ORDER = 1;
const SAFETY_IN_RANGE = 1.25;
const SAFETY_OUT_OF_RANGE = 3;
/** Neighbouring levels closer than this in h are the same mesh. */
const MIN_H_RATIO = 1.05;

/**
 * The project with every mesh length `scale` times larger (scale < 1:
 * finer). Lengths stay expressions, so variables keep working. Counts
 * measured in cells (layers across a dielectric, air margin) scale the other
 * way so the physical sizes stay put, rounded to whole cells; PML keeps its
 * cell count, because its reflection depends on cells, not millimetres.
 * The step cap grows by 2 / scale: the time step follows the smallest cell,
 * which can shrink faster than the scale. It is only a cap; the energy stop
 * ends the run.
 */
export function scaledMeshJson(json: Record<string, any>, scale: number): Record<string, any> {
  if (!(scale > 0)) throw new Error(`mesh scale must be positive, got ${scale}`);
  const out = structuredClone(json);
  const k = Number(scale.toPrecision(12));
  const mesh = out.mesh;
  mesh.cell = `(${mesh.cell}) * ${k}`;
  for (const side of Object.keys(mesh.air_margin_cells)) {
    mesh.air_margin_cells[side] = Math.max(1, Math.round(mesh.air_margin_cells[side] / scale));
  }
  if (mesh.graded) {
    mesh.graded.edge_cell = `(${mesh.graded.edge_cell}) * ${k}`;
    mesh.graded.dielectric_cells = Math.max(1, Math.round(mesh.graded.dielectric_cells / scale));
  }
  out.analysis.stop.max_steps = Math.ceil((2 * out.analysis.stop.max_steps) / Math.min(1, scale));
  return out;
}

/** Vertex of the parabola through samples k-1, k, k+1 (uniform spacing). */
function parabolaVertex(x: ArrayLike<number>, y: ArrayLike<number>, k: number): { x: number; y: number } {
  const [a, b, c] = [y[k - 1], y[k], y[k + 1]];
  const den = a - 2 * b + c;
  const offset = den === 0 ? 0 : (0.5 * (a - c)) / den;
  return { x: x[k] + offset * (x[1] - x[0]), y: b - 0.25 * (a - c) * offset };
}

/**
 * The |S11| dip of a one-port, refined between frequency samples with a
 * parabola in dB: the sample spacing (often 0.5 % of the band centre) is
 * larger than the mesh error being measured. Without `nearGhz` the deepest
 * dip; with it, the local minimum closest to that frequency. Null when the
 * dip sits on a band edge, so the band does not contain it.
 */
export function s11Minimum(s: ScatteringResult, nearGhz?: number): { fGhz: number; magnitude: number } | null {
  const re = s.re[0][0]!, im = s.im[0][0]!;
  const db = Array.from(re, (r, m) => 20 * Math.log10(Math.max(1e-12, Math.hypot(r, im[m]))));
  let k = 0;
  if (nearGhz === undefined) {
    for (let m = 1; m < db.length; m++) if (db[m] < db[k]) k = m;
  } else {
    let best = Infinity;
    for (let m = 0; m < db.length; m++) {
      const isMinimum = (m === 0 || db[m] <= db[m - 1]) && (m === db.length - 1 || db[m] <= db[m + 1]);
      const distance = Math.abs(s.fGHz[m] - nearGhz);
      if (isMinimum && distance < best) [best, k] = [distance, m];
    }
  }
  if (k === 0 || k === db.length - 1) return null;
  const v = parabolaVertex(s.fGHz, db, k);
  return { fGhz: v.x, magnitude: 10 ** (v.y / 20) };
}

/** Largest complex difference between two S-matrices over the band, over the columns both measured. */
export function maxDeltaS(a: ScatteringResult, b: ScatteringResult): number {
  if (a.fGHz.length !== b.fGHz.length) throw new Error('internal: mesh levels have different frequency grids');
  let worst = 0;
  a.re.forEach((row, i) => row.forEach((re, j) => {
    const [im, re2, im2] = [a.im[i][j], b.re[i][j], b.im[i][j]];
    if (!re || !im || !re2 || !im2) return;
    for (let m = 0; m < re.length; m++) worst = Math.max(worst, Math.hypot(re[m] - re2[m], im[m] - im2[m]));
  }));
  return worst;
}

/** Two meshes, finer first: Roache's two-grid GCI with Fs = 3 and order 1. */
export function gciTwoMesh(h: [number, number], phi: [number, number]): GciEstimate | null {
  if (![...h, ...phi].every(Number.isFinite)) return null;
  const r = h[1] / h[0];
  if (!(r > 1)) throw new Error(`internal: mesh sizes must grow, got ${h.join(', ')}`);
  const change = phi[1] - phi[0];
  return {
    value: phi[0], extrapolated: phi[0] - change / (r - 1), order: TWO_LEVEL_ORDER, observedOrder: null,
    uncertainty: (SAFETY_OUT_OF_RANGE * Math.abs(change)) / (r ** TWO_LEVEL_ORDER - 1), behaviour: 'two-level',
  };
}

/**
 * Three meshes, finest first: phi[0] on h[0] < h[1] < h[2]. Absolute band in
 * the unit of phi. Null for a non-finite input.
 */
export function gciThreeMesh(h: [number, number, number], phi: [number, number, number]): GciEstimate | null {
  if (![...h, ...phi].every(Number.isFinite)) return null;
  const [h1, h2, h3] = h;
  const [p1, p2, p3] = phi;
  if (!(h1 < h2 && h2 < h3)) throw new Error(`internal: mesh sizes must grow, got ${h.join(', ')}`);
  const e21 = p2 - p1, e32 = p3 - p2;
  const tiny = 1e-12 * Math.max(Math.abs(p1), Math.abs(p2), Math.abs(p3), 1e-300);
  if (Math.abs(e21) <= tiny && Math.abs(e32) <= tiny) {
    return { value: p1, extrapolated: p1, order: null, observedOrder: null, uncertainty: 0, behaviour: 'unchanged' };
  }
  const unproven = (behaviour: Behaviour): GciEstimate => ({
    value: p1, extrapolated: null, order: null, observedOrder: null, behaviour,
    uncertainty: SAFETY_OUT_OF_RANGE * Math.max(Math.abs(e21), Math.abs(p3 - p1)),
  });
  const r21 = h2 / h1, r32 = h3 / h2;
  if (Math.abs(e21) <= tiny) {
    // The finest two agree by coincidence (curves crossing): no order can be read. Assume the
    // formal 2, the least that makes the floor below non-zero, with the unproven-order Fs.
    const rp = r21 ** MAX_ORDER;
    const predicted = (Math.abs(e32) * (rp - 1)) / (rp * (r32 ** MAX_ORDER - 1));
    return {
      value: p1, extrapolated: null, order: MAX_ORDER, observedOrder: null, behaviour: 'high-order',
      uncertainty: (SAFETY_OUT_OF_RANGE * predicted) / (rp - 1),
    };
  }
  let observed: number;
  {
    const R = e21 / e32;
    if (R < 0) return unproven('oscillatory');
    if (!(R < 1)) return unproven('divergent');
    const s = Math.sign(e32 / e21);
    const lnRatio = Math.log(Math.abs(e32 / e21));
    observed = Math.abs(lnRatio) / Math.log(r21);
    for (let n = 0; n < 200; n++) {
      const next = Math.abs(lnRatio + Math.log((r21 ** observed - s) / (r32 ** observed - s))) / Math.log(r21);
      if (!Number.isFinite(next)) break;
      const done = Math.abs(next - observed) < 1e-10;
      observed = next;
      if (done) break;
    }
    if (!Number.isFinite(observed)) return unproven('divergent');
  }
  // The fixed-point iteration ends near, not on, an exact order of 2.
  const inRange = observed >= MIN_ORDER - 1e-6 && observed <= MAX_ORDER + 1e-6;
  const order = Math.min(MAX_ORDER, Math.max(MIN_ORDER, observed));
  const rp = r21 ** order;
  // phi = phi0 + C h^p gives e21 / e32 = (r21^p - 1) / (r21^p (r32^p - 1)): the finest change the
  // coarser one predicts, a floor so that two levels agreeing by chance cannot zero the band.
  const predicted = (Math.abs(e32) * (rp - 1)) / (rp * (r32 ** order - 1));
  const change = Math.max(Math.abs(e21), predicted);
  return {
    value: p1,
    extrapolated: (rp * p1 - p2) / (rp - 1),
    order,
    observedOrder: observed,
    uncertainty: ((inRange ? SAFETY_IN_RANGE : SAFETY_OUT_OF_RANGE) * change) / (rp - 1),
    behaviour: inRange ? 'monotone' : observed < MIN_ORDER ? 'low-order' : 'high-order',
  };
}

function levelOf(solve: LevelSolve, scale: number, previous: LevelSolve | null, nearGhz: number | undefined): MeshLevel {
  const dip = solve.s.re.length === 1 ? s11Minimum(solve.s, nearGhz) : null;
  return {
    scale,
    cells: solve.cells,
    hMm: solve.hMm,
    fResGhz: dip?.fGhz ?? null,
    s11Min: dip?.magnitude ?? null,
    deltaS: previous ? maxDeltaS(solve.s, previous.s) : null,
  };
}

/** The band of one quantity over the finest two or three levels; null when any of them lacks it. */
function estimate(levels: MeshLevel[], pick: (l: MeshLevel) => number | null): GciEstimate | null {
  const last = levels.slice(-3).reverse();
  const values = last.map(pick);
  if (values.some((v) => v === null)) return null;
  const h = last.map((l) => l.hMm);
  return last.length === 3
    ? gciThreeMesh(h as [number, number, number], values as [number, number, number])
    : gciTwoMesh(h as [number, number], values as [number, number]);
}

export interface ConvergenceOptions {
  mode: 'check' | 'refine';
  ratio?: number;
  /** Delta S at or below which the last pass counts as settled. */
  tolerance?: number;
  /** "refine" only: passes finer than the project's mesh. */
  maxRefinements?: number;
}

/** Whether the pass that produced `level` moved S and the resonance little enough to stop. */
function settled(level: MeshLevel, previous: MeshLevel, tolerance: number): boolean {
  const resonanceStill = level.fResGhz === null || previous.fResGhz === null
    || Math.abs(level.fResGhz - previous.fResGhz) <= RESONANCE_TOLERANCE * level.fResGhz;
  return level.deltaS! <= tolerance && resonanceStill;
}

/**
 * Solve `json` on finer levels than `baseline`, the project's own mesh,
 * already solved (the caller's main result). Throws when the first finer
 * mesh fails or is no different from the project's on the board. A later
 * finer mesh that fails ends the refining, and the finest that solved is
 * the result.
 */
export async function meshConvergence(json: Record<string, any>, baseline: LevelSolve, solveLevel: SolveLevel, options: ConvergenceOptions): Promise<{ report: ConvergenceReport; finest: LevelSolve }> {
  const ratio = options.ratio ?? DEFAULT_RATIO;
  const tolerance = options.tolerance ?? DEFAULT_DELTA_S;
  if (!(ratio > 1)) throw new Error(`refinement ratio must be above 1, got ${ratio}`);
  const passes = options.mode === 'check' ? 1 : options.maxRefinements ?? DEFAULT_MAX_REFINEMENTS;
  const solves: Array<{ scale: number; solve: LevelSolve }> = [{ scale: 1, solve: baseline }];
  let refineStopped: string | null = null;
  for (let pass = 1; pass <= passes; pass++) {
    const scale = ratio ** -pass;
    try {
      solves.push({ scale, solve: await solveLevel(scaledMeshJson(json, scale), scale) });
    } catch (e) {
      if (pass === 1) throw e;
      refineStopped = `the mesh with cells x${scale.toFixed(3)} failed: ${(e as Error).message}`;
      break;
    }
    const n = solves.length - 1;
    if (!(solves[n - 1].solve.hMm >= MIN_H_RATIO * solves[n].solve.hMm)) {
      if (pass > 1) {
        solves.pop();
        refineStopped = `the mesh with cells x${scale.toFixed(3)} is nearly the same on the board as the one before, so refining cannot go further`;
        break;
      }
      throw new Error(`the mesh with cells x${scale.toFixed(3)} is nearly the same on the board as the one before ` +
        `(${solves[n - 1].solve.hMm.toPrecision(3)} and ${solves[n].solve.hMm.toPrecision(3)} mm per cell), so it cannot show convergence`);
    }
  }
  const finest = solves[solves.length - 1].solve;
  const nearGhz = finest.s.re.length === 1 ? s11Minimum(finest.s)?.fGhz : undefined;
  const levels = solves.map(({ scale, solve }, n) => levelOf(solve, scale, n > 0 ? solves[n - 1].solve : null, nearGhz));
  const finestLevel = levels[levels.length - 1];
  return {
    report: {
      mode: options.mode,
      ratio,
      tolerance,
      levels,
      converged: settled(finestLevel, levels[levels.length - 2], tolerance),
      fResGhz: estimate(levels, (l) => l.fResGhz),
      s11Min: estimate(levels, (l) => l.s11Min),
      refineStopped,
    },
    finest,
  };
}
