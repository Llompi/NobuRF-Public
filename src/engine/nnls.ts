/**
 * Non-negative least squares: minimise |A x - b| subject to x >= 0, by the
 * active-set method of Lawson and Hanson ("Solving Least Squares Problems",
 * 1974, ch. 23). Used for the small, well-posed fits here (a dozen unknowns,
 * a hundred rows): surface impedance shapes and measured permittivity tables.
 * A is given by rows.
 */
export function nnls(a: number[][], b: number[], maxIterations = 500): number[] {
  const m = a.length;
  const n = a[0]?.length ?? 0;
  if (!b.every(Number.isFinite) || !a.every((row) => row.length === n && row.every(Number.isFinite))) {
    throw new Error(`nnls needs finite numbers and rows of ${n} columns`);
  }
  const x = new Array<number>(n).fill(0);
  const passive = new Array<boolean>(n).fill(false);
  const residual = () => b.map((bi, i) => bi - a[i].reduce((s, aij, j) => s + aij * x[j], 0));
  const gradient = (r: number[]) => Array.from({ length: n }, (_, j) => a.reduce((s, row, i) => s + row[j] * r[i], 0));
  const tolerance = 1e-12 * Math.max(1, ...b.map(Math.abs));
  // A column whose gradient passes the tolerance only by rounding can solve to <= 0 and be dropped again at once;
  // it is not picked again until x changes, or the loop would cycle (Lawson and Hanson's step 6 guard).
  const rejected = new Set<number>();
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const w = gradient(residual());
    let best = -1;
    for (let j = 0; j < n; j++) if (!passive[j] && !rejected.has(j) && w[j] > tolerance && (best < 0 || w[j] > w[best])) best = j;
    if (best < 0) return x;
    const before = [...x];
    passive[best] = true;
    // Inner loop: solve on the passive set, stepping back to keep x >= 0.
    for (;;) {
      const cols = passive.flatMap((p, j) => (p ? [j] : []));
      const z = leastSquares(a.map((row) => cols.map((j) => row[j])), b);
      if (z.every((v) => v > 0)) {
        cols.forEach((j, k) => (x[j] = z[k]));
        break;
      }
      let alpha = 1;
      // x[j] = z[k] = 0 would be 0 / 0: such a column steps nowhere and is dropped below.
      cols.forEach((j, k) => { if (z[k] <= 0) alpha = Math.min(alpha, x[j] <= 0 ? 0 : x[j] / (x[j] - z[k])); });
      cols.forEach((j, k) => {
        x[j] += alpha * (z[k] - x[j]);
        if (x[j] <= 1e-15 * Math.max(1, Math.abs(z[k]))) { x[j] = 0; passive[j] = false; }
      });
    }
    if (x.every((v, j) => v === before[j])) rejected.add(best);
    else rejected.clear();
  }
  throw new Error(`nnls did not converge in ${maxIterations} iterations (${m} rows, ${n} unknowns)`);
}

/** Unconstrained least squares by Householder QR (columns are few and well scaled here). */
function leastSquares(a: number[][], b: number[]): number[] {
  const m = a.length;
  const n = a[0]?.length ?? 0;
  const q = a.map((row) => [...row]);
  const y = [...b];
  for (let k = 0; k < n; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += q[i][k] ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = q[k][k] > 0 ? -norm : norm;
    const v = q.slice(k).map((row) => row[k]);
    v[0] -= alpha;
    const vv = v.reduce((s, vi) => s + vi * vi, 0);
    if (vv === 0) continue;
    for (let j = k; j < n; j++) {
      const d = (2 * v.reduce((s, vi, i) => s + vi * q[k + i][j], 0)) / vv;
      for (let i = 0; i < v.length; i++) q[k + i][j] -= d * v[i];
    }
    const d = (2 * v.reduce((s, vi, i) => s + vi * y[k + i], 0)) / vv;
    for (let i = 0; i < v.length; i++) y[k + i] -= d * v[i];
  }
  const x = new Array<number>(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let s = y[k];
    for (let j = k + 1; j < n; j++) s -= q[k][j] * x[j];
    x[k] = q[k][k] === 0 ? 0 : s / q[k][k];
  }
  return x;
}
