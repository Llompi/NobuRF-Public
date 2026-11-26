import { describe, expect, it } from 'vitest';
import type { Evaluation, Evaluator } from '../src/design/evaluate';
import { metricsFromSpectrum, type DesignGoal } from '../src/design/goal';
import { patchDesign } from '../src/design/patch_template';
import { DesignSession } from '../src/design/session';
import { analyse, applyStepCheck, planSteps, rankBy, slopeOf, type SensitivityVariable } from '../src/design/sensitivity';
import { resolveProject } from '../src/project/resolve';
import type { Project } from '../src/project/schema';

const variable = (over: Partial<SensitivityVariable> = {}): SensitivityVariable => ({
  name: 'x', value: 5, min: 0, max: 10, minSet: true, maxSet: true, rangeSet: true, unit: 'mm', minStep: 0, ...over,
});

describe('finite differences', () => {
  it('central: exact on a quadratic, spread is the curvature term h |f\'\'| / 2', () => {
    const f = (x: number) => 3 * x * x - 2 * x + 1; // f' = 6x - 2, f'' = 6
    const [x, h] = [2, 0.1];
    const s = slopeOf('central', h, f(x), f(x - h), f(x + h));
    expect(s.perUnit).toBeCloseTo(10, 10);
    expect(s.spread).toBeCloseTo((h * 6) / 2, 10);
  });

  it('one-sided: second order, exact on a quadratic, both directions', () => {
    const f = (x: number) => 3 * x * x - 2 * x + 1;
    const [x, h] = [2, 0.1];
    expect(slopeOf('forward', h, f(x), f(x + h), f(x + 2 * h)).perUnit).toBeCloseTo(10, 10);
    expect(slopeOf('backward', h, f(x), f(x - h), f(x - 2 * h)).perUnit).toBeCloseTo(10, 10);
  });

  it('grades a jump unresolved, a jump plus a small trend sign only, a clean slope clean', () => {
    const steps = planSteps([variable()], 0.02, () => true).steps; // h = 0.2
    const metrics = [{ key: 'm', label: 'M', unit: 'u' }];
    const [jump] = analyse(steps, metrics, { m: 0 }, [[{ m: 0 }, { m: 1 }]]); // flat, then a step up
    expect(jump.slopes.m!.grade).toBe('unresolved');
    // True slope 0.5 plus a jump of 1 above: the slope reads 3, spread 2.5; the size is not to be trusted.
    const [trend] = analyse(steps, metrics, { m: 0 }, [[{ m: -0.1 }, { m: 1.1 }]]);
    expect(trend.slopes.m!.grade).toBe('sign only');
    const [clean] = analyse(steps, metrics, { m: 0 }, [[{ m: -0.2 }, { m: 0.2 }]]);
    expect(clean.slopes.m).toMatchObject({ perUnit: 1, spread: 0, acrossRange: 10, grade: 'clean', curved: false });
  });

  it('marks a curved response whose across-range figure is a poor linear estimate', () => {
    const steps = planSteps([variable()], 0.02, () => true).steps; // h = 0.2, span 10
    const f = (x: number) => 0.2 * x + 0.05 * x * x; // f' = 0.2, f'' = 0.1 at 0: curvature over the range 0.1 * 100 / 8 = 1.25 > 0.5
    const [row] = analyse(steps, [{ key: 'm', label: 'M', unit: 'u' }], { m: f(0) }, [[{ m: f(-0.2) }, { m: f(0.2) }]]);
    expect(row.slopes.m).toMatchObject({ grade: 'clean', curved: true });
  });

  it('the step check estimates the slope error from twice the step and downgrades a step-dependent slope', () => {
    const metrics = [{ key: 'm', label: 'M', unit: 'u' }];
    const f = (x: number) => x ** 3; // f'(1) = 3; central error h^2 f''' / 6 = h^2
    const study = (scale: number) => {
      const steps = planSteps([variable({ value: 1, min: -10, max: 10, minStep: 0.5 })], 0.001, () => true, scale).steps;
      const h = steps[0].h;
      return analyse(steps, metrics, { m: f(1) }, [[{ m: f(1 - h) }, { m: f(1 + h) }]]);
    };
    const [rows, doubled] = [study(1), study(2)]; // h = 0.5: slope 3.25; 2h = 1: slope 4
    applyStepCheck(rows, doubled);
    expect(rows[0].slopes.m!.perUnit).toBeCloseTo(3.25, 10);
    expect(rows[0].slopes.m!.stepError).toBeCloseTo(0.25, 10); // exactly the true error h^2 for a cubic
    // A clean linear slope (2) that reads 0 at twice the step: step error 2/3, a third of it, so no longer clean.
    const steps = planSteps([variable()], 0.02, () => true).steps;
    const [lin] = analyse(steps, metrics, { m: 0 }, [[{ m: -0.4 }, { m: 0.4 }]]);
    expect(lin.slopes.m!.grade).toBe('clean');
    const [flat] = analyse(steps, metrics, { m: 0 }, [[{ m: 0 }, { m: 0 }]]);
    applyStepCheck([lin], [flat]);
    expect(lin.slopes.m!.stepError).toBeCloseTo(2 / 3, 10);
    expect(lin.slopes.m!.grade).toBe('sign only');
  });

  it('never ranks an unresolved jump above a clean slope', () => {
    const steps = planSteps([variable({ name: 'jumpy' }), variable({ name: 'clean' })], 0.02, () => true).steps;
    const metrics = [{ key: 'm', label: 'M', unit: 'u' }];
    const rows = analyse(steps, metrics, { m: 0 }, [[{ m: 0 }, { m: 100 }], [{ m: -0.2 }, { m: 0.2 }]]);
    expect(rankBy(rows, 'm').map((r) => r.variable.name)).toEqual(['clean', 'jumpy']);
  });

  it('never steps below the mesh, goes one-sided at a bound, skips a variable with no room', () => {
    const { steps, skipped } = planSteps([
      variable({ name: 'fine', minStep: 0.5 }), // 2 % of 10 = 0.2 < 0.5
      variable({ name: 'atMin', value: 0 }),
      variable({ name: 'atMax', value: 10 }),
      variable({ name: 'tight', min: 4.9, max: 5.1, value: 5, minStep: 0.5 }),
    ], 0.02, () => true);
    expect(steps.map((s) => [s.variable.name, s.scheme, s.h])).toEqual([['fine', 'central', 0.5], ['atMin', 'forward', 0.2], ['atMax', 'backward', 0.2]]);
    expect(steps[1].at).toEqual([0.2, 0.4]);
    expect(skipped.map((s) => s.name)).toEqual(['tight']);
  });

  it('respects a dependent range the caller reports as infeasible', () => {
    const { steps } = planSteps([variable()], 0.02, (_, x) => x >= 5); // below the value is refused
    expect(steps[0].scheme).toBe('forward');
  });

  it('ranks by the change across the range, not the slope', () => {
    const steps = planSteps([variable({ name: 'steepNarrow', min: 4.5, max: 5.5 }), variable({ name: 'gentleWide' })], 0.02, () => true).steps;
    const metrics = [{ key: 'm', label: 'M', unit: 'u' }];
    const rows = analyse(steps, metrics, { m: 0 }, [
      [{ m: -0.02 * 5 }, { m: 0.02 * 5 }], // h = 0.02: slope 5, range 1 -> 5
      [{ m: -0.2 }, { m: 0.2 }], // h = 0.2: slope 1, range 10 -> 10
    ]);
    expect(rankBy(rows, 'm').map((r) => r.variable.name)).toEqual(['gentleWide', 'steepNarrow']);
  });
});

/** A stand-in solver: resonance 68 / patch_l GHz (df/dL known exactly), match independent of the other variables. */
function cavityEvaluator(goal: DesignGoal): Evaluator {
  const one = (project: Project): Evaluation => {
    const v = resolveProject(project).variables;
    const f0 = 68 / v.patch_l.value;
    const fGHz = Array.from({ length: 2001 }, (_, k) => 4 + (4 * k) / 2000);
    const s11Db = fGHz.map((f) => 10 * Math.log10(1 - 0.9 / (1 + ((f - f0) / (0.02 * f0)) ** 2)));
    const zRe = fGHz.map(() => 50 + v.feed_w.value);
    const zIm = fGHz.map(() => 0);
    const spectrum = { fGHz, s11Db, zRe, zIm };
    return { metrics: metricsFromSpectrum(spectrum, goal), spectrum, cells: 1000, steps: 1, solveMs: 1, warnings: [] };
  };
  return { evaluateAll: async (ps) => ps.map((p) => ({ status: 'fulfilled' as const, value: one(p) })), stopCurrent: () => false, solves: 0, solveMs: 0, close: async () => {} };
}

describe('design session sensitivity', () => {
  const goal: DesignGoal = { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 };

  it('recovers the exact slope, ranks patch_l first, costs 2 solves per variable plus the base', async () => {
    const design = patchDesign({ goal, boardWMm: 20, boardLMm: 20 });
    const session = new DesignSession(design, cavityEvaluator(goal), { maxSearchSolves: 60, maxConfirmSolves: 1 });
    const report = await session.sensitivity({}, 'search');
    expect(report.solves).toBe(1 + 2 * 3); // patch_w, patch_l, feed_w (no feature on)
    expect(report.rows[0].variable.name).toBe('patch_l');
    const l = session.current.values.patch_l;
    const exact = (-68000 / (l * l)); // MHz per mm
    expect(report.rows[0].slopes.f0_mhz!.perUnit).toBeCloseTo(exact, -1);
    expect(Math.abs(report.rows[0].slopes.f0_mhz!.perUnit - exact) / Math.abs(exact)).toBeLessThan(0.01);
    const feed = report.rows.find((r) => r.variable.name === 'feed_w')!;
    expect(feed.slopes.f0_mhz!.perUnit).toBe(0);
    expect(feed.slopes.zin_target_ohm!.perUnit).toBeCloseTo(1, 6);
    // The tool form: compact, and a refused variable is a tool error, not a crash.
    expect(await session.call('sensitivity', { variables: ['slot_l'] })).toMatchObject({ error: expect.stringContaining('off') });
    const view = (await session.call('sensitivity', { variables: ['patch_l'], rank_by: 's11_min_db' })) as { rows: unknown[]; solves: number };
    expect(view.rows).toHaveLength(1);
    expect(view.solves).toBe(0); // every point already solved
  });

  it('refuses a project with more than one port, as the workbench does', async () => {
    const design = patchDesign({ goal, boardWMm: 20, boardLMm: 20 });
    const port = design.project.ports[0];
    design.project = { ...design.project, ports: [port, { ...port, id: `${port.id}_2` }] };
    const session = new DesignSession(design, cavityEvaluator(goal), { maxSearchSolves: 60, maxConfirmSolves: 1 });
    expect(await session.call('sensitivity', {})).toMatchObject({ error: expect.stringContaining('2 ports') });
  });
});
