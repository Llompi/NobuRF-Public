import type { CpuFdtd, StepRecorder } from './fdtd_cpu';
import type { GridConfig } from './types';

/**
 * Running DFT of the fields on whole z planes, for field and surface-current
 * plots. Shared by PlaneDftRecorder (CPU) and the plane_dft.wgsl kernel (GPU),
 * which fill the same layout.
 *
 * Values are the raw Yee components of the normalised fields (e = E*dRef,
 * h = eta0*H*dRef, see fdtd_cpu.ts) at node (i, j) of plane k, without any
 * averaging to a common point:
 *   Ex at (i+1/2, j,     k)      Hx at (i,     j+1/2, k+1/2)
 *   Ey at (i,     j+1/2, k)      Hy at (i+1/2, j,     k+1/2)
 *   Ez at (i,     j,     k+1/2)
 * So for a copper sheet on plane k, H just above it is plane k and H just
 * below it is plane k - 1. E is sampled at (n + 1) dt and H at (n + 1/2) dt
 * after step n, and each sum is the plain sum over steps of value * e^{-j w t},
 * the same convention as the Huygens-box DFT (huygens_box.ts).
 */
export const PLANE_DFT_COMPONENTS = ['ex', 'ey', 'ez', 'hx', 'hy'] as const;
export type PlaneDftComponent = (typeof PLANE_DFT_COMPONENTS)[number];

/** Offsets of each component in the packed e and h arrays, in units of N. */
const COMPONENT_SOURCE: Record<PlaneDftComponent, { field: 'e' | 'h'; block: number }> = {
  ex: { field: 'e', block: 0 }, ey: { field: 'e', block: 1 }, ez: { field: 'e', block: 2 },
  hx: { field: 'h', block: 0 }, hy: { field: 'h', block: 1 },
};

export interface PlaneDftLayout {
  nx: number;
  ny: number;
  planesK: readonly number[];
  frequenciesHz: readonly number[];
}

/**
 * Index of the real part of one value; the imaginary part follows it.
 * Order, slowest first: plane, frequency, component, j, i.
 */
export function planeDftIndex(layout: PlaneDftLayout, plane: number, frequency: number, component: PlaneDftComponent, i: number, j: number): number {
  const c = PLANE_DFT_COMPONENTS.indexOf(component);
  const block = (plane * layout.frequenciesHz.length + frequency) * PLANE_DFT_COMPONENTS.length + c;
  return 2 * (block * layout.nx * layout.ny + i + layout.nx * j);
}

export function planeDftLength(layout: PlaneDftLayout): number {
  return 2 * layout.planesK.length * layout.frequenciesHz.length * PLANE_DFT_COMPONENTS.length * layout.nx * layout.ny;
}

/** Throws unless the planes are distinct z node indices of the grid and there is at least one frequency. */
export function assertPlaneDftRequest(grid: GridConfig, planesK: readonly number[], frequenciesHz: readonly number[]): void {
  if (planesK.length === 0) throw new Error('plane DFT: no planes');
  if (frequenciesHz.length === 0) throw new Error('plane DFT: no frequencies');
  for (const k of planesK) {
    if (!Number.isInteger(k) || k < 0 || k >= grid.nz) throw new Error(`plane DFT: plane k = ${k} is outside 0..${grid.nz - 1}`);
  }
  if (new Set(planesK).size !== planesK.length) throw new Error(`plane DFT: planes repeat in [${planesK.join(', ')}]`);
  for (const f of frequenciesHz) if (!(f > 0)) throw new Error(`plane DFT: frequency ${f} Hz is not positive`);
}

/** CPU counterpart of Fdtd3D.enablePlaneDft, for CpuFdtd.run. */
export class PlaneDftRecorder implements StepRecorder {
  readonly accumulators: Float64Array;
  private readonly layout: PlaneDftLayout;
  private readonly omegaDt: Float64Array;

  constructor(grid: GridConfig, planesK: readonly number[], frequenciesHz: readonly number[], dtSec: number) {
    assertPlaneDftRequest(grid, planesK, frequenciesHz);
    this.layout = { nx: grid.nx, ny: grid.ny, planesK, frequenciesHz };
    this.accumulators = new Float64Array(planeDftLength(this.layout));
    this.omegaDt = Float64Array.from(frequenciesHz, (f) => 2 * Math.PI * f * dtSec);
  }

  afterStep(stepIndex: number, sim: CpuFdtd): void {
    const { nx, ny, planesK } = this.layout;
    const planeSize = nx * ny;
    const N = planeSize * sim.model.grid.nz;
    planesK.forEach((k, plane) => {
      this.omegaDt.forEach((omegaDt, frequency) => {
        for (const component of PLANE_DFT_COMPONENTS) {
          const { field, block } = COMPONENT_SOURCE[component];
          const phase = omegaDt * (field === 'e' ? stepIndex + 1 : stepIndex + 0.5);
          const re = Math.cos(phase);
          const im = -Math.sin(phase);
          const values = field === 'e' ? sim.e : sim.h;
          const from = block * N + k * planeSize;
          const to = planeDftIndex(this.layout, plane, frequency, component, 0, 0);
          for (let cell = 0; cell < planeSize; cell++) {
            const v = values[from + cell];
            this.accumulators[to + 2 * cell] += v * re;
            this.accumulators[to + 2 * cell + 1] += v * im;
          }
        }
      });
    });
  }
}
