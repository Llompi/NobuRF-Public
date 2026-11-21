/**
 * What the progress bar says about a running solve. Kept apart from the page
 * so the rules (never move backwards, say what happens after the time loop)
 * can be tested.
 */
import { fmtClock } from '../ui/format';
import type { SolveProgress } from './solve';

export interface ProgressView {
  label: string;
  detail: string;
  /** 0..1, or null for an activity with no measurable end. */
  fraction: number | null;
}

const STAGE_LABELS: Record<Exclude<SolveProgress['stage'], 'solving'>, string> = {
  'reading-fields': 'Reading the field results from the GPU',
  'far-field': 'Computing the far field',
};

export class SolveProgressMeter {
  /** The furthest the bar has been: the energy can rise again between checks, the bar should not. */
  private furthest = 0;

  view(p: SolveProgress, elapsedMs: number): ProgressView {
    const clock = fmtClock(elapsedMs);
    if (p.meshScale !== undefined) {
      // Each mesh level is its own solve; one bar across them would run backwards.
      const label = `Mesh check: solving a finer mesh, cells ×${p.meshScale.toFixed(2)}`;
      const energy = p.stage === 'solving' && p.decayDb !== null ? `energy down ${p.decayDb.toFixed(0)} of ${p.targetDb} dB · ` : '';
      return { label, detail: energy + clock, fraction: null };
    }
    if (p.stage !== 'solving') return { label: STAGE_LABELS[p.stage], detail: clock, fraction: null };
    const run = p.runs > 1 ? `Run ${p.run + 1} of ${p.runs}: ` : '';
    if (p.decayDb === null) return { label: `${run}solving`, detail: clock, fraction: null };
    // Energy decay is what ends the run, so it is the honest measure of how far along it is.
    const fraction = (p.run + Math.min(1, Math.max(0, p.decayDb) / p.targetDb)) / p.runs;
    this.furthest = Math.max(this.furthest, fraction);
    return {
      label: `${run}step ${p.step.toLocaleString('en-US')}`,
      detail: `energy down ${p.decayDb.toFixed(0)} of ${p.targetDb} dB · ${clock}`,
      fraction: this.furthest,
    };
  }
}
