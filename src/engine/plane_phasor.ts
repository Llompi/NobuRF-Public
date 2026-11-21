import type { CpuFdtd, StepRecorder } from './fdtd_cpu';
import type { GridConfig } from './types';

/**
 * Running DFT of Ey and Ez on the plane x = node i, at one frequency: the
 * steady-state field on a cut through the feed, for figures. E is sampled at
 * (n + 1) dt after step n. Values are the normalised e = E * dRef (volts per
 * smallest cell); divide by dRef for V/m.
 */
export class PlanePhasorRecorder implements StepRecorder {
  readonly eyRe: Float64Array;
  readonly eyIm: Float64Array;
  readonly ezRe: Float64Array;
  readonly ezIm: Float64Array;

  constructor(grid: GridConfig, readonly i: number, readonly frequencyHz: number, private readonly dtSec: number) {
    const { ny, nz } = grid;
    [this.eyRe, this.eyIm, this.ezRe, this.ezIm] = [0, 0, 0, 0].map(() => new Float64Array(ny * nz));
  }

  afterStep(stepIndex: number, sim: CpuFdtd): void {
    const { nx, ny, nz } = sim.model.grid;
    const N = nx * ny * nz;
    const phase = 2 * Math.PI * this.frequencyHz * this.dtSec * (stepIndex + 1);
    const [c, s] = [Math.cos(phase), -Math.sin(phase)];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const cell = this.i + nx * (j + ny * k);
      const p = j + ny * k;
      const ey = sim.e[N + cell];
      const ez = sim.e[2 * N + cell];
      this.eyRe[p] += ey * c;
      this.eyIm[p] += ey * s;
      this.ezRe[p] += ez * c;
      this.ezIm[p] += ez * s;
    }
  }
}
