/**
 * Conformal copper solids (src/project/conformal_solids.ts) against closed
 * forms: two PEC cavities whose walls are curved and, for the cylinder, turned
 * against the mesh on every axis. Air inside, PEC outside; the resonance is
 * read from a ring-down (ring_down.ts), as the other cavity checks do.
 *
 *  - Sphere, radius 10 mm, centre off the mesh nodes. Lowest mode TM101:
 *    k a = 2.743707, the first root of d/dx [x j1(x)] (Harrington, Time-Harmonic
 *    Electromagnetic Fields, section 6-4), so f = 13.091 GHz.
 *  - Cylinder, radius 6 mm, length 5 mm, its axis along (1, 0.6, 0.8) (turned
 *    about all three axes) and its centre off the nodes. Lowest mode TM010,
 *    k a = 2.404826 (first zero of J0, Pozar section 6.4), whatever the
 *    length: f = 19.124 GHz.
 *
 * Each runs on several uniform cell sizes, staircased (a cell is metal when its
 * centre is) and conformal, both at CONFORMAL_SOLID_COURANT, so only the
 * geometry differs. Nothing here is
 * fitted: the closed forms are the references and the shapes are fixed before
 * any run.
 *
 *   npx tsx scripts/validate/conformal_solids.ts   -> docs/validation/data/conformal_solids.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { C0, DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { CONFORMAL_SOLID_COURANT } from '../../src/engine/conformal';
import { buildCpml, uniformFaces } from '../../src/engine/cpml';
import { CpuFdtd, vacuumModel } from '../../src/engine/fdtd_cpu';
import { uniformLines, type MeshLines } from '../../src/engine/mesh';
import type { GridConfig } from '../../src/engine/types';
import { materialSignature, type VoxelModel } from '../../src/engine/voxelize';
import { addConformalSolids, boxMesh, joinMeshes, segmentsForSag, sphereMesh, tubeMesh, type TriangleMesh } from '../../src/project/conformal_solids';
import { analyse } from './ring_down';

type Vec3 = [number, number, number];

export interface Cavity {
  name: string;
  /** Closed-form resonance (GHz). */
  fGhz: number;
  /** Half extent of the box around the cavity (mm), and its centre. */
  half: Vec3;
  /** True where the point is metal (outside the cavity). */
  metal: (p: Vec3) => boolean;
  /** The metal as one closed solid: a box past the mesh, with the cavity surface inside it. */
  solid: TriangleMesh;
  /** Source and probe: E components at points inside the cavity. */
  source: { at: Vec3; comp: 0 | 1 | 2 };
  probe: { at: Vec3; comp: 0 | 1 | 2 };
}

const GHZ = C0 / 1e6; // c in mm * GHz

export function sphereCavity(): Cavity {
  const R = 10;
  const c: Vec3 = [0.23, -0.31, 0.17];
  const outer = boxMesh([-30, -30, -30], [30, 30, 30]);
  return {
    name: 'sphere TM101',
    fGhz: (2.743707 * GHZ) / (2 * Math.PI * R),
    half: [R + 1.5, R + 1.5, R + 1.5],
    metal: ([x, y, z]) => Math.hypot(x - c[0], y - c[1], z - c[2]) > R,
    solid: joinMeshes([outer, sphereMesh(c, R, segmentsForSag(R, 2e-4))]),
    // TM101 about z: E along z at the centre.
    source: { at: [c[0] + 1.1, c[1] + 0.7, c[2] + 0.4], comp: 2 },
    probe: { at: [c[0] - 2.3, c[1] + 1.9, c[2] - 1.2], comp: 2 },
  };
}

export function cylinderCavity(): Cavity {
  const a = 6;
  const len = 5;
  const c: Vec3 = [0.19, -0.27, 0.11];
  const n = [1, 0.6, 0.8].map((v) => v / Math.hypot(1, 0.6, 0.8)) as Vec3;
  const ends: Vec3[] = [-1, 1].map((s) => c.map((v, q) => v + (s * len * n[q]) / 2) as Vec3);
  const outer = boxMesh([-30, -30, -30], [30, 30, 30]);
  const along = (p: Vec3) => (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2];
  const half = [0, 1, 2].map((q) => Math.abs(n[q]) * len / 2 + a * Math.sqrt(1 - n[q] * n[q]) + 1.5) as Vec3;
  return {
    name: 'turned cylinder TM010',
    fGhz: (2.404826 * GHZ) / (2 * Math.PI * a),
    half,
    metal: (p) => {
      const t = along(p);
      const r = Math.hypot(p[0] - c[0] - t * n[0], p[1] - c[1] - t * n[1], p[2] - c[2] - t * n[2]);
      return Math.abs(t) > len / 2 || r > a;
    },
    solid: joinMeshes([outer, tubeMesh(ends, a, segmentsForSag(a, 2e-4))]),
    // TM010: E along the axis, largest on it. Drive and probe the axial field near the axis.
    source: { at: c.map((v, q) => v + 0.6 * n[q] + [0.5, -0.3, 0.2][q]) as Vec3, comp: 0 },
    probe: { at: c.map((v, q) => v - 0.8 * n[q] + [-0.4, 0.6, -0.3][q]) as Vec3, comp: 0 },
  };
}

/** A uniform mesh of cell `h` over the cavity's box, with every wall PEC. */
export function boxModel(cav: Pick<Cavity, 'half'>, h: number): VoxelModel {
  const counts = cav.half.map((v) => 2 * Math.ceil(v / h));
  const mesh: MeshLines = { x: uniformLines(counts[0] + 1, -counts[0] * h / 2, h), y: uniformLines(counts[1] + 1, -counts[1] * h / 2, h), z: uniformLines(counts[2] + 1, -counts[2] * h / 2, h) };
  const grid: GridConfig = { ...DEFAULT_GRID, nx: counts[0] + 1, ny: counts[1] + 1, nz: counts[2] + 1, dxMm: h, pmlCells: 0, groundK: 1, courant: CONFORMAL_SOLID_COURANT };
  const model = vacuumModel(grid, uniformFaces(0));
  model.mesh = mesh;
  model.cpml = buildCpml(grid, uniformFaces(0), undefined, mesh);
  return model;
}

/**
 * The usual staircase of a solid: a cell is metal when its centre is, and
 * every edge of a metal cell is PEC. The wall lands on the mesh line nearest
 * to it, give or take half a cell.
 */
function staircase(model: VoxelModel, metal: (p: Vec3) => boolean): void {
  const { nx, ny, nz } = model.grid;
  const N = nx * ny * nz;
  const { x, y, z } = model.mesh;
  for (let k = 0; k + 1 < nz; k++) for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    if (!metal([(x[i] + x[i + 1]) / 2, (y[j] + y[j + 1]) / 2, (z[k] + z[k + 1]) / 2])) continue;
    const at = (di: number, dj: number, dk: number) => i + di + nx * (j + dj + ny * (k + dk));
    for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      model.eCurl[at(0, a, b)] = 0;
      model.eCurl[N + at(a, 0, b)] = 0;
      model.eCurl[2 * N + at(a, b, 0)] = 0;
    }
  }
}

export function buildCavity(cav: Cavity, h: number, method: 'staircase' | 'conformal'): VoxelModel {
  const model = boxModel(cav, h);
  if (method === 'conformal') return addConformalSolids(model, [cav.solid]);
  staircase(model, cav.metal);
  model.signature = materialSignature(model.eDecay, model.eCurl);
  return model;
}

/** The E edge of component `comp` nearest a point. */
export function edgeAt(model: VoxelModel, p: Vec3, comp: number): number {
  const lines = [model.mesh.x, model.mesh.y, model.mesh.z];
  const ijk = [0, 1, 2].map((q) => {
    const l = lines[q];
    const h = l[1] - l[0];
    return Math.max(0, Math.min(l.length - 2, Math.round((p[q] - l[0]) / h - (q === comp ? 0.5 : 0))));
  });
  const { nx, ny, nz } = model.grid;
  return comp * nx * ny * nz + ijk[0] + nx * (ijk[1] + ny * ijk[2]);
}

export function ringDown(cav: Pick<Cavity, 'fGhz' | 'source' | 'probe'>, model: VoxelModel, periods = 250) {
  const solver = new CpuFdtd(model);
  const dt = timestepSec(model.grid);
  const f = cav.fGhz * 1e9;
  const src = edgeAt(model, cav.source.at, cav.source.comp);
  const probe = edgeAt(model, cav.probe.at, cav.probe.comp);
  if (model.eCurl[src] === 0 || model.eCurl[probe] === 0) throw new Error('source or probe edge is metal');
  // Gaussian pulse about 25 % wide around the closed form: picks the mode, does not set the answer (the phase slope does).
  const tau = 1 / (Math.PI * 0.12 * f);
  const t0 = 4 * tau;
  const start = Math.ceil((2 * t0) / dt);
  const steps = start + Math.ceil(periods / (f * dt));
  const rec = new Float64Array(steps);
  for (let n = 0; n < steps; n++) {
    solver.updateH();
    solver.updateE();
    const t = n * dt;
    if (n < start) solver.e[src] += Math.exp(-(((t - t0) / tau) ** 2)) * Math.sin(2 * Math.PI * f * t);
    rec[n] = solver.e[probe];
  }
  return { steps, ...analyse(rec, dt, start, f) };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const OUT = new URL('../../docs/validation/data/', import.meta.url);
  mkdirSync(OUT, { recursive: true });
  const plan: Array<[Cavity, number[]]> = [
    [sphereCavity(), [2, 1.5, 1, 0.75, 0.5]],
    [cylinderCavity(), [1, 0.75, 0.5, 0.375]],
  ];
  const rows = [];
  for (const [cav, cells] of plan) {
    for (const h of cells) {
      for (const method of ['staircase', 'conformal'] as const) {
        const t0 = performance.now();
        const model = buildCavity(cav, h, method);
        const r = ringDown(cav, model);
        const err = (r.f0_ghz - cav.fGhz) / cav.fGhz;
        const row = { cavity: cav.name, closed_form_ghz: cav.fGhz, cell_mm: h, method, f0_ghz: r.f0_ghz, error: err, cells: model.grid.nx * model.grid.ny * model.grid.nz, steps: r.steps, faces: model.conformal?.hIndex.length ?? 0 };
        rows.push(row);
        console.log(`${cav.name.padEnd(22)} h ${h.toFixed(3)} mm ${method.padEnd(9)} f0 ${r.f0_ghz.toFixed(4)} GHz vs ${cav.fGhz.toFixed(4)} (${(err * 100).toFixed(3)} %), ${row.cells} cells, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      }
    }
  }
  writeFileSync(new URL('conformal_solids.json', OUT), JSON.stringify({ references: { sphere: 'Harrington 6-4, TM101 ka = 2.743707', cylinder: 'Pozar 6.4, TM010 ka = 2.404826' }, rows }, null, 1));
}
