/**
 * Physics checks that hold for every passive, reciprocal board, whatever its
 * shape or materials, run on every solve's S-matrix.
 *
 * Passivity: a network with no sources cannot return more power than it
 * receives, so the largest singular value of S is at most 1 at every
 * frequency (Pozar, Microwave Engineering, 4th ed., section 4.3; IEEE
 * 370-2020 uses the same test in its S-parameter quality checks). With only some
 * ports excited the full S is unknown; each measured column's power sum
 * sum_i |S_ij|^2 <= 1 is the test that remains.
 *
 * Reciprocity: isotropic eps, mu and sigma make S = S^T (Pozar section
 * 4.3). NobuRF has only isotropic materials, so |S_ij - S_ji| is pure
 * numerical error: unequal port spacing on the mesh, truncation.
 *
 * Two levels each, a warning and a failure. The DFT of a run stopped at a
 * finite energy decay leaves a residue of roughly the field amplitude left,
 * 10^(-decay/20), in every S entry (about 0.003 at 50 dB), and band edges of
 * the excitation spectrum add a little more. Passivity warns above 1.005 and
 * fails above 1.02; reciprocity warns above 0.005 and fails above 0.01. A
 * warning is worth a look (a run stopped early, a band edge); a failure
 * means a real defect: a port model, a source, an unstable material.
 */
import type { ScatteringResult } from '../engine/port_dft';

export const PASSIVITY_WARN = 1.005;
export const PASSIVITY_FAIL = 1.02;
export const RECIPROCITY_WARN = 0.005;
export const RECIPROCITY_FAIL = 0.01;

export interface CheckResult {
  name: 'passivity' | 'reciprocity' | 'energy_decay';
  /** At or below the failure level. */
  passed: boolean;
  /** Above the warning level (a failure is also a warning). */
  marginal: boolean;
  /** Worst value found and where; the unit depends on the check. */
  worst: number;
  atGhz: number | null;
  /** The failure level. */
  limit: number;
  detail: string;
}

type C = [number, number];

/** Largest singular value of the n x n complex matrix S (row-major, [re, im] entries) by power iteration on S^H S. */
export function largestSingularValue(s: C[][]): number {
  const n = s.length;
  // G = S^H S, Hermitian positive semi-definite.
  const g: C[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => {
    let re = 0, im = 0;
    for (let k = 0; k < n; k++) {
      const [ar, ai] = s[k][i], [br, bi] = s[k][j];
      re += ar * br + ai * bi; // conj(a) * b
      im += ar * bi - ai * br;
    }
    return [re, im] as C;
  }));
  let v: C[] = Array.from({ length: n }, (_, i) => [1, 0.1 * i] as C);
  let lambda = 0;
  for (let iter = 0; iter < 200; iter++) {
    const w: C[] = g.map((row) => row.reduce<C>(([re, im], [gr, gi], j) => [re + gr * v[j][0] - gi * v[j][1], im + gr * v[j][1] + gi * v[j][0]], [0, 0]));
    const norm = Math.hypot(...w.map(([re, im]) => Math.hypot(re, im)));
    if (norm === 0) return 0;
    const next = norm;
    v = w.map(([re, im]) => [re / norm, im / norm] as C);
    if (Math.abs(next - lambda) <= 1e-12 * next) { lambda = next; break; }
    lambda = next;
  }
  return Math.sqrt(lambda);
}

export function passivityCheck(s: ScatteringResult): CheckResult {
  const n = s.re.length;
  let worst = 0, atGhz: number | null = null;
  const columns = Array.from({ length: n }, (_, j) => j).filter((j) => s.re[0][j] !== null);
  for (let m = 0; m < s.fGHz.length; m++) {
    let value: number;
    if (s.method === 'full') {
      value = largestSingularValue(s.re.map((row, i) => row.map((re, j) => [re![m], s.im[i][j]![m]] as C)));
    } else {
      value = Math.max(...columns.map((j) => Math.sqrt(s.re.reduce((sum, row, i) => sum + row[j]![m] ** 2 + s.im[i][j]![m] ** 2, 0))));
    }
    if (value > worst) [worst, atGhz] = [value, s.fGHz[m]];
  }
  const what = s.method === 'full' ? 'largest singular value of S' : 'largest power sum of a measured S column';
  return {
    name: 'passivity', passed: worst <= PASSIVITY_FAIL, marginal: worst > PASSIVITY_WARN, worst, atGhz, limit: PASSIVITY_FAIL,
    detail: `${what} ${worst.toFixed(4)}${atGhz === null ? '' : ` at ${atGhz.toFixed(3)} GHz`} (warns above ${PASSIVITY_WARN}, fails above ${PASSIVITY_FAIL})`,
  };
}

/** Null when fewer than two ports or not every port was excited: S_ji is unknown. */
export function reciprocityCheck(s: ScatteringResult): CheckResult | null {
  const n = s.re.length;
  if (n < 2 || s.method !== 'full') return null;
  let worst = 0, atGhz: number | null = null, pair = '';
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let m = 0; m < s.fGHz.length; m++) {
        const d = Math.hypot(s.re[i][j]![m] - s.re[j][i]![m], s.im[i][j]![m] - s.im[j][i]![m]);
        if (d > worst) [worst, atGhz, pair] = [d, s.fGHz[m], `S${i + 1}${j + 1} vs S${j + 1}${i + 1}`];
      }
    }
  }
  return {
    name: 'reciprocity', passed: worst <= RECIPROCITY_FAIL, marginal: worst > RECIPROCITY_WARN, worst, atGhz, limit: RECIPROCITY_FAIL,
    detail: `largest |S_ij - S_ji| ${worst.toFixed(4)}${pair ? ` (${pair} at ${atGhz!.toFixed(3)} GHz)` : ''} (warns above ${RECIPROCITY_WARN}, fails above ${RECIPROCITY_FAIL})`,
  };
}

/** The field must ring down to the requested level, or the DFT misses energy that never left the box. */
export function energyCheck(runs: Array<{ energyDecayDb: number; stoppedOnEnergy: boolean }>, requestedDb: number): CheckResult {
  const decays = runs.map((r) => (Number.isFinite(r.energyDecayDb) ? r.energyDecayDb : -Infinity));
  const worst = Math.min(...decays);
  return {
    name: 'energy_decay', passed: runs.every((r) => r.stoppedOnEnergy), marginal: !runs.every((r) => r.stoppedOnEnergy), worst, atGhz: null, limit: requestedDb,
    detail: `least energy decay over ${runs.length} run(s): ${Number.isFinite(worst) ? `${worst.toFixed(1)} dB` : 'not measured'} (requested ${requestedDb} dB)`,
  };
}

/** S of a one-port from its reflection coefficient samples. */
export function onePortScattering(fGHz: Float64Array, gammaRe: Float64Array, gammaIm: Float64Array): ScatteringResult {
  return { fGHz, re: [[gammaRe]], im: [[gammaIm]], method: 'full', maxPassiveIncidentRatio: 0 };
}
