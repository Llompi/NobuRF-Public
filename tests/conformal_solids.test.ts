import { describe, expect, it } from 'vitest';
import { CONFORMAL_COURANT, CONFORMAL_SOLID_COURANT, effectiveFreeArea } from '../src/engine/conformal';
import { DEFAULT_GRID } from '../src/engine/config';
import { buildCpml, uniformFaces } from '../src/engine/cpml';
import { CpuFdtd, vacuumModel } from '../src/engine/fdtd_cpu';
import { uniformLines, type MeshLines } from '../src/engine/mesh';
import type { VoxelModel } from '../src/engine/voxelize';
import {
  addConformalSolids, assertClosedMesh, boxMesh, joinMeshes, segmentsForSag, solidCoverage, sphereMesh, tubeMesh, type TriangleMesh,
} from '../src/project/conformal_solids';

const cube = (n: number, from: number, h: number): MeshLines => ({ x: uniformLines(n, from, h), y: uniformLines(n, from, h), z: uniformLines(n, from, h) });

/** A vacuum model over `mesh` with no PML, at Courant number `courant`. */
function airModel(mesh: MeshLines, courant = CONFORMAL_SOLID_COURANT, pml = 0): VoxelModel {
  const grid = { ...DEFAULT_GRID, nx: mesh.x.length, ny: mesh.y.length, nz: mesh.z.length, dxMm: mesh.x[1] - mesh.x[0], pmlCells: pml, groundK: 1, courant };
  const model = vacuumModel(grid, uniformFaces(pml));
  model.mesh = mesh;
  model.cpml = buildCpml(grid, uniformFaces(pml), undefined, mesh);
  return model;
}

/** Largest eigenvalue of the leapfrog operator by power iteration (as tests/conformal.test.ts); stable below 4. */
function largestEigenvalue(model: VoxelModel, iterations: number): number {
  const sim = new CpuFdtd(model);
  const x = Float64Array.from(model.eCurl, (c, m) => (c === 0 ? 0 : (Math.sin(m * 12.9898) * 43758.5453) % 1));
  let rho = 0;
  for (let it = 0; it < iterations; it++) {
    let norm = 0;
    for (const v of x) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    sim.reset();
    for (let m = 0; m < x.length; m++) sim.e[m] = x[m] / norm;
    sim.updateH();
    sim.e.fill(0);
    sim.updateE();
    let sum = 0;
    for (let m = 0; m < x.length; m++) {
      x[m] = -sim.e[m];
      sum += x[m] * x[m];
    }
    rho = Math.sqrt(sum);
  }
  return rho;
}

describe('solidCoverage', () => {
  const h = 1;
  const lines = cube(25, -12, h);
  const n = 25;
  const N = n ** 3;

  it('integrates a sphere off the nodes exactly, up to its tessellation', () => {
    const R = 8.3;
    const c: [number, number, number] = [0.21, -0.37, 0.13];
    const segments = 720;
    const cover = solidCoverage(lines, [sphereMesh(c, R, segments)]);
    let worstArea = 0;
    let worstChord = 0;
    for (let k = 0; k < n; k++) {
      let area = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) area += cover.face[2 * N + i + n * (j + n * k)] * h * h;
      const dz = lines.z[k] - c[2];
      worstArea = Math.max(worstArea, Math.abs(area - (Math.abs(dz) < R ? Math.PI * (R * R - dz * dz) : 0)) / (Math.PI * R * R));
      for (let j = 0; j < n; j++) {
        let length = 0;
        for (let i = 0; i + 1 < n; i++) length += cover.edge[i + n * (j + n * k)] * h;
        const r2 = R * R - (lines.y[j] - c[1]) ** 2 - dz * dz;
        worstChord = Math.max(worstChord, Math.abs(length - (r2 > 0 ? 2 * Math.sqrt(r2) : 0)));
      }
    }
    // 720 x 360 facets: the polygon sections lose about 1e-5 of the area, and a chord near grazing about 3 um.
    expect(worstArea).toBeLessThan(1e-4);
    expect(worstChord).toBeLessThan(5e-3);
  });

  it('gives a cylinder turned about every axis its volume', () => {
    const cover = solidCoverage(lines, [tubeMesh([[-5, -3, -4], [6, 4, 5]], 3, 512)]);
    let volume = 0;
    for (let f = 0; f < N; f++) volume += cover.face[f] * h ** 3;
    expect(volume / (Math.PI * 9 * Math.hypot(11, 7, 9))).toBeCloseTo(1, 4);
  });

  it('counts copper on the surface as copper: a box on mesh lines is the staircase box', () => {
    const cover = solidCoverage(lines, [boxMesh([-3, -2, -1], [3, 2, 1])]);
    for (const f of cover.edge) expect(f === 0 || f === 1).toBe(true);
    const at = (i: number, j: number, k: number) => i + 12 + n * (j + 12 + n * (k + 12));
    expect(cover.edge[at(-3, -2, 0)]).toBe(1); // Ex on the y = -2 face
    expect(cover.edge[at(-3, -3, 0)]).toBe(0);
    expect(cover.face[2 * N + at(0, 0, 1)]).toBe(1); // Hz on the top face
    expect(cover.face[2 * N + at(0, 0, 2)]).toBe(0);
  });

  it('counts a slice point shared by two triangles once, wherever a row passes through it', () => {
    // The box quads split along diagonals that cross the planes x = 1 exactly at z = 1, on a row.
    const mesh = { x: uniformLines(27, -13, 1), y: uniformLines(15, -7, 1), z: uniformLines(19, -9, 1) };
    const cover = solidCoverage(mesh, [joinMeshes([boxMesh([-30, -30, -30], [30, 30, 30]), boxMesh([-11, -5, -7.5], [11, 5, 7.5])])]);
    const [nx, ny] = [27, 15];
    const ey = (x: number, y: number, z: number) => cover.edge[nx * ny * 19 + x + 13 + nx * (y + 7 + ny * (z + 9))];
    expect(ey(1, 0, 1)).toBe(0);
    expect(ey(1, -7, 1)).toBe(1);
  });
});

describe('closed surfaces', () => {
  it('accepts the shape helpers and rejects an open surface', () => {
    const helix = Array.from({ length: 200 }, (_, m): [number, number, number] => [5 * Math.cos(m / 20), 5 * Math.sin(m / 20), 0.1 * m]);
    for (const mesh of [sphereMesh([0, 0, 0], 2, 32), tubeMesh(helix, 0.6, 24), boxMesh([0, 0, 0], [1, 2, 3])]) expect(() => assertClosedMesh(mesh)).not.toThrow();
    const box = boxMesh([0, 0, 0], [1, 1, 1]);
    const open: TriangleMesh = { positions: box.positions, triangles: box.triangles.slice(3) };
    expect(() => assertClosedMesh(open)).toThrow(/not closed/);
  });

  it('chooses facets for a chord sag', () => {
    const n = segmentsForSag(10, 1e-3);
    expect(10 * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(1e-3);
  });
});

describe('addConformalSolids', () => {
  it('cuts faces of all three orientations and scales the partly covered edges', () => {
    const model = addConformalSolids(airModel(cube(17, -8, 1)), [sphereMesh([0.3, -0.2, 0.1], 5.2, 128)]);
    const N = 17 ** 3;
    const comps = new Set(Array.from(model.conformal!.hIndex, (f) => Math.floor(f / N)));
    expect([...comps].sort()).toEqual([0, 1, 2]);
    for (const e of model.conformal!.partialEdges) {
      expect(model.eCurl[e]).toBeGreaterThan(0);
      expect(model.eCurl[e]).toBeLessThan(CONFORMAL_SOLID_COURANT);
    }
  });

  it('stays below the leapfrog limit for slivers and turned cylinders', () => {
    // Walls 0.01 mm past mesh lines leave 1 % slivers on all three axes; a turned cylinder cuts all four faces of many edges.
    const sliver = addConformalSolids(airModel(cube(15, -7, 1)), [joinMeshes([boxMesh([-30, -30, -30], [30, 30, 30]), boxMesh([-5.01, -4.01, -3.01], [5.01, 4.01, 3.01])])]);
    const rod = addConformalSolids(airModel(cube(15, -7, 1)), [tubeMesh([[-4.1, -3.3, -2.2], [4.3, 3.1, 2.9]], 2.2, 96)]);
    for (const m of [sliver, rod]) expect(largestEigenvalue(m, 200)).toBeLessThan(4);
  });

  it('shares an edge between its cut faces in the stability bound', () => {
    // The same face allows a smaller effective area when its edges border fewer cut faces.
    const lambdas = [1, 1, 0.4, 0.4];
    const entries = [1, 1, 1 / 0.4, 1 / 0.4].map((v, n) => v * lambdas[n] / lambdas[n]);
    const two = effectiveFreeArea(0.1, lambdas, entries, CONFORMAL_COURANT, 2);
    const four = effectiveFreeArea(0.1, lambdas, entries, CONFORMAL_COURANT, 4);
    expect(four).toBeGreaterThan(two);
    expect(effectiveFreeArea(0.1, lambdas, entries, CONFORMAL_COURANT)).toBe(two);
  });

  it('corrects a solid\'s cut faces whether or not other solids are present', () => {
    const wire = tubeMesh([[0.5, 0.5, -4], [0.5, 0.5, 4]], 0.3, 32);
    const alone = addConformalSolids(airModel(cube(17, -8, 1)), [wire]);
    const withSphere = addConformalSolids(airModel(cube(17, -8, 1)), [wire, sphereMesh([4.3, 4.1, 0.2], 1.6, 64)]);
    const faces = (m: VoxelModel) => new Set(m.conformal?.hIndex ?? []);
    const wireFaces = faces(alone);
    expect(wireFaces.size).toBeGreaterThan(0);
    for (const f of wireFaces) expect(faces(withSphere).has(f)).toBe(true);
  });

  it('refuses solids in the PML and over a port', () => {
    const inPml = airModel(cube(21, -10, 1), CONFORMAL_SOLID_COURANT, 4);
    expect(() => addConformalSolids(inPml, [sphereMesh([-6.5, 0, 0], 1.2, 32)])).toThrow(/PML/);
    const ported = airModel(cube(21, -10, 1));
    const N = 21 ** 3;
    ported.ports = [{ ezIndex: Uint32Array.of(2 * N + 10 + 21 * (10 + 21 * 10)) } as unknown as VoxelModel['ports'][number]];
    expect(() => addConformalSolids(ported, [sphereMesh([0.2, 0.1, 0.4], 1.5, 32)])).toThrow(/port/);
  });
});
