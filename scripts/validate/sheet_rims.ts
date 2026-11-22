/**
 * Thin-sheet rims (src/project/conformal_sheets.ts, "Rims"): does a strip's
 * resonance depend on where its free edges fall inside their cells?
 *
 *  1. Slide: a 12.5 x 2.17 mm sheet strip 1.37 mm over the floor of a
 *     shielded channel (40 x 8 x 8 mm PEC box), slid along its length through
 *     a whole cell in ten steps. The box is long, so sliding barely changes
 *     the physics: any change in the strip mode is the grid's. Compared with
 *     the same strip on a graded mesh whose lines sit the plain sheet's own
 *     rim shift inside each rim (src/engine/sheet_rim.ts, beta = 1), where
 *     the rims are exact by construction.
 *  2. Turn: a 12 x 2 mm strip at the centre of a PEC sphere cavity (radius
 *     12 mm, conformal solid), turned four ways. Turning is an exact symmetry
 *     of the cavity, so the strip's lowest mode should not move at all.
 *
 * Each run is driven by a broadband pulse and read off the probe's spectrum
 * (Hann window, the strongest peak). Both rim modes ('snap', the old update,
 * and 'subcell') run on the same models. Nothing is fitted.
 *
 *   npx tsx scripts/validate/sheet_rims.ts [cells, default 1]  -> docs/validation/data/sheet_rims_<cell>mm.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { CONFORMAL_SOLID_COURANT } from '../../src/engine/conformal';
import { buildCpml, uniformFaces } from '../../src/engine/cpml';
import { CpuFdtd, vacuumModel } from '../../src/engine/fdtd_cpu';
import { gradedLines, smallestCell, uniformLines, type MeshLines } from '../../src/engine/mesh';
import { sheetRimShiftCells } from '../../src/engine/sheet_rim';
import type { VoxelModel } from '../../src/engine/voxelize';
import { addConformalSheets } from '../../src/project/conformal_sheets';
import { addConformalSolids, boxMesh, joinMeshes, ribbonMesh, segmentsForSag, sphereMesh } from '../../src/project/conformal_solids';
import { boxModel } from './conformal_solids';

type Vec3 = [number, number, number];
type Rims = 'snap' | 'subcell';

function airModel(mesh: MeshLines): VoxelModel {
  const grid = { ...DEFAULT_GRID, nx: mesh.x.length, ny: mesh.y.length, nz: mesh.z.length, dxMm: smallestCell(mesh), pmlCells: 0, groundK: 1, courant: CONFORMAL_SOLID_COURANT };
  const model = vacuumModel(grid, uniformFaces(0));
  model.mesh = mesh;
  model.cpml = buildCpml(grid, uniformFaces(0), undefined, mesh);
  return model;
}

/** The E edge of component `comp` nearest a point. */
function edgeNear(model: VoxelModel, p: Vec3, comp: number): number {
  const lines = [model.mesh.x, model.mesh.y, model.mesh.z];
  const ijk = [0, 1, 2].map((q) => {
    const l = lines[q];
    let best = 0;
    for (let n = 0; n + (q === comp ? 1 : 0) < l.length; n++) {
      const at = q === comp ? (l[n] + l[n + 1]) / 2 : l[n];
      const bestAt = q === comp ? (l[best] + l[best + 1]) / 2 : l[best];
      if (Math.abs(at - p[q]) < Math.abs(bestAt - p[q])) best = n;
    }
    return best;
  });
  const { nx, ny, nz } = model.grid;
  return comp * nx * ny * nz + ijk[0] + nx * (ijk[1] + ny * ijk[2]);
}

/** Strongest spectral peak (GHz) between fLo and fHi at the probe after a broadband pulse at the source. */
function strongestPeak(model: VoxelModel, source: number, probe: number, fLo: number, fHi: number, ns: number): number {
  if (model.eCurl[source] === 0 || model.eCurl[probe] === 0) throw new Error('source or probe edge is metal');
  const sim = new CpuFdtd(model);
  const dt = timestepSec(model.grid);
  const steps = Math.ceil((ns * 1e-9) / dt);
  const rec = new Float64Array(steps);
  const tau = 1 / (Math.PI * fHi * 1e9 * 0.5);
  const t0 = 4 * tau;
  for (let k = 0; k < steps; k++) {
    sim.updateH();
    sim.updateE();
    const t = k * dt;
    if (t < 2 * t0) sim.e[source] += Math.exp(-(((t - t0) / tau) ** 2));
    rec[k] = sim.e[probe];
  }
  const start = Math.ceil((2 * t0) / dt);
  const len = steps - start;
  const amp = (f: number) => {
    let [re, im] = [0, 0];
    for (let k = 0; k < len; k++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (len - 1));
      const ph = 2 * Math.PI * f * 1e9 * (start + k) * dt;
      re += w * rec[start + k] * Math.cos(ph);
      im -= w * rec[start + k] * Math.sin(ph);
    }
    return Math.hypot(re, im);
  };
  const df = 0.005;
  let [best, bestAmp] = [fLo, -1];
  for (let f = fLo; f <= fHi; f += df) {
    const a = amp(f);
    if (a > bestAmp) [best, bestAmp] = [f, a];
  }
  // Parabola through the log amplitudes around the peak.
  const [a, b, c] = [Math.log(amp(best - df)), Math.log(bestAmp), Math.log(amp(best + df))];
  return best + (0.5 * (a - c) * df) / (a - 2 * b + c);
}

const CHANNEL = { half: [20, 4, 4] as Vec3, length: 12.5, width: 2.17, height: 1.37, y: 0.13 };

/** Slide: the channel strip with its centre at x = shift. */
export function slideRun(h: number, shift: number, rims: Rims): number {
  const { half } = CHANNEL;
  const n = half.map((v) => 2 * Math.round(v / h));
  const model = airModel({ x: uniformLines(n[0] + 1, -half[0], h), y: uniformLines(n[1] + 1, -half[1], h), z: uniformLines(n[2] + 1, -half[2], h) });
  return channelPeak(model, h, shift, rims);
}

/** The channel strip on a graded mesh with lines the plain sheet's rim shift inside each rim (rims exact by construction). */
export function referenceRun(h: number): number {
  const { half, length, width, height, y } = CHANNEL;
  const z = -half[2] + height;
  const nz = 2 * Math.round(half[2] / h);
  const zLines = uniformLines(nz + 1, -half[2], h);
  const k = Math.floor((z - zLines[0]) / h);
  const inset = sheetRimShiftCells((z - zLines[k]) / h, 1) * h;
  const lines = (lo: number, hi: number, fixed: number[]) => {
    const ends = [lo, ...fixed, hi];
    return gradedLines(ends.slice(1).map((end, m) => ({ start: ends[m], end, maxCellMm: h })), { maxCellMm: h, maxGrowth: 1.3 }, fixed.map((at) => ({ at, cellMm: h })));
  };
  const model = airModel({
    x: lines(-half[0], half[0], [-length / 2 + inset, length / 2 - inset]),
    y: lines(-half[1], half[1], [y - width / 2 + inset, y + width / 2 - inset]),
    z: zLines,
  });
  return channelPeak(model, h, 0, 'snap');
}

function channelPeak(model: VoxelModel, h: number, shift: number, rims: Rims): number {
  const { half, length, width, height, y } = CHANNEL;
  const z = -half[2] + height;
  addConformalSheets(model, [ribbonMesh([[shift - length / 2, y, z], [shift + length / 2, y, z]], [[0, 1, 0], [0, 1, 0]], width)], { rims });
  const zProbe = -half[2] + 0.5 * h;
  const source = edgeNear(model, [shift + length / 2 - 0.7, y, zProbe], 2);
  const probe = edgeNear(model, [shift - length / 2 + 0.7, y, zProbe], 2);
  return strongestPeak(model, source, probe, 6, 11, 30);
}

const SPHERE_CENTRE: Vec3 = [0.23, -0.31, 0.17];
export const TURNS: Array<{ name: string; along: Vec3; up: Vec3 }> = [
  { name: 'along x', along: [1, 0, 0], up: [0, 0, 1] },
  { name: 'along y, normal x', along: [0, 1, 0], up: [1, 0, 0] },
  { name: 'turned 30 deg about z', along: [0.866, 0.5, 0], up: [0, 0, 1] },
  { name: 'along (1, 0.6, 0.8)', along: [1, 0.6, 0.8], up: [0, 1, 0] },
];

/** Turn: the strip at the centre of the sphere cavity, along `along`, its normal nearest `up`. */
export function turnRun(h: number, along: Vec3, up: Vec3, rims: Rims): number {
  const [radius, length, width] = [12, 12, 2];
  const unit = (v: Vec3): Vec3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const u = unit(along);
  const side = unit(cross(up, u));
  const normal = cross(u, side);
  const cavity = joinMeshes([boxMesh([-60, -60, -60], [60, 60, 60]), sphereMesh(SPHERE_CENTRE, radius, segmentsForSag(radius, 2e-4))]);
  const model = addConformalSolids(boxModel({ half: [radius + 1.5, radius + 1.5, radius + 1.5] }, h), [cavity]);
  const point = (a: number, n: number): Vec3 => [0, 1, 2].map((k) => SPHERE_CENTRE[k] + a * u[k] + n * normal[k]) as Vec3;
  addConformalSheets(model, [ribbonMesh([point(-length / 2, 0), point(length / 2, 0)], [side, side], width)], { rims });
  const comp = [0, 1, 2].reduce((m, k) => (Math.abs(normal[k]) > Math.abs(normal[m]) ? k : m), 0);
  const source = edgeNear(model, point(length / 2 - 1, 1.2), comp);
  const probe = edgeNear(model, point(-length / 2 + 1, 1.2), comp);
  return strongestPeak(model, source, probe, 6, 10, 25);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const h = Number(process.argv[2] ?? 1);
  const out = new URL('../../docs/validation/data/', import.meta.url);
  mkdirSync(out, { recursive: true });
  const reference = referenceRun(h);
  console.log(`slide reference (rim lines) ${reference.toFixed(3)} GHz`);
  const slide = [];
  for (let m = 0; m < 10; m++) {
    const shift = (m / 10) * h;
    const row = { shift_mm: shift, snap_ghz: slideRun(h, shift, 'snap'), subcell_ghz: slideRun(h, shift, 'subcell') };
    slide.push(row);
    console.log(`slide ${shift.toFixed(2)} mm: snap ${row.snap_ghz.toFixed(3)}, subcell ${row.subcell_ghz.toFixed(3)} GHz`);
  }
  const turn = [];
  for (const t of TURNS) {
    const row = { turn: t.name, snap_ghz: turnRun(h, t.along, t.up, 'snap'), subcell_ghz: turnRun(h, t.along, t.up, 'subcell') };
    turn.push(row);
    console.log(`turn ${t.name}: snap ${row.snap_ghz.toFixed(3)}, subcell ${row.subcell_ghz.toFixed(3)} GHz`);
  }
  writeFileSync(new URL(`sheet_rims_${h}mm.json`, out), `${JSON.stringify({ cell_mm: h, slide_reference_ghz: reference, slide, turn }, null, 1)}\n`);
}
