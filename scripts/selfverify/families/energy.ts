/**
 * Conserved-energy family: a random board in a closed PEC box with lossless
 * materials, on a random graded mesh, started from random fields and left to
 * run with no source. Leapfrog conserves exactly (in exact arithmetic)
 *   W^n = sum_E eps w_E (e^n)^2 + sum_H w_H h^(n-1/2) h^(n+1/2),
 * with w the volume each edge stands for, provided the discrete curl that
 * updates E is the transpose of the one that updates H under those weights.
 * A graded-mesh scale factor or a PEC edge applied on one side and not the
 * other breaks that symmetry, and an unstable update blows W up.
 *
 * The weights come from the mesh lines, so a wrong difference scale shows.
 * The permittivity of each edge still comes from the solver's own update
 * coefficient (eps = Sc / eCurl), so a wrong material average conserves
 * energy and passes, as do errors that keep the operator symmetric, such as
 * copper drawn half a cell too wide. The closed-form families cover those.
 */
import { CpuFdtd } from '../../../src/engine/fdtd_cpu';
import { cellWidth, dualWidth } from '../../../src/engine/mesh';
import { rasterise } from '../../../src/project/rasterise';
import { toProject } from '../board_spec';
import { compare, type Check } from '../measure';
import type { Rng } from '../rng';
import { energyDriftTolerance } from '../tolerances';
import { randomBoard } from './random_board';

const FAMILY = 'conserved-energy';

export function runEnergy(rng: Rng, tier: 'quick' | 'full'): Check[] {
  const cases = tier === 'quick' ? 2 : 6;
  const steps = tier === 'quick' ? 2000 : 6000;
  const checks: Check[] = [];
  for (let c = 0; c < cases; c++) {
    const r = rng.fork(`case${c}`);
    const spec = randomBoard(r, `energy-${c}`, { boundary: 'pec', lossy: false, layers: c % 2 === 0 ? 1 : 2 });
    const { model } = rasterise(toProject(spec));
    const sim = new CpuFdtd(model);
    const { nx, ny, nz, courant: Sc } = model.grid;
    const N = sim.N;
    const { eDecay, eCurl, mesh } = model;
    const dRef = model.grid.dxMm;
    // Random fields on every free E edge; PEC and port edges (eCurl 0) stay 0 and are not updated.
    for (let m = 0; m < 3 * N; m++) sim.e[m] = eCurl[m] === 0 ? 0 : r.uniform(-1, 1);
    // Volume weights in units of the smallest cell, from the mesh lines themselves (float64), not from
    // the solver's difference scales: a wrong scale factor then breaks the symmetry this test checks.
    const weightsE = new Float64Array(3 * N);
    const weightsH = new Float64Array(3 * N);
    let cell = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, cell++) {
      const [cx, dx] = [cellWidth(mesh.x, i) / dRef, dualWidth(mesh.x, i) / dRef];
      const [cy, dy] = [cellWidth(mesh.y, j) / dRef, dualWidth(mesh.y, j) / dRef];
      const [cz, dz] = [cellWidth(mesh.z, k) / dRef, dualWidth(mesh.z, k) / dRef];
      const eps = (m: number) => (eCurl[m] === 0 ? 0 : (Sc * (1 + eDecay[m])) / (2 * eCurl[m]));
      weightsE[cell] = eps(cell) * cx * dy * dz;
      weightsE[N + cell] = eps(N + cell) * dx * cy * dz;
      weightsE[2 * N + cell] = eps(2 * N + cell) * dx * dy * cz;
      weightsH[cell] = dx * cy * cz;
      weightsH[N + cell] = cx * dy * cz;
      weightsH[2 * N + cell] = cx * cy * dz;
    }
    let initial = NaN;
    let worst = 0;
    for (let n = 0; n < steps; n++) {
      const hBefore = Float64Array.from(sim.h);
      sim.updateH();
      let w = 0;
      for (let m = 0; m < 3 * N; m++) w += weightsE[m] * sim.e[m] * sim.e[m] + weightsH[m] * hBefore[m] * sim.h[m];
      if (n === 0) initial = w;
      worst = Math.max(worst, Math.abs(w / initial - 1));
      sim.updateE();
    }
    checks.push(compare({
      family: FAMILY,
      case: `${spec.name}: ${nx}x${ny}x${nz} graded cells, ${spec.stackup.filter((l) => l.type === 'dielectric').length} dielectric layer(s)`,
      check: 'drift of the conserved discrete energy',
      measured: worst, expected: 0, tolerance: energyDriftTolerance(steps),
      note: `largest |W^n / W^0 - 1| over ${steps} steps from random fields; float32 random-walk bound`,
    }));
  }
  return checks;
}
