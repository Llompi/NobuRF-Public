/** Test helpers: an analytic stand-in for the FDTD solver, shared by the design-loop tests. */
import { resolveProject } from '../src/project/resolve';
import type { Project } from '../src/project/schema';
import type { Evaluation, Evaluator, LiveFrame, LiveOptions } from '../src/design/evaluate';
import { metricsFromSpectrum, type DesignGoal } from '../src/design/goal';

/** A resonance: S11 dips to `depthDb` at f0 with a fractional half-width `q`. */
export function lorentzian(f0: number, depthDb: number, q = 0.02) {
  const fGHz = Float64Array.from({ length: 301 }, (_, k) => 4.5 + (3 * k) / 300);
  const gMin2 = 10 ** (depthDb / 10);
  const s11Db = fGHz.map((f) => 10 * Math.log10(1 - (1 - gMin2) / (1 + ((f - f0) / (q * f0)) ** 2)));
  return { fGHz, s11Db };
}

/**
 * An analytic stand-in for the solver: the resonance falls with patch_l and
 * with a slot, the match depends on the inset depth. Qualitative only.
 * With `live`, watched solves run one at a time and stream four frames each
 * (the final numbers, at 25 % steps apart), and stopCurrent ends one early.
 */
export function surrogateEvaluator(goal: DesignGoal, solveDelayMs = 0, live?: LiveOptions): Evaluator & { count: number } {
  let count = 0;
  const evaluateOne = (project: Project): Evaluation => {
    count++;
    const v = resolveProject(project).variables;
    const ids = project.geometry.top.map((s) => s.id);
    const slot = ids.includes('slot') ? 0.45 * v.slot_l.value : 0;
    const f0 = 68 / (v.patch_l.value + slot);
    const depth = ids.includes('inset_left') ? -6 - 20 / (1 + ((v.inset_d.value - 3.2) / 0.8) ** 2) : -6;
    const spec = lorentzian(f0, depth);
    return { metrics: metricsFromSpectrum(spec, goal), spectrum: { fGHz: Array.from(spec.fGHz), s11Db: Array.from(spec.s11Db) }, steps: 1000, solveMs: 1, warnings: [] };
  };
  let started = 0;
  let current: { frame: LiveFrame | null; reason: string | null } | null = null;
  const watched = async (project: Project): Promise<Evaluation> => {
    const full = evaluateOne(project);
    const me = { frame: null as LiveFrame | null, reason: null as string | null };
    current = me;
    const solve = ++started;
    try {
      for (let k = 1; k <= 4; k++) {
        await new Promise((r) => setTimeout(r, solveDelayMs / 4));
        if (me.reason !== null && me.frame) {
          return { ...full, steps: me.frame.stepsDone, warnings: [`stopped early: ${me.reason}`], stoppedEarly: { steps: me.frame.stepsDone, energyDecayDb: me.frame.energyDecayDb, reason: me.reason } };
        }
        if (k < 4) {
          me.frame = { solve, stepsDone: 250 * k, energyDecayDb: 10 * k, metrics: full.metrics, spectrum: full.spectrum };
          live!.onFrame(me.frame);
        }
      }
      return full;
    } finally {
      current = null;
    }
  };
  return {
    get count() { return count; },
    evaluateAll: async (projects, opts) => {
      if (live && opts?.watch) {
        const out: Array<PromiseSettledResult<Evaluation>> = [];
        for (const p of projects) out.push({ status: 'fulfilled', value: await watched(p) });
        return out;
      }
      if (solveDelayMs) await new Promise((r) => setTimeout(r, solveDelayMs));
      return projects.map((p) => ({ status: 'fulfilled' as const, value: evaluateOne(p) }));
    },
    stopCurrent: (reason) => {
      if (!current?.frame || current.reason !== null) return false;
      current.reason = reason;
      return true;
    },
    solves: 0,
    solveMs: 0,
    close: async () => {},
  };
}
