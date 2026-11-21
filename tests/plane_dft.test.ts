import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCITATION, timestepSec } from '../src/engine/config';
import { CpuFdtd, type StepRecorder } from '../src/engine/fdtd_cpu';
import { PlaneDftRecorder, planeDftIndex, planeDftLength, type PlaneDftComponent } from '../src/engine/plane_dft';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

describe('plane DFT recorder', () => {
  const { model } = rasterise(parseProject(smallProjectJson()));
  const grid = model.grid;
  const dt = timestepSec(grid);

  it('each value is the DFT of that Yee component at that node, E at (n+1) dt and H at (n+1/2) dt', () => {
    const port = model.ports[0];
    // Air one cell above the top copper, and the substrate plane of the port.
    const planesK = [port.k1 + 1, port.k0];
    const frequenciesHz = [9e9, 12e9];
    const planes = new PlaneDftRecorder(grid, planesK, frequenciesHz, dt);
    // Just outside the patch edge next to the port, where every component is non-zero.
    const [i, j] = [port.i, port.j - 1];
    const N = grid.nx * grid.ny * grid.nz;
    const probes: Array<{ component: PlaneDftComponent; offset: number; field: 'e' | 'h'; half: number }> = [
      { component: 'ex', offset: 0, field: 'e', half: 1 },
      { component: 'ez', offset: 2 * N, field: 'e', half: 1 },
      { component: 'hy', offset: N, field: 'h', half: 0.5 },
    ];
    const histories = probes.map(() => [] as number[]);
    const plane = 0;
    const cell = i + grid.nx * (j + grid.ny * planesK[plane]);
    const probe: StepRecorder = {
      afterStep(_, sim) {
        probes.forEach((p, n) => histories[n].push((p.field === 'e' ? sim.e : sim.h)[p.offset + cell]));
      },
    };
    const both: StepRecorder = { afterStep: (n, sim) => { planes.afterStep(n, sim); probe.afterStep(n, sim); } };
    new CpuFdtd(model).run(DEFAULT_EXCITATION, { maxSteps: 300, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 }, both);
    const layout = { nx: grid.nx, ny: grid.ny, planesK, frequenciesHz };
    expect(planes.accumulators.length).toBe(planeDftLength(layout));
    probes.forEach((p, n) => {
      const f = 1;
      let re = 0, im = 0;
      histories[n].forEach((v, step) => {
        const phase = 2 * Math.PI * frequenciesHz[f] * dt * (step + p.half);
        re += v * Math.cos(phase);
        im -= v * Math.sin(phase);
      });
      const at = planeDftIndex(layout, plane, f, p.component, i, j);
      expect(Math.hypot(re, im)).toBeGreaterThan(0);
      expect(planes.accumulators[at]).toBeCloseTo(re, 9);
      expect(planes.accumulators[at + 1]).toBeCloseTo(im, 9);
    });
  });

  it('rejects planes outside the grid, repeated planes and no frequencies', () => {
    expect(() => new PlaneDftRecorder(grid, [grid.nz], [1e9], dt)).toThrow(/outside/);
    expect(() => new PlaneDftRecorder(grid, [2, 2], [1e9], dt)).toThrow(/repeat/);
    expect(() => new PlaneDftRecorder(grid, [2], [], dt)).toThrow(/no frequencies/);
    expect(() => new PlaneDftRecorder(grid, [], [1e9], dt)).toThrow(/no planes/);
  });
});
