/**
 * Published benchmarks: run the project files in examples/benchmarks/ through
 * the same solve path as `noburf solve` (solveProjectText in scripts/noburf.ts,
 * CPU reference) and compare with published or closed-form numbers.
 *
 *   npx tsx scripts/validate/benchmarks.ts [--plan] [--only <benchmark>[,<benchmark>]] [--max-minutes 20]
 *                                          [--mesh uniform|graded] [--refine <k>]
 *
 *   --plan          print each solve's grid and projected run time, solve nothing
 *   --only          run only the named benchmarks (results of the others are kept
 *                   from the existing docs/validation/data/benchmarks.json)
 *   --max-minutes   skip any single solve whose worst-case projection (cells x
 *                   max_steps at the measured CPU rate) exceeds this; default 20
 *   --mesh          uniform (default): examples/benchmarks/<name>.json, the
 *                   published geometry on a cubic grid. graded: the same
 *                   geometry from examples/benchmarks/graded/<name>.json, with
 *                   mesh lines on every copper edge. Benchmarks without a
 *                   graded file are skipped.
 *   --refine        graded only: divide edge_cell by k and multiply
 *                   dielectric_cells and max_steps by k (default 1). The
 *                   largest cell, max_growth and air margins stay, so the
 *                   smallest cell shrinks by a little less than k (1.9 for
 *                   k = 2 on these files). k = 1 vs 2 shows the sensitivity
 *                   to edge resolution, not a full convergence study.
 *
 * Results go to docs/validation/data/benchmarks.json (uniform) or
 * benchmarks-graded-r<k>.json.
 *
 * Solves run one at a time. The reference numbers, their sources and the
 * cases NobuRF cannot express yet are listed in examples/benchmarks/README.md.
 * Nothing here is tuned to the references: geometry is the published geometry
 * on a uniform cubic grid, and every difference is reported as it comes out.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseProject } from '../../src/project/schema';
import { rasterise } from '../../src/project/rasterise';
import type { Spectrum, ScatteringResult } from '../../src/engine/port_dft';
import { solveProjectText } from '../noburf';
import { hammerstadJensenStatic, kirschningJansenEpsEff } from './closed_forms';

const BENCHMARK_DIR = new URL('../../examples/benchmarks/', import.meta.url);
const DATA_DIR = new URL('../../docs/validation/data/', import.meta.url);
const SPEED_OF_LIGHT_M_PER_S = 299_792_458;

/**
 * CPU reference throughput used for the run-time projection, in cell-updates
 * per second (one cell = all six field components). Measured on the 4-core
 * validation machine (single-threaded solver) with balanis-ex14-edge-probe:
 * 441k cells x 2100 steps in 52 s. A projection, not a promise.
 */
const CPU_CELL_STEPS_PER_SECOND = 1.8e7;

/* ------------------------------------------------------------------------ */
/* Closed-form references                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Real part of Z0 for a quasi-TEM line whose substrate has loss tangent
 * tanDelta: C becomes complex through the filling-factor loss tangent
 * tan_e = eps_r (eps_eff - 1) tanDelta / (eps_eff (eps_r - 1))
 * (Pozar, Microwave Engineering, 4th ed., eq. 3.198 and section 3.8), L is
 * unchanged, so Z0_lossy = Z0 / sqrt(1 - j tan_e).
 */
export function lossyLineRealZ0(z0Ohm: number, epsR: number, epsEff: number, tanDelta: number): number {
  const tanEffective = (epsR * (epsEff - 1) * tanDelta) / (epsEff * (epsR - 1));
  // 1 / sqrt(1 - j t): modulus (1 + t^2)^(-1/4), phase +atan(t)/2.
  return z0Ohm * (1 + tanEffective ** 2) ** -0.25 * Math.cos(Math.atan(tanEffective) / 2);
}

/* ------------------------------------------------------------------------ */
/* Spectrum readers                                                          */
/* ------------------------------------------------------------------------ */

/** Index of the largest value; the caller decides whether an edge maximum is acceptable. */
function indexOfMaximum(values: ArrayLike<number>): number {
  let best = 0;
  for (let m = 1; m < values.length; m++) if (values[m] > values[best]) best = m;
  return best;
}

/** Frequency and height of the largest interior maximum, refined with a parabola through three points. Fails if the maximum sits on a band edge. */
function refinedPeak(fGHz: Float64Array, values: Float64Array, what: string): { fGHz: number; value: number } {
  const k = indexOfMaximum(values);
  if (k === 0 || k === values.length - 1) {
    throw new Error(`${what}: maximum at the band edge (${fGHz[k]} GHz); the band does not contain the resonance`);
  }
  return parabolaVertex(fGHz, values, k);
}

/** Vertex of the parabola through samples k - 1, k, k + 1 (uniform frequency spacing). */
function parabolaVertex(fGHz: Float64Array, values: ArrayLike<number>, k: number): { fGHz: number; value: number } {
  const [a, b, c] = [values[k - 1], values[k], values[k + 1]];
  const offset = (0.5 * (a - c)) / (a - 2 * b + c);
  return { fGHz: fGHz[k] + offset * (fGHz[1] - fGHz[0]), value: b - 0.25 * (a - c) * offset };
}

/**
 * Lowest-frequency local maximum of Re(Z_in): the fundamental mode. A centre-line
 * probe on a small, electrically thick patch also drives TM20-like modes a few
 * GHz higher whose resistance peak can be the larger one, so the band-wide
 * maximum is not always the fundamental. A sample counts as a maximum when it
 * beats the `halfWidth` samples on each side, which ignores ripple.
 */
function lowestResistancePeak(spec: Spectrum, what: string, halfWidth = 3): { fGHz: number; value: number } {
  const r = spec.zRe;
  for (let k = halfWidth; k < r.length - halfWidth; k++) {
    let isPeak = true;
    for (let d = 1; d <= halfWidth && isPeak; d++) isPeak = r[k] > r[k - d] && r[k] >= r[k + d];
    if (isPeak) return parabolaVertex(spec.fGHz, r, k);
  }
  throw new Error(`${what} Re(Z_in): no interior local maximum in the band`);
}

function realZPeak(spec: Spectrum, what: string) {
  return refinedPeak(spec.fGHz, spec.zRe, `${what} Re(Z_in)`);
}

function s11Minimum(spec: Spectrum, what: string) {
  const negated = Float64Array.from(spec.s11Db, (v) => -v);
  const peak = refinedPeak(spec.fGHz, negated, `${what} S11`);
  return { fGHz: peak.fGHz, valueDb: -peak.value };
}

/** |S_ij| in dB over the band; column j must have been excited. */
function sParameterDb(s: ScatteringResult, i: number, j: number, what: string): Float64Array {
  const re = s.re[i][j], im = s.im[i][j];
  if (!re || !im) throw new Error(`${what}: port ${j + 1} was not excited, so S${i + 1}${j + 1} is unknown`);
  return Float64Array.from(re, (r, m) => 20 * Math.log10(Math.hypot(r, im[m])));
}

/** Deepest minimum of `db` inside [fLowGHz, fHighGHz], refined with a parabola. Fails if it sits on the window edge. */
function minimumIn(fGHz: Float64Array, db: Float64Array, fLowGHz: number, fHighGHz: number, what: string): { fGHz: number; valueDb: number } {
  const inside = Array.from(fGHz.keys()).filter((m) => fGHz[m] >= fLowGHz && fGHz[m] <= fHighGHz);
  const k = inside.reduce((best, m) => (db[m] < db[best] ? m : best), inside[0]);
  if (k === inside[0] || k === inside[inside.length - 1]) throw new Error(`${what}: minimum on the edge of ${fLowGHz}-${fHighGHz} GHz`);
  const vertex = parabolaVertex(fGHz, db, k);
  return { fGHz: vertex.fGHz, valueDb: vertex.value };
}

/**
 * First frequency above fFromGHz where a(f) - b(f) changes sign, linearly
 * interpolated. With `falling`, only a crossing where a drops below b counts.
 */
function firstCrossing(fGHz: Float64Array, a: ArrayLike<number>, b: ArrayLike<number>, fFromGHz: number, what: string, falling = false): number {
  for (let m = 1; m < fGHz.length; m++) {
    if (fGHz[m - 1] < fFromGHz) continue;
    const d0 = a[m - 1] - b[m - 1], d1 = a[m] - b[m];
    if (falling ? !(d0 > 0 && d1 <= 0) : Math.sign(d0) === Math.sign(d1) && d0 !== 0) continue;
    return d0 === 0 ? fGHz[m - 1] : fGHz[m - 1] + (d0 / (d0 - d1)) * (fGHz[m] - fGHz[m - 1]);
  }
  throw new Error(`${what}: no crossing above ${fFromGHz} GHz`);
}

/* ------------------------------------------------------------------------ */
/* Benchmarks                                                                */
/* ------------------------------------------------------------------------ */

interface Comparison {
  quantity: string;
  unit: string;
  reference: number;
  reference_kind: 'measured' | 'simulated' | 'closed-form' | 'textbook model' | 'read from a plot';
  noburf: number;
  /** (noburf - reference) / reference, in percent. */
  difference_percent: number;
  note?: string;
}

interface SolveSummary {
  project: string;
  grid: [number, number, number];
  cells: number;
  dx_mm: number;
  steps: number;
  stopped_on_energy: boolean;
  energy_decay_db: number;
  solve_s: number;
  /** Null when the extreme sits on a band edge (no interior resonance, e.g. the lossy line). */
  f_s11_min_ghz: number | null;
  s11_min_db: number | null;
  f_re_z_peak_ghz: number | null;
  re_z_peak_ohm: number | null;
  warnings: string[];
}

interface Benchmark {
  name: string;
  source: string;
  projects: string[];
  /** `scattering` holds the S-matrix of each multiport project (null for one port). */
  compare: (spectra: Map<string, Spectrum>, scattering: Map<string, ScatteringResult | null>) => Comparison[];
}

function comparison(c: Omit<Comparison, 'difference_percent'>): Comparison {
  return { ...c, difference_percent: (100 * (c.noburf - c.reference)) / c.reference };
}

const BALANIS = 'C. A. Balanis, Antenna Theory, 3rd/4th ed., Examples 14.1 and 14.2 (transmission-line and cavity models)';
const CHANG = 'E. Chang, S. A. Long, W. F. Richards, "An experimental investigation of electrically thick rectangular microstrip antennas," IEEE Trans. AP-34(6), 1986, Table I (measured; f_r is the frequency of maximum input resistance, section III-B)';
const SHEEN = 'D. M. Sheen, S. M. Ali, M. D. Abouzahra, J. A. Kong, IEEE Trans. MTT 38(7), 1990, pp. 849-857, measured and FDTD: line-fed patch (Figs. 3, 5, 6), low-pass filter (Figs. 7, 9, 10), branch-line coupler (Figs. 11, 13)';
const POZAR = 'D. M. Pozar, Microwave Engineering, 4th ed., 2012, Example 3.7 (pp. 149-150), with Hammerstad-Jensen 1980 and Kirschning-Jansen 1982';

/** Pozar Example 3.7 line as drawn: 0.5 mm alumina, strip 0.5 mm (5 cells; the example's 50 ohm width is 0.483 mm). */
const POZAR_LINE = { epsR: 9.9, heightMm: 0.5, widthMm: 0.5, lossyTanDelta: 0.3, lossyLengthMm: 25, resonatorLengthsMm: [5.8, 11.6] };

function chang(name: string, measuredMHz: number): Benchmark {
  return {
    name,
    source: CHANG,
    projects: [name],
    compare: (spectra) => {
      const spec = spectra.get(name)!;
      const peak = lowestResistancePeak(spec, name);
      const dip = s11Minimum(spec, name);
      return [
        comparison({ quantity: 'f_r at the lowest Re(Z_in) peak (the paper\'s definition)', unit: 'GHz', reference: measuredMHz / 1000, reference_kind: 'measured', noburf: peak.fGHz }),
        comparison({ quantity: 'f at the S11 minimum', unit: 'GHz', reference: measuredMHz / 1000, reference_kind: 'measured', noburf: dip.fGHz,
          note: `S11 minimum ${dip.valueDb.toFixed(1)} dB; not the paper's definition of f_r, which is the Re(Z_in) peak` }),
      ];
    },
  };
}

const BENCHMARKS: Benchmark[] = [
  {
    name: 'balanis-ex14-edge-probe',
    source: BALANIS,
    projects: ['balanis-ex14-edge-probe'],
    compare: (spectra) => {
      const peak = realZPeak(spectra.get('balanis-ex14-edge-probe')!, 'balanis edge');
      return [
        comparison({ quantity: 'f0 (Re(Z_in) peak) vs design frequency', unit: 'GHz', reference: 10, reference_kind: 'textbook model', noburf: peak.fGHz }),
        comparison({ quantity: 'R_in at resonance, probe on the first node inside the radiating edge (0.35 mm in)', unit: 'ohm', reference: 228.35, reference_kind: 'textbook model', noburf: peak.value,
          note: 'Balanis R_in(edge) = 1 / (2 (G1 + G12)); the probe sits on the first grid node inside the edge (0.35 mm in), where cos^2 reduces the model value by about 1.5 %' }),
      ];
    },
  },
  {
    name: 'balanis-ex14-inset-probe',
    source: BALANIS,
    projects: ['balanis-ex14-inset-probe'],
    compare: (spectra) => {
      const peak = realZPeak(spectra.get('balanis-ex14-inset-probe')!, 'balanis inset');
      return [
        comparison({ quantity: 'f0 (Re(Z_in) peak) vs design frequency', unit: 'GHz', reference: 10, reference_kind: 'textbook model', noburf: peak.fGHz }),
        comparison({ quantity: 'R_in at resonance, probe at y0 = 3.126 mm', unit: 'ohm', reference: 50, reference_kind: 'textbook model', noburf: peak.value }),
      ];
    },
  },
  // Chang et al. 1986, Table I, every row (the 17 x 11 mm patch on 3.175 mm is listed twice; run once).
  chang('chang1986-57x38', 2310),
  chang('chang1986-45.5x30.5', 2890),
  chang('chang1986-29.5x19.5', 4240),
  chang('chang1986-19.5x13', 5840),
  chang('chang1986-17x11', 6800),
  chang('chang1986-14x9', 7700),
  chang('chang1986-12x8', 8270),
  chang('chang1986-10.5x7', 9140),
  chang('chang1986-9x6', 10250),
  chang('chang1986-17x11-h1.524', 7870),
  chang('chang1986-17x11-h9.525', 4730),
  {
    name: 'sheen1990-patch',
    source: SHEEN,
    projects: ['sheen1990-patch'],
    compare: (spectra) => {
      const dip = s11Minimum(spectra.get('sheen1990-patch')!, 'sheen');
      return [
        comparison({ quantity: 'f at the S11 minimum (first resonance)', unit: 'GHz', reference: 7.5, reference_kind: 'measured', noburf: dip.fGHz,
          note: `NobuRF S11 minimum ${dip.valueDb.toFixed(1)} dB. Sheen's text: the operating resonance at 7.5 GHz is shown by both measurement and FDTD (Fig. 5)` }),
      ];
    },
  },
  {
    name: 'sheen1990-lowpass-filter',
    source: SHEEN,
    projects: ['sheen1990-lowpass-filter'],
    compare: (_spectra, scattering) => {
      const s = scattering.get('sheen1990-lowpass-filter')!;
      const s11 = sParameterDb(s, 0, 0, 'sheen filter');
      const s21 = sParameterDb(s, 1, 0, 'sheen filter');
      const level = (db: number) => new Float64Array(s21.length).fill(db);
      const minus3 = firstCrossing(s.fGHz, s21, level(-3), 1, 'sheen filter S21 = -3 dB', true);
      const minus10 = firstCrossing(s.fGHz, s21, level(-10), 1, 'sheen filter S21 = -10 dB', true);
      const fig10 = 'Measured curve of Fig. 10 read at this level by pixel position on a 400 dpi scan; reading uncertainty about 0.05 GHz';
      const dip1 = minimumIn(s.fGHz, s11, 3.5, 6.5, 'sheen filter first S11 dip');
      const dip2 = minimumIn(s.fGHz, s11, 9, 12.5, 'sheen filter second S11 dip');
      return [
        comparison({ quantity: 'S21 falls through -3 dB', unit: 'GHz', reference: 5.45, reference_kind: 'read from a plot', noburf: minus3, note: fig10 }),
        comparison({ quantity: 'S21 falls through -10 dB', unit: 'GHz', reference: 5.98, reference_kind: 'read from a plot', noburf: minus10, note: fig10 }),
        comparison({ quantity: 'first S11 dip', unit: 'GHz', reference: 5.0, reference_kind: 'read from a plot', noburf: dip1.fGHz,
          note: `NobuRF ${dip1.valueDb.toFixed(1)} dB. Measured dip read off Fig. 9 to about 0.1 GHz` }),
        comparison({ quantity: 'second S11 dip', unit: 'GHz', reference: 10.8, reference_kind: 'read from a plot', noburf: dip2.fGHz,
          note: `NobuRF ${dip2.valueDb.toFixed(1)} dB. Measured dip read off Fig. 9 to about 0.1 GHz` }),
      ];
    },
  },
  {
    name: 'sheen1990-branch-line-coupler',
    source: SHEEN,
    projects: ['sheen1990-branch-line-coupler'],
    compare: (_spectra, scattering) => {
      const s = scattering.get('sheen1990-branch-line-coupler')!;
      const s11 = sParameterDb(s, 0, 0, 'sheen coupler');
      const s31 = sParameterDb(s, 2, 0, 'sheen coupler');
      const s41 = sParameterDb(s, 3, 0, 'sheen coupler');
      const crossover = firstCrossing(s.fGHz, s31, s41, 4.5, 'sheen coupler S31 = S41');
      const at = (db: Float64Array) => { const m = Array.from(s.fGHz).findIndex((f) => f >= crossover); return db[m]; };
      const s21 = sParameterDb(s, 1, 0, 'sheen coupler');
      const match = minimumIn(s.fGHz, s11, 5, 8, 'sheen coupler S11 null');
      const isolation = minimumIn(s.fGHz, s21, 5, 8, 'sheen coupler S21 null');
      return [
        comparison({ quantity: 'operating point: S31 = S41 crossover', unit: 'GHz', reference: 6.5, reference_kind: 'measured', noburf: crossover,
          note: `Sheen gives the operating point as about 6.5 GHz in both calculation and measurement (text). NobuRF |S31| = ${at(s31).toFixed(2)} dB and |S41| = ${at(s41).toFixed(2)} dB there; ideal -3.01 dB` }),
        comparison({ quantity: 'S11 null', unit: 'GHz', reference: 6.5, reference_kind: 'measured', noburf: match.fGHz,
          note: `NobuRF ${match.valueDb.toFixed(1)} dB. Sheen: the S11 and S21 nulls sit at the operating point (text). The lumped ports are not de-embedded, so their own reflection adds to S11 and can move a deep null` }),
        comparison({ quantity: 'S21 (isolation) null', unit: 'GHz', reference: 6.5, reference_kind: 'measured', noburf: isolation.fGHz,
          note: `NobuRF ${isolation.valueDb.toFixed(1)} dB. Port 2 is the isolated port: it sits across the narrow branch from port 1` }),
      ];
    },
  },
  {
    name: 'pozar-ex3.7-z0',
    source: POZAR,
    projects: ['pozar-ex3.7-z0-lossy-line'],
    compare: (spectra) => {
      const spec = spectra.get('pozar-ex3.7-z0-lossy-line')!;
      const { epsR, heightMm, widthMm, lossyTanDelta } = POZAR_LINE;
      const u = widthMm / heightMm;
      const hj = hammerstadJensenStatic(u, epsR);
      // Average over 8-12 GHz: the residual far-end echo is a ripple in frequency, and averaging over several periods removes most of it.
      let simulated = 0, closedForm = 0, count = 0;
      for (let m = 0; m < spec.fGHz.length; m++) {
        const f = spec.fGHz[m];
        if (f < 8 || f > 12) continue;
        const epsEff = kirschningJansenEpsEff(u, epsR, hj.epsEff, f, heightMm);
        // Constant conductivity: tan delta falls as 1/f from its value at the 10 GHz reference.
        simulated += spec.zRe[m];
        closedForm += lossyLineRealZ0(hj.z0AirOhm / Math.sqrt(epsEff), epsR, epsEff, (lossyTanDelta * 10) / f);
        count++;
      }
      return [
        comparison({ quantity: 'Re(Z0), mean over 8-12 GHz, lossy line (tan d 0.3 at 10 GHz)', unit: 'ohm', reference: closedForm / count, reference_kind: 'closed-form', noburf: simulated / count,
          note: `Hammerstad-Jensen at W/h = ${u}, dispersion by Kirschning-Jansen, loss by Pozar eq. 3.198. Lossless H-J Z0 at this width: ${hj.z0Ohm.toFixed(2)} ohm (Pozar's 50 ohm width is 0.483 mm)` }),
      ];
    },
  },
  {
    name: 'pozar-ex3.7-eeff',
    source: POZAR,
    projects: ['pozar-ex3.7-eeff-line-a', 'pozar-ex3.7-eeff-line-b'],
    compare: (spectra) => {
      const { epsR, heightMm, widthMm, resonatorLengthsMm: [lengthA, lengthB] } = POZAR_LINE;
      // Half-wave (n = 1) peak of the short line, full-wave (n = 2) peak of the long one:
      // L + dL = n c / (2 f sqrt(eps_eff)) with the same end correction dL at both ends.
      const fA = realZPeak(spectra.get('pozar-ex3.7-eeff-line-a')!, 'line a').fGHz;
      const fB = realZPeak(spectra.get('pozar-ex3.7-eeff-line-b')!, 'line b').fGHz;
      const sqrtEpsEff = (SPEED_OF_LIGHT_M_PER_S * (2 / (fB * 1e9) - 1 / (fA * 1e9))) / (2 * (lengthB - lengthA) * 1e-3);
      const u = widthMm / heightMm;
      const hj = hammerstadJensenStatic(u, epsR);
      const fMean = (fA + fB) / 2;
      const closedForm = kirschningJansenEpsEff(u, epsR, hj.epsEff, fMean, heightMm);
      return [
        comparison({ quantity: `eps_eff at ${fMean.toFixed(2)} GHz, two-resonator method`, unit: '', reference: closedForm, reference_kind: 'closed-form', noburf: sqrtEpsEff ** 2,
          note: `Resonances ${fA.toFixed(3)} GHz (n = 1, ${lengthA} mm) and ${fB.toFixed(3)} GHz (n = 2, ${lengthB} mm). Static H-J eps_eff at W/h = ${u}: ${hj.epsEff.toFixed(3)}; Pozar's quasi-static value at W = 0.483 mm: 6.665` }),
      ];
    },
  },
];

/** Cases recorded in the README that are not built yet, with what each still needs. Kept in the JSON so they show up as open. */
const NOT_BUILT = [
  { name: 'half-wave-dipole', source: 'Balanis, Antenna Theory, eq. 4-93: Z_in = 73 + j42.5 ohm for an infinitely thin lambda/2 dipole', needs: 'a thin-wire or horizontal gap port in free space (ports are vertical columns between copper layers)' },
  { name: 'quarter-wave-transformer', source: 'Pozar, Microwave Engineering, 4th ed., section 2.5', needs: 'a two-port project file' },
  { name: 'microstrip-conductor-loss', source: POZAR, needs: 'a project file with copper strips (the copper material exists)' },
];

/* ------------------------------------------------------------------------ */
/* Runner                                                                    */
/* ------------------------------------------------------------------------ */

function parseArguments(argv: string[]) {
  let planOnly = false;
  let only: string[] | null = null;
  let maxMinutes = 20;
  let mesh: MeshVariant = 'uniform';
  let refine = 1;
  for (let n = 0; n < argv.length; n++) {
    if (argv[n] === '--plan') planOnly = true;
    else if (argv[n] === '--mesh' && (argv[n + 1] === 'uniform' || argv[n + 1] === 'graded')) mesh = argv[++n] as MeshVariant;
    else if (argv[n] === '--refine' && argv[n + 1]) refine = Number(argv[++n]);
    else if (argv[n] === '--only' && argv[n + 1]) only = argv[++n].split(',');
    else if (argv[n] === '--max-minutes' && argv[n + 1]) maxMinutes = Number(argv[++n]);
    else throw new Error('usage: benchmarks.ts [--plan] [--only <name>[,<name>]] [--max-minutes <minutes>] [--mesh uniform|graded] [--refine <k>]');
  }
  if (!Number.isInteger(refine) || refine < 1) throw new Error(`--refine must be a positive integer, got ${refine}`);
  if (refine !== 1 && mesh !== 'graded') throw new Error('--refine applies to --mesh graded only');
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0) throw new Error(`--max-minutes must be a positive number, got ${maxMinutes}`);
  for (const name of only ?? []) {
    if (!BENCHMARKS.some((b) => b.name === name)) throw new Error(`unknown benchmark "${name}" (known: ${BENCHMARKS.map((b) => b.name).join(', ')})`);
  }
  return { planOnly, only, maxMinutes, mesh, refine };
}

type MeshVariant = 'uniform' | 'graded';
let meshVariant: MeshVariant = 'uniform';
let refineFactor = 1;

function projectFile(projectName: string): URL {
  return new URL(`${meshVariant === 'graded' ? 'graded/' : ''}${projectName}.json`, BENCHMARK_DIR);
}

/** The project as solved: for --refine k, edge cells k times smaller, k times the cells across each dielectric and k times the step cap. */
function projectText(projectName: string): string {
  const text = readFileSync(projectFile(projectName), 'utf8');
  if (refineFactor === 1) return text;
  const project = JSON.parse(text);
  const graded = project.mesh.graded;
  const edge = /^([0-9.]+) mm$/.exec(graded.edge_cell);
  if (!edge) throw new Error(`${projectName}: --refine needs mesh.graded.edge_cell as "<number> mm", got ${graded.edge_cell}`);
  graded.edge_cell = `${Number(edge[1]) / refineFactor} mm`;
  graded.dielectric_cells *= refineFactor;
  project.analysis.stop.max_steps *= refineFactor;
  project.name += `-r${refineFactor}`;
  return JSON.stringify(project);
}

/** Grid size and worst-case run time (every allowed step) without solving. */
function projection(projectName: string) {
  const project = parseProject(JSON.parse(projectText(projectName)));
  const { model } = rasterise(project);
  const { nx, ny, nz } = model.grid;
  const cells = nx * ny * nz;
  const maxSteps = project.analysis.stop.max_steps;
  return { grid: [nx, ny, nz] as [number, number, number], cells, maxSteps, worstCaseMinutes: (cells * maxSteps) / CPU_CELL_STEPS_PER_SECOND / 60 };
}

async function solveOne(projectName: string): Promise<{ spec: Spectrum; scattering: ScatteringResult | null; summary: SolveSummary }> {
  const solve = await solveProjectText(projectText(projectName), `${projectName}.json`, false);
  const { nx, ny, nz } = solve.model.grid;
  const orNull = <T,>(read: () => T): T | null => {
    try {
      return read();
    } catch {
      return null; // an edge extreme: recorded as null, and the comparisons that need it fail loudly in compare()
    }
  };
  const dip = orNull(() => s11Minimum(solve.spec, projectName));
  const peak = orNull(() => realZPeak(solve.spec, projectName));
  const summary: SolveSummary = {
    project: projectName,
    grid: [nx, ny, nz],
    cells: nx * ny * nz,
    dx_mm: solve.model.grid.dxMm,
    steps: solve.steps,
    stopped_on_energy: solve.stoppedOnEnergy,
    energy_decay_db: solve.energyDecayDb,
    solve_s: Math.round(solve.solveMs / 1000),
    f_s11_min_ghz: dip?.fGHz ?? null,
    s11_min_db: dip?.valueDb ?? null,
    f_re_z_peak_ghz: peak?.fGHz ?? null,
    re_z_peak_ohm: peak?.value ?? null,
    warnings: solve.warnings,
  };
  const dipText = dip ? `S11 min ${dip.valueDb.toFixed(2)} dB at ${dip.fGHz.toFixed(3)} GHz` : 'S11 min on a band edge';
  const peakText = peak ? `Re(Z) peak ${peak.value.toFixed(1)} ohm at ${peak.fGHz.toFixed(3)} GHz` : 'Re(Z) peak on a band edge';
  console.log(`  ${projectName}: ${dipText}, ${peakText}, ` +
    `${summary.steps} steps, ${summary.solve_s} s`);
  for (const w of solve.warnings) console.log(`    warning: ${w}`);
  return { spec: solve.spec, scattering: solve.scattering, summary };
}

type BenchmarkResult =
  | { name: string; source: string; status: 'run'; solves: SolveSummary[]; comparisons: Comparison[] }
  | { name: string; source: string; status: 'not run'; reason: string; projections: ReturnType<typeof projection>[] };

async function main(): Promise<void> {
  const { planOnly, only, maxMinutes, mesh, refine } = parseArguments(process.argv.slice(2));
  meshVariant = mesh;
  refineFactor = refine;
  const OUTPUT_FILE = new URL(mesh === 'uniform' ? 'benchmarks.json' : `benchmarks-graded-r${refine}.json`, DATA_DIR);
  const previous: BenchmarkResult[] = existsSync(OUTPUT_FILE) ? JSON.parse(readFileSync(OUTPUT_FILE, 'utf8')).benchmarks : [];
  const results: BenchmarkResult[] = [];

  for (const benchmark of BENCHMARKS) {
    if (only && !only.includes(benchmark.name)) {
      const kept = previous.find((r) => r.name === benchmark.name);
      if (kept) results.push(kept);
      continue;
    }
    if (!benchmark.projects.every((name) => existsSync(projectFile(name)))) {
      if (only) throw new Error(`${benchmark.name} has no ${meshVariant} project file under examples/benchmarks/`);
      console.log(`${benchmark.name}: no ${meshVariant} project file, skipped`);
      continue;
    }
    const projections = benchmark.projects.map(projection);
    console.log(`${benchmark.name}`);
    for (const [n, p] of projections.entries()) {
      console.log(`  ${benchmark.projects[n]}: ${p.grid.join('x')} = ${(p.cells / 1e6).toFixed(2)} M cells, <= ${p.maxSteps} steps, worst case ${p.worstCaseMinutes.toFixed(1)} min`);
    }
    if (planOnly) continue;
    const tooLong = projections.filter((p) => p.worstCaseMinutes > maxMinutes);
    if (tooLong.length > 0) {
      const reason = `worst-case projection ${Math.max(...tooLong.map((p) => p.worstCaseMinutes)).toFixed(0)} min for one solve exceeds the ${maxMinutes} min limit`;
      console.log(`  not run: ${reason}`);
      results.push({ name: benchmark.name, source: benchmark.source, status: 'not run', reason, projections });
      continue;
    }
    const spectra = new Map<string, Spectrum>();
    const scattering = new Map<string, ScatteringResult | null>();
    const solves: SolveSummary[] = [];
    for (const projectName of benchmark.projects) {
      const solved = await solveOne(projectName);
      spectra.set(projectName, solved.spec);
      scattering.set(projectName, solved.scattering);
      solves.push(solved.summary);
    }
    const comparisons = benchmark.compare(spectra, scattering);
    for (const c of comparisons) {
      console.log(`  ${c.quantity}: NobuRF ${c.noburf.toFixed(4)} vs ${c.reference_kind} ${c.reference.toFixed(4)} ${c.unit} (${c.difference_percent >= 0 ? '+' : ''}${c.difference_percent.toFixed(2)} %)`);
    }
    results.push({ name: benchmark.name, source: benchmark.source, status: 'run', solves, comparisons });
  }
  if (planOnly) return;

  writeFileSync(OUTPUT_FILE, JSON.stringify({
    generated_by: 'scripts/validate/benchmarks.ts',
    solver: 'CPU reference via solveProjectText (the noburf solve path)',
    max_minutes_per_solve: maxMinutes,
    mesh,
    refine,
    benchmarks: results,
    not_built: NOT_BUILT,
  }, null, 2) + '\n');
  console.log(`wrote ${OUTPUT_FILE.pathname}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
