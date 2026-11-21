/**
 * Exact answers the suite compares against. Nothing here calls the solver.
 */
import { C0 } from '../../src/engine/config';

/** Complete elliptic integral of the first kind K(k), by the arithmetic-geometric mean: K = pi / (2 AGM(1, sqrt(1 - k^2))). */
export function ellipticK(k: number): number {
  if (!(k >= 0 && k < 1)) throw new Error(`ellipticK needs 0 <= k < 1, got ${k}`);
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  for (let n = 0; n < 60 && Math.abs(a - b) > 1e-16 * a; n++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
}

/**
 * Characteristic impedance of a zero-thickness strip of width W centred
 * between two infinite ground planes b apart, in a uniform dielectric
 * (Cohn 1954, exact by conformal mapping):
 *   Z0 = eta0 / (4 sqrt(eps_r)) * K(k) / K(k'),  k = sech(pi W / 2b), k' = tanh(pi W / 2b).
 */
export function cohnStriplineZ0(widthMm: number, groundSpacingMm: number, epsR: number): number {
  const ETA0 = 376.730_313_668;
  const x = (Math.PI * widthMm) / (2 * groundSpacingMm);
  const k = 1 / Math.cosh(x);
  const kPrime = Math.tanh(x);
  return (ETA0 / (4 * Math.sqrt(epsR))) * (ellipticK(k) / ellipticK(kPrime));
}

/** Rectangular PEC cavity mode indices; a mode needs at least two non-zero indices. */
export interface CavityMode { m: number; n: number; p: number }

/** Every mode with indices up to `maxIndex` (in the continuum, any order). */
export function cavityModes(maxIndex: number): CavityMode[] {
  const modes: CavityMode[] = [];
  for (let m = 0; m <= maxIndex; m++) for (let n = 0; n <= maxIndex; n++) for (let p = 0; p <= maxIndex; p++) {
    if ([m, n, p].filter((v) => v > 0).length >= 2) modes.push({ m, n, p });
  }
  return modes;
}

/**
 * Exact eigenfrequency of a cavity mode on a uniform Yee grid (Taflove &
 * Hagness eq. 4.47 applied to the standing wave):
 *   sin(w dt / 2) / (c dt) = sqrt(sum_i (sin(k_i dx / 2) / dx)^2) / sqrt(eps_r)
 * i.e. the numerical dispersion relation with k_i = index_i * pi / L_i.
 * cells: [nx, ny, nz] cells per side, dt in s, dx in m.
 */
export function yeeCavityFrequencyHz(mode: CavityMode, cells: [number, number, number], dxM: number, dtSec: number, epsR: number): number {
  const s = [mode.m, mode.n, mode.p].map((index, a) => Math.sin((index * Math.PI) / (2 * cells[a])) / dxM);
  const rhs = (C0 * dtSec * Math.hypot(s[0], s[1], s[2])) / Math.sqrt(epsR);
  if (!(rhs < 1)) throw new Error('mode above the grid cutoff');
  return Math.asin(rhs) / (Math.PI * dtSec);
}

/** The same mode in the continuum: c / (2 sqrt(eps_r)) * sqrt((m/a)^2 + (n/b)^2 + (p/d)^2). */
export function cavityFrequencyHz(mode: CavityMode, sidesM: [number, number, number], epsR: number): number {
  return (C0 / (2 * Math.sqrt(epsR))) * Math.hypot(mode.m / sidesM[0], mode.n / sidesM[1], mode.p / sidesM[2]);
}

/**
 * Propagation constant of a TEM wave on a uniform Yee grid of cell `dyM`
 * along the line in a uniform dielectric: the 1D dispersion relation
 *   sin(beta dy / 2) / dy = sqrt(eps_r) sin(w dt / 2) / (c dt).
 * Exact for a TEM mode of the discrete scheme in a uniform fill: its
 * transverse E is the discrete gradient of a discrete static potential and H
 * follows it, so only the longitudinal differences disperse.
 */
export function yeeTemBeta(frequencyHz: number, dyM: number, dtSec: number, epsR: number): number {
  const rhs = (dyM * Math.sqrt(epsR) * Math.sin(Math.PI * frequencyHz * dtSec)) / (C0 * dtSec);
  if (!(rhs < 1)) throw new Error('frequency above the line grid cutoff');
  return (2 / dyM) * Math.asin(rhs);
}
