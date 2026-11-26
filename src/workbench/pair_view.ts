/**
 * The Differential view: a solved board read as differential pairs. Mixed-mode
 * S (insertion loss Sdd21, return loss Sdd11, mode conversion Scd21), the
 * differential TDR, delay and intra-pair skew (engine/differential.ts).
 *
 * The pairing lives in the project (outputs.differential_pairs) but is
 * post-processing only, so changing it never makes results stale. When the
 * project has none, the view proposes one from the S-matrix and the port
 * positions and shows its results straight away; nothing is written to the
 * project until the user picks Use this pairing.
 */
import { analyseDifferential, constantLossNote, modeTerm, TIMING_ENERGY_DECAY_DB, pairSpecsFromIds, proposePairs, type DifferentialReport, type PairSpec } from '../engine/differential';
import { constantLossDielectrics, resolveProject } from '../project/resolve';
import { parseProject, type DifferentialPairDef } from '../project/schema';
import { escapeHtml, withMinus } from '../ui/format';
import { extent, LineChart, type Trace } from './line_chart';
import { TRACE_COLORS } from './results';
import type { WorkbenchResult } from './solve';

type Doc = Record<string, unknown>;

/** The document with this pairing, or none. */
export function withPairs(doc: Doc, pairs: DifferentialPairDef[] | null): Doc {
  const next = structuredClone(doc) as { outputs: Doc };
  if (pairs) next.outputs.differential_pairs = pairs;
  else delete next.outputs.differential_pairs;
  return next as Doc;
}

export type PairState =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'paired' | 'proposed'; pairs: DifferentialPairDef[]; specs: PairSpec[]; report: DifferentialReport }
  | { kind: 'invalid'; pairs: DifferentialPairDef[]; reason: string };

/** The document's pairing when it is a non-empty list of pair entries; anything else counts as none (the validator reports it). */
function listedPairs(doc: unknown): DifferentialPairDef[] | null {
  const listed = (doc as { outputs?: { differential_pairs?: unknown } } | null)?.outputs?.differential_pairs;
  if (!Array.isArray(listed) || !listed.length) return null;
  const entry = (p: unknown) => !!p && typeof p === 'object' && ['id', 'positive', 'negative'].every((k) => typeof (p as Record<string, unknown>)[k] === 'string');
  return listed.every(entry) ? (listed as DifferentialPairDef[]) : null;
}

/** The last state worked out, keyed by the solve's S-matrix and the pairing: every edit asks again, and the analysis is not free. A steered far field keeps S. */
let cached: { s: WorkbenchResult['s']; pairsJson: string; state: PairState } | null = null;

/** What the view can show for this result under the document's current pairing. */
export function pairState(r: WorkbenchResult, doc: unknown): PairState {
  const pairs = listedPairs(doc);
  const pairsJson = JSON.stringify(pairs);
  if (cached?.s === r.s && cached.pairsJson === pairsJson) return cached.state;
  const state = computePairState(r, pairs);
  cached = { s: r.s, pairsJson, state };
  return state;
}

function computePairState(r: WorkbenchResult, pairs: DifferentialPairDef[] | null): PairState {
  let kind: 'paired' | 'proposed' = 'paired';
  let chosen = pairs;
  try {
    if (!chosen) {
      const proposal = proposePairs(r.s, r.portIds, r.ports);
      if ('reason' in proposal) return { kind: 'unavailable', reason: proposal.reason };
      kind = 'proposed';
      chosen = proposal.pairs;
    }
    const specs = pairSpecsFromIds(chosen, r.portIds);
    return { kind, pairs: chosen, specs, report: analyseDifferential(r.s, r.z0, specs) };
  } catch (error) {
    if (!chosen || kind === 'proposed') return { kind: 'unavailable', reason: (error as Error).message };
    return { kind: 'invalid', pairs: chosen, reason: `${(error as Error).message}. Solve again, or change the pairing.` };
  }
}

const facts = (rows: Array<[string, string]>) => rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
const db = (x: number) => withMinus(`${x.toFixed(1)} dB`);
const ohms = (x: number) => `${x.toFixed(1)} Ω`;
const dbOf = (re: number, im: number) => 20 * Math.log10(Math.hypot(re, im));
/** Lowest |S| drawn: mode conversion of a symmetric pair sits near the solver's noise floor, which says nothing useful below this. */
const CHART_FLOOR_DB = -80;

export class PairView {
  private readonly sChart: LineChart;
  private readonly tdrChart: LineChart;

  constructor(private readonly el: {
    bar: HTMLElement; sChart: HTMLCanvasElement; tdrChart: HTMLCanvasElement; facts: HTMLElement; notes: HTMLElement;
  }, private readonly onPairs: (pairs: DifferentialPairDef[] | null) => void) {
    this.sChart = new LineChart(el.sChart);
    this.tdrChart = new LineChart(el.tdrChart);
  }

  show(r: WorkbenchResult, state: Exclude<PairState, { kind: 'unavailable' }>): void {
    this.renderBar(r, state);
    if (state.kind === 'invalid') {
      this.sChart.set({ traces: [], yUnit: 'dB' });
      this.tdrChart.set({ traces: [], yUnit: 'Ω', xUnit: 'ns' });
      this.el.facts.innerHTML = '';
      this.el.notes.innerHTML = `<p class="note">${escapeHtml(state.reason)}</p>`;
      return;
    }
    const { report } = state;
    const mm = report.mixedMode;
    const f = r.s.fGHz;
    const curve = (block: 'dd' | 'cd' | 'cc', to: number, from: number) => {
      const t = modeTerm(mm, block, to, from);
      return Float64Array.from(t.re, (x, m) => Math.max(CHART_FLOOR_DB, dbOf(x, t.im[m])));
    };
    const index = (id: string) => mm.pairIds.indexOf(id);
    const traces: Trace[] = report.throughs.flatMap((t, n) => {
      const [i, j] = [index(t.from), index(t.to)];
      const color = (k: number) => TRACE_COLORS[(3 * n + k) % TRACE_COLORS.length];
      return [
        { name: `Sdd${j + 1}${i + 1}`, color: color(0), x: f, y: curve('dd', j, i) },
        { name: `Sdd${i + 1}${i + 1}`, color: color(1), x: f, y: curve('dd', i, i) },
        { name: `Scd${j + 1}${i + 1}`, color: color(2), dashed: true, x: f, y: curve('cd', j, i) },
      ];
    });
    const lowest = extent(traces.flatMap((t) => Array.from(t.y)))[0];
    this.sChart.set({ traces, yUnit: 'dB', yMin: Math.floor(lowest / 10) * 10, yMax: 0, markers: r.zinGHz.map((x) => ({ x, label: `${x} GHz` })) });
    this.renderTdr(report);
    this.renderFacts(r, report);
  }

  private renderBar(r: WorkbenchResult, state: Exclude<PairState, { kind: 'unavailable' }>): void {
    const chips = state.pairs.map((p) =>
      `<span class="pair-chip"><strong>${escapeHtml(p.id)}</strong> ${escapeHtml(p.positive)} <span aria-label="positive">+</span> / ${escapeHtml(p.negative)} <span aria-label="negative">−</span></span>`).join('');
    const swapped = state.pairs.map((p) => ({ ...p, positive: p.negative, negative: p.positive }));
    const z0 = r.z0[0];
    const first = state.pairs[0];
    const field = (key: 'differential_ohm' | 'common_ohm', label: string, fallback: number) =>
      `<label class="select-label">${label} <input type="number" min="1" step="any" inputmode="decimal" data-reference="${key}" value="${first[key] ?? ''}" placeholder="${fallback}" /> Ω</label>`;
    const lead = state.kind === 'proposed'
      ? '<span class="pair-lead">Proposed from which ports transmit to which and where they sit:</span>'
      : '<span class="pair-lead">Pairs</span>';
    const actions = state.kind === 'proposed'
      ? '<button type="button" data-pair="use" class="primary">Use this pairing</button>'
      : `${field('differential_ohm', 'Differential reference', 2 * z0)}${field('common_ohm', 'Common reference', z0 / 2)}<button type="button" data-pair="clear">Remove pairing</button>`;
    // A proposal is confirmed first: only Use this pairing writes to the project.
    const swap = state.kind === 'proposed' ? '' : '<button type="button" data-pair="swap" title="Swap the positive and negative line at every end">Swap + and −</button>';
    this.el.bar.innerHTML = `${lead}${chips}${swap}${actions}`;
    this.el.bar.onclick = (e) => {
      const action = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-pair]')?.dataset.pair;
      if (action === 'use') this.onPairs(state.pairs);
      else if (action === 'swap') this.onPairs(swapped);
      else if (action === 'clear') this.onPairs(null);
    };
    this.el.bar.onchange = (e) => {
      const input = (e.target as HTMLElement).closest<HTMLInputElement>('input[data-reference]');
      if (!input) return;
      const key = input.dataset.reference as 'differential_ohm' | 'common_ohm';
      const value = Number(input.value.trim().replace(',', '.'));
      if (input.value.trim() && !(value > 0)) {
        input.setCustomValidity('A reference impedance above 0 Ω, or empty for the default.');
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      this.onPairs(state.pairs.map((p) => {
        const next = { ...p };
        if (input.value.trim()) next[key] = value;
        else delete next[key];
        return next;
      }));
    };
  }

  private renderTdr(report: DifferentialReport): void {
    const timed = report.throughs.find((t) => t.timing)?.timing;
    // Three round trips: the line, the far end, and what rings after it.
    const untilNs = timed ? 3 * 2 * timed.differentialDelayNs : Infinity;
    const traces: Trace[] = report.ends.flatMap((e, n) => {
      const tdr = e.differentialTdr;
      if (!tdr) return [];
      const keep = tdr.tNs.findIndex((t) => t > untilNs);
      const end = keep < 0 ? tdr.tNs.length : keep;
      return [{ name: `From ${e.id}`, color: TRACE_COLORS[n % TRACE_COLORS.length], dashed: n > 0, x: tdr.tNs.subarray(0, end), y: tdr.zOhm.subarray(0, end) }];
    });
    const zRef = report.ends[0].differentialOhm;
    // At least 10 ohm either side of the reference, so a near-match does not fill the chart with a few ohms of ripple.
    let [lo, hi] = [zRef - 10, zRef + 10];
    for (const t of traces) for (const z of Array.from(t.y)) [lo, hi] = [Math.min(lo, z), Math.max(hi, z)];
    this.tdrChart.set({
      traces, yUnit: 'Ω', xUnit: 'ns', yMin: Math.floor(lo / 5) * 5, yMax: Math.ceil(hi / 5) * 5,
      rules: [{ y: zRef, label: `${Number(zRef.toFixed(1))} Ω` }],
      markers: timed ? [{ x: Number((2 * timed.differentialDelayNs).toFixed(4)), label: 'Far end' }] : [],
    });
  }

  private renderFacts(r: WorkbenchResult, report: DifferentialReport): void {
    const mm = report.mixedMode;
    const rows: Array<[string, string]> = [];
    const notes: string[] = [];
    const end = report.ends[0];
    rows.push(['References', `${ohms(end.differentialOhm)} differential, ${ohms(end.commonOhm)} common`]);
    // One row when every end reads the same line impedance to 0.5 %, as on a uniform pair; else one row per end.
    const timedEnds = report.ends.filter((e) => e.lineDifferentialOhm && e.lineCommonOhm);
    const same = timedEnds.every((e) => Math.abs(e.lineDifferentialOhm!.median / timedEnds[0].lineDifferentialOhm!.median - 1) < 0.005);
    for (const e of same ? timedEnds.slice(0, 1) : timedEnds) {
      if (!e.lineDifferentialOhm || !e.lineCommonOhm) continue;
      const label = same ? '' : ` from ${e.id}`;
      rows.push([`Differential impedance${label}`, `${ohms(e.lineDifferentialOhm.median)} along the middle of the line (${ohms(e.lineDifferentialOhm.min)} to ${ohms(e.lineDifferentialOhm.max)})`]);
      rows.push([`Common-mode impedance${label}`, ohms(e.lineCommonOhm.median)]);
    }
    for (const t of report.throughs) {
      const [i, j] = [mm.pairIds.indexOf(t.from), mm.pairIds.indexOf(t.to)];
      const term = (block: 'dd' | 'cd', to: number, from: number) => {
        const s = modeTerm(mm, block, to, from);
        return Array.from(s.re, (x, m) => dbOf(x, s.im[m]));
      };
      const [sdd21, sdd11, scd21] = [term('dd', j, i), term('dd', i, i), term('cd', j, i)];
      const at = (values: number[], ghz: number) => {
        let m = 0;
        for (let q = 1; q < r.s.fGHz.length; q++) if (Math.abs(r.s.fGHz[q] - ghz) < Math.abs(r.s.fGHz[m] - ghz)) m = q;
        return values[m];
      };
      const span = `${t.from} to ${t.to}`;
      for (const ghz of r.zinGHz) rows.push([`Insertion loss, ${span}, at ${ghz} GHz`, `Sdd${j + 1}${i + 1} ${db(at(sdd21, ghz))}`]);
      rows.push([`Worst return loss, ${t.from}`, `Sdd${i + 1}${i + 1} ${db(Math.max(...sdd11))}`]);
      rows.push([`Worst mode conversion, ${span}`, `Scd${j + 1}${i + 1} ${db(Math.max(...scd21))}`]);
      if (t.timing) {
        const s = t.timing.skewPs;
        rows.push([`Delay, ${span}`, `${(1000 * t.timing.differentialDelayNs).toFixed(1)} ps`]);
        rows.push(['Intra-pair skew', Math.abs(s) < 0.05 ? 'under 0.05 ps' : `${Math.abs(s).toFixed(2)} ps, the ${s > 0 ? 'positive' : 'negative'} line later`]);
      } else {
        rows.push([`Delay, ${span}`, `not measured: ${t.timingProblem}`]);
      }
      const c = t.skewFromConversionPs;
      if (c) rows.push(['Skew from mode conversion', `${withMinus(c.median.toFixed(2))} ps (median; ${withMinus(c.min.toFixed(2))} to ${withMinus(c.max.toFixed(2))} ps over the band)`]);
    }
    if (end.differentialTdr) rows.push(['TDR rise time', `${end.differentialTdr.riseTimePs.toFixed(0)} ps, set by the ${r.s.fGHz[r.s.fGHz.length - 1]} GHz top of the band`]);
    if (report.timeDomainProblem) notes.unshift(`No TDR, delay or skew: ${report.timeDomainProblem}.`);
    const timed = report.throughs.find((t) => t.timing)?.timing;
    if (timed && end.differentialTdr && !timedEnds.length) {
      rows.push(['Differential impedance', `not read: the ${end.differentialTdr.riseTimePs.toFixed(0)} ps TDR rise time is longer than the ` +
        `${(1000 * timed.differentialDelayNs).toFixed(0)} ps line, so the port connections blur into it. Raise the top of the band, or lengthen the line.`]);
    }

    notes.push('Skew is the difference of the two lines\' step-response 50 % crossings. The mode-conversion figure reads the same skew from ' +
      'Im(Scd21 / Sdd21); it matches only when the lines differ in delay alone, so a gap between the two points at impedance or loss imbalance too.');
    notes.push('The ports are lumped: the bumps at both ends of the TDR are the port connections, and on the four-port Sheen branch-line coupler ' +
      'lumped ports read 7 to 9 % low (docs/validation.md). NobuRF is not yet validated on a coupled pair, and its zero-thickness copper ' +
      'understates the coupling between the traces.');
    const decay = Math.min(...r.runs.map((run) => run.energyDecayDb));
    if (decay < TIMING_ENERGY_DECAY_DB - 5) {
      notes.unshift(`The runs stopped at ${Number.isFinite(decay) ? `${decay.toFixed(0)} dB` : 'their step limit, with no'} energy decay. Skew and the TDR level rest on the lowest frequencies, ` +
        `which a short ring-down leaves wrong; set the energy stop to ${TIMING_ENERGY_DECAY_DB} dB under Analysis and solve again before trusting them.`);
    }
    const leaky = solvedConstantLossDielectrics(r.projectText);
    if (leaky.length && end.differentialTdr) notes.unshift(constantLossNote(leaky));
    const f = r.s.fGHz;
    const df = (f[f.length - 1] - f[0]) / (f.length - 1);
    if (f[0] > 2 * df) notes.push(`The band starts at ${f[0]} GHz, so the TDR level is extrapolated towards DC and can be several ohms off. Start the band one frequency step above DC for a true level.`);
    this.el.facts.innerHTML = facts(rows);
    this.el.notes.innerHTML = notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
  }
}

/** The solved project's plain-loss-tangent dielectrics; none when its text no longer parses (the solve itself did). */
function solvedConstantLossDielectrics(projectText: string): string[] {
  try {
    return constantLossDielectrics(resolveProject(parseProject(JSON.parse(projectText))));
  } catch {
    return [];
  }
}
