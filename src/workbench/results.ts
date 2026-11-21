/**
 * Result views: |S| in dB, the Smith chart, Z_in, and the far-field cuts,
 * each with the figures an RF engineer reads first.
 */
import { interp } from '../engine/port_dft';
import { escapeHtml, fmtDuration, fmtOhms, withMinus } from '../ui/format';
import { patternCutsSvg } from '../viewer/pattern_plot';
import { drawSmith } from '../viewer/smith_chart';
import { LineChart, type Trace } from './line_chart';
import { BAND_SCOPE, BEHAVIOUR_TEXT, lastChange } from '../verify/accuracy';
import type { FarFieldSummary, WorkbenchResult } from './solve';

export const TRACE_COLORS = ['#f2a33a', '#8eaaf5', '#c7a3f0', '#7fd1a8', '#ec6b62', '#e3b448', '#9ba3af', '#5fc2d6'];
const MATCH_LEVEL_DB = -10;

/**
 * Lossless boards compute a hair over 100 % from discretisation error; showing "100.1 %" reads as a bug.
 * Larger excesses are shown as they are, since they point at a real problem.
 */
export function efficiencyText(efficiency: number): string {
  const percent = 100 * efficiency;
  if (percent > 100 && percent <= 101) return '100 % (within the solver\'s numerical error)';
  return `${percent.toFixed(1)} %`;
}

const db = (x: number) => withMinus(`${x.toFixed(1)} dB`);
const ghz = (x: number) => `${x.toFixed(3)} GHz`;

/** Lowest point of a dB trace and the contiguous span around it below `levelDb`. */
export function dipAndBandwidth(fGHz: ArrayLike<number>, valuesDb: ArrayLike<number>, levelDb: number) {
  let lo = 0;
  for (let m = 1; m < valuesDb.length; m++) if (valuesDb[m] < valuesDb[lo]) lo = m;
  if (valuesDb[lo] > levelDb) return { f: fGHz[lo], db: valuesDb[lo], bandwidthGHz: null };
  // Walk out from the dip to where the trace crosses the level, interpolating the crossing.
  const crossing = (inside: number, outside: number) =>
    fGHz[inside] + ((levelDb - valuesDb[inside]) / (valuesDb[outside] - valuesDb[inside])) * (fGHz[outside] - fGHz[inside]);
  let a = lo;
  while (a > 0 && valuesDb[a - 1] <= levelDb) a--;
  let b = lo;
  while (b < valuesDb.length - 1 && valuesDb[b + 1] <= levelDb) b++;
  const fLow = a > 0 ? crossing(a, a - 1) : fGHz[0];
  const fHigh = b < valuesDb.length - 1 ? crossing(b, b + 1) : fGHz[fGHz.length - 1];
  const openEnded = a === 0 || b === valuesDb.length - 1;
  return { f: fGHz[lo], db: valuesDb[lo], bandwidthGHz: fHigh - fLow, fLow, fHigh, openEnded };
}

/** Lowest |S| drawn; facts use the unclamped values. */
const CHART_FLOOR_DB = -60;

/** Every |S_ij| in dB, unclamped. */
function sParameterDb(r: WorkbenchResult): Array<{ name: string; reflection: boolean; db: Float64Array }> {
  const out: Array<{ name: string; reflection: boolean; db: Float64Array }> = [];
  const n = r.portIds.length;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [re, im] = [r.s.re[i][j], r.s.im[i][j]];
      if (!re || !im) continue;
      // Reciprocal pairs from the full matrix: show S21 and skip S12, which matches it to float rounding.
      // With matched loads they differ by the passive-port error, so both are shown.
      if (i < j && r.s.re[j][i] && r.s.method === 'full') continue;
      out.push({ name: `S${i + 1}${j + 1}`, reflection: i === j, db: Float64Array.from(re, (x, m) => 20 * Math.log10(Math.hypot(x, im[m]))) });
    }
  }
  return out;
}

const sParameterTraces = (r: WorkbenchResult): Trace[] => sParameterDb(r).map((p, n) => ({
  name: p.name, color: TRACE_COLORS[n % TRACE_COLORS.length], dashed: !p.reflection, x: r.s.fGHz,
  y: p.db.map((v) => Math.max(CHART_FLOOR_DB, v)),
}));

const facts = (rows: Array<[string, string]>) => rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');

function runFacts(r: WorkbenchResult): Array<[string, string]> {
  const steps = r.runs.map((run) => run.steps.toLocaleString('en-US')).join(' + ');
  const decay = Math.min(...r.runs.map((run) => run.energyDecayDb));
  const decayText = Number.isFinite(decay) ? `energy down ${decay.toFixed(0)} dB` : 'no energy check ran';
  return [
    ['Solver', r.solver],
    ['Mesh', `${r.grid.nx} × ${r.grid.ny} × ${r.grid.nz} cells, ${r.grid.smallestCellMm.toPrecision(2)} to ${r.grid.largestCellMm.toPrecision(2)} mm`],
    ['Steps', `${steps}, ${decayText}`],
    ['Solve time', fmtDuration(r.solveMs)],
    ...(r.deembedding ? [['De-embedded', r.deembedding.map((d) => `${d.feed.portId}: ${d.feed.lengthMm} mm of feed, line ${d.zLineOhm.toFixed(1)} Ω`).join('; ')] as [string, string]] : []),
  ];
}

/** The self-check in a few lines: error bar, convergence, physics checks, validated range. */
export function accuracyFacts(r: WorkbenchResult): Array<[string, string]> {
  const a = r.accuracy;
  if (!a) return [];
  const rows: Array<[string, string]> = [];
  const c = a.convergence;
  if (!c) {
    rows.push(['Mesh check', a.unavailable === 'off' ? 'off, so no mesh error bar; turn on Mesh check in the toolbar for one' : `no error bar: ${a.unavailable}`]);
  } else {
    const finest = c.levels[c.levels.length - 1];
    rows.push(['Results from', `the finest mesh solved, cells ×${finest.scale.toFixed(2)} of the project's (${finest.hMm.toFixed(3)} mm board cells)`]);
    const f = c.fResGhz;
    if (f) {
      const bar = `${ghz(f.value)} ± ${((100 * f.uncertainty) / f.value).toFixed(2)} %`;
      const how = f.behaviour === 'monotone' ? `; about ${f.extrapolated!.toFixed(3)} GHz extrapolated to an infinitely fine mesh`
        : f.behaviour === 'unchanged' ? ''
        : f.behaviour === 'oscillatory' || f.behaviour === 'divergent' ? `, a rough bound: the resonance ${BEHAVIOUR_TEXT[f.behaviour]}`
        : `; the resonance ${BEHAVIOUR_TEXT[f.behaviour]}`;
      rows.push(['Resonance error bar', bar + how]);
    }
    if (c.s11Min) {
      const { value, uncertainty } = c.s11Min;
      const dbOf = (x: number) => 20 * Math.log10(Math.max(1e-6, x));
      const bar = `|S11| ${value.toFixed(3)} ± ${uncertainty.toFixed(3)}`;
      rows.push(['Dip depth error bar', value - uncertainty > 0
        ? `${bar}, so ${db(dbOf(Math.min(1, value + uncertainty)))} to ${db(dbOf(value - uncertainty))}`
        : `${bar}: the mesh does not pin the depth down yet; two finer meshes narrow it`]);
    }
    rows.push(['Error bar covers', BAND_SCOPE]);
    rows.push(['Mesh convergence', `${c.converged ? 'Settled' : 'Still moving'} over ${c.levels.length} meshes: ${lastChange(c)}`]);
  }
  const failed = a.checks.filter((x) => !x.passed);
  const marginal = a.checks.filter((x) => x.passed && x.marginal);
  const named = (list: typeof a.checks) => list.map((x) => x.name.replace('_', ' ')).join(', ');
  rows.push(['Physics checks', failed.length ? `failed: ${named(failed)}`
    : a.checks.map((x) => ({ passivity: 'passive', reciprocity: 'reciprocal', energy_decay: 'rang down' })[x.name]).join(', ')
      + (marginal.length ? `; marginal: ${named(marginal)}` : '')]);
  const outside = a.envelope.filter((x) => !x.inside);
  rows.push(['Validated range', outside.length ? `outside: ${outside.map((x) => x.parameter).join('; ')}` : 'inside: each feature matches a benchmark that agrees with measurement']);
  return rows;
}

export class ResultViews {
  private readonly sChart: LineChart;
  private readonly zChart: LineChart;
  private result: WorkbenchResult | null = null;
  private farFieldIndex = 0;

  constructor(private readonly el: {
    sChart: HTMLCanvasElement; sFacts: HTMLElement;
    smith: HTMLCanvasElement; smithFacts: HTMLElement;
    zChart: HTMLCanvasElement; zFacts: HTMLElement;
    farField: HTMLElement; farFieldFacts: HTMLElement;
  }, private readonly onFarFieldFrequency: (entry: FarFieldSummary) => void) {
    this.sChart = new LineChart(el.sChart);
    this.zChart = new LineChart(el.zChart);
    new ResizeObserver(() => this.drawSmith()).observe(el.smith);
    el.farField.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      if (select.id !== 'farfield-frequency') return;
      this.farFieldIndex = Number(select.value);
      this.renderFarField();
      this.onFarFieldFrequency(this.result!.farField!.entries[this.farFieldIndex]);
    });
  }

  show(r: WorkbenchResult): void {
    this.result = r;
    this.farFieldIndex = 0;
    const markerGHz = this.designFrequency();
    const sTraces = sParameterTraces(r);
    const lowest = Math.min(...sTraces.flatMap((t) => Array.from(t.y)));
    this.sChart.set({
      traces: sTraces, yUnit: 'dB', yMin: Math.max(CHART_FLOOR_DB, Math.floor(lowest / 10) * 10), yMax: 0,
      rules: [{ y: MATCH_LEVEL_DB, label: '−10 dB' }],
      markers: markerGHz === null ? [] : [{ x: markerGHz, label: `${markerGHz} GHz` }],
    });
    this.el.sFacts.innerHTML = facts([...this.sFactRows(r), ...accuracyFacts(r), ...runFacts(r)]);

    const zTraces: Trace[] = r.runs.flatMap((run, n) => [
      { name: `Re Z${r.runs.length > 1 ? ` ${run.portId}` : ''}`, color: TRACE_COLORS[(2 * n) % TRACE_COLORS.length], x: run.spectrum.fGHz, y: run.spectrum.zRe },
      { name: `Im Z${r.runs.length > 1 ? ` ${run.portId}` : ''}`, color: TRACE_COLORS[(2 * n + 1) % TRACE_COLORS.length], dashed: true, x: run.spectrum.fGHz, y: run.spectrum.zIm },
    ]);
    this.zChart.set({ traces: zTraces, yUnit: 'Ω', rules: [{ y: r.z0[r.excited[0]], label: `${r.z0[r.excited[0]]} Ω` }, { y: 0, label: '' }],
      markers: markerGHz === null ? [] : [{ x: markerGHz, label: `${markerGHz} GHz` }] });
    this.el.zFacts.innerHTML = facts(this.zFactRows(r));
    this.drawSmith();
    this.renderFarField();
  }

  /** The first Z_in frequency of the project, the one the views mark. */
  private designFrequency(): number | null {
    return this.result?.zinGHz[0] ?? null;
  }

  private sFactRows(r: WorkbenchResult): Array<[string, string]> {
    if (r.portIds.length === 1) {
      const spec = r.runs[0].spectrum;
      const d = dipAndBandwidth(spec.fGHz, spec.s11Db, MATCH_LEVEL_DB);
      const bandwidth = d.bandwidthGHz === null ? `none: S11 stays above ${db(MATCH_LEVEL_DB)}`
        : `${Math.round(d.bandwidthGHz * 1000)} MHz (${d.fLow!.toFixed(3)} to ${d.fHigh!.toFixed(3)} GHz)${d.openEnded ? ', runs past the band edge' : ''}`;
      return [['Deepest S11', `${db(d.db)} at ${ghz(d.f)}`], ['Bandwidth below −10 dB', bandwidth]];
    }
    const f = r.s.fGHz;
    return sParameterDb(r).map((t): [string, string] => {
      let [lo, hi] = [0, 0];
      for (let m = 1; m < t.db.length; m++) {
        if (t.db[m] < t.db[lo]) lo = m;
        if (t.db[m] > t.db[hi]) hi = m;
      }
      return [t.name, `${db(t.db[lo])} at ${ghz(f[lo])} to ${db(t.db[hi])} at ${ghz(f[hi])}`];
    });
  }

  private zFactRows(r: WorkbenchResult): Array<[string, string]> {
    return r.runs.flatMap((run) => r.zinGHz.map((f): [string, string] => {
      const [re, im] = [interp(run.spectrum.fGHz, run.spectrum.zRe, f), interp(run.spectrum.fGHz, run.spectrum.zIm, f)];
      return [`Z at ${f} GHz${r.runs.length > 1 ? `, port ${run.portId}` : ''}`, fmtOhms(re, im)];
    }));
  }

  private drawSmith(): void {
    const r = this.result;
    if (!r) return;
    const run = r.runs[0];
    const target = this.designFrequency() ?? dipAndBandwidth(run.spectrum.fGHz, run.spectrum.s11Db, MATCH_LEVEL_DB).f;
    drawSmith(this.el.smith, run.spectrum, target, { traceColor: TRACE_COLORS[0], referenceOhms: r.z0[r.excited[0]], goalDb: MATCH_LEVEL_DB });
    const d = dipAndBandwidth(run.spectrum.fGHz, run.spectrum.s11Db, MATCH_LEVEL_DB);
    this.el.smithFacts.innerHTML = facts([
      ['Port', `${run.portId}${r.portIds.length > 1 ? ', others loaded by their reference impedance' : ''}`],
      ['Closest to the center', `${db(d.db)} at ${ghz(d.f)}`],
      ['Dashed circle', `|S11| = ${db(MATCH_LEVEL_DB)}`],
    ]);
  }

  private renderFarField(): void {
    const r = this.result;
    const host = this.el.farField;
    if (!r?.farField) {
      host.innerHTML = '';
      this.el.farFieldFacts.innerHTML = '';
      return;
    }
    const entries = r.farField.entries;
    const entry = entries[Math.min(this.farFieldIndex, entries.length - 1)];
    const f = entry.result;
    const fGHz = f.frequencyHz / 1e9;
    const svg = patternCutsSvg({
      pattern: f, frequencyGHz: fGHz, polarisation: entry.polarisation,
      caption: `${r.projectName}: peak directivity ${f.peakDirectivityDbi.toFixed(2)} dBi`,
    }).replace('@media (prefers-color-scheme: dark)', '@media all'); // The workbench is dark only.
    const picker = entries.length > 1
      ? `<label class="select-label">Frequency <select id="farfield-frequency">${entries.map((e, n) =>
        `<option value="${n}"${n === this.farFieldIndex ? ' selected' : ''}>${e.result.frequencyHz / 1e9} GHz</option>`).join('')}</select></label>`
      : '';
    const caveat = r.farField.caveat ? `<p class="note">${escapeHtml(r.farField.caveat)}</p>` : '';
    host.innerHTML = picker + caveat + `<img alt="E-plane and H-plane radiation pattern cuts at ${fGHz} GHz" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}" />`;
    const deg = (x: number | null) => (x === null ? 'not reached' : `${x.toFixed(0)}°`);
    this.el.farFieldFacts.innerHTML = facts([
      ['Peak directivity', `${withMinus(f.peakDirectivityDbi.toFixed(2))} dBi at θ ${f.peakThetaDeg}°, φ ${f.peakPhiDeg}°`],
      ['Peak gain', `${withMinus(f.peakGainDbi.toFixed(2))} dBi`],
      ['Realized gain', `${withMinus(f.peakRealisedGainDbi.toFixed(2))} dBi, with the port mismatch`],
      ['Radiation efficiency', efficiencyText(f.efficiency)],
      ['Half-power beamwidth', `E-plane ${deg(entry.beamwidthEPlaneDeg)}, H-plane ${deg(entry.beamwidthHPlaneDeg)}`],
      ['Front to back', db(entry.frontToBackDb)],
      ['Cross-polar at broadside', db(entry.crossPolarDb)],
    ]);
  }
}
