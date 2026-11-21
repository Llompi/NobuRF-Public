import type { PlanePhasor } from './field_phasor';

/**
 * Far-field pattern of a patch from the tangential E field on a plane just
 * above the board (aperture method, Balanis ch. 12).
 *
 * The plane is treated as an aperture in an infinite ground plane: the
 * equivalent magnetic current is M = -2 n x E, so the pattern covers the upper
 * hemisphere only and ignores radiation past the finite ground's edges. That
 * is the standard first-order approximation for a patch; the UI labels it.
 *
 *   F_x,y(theta, phi) = sum E_x,y(x, y) exp(j k (x sin(theta) cos(phi) + y sin(theta) sin(phi))) dA
 *   E_theta ~ F_x cos(phi) + F_y sin(phi)
 *   E_phi   ~ cos(theta) (F_y cos(phi) - F_x sin(phi))
 */
export interface FarFieldPattern {
  thetaDeg: Float32Array;
  phiDeg: Float32Array;
  /** Directive gain in dBi at [thetaIndex * phiCount + phiIndex]. */
  gainDbi: Float32Array;
  /** Peak directivity (dBi). Lossless model, so gain = directivity. */
  peakDbi: number;
  peakThetaDeg: number;
  peakPhiDeg: number;
}

export interface ApertureGrid {
  nx: number;
  ny: number;
  dxMm: number;
  /** Cells to skip at each edge (the PML holds no physical field). */
  borderCells: number;
}

export function apertureFarField(
  ex: PlanePhasor,
  ey: PlanePhasor,
  grid: ApertureGrid,
  frequencyHz: number,
  { thetaSteps = 31, phiSteps = 72 }: { thetaSteps?: number; phiSteps?: number } = {},
): FarFieldPattern {
  const { nx, ny, dxMm, borderCells } = grid;
  const dx = dxMm * 1e-3;
  const k = (2 * Math.PI * frequencyHz) / 299792458;
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;

  // Ex lives at (i + 1/2, j), Ey at (i, j + 1/2) on the Yee grid. The phase
  // term factorises as exp(j kx x) exp(j ky y), so each direction is a sum over
  // rows of (row sum weighted by exp(j kx x)) times exp(j ky y): no trig per cell.
  const i0 = borderCells, i1 = nx - borderCells;
  const j0 = borderCells, j1 = ny - borderCells;
  const cols = i1 - i0;
  const xEx = new Float64Array(cols), xEy = new Float64Array(cols);
  for (let c = 0; c < cols; c++) {
    xEx[c] = (i0 + c + 0.5 - cx) * dx;
    xEy[c] = (i0 + c - cx) * dx;
  }
  const phaseX = new Float64Array(cols * 4); // cos/sin at Ex and Ey positions
  const sumRows = (field: PlanePhasor, xOffset: 0 | 2, yShift: number, ky: number, out: Float64Array, outOffset: number) => {
    let accRe = 0, accIm = 0;
    for (let j = j0; j < j1; j++) {
      let rowRe = 0, rowIm = 0;
      const base = j * nx + i0;
      for (let c = 0; c < cols; c++) {
        const cr = phaseX[c * 4 + xOffset], ci = phaseX[c * 4 + xOffset + 1];
        const er = field.re[base + c], ei = field.im[base + c];
        rowRe += er * cr - ei * ci;
        rowIm += er * ci + ei * cr;
      }
      const ay = ky * (j + yShift - cy) * dx;
      const cr = Math.cos(ay), ci = Math.sin(ay);
      accRe += rowRe * cr - rowIm * ci;
      accIm += rowRe * ci + rowIm * cr;
    }
    out[outOffset] = accRe;
    out[outOffset + 1] = accIm;
  };

  const thetaDeg = new Float32Array(thetaSteps);
  const phiDeg = new Float32Array(phiSteps);
  for (let t = 0; t < thetaSteps; t++) thetaDeg[t] = (90 * t) / (thetaSteps - 1);
  for (let p = 0; p < phiSteps; p++) phiDeg[p] = (360 * p) / phiSteps;

  const intensity = new Float64Array(thetaSteps * phiSteps);
  const sums = new Float64Array(4);
  for (let t = 0; t < thetaSteps; t++) {
    const theta = (thetaDeg[t] * Math.PI) / 180;
    for (let p = 0; p < phiSteps; p++) {
      const phi = (phiDeg[p] * Math.PI) / 180;
      const kx = k * Math.sin(theta) * Math.cos(phi);
      const ky = k * Math.sin(theta) * Math.sin(phi);
      for (let c = 0; c < cols; c++) {
        phaseX[c * 4] = Math.cos(kx * xEx[c]);
        phaseX[c * 4 + 1] = Math.sin(kx * xEx[c]);
        phaseX[c * 4 + 2] = Math.cos(kx * xEy[c]);
        phaseX[c * 4 + 3] = Math.sin(kx * xEy[c]);
      }
      sumRows(ex, 0, 0, ky, sums, 0);
      sumRows(ey, 2, 0.5, ky, sums, 2);
      const [fxRe, fxIm, fyRe, fyIm] = sums;
      const cp = Math.cos(phi), sp = Math.sin(phi), ct = Math.cos(theta);
      const thRe = fxRe * cp + fyRe * sp, thIm = fxIm * cp + fyIm * sp;
      const phRe = ct * (fyRe * cp - fxRe * sp), phIm = ct * (fyIm * cp - fxIm * sp);
      intensity[t * phiSteps + p] = thRe * thRe + thIm * thIm + phRe * phRe + phIm * phIm;
    }
  }

  // Radiated power over the upper hemisphere: sum U sin(theta) dtheta dphi (trapezoid in theta).
  const dTheta = ((90 / (thetaSteps - 1)) * Math.PI) / 180;
  const dPhi = (2 * Math.PI) / phiSteps;
  let power = 0;
  for (let t = 0; t < thetaSteps; t++) {
    const weight = t === 0 || t === thetaSteps - 1 ? 0.5 : 1;
    const sinTheta = Math.sin((thetaDeg[t] * Math.PI) / 180);
    for (let p = 0; p < phiSteps; p++) power += weight * intensity[t * phiSteps + p] * sinTheta * dTheta * dPhi;
  }
  if (!(power > 0)) throw new Error('apertureFarField: no radiated power (empty aperture field)');

  const gainDbi = new Float32Array(intensity.length);
  let peak = 0;
  for (let n = 0; n < intensity.length; n++) {
    gainDbi[n] = 10 * Math.log10(Math.max(1e-12, (4 * Math.PI * intensity[n]) / power));
    if (gainDbi[n] > gainDbi[peak]) peak = n;
  }
  return {
    thetaDeg, phiDeg, gainDbi,
    peakDbi: gainDbi[peak],
    peakThetaDeg: thetaDeg[Math.floor(peak / phiSteps)],
    peakPhiDeg: phiDeg[peak % phiSteps],
  };
}
