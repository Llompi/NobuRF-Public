import { describe, expect, it } from 'vitest';
import { activeConformalFaces, CONFORMAL_COURANT, effectiveFreeArea } from '../src/engine/conformal';
import { DEFAULT_EXCITATION } from '../src/engine/config';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { uniformLines } from '../src/engine/mesh';
import type { VoxelModel } from '../src/engine/voxelize';
import { planeCoverage, polygonSegments } from '../src/project/coverage';
import { rasterise } from '../src/project/rasterise';
import type { Vec2 } from '../src/project/resolve';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';
import { patchResonance } from '../scripts/validate/conformal_patch';

const slow = process.env.SKIP_SLOW ? it.skip : it;

/** Point in polygon by crossing number, for the brute-force reference. */
function inside(polygon: Vec2[], x: number, y: number): boolean {
  let odd = false;
  for (let n = 0, prev = polygon.length - 1; n < polygon.length; prev = n++) {
    const [a, b] = [polygon[prev], polygon[n]];
    if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) odd = !odd;
  }
  return odd;
}

const turned = (points: Vec2[], deg: number, [cx, cy]: Vec2 = [0, 0]): Vec2[] => {
  const t = (deg * Math.PI) / 180;
  return points.map(([x, y]) => [cx + x * Math.cos(t) - y * Math.sin(t), cy + x * Math.sin(t) + y * Math.cos(t)]);
};
const square = (half: number): Vec2[] => [[-half, -half], [half, -half], [half, half], [-half, half]];
const shoelace = (p: Vec2[]) => Math.abs(p.reduce((s, [x0, y0], n) => s + x0 * p[(n + 1) % p.length][1] - p[(n + 1) % p.length][0] * y0, 0)) / 2;

describe('planeCoverage', () => {
  const lines = uniformLines(21, -5, 0.5);
  const shape = turned(square(2.3), 27, [0.11, -0.07]);
  const cover = planeCoverage(lines, lines, polygonSegments(shape), (x, y) => inside(shape, x, y));

  it('covers exactly the polygon area, summed over faces', () => {
    let area = 0;
    for (const f of cover.face) area += f * 0.25;
    expect(area).toBeCloseTo(shoelace(shape), 10);
  });

  it('matches brute-force sampling on every edge and face', () => {
    const samples = 400;
    let worst = 0;
    for (let j = 0; j + 1 < lines.length; j++) {
      for (let i = 0; i + 1 < lines.length; i++) {
        const col = i + lines.length * j;
        let ex = 0;
        let ey = 0;
        for (let s = 0; s < samples; s++) {
          const t = (s + 0.5) / samples;
          ex += inside(shape, lines[i] + 0.5 * t, lines[j]) ? 1 : 0;
          ey += inside(shape, lines[i], lines[j] + 0.5 * t) ? 1 : 0;
        }
        worst = Math.max(worst, Math.abs(ex / samples - cover.ex[col]), Math.abs(ey / samples - cover.ey[col]));
      }
    }
    // Sampling resolves 1/400 of an edge, and a polygon edge can cross a mesh edge twice.
    expect(worst).toBeLessThanOrEqual(2 / samples + 1e-12);
  });
});

/** The small patch project, its patch replaced by `patch`, with mesh.conformal as given. */
function smallModel(patch: Vec2[] | null, conformal: boolean): VoxelModel {
  const json = smallProjectJson();
  if (patch) json.geometry.top[0].polygon = patch.map(([x, y]) => [`${x} mm`, `${y} mm`]);
  json.mesh.conformal = conformal;
  return rasterise(parseProject(json)).model;
}

describe('conformal rasterise', () => {
  it('meshes copper on mesh lines exactly as the staircase does, time step included', () => {
    const plain = smallModel(null, false);
    const conformal = smallModel(null, true);
    expect(conformal.conformal).toBeUndefined();
    expect(conformal.grid).toEqual(plain.grid);
    expect(Array.from(conformal.eCurl)).toEqual(Array.from(plain.eCurl));
    expect(conformal.signature).toBe(plain.signature);
  });

  it('gives a turned patch partial edges and conformal faces at the conformal Courant number', () => {
    const m = smallModel(turned(square(3), 30), true);
    expect(m.grid.courant).toBe(CONFORMAL_COURANT);
    const faces = m.conformal!;
    expect(faces.partialEdges.length).toBeGreaterThan(faces.hIndex.length / 2);
    expect(faces.hIndex.length).toBeGreaterThan(0);
    expect(activeConformalFaces(m)).toBe(faces);
    // Editing one of their edges afterwards (as a coax anti-pad does) drops that face back to the plain update.
    const edited = { ...m, eCurl: m.eCurl.slice() };
    edited.eCurl[faces.eIndex[0]] = m.grid.courant;
    expect(activeConformalFaces(edited)!.hIndex.length).toBeLessThan(faces.hIndex.length);
  });

  it('rejects a mesh.conformal that is not true or false', () => {
    const json = smallProjectJson();
    json.mesh.conformal = 'yes';
    expect(() => parseProject(json)).toThrow(/\$\.mesh\.conformal/);
  });
});

describe('effectiveFreeArea', () => {
  const DEFAULT_SC = 0.99 / Math.sqrt(3);
  it('keeps every free edge within the stability budget', () => {
    for (const sc of [DEFAULT_SC, CONFORMAL_COURANT]) {
      const budget = (0.98 * 4) / sc ** 2;
      for (let trial = 0; trial < 2000; trial++) {
        const lambdas = Array.from({ length: 4 }, (_, n) => (n === 0 || Math.random() < 0.6 ? Math.random() : 0));
        const entries = lambdas.map(() => 0.2 + 0.8 * Math.random());
        const a = Math.random() * 0.999;
        const aEff = effectiveFreeArea(a, lambdas, entries, sc);
        const load = lambdas.reduce((t, l, n) => (l > 0 ? t + entries[n] / (Math.max(0, budget - 12) + budget * (1 / l - 1)) : t), 0);
        expect(aEff).toBeGreaterThanOrEqual(a);
        // The bound of docs/conformal.md: 2 * Delta * sum(entry / slack) <= 1.
        expect(2 * (1 / aEff - 1) * load).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('at the default Courant number leaves a face with a wholly free edge alone; at the conformal one floors it', () => {
    expect(effectiveFreeArea(0.3, [1, 0.4, 0.2, 0], [1, 1, 1, 1], DEFAULT_SC)).toBe(1);
    expect(effectiveFreeArea(0.3, [0, 0, 0, 0], [1, 1, 1, 1], CONFORMAL_COURANT)).toBe(1);
    const floored = effectiveFreeArea(0.02, [1, 0.02, 0.02, 0], [1, 1, 1, 1], CONFORMAL_COURANT);
    expect(floored).toBeGreaterThan(0.3);
    expect(floored).toBeLessThan(0.4);
  });
});

/**
 * Largest eigenvalue of the leapfrog operator e -> eCurl curl(-Sc curl e), by
 * power iteration. The update is stable while it is below 4.
 */
function largestEigenvalue(model: VoxelModel, iterations: number): number {
  const sim = new CpuFdtd(model);
  const x = Float64Array.from(model.eCurl, (c, m) => (c === 0 ? 0 : Math.sin(m * 12.9898) * 43758.5453 % 1));
  let rho = 0;
  for (let it = 0; it < iterations; it++) {
    const norm = Math.hypot(...x.filter((v) => v !== 0)) || 1;
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

describe('conformal stability', () => {
  it('stays below the leapfrog limit, slivers and copper in air included', () => {
    // Edges 0.01 mm past mesh lines leave slivers of 1 % free area along whole edges: plain Dey-Mittra blows up there.
    const sliver = smallModel(square(2.99), true);
    const circle = smallModel(Array.from({ length: 64 }, (_, k): Vec2 => [0.13 + 2.87 * Math.cos((k * Math.PI) / 32), -0.21 + 2.87 * Math.sin((k * Math.PI) / 32)]), true);
    // Copper with air on both sides: no dielectric to slow its edges, the hardest case for a cut face.
    const json = smallProjectJson();
    json.stackup[1].material = 'air';
    json.geometry.top[0].polygon = square(2.99).map(([x, y]) => [`${x} mm`, `${y} mm`]);
    json.mesh.conformal = true;
    const airSliver = rasterise(parseProject(json)).model;
    const strip = smallModel(turned([[-0.6, -4], [0.6, -4], [0.6, 4], [-0.6, 4]], 8, [0.05, 0]), true);
    for (const m of [sliver, airSliver, circle, strip]) {
      expect(largestEigenvalue(m, 150)).toBeLessThan(4);
    }
  });
});

describe('conformal copper on dispersive FR-4', () => {
  it('keeps the free fraction of partly covered edges in the dispersion pass: a sliver patch rings down', () => {
    // The dispersion pass recovers curl(h) from eCurl, which carries the free fraction; the edge's medium must carry
    // it too (eps / lambda), or the sliver edges update as if wholly free and the run blows up within a few hundred steps.
    const json = smallProjectJson();
    json.materials = { 'FR-4 wideband': { eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 1 } } };
    json.stackup[1].material = 'FR-4 wideband';
    json.geometry.top[0].polygon = square(2.99).map(([x, y]) => [`${x} mm`, `${y} mm`]);
    json.mesh.conformal = true;
    const model = rasterise(parseProject(json)).model;
    const partial = new Set(model.conformal!.partialEdges);
    expect(Array.from(model.dispersion!.e!.index).filter((m) => partial.has(m)).length).toBeGreaterThan(0);
    const run = new CpuFdtd(model).run(DEFAULT_EXCITATION, { maxSteps: 3000, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 });
    const peak = (v: Float32Array | Float64Array | number[], from: number, to: number) => Math.max(...Array.from(v.slice(from, to), Math.abs));
    // It rings down by about 70 dB over the run (3.9e-1 to 3.6e-8 V peak); a lost free fraction grows instead.
    expect(peak(run.v, 2500, 3000)).toBeLessThan(1e-4 * peak(run.v, 0, 500));
  });
});

describe('conformal accuracy', () => {
  // The 12 x 9 mm patch of docs/conformal.md turned 30 deg, 0.75 mm cells. Turning changes nothing physical, so
  // the answer is the unturned patch on the graded mesh, 9.288 GHz (scripts/validate/conformal_patch.ts rect 0.75 graded 0).
  const GRADED_GHZ = 9.288;
  slow('lands a turned patch on the aligned resonance, where the staircase reads several percent low', async () => {
    const conformal = await patchResonance('rect', 0.75, 'conformal', [30, 0]);
    const staircase = await patchResonance('rect', 0.75, 'staircase', [30, 0]);
    expect(Math.abs(conformal.fGHz / GRADED_GHZ - 1)).toBeLessThan(0.005);
    expect(1 - staircase.fGHz / GRADED_GHZ).toBeGreaterThan(0.03);
  }, 120_000);
});
