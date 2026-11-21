/**
 * Nelder-Mead on the unit box [0, 1]^n (Lagarias et al., SIAM J. Optim. 9(1),
 * 1998: reflection 1, expansion 2, contraction 1/2, shrink 1/2). Points
 * outside the box are clamped onto it. The objective takes a batch, so the
 * initial simplex and a shrink are solved in parallel; the other steps need
 * one point at a time.
 */
export interface NelderMeadOptions {
  /** Objective evaluations allowed, including the initial simplex. */
  maxEvaluations: number;
  /** Initial simplex edge, in box units. */
  initialStep?: number;
  /** Stop when every vertex is within this of the best, in box units. */
  tolerance?: number;
  /** Stop as soon as a value at or below this is found (the goal is met). */
  stopAt?: number;
}

export interface NelderMeadResult {
  best: number[];
  value: number;
  evaluations: number;
  reason: 'goal' | 'converged' | 'budget';
}

export type BatchObjective = (points: number[][]) => Promise<number[]>;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export async function nelderMead(objective: BatchObjective, start: number[], options: NelderMeadOptions): Promise<NelderMeadResult> {
  const n = start.length;
  const step = options.initialStep ?? 0.15;
  const tolerance = options.tolerance ?? 0.005;
  const stopAt = options.stopAt ?? -Infinity;
  let evaluations = 0;

  const x0 = start.map(clamp01);
  // Each initial vertex steps one coordinate, inward when the start sits near the top of the box.
  const initial = [x0, ...x0.map((_, k) => x0.map((x, m) => (m === k ? (x + step <= 1 ? x + step : x - step) : x)))];
  if (initial.length > options.maxEvaluations) throw new Error(`Nelder-Mead in ${n} dimensions needs at least ${n + 1} evaluations`);

  const evaluate = async (points: number[][]) => {
    evaluations += points.length;
    return objective(points);
  };
  const values = await evaluate(initial);
  let simplex = initial.map((x, k) => ({ x, f: values[k] }));

  const done = (): NelderMeadResult['reason'] | null => {
    simplex.sort((a, b) => a.f - b.f);
    if (simplex[0].f <= stopAt) return 'goal';
    const spread = Math.max(...simplex.slice(1).map((v) => Math.max(...v.x.map((x, k) => Math.abs(x - simplex[0].x[k])))));
    if (spread <= tolerance) return 'converged';
    if (evaluations >= options.maxEvaluations) return 'budget';
    return null;
  };
  const along = (from: number[], to: number[], t: number) => from.map((x, k) => clamp01(x + t * (to[k] - x)));
  const one = async (x: number[]) => ({ x, f: (await evaluate([x]))[0] });

  let reason: NelderMeadResult['reason'] | null;
  while (!(reason = done())) {
    const worst = simplex[n];
    const centroid = Array.from({ length: n }, (_, k) => simplex.slice(0, n).reduce((s, v) => s + v.x[k], 0) / n);
    const r = await one(along(centroid, worst.x, -1));
    if (r.f < simplex[0].f) {
      if (evaluations >= options.maxEvaluations) {
        simplex[n] = r;
        continue;
      }
      const e = await one(along(centroid, worst.x, -2));
      simplex[n] = e.f < r.f ? e : r;
      continue;
    }
    if (r.f < simplex[n - 1].f) {
      simplex[n] = r;
      continue;
    }
    if (evaluations >= options.maxEvaluations) continue; // done() reports the budget
    // Contract: outside when the reflection beat the worst, inside otherwise.
    const outside = r.f < worst.f;
    const c = await one(along(centroid, worst.x, outside ? -0.5 : 0.5));
    if (c.f < (outside ? r.f : worst.f)) {
      simplex[n] = c;
      continue;
    }
    if (evaluations + n > options.maxEvaluations) {
      if (outside) simplex[n] = r;
      break;
    }
    const best = simplex[0];
    const shrunk = simplex.slice(1).map((v) => along(best.x, v.x, 0.5));
    const fs = await evaluate(shrunk);
    simplex = [best, ...shrunk.map((x, k) => ({ x, f: fs[k] }))];
  }
  simplex.sort((a, b) => a.f - b.f);
  return { best: simplex[0].x, value: simplex[0].f, evaluations, reason: reason ?? 'budget' };
}
