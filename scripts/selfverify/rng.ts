/**
 * Seeded random numbers for the case families. By default the seed is the
 * commit being tested, so every commit draws different cases (nothing can be
 * fitted to a fixed set) and any run can be repeated with --seed.
 */
import { execFileSync } from 'node:child_process';

export interface Rng {
  /** Uniform in [lo, hi). */
  uniform(lo: number, hi: number): number;
  /** Integer in [lo, hi]. */
  integer(lo: number, hi: number): number;
  /** An independent stream for a named sub-task, so adding a case does not reshuffle the others. */
  fork(label: string): Rng;
}

function hash32(text: string): number {
  // FNV-1a.
  let h = 0x811c9dc5;
  for (let n = 0; n < text.length; n++) {
    h ^= text.charCodeAt(n);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function seededRng(seed: string): Rng {
  // mulberry32.
  let state = hash32(seed);
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    integer: (lo, hi) => lo + Math.floor((hi - lo + 1) * next()),
    fork: (label) => seededRng(`${seed}/${label}`),
  };
}

/** The commit under test, as the default seed. */
export function headCommitSeed(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
