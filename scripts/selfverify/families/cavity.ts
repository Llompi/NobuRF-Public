/**
 * PEC box family: a closed box of one dielectric on a uniform grid. Its modes
 * have an exact discrete answer, the Yee dispersion relation (closed_forms.ts),
 * so the update kernel must reproduce it to the frequency estimator's own
 * precision, for any box size, cell and permittivity.
 */
import { DEFAULT_GRID, timestepSec } from '../../../src/engine/config';
import { CpuFdtd, pecBoxModel } from '../../../src/engine/fdtd_cpu';
import type { GridConfig } from '../../../src/engine/types';
import { cavityModes, yeeCavityFrequencyHz, type CavityMode } from '../closed_forms';
import { compare, dft, hannWindow, spectralPeak, type Check } from '../measure';
import type { Rng } from '../rng';
import { MAX_NEIGHBOUR_RATIO, MIN_MODE_SEPARATION_BINS, PEAK_BIAS_BINS, roundoffError } from '../tolerances';

const FAMILY = 'pec-box';

export function runCavity(rng: Rng, tier: 'quick' | 'full'): Check[] {
  const cases = tier === 'quick' ? 2 : 6;
  const steps = tier === 'quick' ? 12000 : 24000;
  const checks: Check[] = [];
  for (let c = 0; c < cases; c++) {
    const r = rng.fork(`case${c}`);
    const cells: [number, number, number] = [r.integer(10, 26), r.integer(10, 26), r.integer(10, 26)];
    const dxMm = r.uniform(0.3, 1);
    const epsR = r.uniform(1, 10);
    const grid: GridConfig = { ...DEFAULT_GRID, nx: cells[0], ny: cells[1], nz: cells[2], dxMm, pmlCells: 0, groundK: 1 };
    const dt = timestepSec(grid);
    const bin = 1 / (steps * dt);
    const name = `box ${cells.join('x')} cells of ${dxMm.toFixed(3)} mm, eps_r ${epsR.toFixed(3)}`;

    // Modes the record can resolve: separated from every other mode by MIN_MODE_SEPARATION_BINS.
    const all = cavityModes(6).map((mode) => ({ mode, f: yeeCavityFrequencyHz(mode, cells, dxMm * 1e-3, dt, epsR) })).sort((a, b) => a.f - b.f);
    const tested = all.slice(0, 8).filter(({ f }, n) => all.every((o, k) => k === n || Math.abs(o.f - f) >= MIN_MODE_SEPARATION_BINS * bin)).slice(0, 4);

    // Soft Gaussian kick on all three E components at an off-symmetry point; six probes at random points.
    const sim = new CpuFdtd(pecBoxModel(grid, epsR));
    const N = sim.N;
    const point = () => r.integer(1, cells[0] - 2) + cells[0] * (r.integer(1, cells[1] - 2) + cells[1] * r.integer(1, cells[2] - 2));
    const source = point();
    const probes = Array.from({ length: 6 }, point);
    const records = probes.map(() => new Float64Array(steps));
    const width = 3;
    for (let n = 0; n < steps; n++) {
      sim.updateH();
      sim.updateE();
      if (n < 8 * width) {
        const u = (n - 4 * width) / width;
        const a = Math.exp(-u * u);
        sim.e[source] += a;
        sim.e[N + source] += 0.7 * a;
        sim.e[2 * N + source] += 0.5 * a;
      }
      probes.forEach((p, q) => {
        records[q][n] = sim.e[p] + sim.e[N + p] + sim.e[2 * N + p] + sim.h[p] + sim.h[N + p] + sim.h[2 * N + p];
      });
    }

    const window = hannWindow(steps);
    const amplitudeAt = (rec: Float64Array, f: number) => Math.hypot(...dft(rec, dt, f, 0, window));
    for (const { mode, f } of tested) {
      const label = `TM/TE ${modeName(mode)}`;
      // The probe where this mode is strongest, and the strongest other mode there (within 30 bins).
      const best = records.map((rec) => ({ rec, a: amplitudeAt(rec, f) })).reduce((x, y) => (y.a > x.a ? y : x));
      const neighbours = all.filter((o) => o.f !== f && Math.abs(o.f - f) < 30 * bin);
      const ratio = Math.max(0, ...neighbours.map((o) => amplitudeAt(best.rec, o.f))) / best.a;
      if (!(ratio <= MAX_NEIGHBOUR_RATIO)) {
        checks.push({ family: FAMILY, case: name, check: `${label} frequency`, verdict: 'inconclusive', measured: null, expected: f, tolerance: null, note: `mode too weak at every probe (neighbour ${ratio.toFixed(0)}x stronger)` });
        continue;
      }
      const peak = spectralPeak(best.rec, dt, f - 3 * bin, f + 3 * bin);
      checks.push(compare({
        family: FAMILY, case: name, check: `${label} frequency vs exact Yee eigenfrequency`,
        measured: peak.frequencyHz / f - 1, expected: 0, tolerance: (PEAK_BIAS_BINS * bin) / f + roundoffError(steps),
        note: `relative error; record ${steps} steps (bin ${(bin / 1e6).toFixed(2)} MHz at ${(f / 1e9).toFixed(4)} GHz); estimator bias bound + roundoff`,
      }));
    }
    if (tested.length === 0) {
      checks.push({ family: FAMILY, case: name, check: 'mode frequencies', verdict: 'inconclusive', measured: null, expected: null, tolerance: null, note: 'no low mode is separated enough from its neighbours for this record length' });
    }
  }
  return checks;
}

function modeName(mode: CavityMode): string {
  return `${mode.m}${mode.n}${mode.p}`;
}
