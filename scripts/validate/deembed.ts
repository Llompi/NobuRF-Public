/**
 * Port de-embedding validation (ports[].deembed, src/project/deembed_kit.ts).
 *
 *   npm run validate:deembed [-- line|planes|alumina ...] [--cpu]
 *
 * Every structure is solved the way `noburf solve` solves it, then
 * de-embedded with the kit NobuRF builds from the project. Writes
 * docs/validation/data/deembed.json and prints a summary.
 *
 * - line: a 30 mm, 50 ohm line on RO4003C between two 10 mm feeds. After
 *   de-embedding, what is left must be that line alone: the ideal line with
 *   the impedance and propagation constant the kit measured. The difference
 *   is everything the port leaves behind.
 * - planes: Pozar Ex. 5.5's quarter-wave section (22.36 ohm, 14.32 mm) with
 *   10 mm feeds and with 16 mm feeds, each de-embedded to the section's ends.
 *   Both put their reference planes in the same place, so the de-embedded
 *   S-matrices must agree; the raw ones do not.
 * - quarter-wave: the 10 mm version terminated in 10 ohm, as Pozar Ex. 5.5
 *   grades it (|Gamma| <= 0.2 band around 3 GHz), against the book and against
 *   the textbook exam's external calibration of the same structure.
 * - alumina: the 50 ohm line of Pozar Ex. 3.7 (W/h = 1 on 0.5 mm of
 *   eps_r 9.9, lossless) between 10 mm feeds: the kit's eps_eff at 10 GHz
 *   against openEMS's MSL port (6.88, validation.md section 7.3), and its
 *   low-frequency impedance against Hammerstad-Jensen's static 49.05 ohm.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { abcdToS, lineAbcd } from '../../src/engine/deembed';
import type { Complex, ScatteringResult } from '../../src/engine/port_dft';
import { deembedProject, type KitSolver, type PortDeembedding } from '../../src/project/deembed_kit';
import { parseProject, type Project } from '../../src/project/schema';
import { passivityCheck } from '../../src/verify/checks';
import { solveProjectText } from '../noburf';

const useGpu = !process.argv.includes('--cpu');
const C_MM_PER_NS = 299.792458;
const RO4003C = { epsR: 3.55, hMm: 0.813 };
/** Pozar eq. 3.197 widths, as the textbook exam drew them (scripts/textbook_exam/exam.py). */
const W50_MM = 1.8186;
const W22_MM = 5.5676;
const SECTION_MM = 14.3202;

type Rect = [x0: number, y0: number, x1: number, y1: number];
const mm = (v: number) => `${v.toFixed(4)} mm`;
const polygon = ([x0, y0, x1, y1]: Rect) => [[mm(x0), mm(y0)], [mm(x1), mm(y0)], [mm(x1), mm(y1)], [mm(x0), mm(y1)]];

/** Top copper over a full ground on one substrate, ports at the ends of the traces; the layout of build.py's microstrip_project. */
function microstrip(name: string, sub: { epsR: number; hMm: number }, traces: Rect[], feedMm: number, band: [number, number, number], mesh: { cell: number; edge: number; dielectricCells: number }): Project {
  const xs = traces.flatMap((r) => [r[0], r[2]]);
  const ys = traces.flatMap((r) => [r[1], r[3]]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const outline: Rect = [x0 - 2, Math.min(...ys) - 6, x1 + 2, Math.max(...ys) + 6];
  return parseProject({
    noburf_project: 1,
    name,
    variables: {},
    materials: { substrate: { eps_r: sub.epsR, tan_delta: 0 } },
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'core', material: 'substrate', thickness: mm(sub.hMm) },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: polygon(outline) },
    geometry: { gnd: [{ id: 'ground', op: 'add', polygon: polygon(outline) }], top: traces.map((r, n) => ({ id: `trace${n + 1}`, op: 'add', polygon: polygon(r) })) },
    ports: [
      { id: 'p1', x: mm(x0), y: mm(0), between: ['gnd', 'top'], reference_impedance_ohm: 50, deembed: { length: mm(feedMm) } },
      { id: 'p2', x: mm(x1), y: mm(0), between: ['gnd', 'top'], reference_impedance_ohm: 50, deembed: { length: mm(feedMm) } },
    ],
    boundaries: Object.fromEntries(['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'].map((f) => [f, { type: 'pml', cells: 8 }])),
    mesh: { cell: mm(mesh.cell), air_margin_cells: { xy: 4, below: 3, above: 12 }, graded: { edge_cell: mm(mesh.edge), dielectric_cells: mesh.dielectricCells, max_growth: 1.3 } },
    analysis: { f_min_ghz: band[0], f_max_ghz: band[1], n_freq: band[2], loss_reference_ghz: (band[0] + band[1]) / 2, stop: { energy_decay_db: 50, max_steps: 60000 } },
    outputs: { zin_at_ghz: [] },
  });
}

const RO_MESH = { cell: 1, edge: 0.2, dielectricCells: 4 };
const RO_BAND: [number, number, number] = [0.25, 6.5, 126];

const kitCache = new Map<string, Promise<ScatteringResult>>();
const solveKit: KitSolver = (kit) => {
  const key = JSON.stringify({ ...kit, name: '' });
  if (!kitCache.has(key)) kitCache.set(key, solveProjectText(JSON.stringify(kit), kit.name, useGpu, true).then((r) => r.scattering!));
  return kitCache.get(key)!;
};

async function solveAndDeembed(project: Project) {
  const solved = await solveProjectText(JSON.stringify(project), project.name, useGpu, true);
  const raw = solved.scattering!;
  const done = await deembedProject(project, raw, solveKit, (line) => console.log(line));
  done.warnings.forEach((w) => console.warn(`warning: ${w}`));
  return { raw, s: done.s, ports: done.ports, warnings: done.warnings };
}

const at = (s: ScatteringResult, i: number, j: number, m: number): Complex => [s.re[i][j]![m], s.im[i][j]![m]];
const dist = (a: Complex, b: Complex) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const round = (x: number, digits = 5) => Number(x.toPrecision(digits));

/** Largest |S_ij - S'_ij| over the band (every entry). */
function largestDifference(a: ScatteringResult, b: ScatteringResult): { value: number; atGhz: number } {
  let best = { value: 0, atGhz: a.fGHz[0] };
  for (let m = 0; m < a.fGHz.length; m++) {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const d = dist(at(a, i, j, m), at(b, i, j, m));
      if (d > best.value) best = { value: d, atGhz: a.fGHz[m] };
    }
  }
  return { value: round(best.value), atGhz: round(best.atGhz) };
}

const largestS11 = (s: ScatteringResult) => round(Math.max(...Array.from(s.fGHz, (_, m) => Math.hypot(...at(s, 0, 0, m)))));

function lineReport(p: PortDeembedding) {
  return { port: p.feed.portId, z_line_ohm: round(p.zLineOhm), eps_eff_guess: round(p.epsEffGuess), extra_lines_mm: p.kit.extraLinesMm.map((x) => round(x)), solves: p.kit.solves, reused_from: p.kit.reusedFrom, half_thru_ghz: p.halfThruGHz.map((x) => round(x)) };
}

async function caseLine() {
  const lineMm = 30;
  const feed = 10;
  const dut = await solveAndDeembed(microstrip('deembed-line', RO4003C, [[-lineMm / 2 - feed, -W50_MM / 2, lineMm / 2 + feed, W50_MM / 2]], feed, RO_BAND, RO_MESH));
  const p = dut.ports[0];
  // The ideal 30 mm line with the kit's own line parameters, where the kit measured gamma.
  let worst = { value: 0, atGhz: 0 };
  let compared = 0;
  for (let m = 0; m < dut.s.fGHz.length; m++) {
    const gamma = p.epsEff[m] === null ? null : ([p.lossDbPerMm[m]! * Math.LN10 / 20, (2 * Math.PI * dut.s.fGHz[m] / C_MM_PER_NS) * Math.sqrt(p.epsEff[m]!)] as Complex);
    if (!gamma) continue;
    compared++;
    const ideal = abcdToS(lineAbcd(gamma, lineMm, [p.zLineOhm, 0]), 50);
    const pairs: Array<[Complex, Complex]> = [[at(dut.s, 0, 0, m), ideal.s11], [at(dut.s, 1, 0, m), ideal.s21], [at(dut.s, 0, 1, m), ideal.s12], [at(dut.s, 1, 1, m), ideal.s22]];
    for (const [x, y] of pairs) if (dist(x, y) > worst.value) worst = { value: dist(x, y), atGhz: dut.s.fGHz[m] };
  }
  return {
    description: '30 mm 50 ohm line on RO4003C (0.813 mm, eps_r 3.55, lossless) between 10 mm feeds, both de-embedded',
    kit: dut.ports.map(lineReport),
    max_abs_s11: { raw: largestS11(dut.raw), deembedded: largestS11(dut.s) },
    vs_ideal_line: { max_abs_difference: round(worst.value), at_ghz: round(worst.atGhz), frequencies_compared: compared },
    passivity: passivityCheck(dut.s).detail,
    warnings: dut.warnings,
  };
}

function quarterWaveTraces(feed: number): Rect[] {
  return [
    [-SECTION_MM / 2 - feed, -W50_MM / 2, -SECTION_MM / 2, W50_MM / 2],
    [-SECTION_MM / 2, -W22_MM / 2, SECTION_MM / 2, W22_MM / 2],
    [SECTION_MM / 2, -W22_MM / 2, SECTION_MM / 2 + feed, W22_MM / 2],
  ];
}

/** Input reflection of the two-port with port 2 terminated in z_load (50 ohm reference). */
function gammaIn(s: ScatteringResult, m: number, zLoad: number): Complex {
  const gl = (zLoad - 50) / (zLoad + 50);
  const [s11, s12, s21, s22] = [at(s, 0, 0, m), at(s, 0, 1, m), at(s, 1, 0, m), at(s, 1, 1, m)];
  const mul = (a: Complex, b: Complex): Complex => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const num = mul(mul(s12, s21), [gl, 0]);
  const den: Complex = [1 - s22[0] * gl, -s22[1] * gl];
  const q = den[0] ** 2 + den[1] ** 2;
  return [s11[0] + (num[0] * den[0] + num[1] * den[1]) / q, s11[1] + (num[1] * den[0] - num[0] * den[1]) / q];
}

/** The contiguous band around `around` where value <= limit, edges interpolated (scripts/textbook_exam/network.py band_below). */
function bandBelow(f: Float64Array, value: number[], limit: number, around: number): [number, number] | null {
  let k = 0;
  for (let m = 1; m < f.length; m++) if (Math.abs(f[m] - around) < Math.abs(f[k] - around)) k = m;
  if (value[k] > limit) return null;
  let lo = k;
  while (lo > 0 && value[lo - 1] <= limit) lo--;
  let hi = k;
  while (hi < f.length - 1 && value[hi + 1] <= limit) hi++;
  const cross = (i: number, j: number) => f[i] + ((limit - value[i]) * (f[j] - f[i])) / (value[j] - value[i]);
  return [lo > 0 ? cross(lo - 1, lo) : f[0], hi < f.length - 1 ? cross(hi, hi + 1) : f[f.length - 1]];
}

async function casePlanes() {
  const short = await solveAndDeembed(microstrip('deembed-planes-10mm', RO4003C, quarterWaveTraces(10), 10, RO_BAND, RO_MESH));
  const long = await solveAndDeembed(microstrip('deembed-planes-16mm', RO4003C, quarterWaveTraces(16), 16, RO_BAND, RO_MESH));
  const planes = {
    description: "Pozar Ex. 5.5's 22.36 ohm quarter-wave section between 50 ohm (port 1) and 22.36 ohm (port 2) feeds of 10 mm and of 16 mm, each de-embedded to the section's ends",
    kits: { feeds_10mm: short.ports.map(lineReport), feeds_16mm: long.ports.map(lineReport) },
    max_abs_difference: { raw: largestDifference(short.raw, long.raw), deembedded: largestDifference(short.s, long.s) },
    warnings: { feeds_10mm: short.warnings, feeds_16mm: long.warnings },
  };
  // Pozar Ex. 5.5, graded as the textbook exam grades it: the |Gamma| <= 0.4 band (and the book's SWR 1.5, |Gamma| <= 0.2).
  const mag = Array.from(short.s.fGHz, (_, m) => Math.hypot(...gammaIn(short.s, m, 10)));
  const bandAt = (limit: number) => {
    const band = bandBelow(short.s.fGHz, mag, limit, 3);
    return band && { gamma_max: limit, band_ghz: band.map((x) => round(x)), centre_ghz: round((band[0] + band[1]) / 2) };
  };
  const grades = JSON.parse(readFileSync(new URL('../../docs/textbook-exam/results/grades.json', import.meta.url), 'utf8')) as Record<string, Array<{ quantity: string; nobu: number; book: number }>>;
  const exam = grades['quarter-wave'];
  const quarterWave = {
    description: 'Pozar Ex. 5.5, the 10 mm structure terminated in 10 ohm at the section end: the matched band',
    bands: [bandAt(0.4), bandAt(0.2)],
    book: { centre_ghz: 3 },
    textbook_exam_external_calibration: exam.map((g) => ({ quantity: g.quantity, nobu: g.nobu, book: g.book })),
  };
  return { planes, quarterWave };
}

async function caseAlumina() {
  const sub = { epsR: 9.9, hMm: 0.5 };
  const w = 0.5;
  const feed = 10;
  const lineMm = 20;
  const dut = await solveAndDeembed(microstrip('deembed-alumina', sub, [[-lineMm / 2 - feed, -w / 2, lineMm / 2 + feed, w / 2]], feed, [6, 14, 161], { cell: 0.5, edge: 0.05, dielectricCells: 6 }));
  const p = dut.ports[0];
  const m10 = dut.s.fGHz.findIndex((f) => Math.abs(f - 10) < 1e-6);
  return {
    description: 'Pozar Ex. 3.7 line (W/h = 1, 0.5 mm alumina eps_r 9.9, lossless), 20 mm between 10 mm feeds',
    kit: dut.ports.map(lineReport),
    eps_eff_10ghz: { nobu: p.epsEff[m10] === null ? null : round(p.epsEff[m10]!), openems_msl_port: 6.88, kirschning_jansen: 6.88 },
    z_line_static_ohm: { nobu: round(p.zLineOhm), hammerstad_jensen: 49.05 },
    max_abs_s11: { raw: largestS11(dut.raw), deembedded: largestS11(dut.s) },
    warnings: dut.warnings,
  };
}

const OUT = new URL('../../docs/validation/data/deembed.json', import.meta.url);

/** Adds one case's results to the data file, re-read just before writing, so cases can run separately. */
function record(entries: Record<string, unknown>) {
  let out: Record<string, unknown> = {};
  try {
    out = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch {
    // First case: no file yet.
  }
  out = { generated_by: 'scripts/validate/deembed.ts', solver: useGpu ? 'GPU (WGSL)' : 'CPU reference', ...out, ...entries };
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  for (const value of Object.values(entries)) console.log(JSON.stringify(value));
}

const CASES: Record<string, () => Promise<void>> = {
  line: async () => record({ line: await caseLine() }),
  planes: async () => {
    const { planes, quarterWave } = await casePlanes();
    record({ planes, quarter_wave: quarterWave });
  },
  alumina: async () => record({ alumina: await caseAlumina() }),
};

async function main() {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const name of asked.length ? asked : Object.keys(CASES)) {
    if (!CASES[name]) throw new Error(`unknown case "${name}" (cases: ${Object.keys(CASES).join(', ')})`);
    await CASES[name]();
  }
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
