import { ProjectError, type Project } from '../project/schema';
import { projectFor, startPoint, tunableVariables, variableBounds, type DesignFile, type DesignPoint, type Fidelity } from './design_file';
import type { Evaluation, Evaluator } from './evaluate';
import { goalMet, goalScore, metricsFromSpectrum, type DesignGoal, type DesignMetrics } from './goal';
import { nelderMead } from './nelder_mead';
import { resolveProject } from '../project/resolve';
import {
  analyse, applyStepCheck, DEFAULT_STEP_FRACTION, planSteps, rankBy, UNSET_RANGE_FRACTION,
  type MetricInfo, type Metrics, type SensitivityRow, type SensitivityVariable, type SkippedVariable,
} from './sensitivity';

/** Score of a point the project refuses (outside a range that depends on another variable) or the solver fails on. */
const INFEASIBLE_SCORE = 1000;
/** Variables one optimise call may move. More than this and the simplex needs more solves than a session has. */
const MAX_FREE_VARIABLES = 4;

export interface SessionLimits {
  /** Search-mesh solves for the whole session. */
  maxSearchSolves: number;
  /** Confirm-mesh solves for the whole session. */
  maxConfirmSolves: number;
}

/** One solved point, as the journal and the final report see it. */
export interface SolveRecord {
  fidelity: Fidelity;
  point: DesignPoint;
  metrics: DesignMetrics | null;
  score: number;
  error?: string;
  warnings?: string[];
  /** Grid cells of the solve, when the evaluator reports them. */
  cells?: number;
}

/** What `sensitivity` finds: the ranked rows and what it could not step. */
export interface SensitivityReport {
  fidelity: Fidelity;
  rankBy: string;
  metrics: MetricInfo[];
  base: SolveRecord;
  rows: SensitivityRow[];
  skipped: SkippedVariable[];
  /** Fresh solves this study cost (repeats of a solved design are free). */
  solves: number;
  /** The study was repeated at twice the step (applyStepCheck). */
  stepChecked: boolean;
}

export type SessionEvent =
  | { type: 'solve'; record: SolveRecord }
  | { type: 'tool'; name: string; args: unknown; result: unknown; ms: number };

const round = (x: number, digits = 3) => Number(x.toFixed(digits));

/** The numbers the strategist reads, rounded so they cost few tokens. */
function metricsView(m: DesignMetrics) {
  return {
    f0_ghz: round(m.f0_ghz),
    s11_at_target_db: round(m.s11_at_target_db, 1),
    s11_min_db: round(m.s11_min_db, 1),
    bandwidth_mhz: Math.round(m.bandwidth_mhz),
    ...(m.bandwidth_open ? { bandwidth_open: true } : {}),
    ...(m.axial_ratio_db !== undefined ? { axial_ratio_db: round(m.axial_ratio_db, 1), sense: m.polarisation_sense } : {}),
  };
}

/** Tool schemas in the OpenAI function-calling format (also served over MCP). */
export const DESIGN_TOOLS = [
  {
    name: 'try_design',
    description: 'Switch features on or off and/or set variables (mm), then solve once on the search mesh. Unspecified values stay as they are.',
    parameters: {
      type: 'object',
      properties: {
        enable: { type: 'array', items: { type: 'string' }, description: 'The complete list of features that should be on.' },
        values: { type: 'object', additionalProperties: { type: 'number' }, description: 'Variable name to length in mm.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sweep',
    description: 'Solve the current design at evenly spaced values of one variable (search mesh, in parallel). Does not change the current design.',
    parameters: {
      type: 'object',
      properties: {
        variable: { type: 'string' },
        from_mm: { type: 'number' },
        to_mm: { type: 'number' },
        points: { type: 'integer', minimum: 2, maximum: 8 },
      },
      required: ['variable', 'from_mm', 'to_mm', 'points'],
      additionalProperties: false,
    },
  },
  {
    name: 'optimise',
    description: 'Run a Nelder-Mead search on the search mesh over 1 to 4 free variables, within their ranges, from the current design. ' +
      'The current design becomes the best point found. aim_ghz / aim_s11_db replace the goal for this search only ' +
      '(for example to aim off a known search-mesh offset, or for margin).',
    parameters: {
      type: 'object',
      properties: {
        enable: { type: 'array', items: { type: 'string' }, description: 'Features that should be on (default: unchanged).' },
        free: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_FREE_VARIABLES },
        max_solves: { type: 'integer', minimum: 2 },
        aim_ghz: { type: 'number' },
        aim_s11_db: { type: 'number' },
      },
      required: ['free', 'max_solves'],
      additionalProperties: false,
    },
  },
  {
    name: 'sensitivity',
    description: 'Rank the live variables by how much they move each result at the current design: two extra search solves per variable ' +
      '(central differences, one-sided at a bound; step 2 % of the range, at least the mesh resolution; a variable with no room is skipped). ' +
      'Each slope comes with a spread and a grade: clean, sign only (direction known, size not), or unresolved (turns or jumps within the step); ' +
      'curved means the across-range figure is a poor linear estimate. Rows rank clean first. Use it to choose which variables to free. ' +
      'Does not change the current design.',
    parameters: {
      type: 'object',
      properties: {
        variables: { type: 'array', items: { type: 'string' }, description: 'Default: every live variable.' },
        rank_by: { type: 'string', enum: ['f0_mhz', 's11_target_db', 'zin_target_ohm', 's11_min_db'], description: 'Default f0_mhz.' },
        check_step: { type: 'boolean', description: 'Also solve at twice the step (doubles the cost) and downgrade slopes that change with the step.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'confirm',
    description: 'Solve the current design on the fine confirm mesh: the number that counts. Slow; limited.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'finish',
    description: 'End the session with a short engineering summary: what you tried, why, and the result.',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof DESIGN_TOOLS)[number]['name'];

/** Thrown for a tool call the strategist got wrong: the message goes back to it as the tool result. */
export class ToolInputError extends Error {}

/**
 * A design session: the current design point, the solves so far, and the
 * tools the strategist drives it with. The strategist chooses features,
 * which variables to free, ranges and aims; Nelder-Mead does the search.
 */
export class DesignSession {
  current: DesignPoint;
  readonly records: SolveRecord[] = [];
  finished: { summary: string } | null = null;
  private confirmSolves = 0;
  /** The result of the last optimise when it aimed off the target frequency (a measured mesh offset), else null. */
  private aimedPoint: DesignPoint | null = null;
  /** Every project solved so far (both meshes), by its JSON text: a repeat costs no solve and no budget. */
  private readonly solved = new Map<string, Evaluation | Error>();

  constructor(
    readonly design: DesignFile,
    private readonly evaluator: Evaluator,
    readonly limits: SessionLimits,
    private readonly onEvent: (e: SessionEvent) => void = () => {},
  ) {
    this.current = startPoint(design);
  }

  get goal(): DesignGoal {
    return this.design.goal;
  }

  get searchSolvesLeft(): number {
    return this.limits.maxSearchSolves - this.records.filter((r) => r.fidelity === 'search').length;
  }

  /**
   * Search solves held back until the first confirm, so a strategist that
   * spends freely can still re-aim once after the fine mesh disagrees: about
   * one search's worth (8 of 60), none when no confirm is left.
   */
  get searchReserve(): number {
    const confirmed = this.records.some((r) => r.fidelity === 'confirm');
    return confirmed || this.confirmSolvesLeft <= 0 ? 0 : Math.min(8, Math.floor(this.limits.maxSearchSolves / 6));
  }

  /** Search solves a tool may spend now: what is left, less the reserve. */
  get searchSolvesFree(): number {
    return Math.max(0, this.searchSolvesLeft - this.searchReserve);
  }

  get confirmSolvesLeft(): number {
    return this.limits.maxConfirmSolves - this.confirmSolves;
  }

  /** The opening message: goal, features, variables with their ranges, and the budget. */
  brief() {
    const project = this.projectOrThrow(this.current, 'confirm');
    const featureOf = new Map(Object.entries(this.design.features).flatMap(([f, def]) => def.variables.map((v) => [v, f] as const)));
    const variables = Object.fromEntries(tunableVariables(project).map((name) => {
      const feature = featureOf.get(name);
      const entry = { mm: round(this.current.values[name]), range: rangeText(this.design, name), feature: feature ?? 'base' };
      // Ranges resolve only for live variables; an off feature's range applies once it is switched on.
      if (feature && !this.current.enabled.includes(feature)) return [name, entry];
      const { min, max } = variableBounds(project, name);
      return [name, { ...entry, min_mm: round(min), max_mm: round(max) }];
    }));
    const locked = Object.fromEntries(Object.entries(project.variables).filter(([, v]) => v.locked).map(([n, v]) => [n, v.value]));
    return {
      goal: this.goal,
      features: Object.fromEntries(Object.entries(this.design.features).map(([name, f]) => [name, f.what])),
      enabled: this.current.enabled,
      variables,
      locked,
      stackup: project.stackup.map((l) => (l.type === 'dielectric' ? `${l.name}: ${l.material} ${l.thickness}` : `${l.name}: ${l.material}`)),
      budget: {
        search_solves: this.searchSolvesLeft,
        confirm_solves: this.confirmSolvesLeft,
        ...(this.searchReserve ? { search_solves_held_until_first_confirm: this.searchReserve } : {}),
      },
      meshes: 'search: coarse graded mesh, fast, can sit a percent or two off the confirm mesh; confirm: the fine mesh, the result that counts',
    };
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const t0 = performance.now();
    let result: unknown;
    try {
      if (this.finished) throw new ToolInputError('the session has finished; start a new one to keep designing');
      switch (name as ToolName) {
        case 'try_design': result = await this.tryDesign(args); break;
        case 'sweep': result = await this.sweep(args); break;
        case 'optimise': result = await this.optimise(args); break;
        case 'sensitivity': result = sensitivityView(await this.sensitivity(args, 'search'), this.searchSolvesLeft); break;
        case 'confirm': result = await this.confirm(); break;
        case 'finish': result = this.finish(args); break;
        default: throw new ToolInputError(`no tool "${name}"`);
      }
    } catch (e) {
      if (!(e instanceof ToolInputError || e instanceof ProjectError)) throw e;
      result = { error: e.message };
    }
    this.onEvent({ type: 'tool', name, args, result, ms: Math.round(performance.now() - t0) });
    return result;
  }

  private async tryDesign(args: Record<string, unknown>) {
    const point = this.pointWith(args.enable, args.values);
    const [record] = await this.solve([point], 'search', this.goal);
    if (record.error) return { error: record.error };
    this.current = point;
    return this.pointView(record);
  }

  private async sweep(args: Record<string, unknown>) {
    const variable = this.live(this.tunable(args.variable), this.current.enabled);
    const [from, to, points] = [num(args.from_mm, 'from_mm'), num(args.to_mm, 'to_mm'), num(args.points, 'points')];
    if (!Number.isInteger(points) || points < 2 || points > 8) throw new ToolInputError('points must be an integer from 2 to 8');
    this.requireSearchSolves(points);
    const xs = Array.from({ length: points }, (_, k) => from + ((to - from) * k) / (points - 1));
    const records = await this.solve(xs.map((x) => ({ ...this.current, values: { ...this.current.values, [variable]: x } })), 'search', this.goal);
    return {
      variable,
      rows: records.map((r, k) => ({ mm: round(xs[k]), ...(r.metrics ? metricsView(r.metrics) : { error: r.error }), score: round(r.score, 2) })),
      search_solves_left: this.searchSolvesLeft,
    };
  }

  private async optimise(args: Record<string, unknown>) {
    const start = this.pointWith(args.enable, undefined);
    if (!Array.isArray(args.free) || args.free.length < 1 || args.free.length > MAX_FREE_VARIABLES) {
      throw new ToolInputError(`free must list 1 to ${MAX_FREE_VARIABLES} variables`);
    }
    const free = args.free.map((v) => this.live(this.tunable(v), start.enabled));
    const maxSolves = Math.min(num(args.max_solves, 'max_solves'), this.searchSolvesFree);
    if (maxSolves < free.length + 1) throw new ToolInputError(`${free.length} free variables need at least ${free.length + 1} solves; ${this.budgetText()}`);
    const aim: DesignGoal = {
      ...this.goal,
      ...(args.aim_ghz !== undefined ? { target_ghz: this.aimInBand(num(args.aim_ghz, 'aim_ghz')) } : {}),
      ...(args.aim_s11_db !== undefined ? { s11_max_db: num(args.aim_s11_db, 'aim_s11_db') } : {}),
    };
    // Box bounds from the ranges at the start point; ranges that depend on a moving variable are caught per point.
    const startProject = this.projectOrThrow(start, 'search');
    const bounds = free.map((v) => variableBounds(startProject, v));
    const toPoint = (u: number[]): DesignPoint => ({
      ...start,
      values: { ...start.values, ...Object.fromEntries(free.map((v, k) => [v, bounds[k].min + u[k] * (bounds[k].max - bounds[k].min)])) },
    });
    const u0 = free.map((v, k) => (bounds[k].max > bounds[k].min ? (start.values[v] - bounds[k].min) / (bounds[k].max - bounds[k].min) : 0));
    const result = await nelderMead(async (us) => (await this.solve(us.map(toPoint), 'search', aim)).map((r) => r.score), u0, {
      maxEvaluations: maxSolves,
      stopAt: 0,
    });
    const best = toPoint(result.best);
    const [record] = await this.solve([best], 'search', this.goal); // cached: re-scored against the real goal
    if (!record.metrics) return { stop: result.reason, solves: result.evaluations, error: `no point solved: ${record.error}` };
    this.current = best;
    this.aimedPoint = aim.target_ghz !== this.goal.target_ghz ? best : null;
    const atBound = free.flatMap((v, k) => {
      const x = best.values[v];
      const span = bounds[k].max - bounds[k].min;
      if (x <= bounds[k].min + 0.01 * span) return [`${v} at its min ${round(bounds[k].min)} mm`];
      if (x >= bounds[k].max - 0.01 * span) return [`${v} at its max ${round(bounds[k].max)} mm`];
      return [];
    });
    return {
      stop: result.reason === 'goal' ? 'aim met' : result.reason,
      solves: result.evaluations,
      ...this.pointView(record),
      ...(atBound.length ? { at_bound: atBound } : {}),
    };
  }

  /**
   * Finite-difference slopes of the results with respect to each live variable
   * at the current design (sensitivity.ts), ranked. Search fidelity costs
   * search solves; the command line may ask for the confirm mesh.
   * args: variables (default all live), rank_by (a metric key), step_pct (default 2).
   */
  async sensitivity(args: Record<string, unknown>, fidelity: Fidelity): Promise<SensitivityReport> {
    const point = this.current;
    const baseProject = this.projectOrThrow(point, fidelity);
    if (baseProject.ports.length !== 1) throw new ToolInputError(`the sensitivity study reads one port's S11 and Z_in; this project has ${baseProject.ports.length} ports`);
    const live = tunableVariables(baseProject).filter((v) => Object.hasOwn(point.values, v) && this.isLive(v, point.enabled));
    let names = live;
    if (args.variables !== undefined) {
      if (!Array.isArray(args.variables) || args.variables.length === 0) throw new ToolInputError('variables must list one or more variable names');
      names = [...new Set(args.variables.map((v) => this.live(this.tunable(v), point.enabled)))];
    }
    const metrics = this.sensitivityMetrics();
    const rankKey = args.rank_by === undefined ? 'f0_mhz' : String(args.rank_by);
    if (!metrics.some((m) => m.key === rankKey)) throw new ToolInputError(`rank_by must be one of: ${metrics.map((m) => m.key).join(', ')}`);
    const stepFraction = args.step_pct === undefined ? DEFAULT_STEP_FRACTION : num(args.step_pct, 'step_pct') / 100;
    const resolved = resolveProject(baseProject);
    // Graded: lines follow the copper edges. Uniform: edges snap to cells and a centred size moves each edge by half its change.
    const minStep = resolved.graded ? resolved.graded.edgeCellMm : 2 * resolved.cellMm;
    const variables: SensitivityVariable[] = names.map((name) => {
      const value = point.values[name];
      const def = baseProject.variables[name];
      const bounds = variableBounds(baseProject, name);
      const [minSet, maxSet] = [def.min !== undefined, def.max !== undefined];
      const spread = UNSET_RANGE_FRACTION * Math.abs(value);
      return {
        name, value, minSet, maxSet, rangeSet: minSet && maxSet, unit: 'mm', minStep,
        min: def.min !== undefined ? bounds.min : value - spread,
        max: def.max !== undefined ? bounds.max : value + spread,
      };
    });
    const at = (name: string, x: number): DesignPoint => ({ ...point, values: { ...point.values, [name]: x } });
    const feasible = (name: string, x: number) => {
      try {
        this.projectOrThrow(at(name, x), fidelity);
        return true;
      } catch {
        return false;
      }
    };
    let stepped;
    try {
      stepped = planSteps(variables, stepFraction, feasible);
    } catch (e) {
      throw new ToolInputError((e as Error).message);
    }
    const { steps, skipped } = stepped;
    const checkStep = args.check_step === true;
    const doubled = checkStep ? planSteps(variables, stepFraction, feasible, 2).steps : [];
    const before = this.records.length;
    // One batch, so every solve runs in parallel where the evaluator allows.
    const points = (plans: typeof steps) => plans.flatMap((s) => s.at.map((x) => at(s.variable.name, x)));
    const records = await this.solve([point, ...points(steps), ...points(doubled)], fidelity, this.goal);
    const [base, ...rest] = records;
    const rowsOf = (plans: typeof steps, offset: number) => {
      const pairs = plans.map((_, k) => [rest[offset + 2 * k], rest[offset + 2 * k + 1]] as const);
      const rows = analyse(
        plans, metrics, metricsOf(base), pairs.map(([a, b]) => [metricsOf(a), metricsOf(b)]),
        { base: base.cells, perturbed: pairs.map(([a, b]) => [a.cells, b.cells]) },
      );
      for (const [k, [a, b]] of pairs.entries()) {
        for (const r of [a, b]) if (r.error) rows[k].notes.push(`a solve failed: ${r.error}`);
      }
      return rows;
    };
    const rows = rowsOf(steps, 0);
    if (checkStep) applyStepCheck(rows, rowsOf(doubled, 2 * steps.length));
    return { fidelity, rankBy: rankKey, metrics, base, rows: rankBy(rows, rankKey), skipped, solves: this.records.length - before, stepChecked: checkStep };
  }

  /** The metrics a sensitivity study reports: resonance and match always, the goal's optional terms when it has them. */
  private sensitivityMetrics(): MetricInfo[] {
    const at = `${this.goal.target_ghz} GHz`;
    return [
      { key: 'f0_mhz', label: 'Resonance', unit: 'MHz' },
      { key: 's11_target_db', label: `S11 at ${at}`, unit: 'dB' },
      { key: 'zin_target_ohm', label: `|Z_in| at ${at}`, unit: 'ohm' },
      { key: 's11_min_db', label: 'Dip depth', unit: 'dB' },
      ...(this.goal.min_bandwidth_mhz ? [{ key: 'bandwidth_mhz', label: '-10 dB bandwidth', unit: 'MHz' }] : []),
      ...(this.goal.max_axial_ratio_db !== undefined ? [{ key: 'axial_ratio_db', label: `Axial ratio at ${at}`, unit: 'dB' }] : []),
    ];
  }

  private async confirm() {
    if (this.confirmSolves >= this.limits.maxConfirmSolves) throw new ToolInputError('no confirm solves left');
    this.confirmSolves++;
    const [record] = await this.solve([this.current], 'confirm', this.goal);
    if (record.error) return { error: record.error };
    const search = this.records.find((r) => r.fidelity === 'search' && r.metrics && this.samePoint(r.point, this.current));
    return {
      ...this.pointView(record),
      ...(search?.metrics ? { search_mesh_f0_ghz: round(search.metrics.f0_ghz) } : {}),
      confirm_solves_left: this.confirmSolvesLeft,
    };
  }

  /**
   * The harness's own last step, after the strategist stops: when no confirmed
   * design meets the goal, confirm the best search design that was never
   * confirmed, if a confirm solve is left. A strategist that spends the search
   * budget and stops without confirming still gets its best design checked.
   * Returns the confirm result, or null when there was nothing to do.
   */
  async closingConfirm() {
    if (this.bestConfirmed()?.score === 0 || this.confirmSolvesLeft <= 0) return null;
    const confirmed = this.records.filter((r) => r.fidelity === 'confirm');
    const unconfirmed = this.records.filter((r) => r.fidelity === 'search' && r.metrics && !confirmed.some((c) => this.samePoint(c.point, r.point)));
    // An aimed result first: aimed off a measured mesh offset, it scores badly on the search mesh by intent.
    const aimed = this.aimedPoint;
    const best = (aimed && unconfirmed.find((r) => this.samePoint(r.point, aimed))) || unconfirmed.sort((a, b) => a.score - b.score)[0];
    if (!best) return null;
    this.current = best.point;
    return this.confirm();
  }

  private finish(args: Record<string, unknown>) {
    if (typeof args.summary !== 'string' || !args.summary.trim()) throw new ToolInputError('summary must be a non-empty string');
    this.finished = { summary: args.summary.trim() };
    return { ok: true };
  }

  /** The best design that met the goal on the confirm mesh, else the best confirmed, else null. */
  bestConfirmed(): SolveRecord | null {
    const confirmed = this.records.filter((r) => r.fidelity === 'confirm' && r.metrics);
    return confirmed.sort((a, b) => a.score - b.score)[0] ?? null;
  }

  private async solve(points: DesignPoint[], fidelity: Fidelity, scoreGoal: DesignGoal): Promise<SolveRecord[]> {
    // A point the project refuses is an Error here; the rest are keyed by their project text.
    const keyed = points.map((p) => {
      try {
        return JSON.stringify(this.projectOrThrow(p, fidelity));
      } catch (e) {
        return e as Error;
      }
    });
    const fresh = [...new Set(keyed.filter((k): k is string => typeof k === 'string' && !this.solved.has(k)))];
    if (fidelity === 'search') this.requireSearchSolves(fresh.length);
    const settled = await this.evaluator.evaluateAll(fresh.map((k) => JSON.parse(k) as Project));
    fresh.forEach((key, n) => {
      const s = settled[n];
      const outcome = s.status === 'fulfilled' ? s.value : new Error(`solver failed: ${(s.reason as Error).message}`);
      this.solved.set(key, outcome);
      const point = points[keyed.indexOf(key)];
      // Each solve is journaled once, scored against the real goal (the optimiser may be aiming elsewhere).
      const record = recordOf(fidelity, point, outcome, this.goal);
      this.records.push(record);
      this.onEvent({ type: 'solve', record });
    });
    return points.map((point, k) => {
      const key = keyed[k];
      if (key instanceof Error) return { fidelity, point, metrics: null, score: INFEASIBLE_SCORE, error: `refused: ${key.message}` };
      return recordOf(fidelity, point, this.solved.get(key)!, scoreGoal);
    });
  }

  private aimInBand(ghz: number): number {
    const { f_min_ghz: lo, f_max_ghz: hi } = this.design.project.analysis;
    if (!(ghz > lo && ghz < hi)) throw new ToolInputError(`aim_ghz must lie inside the analyzed band, ${lo} to ${hi} GHz`);
    return ghz;
  }

  private requireSearchSolves(n: number) {
    if (n > this.searchSolvesFree) throw new ToolInputError(`needs ${n} search solves, ${this.budgetText()}`);
  }

  private budgetText(): string {
    const held = this.searchReserve;
    return held ? `${this.searchSolvesFree} free (${held} more are held until the first confirm)` : `${this.searchSolvesLeft} left`;
  }

  private projectOrThrow(point: DesignPoint, fidelity: Fidelity) {
    return projectFor(this.design, point, fidelity);
  }

  private pointWith(enable: unknown, values: unknown): DesignPoint {
    let enabled = this.current.enabled;
    if (enable !== undefined) {
      if (!Array.isArray(enable) || enable.some((f) => typeof f !== 'string' || !Object.hasOwn(this.design.features, f))) {
        throw new ToolInputError(`enable must list features from: ${Object.keys(this.design.features).join(', ')}`);
      }
      enabled = [...new Set(enable as string[])];
    }
    const next = { ...this.current.values };
    if (values !== undefined) {
      if (typeof values !== 'object' || values === null || Array.isArray(values)) throw new ToolInputError('values must map variable names to mm');
      for (const [name, v] of Object.entries(values)) next[this.tunable(name)] = num(v, `values.${name}`);
    }
    return { enabled, values: next };
  }

  private tunable(name: unknown): string {
    if (typeof name !== 'string' || !Object.hasOwn(this.current.values, name)) {
      throw new ToolInputError(`${JSON.stringify(name)} is not a tunable variable; tunable: ${Object.keys(this.current.values).join(', ')}`);
    }
    return name;
  }

  /** A variable of a switched-off feature changes nothing: refuse to spend solves on it. */
  private live(variable: string, enabled: string[]): string {
    const owner = Object.entries(this.design.features).find(([, f]) => f.variables.includes(variable));
    if (owner && !enabled.includes(owner[0])) throw new ToolInputError(`${variable} belongs to feature "${owner[0]}", which is off; enable it first`);
    return variable;
  }

  /** The same physical design: same features, same values of the variables that are live (an off feature's do nothing). */
  private samePoint(a: DesignPoint, b: DesignPoint): boolean {
    if (JSON.stringify([...a.enabled].sort()) !== JSON.stringify([...b.enabled].sort())) return false;
    return Object.keys(b.values).every((k) => !this.isLive(k, b.enabled) || Math.abs(a.values[k] - b.values[k]) < 1e-6);
  }

  private isLive(variable: string, enabled: string[]): boolean {
    const owner = Object.entries(this.design.features).find(([, f]) => f.variables.includes(variable));
    return !owner || enabled.includes(owner[0]);
  }

  /** Values of the base variables and of the switched-on features, with the metrics. */
  private pointView(record: SolveRecord) {
    const shown = new Set(Object.keys(record.point.values));
    for (const [name, f] of Object.entries(this.design.features)) {
      if (!record.point.enabled.includes(name)) f.variables.forEach((v) => shown.delete(v));
    }
    return {
      met: record.metrics ? goalMet(record.metrics, this.goal) : false,
      score: round(record.score, 2),
      ...(record.metrics ? metricsView(record.metrics) : { error: record.error }),
      enabled: record.point.enabled,
      values_mm: Object.fromEntries([...shown].map((v) => [v, round(record.point.values[v])])),
      ...(record.warnings?.length ? { warnings: record.warnings } : {}),
      search_solves_left: this.searchSolvesLeft,
    };
  }
}

function recordOf(fidelity: Fidelity, point: DesignPoint, outcome: Evaluation | Error, goal: DesignGoal): SolveRecord {
  if (outcome instanceof Error) return { fidelity, point, metrics: null, score: INFEASIBLE_SCORE, error: outcome.message };
  // Against an aim, every frequency-dependent number moves with it; the axial ratio stays the design target's.
  const metrics = { ...outcome.metrics, ...metricsFromSpectrum(outcome.spectrum, goal) };
  return {
    fidelity, point, metrics, score: goalScore(metrics, goal),
    ...(outcome.warnings.length ? { warnings: outcome.warnings } : {}),
    ...(outcome.cells !== undefined ? { cells: outcome.cells } : {}),
  };
}

/** A solve's metrics in the keys of sensitivityMetrics; null for a failed solve or a metric it lacks. */
function metricsOf(r: SolveRecord): Metrics {
  const m = r.metrics;
  return {
    f0_mhz: m ? 1000 * m.f0_ghz : null,
    s11_target_db: m ? m.s11_at_target_db : null,
    zin_target_ohm: m?.zin_target_ohm ?? null,
    s11_min_db: m ? m.s11_min_db : null,
    bandwidth_mhz: m ? m.bandwidth_mhz : null,
    axial_ratio_db: m?.axial_ratio_db ?? null,
  };
}

/** The report as the strategist reads it: per variable, slope per mm with its spread and the change across the range, rounded. */
function sensitivityView(report: SensitivityReport, searchSolvesLeft: number) {
  const sig = (x: number) => Number(x.toPrecision(3));
  return {
    rank_by: report.rankBy,
    rows: report.rows.map((r) => ({
      variable: r.variable.name,
      mm: round(r.variable.value),
      range_mm: [round(r.variable.min), round(r.variable.max)],
      step_mm: round(r.h),
      ...Object.fromEntries(Object.entries(r.slopes).map(([key, s]) => [key, s
        ? {
          per_mm: sig(s.perUnit), spread: sig(s.spread), across_range: sig(s.acrossRange), grade: s.grade,
          ...(s.stepError !== undefined ? { step_error: sig(s.stepError) } : {}), ...(s.curved ? { curved: true } : {}),
        }
        : null])),
      ...(r.notes.length ? { notes: r.notes } : {}),
    })),
    ...(report.skipped.length ? { skipped: report.skipped } : {}),
    solves: report.solves,
    search_solves_left: searchSolvesLeft,
  };
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ToolInputError(`${name} must be a number`);
  return v;
}


/** The range as written in the project ("min 0.5 mm, max patch_l / 2"), so the strategist sees what a bound depends on. */
function rangeText(design: DesignFile, name: string): string {
  const def = design.project.variables[name];
  return [def.min !== undefined ? `min ${def.min}` : '', def.max !== undefined ? `max ${def.max}` : ''].filter(Boolean).join(', ');
}
