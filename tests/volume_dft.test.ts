import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCITATION, timestepSec } from '../src/engine/config';
import { CpuFdtd, type StepRecorder } from '../src/engine/fdtd_cpu';
import { PLANE_DFT_COMPONENTS, PlaneDftRecorder, planeDftIndex } from '../src/engine/plane_dft';
import { VolumeDftRecorder, volumeDftBytes, volumeDftIndex, volumeDftLength } from '../src/engine/volume_dft';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

describe('volume DFT recorder', () => {
  const { model } = rasterise(parseProject(smallProjectJson()));
  const grid = model.grid;
  const dt = timestepSec(grid);
  const control = { maxSteps: 300, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const frequenciesHz = [9e9, 12e9];

  it('matches the plane DFT on the components both record, and records Hz the same way', () => {
    const port = model.ports[0];
    const planesK = [port.k0, port.k1 + 1];
    const planes = new PlaneDftRecorder(grid, planesK, frequenciesHz, dt);
    const volume = new VolumeDftRecorder(grid, frequenciesHz, dt);
    // Hz just outside the patch edge next to the port, by hand.
    const [i, j, k] = [port.i, port.j - 1, port.k1 + 1];
    const N = grid.nx * grid.ny * grid.nz;
    const hzCell = 2 * N + i + grid.nx * (j + grid.ny * k);
    const hzHistory: number[] = [];
    const all: StepRecorder = {
      afterStep(n, sim) {
        planes.afterStep(n, sim);
        volume.afterStep(n, sim);
        hzHistory.push(sim.h[hzCell]);
      },
    };
    new CpuFdtd(model).run(DEFAULT_EXCITATION, control, all);

    const layout = { nx: grid.nx, ny: grid.ny, nz: grid.nz, frequencies: frequenciesHz.length };
    expect(volume.accumulators.length).toBe(volumeDftLength(layout));
    expect(volumeDftBytes(grid, 2)).toBe(4 * volume.accumulators.length);
    const planeLayout = { nx: grid.nx, ny: grid.ny, planesK, frequenciesHz };
    let worst = 0;
    let largest = 0;
    planesK.forEach((pk, plane) => frequenciesHz.forEach((_, f) => {
      for (const component of PLANE_DFT_COMPONENTS) {
        for (let jj = 0; jj < grid.ny; jj++) for (let ii = 0; ii < grid.nx; ii++) {
          const a = planeDftIndex(planeLayout, plane, f, component, ii, jj);
          const b = volumeDftIndex(layout, f, component, ii, jj, pk);
          for (const part of [0, 1]) {
            largest = Math.max(largest, Math.abs(planes.accumulators[a + part]));
            worst = Math.max(worst, Math.abs(planes.accumulators[a + part] - volume.accumulators[b + part]));
          }
        }
      }
    }));
    expect(largest).toBeGreaterThan(0);
    // float32 sums against float64 sums of the same samples.
    expect(worst / largest).toBeLessThan(1e-5);

    const f = 1;
    let re = 0, im = 0;
    hzHistory.forEach((v, step) => {
      const phase = 2 * Math.PI * frequenciesHz[f] * dt * (step + 0.5);
      re += v * Math.cos(phase);
      im -= v * Math.sin(phase);
    });
    const at = volumeDftIndex(layout, f, 'hz', i, j, k);
    expect(Math.hypot(re, im)).toBeGreaterThan(0);
    expect(volume.accumulators[at]).toBeCloseTo(re, 4);
    expect(volume.accumulators[at + 1]).toBeCloseTo(im, 4);
  });

  it('does not change the run it watches', () => {
    const plain = new CpuFdtd(model).run(DEFAULT_EXCITATION, control);
    const watched = new CpuFdtd(model).run(DEFAULT_EXCITATION, control, new VolumeDftRecorder(grid, frequenciesHz, dt));
    expect(Array.from(watched.v)).toEqual(Array.from(plain.v));
    expect(Array.from(watched.i)).toEqual(Array.from(plain.i));
  });

  it('rejects no frequencies and non-positive ones', () => {
    expect(() => new VolumeDftRecorder(grid, [], dt)).toThrow(/no frequencies/);
    expect(() => new VolumeDftRecorder(grid, [0], dt)).toThrow(/not positive/);
  });
});
