/**
 * Vias against exact references (docs/vias.md).
 *
 *   post: a via and the port as two posts between parallel plates. Between
 *   plates the field of a vertical post is two-dimensional, so the loop
 *   inductance is (mu0 h / 2 pi) acosh((d^2 - r1^2 - r2^2) / (2 r1 r2)); for a
 *   port much thinner than d, changing only the drill changes L by a
 *   difference of those in which the port's own radius cancels. L comes from the low-frequency susceptance, B w = -1/L + w^2 C.
 *
 *   short: a 50 ohm microstrip ended by one via to ground, as
 *   validation/openems/via_openems.py builds it. The port is de-embedded to
 *   a plane 3 mm before the via; with the kit's own line impedance and
 *   permittivity the load at the via is moved back to its center, and its
 *   reactance read as an inductance, as the openEMS script does with its
 *   MSL port's Z0 and beta.
 *
 *   node --import tsx --import ./src/node/register_raw_imports.mjs scripts/validate/vias.ts post|short|short-checks [--cpu]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deembedSolve, solveProjectText } from '../noburf';

const DATA = 'docs/validation/data/vias.json';

/** Merges one case's results into DATA, keeping the other cases. */
function record(name: string, value: unknown) {
  let all: Record<string, unknown> = {};
  try {
    all = JSON.parse(readFileSync(DATA, 'utf8'));
  } catch {
    // first case
  }
  all[name] = value;
  writeFileSync(DATA, `${JSON.stringify(all, null, 1)}\n`);
}

const MU0_OVER_2PI_NH_PER_MM = 0.2;

function plates(drillMm: number, edgeCellMm: number) {
  const side = 20;
  const d = 5;
  const square = (s: number) => [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]].map(([x, y]) => [`${x} mm`, `${y} mm`]);
  return {
    noburf_project: 1,
    name: `via-post-${drillMm}`,
    variables: {},
    materials: { vac: { eps_r: 1, tan_delta: 0 } },
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'gap', material: 'vac', thickness: '1 mm' },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: square(side) },
    geometry: { gnd: [{ id: 'g', op: 'add', polygon: square(side) }], top: [{ id: 't', op: 'add', polygon: square(side) }] },
    ports: [{ id: 'p', x: `${-d / 2} mm`, y: '0 mm', between: ['gnd', 'top'], reference_impedance_ohm: 50 }],
    vias: [{ id: 'v', x: `${d / 2} mm`, y: '0 mm', drill: `${drillMm} mm`, between: ['gnd', 'top'] }],
    boundaries: Object.fromEntries(['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'].map((f) => [f, { type: 'pml', cells: 8 }])),
    mesh: { cell: '1 mm', air_margin_cells: { xy: 6, below: 6, above: 6 }, graded: { edge_cell: `${edgeCellMm} mm`, dielectric_cells: 5, max_growth: 1.3 } },
    analysis: { f_min_ghz: 0.1, f_max_ghz: 1, n_freq: 19, loss_reference_ghz: 1, stop: { energy_decay_db: 60, max_steps: 400000 } },
    outputs: { zin_at_ghz: [0.5] },
  };
}

/** Least squares of B w = -1/L + w^2 C over the band: L in nH. */
function loopInductanceNh(fGHz: Float64Array, zRe: Float64Array, zIm: Float64Array): number {
  const rows = Array.from(fGHz, (f, n) => {
    const w = 2 * Math.PI * f * 1e9;
    const b = -zIm[n] / (zRe[n] ** 2 + zIm[n] ** 2);
    return { x: w * w, y: b * w };
  });
  const m = rows.length;
  const sx = rows.reduce((a, r) => a + r.x, 0);
  const sy = rows.reduce((a, r) => a + r.y, 0);
  const sxx = rows.reduce((a, r) => a + r.x * r.x, 0);
  const sxy = rows.reduce((a, r) => a + r.x * r.y, 0);
  const intercept = (sy * sxx - sx * sxy) / (m * sxx - sx * sx);
  return -1e9 / intercept;
}

/** The 2D two-post inductance change from a drill of ra to rb (mm), the port's own post cancelling: (mu0 h / 2 pi) ln(...) in nH. */
function twoPostDeltaNh(hMm: number, dMm: number, ra: number, rb: number): number {
  // acosh((d^2 - r1^2 - r2^2) / (2 r1 r2)) with the port's r2 << d: ln((d^2 - r1^2) / (r1 r2)).
  const term = (r: number) => Math.log((dMm * dMm - r * r) / r);
  return MU0_OVER_2PI_NH_PER_MM * hMm * (term(rb) - term(ra));
}

async function post(useGpu: boolean) {
  const cases = [
    { edge: 0.2, drills: [1.6, 0.8, 0.4, 0.2, 0.15, 0.1, 0.05] },
    { edge: 0.1, drills: [1.6, 0.4, 0.2, 0.1] },
  ];
  const out: unknown[] = [];
  for (const { edge, drills } of cases) {
    const rows: Array<{ drillMm: number; lNh: number; steps: number; oneColumn: boolean }> = [];
    for (const drillMm of drills) {
      const solved = await solveProjectText(JSON.stringify(plates(drillMm, edge)), `post ${drillMm}`, useGpu, true);
      const lNh = loopInductanceNh(solved.spec.fGHz, solved.spec.zRe, solved.spec.zIm);
      const oneColumn = solved.warnings.some((w) => w.includes('one grid column'));
      rows.push({ drillMm, lNh, steps: solved.steps, oneColumn });
      console.log(`edge ${edge} drill ${drillMm} mm: L ${lNh.toFixed(4)} nH, ${solved.steps} steps, decay ${solved.energyDecayDb.toFixed(1)} dB${oneColumn ? ' (one column)' : ''}`);
    }
    const ref = rows[0];
    for (const row of rows.slice(1)) {
      const exact = twoPostDeltaNh(1, 5, ref.drillMm / 2, row.drillMm / 2);
      const got = row.lNh - ref.lNh;
      console.log(`RESULT edge ${edge} drill ${row.drillMm} vs ${ref.drillMm}: dL ${got.toFixed(4)} nH, exact ${exact.toFixed(4)} nH, error ${(got - exact).toFixed(4)} nH`);
      out.push({ edge_cell_mm: edge, drill_mm: row.drillMm, reference_drill_mm: ref.drillMm, one_column: row.oneColumn, steps: row.steps,
        l_nh: +row.lNh.toFixed(5), delta_l_nh: +got.toFixed(5), exact_delta_l_nh: +exact.toFixed(5), error_nh: +(got - exact).toFixed(5) });
    }
  }
  record('post', { what: 'two posts between 1 mm parallel plates, 5 mm apart: the change in loop inductance from the reference drill', rows: out });
}

const H_MM = 0.813;
const W_MM = 1.8;
const FEED_MM = 10;

interface ShortCase {
  drill: number;
  edge: number;
  /** Cells across the substrate. */
  dcells?: number;
  /** De-embedded plane before the via center, mm. */
  plane?: number;
}

function viaShort({ drill: drillMm, edge: edgeCellMm, dcells = 6, plane = 3 }: ShortCase) {
  const mm = (v: number) => `${v} mm`;
  const rect = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [mm(x), mm(y)]);
  const y0 = -plane - FEED_MM;
  const pad = 0.6;
  const boardEnd = pad + 2;
  return {
    noburf_project: 1,
    name: `via-short-${drillMm}`,
    variables: {},
    materials: { ro4003c_lossless: { eps_r: 3.55, tan_delta: 0 } },
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'core', material: 'ro4003c_lossless', thickness: mm(H_MM) },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: rect(-8, y0, 8, boardEnd) },
    geometry: { gnd: [{ id: 'g', op: 'add', polygon: rect(-8, y0, 8, boardEnd) }], top: [{ id: 'strip', op: 'add', polygon: rect(-W_MM / 2, y0, W_MM / 2, pad) }] },
    ports: [{ id: 'p', x: '0 mm', y: mm(y0), between: ['gnd', 'top'], reference_impedance_ohm: 50, deembed: { length: mm(FEED_MM) } }],
    vias: [{ id: 'v', x: '0 mm', y: '0 mm', drill: mm(drillMm), between: ['gnd', 'top'] }],
    boundaries: Object.fromEntries(['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'].map((f) => [f, { type: 'pml', cells: 8 }])),
    mesh: { cell: '0.5 mm', air_margin_cells: { xy: 4, below: 3, above: 10 }, graded: { edge_cell: mm(edgeCellMm), dielectric_cells: dcells, max_growth: 1.3 } },
    analysis: { f_min_ghz: 0.5, f_max_ghz: 8, n_freq: 151, loss_reference_ghz: 4, stop: { energy_decay_db: 50, max_steps: 600000 } },
    outputs: { zin_at_ghz: [2] },
  };
}

const C_MM_PER_NS = 299.792458;

async function shortRows(cases: ShortCase[], useGpu: boolean) {
  const out: unknown[] = [];
  for (const c of cases) {
    const { drill, edge, dcells = 6, plane = 3 } = c;
    const text = JSON.stringify(viaShort(c));
    const solved = await solveProjectText(text, `short ${drill}`, useGpu, true);
    const done = (await deembedSolve(solved, useGpu, true))!;
    const port = done.ports[0];
    const z0 = port.zLineOhm;
    const f = Array.from(done.s.fGHz);
    const lNh = f.map((fGHz, m) => {
      const [sr, si] = [done.s.re[0][0]![m], done.s.im[0][0]![m]];
      // Z at the plane, then moved back `plane` mm along the kit's line to the via center.
      const den = (1 - sr) ** 2 + si ** 2;
      const zin = { re: (50 * (1 - sr * sr - si * si)) / den, im: (50 * 2 * si) / den };
      const eps = port.epsEff[m];
      if (eps === null) return null;
      const t = Math.tan((2 * Math.PI * fGHz * Math.sqrt(eps) * plane) / C_MM_PER_NS);
      // Z0 (zin - j Z0 t) / (Z0 - j zin t)
      const num = { re: zin.re, im: zin.im - z0 * t };
      const dd = { re: z0 + zin.im * t, im: -zin.re * t };
      const qi = (num.im * dd.re - num.re * dd.im) / (dd.re ** 2 + dd.im ** 2);
      return ((z0 * qi) / (2 * Math.PI * fGHz * 1e9)) * 1e9;
    });
    const at = (g: number) => {
      const m = f.findIndex((v) => Math.abs(v - g) < 1e-6);
      return m < 0 || lNh[m] === null ? null : +lNh[m]!.toFixed(5);
    };
    const row = { drill_mm: drill, edge_cell_mm: edge, dielectric_cells: dcells, plane_mm: plane, z_line_ohm: +z0.toFixed(3), eps_eff_at_2: port.epsEff[f.findIndex((v) => Math.abs(v - 2) < 1e-6)],
      l_nh_at: Object.fromEntries([1, 2, 4, 6, 8].map((g) => [String(g), at(g)])), steps: solved.steps, warnings: done.warnings };
    console.log('RESULT', JSON.stringify(row));
    out.push(row);
  }
  return out;
}

async function short(useGpu: boolean) {
  const rows = await shortRows([{ drill: 0.4, edge: 0.1 }, { drill: 0.2, edge: 0.1 }, { drill: 0.8, edge: 0.1 }, { drill: 0.4, edge: 0.05 }], useGpu);
  record('short', { what: 'via at the end of a 50 ohm microstrip (RO4003C-like, h 0.813 mm, W 1.8 mm): its reactance as an inductance at the via center, from the de-embedded S11', rows });
}

/** Does the reading depend on the barrel's staircase, the substrate's cells or the plane? Finer via cells, twice the substrate cells, the plane twice as far. */
async function shortChecks(useGpu: boolean) {
  const rows = await shortRows([{ drill: 0.8, edge: 0.05 }, { drill: 0.4, edge: 0.1, dcells: 12 }, { drill: 0.4, edge: 0.1, plane: 6 }], useGpu);
  record('short_checks', { what: 'the short again with finer cells at the via (0.8 mm drill), 12 cells across the substrate, and the plane 6 mm before the via', rows });
}

const args = process.argv.slice(2);
const useGpu = !args.includes('--cpu');
if (args.includes('post')) await post(useGpu);
if (args.includes('short')) await short(useGpu);
if (args.includes('short-checks')) await shortChecks(useGpu);
