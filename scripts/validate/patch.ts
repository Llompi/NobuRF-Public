/**
 * Patch-antenna validation runs on the CPU reference solver (bit-for-bit the
 * same update equations as the WebGPU kernels; parity is checked by selftest).
 *
 *   npx tsx scripts/validate/patch.ts <job>
 *
 * Jobs (each writes docs/validation/data/patch_<job>.json):
 *   demo     baseline + inset 4 mm on the demo grid, 3000 and 12000 steps
 *   fine     baseline + inset 4 mm with 0.25 mm cells (2x refinement), same box
 *   bigbox   baseline + inset 4 mm, 0.5 mm cells, 2x the air and 2x the PML
 *   inset    inset-depth sweep 0..5 mm (converged ring-down)
 *   length   patch-length sweep 10..14 mm, edge-fed (grid-aligned lengths)
 *   length_inset4  11..13.5 mm with a 4 mm inset, incl. half-cell lengths (grid snapping)
 *   fields   frequency-domain |E| maps at resonance for the inset-4 patch
 *   strip    baseline + inset 4 mm on the demo grid with the strip port (lumped
 *            port across the feed width, openEMS's "strip" case), 12000 steps;
 *            the line-port runs of the same grid are in patch_demo.json
 *   notch    inset 4 mm with a 0.5 and a 1.5 mm notch gap (line port, demo grid):
 *            how much the inset response depends on how the 1 mm notch voxelises
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { DEFAULT_EXCITATION, DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { applyEdit, baselineGeometry, textbookPatchF0GHz } from '../../src/engine/geometry';
import { portSpectrum } from '../../src/engine/port_dft';
import { sourceParams, sourceValue } from '../../src/engine/source';
import type { ExcitationConfig, GeometryEdit, GridConfig, MicroGeometryDSL } from '../../src/engine/types';
import { voxelize, type LumpedPortKind } from '../../src/engine/voxelize';

const OUT = new URL('../../docs/validation/data/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const EXC: ExcitationConfig = { ...DEFAULT_EXCITATION, nFreq: 301 };

const GRIDS: Record<string, GridConfig> = {
  demo: DEFAULT_GRID,
  // Same physical box (32 x 32 x 24 mm) and PML thickness (4 mm), half the cell.
  fine: { ...DEFAULT_GRID, nx: 128, ny: 128, nz: 96, dxMm: 0.25, pmlCells: 16, groundK: 24 },
  // 0.5 mm cells, box 56 x 56 x 40 mm: 8 mm of air between the board and an 8 mm PML.
  bigbox: { ...DEFAULT_GRID, nx: 112, ny: 112, nz: 80, pmlCells: 16, groundK: 28 },
};

function geom(edit: GeometryEdit | null): MicroGeometryDSL {
  return edit ? applyEdit(baselineGeometry(), edit) : baselineGeometry();
}

/** Resonance as the peak of Re(Zin): defined even when the match is poor. */
function reZPeak(fGHz: Float64Array, zRe: Float64Array): number {
  let k = 0;
  for (let m = 1; m < zRe.length; m++) if (zRe[m] > zRe[k]) k = m;
  if (k === 0 || k === zRe.length - 1) return fGHz[k];
  // Parabolic refinement.
  const a = zRe[k - 1], b = zRe[k], c = zRe[k + 1];
  const off = (0.5 * (a - c)) / (a - 2 * b + c);
  return fGHz[k] + off * (fGHz[1] - fGHz[0]);
}

function solve(label: string, g: MicroGeometryDSL, grid: GridConfig, steps: number, portKind: LumpedPortKind = 'line') {
  const t0 = performance.now();
  const model = voxelize(g, grid, EXC.z0, portKind);
  // Same loop as CpuFdtd.run(), plus an Ez probe under the far radiating edge.
  // Its spectrum over the source spectrum peaks at the cavity (TM010)
  // resonance, independent of the feed line that sits between patch and port.
  const s = new CpuFdtd(model);
  const dt = timestepSec(grid);
  const sp = sourceParams(EXC);
  const v = new Float32Array(steps), i = new Float32Array(steps);
  const edge = new Float64Array(steps), src = new Float64Array(steps);
  const { nx, ny } = grid;
  const N = nx * ny * grid.nz;
  const jEdge = Math.floor((g.patch.l_mm / 2) / grid.dxMm - 0.5 + 1e-9) + ny / 2;
  const probe = 2 * N + nx / 2 + nx * (jEdge + ny * (grid.groundK + 1));
  for (let n = 0; n < steps; n++) {
    s.updateH();
    s.updateE();
    src[n] = sourceValue(sp, (n + 0.5) * dt);
    const [vn, inn] = s.updatePort(src[n], 0)[0];
    v[n] = vn; i[n] = inn;
    edge[n] = s.e[probe];
  }
  const spec = portSpectrum({ v, i, dtSec: dt }, EXC);
  const ratio = Array.from(spec.fGHz, (f) => {
    const w = 2 * Math.PI * f * 1e9 * dt;
    let er = 0, ei = 0, sr = 0, si = 0;
    for (let n = 0; n < steps; n++) {
      const c = Math.cos(w * n), q = Math.sin(w * n);
      er += edge[n] * c; ei -= edge[n] * q; sr += src[n] * c; si -= src[n] * q;
    }
    return Math.hypot(er, ei) / Math.hypot(sr, si);
  });
  let k = 0;
  for (let m = 1; m < spec.s11Db.length; m++) if (spec.s11Db[m] < spec.s11Db[k]) k = m;
  const r = {
    label,
    dx_mm: grid.dxMm,
    grid: [grid.nx, grid.ny, grid.nz],
    cells: grid.nx * grid.ny * grid.nz,
    steps,
    port: portKind,
    port_columns: model.ports[0].columns,
    time_ns: (steps * timestepSec(grid)) / 1e-9,
    geometry: { L: g.patch.l_mm, W: g.patch.w_mm, inset: g.feed.inset_depth_mm },
    f_s11min_ghz: spec.fGHz[k],
    s11_min_db: spec.s11Db[k],
    f_rezpeak_ghz: reZPeak(spec.fGHz, spec.zRe),
    f_cavity_ghz: reZPeak(spec.fGHz, Float64Array.from(ratio)),
    edge_response: ratio.map((x) => +x.toExponential(3)),
    f_textbook_ghz: textbookPatchF0GHz(g),
    residual: spec.residual,
    wall_s: (performance.now() - t0) / 1000,
    f_ghz: Array.from(spec.fGHz, (v) => +v.toFixed(4)),
    s11_db: Array.from(spec.s11Db, (v) => +v.toFixed(3)),
    zin_re: Array.from(spec.zRe, (v) => +v.toFixed(3)),
    zin_im: Array.from(spec.zIm, (v) => +v.toFixed(3)),
  };
  console.log(`${label}: f(S11min) ${r.f_s11min_ghz.toFixed(3)} GHz, S11 ${r.s11_min_db.toFixed(2)} dB, ` +
    `f(ReZ peak) ${r.f_rezpeak_ghz.toFixed(3)}, f(cavity) ${r.f_cavity_ghz.toFixed(3)}, textbook ${r.f_textbook_ghz.toFixed(3)}, ${r.wall_s.toFixed(0)} s`);
  return r;
}

/** Same solve, plus a running DFT of Ez at frequency f on two planes. */
function fieldMaps(g: MicroGeometryDSL, grid: GridConfig, steps: number, fGHz: number) {
  const model = voxelize(g, grid, EXC.z0);
  const s = new CpuFdtd(model);
  const { nx, ny, nz } = grid;
  const N = nx * ny * nz;
  const dt = timestepSec(grid);
  const sp = sourceParams(EXC);
  const kMid = grid.groundK + 1; // Ez node in the middle of the 3-cell substrate
  const iCut = nx / 2 + 8; // y-z cut 4 mm off the feed axis (avoids the feed line)
  const xyRe = new Float64Array(nx * ny), xyIm = new Float64Array(nx * ny);
  const yzRe = new Float64Array(ny * nz), yzIm = new Float64Array(ny * nz);
  const xyEy = new Float64Array(nx * ny), xyEyI = new Float64Array(nx * ny);
  const w = 2 * Math.PI * fGHz * 1e9;
  for (let n = 0; n < steps; n++) {
    s.updateH();
    s.updateE();
    s.updatePort(sourceValue(sp, (n + 0.5) * dt), 0);
    const cr = Math.cos(w * (n + 1) * dt), ci = -Math.sin(w * (n + 1) * dt);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = i + nx * (j + ny * kMid);
      const v = s.e[2 * N + c];
      xyRe[i + nx * j] += v * cr; xyIm[i + nx * j] += v * ci;
      // Tangential fringing field just above the patch plane.
      const cu = i + nx * (j + ny * (model.patchK + 1));
      const vy = s.e[N + cu];
      xyEy[i + nx * j] += vy * cr; xyEyI[i + nx * j] += vy * ci;
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) {
      const c = iCut + nx * (j + ny * k);
      yzRe[j + ny * k] += s.e[2 * N + c] * cr;
      yzIm[j + ny * k] += s.e[2 * N + c] * ci;
    }
  }
  const mag = (a: Float64Array, b: Float64Array) => Array.from(a, (v, q) => +Math.hypot(v, b[q]).toExponential(3));
  // Signed real part after rotating to the phase of the strongest cell: shows the half-wave sign flip.
  let qMax = 0;
  for (let q = 1; q < xyRe.length; q++) if (Math.hypot(xyRe[q], xyIm[q]) > Math.hypot(xyRe[qMax], xyIm[qMax])) qMax = q;
  const ph = Math.atan2(xyIm[qMax], xyRe[qMax]);
  const signed = Array.from(xyRe, (v, q) => +(v * Math.cos(ph) + xyIm[q] * Math.sin(ph)).toExponential(3));
  return {
    f_ghz: fGHz, nx, ny, nz, dx_mm: grid.dxMm, groundK: grid.groundK, patchK: model.patchK, iCut,
    topCopper: Array.from(model.topCopper),
    ez_mid_substrate_mag: mag(xyRe, xyIm),
    ez_mid_substrate_signed: signed,
    ey_above_patch_mag: mag(xyEy, xyEyI),
    eyz_cut_mag: mag(yzRe, yzIm),
  };
}

const job = process.argv[2];
const t0 = performance.now();
let out: unknown;
switch (job) {
  case 'demo':
    out = [
      solve('baseline 3000', geom(null), GRIDS.demo, 3000),
      solve('inset4 3000', geom({ inset_depth_mm: 4 }), GRIDS.demo, 3000),
      solve('baseline 12000', geom(null), GRIDS.demo, 12000),
      solve('inset4 12000', geom({ inset_depth_mm: 4 }), GRIDS.demo, 12000),
    ];
    break;
  case 'fine': {
    // One file per case (patch_fine_baseline.json, patch_fine_inset4.json), which is what plot.py reads.
    const which = process.argv[3] ?? 'both';
    if (!['both', 'baseline', 'inset4'].includes(which)) throw new Error('fine takes baseline | inset4 | both');
    for (const c of ['baseline', 'inset4'] as const) {
      if (which !== 'both' && which !== c) continue;
      const r = solve(`${c} fine`, geom(c === 'inset4' ? { inset_depth_mm: 4 } : null), GRIDS.fine, 24000);
      writeFileSync(new URL(`patch_fine_${c}.json`, OUT), JSON.stringify([r]));
    }
    console.log(`fine done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    process.exit(0);
  }
  case 'bigbox':
    out = [
      solve('baseline bigbox', geom(null), GRIDS.bigbox, 12000),
      solve('inset4 bigbox', geom({ inset_depth_mm: 4 }), GRIDS.bigbox, 12000),
    ];
    break;
  case 'inset':
    out = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5].map((d) =>
      solve(`inset ${d}`, geom(d ? { inset_depth_mm: d } : null), GRIDS.demo, 12000));
    break;
  case 'length':
    // Edge-fed (the case the transmission-line model describes), lengths whose
    // edges fall on grid nodes so the voxelised length equals the requested one.
    out = [10, 11, 12, 13, 14].map((L) =>
      solve(`L ${L}`, geom({ patch_l_mm: L }), GRIDS.demo, 12000));
    break;
  case 'length_inset4':
    // Includes half-cell lengths on purpose: shows how edits snap to the 0.5 mm grid.
    out = [11, 11.5, 12, 12.4, 13, 13.5].map((L) =>
      solve(`L ${L}`, geom({ inset_depth_mm: 4, patch_l_mm: L }), GRIDS.demo, 12000));
    break;
  case 'fields': {
    const g = geom({ inset_depth_mm: 4 });
    const r = solve('inset4 for fields', g, GRIDS.demo, 12000);
    out = { solve: r, maps: fieldMaps(g, GRIDS.demo, 12000, r.f_cavity_ghz) };
    break;
  }
  case 'strip':
    out = [
      solve('baseline strip 12000', geom(null), GRIDS.demo, 12000, 'strip'),
      solve('inset4 strip 12000', geom({ inset_depth_mm: 4 }), GRIDS.demo, 12000, 'strip'),
    ];
    break;
  case 'notch':
    out = [0.5, 1.5].map((gap) =>
      solve(`inset4 gap ${gap}`, geom({ inset_depth_mm: 4, inset_gap_mm: gap }), GRIDS.demo, 12000));
    break;
  default:
    console.error('job must be one of demo | fine | bigbox | inset | length | length_inset4 | fields | strip | notch');
    process.exit(2);
}
writeFileSync(new URL(`patch_${job}.json`, OUT), JSON.stringify(out));
console.log(`${job} done in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
