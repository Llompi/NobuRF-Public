/**
 * Every pass/fail threshold of the self-verification suite, with where it
 * comes from. This file was committed before the suite had ever been run
 * against the solver (see docs/self-verify.md, "Rules").
 *
 * A threshold here may only change with an entry in docs/self-verify.md
 * "Tolerance changes" that gives the new derivation. "The case failed" is not
 * a derivation.
 */

/** Unit roundoff of float32, the precision the fields are stored in: 2^-24. */
export const FLOAT32_UNIT_ROUNDOFF = 2 ** -24;

/* ---------------------------------------------------------------------------
 * Frequency estimation from a ring-down record
 * ------------------------------------------------------------------------- */

/**
 * Bias bound of the Hann-windowed peak search, in DFT bins (1 bin = 1 / record
 * length). The bias is set by the slope of a neighbour's Hann response at the
 * tested mode, which falls as 1/k^3 away from it. Measured for one neighbour
 * of 30x the amplitude (MAX_NEIGHBOUR_RATIO): 0.047 bin at 8 bins of
 * separation (adversarial review, Nov 20). At MIN_MODE_SEPARATION_BINS = 16
 * the 1/k^3 slope gives 0.047 / 8 = 0.006 bin; two such neighbours 0.012.
 * 0.05 bin is four times that.
 * (Changed after review: was 8 bins with a wrong -90 dB leakage figure; see docs/self-verify.md.)
 */
export const PEAK_BIAS_BINS = 0.05;

/** Smallest distance from a tested mode to any other mode, in bins, for PEAK_BIAS_BINS to hold. */
export const MIN_MODE_SEPARATION_BINS = 16;

/** Largest neighbour-to-mode amplitude ratio at the chosen probe for which PEAK_BIAS_BINS holds; above it the mode is inconclusive. */
export const MAX_NEIGHBOUR_RATIO = 30;

/* ---------------------------------------------------------------------------
 * Convergence under mesh refinement
 * ------------------------------------------------------------------------- */

/**
 * The order of accuracy the scheme should show. Yee's scheme is second order
 * on uniform grids, and Monk & Suli (SIAM J. Numer. Anal. 31, 1994) prove it
 * stays second order on non-uniform tensor grids ("supraconvergence") even
 * though the local truncation error there is first order.
 *
 * At a zero-thickness sheet edge the field goes as r^(-1/2). The error of a
 * grid at such an edge expands as c1 h + c2 h^2 + ...; the h term is a shift
 * of where the grid puts the edge (src/engine/yee_edge.ts). Once that shift is
 * placed correctly the next term is h^2 (the next singular term, r^(3/2),
 * contributes h^3, and cross terms h^2).
 */
export const FORMAL_ORDER = 2;

/**
 * Observed order below this fails: it means a first-order error term is
 * present. 1.5 is the midpoint between the two hypotheses the test separates,
 * "a first-order term remains" (p = 1) and "second order" (p = 2). Higher-order
 * terms move p by about (k h)^2 / 10 relative, under 0.05 at the coarsest
 * levels the cases use (k h <= 0.5), far from the 0.5 margin.
 */
export const MIN_OBSERVED_ORDER = 1.5;

/**
 * Observed order above this is "inconclusive", not a pass: the levels are not
 * in the asymptotic range, or error terms of opposite sign cancel. 3 is one
 * order above formal; a real second-order scheme gets there only by accident.
 */
export const MAX_OBSERVED_ORDER = 3;

/**
 * Safety factors of the grid convergence index (Roache 1994, 1998): 1.25 when
 * three or more levels confirm the order, 3 when only two levels are used and
 * the order is assumed. These are the published values, not chosen here.
 */
export const GCI_SAFETY_THREE_LEVELS = 1.25;
export const GCI_SAFETY_TWO_LEVELS = 3;

/* ---------------------------------------------------------------------------
 * Time truncation and roundoff
 * ------------------------------------------------------------------------- */

/**
 * Error in a ratio of port spectra (an S-parameter) from stopping the run
 * when the field energy is `decayDb` below its peak. The fields left in the
 * box then have an amplitude 10^(-decayDb/20) of the peak; the transform
 * misses at most that much of V and of I, so S moves by at most twice it.
 */
export function truncationError(decayDb: number): number {
  return 2 * 10 ** (-decayDb / 20);
}

/**
 * Difference between two runs of the same discrete problem whose arithmetic
 * is done in a different order (mirrored, rotated, relabelled, translated by
 * exactly a whole mesh, or scaled with the mesh), and the roundoff in any
 * quantity read from a run. Rounding errors are unbiased, so they add as a
 * random walk: relative error about u sqrt(n) per rounded value after n
 * steps. Each field value is rounded once per update, from a curl of six
 * terms (up to two more roundings for CPML and loss); at most ten roundings
 * per value per step, so 10 u sqrt(n). Resonances store error and signal
 * alike, so the ratio does not grow with Q. Applied to quantities normalised
 * to 1 (|S|, relative f, Z/Z0).
 * (Changed after review from 100 u sqrt(n), whose factor was not derived; see docs/self-verify.md.)
 */
export function roundoffError(steps: number): number {
  return 10 * FLOAT32_UNIT_ROUNDOFF * Math.sqrt(steps);
}

/**
 * Drift allowed in the exactly conserved discrete energy of a closed lossless
 * box (energy.ts) over n steps. Each stored value carries a relative rounding
 * error of at most u, unbiased; the energy changes by 2 w e de per edge, which
 * adds as a random walk over edges and steps: at most 2 u sqrt(n) relative
 * even if one edge held all the energy. Five times that.
 */
export function energyDriftTolerance(steps: number): number {
  return 10 * FLOAT32_UNIT_ROUNDOFF * Math.sqrt(steps);
}

/* ---------------------------------------------------------------------------
 * Closed-form model errors (the reference's own error, not the solver's)
 * ------------------------------------------------------------------------- */

/**
 * Cohn's stripline impedance assumes ground planes of infinite width. The
 * stripline cases have ground planes that end `gapMm` past each strip edge,
 * then air and a PEC wall. Beside the strip the potential between the plates
 * decays as exp(-pi x / b), so ending the plates changes the stored energy,
 * and Z0, by the square of that at the plate edge, exp(-2 pi g / b), from
 * each side. Twice that from two sides, times two for the image in the wall.
 */
export function striplineWidthModelError(gapMm: number, groundSpacingMm: number): number {
  return 4 * Math.exp((-2 * Math.PI * gapMm) / groundSpacingMm);
}

/**
 * Error of reading a TEM line's Z0 and beta from gated V and I records
 * (stripline.ts). The gate keeps the whole forward pulse: the source pulse is
 * below 1e-6 of its peak outside 3.72 tau of its centre, and the case geometry
 * keeps the far-end echo out of the gate, so the transform misses under 1e-6
 * of the signal, 3e-6 at the -9 dB band edges. Higher-order modes from the
 * source column decay at least as exp(-pi d / b) over d >= 6 b, under 1e-8.
 * Z0 and beta then carry about 1e-5 relative error; 1e-4 is ten times that.
 */
export const TEM_EXTRACTION_ERROR = 1e-4;

/**
 * Two-port law checks need the run to have rung down this far: below it the
 * truncation bound 2 * 10^(-dB/20) is over 2 %, too loose to judge anything,
 * and the case is reported inconclusive.
 */
export const MIN_USEFUL_DECAY_DB = 40;
