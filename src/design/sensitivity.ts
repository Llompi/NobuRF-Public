/**
 * Which design variables matter most: one-at-a-time finite differences.
 *
 * For each variable x with an allowed range [min, max], two extra solves give
 * the slope of every metric at the current design:
 *   central   (x - h, x + h):   d = (f+ - f-) / 2h
 *   forward   (x + h, x + 2h):  d = (-3 f0 + 4 f1 - f2) / 2h   (x - h outside the range)
 *   backward  (x - h, x - 2h):  the mirror image
 * all second order in h. The slope times the range is the change the variable
 * can make across its whole range if the response were linear: the number the
 * ranking sorts on, because a steep variable with no room to move matters less
 * than a gentle one with a wide range.
 *
 * Every slope comes with the spread of its two one-sided slopes, |s2 - s1| / 2
 * (s1 = (f0 - f-) / h, s2 = (f+ - f0) / h for central). On a smooth, nearly
 * linear response they agree and the spread is small. The spread grows with
 * curvature (it is h |f''| / 2), with a jump (a mesh line appearing, the dip
 * switching to another mode) and with solver noise. It is an indicator, not
 * an error bound: the central slope's own error h^2 f''' / 6 is invisible to
 * it, and noise gives one draw of it. Each slope is graded:
 *   clean      spread <= 25 % of the slope: the one-sided slopes agree;
 *   sign only  spread below the slope: the direction is known, the size is not;
 *   unresolved the response turns, jumps or is flat within +-h.
 * The change across the range is a linear estimate; when the curvature the
 * spread implies, |f''| span^2 / 8, exceeds a quarter of it, it is marked
 * curved and is not to be read as what the range will do.
 *
 * The step is a fraction of the range, never below the smallest change the
 * mesh resolves (minStep): on a graded mesh the lines follow the copper edges
 * and the floor is the edge cell; on a uniform mesh an edge snaps to the cells,
 * and a dimension centered on the origin moves each edge by half its change, so
 * the floor is two cells. Below that the slope reads 0 or a jump.
 *
 * This is local, one variable at a time, at one design: it misses interactions
 * between variables. An adjoint solve would give every slope from two solves
 * regardless of the number of variables; it is not implemented.
 */

export interface SensitivityVariable {
  name: string;
  value: number;
  /** The allowed range at the current design; a bound the project does not give is the value -+10 %. */
  min: number;
  max: number;
  minSet: boolean;
  maxSet: boolean;
  /** Both bounds come from the project. */
  rangeSet: boolean;
  unit: string;
  /** Smallest change the model resolves (a mesh cell); 0 when it varies smoothly. */
  minStep: number;
}

export type Scheme = 'central' | 'forward' | 'backward';

export interface StepPlan {
  variable: SensitivityVariable;
  h: number;
  scheme: Scheme;
  /** The two extra values solved: x - h and x + h (central), x + h and x + 2h (forward), x - h and x - 2h (backward). */
  at: [number, number];
}

export interface SkippedVariable {
  name: string;
  reason: string;
}

/** Default step: 2 % of the range. */
export const DEFAULT_STEP_FRACTION = 0.02;
/** Without a range in the project, the range taken is the value +- this fraction. */
export const UNSET_RANGE_FRACTION = 0.1;

/**
 * The step and scheme of each variable. `feasible(name, x)` says whether the
 * design with that one value changed is allowed (ranges that depend on other
 * variables, a feature that would no longer fit): central when both sides are,
 * else one-sided toward the side that is.
 */
export function planSteps(
  variables: SensitivityVariable[],
  stepFraction: number,
  feasible: (name: string, x: number) => boolean,
  /** Multiplies every step: 2 for the step check. */
  scale = 1,
): { steps: StepPlan[]; skipped: SkippedVariable[] } {
  if (!(stepFraction > 0 && stepFraction < 0.5)) throw new Error(`the step must be between 0 and 50 % of the range, got ${100 * stepFraction} %`);
  const steps: StepPlan[] = [];
  const skipped: SkippedVariable[] = [];
  for (const v of variables) {
    const span = v.max - v.min;
    const h = scale * Math.max(stepFraction * span, v.minStep);
    if (!(span > 0)) {
      skipped.push({ name: v.name, reason: v.rangeSet ? 'its range is empty at this design' : 'it has no range in the project and its value is 0, so value +-10 % is empty; give it a min and max' });
      continue;
    }
    const ok = (x: number) => x >= v.min - 1e-9 && x <= v.max + 1e-9 && feasible(v.name, x);
    const x = v.value;
    const plan: StepPlan | null = ok(x - h) && ok(x + h) ? { variable: v, h, scheme: 'central', at: [x - h, x + h] }
      : ok(x + h) && ok(x + 2 * h) ? { variable: v, h, scheme: 'forward', at: [x + h, x + 2 * h] }
      : ok(x - h) && ok(x - 2 * h) ? { variable: v, h, scheme: 'backward', at: [x - h, x - 2 * h] }
      : null;
    if (plan) steps.push(plan);
    else skipped.push({ name: v.name, reason: `no room for a ${round(h, 3)} ${v.unit} step either side within its range at this design` });
  }
  return { steps, skipped };
}

/** One solve's numbers by metric key; null where the metric does not exist (solve failed, no dip). */
export type Metrics = Record<string, number | null>;

export interface MetricInfo {
  key: string;
  label: string;
  unit: string;
}

export interface Slope {
  /** Change of the metric per unit of the variable. */
  perUnit: number;
  /** Half the difference of the two one-sided slopes, same unit: see the file comment. */
  spread: number;
  /** perUnit times the range: the change across the whole range, as a linear estimate. */
  acrossRange: number;
  /** See the file comment. */
  grade: SlopeGrade;
  /** With the step check: |slope at h - slope at 2h| / 3, the second-order estimate of the slope's own step error. */
  stepError?: number;
  /** The curvature the spread implies would bend the response across the range by more than a quarter of acrossRange. */
  curved: boolean;
}

export type SlopeGrade = 'clean' | 'sign only' | 'unresolved';

/** A slope is clean when its two one-sided slopes agree within this fraction of it. */
export const CLEAN_SPREAD_FRACTION = 0.25;

export function gradeOf(perUnit: number, spread: number): SlopeGrade {
  if (spread <= CLEAN_SPREAD_FRACTION * Math.abs(perUnit)) return 'clean';
  return spread < Math.abs(perUnit) ? 'sign only' : 'unresolved';
}

export interface SensitivityRow {
  variable: SensitivityVariable;
  h: number;
  scheme: Scheme;
  /** By metric key; null when a solve of the three gave no value. */
  slopes: Record<string, Slope | null>;
  notes: string[];
}

/** Slope and spread from the base value and the two extra solves, in the order of `at`. */
export function slopeOf(scheme: Scheme, h: number, f0: number, fa: number, fb: number): { perUnit: number; spread: number } {
  if (scheme === 'central') {
    const [below, above] = [(f0 - fa) / h, (fb - f0) / h];
    return { perUnit: (fb - fa) / (2 * h), spread: Math.abs(above - below) / 2 };
  }
  // One-sided, with sign s: points at x + s h and x + 2 s h.
  const s = scheme === 'forward' ? 1 : -1;
  const [near, far] = [(fa - f0) / (s * h), (fb - fa) / (s * h)];
  return { perUnit: (-3 * f0 + 4 * fa - fb) / (2 * s * h), spread: Math.abs(far - near) / 2 };
}

/**
 * The rows, one per planned variable. `perturbed[k]` holds the metrics at
 * steps[k].at, `cells` (when given) the grid sizes at the base and at each,
 * so a step that changed the mesh says so.
 */
export function analyse(
  steps: StepPlan[],
  metrics: MetricInfo[],
  base: Metrics,
  perturbed: Array<[Metrics, Metrics]>,
  cells?: { base: number | undefined; perturbed: Array<[number | undefined, number | undefined]> },
): SensitivityRow[] {
  return steps.map((step, k) => {
    const [a, b] = perturbed[k];
    const span = step.variable.max - step.variable.min;
    const slopes = Object.fromEntries(metrics.map(({ key }) => {
      const [f0, fa, fb] = [base[key], a[key], b[key]];
      if (f0 === null || fa === null || fb === null || f0 === undefined || fa === undefined || fb === undefined) return [key, null];
      const { perUnit, spread } = slopeOf(step.scheme, step.h, f0, fa, fb);
      const acrossRange = perUnit * span;
      const curvature = (2 * spread) / step.h; // |f''| from the spread, h |f''| / 2
      const curved = (curvature * span * span) / 8 > 0.25 * Math.abs(acrossRange);
      return [key, { perUnit, spread, acrossRange, grade: gradeOf(perUnit, spread), curved }];
    }));
    const notes: string[] = [];
    if (step.scheme !== 'central') notes.push(`one-sided (${step.scheme}): ${step.scheme === 'forward' ? 'x - h' : 'x + h'} is outside the range or refused by a range that depends on it`);
    if (!step.variable.rangeSet) notes.push(`the project gives no ${missingBounds(step.variable)}: taken at the value ${missingBounds(step.variable) === 'range' ? '' : 'on that side '}+-${100 * UNSET_RANGE_FRACTION} %`);
    if (cells) {
      const [ca, cb] = cells.perturbed[k];
      if (cells.base !== undefined && ca !== undefined && cb !== undefined && (ca !== cells.base || cb !== cells.base)) {
        notes.push(`the mesh changed with the step (${[cells.base, ca, cb].map((c) => c.toLocaleString('en-US')).join(', ')} cells)`);
      }
    }
    return { variable: step.variable, h: step.h, scheme: step.scheme, slopes, notes };
  });
}

/**
 * The rows by |change across the range| of one metric, largest first, within
 * grades: clean slopes, then sign-only, then unresolved, then rows without the
 * metric. A jump within the step reads as a huge slope and must never top the list.
 */
export function rankBy(rows: SensitivityRow[], metric: string): SensitivityRow[] {
  const key = (r: SensitivityRow): [number, number] => {
    const slope = r.slopes[metric];
    return slope ? [GRADE_ORDER[slope.grade], Math.abs(slope.acrossRange)] : [3, 0];
  };
  return [...rows].sort((p, q) => {
    const [[gp, sp], [gq, sq]] = [key(p), key(q)];
    return gp - gq || sq - sp;
  });
}

/**
 * The step check: the same study at twice the step. Both slopes are second
 * order, d(h) = d + c h^2, so |d(h) - d(2h)| / 3 estimates the error of d(h),
 * which the spread cannot see. A clean slope whose step error passes 25 % of
 * it is downgraded like one whose spread does. Rows are matched by variable.
 */
export function applyStepCheck(rows: SensitivityRow[], doubled: SensitivityRow[]): void {
  for (const row of rows) {
    const twin = doubled.find((r) => r.variable.name === row.variable.name && r.scheme === row.scheme);
    if (!twin) {
      row.notes.push('no step check: twice the step does not fit the range the same way');
      continue;
    }
    for (const [key, slope] of Object.entries(row.slopes)) {
      const other = twin.slopes[key];
      if (!slope || !other) continue;
      slope.stepError = Math.abs(slope.perUnit - other.perUnit) / 3;
      const byStep = gradeOf(slope.perUnit, slope.stepError);
      if (GRADE_ORDER[byStep] > GRADE_ORDER[slope.grade]) slope.grade = byStep;
    }
  }
}

const GRADE_ORDER: Record<SlopeGrade, number> = { clean: 0, 'sign only': 1, unresolved: 2 };

function missingBounds(v: SensitivityVariable): string {
  return v.minSet && !v.maxSet ? 'max' : v.maxSet && !v.minSet ? 'min' : 'range';
}

function round(x: number, digits: number): number {
  return Number(x.toFixed(digits));
}
