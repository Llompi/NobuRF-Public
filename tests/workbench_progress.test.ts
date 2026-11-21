import { describe, expect, it } from 'vitest';
import { SolveProgressMeter } from '../src/workbench/progress';
import { efficiencyText } from '../src/workbench/results';
import type { SolveProgress } from '../src/workbench/solve';

const at = (decayDb: number | null, stage: SolveProgress['stage'] = 'solving'): SolveProgress =>
  ({ run: 0, runs: 1, step: 100, maxSteps: 1000, decayDb, targetDb: 40, stage });

describe('solve progress bar', () => {
  it('never moves backwards when the energy rises between checks', () => {
    const meter = new SolveProgressMeter();
    expect(meter.view(at(12), 0).fraction).toBeCloseTo(0.3);
    expect(meter.view(at(11), 0).fraction).toBeCloseTo(0.3);
    expect(meter.view(at(20), 0).fraction).toBeCloseTo(0.5);
  });

  it('names the work after the time loop instead of sitting at 100 %', () => {
    const view = new SolveProgressMeter().view(at(null, 'far-field'), 6000);
    expect(view).toEqual({ label: 'Computing the far field', detail: expect.any(String), fraction: null });
  });
});

describe('radiation efficiency text', () => {
  it('shows a hair over 100 % as numerical error, and a real excess as it is', () => {
    expect(efficiencyText(1.001)).toBe("100 % (within the solver's numerical error)");
    expect(efficiencyText(0.874)).toBe('87.4 %');
    expect(efficiencyText(1.05)).toBe('105.0 %');
  });
});
