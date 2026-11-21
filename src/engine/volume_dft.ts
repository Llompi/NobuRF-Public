import type { CpuFdtd, StepRecorder } from './fdtd_cpu';
import type { GridConfig } from './types';

/**
 * Running DFT of all six field components at every Yee node of the grid, for
 * field plots on any cut through the solve box. Shared by VolumeDftRecorder
 * (CPU) and the volume_dft.wgsl kernel (GPU), which fill the same layout.
 *
 * Values are the raw Yee components of the normalised fields (e = E*dRef,
 * h = eta0*H*dRef, see fdtd_cpu.ts), each at its own staggered position in
 * cell (i, j, k), with the same sampling and sign convention as the plane DFT
 * (plane_dft.ts): E at (n + 1) dt, H at (n + 1/2) dt after step n, summed as
 * value * e^{-j w t}. Accumulators are float32 on both sides.
 *
 * Cost: 48 bytes per node per frequency, and one dispatch (GPU) or one pass
 * over the grid (CPU) per step. volumeDftBytes says how much before a run.
 */
export const VOLUME_DFT_COMPONENTS = ['ex', 'ey', 'ez', 'hx', 'hy', 'hz'] as const;
export type VolumeDftComponent = (typeof VOLUME_DFT_COMPONENTS)[number];

export interface VolumeDftLayout {
  nx: number;
  ny: number;
  nz: number;
  frequencies: number;
}

/** Index of the real part of one value; the imaginary part follows it. Order, slowest first: frequency, component, k, j, i. */
export function volumeDftIndex(layout: VolumeDftLayout, frequency: number, component: VolumeDftComponent, i: number, j: number, k: number): number {
  const c = VOLUME_DFT_COMPONENTS.indexOf(component);
  const cells = layout.nx * layout.ny * layout.nz;
  return 2 * ((frequency * VOLUME_DFT_COMPONENTS.length + c) * cells + i + layout.nx * (j + layout.ny * k));
}

export function volumeDftLength(layout: VolumeDftLayout): number {
  return 2 * VOLUME_DFT_COMPONENTS.length * layout.frequencies * layout.nx * layout.ny * layout.nz;
}

/** Accumulator bytes for `frequencies` frequencies on `grid` (float32). */
export function volumeDftBytes(grid: Pick<GridConfig, 'nx' | 'ny' | 'nz'>, frequencies: number): number {
  return 4 * volumeDftLength({ nx: grid.nx, ny: grid.ny, nz: grid.nz, frequencies });
}

export function assertVolumeDftRequest(frequenciesHz: readonly number[]): void {
  if (frequenciesHz.length === 0) throw new Error('volume DFT: no frequencies');
  for (const f of frequenciesHz) if (!(f > 0)) throw new Error(`volume DFT: frequency ${f} Hz is not positive`);
}

/** CPU counterpart of Fdtd3D.enableVolumeDft, for CpuFdtd.run. */
export class VolumeDftRecorder implements StepRecorder {
  readonly accumulators: Float32Array;
  private readonly omegaDt: Float64Array;
  private readonly cells: number;

  constructor(grid: GridConfig, frequenciesHz: readonly number[], dtSec: number) {
    assertVolumeDftRequest(frequenciesHz);
    this.cells = grid.nx * grid.ny * grid.nz;
    this.accumulators = new Float32Array(volumeDftLength({ nx: grid.nx, ny: grid.ny, nz: grid.nz, frequencies: frequenciesHz.length }));
    this.omegaDt = Float64Array.from(frequenciesHz, (f) => 2 * Math.PI * f * dtSec);
  }

  afterStep(stepIndex: number, sim: CpuFdtd): void {
    const N = this.cells;
    const acc = this.accumulators;
    this.omegaDt.forEach((omegaDt, frequency) => {
      VOLUME_DFT_COMPONENTS.forEach((_, c) => {
        const isE = c < 3;
        const phase = omegaDt * (isE ? stepIndex + 1 : stepIndex + 0.5);
        const re = Math.cos(phase);
        const im = -Math.sin(phase);
        const values = isE ? sim.e : sim.h;
        const from = (c % 3) * N;
        const to = 2 * (frequency * VOLUME_DFT_COMPONENTS.length + c) * N;
        for (let cell = 0; cell < N; cell++) {
          const v = values[from + cell];
          acc[to + 2 * cell] += v * re;
          acc[to + 2 * cell + 1] += v * im;
        }
      });
    });
  }
}
