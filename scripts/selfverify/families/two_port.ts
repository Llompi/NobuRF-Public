/**
 * Two-port family: random boards (random_board.ts) solved through the same
 * path as `noburf solve` (rasterise, CpuFdtd.run per port, scatteringMatrix).
 *
 * Laws, for any such board in open space (PML), lossless or lossy:
 *   - no singular value of S above 1 (passive);
 *   - S_21 = S_12 (reciprocal media).
 * (A closed lossless box would make S unitary, an equality, but its box modes
 * do not ring down within any affordable run; the conserved-energy family
 * checks energy conservation directly instead.)
 * Symmetries, on the lossless board: mirroring, rotating by 90 degrees,
 * translating by a fraction of a cell, scaling with the mesh, or reversing
 * the port list must give the same S (permuted for the port list). The
 * transformed mesh must map exactly onto the original (a mesher that does not
 * follow the board fails), and then only roundoff may differ.
 */
import { CpuFdtd } from '../../../src/engine/fdtd_cpu';
import { scatteringMatrix, type ScatteringResult } from '../../../src/engine/port_dft';
import type { ExcitationConfig, PortSamples, RunControl } from '../../../src/engine/types';
import { rasterise } from '../../../src/project/rasterise';
import { linesMap, mirrorX, reversePorts, rotate90, scale, toProject, translate, type BoardSpec } from '../board_spec';
import { compare, type Check } from '../measure';
import type { Rng } from '../rng';
import { MIN_USEFUL_DECAY_DB, roundoffError, truncationError } from '../tolerances';
import { randomBoard } from './random_board';

const FAMILY = 'two-port';
/** Steps of the symmetry runs. Any length works (both sides are cut at the same step); this keeps them cheap. */
const SYMMETRY_STEPS = 3000;

interface Solved {
  s: ScatteringResult;
  runs: PortSamples[];
  mesh: { x: Float64Array; y: Float64Array; z: Float64Array };
  decayDb: number;
  steps: number;
}

/** fixedSteps: run exactly that many steps (no energy stop), for comparing two discrete problems step for step. */
function solve(spec: BoardSpec, fixedSteps?: number): Solved {
  const project = toProject(spec);
  const { model } = rasterise(project);
  const a = project.analysis;
  const exc: ExcitationConfig = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const control: RunControl = fixedSteps === undefined
    ? { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 }
    : { maxSteps: fixedSteps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const sim = new CpuFdtd(model);
  const runs = model.ports.map((_, activePort) => sim.run(exc, control, undefined, activePort));
  const s = scatteringMatrix(runs.map((samples, activePort) => ({ activePort, samples })), model.ports.map(() => 50), exc);
  return {
    s, runs, mesh: model.mesh,
    decayDb: Math.min(...runs.map((r) => (r.stoppedOnEnergy ? a.stop.energy_decay_db : r.energyDecayDb))),
    steps: Math.max(...runs.map((r) => r.v.length)),
  };
}

const entry = (s: ScatteringResult, i: number, j: number, m: number): [number, number] => [s.re[i][j]![m], s.im[i][j]![m]];

/** Largest singular value of a 2x2 complex matrix. */
function largestSingularValue(m: Array<Array<[number, number]>>): number {
  // Eigenvalues of M^H M (Hermitian 2x2): trace/2 +- sqrt((trace/2)^2 - det).
  const col = (j: number) => [m[0][j], m[1][j]];
  const dot = (u: Array<[number, number]>, v: Array<[number, number]>) => {
    let re = 0;
    let im = 0;
    for (let k = 0; k < 2; k++) {
      re += u[k][0] * v[k][0] + u[k][1] * v[k][1];
      im += u[k][0] * v[k][1] - u[k][1] * v[k][0];
    }
    return [re, im];
  };
  const a = dot(col(0), col(0))[0];
  const d = dot(col(1), col(1))[0];
  const [br, bi] = dot(col(0), col(1));
  const half = (a + d) / 2;
  return Math.sqrt(half + Math.sqrt(((a - d) / 2) ** 2 + br * br + bi * bi));
}

export function runTwoPort(rng: Rng, tier: 'quick' | 'full'): Check[] {
  const cases = tier === 'quick' ? 1 : 3;
  const checks: Check[] = [];
  for (let c = 0; c < cases; c++) {
    const r = rng.fork(`case${c}`);
    const layers = c % 2 === 0 ? 1 : 2;

    // ---- Laws: passivity and reciprocity, lossless and lossy, open (PML).
    const lawChecks = (solved: Solved, name: string) => {
      if (solved.decayDb < MIN_USEFUL_DECAY_DB) {
        checks.push({ family: FAMILY, case: name, check: 'ring-down', verdict: 'inconclusive', measured: solved.decayDb, expected: null, tolerance: null, note: `energy fell only ${solved.decayDb.toFixed(1)} dB in ${solved.steps} steps` });
        return;
      }
      const t = truncationError(solved.decayDb);
      let largest = 0;
      let reciprocity = 0;
      for (let m = 0; m < solved.s.fGHz.length; m++) {
        const matrix = [0, 1].map((i) => [0, 1].map((j) => entry(solved.s, i, j, m)));
        largest = Math.max(largest, largestSingularValue(matrix));
        const [s21, s12] = [matrix[1][0], matrix[0][1]];
        reciprocity = Math.max(reciprocity, Math.hypot(s21[0] - s12[0], s21[1] - s12[1]));
      }
      // ||dS||_2 <= ||dS||_F <= 2 t for a 2x2 with every entry off by at most t.
      checks.push(compare({ family: FAMILY, case: name, check: 'passivity: largest singular value of S <= 1', measured: Math.max(0, largest - 1), expected: 0, tolerance: 2 * t + roundoffError(solved.steps), note: `excess over 1, worst over the band (largest ${largest.toFixed(5)}); truncation at ${solved.decayDb.toFixed(1)} dB + roundoff` }));
      checks.push(compare({ family: FAMILY, case: name, check: 'reciprocity S21 = S12', measured: reciprocity, expected: 0, tolerance: 2 * t + roundoffError(solved.steps), note: 'worst |S21 - S12| over the band' }));
    };

    const spec = randomBoard(r.fork('lossless'), `two-port-${c}`, { boundary: 'pml', lossy: false, layers });
    const name = `${spec.name} (PML, lossless, ${layers} dielectric layer(s))`;
    lawChecks(solve(spec), name);
    const lossy = randomBoard(r.fork('lossy'), `two-port-lossy-${c}`, { boundary: 'pml', lossy: true, layers });
    lawChecks(solve(lossy), `${lossy.name} (PML, lossy, ${layers} dielectric layer(s))`);

    // ---- Symmetries on the lossless board. Both sides of each pair run the same fixed number of
    // steps, so truncation is identical and cancels; only roundoff may differ.
    const reference = solve(spec, SYMMETRY_STEPS);
    const symmetric = (label: string, transformed: BoardSpec, maps: (m: Solved['mesh']) => boolean, permute: (i: number) => number) => {
      const other = solve(transformed, SYMMETRY_STEPS);
      if (!maps(other.mesh)) {
        // The mesher should follow the board through these transformations; when it does not, that is the defect.
        checks.push({ family: FAMILY, case: name, check: label, verdict: 'fail', measured: null, expected: null, tolerance: null, note: 'the transformed mesh does not map onto the original (mesher not equivariant)' });
        return;
      }
      let worst = 0;
      for (let m = 0; m < reference.s.fGHz.length; m++) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        const [u, v] = [entry(reference.s, i, j, m), entry(other.s, permute(i), permute(j), m)];
        worst = Math.max(worst, Math.hypot(u[0] - v[0], u[1] - v[1]));
      }
      checks.push(compare({
        family: FAMILY, case: name, check: label, measured: worst, expected: 0, tolerance: roundoffError(SYMMETRY_STEPS),
        note: `worst |dS| over the band and all entries, both runs ${SYMMETRY_STEPS} steps; same discrete problem, roundoff only`,
      }));
    };
    const id = (i: number) => i;
    const mesh = reference.mesh;
    const shift: [number, number] = [r.uniform(0.05, 0.95) * spec.mesh.edgeCellMm, r.uniform(0.05, 0.95) * spec.mesh.edgeCellMm];
    const s = r.uniform(0.6, 1.6);
    symmetric('S under a mirror in x', mirrorX(spec), (m) => linesMap(mesh.x, m.x, 1, Math.min(...spec.outline.map((p) => p[0])) + Math.max(...spec.outline.map((p) => p[0])), -1) && linesMap(mesh.y, m.y, 1, 0, 1), id);
    symmetric('S under a 90 degree rotation', rotate90(spec), (m) => linesMap(mesh.y, m.x, 1, 0, -1) && linesMap(mesh.x, m.y, 1, 0, 1), id);
    symmetric('S under a sub-cell translation', translate(spec, shift), (m) => linesMap(mesh.x, m.x, 1, shift[0], 1) && linesMap(mesh.y, m.y, 1, shift[1], 1), id);
    symmetric('S under scaling with the mesh', scale(spec, s, true), (m) => linesMap(mesh.x, m.x, s, 0, 1) && linesMap(mesh.y, m.y, s, 0, 1) && linesMap(mesh.z, m.z, s, 0, 1), id);
    symmetric('S under reversed port order', reversePorts(spec), (m) => linesMap(mesh.x, m.x, 1, 0, 1) && linesMap(mesh.y, m.y, 1, 0, 1), (i) => 1 - i);
  }
  return checks;
}
