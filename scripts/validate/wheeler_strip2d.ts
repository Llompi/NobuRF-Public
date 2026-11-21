/**
 * Conductor loss of a boxed microstrip with a strip of real thickness, from
 * Wheeler's incremental-inductance rule on a 2D Laplace solve:
 *   alpha_c = Rs / (2 Z0 eta0) * dZ0_air/dn,   Z0_air = eta0 / q_air,
 * where n is how far every lossy wall recedes into its conductor and q is the
 * capacitance per length over eps0. The strip recedes on all four sides and
 * the ground plane recedes downwards; the box side walls and lid stay put,
 * because in the FDTD resonator they are PEC and dissipate nothing.
 *
 * q comes from the field energy of the discrete solution (sum over links of
 * eps * dual / length * dV^2), which is variational and converges smoothly
 * even with the strip corners' r^(-1/3) singularity. It is the reference for
 * the edge-loss correction (voxelize.ts edgeLossFactor): an independent
 * thick-strip calculation that shares nothing with the zero-thickness model.
 *
 *   npx tsx scripts/validate/wheeler_strip2d.ts [W mm] [t mm] [fine mm]
 */
import { C0 } from '../../src/engine/config';

const ETA0 = 4e-7 * Math.PI * C0;
const COARSE_MM = 0.1;
const GROWTH = 1.15;

/** Lines from lo to hi through every point, `fine` at each point, growing by GROWTH up to COARSE_MM. */
function gradedLines(points: number[], fine: number): number[] {
  const sorted = [...new Set(points)].sort((p, q) => p - q);
  const lines = [sorted[0]];
  for (let n = 1; n < sorted.length; n++) {
    const [a, b] = [sorted[n - 1], sorted[n]];
    const half: number[] = [];
    for (let w = fine, reach = 0; 2 * reach < b - a; w = Math.min(w * GROWTH, COARSE_MM)) {
      half.push(w);
      reach += w;
    }
    const cells = [...half, ...half.reverse()];
    const scale = (b - a) / cells.reduce((s, w) => s + w, 0);
    for (let m = 0; m < cells.length - 1; m++) lines.push(lines[lines.length - 1] + cells[m] * scale);
    lines.push(b);
  }
  return lines;
}

interface Strip { widthMm: number; thicknessMm: number; heightMm: number; boxWidthMm: number; boxHeightMm: number }

/** Capacitance per length over eps0 of the strip at 1 V in a grounded box, substrate eps below heightMm. */
export function stripCapacitance(s: Strip, epsR: number, fineMm: number): number {
  const xs = gradedLines([-s.boxWidthMm / 2, -s.widthMm / 2, s.widthMm / 2, s.boxWidthMm / 2], fineMm);
  const ys = gradedLines([0, s.heightMm, s.heightMm + s.thicknessMm, s.boxHeightMm], fineMm);
  const [nx, ny] = [xs.length, ys.length];
  const tol = 1e-9;
  const v = new Float64Array(nx * ny);
  const fixed = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const onStrip = Math.abs(xs[i]) <= s.widthMm / 2 + tol && ys[j] >= s.heightMm - tol && ys[j] <= s.heightMm + s.thicknessMm + tol;
    if (onStrip || i === 0 || j === 0 || i === nx - 1 || j === ny - 1) {
      fixed[i + nx * j] = 1;
      v[i + nx * j] = onStrip ? 1 : 0;
    }
  }
  // Links of the 5-point stencil with their weights, built cell by cell.
  const from: number[] = [], to: number[] = [], weight: number[] = [];
  const link = (p: number, q: number, w: number) => { from.push(p); to.push(q); weight.push(w); };
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const [dx, dy] = [xs[i + 1] - xs[i], ys[j + 1] - ys[j]];
    const eps = ys[j + 1] <= s.heightMm + tol ? epsR : 1;
    const c = i + nx * j;
    link(c, c + 1, (eps * dy) / 2 / dx);
    link(c + nx, c + nx + 1, (eps * dy) / 2 / dx);
    link(c, c + nx, (eps * dx) / 2 / dy);
    link(c + 1, c + nx + 1, (eps * dx) / 2 / dy);
  }
  const apply = (x: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let l = 0; l < from.length; l++) {
      const flow = weight[l] * (x[from[l]] - x[to[l]]);
      out[from[l]] += flow;
      out[to[l]] -= flow;
    }
  };
  const diagonal = new Float64Array(nx * ny);
  for (let l = 0; l < from.length; l++) { diagonal[from[l]] += weight[l]; diagonal[to[l]] += weight[l]; }
  // Preconditioned conjugate gradients on the free nodes.
  const r = new Float64Array(nx * ny), z = new Float64Array(nx * ny), p = new Float64Array(nx * ny), ap = new Float64Array(nx * ny);
  apply(v, r);
  for (let c = 0; c < r.length; c++) r[c] = fixed[c] ? 0 : -r[c];
  for (let c = 0; c < r.length; c++) p[c] = z[c] = r[c] / diagonal[c];
  let rz = r.reduce((sum, rc, c) => sum + rc * z[c], 0);
  const start = rz;
  for (let iter = 0; iter < 20000 && rz > 1e-24 * start; iter++) {
    apply(p, ap);
    let pap = 0;
    for (let c = 0; c < p.length; c++) if (!fixed[c]) pap += p[c] * ap[c];
    const step = rz / pap;
    let next = 0;
    for (let c = 0; c < p.length; c++) {
      if (fixed[c]) continue;
      v[c] += step * p[c];
      r[c] -= step * ap[c];
      z[c] = r[c] / diagonal[c];
      next += r[c] * z[c];
    }
    for (let c = 0; c < p.length; c++) p[c] = fixed[c] ? 0 : z[c] + (next / rz) * p[c];
    rz = next;
  }
  let energy = 0;
  for (let l = 0; l < from.length; l++) energy += weight[l] * (v[from[l]] - v[to[l]]) ** 2;
  return energy;
}

/** Z0 and alpha_c / Rs (Np/m per ohm) of the boxed thick strip. */
export function wheelerConductorLoss(s: Strip, epsR: number, fineMm = 0.002, recessMm = 0.001) {
  const receded = (d: number) => stripCapacitance({ ...s, widthMm: s.widthMm - 2 * d, thicknessMm: s.thicknessMm - 2 * d, heightMm: s.heightMm + 2 * d, boxHeightMm: s.boxHeightMm + d }, 1, fineMm);
  const qAir = receded(0);
  const z0Ohm = ETA0 / Math.sqrt(qAir * stripCapacitance(s, epsR, fineMm));
  const dqPerMm = (receded(recessMm) - receded(-recessMm)) / (2 * recessMm);
  return { z0Ohm, alphaPerOhm: (-dqPerMm / qAir ** 2) * 1000 / (2 * z0Ohm) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [w, t, fine] = [Number(process.argv[2] ?? 0.5), Number(process.argv[3] ?? 0.035), Number(process.argv[4] ?? 0.002)];
  const r = wheelerConductorLoss({ widthMm: w, thicknessMm: t, heightMm: 0.5, boxWidthMm: w + 5.2, boxHeightMm: 3 }, 9.9, fine);
  console.log(`W ${w} mm, t ${t} mm, fine ${fine} mm: Z0 ${r.z0Ohm.toFixed(3)} ohm, alpha_c / Rs ${r.alphaPerOhm.toFixed(4)} Np/m/ohm`);
}
