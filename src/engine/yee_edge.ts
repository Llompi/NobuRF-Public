/**
 * The Yee grid at the edge of a zero-thickness sheet, from the discrete
 * half-plane problem.
 *
 * Near a strip edge the quasi-static field is that of a half-plane. The
 * vector potential along the edge, A (on the Ey/Ex nodes), obeys the 5-point
 * Laplacian the Yee curl-curl reduces to, with A = 0 on the sheet. The
 * continuum solution is A = Re sqrt(z). Cells are 1 along the sheet and
 * `below` / `above` across it, as the z cells either side of a copper layer.
 * There is no permittivity: when `below` and `above` differ, the electric
 * problem with a substrate on one side gives an offset up to about 0.03 cell
 * smaller (0.293 against 0.317 at cells 0.5 / 1 with eps_r 4.4 below).
 */

/** Re sqrt((x - shift) + i y): zero on the cut x < shift, y = 0. */
export function halfPlaneField(x: number, y: number, shift = 0): number {
  const u = x - shift;
  return Math.sqrt((Math.hypot(u, y) + u) / 2);
}

/**
 * The discrete problem on a (2L+1)^2 node grid, zero on the sheet (nodes
 * i <= 0, k = 0) and `boundary` on the outer ring, solved by conjugate
 * gradients. Node (i, k) sits at x = i, y = k * above (k > 0) or k * below
 * (k < 0). Each free node's equation is weighted by its dual cell, so the
 * matrix is symmetric.
 */
export function solveHalfPlane(L: number, boundary: (x: number, y: number) => number, below = 1, above = 1) {
  const n = 2 * L + 1;
  const at = (i: number, k: number) => i + L + n * (k + L);
  const yOf = (k: number) => k * (k > 0 ? above : below);
  const fixed = new Uint8Array(n * n);
  const a = new Float64Array(n * n);
  // Per row: the spacing to the row above and below, and the dual cell height.
  const up = new Float64Array(n);
  const down = new Float64Array(n);
  for (let k = -L; k <= L; k++) {
    up[k + L] = yOf(k + 1) - yOf(k);
    down[k + L] = yOf(k) - yOf(k - 1);
    for (let i = -L; i <= L; i++) {
      const onSheet = k === 0 && i <= 0;
      if (onSheet || Math.abs(i) === L || Math.abs(k) === L) {
        fixed[at(i, k)] = 1;
        a[at(i, k)] = onSheet ? 0 : boundary(i, yOf(k));
      }
    }
  }
  const apply = (v: Float64Array, out: Float64Array) => {
    for (let c = 0; c < n * n; c++) {
      if (fixed[c]) { out[c] = 0; continue; }
      const row = Math.floor(c / n);
      const [hu, hd] = [up[row], down[row]];
      out[c] = ((hu + hd) / 2) * (2 * v[c] - v[c - 1] - v[c + 1]) + (v[c] - v[c + n]) / hu + (v[c] - v[c - n]) / hd;
    }
  };
  const r = new Float64Array(n * n);
  apply(a, r);
  for (let c = 0; c < n * n; c++) r[c] = fixed[c] ? 0 : -r[c];
  const p = Float64Array.from(r);
  const q = new Float64Array(n * n);
  const masked = new Float64Array(n * n);
  let rr = r.reduce((s, v) => s + v * v, 0);
  for (let iter = 0; iter < 40 * n && rr > 1e-26; iter++) {
    for (let c = 0; c < n * n; c++) masked[c] = fixed[c] ? 0 : p[c];
    apply(masked, q);
    let pq = 0;
    for (let c = 0; c < n * n; c++) pq += masked[c] * q[c];
    const alpha = rr / pq;
    let next = 0;
    for (let c = 0; c < n * n; c++) {
      if (fixed[c]) continue;
      a[c] += alpha * p[c];
      r[c] -= alpha * q[c];
      next += r[c] * r[c];
    }
    for (let c = 0; c < n * n; c++) p[c] = r[c] + (next / rr) * p[c];
    rr = next;
  }
  return { a, at, fixed, yOf };
}

/**
 * Where the grid's sheet edge sits in the continuum: the shift s, in cells
 * along the sheet past its last node, for which the discrete solution far
 * from the edge is Re sqrt(z - s). The solution is linear in the boundary
 * data, so two solves with s = 0 and s = 1 on the outer ring give it: s is
 * the root of the deviation from Re sqrt(z - s) on a ring halfway out,
 * projected on the shift mode d/ds Re sqrt(z - s) = -Re(1 / (2 sqrt(z))).
 * On square cells it is 0.3535 (L 40 to 400); it grows with the cells across
 * the sheet (0.336 at 0.9, 0.372 at 1.1).
 */
export function yeeEdgeOffset(L: number, below = 1, above = 1): number {
  const ringRadius = (Math.min(1, below, above) * L) / 2;
  const ringWidth = Math.max(1, below, above);
  const deviation = (shift: number) => {
    const { a, at, fixed, yOf } = solveHalfPlane(L, (x, y) => halfPlaneField(x, y, shift), below, above);
    let sum = 0;
    for (let k = -L; k <= L; k++) for (let i = -L; i <= L; i++) {
      const [x, y] = [i, yOf(k)];
      const r = Math.hypot(x, y);
      if (Math.abs(r - ringRadius) >= ringWidth || fixed[at(i, k)]) continue;
      // Re(1 / sqrt(z)) = Re sqrt(z) / |z|.
      const mode = -halfPlaneField(x, y) / (2 * r);
      sum += (a[at(i, k)] - halfPlaneField(x, y, shift)) * mode;
    }
    return sum;
  };
  const [d0, d1] = [deviation(0), deviation(1)];
  return -d0 / (d1 - d0);
}

/** Grid size for the mesher's solves, about 0.1 s each (cached); its accuracy is SHEET_EDGE_OFFSET_ACCURACY_CELLS. */
const MESHER_HALF_PLANE_L = 40;
/** The radius, in cells, of the ring the mesher's offset is measured on: the uniform lattice it assumes (rasterise.ts holds that much around a corrected edge). */
export const SHEET_EDGE_OFFSET_RING_CELLS = MESHER_HALF_PLANE_L / 2;
/**
 * How far, in cells, the mesher's offset (L = 40) is from the L = 120 value,
 * at most, over the z cells the mesher uses it for (0.25 to 2 cells below and
 * above the sheet). scripts/lab/edge_offset_accuracy.ts measures it: 2.4e-3
 * at (0.25, 0.25), 1.7e-3 at (0.25, 1), under 8e-4 once both are 0.5 or more,
 * and about 1.5e-4 on square cells.
 */
export const SHEET_EDGE_OFFSET_ACCURACY_CELLS = 2.5e-3;
const offsetCache = new Map<string, number>();

/** yeeEdgeOffset for the mesher, cached by the cell sizes (to 1e-6 of a cell). */
export function sheetEdgeOffsetCells(below: number, above: number): number {
  const key = `${below.toFixed(6)} ${above.toFixed(6)}`;
  let offset = offsetCache.get(key);
  if (offset === undefined) {
    offset = yeeEdgeOffset(MESHER_HALF_PLANE_L, below, above);
    offsetCache.set(key, offset);
  }
  return offset;
}
