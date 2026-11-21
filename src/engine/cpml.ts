import { EPS0 } from './config';
import { cellWidth, dualWidth, smallestCell, uniformLines, type MeshLines } from './mesh';
import type { GridConfig } from './types';

/**
 * Convolutional PML (Roden & Gedney 2000; Taflove & Hagness ch. 7) for the
 * normalised Yee update in fdtd_cpu.ts and the WGSL kernels.
 *
 * Each spatial derivative d/du inside a PML slab is replaced by
 *   (1/kappa_u) d/du + psi_u,   psi_u <- b_u psi_u + c_u d/du
 * with b = exp(-(sigma/kappa + alpha) dt/eps0) and
 *      c = sigma / (sigma kappa + kappa^2 alpha) (b - 1).
 * Only the ratio sigma/(sigma kappa + kappa^2 alpha) and the products
 * sigma dt/eps0, alpha dt/eps0 enter, so everything here is dimensionless and
 * the same coefficients serve E and H (the matched magnetic loss
 * sigma_m / mu0 = sigma / eps0 makes the H recursion identical in form).
 *
 * Geometry of the box, in cell units along one axis of n cells:
 *   - E tangential to the axis sits on integer nodes 0..n-1, H on i + 1/2.
 *   - The high outer wall is PEC at u = n (neighbours past the box read 0).
 *   - The low outer wall is PMC at u = -1/2 (H at index -1 reads 0).
 * A PML of L cells fills [-1/2, L - 1/2] on the low side and [n - L, n] on
 * the high side, graded from 0 at its inner face to the maximum at the wall.
 *
 * Auxiliary fields psi live only in the slabs: per axis, the first `low` and
 * the last `high` node layers. That makes the memory grow with the box surface,
 * not its volume, and it is the layout the GPU kernels use too.
 *
 * Graded meshes (mesh.ts): every spatial difference is also scaled by
 * dRef / width, where dRef is the smallest cell and width is the cell (for H)
 * or dual cell (for E) the difference spans. That factor is folded into the
 * same per-node arrays as 1/kappa (eDiffScale, hDiffScale) and into c, and the
 * normalised sigma uses the local width. On a uniform mesh the factor is
 * exactly 1.
 */

/** PML thickness in cells on each face. 0 means the bare wall (PEC high, PMC low). */
export interface PmlFaces {
  xLow: number;
  xHigh: number;
  yLow: number;
  yHigh: number;
  zLow: number;
  zHigh: number;
}

/**
 * Grading parameters. Defaults picked from a sweep on the TEM line of
 * scripts/validate/tem_line.ts (order 2-4, sigma 0.5-1.5x, alpha 0-0.2 S/m):
 * about -84 dB across 4.5-7.5 GHz with 8 cells. The thickness sweep is in
 * docs/validation/data/analytic.json (line.pml).
 */
export interface CpmlGrading {
  /** Polynomial order of the sigma and kappa grading. */
  order: number;
  /** sigma_max as a multiple of the optimum 0.8 (m + 1) / (eta0 dx). */
  sigmaScale: number;
  /** Maximum coordinate stretch (1 = none). Helps with evanescent near fields. */
  kappaMax: number;
  /** alpha at the inner face, in S/m. Lifts low-frequency absorption; graded linearly to 0 at the wall. */
  alphaMaxSPerM: number;
}

export const DEFAULT_CPML_GRADING: CpmlGrading = { order: 3, sigmaScale: 1, kappaMax: 1, alphaMaxSPerM: 0.05 };

/** Coefficients along one axis, one entry per node index 0..n-1. */
export interface AxisCpml {
  n: number;
  low: number;
  high: number;
  /**
   * At E positions (u = i): b, c, and the factor every difference along this
   * axis is multiplied by, (1/kappa) * dRef / dual width. Outside the PML
   * b = c = 0 and kappa = 1.
   */
  eB: Float32Array;
  eC: Float32Array;
  eDiffScale: Float32Array;
  /** At H positions (u = i + 1/2); the width there is the cell width. */
  hB: Float32Array;
  hC: Float32Array;
  hDiffScale: Float32Array;
}

export interface Cpml {
  x: AxisCpml;
  y: AxisCpml;
  z: AxisCpml;
  faces: PmlFaces;
}


export function uniformFaces(cells: number): PmlFaces {
  return { xLow: cells, xHigh: cells, yLow: cells, yHigh: cells, zLow: cells, zHigh: cells };
}

function axisCpml(lines: Float64Array, low: number, high: number, dRefMm: number, grid: GridConfig, grading: CpmlGrading): AxisCpml {
  const n = lines.length;
  if (!Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high < 0) {
    throw new Error(`PML thickness must be a non-negative integer, got ${low} and ${high}`);
  }
  if (low + high > n - 2) throw new Error(`PML of ${low} + ${high} cells does not fit in ${n} cells`);
  const { order: m, sigmaScale, kappaMax, alphaMaxSPerM } = grading;
  const dtOverEps0 = (grid.courant * dRefMm * 1e-3) / 299_792_458 / EPS0;
  // Normalised sigma_opt dt / eps0 = 0.8 (m + 1) c dt / width, because eta0 c0 eps0 = 1;
  // c dt = Sc dRef, so the local value is 0.8 (m + 1) Sc dRef / width.
  const sigmaMaxAtRef = sigmaScale * 0.8 * (m + 1) * grid.courant;
  const alphaMax = alphaMaxSPerM * dtOverEps0;

  /** Depth into the PML at position u (in node units), 0 at the inner face, 1 at the wall. */
  const depth = (u: number): number => {
    const intoLow = low > 0 ? (low - 0.5 - u) / low : 0;
    const intoHigh = high > 0 ? (u - (n - high)) / high : 0;
    return Math.min(1, Math.max(0, intoLow, intoHigh));
  };
  /** b, c and the difference scale at position u, where a difference spans `widthMm`. */
  const coefficients = (u: number, widthMm: number): [b: number, c: number, diffScale: number] => {
    const meshScale = dRefMm / widthMm;
    const rho = depth(u);
    if (rho === 0) return [0, 0, meshScale];
    const sigma = sigmaMaxAtRef * meshScale * rho ** m;
    const kappa = 1 + (kappaMax - 1) * rho ** m;
    const alpha = alphaMax * (1 - rho);
    const b = Math.exp(-(sigma / kappa + alpha));
    const c = (sigma / (sigma * kappa + kappa * kappa * alpha)) * (b - 1);
    return [b, c * meshScale, meshScale / kappa];
  };

  const ax: AxisCpml = {
    n, low, high,
    eB: new Float32Array(n), eC: new Float32Array(n), eDiffScale: new Float32Array(n),
    hB: new Float32Array(n), hC: new Float32Array(n), hDiffScale: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    [ax.eB[i], ax.eC[i], ax.eDiffScale[i]] = coefficients(i, dualWidth(lines, i));
    [ax.hB[i], ax.hC[i], ax.hDiffScale[i]] = coefficients(i + 0.5, cellWidth(lines, i));
  }
  return ax;
}

/** The uniform cubic mesh of a grid: node i at i * dxMm. */
export function gridMesh(grid: GridConfig): MeshLines {
  return { x: uniformLines(grid.nx, 0, grid.dxMm), y: uniformLines(grid.ny, 0, grid.dxMm), z: uniformLines(grid.nz, 0, grid.dxMm) };
}

/**
 * CPML and mesh-difference coefficients for every axis. `mesh` defaults to the
 * grid's uniform cubic mesh; a graded mesh must have grid.dxMm equal to its
 * smallest cell, because the time step and the normalised units are tied to it.
 */
export function buildCpml(
  grid: GridConfig,
  faces: PmlFaces = uniformFaces(grid.pmlCells),
  grading = DEFAULT_CPML_GRADING,
  mesh: MeshLines = gridMesh(grid),
): Cpml {
  if (mesh.x.length !== grid.nx || mesh.y.length !== grid.ny || mesh.z.length !== grid.nz) {
    throw new Error(`mesh has ${mesh.x.length}x${mesh.y.length}x${mesh.z.length} nodes, grid is ${grid.nx}x${grid.ny}x${grid.nz}`);
  }
  const smallest = smallestCell(mesh);
  if (Math.abs(smallest - grid.dxMm) > 1e-9 * grid.dxMm) {
    throw new Error(`grid.dxMm ${grid.dxMm} must equal the smallest mesh cell ${smallest}`);
  }
  return {
    x: axisCpml(mesh.x, faces.xLow, faces.xHigh, grid.dxMm, grid, grading),
    y: axisCpml(mesh.y, faces.yLow, faces.yHigh, grid.dxMm, grid, grading),
    z: axisCpml(mesh.z, faces.zLow, faces.zHigh, grid.dxMm, grid, grading),
    faces,
  };
}

/** Slab layer index of node i along an axis, or -1 outside both slabs. */
export function slabLayer(ax: AxisCpml, i: number): number {
  if (i < ax.low) return i;
  if (i >= ax.n - ax.high) return i - (ax.n - ax.high - ax.low);
  return -1;
}
