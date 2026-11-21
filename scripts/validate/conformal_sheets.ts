/**
 * Thin curved copper sheets (src/project/conformal_sheets.ts) against closed
 * forms on both sides of the sheet.
 *
 *  - Two concentric spheres: a thin PEC sheet of radius 6 mm inside a PEC
 *    sphere cavity of radius 11 mm (a conformal solid, conformal_solids.ts),
 *    centre off the mesh nodes. The sheet has field on both sides, so the run
 *    holds two cavities: the inner sphere, TM101 at k a = 2.743707 (Harrington,
 *    Time-Harmonic Electromagnetic Fields, section 6-4), and the shell between
 *    the spheres, whose lowest mode TM11 is the first root of
 *      jh1'(k a) yh1'(k b) - jh1'(k b) yh1'(k a) = 0
 *    with jh1(x) = x j1(x), yh1(x) = x y1(x) the Riccati-Bessel functions
 *    (Harrington 6-4: E_theta vanishes on both walls). Each is driven and
 *    probed on its own side; the other side is only there to be kept apart.
 *
 * The staircase compared against makes every edge the sheet crosses PEC: the
 * usual way to put a zero-thickness surface on a grid, it closes the surface
 * but moves it by up to half a cell. Every run is at CONFORMAL_SOLID_COURANT,
 * with the same outer cavity, so only the sheet differs. Nothing is fitted.
 *
 *   npx tsx scripts/validate/conformal_sheets.ts   -> docs/validation/data/conformal_sheets.json
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { C0 } from '../../src/engine/config';
import { materialSignature, type VoxelModel } from '../../src/engine/voxelize';
import { addConformalSheets } from '../../src/project/conformal_sheets';
import { addConformalSolids, boxMesh, joinMeshes, segmentsForSag, sphereMesh, type TriangleMesh } from '../../src/project/conformal_solids';
import { boxModel, ringDown } from './conformal_solids';

type Vec3 = [number, number, number];
type Method = 'staircase' | 'sheet';

const GHZ = C0 / 1e6; // c in mm * GHz
const CENTRE: Vec3 = [0.23, -0.31, 0.17];
const at = (offset: Vec3): Vec3 => [CENTRE[0] + offset[0], CENTRE[1] + offset[1], CENTRE[2] + offset[2]];

/** First root above `from` of f, by stepping and bisection. */
function firstRoot(f: (x: number) => number, from: number, step: number): number {
  let [a, fa] = [from, f(from)];
  for (let b = from + step; ; b += step) {
    const fb = f(b);
    if (fa * fb <= 0) {
      let [lo, hi] = [a, b];
      for (let n = 0; n < 100; n++) {
        const mid = (lo + hi) / 2;
        if (f(lo) * f(mid) <= 0) hi = mid;
        else lo = mid;
      }
      return (lo + hi) / 2;
    }
    [a, fa] = [b, fb];
  }
}

/** Derivatives of the Riccati-Bessel functions x j1(x) and x y1(x). */
const jh1d = (x: number) => Math.cos(x) / x - Math.sin(x) / (x * x) + Math.sin(x);
const yh1d = (x: number) => Math.sin(x) / x + Math.cos(x) / (x * x) - Math.cos(x);

/** Lowest TM mode between PEC spheres of radii a < b (GHz). */
export function shellTm11Ghz(a: number, b: number): number {
  const k = firstRoot((k) => jh1d(k * a) * yh1d(k * b) - jh1d(k * b) * yh1d(k * a), 1e-3 / b, 1e-3 / b);
  return (k * GHZ) / (2 * Math.PI);
}

/** The model with the outer PEC sphere (conformal solid) and the sheets, as sheets or staircased. */
function build(h: number, cavityRadius: number, sheets: TriangleMesh[], method: Method): VoxelModel {
  const half = cavityRadius + 1.5;
  const cavity = joinMeshes([boxMesh([-60, -60, -60], [60, 60, 60]), sphereMesh(CENTRE, cavityRadius, segmentsForSag(cavityRadius, 2e-4))]);
  const model = addConformalSolids(boxModel({ half: [half, half, half] }, h), [cavity]);
  if (method === 'sheet') return addConformalSheets(model, sheets);
  // Staircase: every edge the sheet crosses is PEC (read off the same crossings on an empty model).
  const crossed = addConformalSheets(boxModel({ half: [half, half, half] }, h), sheets).thinSheets?.crossedEdges ?? [];
  for (const e of crossed) model.eCurl[e] = 0;
  model.signature = materialSignature(model.eDecay, model.eCurl, model);
  return model;
}

export function concentric() {
  const [a, b] = [6, 11];
  return {
    a,
    b,
    sheet: sphereMesh(CENTRE, a, segmentsForSag(a, 2e-4)),
    inner: { name: `inner sphere TM101 (a ${a} mm)`, fGhz: (2.743707 * GHZ) / (2 * Math.PI * a), source: { at: at([0.9, 0.6, 0.3]), comp: 2 as const }, probe: { at: at([-1.8, 1.4, -1.1]), comp: 2 as const } },
    shell: { name: `shell TM11 (${a} to ${b} mm)`, fGhz: shellTm11Ghz(a, b), source: { at: at([8.4, 0.6, 0.3]), comp: 0 as const }, probe: { at: at([-0.7, 5.9, 5.8]), comp: 1 as const } },
  };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const OUT = new URL('../../docs/validation/data/', import.meta.url);
  mkdirSync(OUT, { recursive: true });
  const rows: object[] = [];
  const log = (row: Record<string, unknown>, text: string) => {
    rows.push(row);
    console.log(text);
  };
  const c = concentric();
  for (const h of [1.5, 1, 0.75, 0.5]) {
    for (const method of ['staircase', 'sheet'] as const) {
      const t0 = performance.now();
      const model = build(h, c.b, [c.sheet], method);
      for (const mode of [c.inner, c.shell]) {
        const r = ringDown(mode, model);
        const err = (r.f0_ghz - mode.fGhz) / mode.fGhz;
        log({ case: 'concentric', mode: mode.name, closed_form_ghz: mode.fGhz, cell_mm: h, method, f0_ghz: r.f0_ghz, error: err },
          `${mode.name.padEnd(30)} h ${h.toFixed(2)} ${method.padEnd(9)} ${r.f0_ghz.toFixed(4)} GHz vs ${mode.fGhz.toFixed(4)} (${(err * 100).toFixed(3)} %) ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      }
    }
  }
  writeFileSync(new URL('conformal_sheets.json', OUT), JSON.stringify({ references: { inner: 'Harrington 6-4, TM101 ka = 2.743707', shell: 'Harrington 6-4, TM11 between PEC spheres (Riccati-Bessel cross product)' }, rows }, null, 1));
}
