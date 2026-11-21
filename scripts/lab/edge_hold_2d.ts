/**
 * Why corrected copper edges hold uniform cells, and for how long: a 2D lab.
 *
 * The TEM Z0 of a homogeneous stripline on the FDTD mesh equals the Z0 of the
 * discrete 5-point Laplace problem on its (x, z) cross-section (checked
 * against the 3D solver to 1e-5). This script builds that cross-section the
 * way the graded mesher does: strip nodes with the edge lines moved inside
 * by the sheet-edge offset (yee_edge.ts), `hold` uniform edge cells beyond
 * each edge line and in z either side of the strip, then growth by `g` up to
 * a cap. It prints the Z0 error against Cohn's exact formula as the edge
 * cell is refined, for:
 *   - growth right at the edge (hold 1 cell),
 *   - a hold of a fixed number of cells (4, 8, 16, 32, 64),
 *   - a hold of a fixed length (the distance to the ground, b / 2),
 *   - the rule rasterise.ts ships: b / 2, but at most the 20-cell ring the
 *     offset is measured on (SHEET_EDGE_OFFSET_RING_CELLS).
 * A fixed cell count leaves an error floor that refining does not remove; a
 * fixed length converges. rasterise.ts (sheetEdgeHoldMm) cites these numbers.
 *
 *   npx tsx scripts/lab/edge_hold_2d.ts
 */
import { SHEET_EDGE_OFFSET_RING_CELLS, sheetEdgeOffsetCells } from '../../src/engine/yee_edge';

/** Complete elliptic integral of the first kind K(k), by the arithmetic-geometric mean. */
function ellipticK(k: number): number {
  let [a, b] = [1, Math.sqrt(1 - k * k)];
  while (Math.abs(a - b) > 1e-15 * a) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
}

/** Cohn's exact Z0 of a zero-thickness centred stripline, width W, ground spacing b (any length unit). */
export function cohnZ0(w: number, b: number, epsR: number): number {
  const k = 1 / Math.cosh((Math.PI * w) / (2 * b));
  return ((30 * Math.PI) / Math.sqrt(epsR)) * (ellipticK(k) / ellipticK(Math.sqrt(1 - k * k)));
}

/** Z0 of the discrete Laplace problem: potential 1 on the strip nodes, 0 on the box (grounds and side walls). */
export function laplaceZ0(x: Float64Array, z: Float64Array, onStrip: (i: number) => boolean, kStrip: number, epsR: number): number {
  const [nx, nz] = [x.length, z.length];
  const phi = new Float64Array(nx * nz);
  const fixed = new Uint8Array(nx * nz);
  const id = (i: number, k: number) => i + nx * k;
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    if (k === 0 || k === nz - 1 || i === 0 || i === nx - 1) fixed[id(i, k)] = 1;
    if (k === kStrip && onStrip(i)) [fixed[id(i, k)], phi[id(i, k)]] = [1, 1];
  }
  const hx = (i: number) => x[i + 1] - x[i];
  const hz = (k: number) => z[k + 1] - z[k];
  // The finite-volume 5-point Laplacian on the free nodes, A v (symmetric), solved by conjugate gradients.
  const apply = (v: Float64Array, out: Float64Array) => {
    for (let k = 1; k < nz - 1; k++) for (let i = 1; i < nx - 1; i++) {
      const c = id(i, k);
      if (fixed[c]) { out[c] = 0; continue; }
      const [dx, dz] = [(hx(i - 1) + hx(i)) / 2, (hz(k - 1) + hz(k)) / 2];
      out[c] = (dz / hx(i - 1)) * (v[c] - v[c - 1]) + (dz / hx(i)) * (v[c] - v[c + 1]) + (dx / hz(k - 1)) * (v[c] - v[c - nx]) + (dx / hz(k)) * (v[c] - v[c + nx]);
    }
  };
  const r = new Float64Array(nx * nz);
  apply(phi, r);
  for (let c = 0; c < r.length; c++) r[c] = fixed[c] ? 0 : -r[c];
  const p = Float64Array.from(r);
  const q = new Float64Array(nx * nz);
  let rr = r.reduce((sum, v) => sum + v * v, 0);
  const start = rr;
  for (let it = 0; it < 20 * (nx + nz) * 10 && rr > 1e-28 * start; it++) {
    apply(p, q);
    let pq = 0;
    for (let c = 0; c < p.length; c++) if (!fixed[c]) pq += p[c] * q[c];
    const alpha = rr / pq;
    let next = 0;
    for (let c = 0; c < p.length; c++) {
      if (fixed[c]) continue;
      phi[c] += alpha * p[c];
      r[c] -= alpha * q[c];
      next += r[c] * r[c];
    }
    for (let c = 0; c < p.length; c++) p[c] = fixed[c] ? 0 : r[c] + (next / rr) * p[c];
    rr = next;
  }
  let c = 0; // capacitance per unit length / eps: the discrete field energy at potential 1
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx - 1; i++) {
    const dz = k === 0 ? hz(0) / 2 : k === nz - 1 ? hz(nz - 2) / 2 : (hz(k - 1) + hz(k)) / 2;
    c += ((phi[id(i + 1, k)] - phi[id(i, k)]) ** 2 * dz) / hx(i);
  }
  for (let k = 0; k < nz - 1; k++) for (let i = 0; i < nx; i++) {
    const dx = i === 0 ? hx(0) / 2 : i === nx - 1 ? hx(nx - 2) / 2 : (hx(i - 1) + hx(i)) / 2;
    c += ((phi[id(i, k + 1)] - phi[id(i, k)]) ** 2 * dx) / hz(k);
  }
  return 376.730313668 / (Math.sqrt(epsR) * c);
}

/** Cross-section lines: `hold` uniform cells of h beyond each edge line and either side of the strip in z, then growth g up to `cap`. */
function crossSection(w: number, b: number, h: number, hold: number, g: number, cap: number) {
  const grow = (extent: number) => {
    const p: number[] = [];
    let [u, cell] = [0, h];
    for (let k = 1; u < extent - 1e-9; k++) {
      u += cell;
      p.push(u);
      if (k >= hold) cell = Math.min(cap, cell * g);
    }
    return p;
  };
  const up = grow(b / 2);
  const scale = b / 2 / up[up.length - 1];
  const zu = up.map((u) => u * scale);
  const z = [...zu.map((u) => b / 2 - u).reverse(), b / 2, ...zu.map((u) => b / 2 + u)];
  // The offset for the cells actually at the edge: the z cells either side of the strip, over h.
  const zc = zu[0];
  const s = sheetEdgeOffsetCells(zc / h, zc / h) * h;
  const [xl, xr] = [-w / 2 + s, w / 2 - s];
  const n = Math.max(1, Math.round((xr - xl) / h));
  const inside = Array.from({ length: n + 1 }, (_, i) => xl + (i * (xr - xl)) / n);
  const wall = w / 2 + 6 * b;
  const out = grow(wall - xr);
  const x = [...out.map((u) => xl - u).reverse(), ...inside, ...out.map((u) => xr + u)];
  const lo = out.length;
  return { x: Float64Array.from(x), z: Float64Array.from(z), kStrip: zu.length, onStrip: (i: number) => i >= lo && i <= lo + n };
}

function main(): void {
  // A stripline from the self-verify regression seeds: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm.
  const [w, b, epsR, edge, g] = [1.4194, 2.6806, 5.642, 0.1989, 1.37];
  const exact = cohnZ0(w, b, epsR);
  const refinements = [1, 2, 4, 8, 16];
  console.log(`Z0 error vs Cohn (${exact.toFixed(4)} ohm), % at edge cell / ${refinements.join(', ')}`);
  const row = (label: string, holdCells: (h: number) => number) => {
    const errors = refinements.map((m) => {
      const h = edge / m;
      const cs = crossSection(w, b, h, holdCells(h), g, b / 3 / m);
      return ((laplaceZ0(cs.x, cs.z, cs.onStrip, cs.kStrip, epsR) / exact - 1) * 100).toFixed(3);
    });
    console.log(`${label.padEnd(30)} ${errors.join('  ')}`);
  };
  row('growth at the edge (hold 1)', () => 1);
  for (const cells of [4, 8, 16, 32, 64]) row(`hold ${cells} cells`, () => cells);
  row('hold b/2 (distance to ground)', (h) => Math.max(1, Math.round(b / 2 / h)));
  row(`shipped: min(${SHEET_EDGE_OFFSET_RING_CELLS} cells, b/2)`, (h) => Math.max(1, Math.min(SHEET_EDGE_OFFSET_RING_CELLS, Math.round(b / 2 / h))));
}

if (process.argv[1]?.endsWith('edge_hold_2d.ts')) main();
