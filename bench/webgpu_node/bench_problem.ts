/**
 * The kernel benchmark problem, shared by every implementation (WGSL here,
 * CUDA in bench/cuda/fdtd_bench.cu, which builds the identical problem with
 * the same integer hash and formulas, so checksums can be compared).
 *
 * Bulk Yee update only: no CPML slabs and no port, but the 1/kappa lookups the
 * bulk kernels always do are graded (not all 1), so a kernel that skipped them
 * would fail the correctness check. Materials are random per edge: lossy
 * (eDecay < 1) with eps_r in [1, 4), which keeps the run stable.
 * Initial state: e uniform in [-1, 1) per edge, h = 0.
 */
import { DEFAULT_GRID } from '../../src/engine/config';
import { uniformFaces } from '../../src/engine/cpml';
import { vacuumModel } from '../../src/engine/fdtd_cpu';
import type { GridConfig } from '../../src/engine/types';
import type { VoxelModel } from '../../src/engine/voxelize';

export const BENCH_GRID_SIZES: Array<[number, number, number]> = [
  [64, 64, 48],
  [128, 128, 96],
  [256, 256, 192],
];

export const CORRECTNESS_STEPS = 200;

/** Graded 1/kappa region at each end of every axis, in cells (mimics a CPML's kappa grading). */
const KAPPA_RAMP_CELLS = 8;

const HASH_STREAM_E_DECAY = 1;
const HASH_STREAM_E_CURL = 2;
const HASH_STREAM_INITIAL_E = 3;

/** Uniform in [0, 1) from (index, stream); 24-bit result, so it is exact in float32. Same as fdtd_bench.cu. */
export function hashUniform(index: number, stream: number): number {
  let x = (Math.imul(index, 0x9e3779b1) + Math.imul(stream, 0x85ebca77)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 8) / 16777216;
}

export function benchGrid(nx: number, ny: number, nz: number): GridConfig {
  // pmlCells 0: no CPML slabs, so Fdtd3D schedules no CPML passes. groundK is unused: the bench model is built directly, not voxelized.
  return { ...DEFAULT_GRID, nx, ny, nz, pmlCells: 0, groundK: 1 };
}

/** 1/kappa at position x along an axis of n nodes: 1 in the middle, graded down to 1/3 at both ends. */
export function benchDiffScale(x: number, n: number): number {
  const depth = Math.min(1, Math.max(0, (KAPPA_RAMP_CELLS - Math.min(x, n - 1 - x)) / KAPPA_RAMP_CELLS));
  return 1 / (1 + 2 * depth * depth * depth);
}

export function benchModel(grid: GridConfig): VoxelModel {
  const model = vacuumModel(grid, uniformFaces(0));
  for (let edge = 0; edge < model.eDecay.length; edge++) {
    model.eDecay[edge] = 1 - 0.01 * hashUniform(edge, HASH_STREAM_E_DECAY);
    model.eCurl[edge] = grid.courant / (1 + 3 * hashUniform(edge, HASH_STREAM_E_CURL));
  }
  // E sits on integer nodes, H half a cell further along each axis (see cpml.ts).
  for (const axis of [model.cpml.x, model.cpml.y, model.cpml.z]) {
    for (let u = 0; u < axis.n; u++) {
      axis.eDiffScale[u] = benchDiffScale(u, axis.n);
      axis.hDiffScale[u] = benchDiffScale(u + 0.5, axis.n);
    }
  }
  return model;
}

export function benchInitialE(cells: number): Float32Array {
  const e = new Float32Array(3 * cells);
  for (let edge = 0; edge < e.length; edge++) e[edge] = 2 * hashUniform(edge, HASH_STREAM_INITIAL_E) - 1;
  return e;
}

/** max |actual - reference| / max |reference|, the measure the browser self-test uses. */
export function maxRelativeDifference(actual: Float32Array, reference: Float32Array): number {
  if (actual.length !== reference.length) throw new Error(`length mismatch ${actual.length} vs ${reference.length}`);
  let maxDiff = 0;
  let maxRef = 0;
  for (let n = 0; n < reference.length; n++) {
    if (!Number.isFinite(actual[n])) return Infinity;
    maxDiff = Math.max(maxDiff, Math.abs(actual[n] - reference[n]));
    maxRef = Math.max(maxRef, Math.abs(reference[n]));
  }
  return maxDiff / maxRef;
}

/** Sum of e, in double: a cheap cross-implementation checksum of the same state. */
export function checksum(values: Float32Array): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum;
}
