/**
 * Thin copper sheets off the mesh planes (a helix strip on a cylinder, a bent
 * flex circuit): the update side of src/project/conformal_sheets.ts, which
 * builds these rows and documents the method (docs/conformal.md, "Thin
 * curved sheets").
 *
 * A zero-thickness sheet that crosses a Yee face splits it into regions that
 * see different fields, one on each side of the copper, and splits each edge
 * it crosses into pieces on either side. Each region and each piece gets its
 * own unknown: the face's or edge's own slot in H or E for one of them, and a
 * ghost slot (an extra array) for the rest. The main kernels update the own
 * slots as if nothing were cut; two sparse passes then correct them and update
 * the ghosts:
 *
 *   after the H update (and CPML and conformal faces): h_t += sum coef * e_s,
 *   after the E update (and CPML):                     e_t += sum coef * h_s,
 *
 * one row per corrected unknown, its sources among E (or H) and their ghosts.
 * A ghost index carries GHOST in its top bit. The rows of the E pass read the
 * H the H pass finished, and E has not changed since the main H pass, so each
 * correction sees the same fields its main update did.
 */
export const GHOST = 0x80000000;

/** Compressed rows: row r adds sum over k in [start[r], start[r+1]) of coef[k] * source[source[k]] to target[r]. */
export interface SparseRows {
  target: Uint32Array;
  start: Uint32Array;
  source: Uint32Array;
  coef: Float32Array;
}

export interface ThinSheetUpdate {
  /** Ghost unknowns: extra E pieces and extra H regions. */
  ghostE: number;
  ghostH: number;
  /** Rows targeting H and ghost H, sourced from E and ghost E. */
  h: SparseRows;
  /** Rows targeting E and ghost E, sourced from H and ghost H. */
  e: SparseRows;
  /** Own E slots of crossed edges, ascending: their eCurl is scaled by their piece's free fraction. */
  crossedEdges: Uint32Array;
  /**
   * Rim faces whose tie scale hit the end of its range, so the rim sits short
   * of where it should (src/project/conformal_sheets.ts, "Rims"): only off-axis
   * or curved rims, where the growth and the tie range see different fractions.
   */
  clampedRims: number;
}

/** target += rows * source, with GHOST-flagged indices into the ghost arrays. */
export function applySparseRows(rows: SparseRows, target: Float32Array, targetGhost: Float32Array, source: Float32Array, sourceGhost: Float32Array): void {
  const { start, source: from, coef } = rows;
  for (let r = 0; r < rows.target.length; r++) {
    let sum = 0;
    for (let k = start[r]; k < start[r + 1]; k++) {
      const s = from[k];
      sum += coef[k] * (s & GHOST ? sourceGhost[s ^ GHOST] : source[s]);
    }
    const t = rows.target[r];
    if (t & GHOST) targetGhost[t ^ GHOST] += sum;
    else target[t] += sum;
  }
}

/** Builds SparseRows from per-row maps of source -> coef. */
export function packRows(rows: Array<{ target: number; terms: Map<number, number> }>): SparseRows {
  const start = new Uint32Array(rows.length + 1);
  let total = 0;
  rows.forEach((r, n) => {
    start[n] = total;
    total += r.terms.size;
  });
  start[rows.length] = total;
  const source = new Uint32Array(total);
  const coef = new Float32Array(total);
  let k = 0;
  for (const r of rows) {
    for (const [s, c] of r.terms) {
      source[k] = s;
      coef[k++] = c;
    }
  }
  return { target: Uint32Array.from(rows, (r) => r.target), start, source, coef };
}
