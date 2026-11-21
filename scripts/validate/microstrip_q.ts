/**
 * Conductor loss of a microstrip from the Q of a resonator, against Pucel and a 2D Wheeler solve.
 *
 * The Pozar Example 3.7 line (0.5 mm alumina, eps_r 9.9, lossless) cut to an
 * open-ended half-wave resonator and closed in a PEC box, so nothing radiates
 * and the only loss is the copper: the strip and the ground, both `copper` of
 * the given thickness. A Gaussian pulse at the resonance drives Ez under one
 * end; Ez under the other end rings down, and f0 and Q come from the decay
 * (ring_down.ts). Then
 *   alpha_c = omega / (2 Q v_g),
 * with the group velocity from Hammerstad-Jensen + Kirschning-Jansen eps_eff(f).
 * Two references at the solver's Rs (fixed at loss_reference_ghz, set to the
 * resonance) for the same copper thickness: Pucel's closed form, and a 2D
 * Wheeler incremental-inductance solve of the same boxed cross-section with a
 * strip of that thickness (wheeler_strip2d.ts). Pucel sits about 9 % below
 * Wheeler at W/h 1 and 6 % above it at W/h 8.
 * --no-edge-loss sets every copper edge back to the plain Rs (no edge factor).
 *
 *   npx tsx scripts/validate/microstrip_q.ts [--strip 0.5] [--cell 0.1] [--thickness 0.035] [--length 5.5] [--no-edge-loss]
 */
import { C0, timestepSec } from '../../src/engine/config';
import { withoutPorts } from '../../src/engine/coax_feed';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { surfaceResistanceOhm } from '../../src/engine/voxelize';
import { rasterise } from '../../src/project/rasterise';
import { parseProject } from '../../src/project/schema';
import { hammerstadJensenStatic, kirschningJansenEpsEff, pucelConductorLossNpPerM } from './closed_forms';
import { analyse } from './ring_down';
import { wheelerConductorLoss } from './wheeler_strip2d';

const arg = (name: string, fallback: number) => {
  const n = process.argv.indexOf(`--${name}`);
  return n > 0 ? Number(process.argv[n + 1]) : fallback;
};
const STRIP_MM = arg('strip', 0.5);
const CELL_MM = arg('cell', 0.1);
const THICKNESS_MM = arg('thickness', 0.035);
const LENGTH_MM = arg('length', 5.5);
/** 0: a uniform CELL_MM mesh. Otherwise a graded mesh with this cell at copper edges and DIELECTRIC_CELLS across the substrate. */
const EDGE_CELL_MM = arg('edge-cell', 0);
const DIELECTRIC_CELLS = arg('dielectric-cells', 5);
const NO_EDGE_LOSS = process.argv.includes('--no-edge-loss');
const H_MM = 0.5;
const EPS_R = 9.9;
const SIDE_MM = 2.5 + STRIP_MM / 2;
const COPPER_S_PER_M = 5.8e7;

const epsEffAt = (fGHz: number) => kirschningJansenEpsEff(STRIP_MM / H_MM, EPS_R, hammerstadJensenStatic(STRIP_MM / H_MM, EPS_R).epsEff, fGHz, H_MM);
// Resonance estimate: half a guided wavelength over the strip plus about 0.4 h of open-end extension at each end.
const fGuessGHz = C0 / (2 * (LENGTH_MM + 0.8 * H_MM) * 1e-3 * Math.sqrt(epsEffAt(10))) / 1e9;

function project(lossReferenceGHz: number) {
  const pec = { type: 'pec' };
  const rect = (x0: number, y0: number, x1: number, y1: number) => [[`${x0} mm`, `${y0} mm`], [`${x1} mm`, `${y0} mm`], [`${x1} mm`, `${y1} mm`], [`${x0} mm`, `${y1} mm`]];
  const halfY = LENGTH_MM / 2 + 2.5;
  return parseProject({
    noburf_project: 1,
    name: `microstrip-q-w${STRIP_MM}-cell${CELL_MM}`,
    variables: {},
    materials: { alumina: { eps_r: EPS_R, tan_delta: 0 } },
    stackup: [
      { type: 'copper', name: 'gnd', material: 'copper', thickness: `${THICKNESS_MM} mm` },
      { type: 'dielectric', name: 'core', material: 'alumina', thickness: `${H_MM} mm` },
      { type: 'copper', name: 'top', material: 'copper', thickness: `${THICKNESS_MM} mm` },
    ],
    board: { outline: rect(-SIDE_MM, -halfY, SIDE_MM, halfY) },
    geometry: {
      gnd: [{ id: 'ground', op: 'add', polygon: rect(-SIDE_MM, -halfY, SIDE_MM, halfY) }],
      top: [{ id: 'strip', op: 'add', polygon: rect(-STRIP_MM / 2, -LENGTH_MM / 2, STRIP_MM / 2, LENGTH_MM / 2) }],
    },
    // A port only to satisfy the project format; it is removed before the run.
    ports: [{ id: 'p', x: '0 mm', y: `${-LENGTH_MM / 2} mm`, between: ['top', 'gnd'], reference_impedance_ohm: 50 }],
    boundaries: { x_min: pec, x_max: pec, y_min: pec, y_max: pec, z_min: pec, z_max: pec },
    mesh: {
      cell: `${CELL_MM} mm`,
      air_margin_cells: { xy: 1, below: 2, above: Math.round(2.5 / CELL_MM) },
      ...(EDGE_CELL_MM > 0 ? { graded: { edge_cell: `${EDGE_CELL_MM} mm`, dielectric_cells: DIELECTRIC_CELLS, max_growth: 1.3 } } : {}),
    },
    analysis: { f_min_ghz: 5, f_max_ghz: 15, n_freq: 11, loss_reference_ghz: lossReferenceGHz, stop: { energy_decay_db: 60, max_steps: 100000 } },
    outputs: { zin_at_ghz: [] },
  });
}

function ringDown(lossReferenceGHz: number) {
  const { model: withPort } = rasterise(project(lossReferenceGHz));
  const model = withoutPorts(withPort, [{ port: 0, neighbourOffset: 1 }]);
  // Strip and ground are the same copper, so the plain Rs is one value.
  if (NO_EDGE_LOSS) model.sheets!.rsOhm.fill(surfaceResistanceOhm(COPPER_S_PER_M, lossReferenceGHz * 1e9));
  const { grid, mesh } = model;
  const N = grid.nx * grid.ny * grid.nz;
  const node = (lines: Float64Array, v: number) => {
    let best = 0;
    for (let n = 1; n < lines.length; n++) if (Math.abs(lines[n] - v) < Math.abs(lines[best] - v)) best = n;
    return best;
  };
  const k = node(mesh.z, H_MM / 2);
  const ez = (y: number) => 2 * N + node(mesh.x, 0) + grid.nx * (node(mesh.y, y) + grid.ny * k);
  const [src, probe] = [ez(-LENGTH_MM / 2 + 0.3), ez(LENGTH_MM / 2 - 0.3)];
  const solver = new CpuFdtd(model);
  const dt = timestepSec(grid);
  const fRef = fGuessGHz * 1e9;
  const tau = 1 / (Math.PI * 1e9);
  const t0 = 4 * tau;
  // 60 cycles of ring-down after the pulse: with Q of a few hundred, the amplitude falls by about half.
  const steps = Math.ceil((60 / fRef + 2 * t0) / dt);
  const rec = new Float64Array(steps);
  for (let n = 0; n < steps; n++) {
    solver.updateH();
    solver.updateE();
    const t = n * dt;
    if (t < 2 * t0) solver.e[src] += Math.exp(-(((t - t0) / tau) ** 2)) * Math.sin(2 * Math.PI * fRef * t);
    rec[n] = solver.e[probe];
  }
  return { cells: [grid.nx, grid.ny, grid.nz], steps, ...analyse(rec, dt, Math.ceil((2 * t0) / dt), fRef) };
}

const started = performance.now();
const r = ringDown(fGuessGHz);
const fGHz = r.f0_ghz;
const epsEff = epsEffAt(fGHz);
const df = 0.01;
const groupIndex = Math.sqrt(epsEff) + fGHz * (Math.sqrt(epsEffAt(fGHz + df)) - Math.sqrt(epsEffAt(fGHz - df))) / (2 * df);
const alpha = (2 * Math.PI * fGHz * 1e9) / (2 * r.q * (C0 / groupIndex));
const rs = surfaceResistanceOhm(COPPER_S_PER_M, fGuessGHz * 1e9);
const { z0Ohm } = hammerstadJensenStatic(STRIP_MM / H_MM, EPS_R);
const pucel = pucelConductorLossNpPerM(STRIP_MM, H_MM, THICKNESS_MM, z0Ohm, rs);
// The FDTD box: one air cell from the board edge to each side wall, the lid 2.5 mm above the strip.
const wheeler = rs * wheelerConductorLoss({ widthMm: STRIP_MM, thicknessMm: THICKNESS_MM, heightMm: H_MM, boxWidthMm: 2 * SIDE_MM + 2 * CELL_MM, boxHeightMm: H_MM + 2.5 }, EPS_R).alphaPerOhm;
const vs = (ref: number) => `${ref.toFixed(3)} (${((alpha / ref - 1) * 100).toFixed(1)} %)`;
console.log(`W ${STRIP_MM} mm (W/h ${(STRIP_MM / H_MM).toFixed(2)}), cell ${CELL_MM} mm${EDGE_CELL_MM > 0 ? `, graded: edge ${EDGE_CELL_MM} mm, ${DIELECTRIC_CELLS} substrate cells` : ''}, t ${(THICKNESS_MM * 1000).toFixed(0)} um: ${r.cells.join('x')} cells, ${r.steps} steps, ` +
  `f0 ${fGHz.toFixed(3)} GHz, Q ${r.q.toFixed(0)}, alpha_c ${alpha.toFixed(3)} Np/m${NO_EDGE_LOSS ? ' (no edge factor)' : ''} vs Wheeler 2D ${vs(wheeler)}, Pucel ${vs(pucel)}, ` +
  `${((performance.now() - started) / 1000).toFixed(0)} s`);
