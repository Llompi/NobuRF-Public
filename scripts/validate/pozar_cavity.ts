/**
 * Pozar, Microwave Engineering, 4th ed., Example 6.3: a copper WR-187 cavity
 * (a = 4.755 cm, b = 2.215 cm) filled with polyethylene (eps_r 2.25,
 * tan delta 0.0004), cut to resonate at 5 GHz in the TE101 and TE102 modes.
 * The book gives the lengths d, the conductor Q (Q_c), the dielectric Q
 * (Q_d = 1 / tan delta) and the total Q. This script builds the same box on a
 * rectilinear mesh, rings it down and reads f0 and Q from the decay.
 *
 *   npx tsx scripts/validate/pozar_cavity.ts     -> docs/validation/data/pozar_cavity.json
 *
 * Wall loss. The solver's conductor model is a PEC sheet with a surface
 * impedance Rs on its faces (voxelize.ts ConductorSheets). Here it is applied to the
 * tangential E edges of the three walls at the low faces (x = 0, y = 0,
 * z = 0); the three high walls stay perfect, because the kernel makes them
 * PEC by reading missing neighbours as zero. In a TE10l mode the two walls of
 * each opposite pair carry the same |H_t|^2, so the lossy walls dissipate
 * exactly half of Pozar's P_c and the expected Q_c here is twice the book's.
 * The comparison below is made against that doubled figure and says so.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { C0, DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { buildCpml, uniformFaces } from '../../src/engine/cpml';
import { CpuFdtd, pecBoxModel } from '../../src/engine/fdtd_cpu';
import { uniformLines, type MeshLines } from '../../src/engine/mesh';
import type { GridConfig } from '../../src/engine/types';
import { dielectricEdge, lossTangentSigmaDtOverEps0, surfaceResistanceOhm } from '../../src/engine/voxelize';
import { fitSurfaceShape, surfacePoles } from '../../src/engine/surface_impedance';
import { analyse } from './ring_down';

const MU0 = 4e-7 * Math.PI;
const ETA0 = MU0 * C0;

/** Pozar Example 6.3 inputs, as printed. */
const BOOK = {
  aCm: 4.755,
  bCm: 2.215,
  epsR: 2.25,
  tanDelta: 0.0004,
  copperSPerM: 5.813e7,
  fGHz: 5,
};

/** Pozar eq. 6.46 (Q_c of a TE10l cavity) and 6.47 (Q_d), for the book's box. */
function pozarQ(l: number) {
  const a = BOOK.aCm / 100, b = BOOK.bCm / 100;
  const f = BOOK.fGHz * 1e9;
  const k = (2 * Math.PI * f * Math.sqrt(BOOK.epsR)) / C0;
  const d = (l * Math.PI) / Math.sqrt(k * k - (Math.PI / a) ** 2);
  const rs = surfaceResistanceOhm(BOOK.copperSPerM, f);
  const eta = ETA0 / Math.sqrt(BOOK.epsR);
  const qc = ((k * a * d) ** 3 * b * eta) /
    (2 * Math.PI ** 2 * rs * (2 * l ** 2 * a ** 3 * b + 2 * b * d ** 3 + l ** 2 * a ** 3 * d + a * d ** 3));
  const qd = 1 / BOOK.tanDelta;
  return { l, d_cm: d * 100, rs_ohm: rs, q_c: qc, q_d: qd, q: 1 / (1 / qc + 1 / qd) };
}

/**
 * copper: Rs fixed at 5 GHz, as before the skin-effect model. copper_sqrt_f: the
 * skin-effect impedance (1 + j) Rs(f) fitted on 4-6 GHz (surface_impedance.ts), as
 * rasterise gives every copper layer since: the same resistance at 5 GHz, plus the
 * surface reactance, which lowers f0 by f0 / (2 Q_c) (Q_c of the lossy walls).
 */
interface Run { l: number; walls: 'pec' | 'copper' | 'copper_sqrt_f'; dielectric: 'lossless' | 'lossy' }

/** Cells per axis: about 1 mm, with nodes exactly on every wall. */
const CELLS_PER_CM = 10;

function ringDown(run: Run) {
  const book = pozarQ(run.l);
  const dims = [BOOK.aCm, BOOK.bCm, book.d_cm].map((cm) => cm * 10);
  const counts = dims.map((mm) => Math.round((mm / 10) * CELLS_PER_CM));
  const cells = dims.map((mm, n) => mm / counts[n]);
  const dRef = Math.min(...cells);
  const [nx, ny, nz] = counts;
  const grid: GridConfig = { ...DEFAULT_GRID, nx, ny, nz, dxMm: dRef, pmlCells: 0, groundK: 1 };
  const mesh: MeshLines = { x: uniformLines(nx, 0, cells[0]), y: uniformLines(ny, 0, cells[1]), z: uniformLines(nz, 0, cells[2]) };
  const model = pecBoxModel(grid, BOOK.epsR);
  model.mesh = mesh;
  model.cpml = buildCpml(grid, uniformFaces(0), undefined, mesh);

  const dt = timestepSec(grid);
  const fRef = BOOK.fGHz * 1e9;
  const N = nx * ny * nz;
  if (run.dielectric === 'lossy') {
    const edge = dielectricEdge(grid.courant, BOOK.epsR, lossTangentSigmaDtOverEps0(BOOK.epsR, BOOK.tanDelta, fRef, dt));
    for (let n = 0; n < 3 * N; n++) {
      if (model.eCurl[n] === 0) continue;
      model.eDecay[n] = edge.decay;
      model.eCurl[n] = edge.curl;
    }
  }
  if (run.walls !== 'pec') {
    // Tangential E edges on the low walls: index 0 along an axis normal to the edge.
    const rs = surfaceResistanceOhm(BOOK.copperSPerM, fRef);
    const eIndex: number[] = [];
    const normalAxis: number[] = [];
    const set = (n: number, wallAxis: number) => {
      model.eDecay[n] = 1;
      model.eCurl[n] = 0;
      eIndex.push(n);
      normalAxis.push(wallAxis);
    };
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const c = i + nx * (j + ny * k);
      // Ex lies in the y = 0 and z = 0 walls, Ey in x = 0 and z = 0, Ez in x = 0 and y = 0.
      // An edge in two walls (a box corner line) carries no TE10l current; leave it PEC.
      if ((j === 0) !== (k === 0)) set(c, j === 0 ? 1 : 2);
      if ((i === 0) !== (k === 0)) set(N + c, i === 0 ? 0 : 2);
      if ((i === 0) !== (j === 0)) set(2 * N + c, i === 0 ? 0 : 1);
    }
    model.sheets = { eIndex: Uint32Array.from(eIndex), normalAxis: Uint8Array.from(normalAxis), rsOhm: new Float32Array(eIndex.length).fill(rs) };
    if (run.walls === 'copper_sqrt_f') {
      const poles = surfacePoles(4e9, 6e9);
      const { shape } = fitSurfaceShape(BOOK.copperSPerM, null, 4e9, 6e9, fRef, poles);
      model.sheets.surface = { cornerHz: poles.cornerHz, shapes: [shape], shapeIndex: new Uint8Array(eIndex.length) };
    }
  }

  const solver = new CpuFdtd(model);
  // TE10l: E along y, peak at x = a/2. Drive Ey off the z mid-plane so both l = 1 and l = 2 see it.
  const at = (fx: number, fy: number, fz: number) => Math.floor(fx * nx) + nx * (Math.floor(fy * ny) + ny * Math.floor(fz * nz));
  const src = N + at(0.5, 0.5, 0.3 / run.l);
  const probe = N + at(0.45, 0.4, 0.2 / run.l);
  // Gaussian-modulated sine at 5 GHz, about 1 GHz wide: TE10l only.
  const tau = 1 / (Math.PI * 0.5e9);
  const t0 = 4 * tau;
  // 150 ns of ring-down: about 750 cycles. A single clean mode needs only a
  // few percent of decay for the slope fit, and the near-lossless runs would
  // otherwise take millions of steps.
  const totalSec = 150e-9 + 2 * t0;
  const steps = Math.ceil(totalSec / dt);
  const rec = new Float64Array(steps);
  for (let n = 0; n < steps; n++) {
    solver.updateH();
    solver.updateE();
    const t = n * dt;
    if (t < 2 * t0) solver.e[src] += Math.exp(-(((t - t0) / tau) ** 2)) * Math.sin(2 * Math.PI * fRef * t);
    rec[n] = solver.e[probe];
  }
  return { run, book, mesh_cells: counts, cell_mm: cells, steps, dt, ...analyse(rec, dt, Math.ceil((2 * t0) / dt), fRef) };
}

/* ------------------------------------------------------------------ main */

const OUT = new URL('../../docs/validation/data/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const runs: Run[] = [
  { l: 1, walls: 'pec', dielectric: 'lossy' },
  { l: 1, walls: 'copper', dielectric: 'lossless' },
  { l: 1, walls: 'copper', dielectric: 'lossy' },
  { l: 2, walls: 'copper', dielectric: 'lossy' },
  { l: 1, walls: 'copper_sqrt_f', dielectric: 'lossless' },
];
const results = [];
for (const run of runs) {
  const t0 = performance.now();
  const r = ringDown(run);
  const b = r.book;
  // Expected Q for this run: only the low walls are lossy (see header), so Q_c doubles.
  const qcHere = 2 * b.q_c;
  const expectedQ = 1 / ((run.walls !== 'pec' ? 1 / qcHere : 0) + (run.dielectric === 'lossy' ? 1 / b.q_d : 0));
  const row = { ...r, expected_q: expectedQ, q_err: (r.q - expectedQ) / expectedQ, f_err: (r.f0_ghz - BOOK.fGHz) / BOOK.fGHz };
  results.push(row);
  console.log(`TE10${run.l} walls ${run.walls} dielectric ${run.dielectric}: d ${b.d_cm.toFixed(3)} cm, ${r.mesh_cells.join('x')} cells, ${r.steps} steps, ` +
    `f0 ${r.f0_ghz.toFixed(4)} GHz (${(row.f_err * 100).toFixed(2)} %), Q ${r.q.toFixed(0)} vs ${expectedQ.toFixed(0)} (${(row.q_err * 100).toFixed(1)} %), ` +
    `${((performance.now() - t0) / 1000).toFixed(0)} s`);
}
console.log('Pozar book values:', [1, 2].map(pozarQ));
writeFileSync(new URL('pozar_cavity.json', OUT), JSON.stringify({ source: 'Pozar, Microwave Engineering, 4th ed., Example 6.3', book_inputs: BOOK, book: [1, 2].map(pozarQ), results }, null, 1));
