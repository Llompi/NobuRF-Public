import { C0, ETA0 } from './config';
import { cellWidth, type MeshLines } from './mesh';
import type { HuygensSurface } from './huygens_box';
import { equivalentCurrents, sourcePhasor, type Complex } from './near_to_far';
import { planeDftIndex, type PlaneDftComponent, type PlaneDftLayout } from './plane_dft';
import type { ExcitationConfig } from './types';

/**
 * Near fields, for emissions work: the E and H phasors at points close to the
 * board, in V/m and A/m for a 1 V peak source behind the port's reference
 * resistance (the normalisation near_to_far.ts uses). Two routes:
 *
 *   - Inside the grid (scanPlane): the solver's own fields on a z node plane,
 *     from the plane DFT (plane_dft.ts), each component interpolated to the
 *     plane's nodes. Hz is not in the plane DFT; it comes from Faraday's law
 *     on the E of that plane, in the discrete form the solver steps:
 *       Hz (2 j sin(w dt / 2) / dt) = -(curl E)_z / mu0
 *     which reproduces the solver's Hz to rounding.
 *
 *   - Outside the Huygens box (radiatedField): the field of the box's
 *     equivalent currents (J = n x H, M = -n x E) in free space, with the full
 *     Green's function rather than its far-field limit, so it holds at any
 *     distance outside the box. Each patch is a point source at its centre,
 *     split into sub-patches when the point is within a few patch widths
 *     (the midpoint rule's error grows as (width / distance)^2 there). The
 *     currents are still sampled once per cell, so the field a cell or two
 *     outside the box is only as good as that sampling: tests/near_field.test.ts
 *     measures it.
 *
 * Phasors are e^{+j w t} (the DFTs use exp(-j w t)). For each patch with
 * p = J dA, m = M dA, R = r - r' = R u, G = exp(-j k R) / (4 pi R) and
 * x = k R:
 *   a = 1 - j/x - 1/x^2,  b = 1 - 3j/x - 3/x^2
 *   E = -j k eta0 G (a p - b (u.p) u) - (j k + 1/R) G (m x u)
 *   H = -j (k / eta0) G (a m - b (u.m) u) + (j k + 1/R) G (p x u)
 * (Balanis, Antenna Theory, ch. 4 and 6; the far-field limit is the
 * transform in near_to_far.ts.)
 */

/** One complex field component on the nx * ny nodes of a plane, index i + nx * j. */
export interface ComplexPlane {
  re: Float32Array;
  im: Float32Array;
}

export const SCAN_COMPONENTS = ['ex', 'ey', 'ez', 'hx', 'hy', 'hz'] as const;
export type ScanComponent = (typeof SCAN_COMPONENTS)[number];

/** All six components at the nodes of one z plane: E in V/m, H in A/m, peak, for a 1 V source. */
export type ScanPlane = Record<ScanComponent, ComplexPlane>;

/** Values per point in radiatedField's output: re, im of Ex, Ey, Ez, Hx, Hy, Hz. */
export const VALUES_PER_POINT = 12;

const divide = ([ar, ai]: Complex, [br, bi]: Complex): Complex => {
  const den = br * br + bi * bi;
  return [(ar * br + ai * bi) / den, (ai * br - ar * bi) / den];
};

/** The plane DFT planes a scan at node plane k needs: H and Ez sit half a cell either side of it. */
export function scanPlanesK(k: number): [number, number] {
  return [k - 1, k];
}

/**
 * Weight of the sample at the centre of cell n - 1 when interpolating to node n
 * from the centres of cells n - 1 and n (the one at n gets 1 - it). 1/2 on a
 * uniform mesh.
 */
function belowWeight(lines: Float64Array, n: number): number {
  const below = cellWidth(lines, n - 1);
  const above = cellWidth(lines, n);
  return above / (below + above);
}

export interface ScanPlaneInput {
  /** Plane DFT sums and their layout; the layout must hold planes k - 1 and k. */
  accumulators: ArrayLike<number>;
  layout: PlaneDftLayout;
  frequencyIndex: number;
  /** Node plane of the scan. */
  k: number;
  mesh: MeshLines;
  /** Smallest cell (mm), grid.dxMm: e = E * dRef and h = eta0 * H * dRef. */
  dRefMm: number;
  dtSec: number;
  /** DFT of the source voltage at this frequency (near_to_far.ts sourcePhasor). */
  source: Complex;
}

/**
 * E and H at every node of z plane k, from the solver's plane DFT. Nodes on
 * the outer rows and columns, whose stencils fall off the grid, are left 0;
 * callers crop the PML anyway.
 */
export function scanPlane(input: ScanPlaneInput): ScanPlane {
  const { accumulators: acc, layout, frequencyIndex: f, k, mesh, source } = input;
  const { nx, ny } = layout;
  const below = layout.planesK.indexOf(k - 1);
  const at = layout.planesK.indexOf(k);
  if (below < 0 || at < 0) throw new Error(`near-field scan at plane ${k} needs planes ${k - 1} and ${k} in the plane DFT, got [${layout.planesK.join(', ')}]`);
  const dRef = input.dRefMm * 1e-3;
  const plane = (): ComplexPlane => ({ re: new Float32Array(nx * ny), im: new Float32Array(nx * ny) });
  const out: ScanPlane = { ex: plane(), ey: plane(), ez: plane(), hx: plane(), hy: plane(), hz: plane() };
  // Raw phasor of a component at Yee index (i, j) of a plane, in V/m or A/m for a 1 V source.
  const scale = { e: 1 / dRef, h: 1 / (ETA0 * dRef) };
  const raw = (p: number, component: PlaneDftComponent, i: number, j: number): Complex => {
    const n = planeDftIndex(layout, p, f, component, i, j);
    const s = component[0] === 'e' ? scale.e : scale.h;
    return divide([acc[n] * s, acc[n + 1] * s], source);
  };
  const omega = 2 * Math.PI * layout.frequenciesHz[f];
  // Faraday's law as the solver steps it: H at half steps, E at whole steps.
  const jOmegaMu: Complex = [0, ((2 / input.dtSec) * Math.sin((omega * input.dtSec) / 2)) * (ETA0 / C0)];
  // Hz at Yee (i + 1/2, j + 1/2, k) from the curl of E on plane k.
  const hzYee = (i: number, j: number): Complex => {
    const dx = cellWidth(mesh.x, i) * 1e-3;
    const dy = cellWidth(mesh.y, j) * 1e-3;
    const [ey0, ey1, ex0, ex1] = [raw(at, 'ey', i, j), raw(at, 'ey', i + 1, j), raw(at, 'ex', i, j), raw(at, 'ex', i, j + 1)];
    const curl: Complex = [(ey1[0] - ey0[0]) / dx - (ex1[0] - ex0[0]) / dy, (ey1[1] - ey0[1]) / dx - (ex1[1] - ex0[1]) / dy];
    const [re, im] = divide(curl, jOmegaMu);
    return [-re, -im];
  };
  const wz = belowWeight(mesh.z, k);
  const mix = (a: Complex, b: Complex, wa: number): Complex => [wa * a[0] + (1 - wa) * b[0], wa * a[1] + (1 - wa) * b[1]];
  const put = (target: ComplexPlane, node: number, [re, im]: Complex) => {
    target.re[node] = re;
    target.im[node] = im;
  };
  for (let j = 1; j < ny - 1; j++) {
    const wy = belowWeight(mesh.y, j);
    for (let i = 1; i < nx - 1; i++) {
      const wx = belowWeight(mesh.x, i);
      const node = i + nx * j;
      put(out.ex, node, mix(raw(at, 'ex', i - 1, j), raw(at, 'ex', i, j), wx));
      put(out.ey, node, mix(raw(at, 'ey', i, j - 1), raw(at, 'ey', i, j), wy));
      put(out.ez, node, mix(raw(below, 'ez', i, j), raw(at, 'ez', i, j), wz));
      // Hx at (i, j + 1/2, k + 1/2): interpolate in y, then in z. Hy likewise in x.
      const hxIn = (p: number) => mix(raw(p, 'hx', i, j - 1), raw(p, 'hx', i, j), wy);
      const hyIn = (p: number) => mix(raw(p, 'hy', i - 1, j), raw(p, 'hy', i, j), wx);
      put(out.hx, node, mix(hxIn(below), hxIn(at), wz));
      put(out.hy, node, mix(hyIn(below), hyIn(at), wz));
      put(out.hz, node, mix(mix(hzYee(i - 1, j - 1), hzYee(i, j - 1), wx), mix(hzYee(i - 1, j), hzYee(i, j), wx), wy));
    }
  }
  return out;
}

/** The box currents of one frequency, ready to radiate. */
export interface BoxSources {
  surface: HuygensSurface;
  frequencyHz: number;
  currentJ: Float64Array;
  currentM: Float64Array;
}

/** The box's equivalent currents at frequency index `frequencyIndex`, for a 1 V source. */
export function boxSources(
  surface: HuygensSurface, accumulators: ArrayLike<number>, frequenciesHz: readonly number[], frequencyIndex: number,
  exc: ExcitationConfig, dtSec: number, steps: number,
): BoxSources {
  const frequencyHz = frequenciesHz[frequencyIndex];
  const source = sourcePhasor(exc, dtSec, steps, frequencyHz);
  if (!(Math.hypot(...source) > 0)) throw new Error(`the source has no content at ${frequencyHz / 1e9} GHz`);
  const { currentJ, currentM } = equivalentCurrents(surface, accumulators, frequencyIndex, frequenciesHz.length, source);
  return { surface, frequencyHz, currentJ, currentM };
}

/**
 * E and H at each point (mesh coordinates in mm, [x0, y0, z0, x1, ...]),
 * radiated by the box currents into free space. Every point must lie outside
 * the box: inside it the equivalent currents add up to zero, not to the field.
 * Output: VALUES_PER_POINT numbers per point.
 */
export function radiatedField(sources: BoxSources, pointsMm: ArrayLike<number>): Float64Array {
  const { surface } = sources;
  const k = (2 * Math.PI * sources.frequencyHz) / C0;
  const half = boxHalfExtentM(surface);
  const pointCount = pointsMm.length / 3;
  const out = new Float64Array(VALUES_PER_POINT * pointCount);
  const centre = surface.centreM;
  const field = new Float64Array(VALUES_PER_POINT);
  const r = [0, 0, 0];
  const sub = [0, 0, 0];
  for (let n = 0; n < pointCount; n++) {
    for (let a = 0; a < 3; a++) r[a] = (pointsMm[3 * n + a] - surface.centreMm[a]) * 1e-3;
    if (Math.abs(r[0]) < half[0] && Math.abs(r[1]) < half[1] && Math.abs(r[2]) < half[2]) {
      throw new Error(`radiatedField: point (${[0, 1, 2].map((a) => pointsMm[3 * n + a]).join(', ')}) mm is inside the Huygens box; ` +
        'the box currents give the field outside it only');
    }
    field.fill(0);
    for (let s = 0; s < surface.count; s++) {
      const R = Math.hypot(r[0] - centre[3 * s], r[1] - centre[3 * s + 1], r[2] - centre[3 * s + 2]);
      const [lengthP, lengthQ] = [surface.lengthPM[s], surface.lengthQM[s]];
      const divisions = Math.min(MAX_PATCH_DIVISIONS, Math.ceil((SUBDIVIDE_WITHIN_PATCHES * Math.max(lengthP, lengthQ)) / R));
      if (divisions <= 1) {
        addPointSource(field, sources, s, k, r, [centre[3 * s], centre[3 * s + 1], centre[3 * s + 2]], 1);
        continue;
      }
      // Close to the point the field changes across the patch: spread its current evenly over divisions^2 sub-patches.
      const a = surface.normalAxis[s];
      const p = (a + 1) % 3;
      const q = (a + 2) % 3;
      for (let dq = 0; dq < divisions; dq++) {
        for (let dp = 0; dp < divisions; dp++) {
          sub[a] = centre[3 * s + a];
          sub[p] = centre[3 * s + p] + lengthP * ((dp + 0.5) / divisions - 0.5);
          sub[q] = centre[3 * s + q] + lengthQ * ((dq + 0.5) / divisions - 0.5);
          addPointSource(field, sources, s, k, r, sub, 1 / (divisions * divisions));
        }
      }
    }
    out.set(field, VALUES_PER_POINT * n);
  }
  return out;
}

/**
 * Patches nearer the point than this many patch widths are split into
 * sub-patches; the midpoint rule's error grows as (width / distance)^2 and
 * the near terms of the Green's function as 1 / distance^3.
 */
const SUBDIVIDE_WITHIN_PATCHES = 6;
const MAX_PATCH_DIVISIONS = 12;

/**
 * Adds `weight` times the field of patch s's currents, placed at `at` (m from
 * the box centre), at the point r. Output layout as radiatedField's.
 */
function addPointSource(field: Float64Array, sources: BoxSources, s: number, k: number, r: number[], at: ArrayLike<number>, weight: number): void {
  const { currentJ: J, currentM: M } = sources;
  let ux = r[0] - at[0], uy = r[1] - at[1], uz = r[2] - at[2];
  const R = Math.hypot(ux, uy, uz);
  ux /= R;
  uy /= R;
  uz /= R;
  const x = k * R;
  const inv = 1 / x;
  // a = 1 - j/x - 1/x^2, b = 1 - 3j/x - 3/x^2
  const a0 = 1 - inv * inv, a1 = -inv;
  const b0 = 1 - 3 * inv * inv, b1 = -3 * inv;
  // weight G = weight exp(-j x) / (4 pi R)
  const gr = (weight * Math.cos(x)) / (4 * Math.PI * R), gi = (-weight * Math.sin(x)) / (4 * Math.PI * R);
  // -j k eta0 G, -j (k / eta0) G and (j k + 1/R) G
  const ter = k * ETA0 * gi, tei = -k * ETA0 * gr;
  const thr = (k / ETA0) * gi, thi = -(k / ETA0) * gr;
  const cr = gr / R - k * gi, ci = gi / R + k * gr;
  const j6 = 6 * s;
  const pxr = J[j6], pxi = J[j6 + 1], pyr = J[j6 + 2], pyi = J[j6 + 3], pzr = J[j6 + 4], pzi = J[j6 + 5];
  const mxr = M[j6], mxi = M[j6 + 1], myr = M[j6 + 2], myi = M[j6 + 3], mzr = M[j6 + 4], mzi = M[j6 + 5];
  // b (u.p) and b (u.m), complex
  const dpr = ux * pxr + uy * pyr + uz * pzr, dpi = ux * pxi + uy * pyi + uz * pzi;
  const dmr = ux * mxr + uy * myr + uz * mzr, dmi = ux * mxi + uy * myi + uz * mzi;
  const bpr = b0 * dpr - b1 * dpi, bpi = b0 * dpi + b1 * dpr;
  const bmr = b0 * dmr - b1 * dmi, bmi = b0 * dmi + b1 * dmr;
  // Component c: E_c += te (a p_c - b (u.p) u_c) - c (m x u)_c and H_c += th (a m_c - b (u.m) u_c) + c (p x u)_c.
  const component = (c: number, uc: number, pcr: number, pci: number, mcr: number, mci: number,
    mxur: number, mxui: number, pxur: number, pxui: number) => {
    const ser = a0 * pcr - a1 * pci - bpr * uc, sei = a0 * pci + a1 * pcr - bpi * uc;
    const shr = a0 * mcr - a1 * mci - bmr * uc, shi = a0 * mci + a1 * mcr - bmi * uc;
    field[2 * c] += ter * ser - tei * sei - (cr * mxur - ci * mxui);
    field[2 * c + 1] += ter * sei + tei * ser - (cr * mxui + ci * mxur);
    field[6 + 2 * c] += thr * shr - thi * shi + (cr * pxur - ci * pxui);
    field[6 + 2 * c + 1] += thr * shi + thi * shr + (cr * pxui + ci * pxur);
  };
  // The last four arguments: (m x u)_c and (p x u)_c, real and imaginary parts.
  component(0, ux, pxr, pxi, mxr, mxi, myr * uz - mzr * uy, myi * uz - mzi * uy, pyr * uz - pzr * uy, pyi * uz - pzi * uy);
  component(1, uy, pyr, pyi, myr, myi, mzr * ux - mxr * uz, mzi * ux - mxi * uz, pzr * ux - pxr * uz, pzi * ux - pxi * uz);
  component(2, uz, pzr, pzi, mzr, mzi, mxr * uy - myr * ux, mxi * uy - myi * ux, pxr * uy - pyr * ux, pxi * uy - pyi * ux);
}

/** Half the box's extent along each axis (m): the largest |centre| of the patches on its faces normal to that axis. */
function boxHalfExtentM(surface: HuygensSurface): [number, number, number] {
  const half: [number, number, number] = [0, 0, 0];
  for (let s = 0; s < surface.count; s++) {
    const a = surface.normalAxis[s];
    half[a] = Math.max(half[a], Math.abs(surface.centreM[3 * s + a]));
  }
  return half;
}

/** |E| or |H| of one point of radiatedField's output: the root sum of squares of the three components' magnitudes. */
export function vectorMagnitude(values: ArrayLike<number>, point: number, field: 'e' | 'h'): number {
  const base = VALUES_PER_POINT * point + (field === 'e' ? 0 : 6);
  let sum = 0;
  for (let n = 0; n < 6; n++) sum += values[base + n] ** 2;
  return Math.sqrt(sum);
}

/**
 * |E| (V/m, peak, 1 V source) at `distanceM` from the box centre in the
 * direction (thetaDeg, phiDeg), from the full transform: in the far zone it
 * is |r E| / r, and it stays right closer in, where the 1/r^2 and 1/r^3
 * terms are not yet negligible.
 */
export function fieldStrengthAt(sources: BoxSources, distanceM: number, thetaDeg: number, phiDeg: number): number {
  const [t, p] = [(thetaDeg * Math.PI) / 180, (phiDeg * Math.PI) / 180];
  const direction = [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
  const point = direction.map((d, a) => sources.surface.centreMm[a] + d * distanceM * 1e3);
  return vectorMagnitude(radiatedField(sources, point), 0, 'e');
}
