/**
 * A slab of a dispersive and/or magnetic material across the 1D TEM line of
 * tem_line.ts (Ez between plates, Hx forced to zero), lit by a pulse at
 * normal incidence. The FDTD reflection and transmission are compared with
 * the closed-form slab (Fresnel plus multiple reflections, e.g. Orfanidis,
 * "Electromagnetic Waves and Antennas", ch. 5) at the material's exact
 * eps(w) and mu(w). This checks the ADE update of dispersion.ts on E and H
 * edges, the interface averaging and the mixing, with no port model in the way.
 *
 * Geometry: the slab fills x in [i0, i1] cells. Ez at nodes i0 and i1 lie
 * on the faces and take half slab, half vacuum; Ez inside and Hy at the half
 * nodes between take the slab. A CPML closes both ends of the line.
 */
import { C0, DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { buildCpml, uniformFaces } from '../../src/engine/cpml';
import {
  DispersionBuilder, relativeValue, VACUUM_RESPONSE, type Complex, type EdgeDispersion, type MediumResponse,
} from '../../src/engine/dispersion';
import { CpuFdtd, vacuumModel } from '../../src/engine/fdtd_cpu';
import { cellWidth } from '../../src/engine/mesh';
import type { GridConfig } from '../../src/engine/types';
import { dielectricEdge, type VoxelModel } from '../../src/engine/voxelize';
import { dft } from './tem_line';

export interface SlabMaterial {
  eps: MediumResponse;
  mu: MediumResponse;
}

export interface SlabSetup {
  dxMm: number;
  /** Slab thickness in cells. */
  cells: number;
  steps: number;
}

export const SLAB_DEFAULT: SlabSetup = { dxMm: 0.25, cells: 40, steps: 6000 };

const PML = 16;
const SOURCE_I = PML + 8;
const PROBE_I = SOURCE_I + 40;
const GAP = 40;
const AFTER = 40;

/** The line's model with the slab, or without it (material null) for the incident run. */
export function slabLineModel(material: SlabMaterial | null, setup: SlabSetup): { model: VoxelModel; i0: number; i1: number } {
  const i0 = PROBE_I + GAP;
  const i1 = i0 + setup.cells;
  const nx = i1 + AFTER + PML + 40;
  const [ny, nz] = [2, 2];
  const grid: GridConfig = { ...DEFAULT_GRID, nx, ny, nz, dxMm: setup.dxMm, pmlCells: PML, groundK: 1 };
  const N = nx * ny * nz;
  const m = vacuumModel(grid, uniformFaces(0));
  m.cpml = buildCpml(grid, { ...uniformFaces(0), xLow: PML, xHigh: PML });
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    m.eCurl[i + nx * j] = 0; // Ex on k = 0
    m.eCurl[N + i + nx * j] = 0; // Ey on k = 0
  }
  if (material) {
    const dt = timestepSec(grid);
    const e = new DispersionBuilder(dt);
    const h = new DispersionBuilder(dt);
    // A stand-in for eDecay/eCurl: the update recovers the curl through them, so any nonzero value is right.
    const standIn = dielectricEdge(grid.courant, relativeValue(material.eps, 5e9)[0], 0);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = i + nx * (j + ny * k);
        const face = i === i0 || i === i1;
        e.add(2 * N + c, face ? [{ response: material.eps, weight: 0.5 }, { response: VACUUM_RESPONSE, weight: 0.5 }] : [{ response: material.eps, weight: 1 }]);
        m.eDecay[2 * N + c] = standIn.decay;
        m.eCurl[2 * N + c] = standIn.curl;
        if (i < i1) h.add(N + c, [{ response: material.mu, weight: 1 }]); // Hy at i + 1/2
      }
    }
    m.dispersion = { e: e.build(), h: h.build() };
  }
  return { model: m, i0, i1 };
}

/** Ez before (reflection probe) and after (transmission probe) the slab, per step. */
function runLine(model: VoxelModel, steps: number, probeAfter: number): { before: Float64Array; after: Float64Array } {
  const { nx, ny, nz } = model.grid;
  const N = nx * ny * nz;
  const s = new CpuFdtd(model);
  const dt = timestepSec(model.grid);
  const before = new Float64Array(steps);
  const after = new Float64Array(steps);
  // Gaussian-modulated sine, about 1-11 GHz.
  const fc = 6e9, tau = 1 / (Math.PI * 7e9), t0 = 4 * tau;
  for (let n = 0; n < steps; n++) {
    s.updateH();
    s.h.fill(0, 0, N); // PMC side walls: Hx = 0
    s.updateE();
    const t = (n + 0.5) * dt, u = (t - t0) / tau;
    const v = Math.exp(-u * u) * Math.sin(2 * Math.PI * fc * (t - t0));
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) s.e[2 * N + SOURCE_I + nx * (j + ny * k)] += v;
    before[n] = s.e[2 * N + PROBE_I];
    after[n] = s.e[2 * N + probeAfter];
  }
  return { before, after };
}

const cmul = ([a, b]: Complex, [c, d]: Complex): Complex => [a * c - b * d, a * d + b * c];
const cdiv = ([a, b]: Complex, [c, d]: Complex): Complex => { const q = c * c + d * d; return [(a * c + b * d) / q, (b * c - a * d) / q]; };
const cadd = ([a, b]: Complex, [c, d]: Complex): Complex => [a + c, b + d];
const csub = ([a, b]: Complex, [c, d]: Complex): Complex => [a - c, b - d];
const cexp = ([a, b]: Complex): Complex => [Math.exp(a) * Math.cos(b), Math.exp(a) * Math.sin(b)];
/** Principal square root (branch cut on the negative real axis). */
function csqrt([a, b]: Complex): Complex {
  const r = Math.hypot(a, b);
  const re = Math.sqrt((r + a) / 2);
  const im = Math.sqrt(Math.max(0, (r - a) / 2));
  return [re, b < 0 ? -im : im];
}

/**
 * Closed-form reflection and transmission of a slab of thickness d in vacuum:
 *   r = (eta - 1) / (eta + 1), eta = sqrt(mu / eps), k = k0 sqrt(mu eps) (Im k <= 0),
 *   P = exp(-j k d), Gamma = r (1 - P^2) / (1 - r^2 P^2), T = (1 - r^2) P / (1 - r^2 P^2).
 * T is relative to the incident wave at the far face, so it is multiplied by exp(+j k0 d).
 */
export function slabExact(material: SlabMaterial, dMetres: number, fHz: number): { gamma: Complex; t: Complex } {
  const eps = relativeValue(material.eps, fHz);
  const mu = relativeValue(material.mu, fHz);
  const eta = csqrt(cdiv(mu, eps));
  const n = csqrt(cmul(mu, eps));
  const k0d = ((2 * Math.PI * fHz) / C0) * dMetres;
  const p = cexp(cmul([0, -k0d], n[1] > 0 ? [-n[0], -n[1]] : n)); // the root with Im(n) <= 0
  const r = cdiv(csub(eta, [1, 0]), cadd(eta, [1, 0]));
  const r2p2 = cmul(cmul(r, r), cmul(p, p));
  const den = csub([1, 0], r2p2);
  const gamma = cdiv(cmul(r, csub([1, 0], cmul(p, p))), den);
  const t = cmul(cdiv(cmul(csub([1, 0], cmul(r, r)), p), den), [Math.cos(k0d), Math.sin(k0d)]);
  return { gamma, t };
}

export interface SlabResult {
  fHz: number;
  gamma: Complex;
  t: Complex;
  exact: { gamma: Complex; t: Complex };
}

/**
 * FDTD reflection at the slab's front face and transmission at its back face,
 * at each frequency, next to the closed form. Probe offsets are taken out
 * with the vacuum wavenumber (exact for the vacuum line to (k dx)^2).
 */
export function measureSlab(material: SlabMaterial, freqsHz: number[], setup: SlabSetup = SLAB_DEFAULT): SlabResult[] {
  return measureSlabLine(slabLineModel(material, setup), material, freqsHz, setup);
}

/** measureSlab on a line built elsewhere (slabLineModel's geometry, as from lineFromColumn). */
export function measureSlabLine(withSlab: { model: VoxelModel; i0: number; i1: number }, material: SlabMaterial, freqsHz: number[], setup: SlabSetup): SlabResult[] {
  const empty = slabLineModel(null, setup);
  const probeAfter = withSlab.i1 + AFTER;
  const total = runLine(withSlab.model, setup.steps, probeAfter);
  const incident = runLine(empty.model, setup.steps, probeAfter);
  const dt = timestepSec(withSlab.model.grid);
  const dx = setup.dxMm * 1e-3;
  const reflected = total.before.map((v, n) => v - incident.before[n]);
  return freqsHz.map((fHz) => {
    const k0 = (2 * Math.PI * fHz) / C0;
    const toFront = (withSlab.i0 - PROBE_I) * dx;
    // The reflection seen at the probe travelled 2 x toFront further than at the face. Transmission is
    // relative to the incident wave at the same probe, which is what slabExact's t is.
    const gammaAtProbe = cdiv(dft(reflected, dt, fHz), dft(incident.before, dt, fHz));
    const gamma = cmul(gammaAtProbe, [Math.cos(2 * k0 * toFront), Math.sin(2 * k0 * toFront)]);
    const tAtProbe = cdiv(dft(total.after, dt, fHz), dft(incident.after, dt, fHz));
    return { fHz, gamma, t: tAtProbe, exact: slabExact(material, setup.cells * dx, fHz) };
  });
}

/**
 * The line of slabLineModel with its slab taken from a rasterised project
 * instead: one vertical column (i, j) of the project's model, from two planes
 * below the slab to two above, laid along the line. With polarisation 'x',
 * Ex on plane k becomes Ez at line node i0 + (k - kBottom) and Hy at k + 1/2
 * becomes Hy at that node + 1/2; with 'y', Ey and Hx do. Their eDecay/eCurl
 * and dispersion records are copied as they are. A wave down the column at
 * normal incidence sees the layer's tangential edges as the board's fields
 * do, so this checks which E and H edges rasterise lists and their interface
 * mix against the closed form. Not on this path: Hz (normal to the layers),
 * and the eDecay/eCurl stand-in, which the update only uses to recover the
 * curl, so any nonzero value passes.
 * The column's z cells must all be setup.dxMm (a uniform stretch), its time
 * step the line's, and the slab must span setup.cells cells from kBottom.
 */
export function lineFromColumn(
  project: VoxelModel, column: { i: number; j: number }, slab: { kBottom: number; kTop: number }, setup: SlabSetup, polarisation: 'x' | 'y' = 'x',
): { model: VoxelModel; i0: number; i1: number } {
  const g = project.grid;
  const { kBottom } = slab;
  if (slab.kTop - kBottom !== setup.cells) throw new Error(`the slab spans ${slab.kTop - kBottom} cells, the line expects ${setup.cells}`);
  for (let k = kBottom - 2; k < kBottom + setup.cells + 2; k++) {
    const w = cellWidth(project.mesh.z, k);
    if (Math.abs(w - setup.dxMm) > 1e-9) throw new Error(`cell ${k} of the column is ${w} mm, the line's ${setup.dxMm} mm`);
  }
  const line = slabLineModel(null, setup);
  // The dispersion records bake in the project's time step.
  if (timestepSec(g) !== timestepSec(line.model.grid)) throw new Error('the project and the line have different time steps');
  const pN = g.nx * g.ny * g.nz;
  const { nx, ny, nz } = line.model.grid;
  const N = nx * ny * nz;
  const m = line.model;
  const listed = (d: EdgeDispersion | undefined) => new Map(d ? Array.from(d.index, (at, n) => [at, d.medium[n]] as const) : []);
  const pe = listed(project.dispersion?.e);
  const ph = listed(project.dispersion?.h);
  const e = { index: [] as number[], medium: [] as number[] };
  const h = { index: [] as number[], medium: [] as number[] };
  // Ex (block 0) pairs with Hy (block 1); Ey (block 1) with Hx (block 0). Both share the column's cell index.
  const [eBlock, hBlock] = polarisation === 'x' ? [0, 1] : [1, 0];
  for (let dk = -2; dk <= setup.cells + 2; dk++) {
    const cell = column.i + g.nx * (column.j + g.ny * (kBottom + dk));
    const eAt = eBlock * pN + cell;
    const hAt = hBlock * pN + cell;
    for (let lk = 0; lk < nz; lk++) for (let lj = 0; lj < ny; lj++) {
      const c = line.i0 + dk + nx * (lj + ny * lk);
      m.eDecay[2 * N + c] = project.eDecay[eAt];
      m.eCurl[2 * N + c] = project.eCurl[eAt];
      const em = pe.get(eAt);
      if (em !== undefined) { e.index.push(2 * N + c); e.medium.push(em); }
      const hm = ph.get(hAt);
      if (hm !== undefined) { h.index.push(N + c); h.medium.push(hm); }
    }
  }
  const build = (src: EdgeDispersion | undefined, l: { index: number[]; medium: number[] }) =>
    src && l.index.length > 0 ? { ...src, index: Uint32Array.from(l.index), medium: Uint32Array.from(l.medium) } : undefined;
  m.dispersion = { e: build(project.dispersion?.e, e), h: build(project.dispersion?.h, h) };
  return line;
}
