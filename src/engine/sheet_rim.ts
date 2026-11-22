/**
 * The free edge (rim) of a thin sheet off the mesh planes, from the discrete
 * half-plane problem: the sheet-scheme counterpart of yee_edge.ts.
 *
 * Near a rim the quasi-static field is that of a half-plane, A = Re sqrt(z)
 * with A = 0 on the sheet (the field component along the rim, or the
 * potential: both obey the same 5-point problem here). In the thin-sheet
 * update (src/project/conformal_sheets.ts) a sheet that crosses the edges
 * of a column at fraction s of their length ties each edge's two ends to the
 * sheet through its two pieces, conductances 1/s and 1/(1 - s), in place of
 * the link between them; past the last crossed column the sheet is not seen
 * at all. So in the cross-section the sheet is a row of ties, nodes (i, 0)
 * and (i, 1) for columns i <= 0, and it ends where the ties end, whatever
 * the true rim does inside the next cell.
 *
 * This module solves that discrete problem with the ties of the last column
 * scaled by beta, and reports where its rim sits in the continuum: the shift,
 * in cells past the last crossed column, for which the discrete solution far
 * from the rim is Re sqrt(z - shift). beta = 1 is the plain update (0.146 cell
 * at s = 0.5, 0.270 at s = 0.1, tending to yee_edge's 0.3535 as s -> 0);
 * beta > 1 pushes the rim out, beta < 1 pulls it in, monotonically. The sheet
 * update picks beta per rim so the discrete rim lands on the true one.
 *
 * The problem is the same for s and 1 - s (mirror), and the shift is within
 * 0.002 cell of L = 80 at L = 40 (checked for s 0.1 and 0.37, beta 0.2 to 5;
 * and for s 0.01, 0.37 and 0.5 at beta 0.01 to 100, the ends the solver uses).
 * Sheets nearer a plane than s = 0.01 use the s = 0.01 row, whose plain rim is
 * within 0.01 cell of the on-plane 0.3535.
 */

/** Re sqrt((x - shift) + i (y - s)): zero on the cut y = s, x < shift. */
function halfPlaneField(x: number, y: number, s: number, shift: number): number {
  const u = x - shift;
  return Math.sqrt((Math.hypot(u, y - s) + u) / 2);
}

/**
 * Nodes (i, k), |i|, |k| <= L, unit square cells; the sheet lies at height s
 * between rows 0 and 1 for columns i <= 0 (ties as above, the last column's
 * scaled by beta); `boundary` on the outer ring. Conjugate gradients on the
 * symmetric node equations.
 */
function solve(L: number, s: number, beta: number, shift: number): Float64Array {
  const n = 2 * L + 1;
  const at = (i: number, k: number) => i + L + n * (k + L);
  const fixed = new Uint8Array(n * n);
  const u = new Float64Array(n * n);
  // Tie conductance to the sheet (A = 0) per node, and whether the link up from a node is cut.
  const tie = new Float64Array(n * n);
  const cutUp = new Uint8Array(n * n);
  for (let i = -L; i <= 0; i++) {
    const scale = i === 0 ? beta : 1;
    cutUp[at(i, 0)] = 1;
    tie[at(i, 0)] = scale / s;
    tie[at(i, 1)] = scale / (1 - s);
  }
  for (let k = -L; k <= L; k++) for (let i = -L; i <= L; i++) {
    if (Math.abs(i) === L || Math.abs(k) === L) {
      fixed[at(i, k)] = 1;
      u[at(i, k)] = halfPlaneField(i, k, s, shift);
    }
  }
  const apply = (v: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let k = -L; k <= L; k++) for (let i = -L; i <= L; i++) {
      const c = at(i, k);
      out[c] += tie[c] * v[c];
      if (i < L) {
        const d = v[c + 1] - v[c];
        out[c] -= d;
        out[c + 1] += d;
      }
      if (k < L && !cutUp[c]) {
        const d = v[c + n] - v[c];
        out[c] -= d;
        out[c + n] += d;
      }
    }
  };
  const r = new Float64Array(n * n);
  apply(u, r);
  for (let c = 0; c < n * n; c++) r[c] = fixed[c] ? 0 : -r[c];
  const p = Float64Array.from(r);
  const q = new Float64Array(n * n);
  const x = new Float64Array(n * n);
  let rr = r.reduce((sum, v) => sum + v * v, 0);
  for (let iter = 0; iter < 40 * n && rr > 1e-26; iter++) {
    for (let c = 0; c < n * n; c++) if (fixed[c]) p[c] = 0;
    apply(p, q);
    let pq = 0;
    for (let c = 0; c < n * n; c++) if (!fixed[c]) pq += p[c] * q[c];
    const alpha = rr / pq;
    let next = 0;
    for (let c = 0; c < n * n; c++) {
      if (fixed[c]) continue;
      x[c] += alpha * p[c];
      r[c] -= alpha * q[c];
      next += r[c] * r[c];
    }
    for (let c = 0; c < n * n; c++) p[c] = r[c] + (next / rr) * p[c];
    rr = next;
  }
  for (let c = 0; c < n * n; c++) if (!fixed[c]) u[c] = x[c];
  return u;
}

/**
 * Where the discrete rim sits, in cells past the last crossed column, for a
 * sheet at fraction s across the cell and the last column's ties scaled by
 * beta. Linear in the boundary data, so two solves (shift 0 and 1) and the
 * projection on the shift mode d/dshift Re sqrt(z - shift) on a ring halfway
 * out give it (as yeeEdgeOffset).
 */
export function sheetRimShiftCells(s: number, beta: number, L = 40): number {
  if (!(s > 0 && s < 1)) throw new Error(`sheet fraction s must be inside (0, 1), got ${s}`);
  if (!(beta > 0)) throw new Error(`tie scale must be positive, got ${beta}`);
  const n = 2 * L + 1;
  const ring = L / 2;
  const deviation = (shift: number) => {
    const u = solve(L, s, beta, shift);
    let sum = 0;
    for (let k = -L + 1; k < L; k++) for (let i = -L + 1; i < L; i++) {
      const rad = Math.hypot(i, k - s);
      if (Math.abs(rad - ring) >= 1) continue;
      const mode = -halfPlaneField(i, k, s, 0) / (2 * rad);
      sum += (u[i + L + n * (k + L)] - halfPlaneField(i, k, s, shift)) * mode;
    }
    return sum;
  };
  const [d0, d1] = [deviation(0), deviation(1)];
  return -d0 / (d1 - d0);
}

/** The table the sheet update reads (generated by scripts/validate/sheet_rim_table.ts, checked by a test). */
export interface SheetRimTable {
  /** Sheet fractions s in (0, 0.5], ascending (the problem is symmetric in s and 1 - s). */
  s: number[];
  /** Tie scales, ascending. */
  beta: number[];
  /** shift[m][n]: sheetRimShiftCells(s[m], beta[n]). */
  shift: number[][];
}

/**
 * The tie scale that puts the discrete rim `t` cells past the last crossed
 * column (t may be negative), for a sheet at fraction s: interpolated in s
 * and log beta from the table, clamped to its beta range.
 */
export function rimTieScale(table: SheetRimTable, s: number, t: number): number {
  const sym = Math.min(s, 1 - s);
  const ss = table.s;
  let m = 0;
  while (m + 2 < ss.length && ss[m + 1] < sym) m++;
  const w = Math.max(0, Math.min(1, (sym - ss[m]) / (ss[m + 1] - ss[m])));
  const row = table.shift[m].map((v, n) => (1 - w) * v + w * table.shift[m + 1][n]);
  const lb = table.beta.map(Math.log);
  if (t <= row[0]) return table.beta[0];
  for (let n = 0; n + 1 < row.length; n++) {
    if (t <= row[n + 1]) return Math.exp(lb[n] + ((t - row[n]) / (row[n + 1] - row[n])) * (lb[n + 1] - lb[n]));
  }
  return table.beta[table.beta.length - 1];
}

const logBetas = new WeakMap<SheetRimTable, number[]>();

/** Where the discrete rim sits for tie scale beta (interpolated in s and log beta from the table). */
export function rimShiftFromTable(table: SheetRimTable, s: number, beta: number): number {
  const sym = Math.min(s, 1 - s);
  const ss = table.s;
  let m = 0;
  while (m + 2 < ss.length && ss[m + 1] < sym) m++;
  const w = Math.max(0, Math.min(1, (sym - ss[m]) / (ss[m + 1] - ss[m])));
  const lb = logBetas.get(table) ?? logBetas.set(table, table.beta.map(Math.log)).get(table)!;
  const x = Math.min(lb[lb.length - 1], Math.max(lb[0], Math.log(beta)));
  let n = 0;
  while (n + 2 < lb.length && lb[n + 1] < x) n++;
  const v = (x - lb[n]) / (lb[n + 1] - lb[n]);
  const row = (r: number) => (1 - v) * table.shift[r][n] + v * table.shift[r][n + 1];
  return (1 - w) * row(m) + w * row(m + 1);
}

/**
 * The tie scales a rim at sheet fraction s may use: [1 / k, k] with the
 * smallest k whose rims span exactly one cell. One cell is what a rim needs:
 * as the true rim moves through a cell, its distance past the last crossed
 * edge sweeps one cell. Of the ranges that reach that far, the one symmetric
 * in log beta changes the material least (the largest |ln beta| is smallest).
 * Throws if the table cannot reach a cell at s.
 */
export function rimBetaRange(table: SheetRimTable, s: number): [number, number] {
  const cache = betaRanges.get(table) ?? betaRanges.set(table, new Map()).get(table)!;
  const key = Math.min(s, 1 - s);
  const hit = cache.get(key);
  if (hit) return hit;
  const reach = (k: number) => rimShiftFromTable(table, s, k) - rimShiftFromTable(table, s, 1 / k);
  let [lo, hi] = [0, Math.log(Math.min(table.beta[table.beta.length - 1], 1 / table.beta[0]))];
  if (reach(Math.exp(hi)) < 1) throw new Error(`the rim table cannot move a rim over a full cell at sheet fraction ${s}; regenerate it with a wider beta range`);
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (reach(Math.exp(mid)) < 1) lo = mid;
    else hi = mid;
  }
  const range: [number, number] = [Math.exp(-hi), Math.exp(hi)];
  cache.set(key, range);
  return range;
}
const betaRanges = new WeakMap<SheetRimTable, Map<number, [number, number]>>();

/**
 * How far to grow a sheet past its rims, in cells: then wherever the true
 * rim falls inside a cell, it lies within the one cell that the tie scales
 * of rimBetaRange reach from the last crossed edge.
 */
export function rimGrowCells(table: SheetRimTable, s: number): number {
  return -rimShiftFromTable(table, s, rimBetaRange(table, s)[0]);
}
