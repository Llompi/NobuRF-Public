/**
 * Solve one open-helix element (open_helix_model.ts) and report what the
 * Gonzaga AP-S 2019 paper reports: S11, the circular-polarisation gains in the
 * azimuth plane, axial ratio, azimuth ripple and elevation beamwidth.
 * docs/benchmarks/gonzaga.md has the method and the results.
 *
 *   npx tsx scripts/validate/gonzaga_helix.ts --radius 23.6 --pitch 10.5 --out out/helix.json
 *
 * Every geometry and mesh option has a default (--help lists them).
 * CPU only: CpuFdtd, one core per process; run sweeps as parallel processes.
 */
import { writeFileSync } from 'node:fs';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { timestepSec } from '../../src/engine/config';
import { assertBoxEnclosesSources, HuygensDftRecorder, huygensBoxInsidePml, huygensSurface } from '../../src/engine/huygens_box';
import { largestCell } from '../../src/engine/mesh';
import { nearToFarField, type FarFieldResult } from '../../src/engine/near_to_far';
import { portSpectrum } from '../../src/engine/port_dft';
import type { ExcitationConfig, RunControl } from '../../src/engine/types';
import { buildOpenHelix, circularComponents, type OpenHelixGeometry, type OpenHelixMeshOptions } from './open_helix_model';

const DEFAULTS = {
  // Paper, Table I optimum.
  pitch: 10.5,
  'arm-width': 14.6,
  'disk-width': 4.0,
  // Reconstructed (not in the paper): see docs/benchmarks/gonzaga.md.
  radius: 23.6,
  wrap: 170,
  'disk-thickness': 1.6,
  'disk-eps': 4.4,
  'disk-tand': 0.02,
  copper: 1, // 1: copper sheets, 0: PEC
  // Mesh and run.
  cell: 1.0,
  coarse: 4.0,
  padding: 100,
  pml: 10,
  growth: 1.2,
  'f-min': 0.7,
  'f-max': 1.1,
  'n-freq': 401,
  decay: 40,
  'max-steps': 60_000,
  sheet: 0, // 1: arms as thin conformal sheets (conformal_sheets.ts) instead of staircased faces; needs --copper 0 and --courant 0.3333
  courant: 0, // 0: the default Courant number
  pattern: 0, // 1: also write the full theta/phi pattern (gain and RHCP/LHCP gain, dBi) per far-field frequency
};
type Option = keyof typeof DEFAULTS;

function parseArgs(argv: string[]): { options: Record<Option, number>; out: string | null; farGhz: number[] } {
  const options = { ...DEFAULTS };
  let out: string | null = null;
  let farGhz = [0.88, 0.9, 0.915, 0.93, 0.95];
  for (let n = 0; n < argv.length; n += 2) {
    const key = argv[n].replace(/^--/, '');
    const value = argv[n + 1];
    if (key === 'help') {
      console.log(`options (defaults): ${Object.entries(DEFAULTS).map(([k, v]) => `--${k} ${v}`).join(' ')} --far 0.88,0.9,... --out file.json`);
      process.exit(0);
    }
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (key === 'out') out = value;
    else if (key === 'far') farGhz = value.split(',').map(Number);
    else if (key in DEFAULTS) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`--${key}: ${value} is not a number`);
      options[key as Option] = parsed;
    } else throw new Error(`unknown option --${key}`);
  }
  return { options, out, farGhz };
}

const round = (v: number, digits = 4) => Number(v.toFixed(digits));

/** Pattern index of the sample nearest (theta, phi). */
function sampleIndex(r: FarFieldResult, thetaDeg: number, phiDeg: number): number {
  const ti = r.thetaDeg.findIndex((t) => Math.abs(t - thetaDeg) < 1e-6);
  const pi = r.phiDeg.findIndex((p) => Math.abs(p - phiDeg) < 1e-6);
  if (ti < 0 || pi < 0) throw new Error(`no pattern sample at theta ${thetaDeg}, phi ${phiDeg}`);
  return ti * r.phiDeg.length + pi;
}

/**
 * Circular-polarisation figures of one frequency. Partial gain of a hand =
 * gain x its share of |E|^2. The azimuth plane is theta = 90.
 */
function circularFigures(r: FarFieldResult) {
  const gainLinear = (n: number) => 10 ** (r.directivityDbi[n] / 10) * r.efficiency;
  const at = (n: number) => {
    const c = circularComponents([r.rEThetaRe[n], r.rEThetaIm[n]], [r.rEPhiRe[n], r.rEPhiIm[n]]);
    const total = c.right ** 2 + c.left ** 2;
    const g = gainLinear(n);
    return { rhcpDbi: 10 * Math.log10((g * c.right ** 2) / total), lhcpDbi: 10 * Math.log10((g * c.left ** 2) / total), axialRatioDb: c.axialRatioDb };
  };
  const azimuth = Array.from(r.phiDeg, (phi) => ({ phi, ...at(sampleIndex(r, 90, phi)) }));
  const rhcp = azimuth.map((s) => s.rhcpDbi);
  const lhcp = azimuth.map((s) => s.lhcpDbi);
  const ars = azimuth.map((s) => s.axialRatioDb);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const dominant = mean(rhcp) >= mean(lhcp) ? 'RHCP' : 'LHCP';
  const co = dominant === 'RHCP' ? rhcp : lhcp;
  const cross = dominant === 'RHCP' ? lhcp : rhcp;
  // Elevation cut at phi = 0 (and 180 for the far side): co-polar gain against elevation angle 90 - theta.
  const cut = Array.from(r.thetaDeg, (theta) => {
    const s = at(sampleIndex(r, theta, 0));
    return { elevationDeg: 90 - theta, co: dominant === 'RHCP' ? s.rhcpDbi : s.lhcpDbi };
  });
  const horizon = cut.find((s) => s.elevationDeg === 0)!.co;
  const crossing = (sign: 1 | -1) => {
    const side = cut.filter((s) => sign * s.elevationDeg >= 0).sort((a, b) => sign * (a.elevationDeg - b.elevationDeg));
    for (let n = 1; n < side.length; n++) {
      if (side[n].co <= horizon - 3) {
        const [a, b] = [side[n - 1], side[n]];
        return a.elevationDeg + ((horizon - 3 - a.co) / (b.co - a.co)) * (b.elevationDeg - a.elevationDeg);
      }
    }
    return null;
  };
  const up = crossing(1);
  const down = crossing(-1);
  return {
    sense: dominant,
    azimuth_co_gain_dbi: { mean: round(10 * Math.log10(mean(co.map((g) => 10 ** (g / 10))))), min: round(Math.min(...co)), max: round(Math.max(...co)) },
    azimuth_ripple_db: round(Math.max(...co) - Math.min(...co)),
    azimuth_cross_gain_dbi_max: round(Math.max(...cross)),
    azimuth_cross_polar_rejection_db_min: round(Math.min(...co.map((g, n) => g - cross[n]))),
    azimuth_axial_ratio_db: { mean: round(mean(ars)), max: round(Math.max(...ars)), min: round(Math.min(...ars)) },
    elevation_half_power_deg: { up: up === null ? null : round(up, 2), down: down === null ? null : round(down, 2) },
    azimuth: azimuth.map((s) => [s.phi, round(s.rhcpDbi, 3), round(s.lhcpDbi, 3), round(s.axialRatioDb, 3)]),
  };
}

/** Every sample of the pattern: total, right- and left-hand gain in dBi, rows per theta. */
function fullPattern(r: FarFieldResult) {
  const phiCount = r.phiDeg.length;
  const rows = (f: (n: number) => number) => Array.from(r.thetaDeg, (_, t) => Array.from(r.phiDeg, (__, p) => round(f(t * phiCount + p), 3)));
  const hand = (n: number, which: 'right' | 'left') => {
    const c = circularComponents([r.rEThetaRe[n], r.rEThetaIm[n]], [r.rEPhiRe[n], r.rEPhiIm[n]]);
    const total = c.right ** 2 + c.left ** 2;
    return total === 0 ? -100 : r.directivityDbi[n] + 10 * Math.log10(r.efficiency * (c[which] ** 2) / total);
  };
  return {
    theta_deg: Array.from(r.thetaDeg),
    phi_deg: Array.from(r.phiDeg),
    gain_dbi: rows((n) => r.directivityDbi[n] + 10 * Math.log10(r.efficiency)),
    rhcp_gain_dbi: rows((n) => hand(n, 'right')),
    lhcp_gain_dbi: rows((n) => hand(n, 'left')),
  };
}

function main(): void {
  const { options: o, out, farGhz } = parseArgs(process.argv.slice(2));
  const geometry: OpenHelixGeometry = {
    radiusMm: o.radius, pitchDeg: o.pitch, armWidthMm: o['arm-width'], armWrapDeg: o.wrap,
    diskTraceWidthMm: o['disk-width'], diskThicknessMm: o['disk-thickness'], diskEpsR: o['disk-eps'], diskTanDelta: o['disk-tand'],
    copperConductivitySPerM: o.copper ? 5.8e7 : null,
  };
  const meshOptions: OpenHelixMeshOptions = {
    cellMm: o.cell, coarseCellMm: o.coarse, paddingMm: o.padding, pmlCells: o.pml, maxGrowth: o.growth,
    arms: o.sheet ? 'sheet' : 'staircase', ...(o.courant ? { courant: o.courant } : {}),
  };
  const built = buildOpenHelix(geometry, meshOptions);
  const { model } = built;
  const { nx, ny, nz } = model.grid;
  const exc: ExcitationConfig = { fMinGHz: o['f-min'], fMaxGHz: o['f-max'], nFreq: o['n-freq'], z0: 50 };
  const control: RunControl = { maxSteps: o['max-steps'], stopAtEnergyDecayDb: o.decay, energyCheckEverySteps: 200 };
  const box = huygensBoxInsidePml(model);
  assertBoxEnclosesSources(model, box);
  const surface = huygensSurface(model, box);
  const frequenciesHz = farGhz.map((f) => f * 1e9);
  const recorder = new HuygensDftRecorder(surface, frequenciesHz, timestepSec(model.grid));
  console.log(`open helix R ${o.radius} mm, pitch ${o.pitch} deg, arm ${o['arm-width']} mm x ${built.armLengthMm.toFixed(1)} mm, disk trace ${o['disk-width']} mm; ` +
    `height ${built.heightMm.toFixed(1)} mm; ${nx}x${ny}x${nz} = ${(nx * ny * nz / 1e6).toFixed(2)} M cells, ${built.copperFaces} copper faces`);
  const t0 = performance.now();
  const samples = new CpuFdtd(model).run(exc, control, recorder, 0);
  const solveS = (performance.now() - t0) / 1000;
  const spec = portSpectrum(samples, exc);
  let best = 0;
  for (let m = 1; m < spec.s11Db.length; m++) if (spec.s11Db[m] < spec.s11Db[best]) best = m;
  const below10 = Array.from(spec.fGHz).filter((_, m) => spec.s11Db[m] <= -10);
  const far = nearToFarField({ surface, accumulators: recorder.accumulators, frequenciesHz, samples, exc });
  const result = {
    geometry, mesh: meshOptions,
    grid: { nx, ny, nz, cells: nx * ny * nz, smallest_cell_mm: model.grid.dxMm, largest_cell_mm: largestCell(model.mesh) },
    height_mm: round(built.heightMm, 3), arm_length_mm: round(built.armLengthMm, 3),
    steps: samples.v.length, energy_decay_db: round(samples.energyDecayDb, 2), stopped_on_energy: samples.stoppedOnEnergy, solve_s: round(solveS, 1),
    f0_ghz: round(spec.fGHz[best], 5), s11_min_db: round(spec.s11Db[best], 3),
    band_10db_ghz: below10.length ? [round(Math.min(...below10), 5), round(Math.max(...below10), 5)] : null,
    zin_at_f0: [round(spec.zRe[best], 2), round(spec.zIm[best], 2)],
    s11: Array.from(spec.fGHz, (f, m) => [round(f, 5), round(spec.s11Db[m], 3), round(spec.zRe[m], 2), round(spec.zIm[m], 2)]),
    far_field: far.map((r) => ({
      f_ghz: r.frequencyHz / 1e9,
      efficiency: round(r.efficiency),
      sphere_to_box_power_ratio: round(r.sphereIntegralPowerW / r.radiatedPowerW),
      peak_directivity_dbi: round(r.peakDirectivityDbi), peak_gain_dbi: round(r.peakGainDbi), peak_theta_deg: r.peakThetaDeg,
      ...circularFigures(r),
      ...(o.pattern ? { pattern: fullPattern(r) } : {}),
    })),
  };
  const summary = result.far_field.map((f) => `${f.f_ghz} GHz: ${f.sense} ${f.azimuth_co_gain_dbi.mean} dBi (ripple ${f.azimuth_ripple_db} dB), ` +
    `AR ${f.azimuth_axial_ratio_db.mean} dB, eff ${f.efficiency}`).join('\n  ');
  console.log(`f0 ${result.f0_ghz} GHz, S11 ${result.s11_min_db} dB, Zin ${result.zin_at_f0.join(' j')} ohm, -10 dB band ${JSON.stringify(result.band_10db_ghz)}, ` +
    `${result.steps} steps (${result.energy_decay_db} dB) in ${result.solve_s} s\n  ${summary}`);
  if (out) writeFileSync(out, JSON.stringify(result) + '\n');
}

main();
