/**
 * Which dimensions of the Gonzaga open helix (gonzaga_helix.ts) matter most:
 * the sensitivity study of src/design/sensitivity.ts on the helix script,
 * which builds its own model instead of a project file. Each point is one
 * gonzaga_helix.ts process (CPU, one core each), run `--jobs` at a time.
 *
 *   npx tsx scripts/validate/gonzaga_sensitivity.ts [--cell 1.0] [--jobs 4] [--step-pct 2]
 *       [--range pitch:9.5:14] [--variables pitch,radius,arm-width,wrap]
 *       [--out docs/validation/data/gonzaga_sensitivity.json]
 *
 * Ranges: --range name:min:max; without one a variable's range is its value
 * +-10 % and the report says so. Steps are never below one cell of movement
 * of the copper: a cell for radius and arm width; for the angles, the angle
 * that moves the arm's far end by one cell (pitch: cell / arm length, wrap:
 * cell / radius). Smaller steps land inside the staircase and read as 0.
 *
 * Metrics: resonance (deepest S11), its depth, |Z_in| at 915 MHz, and at
 * 915 MHz the mean azimuth axial ratio and co-polar gain.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { metricsFromSpectrum } from '../../src/design/goal';
import {
  analyse, DEFAULT_STEP_FRACTION, planSteps, rankBy, UNSET_RANGE_FRACTION,
  type MetricInfo, type Metrics, type SensitivityVariable,
} from '../../src/design/sensitivity';

const run = promisify(execFile);
const TARGET_GHZ = 0.915;
/** Defaults as in gonzaga_helix.ts (Table I optimum and the reconstructed radius and wrap). */
const VALUES: Record<string, { value: number; unit: string }> = {
  pitch: { value: 10.5, unit: 'deg' },
  radius: { value: 23.6, unit: 'mm' },
  'arm-width': { value: 14.6, unit: 'mm' },
  wrap: { value: 170, unit: 'deg' },
};
const METRICS: MetricInfo[] = [
  { key: 'f0_mhz', label: 'Resonance', unit: 'MHz' },
  { key: 's11_min_db', label: 'Dip depth', unit: 'dB' },
  { key: 'zin_target_ohm', label: '|Z_in| at 915 MHz', unit: 'ohm' },
  { key: 'axial_ratio_db', label: 'Axial ratio at 915 MHz', unit: 'dB' },
  { key: 'gain_dbi', label: 'Azimuth co-polar gain at 915 MHz', unit: 'dB' },
];

function parse(argv: string[]) {
  const o = { cell: 1.0, jobs: Math.min(4, cpus().length), stepPct: 100 * DEFAULT_STEP_FRACTION, out: '', variables: Object.keys(VALUES), ranges: new Map<string, [number, number]>() };
  for (let n = 0; n < argv.length; n += 2) {
    const [key, value] = [argv[n], argv[n + 1]];
    if (value === undefined) throw new Error(`${key} needs a value`);
    if (key === '--cell') o.cell = Number(value);
    else if (key === '--jobs') o.jobs = Number(value);
    else if (key === '--step-pct') o.stepPct = Number(value);
    else if (key === '--out') o.out = value;
    else if (key === '--variables') o.variables = value.split(',');
    else if (key === '--range') {
      const [name, lo, hi] = value.split(':');
      o.ranges.set(name, [Number(lo), Number(hi)]);
    } else throw new Error(`unknown option ${key}`);
  }
  for (const v of o.variables) if (!VALUES[v]) throw new Error(`no variable ${v}; variables: ${Object.keys(VALUES).join(', ')}`);
  return o;
}

interface HelixResult {
  f0_ghz: number;
  s11_min_db: number;
  arm_length_mm: number;
  grid: { cells: number };
  solve_s: number;
  s11: Array<[number, number, number, number]>;
  far_field: Array<{ f_ghz: number; azimuth_axial_ratio_db: { mean: number }; azimuth_co_gain_dbi: { mean: number } }>;
}

/** The metrics from the S11 table, as the design session takes them (dip between samples), not the script's grid minimum. */
function metricsOf(r: HelixResult): Metrics {
  const spectrum = { fGHz: r.s11.map((row) => row[0]), s11Db: r.s11.map((row) => row[1]), zRe: r.s11.map((row) => row[2]), zIm: r.s11.map((row) => row[3]) };
  const m = metricsFromSpectrum(spectrum, { target_ghz: TARGET_GHZ, s11_max_db: -10, f_tolerance_pct: 1 });
  const ff = r.far_field.find((x) => Math.abs(x.f_ghz - TARGET_GHZ) < 1e-9);
  return {
    f0_mhz: 1000 * m.f0_ghz,
    s11_min_db: m.s11_min_db,
    zin_target_ohm: m.zin_target_ohm ?? null,
    axial_ratio_db: ff?.azimuth_axial_ratio_db.mean ?? null,
    gain_dbi: ff?.azimuth_co_gain_dbi.mean ?? null,
  };
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  // One JSON per solved point, reused by a rerun of the same code: the folder is keyed by the helix scripts and the engine.
  const dir = join(tmpdir(), `noburf-gonzaga-sensitivity-${codeHash()}`);
  const cached: string[] = [];
  mkdirSync(dir, { recursive: true });
  const cache = new Map<string, Promise<HelixResult>>();
  let running = 0;
  const waiting: Array<() => void> = [];
  const solve = (values: Record<string, number>): Promise<HelixResult> => {
    const args = [...Object.entries(values).flatMap(([k, v]) => [`--${k}`, String(Number(v.toFixed(6)))]), '--cell', String(o.cell)];
    const key = args.join(' ');
    if (!cache.has(key)) {
      const out = join(dir, `${key.replace(/[^\w.-]+/g, '_')}.json`);
      cache.set(key, (async () => {
        if (existsSync(out)) {
          cached.push(key);
          return JSON.parse(readFileSync(out, 'utf8')) as HelixResult;
        }
        while (running >= o.jobs) await new Promise<void>((go) => waiting.push(go));
        running++;
        try {
          console.log(`solving ${key}`);
          await run('npx', ['tsx', 'scripts/validate/gonzaga_helix.ts', ...args, '--out', out], { maxBuffer: 1 << 24 });
          return JSON.parse(readFileSync(out, 'utf8')) as HelixResult;
        } finally {
          running--;
          waiting.shift()?.();
        }
      })());
    }
    return cache.get(key)!;
  };

  const baseValues = Object.fromEntries(o.variables.map((v) => [v, VALUES[v].value]));
  const t0 = performance.now();
  const base = await solve(baseValues);
  const leverMm: Record<string, number> = { pitch: base.arm_length_mm, wrap: VALUES.radius.value };
  const variables: SensitivityVariable[] = o.variables.map((name) => {
    const { value, unit } = VALUES[name];
    const range = o.ranges.get(name);
    const minStep = unit === 'mm' ? o.cell : (180 / Math.PI) * (o.cell / leverMm[name]);
    return {
      name, value, unit, minStep, minSet: range !== undefined, maxSet: range !== undefined, rangeSet: range !== undefined,
      min: range?.[0] ?? value * (1 - UNSET_RANGE_FRACTION), max: range?.[1] ?? value * (1 + UNSET_RANGE_FRACTION),
    };
  });
  const { steps, skipped } = planSteps(variables, o.stepPct / 100, () => true);
  const pairs = await Promise.all(steps.map((s) => Promise.all(s.at.map((x) => solve({ ...baseValues, [s.variable.name]: x })))));
  const rows = rankBy(analyse(steps, METRICS, metricsOf(base), pairs.map(([a, b]) => [metricsOf(a), metricsOf(b)]),
    { base: base.grid.cells, perturbed: pairs.map(([a, b]) => [a.grid.cells, b.grid.cells]) }), 'f0_mhz');
  const wallS = (performance.now() - t0) / 1000;
  for (const row of rows) {
    const v = row.variable;
    console.log(`\n${v.name} = ${v.value} ${v.unit}, range ${v.min.toFixed(2)} to ${v.max.toFixed(2)}, step ${row.h.toFixed(3)} ${v.unit} ${row.scheme}`);
    for (const m of METRICS) {
      const s = row.slopes[m.key];
      console.log(`  ${m.label.padEnd(34)}${s ? `${s.perUnit.toFixed(3)} ${m.unit}/${v.unit} ± ${s.spread.toFixed(3)}, across range ${s.acrossRange.toFixed(2)} ${m.unit}, ${s.grade}${s.curved ? ', curved' : ''}` : 'n/a'}`);
    }
    for (const n of row.notes) console.log(`  note: ${n}`);
  }
  // wall_s is this invocation only (0 when every point came from the cache); point_solve_s is what the points cost when solved, from each point's own record.
  const pointSolveS = [base, ...pairs.flat()].reduce((sum, p) => sum + p.solve_s, 0);
  const out = o.out || 'docs/validation/data/gonzaga_sensitivity.json';
  writeFileSync(out, JSON.stringify({ cell_mm: o.cell, wall_s: Math.round(wallS), point_solve_s: Math.round(pointSolveS), cache: dir, points_from_cache: cached, base: metricsOf(base), metrics: METRICS, rows, skipped }, null, 2) + '\n');
  if (cached.length) console.log(`\n${cached.length} point(s) read from ${dir}, solved earlier by the same code`);
  console.log(`\n${1 + 2 * steps.length} solves in ${Math.round(wallS)} s -> ${out}`);
}

/** Hash of everything a helix solve depends on: the two helix scripts and every file of the engine. */
function codeHash(): string {
  const files = ['scripts/validate/gonzaga_helix.ts', 'scripts/validate/open_helix_model.ts',
    ...readdirSync('src/engine', { recursive: true, encoding: 'utf8' }).map((f) => join('src/engine', f)).filter((f) => /\.(ts|wgsl)$/.test(f)).sort()];
  const hash = createHash('sha256');
  for (const f of files) hash.update(f).update(readFileSync(f));
  return hash.digest('hex').slice(0, 12);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
