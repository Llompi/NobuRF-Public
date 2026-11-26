/**
 * The Sensitivity view: which of the project's variables move the results
 * most, from the same study as `design sensitivity` (src/design/sensitivity.ts,
 * DesignSession.sensitivity), with the solves run one after another in the
 * solve worker. One port only: the metrics are that port's S11 and Z_in.
 */
import { designFromProject } from '../design/design_file';
import type { Evaluation, Evaluator } from '../design/evaluate';
import { metricsFromSpectrum, type DesignGoal } from '../design/goal';
import { DesignSession, type SensitivityReport } from '../design/session';
import { rankBy, type Slope, type SlopeGrade } from '../design/sensitivity';
import type { Project } from '../project/schema';
import { escapeHtml, withMinus } from '../ui/format';
import { scaledMeshJson } from '../verify/convergence';
import type { SolverChoice, SolveProgress, SolveStart, WorkbenchResult } from './solve';
import { SolveCancelled, startSolve } from './solve_client';

/** The coarse mesh: cells sqrt 2 larger, so about 2.8 times fewer cells and 1.4 times fewer time steps. */
export const COARSE_MESH_SCALE = Math.SQRT2;

export interface SensitivityRunHooks {
  /** Before solve `index` (0-based) of `count`. */
  onSolve(index: number, count: number): void;
  onStart(start: SolveStart): void;
  onProgress(progress: SolveProgress): void;
}

/** Solves one project at a time in a fresh solve worker; `cancel` stops the one running and refuses the rest. */
class WorkbenchEvaluator implements Evaluator {
  solves = 0;
  solveMs = 0;
  cancelled = false;
  private running: { cancel(): void } | null = null;

  constructor(private readonly goal: DesignGoal, private readonly choice: SolverChoice, private readonly hooks: SensitivityRunHooks) {}

  async evaluateAll(projects: Project[]): Promise<Array<PromiseSettledResult<Evaluation>>> {
    const out: Array<PromiseSettledResult<Evaluation>> = [];
    for (const [n, project] of projects.entries()) {
      if (this.cancelled) {
        out.push({ status: 'rejected', reason: new SolveCancelled() });
        continue;
      }
      this.hooks.onSolve(n, projects.length);
      // Only S11 and Z_in are read: leave out the far field, the near-field scan and the field volume.
      const lean = { ...project, outputs: { ...project.outputs, far_field_ghz: undefined, array_excitation: undefined, near_field_mm: undefined } };
      const run = startSolve(JSON.stringify(lean), this.choice, 'off', false, { onStart: this.hooks.onStart, onProgress: this.hooks.onProgress });
      this.running = run;
      try {
        out.push({ status: 'fulfilled', value: this.evaluation(await run.done) });
      } catch (reason) {
        out.push({ status: 'rejected', reason });
      } finally {
        this.running = null;
      }
    }
    return out;
  }

  private evaluation(r: WorkbenchResult): Evaluation {
    const run = r.runs[0];
    const spectrum = { fGHz: Array.from(run.spectrum.fGHz), s11Db: Array.from(run.spectrum.s11Db), zRe: Array.from(run.spectrum.zRe), zIm: Array.from(run.spectrum.zIm) };
    this.solves++;
    this.solveMs += r.solveMs;
    return {
      metrics: metricsFromSpectrum(spectrum, this.goal), spectrum, cells: r.grid.nx * r.grid.ny * r.grid.nz,
      steps: run.steps, solveMs: r.solveMs, warnings: r.warnings,
    };
  }

  cancel(): void {
    this.cancelled = true;
    this.running?.cancel();
  }

  async close(): Promise<void> {}
}

/**
 * Runs the study on the project document. Coarse: on a mesh sqrt 2 coarser
 * than the project's (fast, for ranking); else on the project's own mesh.
 * Resolves to null when cancelled.
 */
export function runSensitivity(doc: Project, choice: SolverChoice, coarse: boolean, checkStep: boolean, hooks: SensitivityRunHooks): { done: Promise<SensitivityReport | null>; cancel(): void } {
  if (doc.ports.length !== 1) throw new Error(`the sensitivity study reads one port's S11 and Z_in; this project has ${doc.ports.length} ports`);
  const searchMesh = coarse ? (scaledMeshJson(doc, COARSE_MESH_SCALE).mesh as Project['mesh']) : undefined;
  const design = designFromProject(doc, undefined, searchMesh);
  const evaluator = new WorkbenchEvaluator(design.goal, choice, hooks);
  const session = new DesignSession(design, evaluator, { maxSearchSolves: Number.MAX_SAFE_INTEGER, maxConfirmSolves: 0 });
  const done = session.sensitivity({ check_step: checkStep }, 'search').then((report) => (evaluator.cancelled ? null : report));
  return { done, cancel: () => evaluator.cancel() };
}

/* -------------------------------------------------------------------- view */

const sig = (x: number) => withMinus(Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

/** A change across the range, in the metric's unit (MHz shown as GHz once it is large). */
function changeText(value: number, unit: string): string {
  if (unit === 'MHz' && Math.abs(value) >= 1000) return `${sig(value / 1000)} GHz`;
  return `${sig(value)} ${unit === 'ohm' ? 'Ω' : unit}`;
}

export class SensitivityView {
  private report: SensitivityReport | null = null;
  private meta: StudyMeta | null = null;

  constructor(private readonly els: { rows: HTMLElement; metric: HTMLSelectElement; facts: HTMLElement; notes: HTMLElement; empty: HTMLElement }) {
    els.metric.addEventListener('change', () => this.render());
  }

  show(report: SensitivityReport, meta: StudyMeta): void {
    this.report = report;
    this.meta = meta;
    const keep = this.els.metric.value;
    this.els.metric.innerHTML = report.metrics.map((m) => `<option value="${m.key}">${escapeHtml(m.label)}</option>`).join('');
    this.els.metric.value = report.metrics.some((m) => m.key === keep) ? keep : report.rankBy;
    this.els.metric.disabled = false;
    this.render();
  }

  private render(): void {
    const { report, meta, els } = this;
    if (!report || !meta) return;
    const metric = report.metrics.find((m) => m.key === els.metric.value) ?? report.metrics[0];
    const rows = rankBy(report.rows, metric.key);
    // Bars scale to the largest clean slope, so a jump read as a slope cannot shrink every other bar.
    const clean = rows.map((r) => r.slopes[metric.key]).filter((s): s is Slope => s?.grade === 'clean');
    const largest = Math.max(...(clean.length ? clean : rows.map((r) => r.slopes[metric.key]).filter((s): s is Slope => !!s)).map((s) => Math.abs(s.acrossRange)), 0);
    els.empty.hidden = rows.length > 0;
    els.empty.textContent = rows.length ? '' : 'No variable could be stepped. Unlock a length variable and give it a min and max in the inspector, then run again.';
    els.rows.innerHTML = rows.map((r) => {
      const s = r.slopes[metric.key];
      const v = r.variable;
      const head = `<div class="sens-name"><strong>${escapeHtml(v.name)}</strong><span>${v.value.toFixed(2)} ${escapeHtml(v.unit)} in ${v.min.toFixed(2)} to ${v.max.toFixed(2)}</span></div>`;
      if (!s) return `<li class="sens-row">${head}<div class="sens-bar-track"></div><div class="sens-value">no value</div></li>`;
      const share = largest > 0 ? Math.min(1, Math.abs(s.acrossRange) / largest) : 0;
      const side = s.acrossRange < 0 ? 'down' : 'up';
      const detail = `${sig(s.perUnit)} ${metric.unit === 'ohm' ? 'Ω' : metric.unit}/${v.unit} ± ${sig(s.spread)}${s.stepError !== undefined ? `, step error ${sig(s.stepError)}` : ''} · step ${r.h.toFixed(2)} ${v.unit}${r.scheme === 'central' ? '' : `, ${r.scheme}`}`;
      const flag = s.grade === 'clean' ? '' : `<span class="sens-flag" title="${GRADE_TEXT[s.grade]}">${s.grade}</span>`;
      const curved = s.curved ? '<span class="sens-flag" title="The curvature between the two steps would bend the result across the range by more than a quarter of this straight-line figure. Trust the slope, not the across-range number.">curved</span>' : '';
      return `<li class="sens-row${s.grade === 'clean' ? '' : ' unresolved'}">${head}` +
        `<div class="sens-bar-track" aria-hidden="true"><div class="sens-bar ${side}" style="width:${(50 * share).toFixed(1)}%"></div></div>` +
        `<div class="sens-value"><span class="number">${changeText(s.acrossRange, metric.unit)}</span> <span class="sens-caption">across its range</span>${flag}${curved}<span class="sens-detail">${escapeHtml(detail)}</span></div></li>`;
    }).join('');
    const base = report.base.metrics;
    const facts: Array<[string, string]> = [
      ...(meta.changed ? [['For', 'the project as it was when the study started; it has changed since, so run it again'] as [string, string]] : []),
      ['Solves', `${report.solves} on the ${meta.mesh}, ${meta.seconds.toFixed(0)} s, ${meta.solver}`],
      ...(base ? [['At this design', `resonance ${(base.f0_ghz).toFixed(3)} GHz, dip ${withMinus(base.s11_min_db.toFixed(1))} dB`] as [string, string]] : []),
      ['Bars', `straight-line change of ${metric.label.toLowerCase()} across each variable's range; right raises it, left lowers it`],
    ];
    els.facts.innerHTML = facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    const notes = [
      ...report.rows.flatMap((r) => r.notes.map((n) => `${r.variable.name}: ${n}`)),
      ...report.skipped.map((s) => `${s.name} skipped: ${s.reason}`),
      'One variable at a time at this design: it does not see how variables interact. ± is half the gap between the slopes below and above the value: an indicator that grows with curvature, jumps and mesh noise, not an error bound.',
    ];
    els.notes.innerHTML = notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
  }
}

interface StudyMeta {
  mesh: string;
  seconds: number;
  solver: string;
  /** The project was edited while the study ran. */
  changed: boolean;
}

const GRADE_TEXT: Record<Exclude<SlopeGrade, 'clean'>, string> = {
  'sign only': 'The slopes below and above the value differ by more than 25 %: the direction is known, the size is not.',
  unresolved: 'The slopes below and above the value differ by more than the slope: the result turns, jumps or is flat within the step. Not a slope to act on.',
};
