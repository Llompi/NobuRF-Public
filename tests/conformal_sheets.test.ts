import { describe, expect, it } from 'vitest';
import { CONFORMAL_SOLID_COURANT } from '../src/engine/conformal';
import { DEFAULT_GRID } from '../src/engine/config';
import { buildCpml, uniformFaces } from '../src/engine/cpml';
import { CpuFdtd, vacuumModel } from '../src/engine/fdtd_cpu';
import { uniformLines, type MeshLines } from '../src/engine/mesh';
import { GHOST } from '../src/engine/thin_sheets';
import type { VoxelModel } from '../src/engine/voxelize';
import { addConformalSheets, assertSheetMesh, faceRegions } from '../src/project/conformal_sheets';
import { boxModel, ringDown } from '../scripts/validate/conformal_solids';
import { addConformalSolids, boxMesh, joinMeshes, ribbonMesh, sphereMesh, type TriangleMesh } from '../src/project/conformal_solids';

const cube = (n: number, from: number, h: number): MeshLines => ({ x: uniformLines(n, from, h), y: uniformLines(n, from, h), z: uniformLines(n, from, h) });

function airModel(mesh: MeshLines, courant = CONFORMAL_SOLID_COURANT, pml = 0): VoxelModel {
  const grid = { ...DEFAULT_GRID, nx: mesh.x.length, ny: mesh.y.length, nz: mesh.z.length, dxMm: mesh.x[1] - mesh.x[0], pmlCells: pml, groundK: 1, courant };
  const model = vacuumModel(grid, uniformFaces(pml));
  model.mesh = mesh;
  model.cpml = buildCpml(grid, uniformFaces(pml), undefined, mesh);
  return model;
}

const area = (p: Array<[number, number]>) => Math.abs(p.reduce((s, a, n) => s + a[0] * p[(n + 1) % p.length][1] - p[(n + 1) % p.length][0] * a[1], 0)) / 2;

/** Largest eigenvalue of the leapfrog operator over E and the ghost E, by power iteration; stable below 4. */
function largestEigenvalue(model: VoxelModel, iterations: number): number {
  const sim = new CpuFdtd(model);
  const nE = sim.e.length;
  const x = Float64Array.from({ length: nE + sim.ghostE.length }, (_, m) => (m < nE && model.eCurl[m] === 0 ? 0 : (Math.sin(m * 12.9898) * 43758.5453) % 1));
  let rho = 0;
  for (let it = 0; it < iterations; it++) {
    const norm = Math.hypot(...x) || 1;
    sim.reset();
    for (let m = 0; m < nE; m++) sim.e[m] = x[m] / norm;
    for (let m = 0; m < sim.ghostE.length; m++) sim.ghostE[m] = x[nE + m] / norm;
    sim.updateH();
    sim.e.fill(0);
    sim.ghostE.fill(0);
    sim.updateE();
    for (let m = 0; m < nE; m++) x[m] = -sim.e[m];
    for (let m = 0; m < sim.ghostE.length; m++) x[nE + m] = -sim.ghostE[m];
    rho = Math.hypot(...x);
  }
  return rho;
}

describe('faceRegions', () => {
  it('splits a face along a chord, keeps a trace that ends inside whole, and splits twice for two chords', () => {
    const chord = faceRegions([{ a: [-0.5, 0.3], b: [0.4, 0.5] }, { a: [0.4, 0.5], b: [1.5, 0.8] }], 0, 1, 0, 1);
    expect(chord).toHaveLength(2);
    expect(chord.map(area).reduce((s, a) => s + a, 0)).toBeCloseTo(1, 12);
    // Below the chord: a trapezoid from y 0.4333 at x 0 through the kink (0.4, 0.5) to y 0.6636 at x 1.
    const below = 0.4 * (0.5 + 0.3 + (0.2 * 0.5) / 0.9) / 2 + 0.6 * (0.5 + 0.5 + (0.3 * 0.6) / 1.1) / 2;
    expect(Math.min(...chord.map(area))).toBeCloseTo(Math.min(below, 1 - below), 12);
    expect(faceRegions([{ a: [-0.5, 0.3], b: [0.6, 0.4] }], 0, 1, 0, 1)).toHaveLength(1);
    expect(faceRegions([{ a: [0.2, -1], b: [0.3, 2] }, { a: [-1, 0.7], b: [0.25, 0.71] }], 0, 1, 0, 1)).toHaveLength(2);
    expect(faceRegions([{ a: [0.2, -1], b: [0.3, 2] }, { a: [0.6, -1], b: [0.7, 2] }], 0, 1, 0, 1)).toHaveLength(3);
  });

  it('refuses traces that branch', () => {
    expect(() => faceRegions([{ a: [0.5, -1], b: [0.5, 0.5] }, { a: [0.5, 0.5], b: [0.2, 2] }, { a: [0.5, 0.5], b: [0.8, 2] }], 0, 1, 0, 1)).toThrow(/branch/);
  });
});

describe('assertSheetMesh', () => {
  it('accepts open and closed surfaces and refuses a fin', () => {
    expect(() => assertSheetMesh(ribbonMesh([[0, 0, 0], [1, 0, 0], [2, 1, 0]], [[0, 1, 0], [0, 1, 0], [0, 0, 1]], 0.5))).not.toThrow();
    expect(() => assertSheetMesh(sphereMesh([0, 0, 0], 1, 16))).not.toThrow();
    const fin: TriangleMesh = { positions: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1), triangles: Uint32Array.of(0, 1, 2, 0, 1, 3, 0, 1, 4) };
    expect(() => assertSheetMesh(fin)).toThrow(/branch/);
  });
});

describe('addConformalSheets', () => {
  const R = 5.2;
  const c: [number, number, number] = [0.23, -0.31, 0.17];
  const sphere = sphereMesh(c, R, 160);

  it('keeps the field inside a closed sheet inside', () => {
    const lines = cube(17, -8, 1);
    const model = addConformalSheets(airModel(lines), [sphere]);
    const sim = new CpuFdtd(model);
    const n = 17;
    const N = n ** 3;
    const r = (i: number, j: number, k: number) => Math.hypot(lines.x[i] - c[0], lines.y[j] - c[1], lines.z[k] - c[2]);
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (r(i, j, k) < R - 1.5) sim.e[2 * N + i + n * (j + n * k)] = Math.sin(i + 2 * j + 3 * k);
    for (let s = 0; s < 400; s++) {
      sim.updateH();
      sim.updateE();
    }
    let [inside, outside] = [0, 0];
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      for (let comp = 0; comp < 3; comp++) {
        const v = sim.e[comp * N + i + n * (j + n * k)] ** 2;
        if (r(i, j, k) < R - 1.5) inside += v;
        if (r(i, j, k) > R + 1.5) outside += v;
      }
    }
    expect(inside).toBeGreaterThan(1);
    expect(outside / inside).toBeLessThan(1e-12);
  });

  it('updates the inside of a closed sheet as the conformal cavity of the same surface', () => {
    // Pieces carry their own length fraction, ghosts included: then the sheet's inside is the solid cavity's update.
    const lines = cube(17, -8, 1);
    const sc = 0.1; // below every stability floor, so both use the plain cut-cell areas
    const sheet = addConformalSheets(airModel(lines, sc), [sphere]);
    const solid = addConformalSolids(airModel(lines, sc), [joinMeshes([boxMesh([-30, -30, -30], [30, 30, 30]), sphere])]);
    const [a, b] = [new CpuFdtd(sheet), new CpuFdtd(solid)];
    const n = 17;
    const N = n ** 3;
    const inside = (i: number, j: number, k: number) => Math.hypot(lines.x[i] - c[0], lines.y[j] - c[1], lines.z[k] - c[2]) < R - 1.5;
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (inside(i, j, k)) a.e[i + n * (j + n * k)] = b.e[i + n * (j + n * k)] = Math.cos(3 * i + j - k);
    for (let s = 0; s < 300; s++) {
      a.updateH();
      a.updateE();
      b.updateH();
      b.updateE();
    }
    let [worst, peak] = [0, 0];
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      if (!inside(i, j, k)) continue;
      for (let comp = 0; comp < 3; comp++) {
        const m = comp * N + i + n * (j + n * k);
        worst = Math.max(worst, Math.abs(a.e[m] - b.e[m]));
        peak = Math.max(peak, Math.abs(b.e[m]));
      }
    }
    expect(peak).toBeGreaterThan(0.1);
    expect(worst / peak).toBeLessThan(1e-4);
  });

  it('closes a surface given as one vertex per triangle (welded by position)', () => {
    const t = sphere.triangles;
    const soup: TriangleMesh = { positions: Float64Array.from(Array.from(t, (v) => [sphere.positions[3 * v], sphere.positions[3 * v + 1], sphere.positions[3 * v + 2]]).flat()), triangles: Uint32Array.from(t, (_, n) => n) };
    const a = addConformalSheets(airModel(cube(17, -8, 1)), [sphere]).thinSheets!;
    const b = addConformalSheets(airModel(cube(17, -8, 1)), [soup]).thinSheets!;
    expect([b.ghostE, b.ghostH, b.h.coef.length]).toEqual([a.ghostE, a.ghostH, a.h.coef.length]);
  });

  it('makes a sheet on mesh planes the copper plane: the edges under it are PEC', () => {
    const model = addConformalSheets(airModel(cube(17, -8, 1)), [boxMesh([-4, -4, -4], [4, 4, 4])]);
    const n = 17;
    const at = (x: number, y: number, z: number) => x + 8 + n * (y + 8 + n * (z + 8));
    for (let x = -4; x < 4; x++) for (let y = -4; y <= 4; y++) expect(model.eCurl[at(x, y, 4)]).toBe(0); // Ex on the top face
    expect(model.eCurl[at(0, 0, 3)]).toBeGreaterThan(0); // and not a cell below
    expect(model.eCurl[2 * n ** 3 + at(0, 0, 3)]).toBeCloseTo(CONFORMAL_SOLID_COURANT, 6); // Ez under the top face: whole
  });

  it('refuses lossy copper faces and a port next to a sheet, and leaves the model untouched when it refuses', () => {
    const strip = ribbonMesh([[-2, 0.3, 0.4], [2, 0.3, 0.4]], [[0, 1, 0], [0, 1, 0]], 2);
    const near = airModel(cube(21, -10, 1));
    near.ports = [{ ezIndex: Uint32Array.of(10 + 21 * (10 + 21 * 11)) } as unknown as VoxelModel['ports'][number]]; // an edge of the faces the strip cuts, above it
    const before = Float32Array.from(near.eCurl);
    expect(() => addConformalSheets(near, [strip])).toThrow(/port/);
    expect(near.eCurl).toEqual(before);
    expect(near.thinSheets).toBeUndefined();
    const lossy = airModel(cube(21, -10, 1));
    const ex = 10 + 21 * (10 + 21 * 10); // Ex at (0, 0, 0), under the strip's faces
    lossy.eCurl[ex] = 0;
    lossy.sheets = { eIndex: Uint32Array.of(ex), normalAxis: Uint8Array.of(2), rsOhm: Float32Array.of(0.01) };
    expect(() => addConformalSheets(lossy, [strip])).toThrow(/lossy copper/);
  });

  it('welds a solid given as one vertex per triangle, dropping zero-area facets', () => {
    const box = boxMesh([-3.3, -2.2, -1.1], [3.4, 2.3, 1.2]);
    const t = box.triangles;
    const soup: TriangleMesh = { positions: Float64Array.from([...Array.from(t, (v) => [box.positions[3 * v], box.positions[3 * v + 1], box.positions[3 * v + 2]]).flat(), 0, 0, 0, 0, 0, 0, 1, 1, 1]), triangles: Uint32Array.from([...Array.from(t, (_, n) => n), t.length, t.length + 1, t.length + 2]) };
    const a = addConformalSolids(airModel(cube(17, -8, 1)), [joinMeshes([boxMesh([-30, -30, -30], [30, 30, 30]), box])]);
    const b = addConformalSolids(airModel(cube(17, -8, 1)), [joinMeshes([boxMesh([-30, -30, -30], [30, 30, 30]), soup])]);
    expect(b.eCurl).toEqual(a.eCurl);
  });

  it('rings a box of sheets on mesh planes at the solid box\'s frequency', () => {
    const cav = { fGhz: 26.5, source: { at: [0.3, 0.2, 0.1] as [number, number, number], comp: 1 as const }, probe: { at: [-0.7, 0.4, -1.3] as [number, number, number], comp: 1 as const } };
    const sheet = ringDown(cav, addConformalSheets(boxModel({ half: [6.5, 6.5, 6.5] }, 1), [boxMesh([-4, -4, -4], [4, 4, 4])]), 120).f0_ghz;
    const solid = ringDown(cav, addConformalSolids(boxModel({ half: [6.5, 6.5, 6.5] }, 1), [joinMeshes([boxMesh([-30, -30, -30], [30, 30, 30]), boxMesh([-4, -4, -4], [4, 4, 4])])]), 120).f0_ghz;
    expect(Math.abs(sheet / solid - 1)).toBeLessThan(1e-5);
  });

  it('names ghosts by index below their count', () => {
    const model = addConformalSheets(airModel(cube(17, -8, 1)), [sphere]);
    const t = model.thinSheets!;
    expect(t.ghostE).toBeGreaterThan(0);
    for (const rows of [t.h, t.e]) {
      for (const idx of [...rows.target, ...rows.source]) {
        if (idx >= GHOST) expect(idx - GHOST).toBeLessThan(Math.max(t.ghostE, t.ghostH));
      }
    }
  });

  it('stays below the leapfrog limit for a closed sheet and a strip turned on three axes', () => {
    const strip = ribbonMesh([[-5.3, -3.1, -2.2], [5.1, 4.3, 3.9]], [[0.8, -0.36, -0.48], [0.8, -0.36, -0.48]], 2.3);
    const model = addConformalSheets(airModel(cube(17, -8, 1)), [sphereMesh([-3.4, 3.2, -3.3], 2.6, 96), strip]);
    expect(largestEigenvalue(model, 200)).toBeLessThan(4);
  });

  it('refuses a fast time step, the PML, a port and a lossy edge', () => {
    expect(() => addConformalSheets(airModel(cube(17, -8, 1), 0.5), [sphere])).toThrow(/Courant/);
    expect(() => addConformalSheets(airModel(cube(21, -10, 1), CONFORMAL_SOLID_COURANT, 4), [sphereMesh([-6.5, 0, 0], 1.2, 32)])).toThrow(/PML/);
    const ported = airModel(cube(21, -10, 1));
    const N = 21 ** 3;
    ported.ports = [{ ezIndex: Uint32Array.of(2 * N + 10 + 21 * (10 + 21 * 10)) } as unknown as VoxelModel['ports'][number]];
    expect(() => addConformalSheets(ported, [ribbonMesh([[-2, 0.3, 0.4], [2, 0.3, 0.4]], [[0, 1, 0], [0, 1, 0]], 2)])).toThrow(/port/);
    const lossy = airModel(cube(17, -8, 1));
    lossy.eDecay.fill(0.99);
    expect(() => addConformalSheets(lossy, [sphere])).toThrow(/lossy/);
  });
});
