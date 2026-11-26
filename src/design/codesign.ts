import type { CallStats, ChatMessage, ChatModel, ChatTool, ChatTurn } from './llm';
import type { LiveFrame } from './evaluate';
import type { DesignGoal } from './goal';
import { SpendCapError } from './spend';
import type { DesignSession, SolveRecord } from './session';

/**
 * Co-design: a model watches the optimiser solve by solve and can redirect it.
 *
 * The strategist loop (strategist.ts) hands the model the floor only between
 * searches: a 24-solve Nelder-Mead run happens without it. Here the search
 * runs and, in parallel, the model reviews the newest solve every time it is
 * free. It answers with one `steer` call: continue (with a one-line note on
 * what the solve shows), redirect (other features, free variables, a jump in
 * values, an aim), confirm, or stop. A redirect stops the running search
 * before its next solve.
 *
 * With live frames (GPU solves), the model also sees the solve that is still
 * running: S11 from its port signal so far. It can stop that one solve
 * (stop_solve) when it is clearly a dead end; the search goes on. A fixed
 * early-stop rule (EarlyStopRule) does the same without a model.
 *
 * Nothing waits for the model while a search runs. A model slower than the
 * solver reviews only some of the solves and reacts later; the solver keeps
 * going either way. So the lanes differ in what fraction of the solves the
 * model saw and how many solves passed between a solve and the model's answer
 * to it, not in solver time.
 */

export const STEER_TOOL: ChatTool = {
  name: 'steer',
  description: 'Your decision on the newest result. Always include a one-line note in plain words on what the result shows physically.',
  parameters: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'At most 25 words: what this result shows and why, in plain engineering terms.' },
      action: { type: 'string', enum: ['continue', 'stop_solve', 'redirect', 'confirm', 'stop'] },
      enable: { type: 'array', items: { type: 'string' }, description: 'redirect: features to switch on, in addition to those already on.' },
      disable: { type: 'array', items: { type: 'string' }, description: 'redirect: features to switch off.' },
      free: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4, description: 'redirect: the variables the optimiser may move (1 to 4).' },
      values: { type: 'object', additionalProperties: { type: 'number' }, description: 'redirect: jump to these values (mm) before searching.' },
      aim_ghz: { type: 'number', description: 'redirect: aim the search here instead of the target (to offset the measured mesh_gap).' },
      aim_s11_db: { type: 'number', description: 'redirect: S11 the search must reach instead of the goal (deeper, to offset the measured mesh_gap).' },
    },
    required: ['note', 'action'],
    additionalProperties: false,
  },
};

export const WATCHER_PROMPT = `You watch a Nelder-Mead optimiser design a planar antenna on the NobuRF FDTD solver, one solve at a time, and steer it.
Each message is the state now: goal, variables with ranges, the search in progress, the newest solves, your recent notes.

Answer with one steer call. action:
- continue: the search is making progress; let it run. This is the usual answer.
- stop_solve: end the solve that is still running (running_solve) because its early numbers already show a dead end. The search goes on.
  running_solve is read from the signal so far: its f0 is reliable once energy_down_db passes about 10; its S11 depth is not final.
- redirect: the search is wasting solves. Give free (and enable, disable, values, aim_ghz, aim_s11_db as needed). It restarts from the best point.
  enable only adds features and disable only removes them; features you do not name stay as they are.
- confirm: a search design meets the goal (score 0); check it on the fine mesh.
- stop: a confirmed design meets the goal, or the budget left cannot reach it.

Physics to reason with:
- f0 scales about as 1/patch_l. If f0 is off by x %, patch_l should change by about x % the other way. A jump in values gets there in one solve.
- z_target is the input impedance at the target (R + jX ohm). Near 50 + j0 is a match. R well above 50 with an edge feed: a deeper inset lowers it.
  X far from 0 at the target usually means the resonance is not at the target yet.
- A free variable pinned at a range limit cannot go further: switch on a feature (a slot lowers f0 of a patch that cannot grow) or free another variable.
- A frequency that is right with a match that stalls: free feed_w with the inset.
- The search mesh is coarser than the fine confirm mesh. mesh_gap is that difference measured in this run (fine minus search).
  After a confirm misses, aim past it: aim_ghz = target / (1 + f0_pct/100) and aim_s11_db = goal s11_max_db - s11_db (when s11_db > 0).
Redirect only for a reason you can name in the note. Keep notes short and concrete; no filler.
user_says holds requests from the person running the design. They come first: act on them and say how in the note.`;

export type SteerAction = 'continue' | 'stop_solve' | 'redirect' | 'confirm' | 'stop';

export interface SteerDecision {
  note: string;
  action: SteerAction;
  enable?: string[];
  disable?: string[];
  free?: string[];
  values?: Record<string, number>;
  aim_ghz?: number;
  aim_s11_db?: number;
}

export interface ReviewEvent {
  type: 'review';
  /** Why the model was asked: the newest solve while a search runs, or a point where the loop needs a decision. */
  trigger: 'start' | 'solve' | 'frame' | 'search_ended' | 'confirm';
  /** Search solves done when the model was asked, and when it answered. */
  solves_asked: number;
  solves_answered: number;
  stats: CallStats;
  decision: SteerDecision | { error: string };
  /** The person's requests this call showed the model, if any. */
  user_says?: string[];
}

export interface CoDesignResult {
  ended: 'stopped' | 'budget' | 'review_limit' | 'spend_cap' | 'model_error' | 'tool_error';
  reviews: number;
  /** Search solves the model saw: each call shows the solves since the last call, up to NEWEST_ROWS. */
  solvesReviewed: number;
  /** Reviews while a search ran: mean search solves that landed between asking and getting the answer. */
  meanLagSolves: number;
  redirects: number;
  modelMs: number;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  retryWaitMs: number;
  error?: string;
}

/** Resolves the next time a solve lands; the script fires it from the session's event hook. */
export class SolveSignal {
  private waiters: Array<() => void> = [];
  fire(): void {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }
  next(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/**
 * The running solve, as the co-design loop sees it: its newest frame, and a
 * switch that stops it. The script wires both to the evaluator's live options.
 */
export interface LiveWatch {
  /** The newest frame of the solve running now, or null between solves or before its first frame. */
  latest(): LiveFrame | null;
  stopSolve(reason: string): boolean;
}

/** Energy decay (dB from the peak) after which a running solve's f0 is worth reading. */
export const FRAME_READY_DB = 10;

/**
 * The no-model early stop: end a solve whose resonance, read from the signal
 * so far, sits more than `offPct` from the target on two frames in a row that
 * agree to within 0.5 %. Fed every frame; returns the reason to stop, or null.
 */
export class EarlyStopRule {
  private last: LiveFrame | null = null;

  constructor(private readonly offPct = 4) {}

  consider(frame: LiveFrame, goal: DesignGoal): string | null {
    const previous = this.last?.solve === frame.solve ? this.last : null;
    this.last = frame;
    if (!previous || frame.energyDecayDb < FRAME_READY_DB) return null;
    const f0 = frame.metrics.f0_ghz;
    const steady = Math.abs(f0 - previous.metrics.f0_ghz) / f0 < 0.005;
    const offPct = (100 * Math.abs(f0 - goal.target_ghz)) / goal.target_ghz;
    return steady && offPct > this.offPct ? `f0 ${f0.toFixed(3)} GHz is ${offPct.toFixed(1)} % off the target and steady` : null;
  }
}

/** Solves shown to the model per call. */
const NEWEST_ROWS = 6;

const round = (x: number, digits = 3) => Number(x.toFixed(digits));

/** One solve as a short row: the free variables' values, then the numbers that matter. */
function solveRow(r: SolveRecord, variables: string[]) {
  const m = r.metrics;
  return [
    ...variables.map((v) => round(r.point.values[v], 2)),
    m ? round(m.f0_ghz) : null,
    m ? round(m.s11_at_target_db, 1) : null,
    m?.z_target_ohm ? `${Math.round(m.z_target_ohm.re)}${m.z_target_ohm.im < 0 ? '-' : '+'}j${Math.abs(Math.round(m.z_target_ohm.im))}` : null,
    m ? Math.round(m.bandwidth_mhz) : null,
    round(r.score, 2),
    ...(r.error ? [r.error.slice(0, 80)] : []),
  ];
}

interface SearchState {
  free: string[];
  enabled: string[];
  aims: { aim_ghz?: number; aim_s11_db?: number };
  startedAtSolve: number;
}

/**
 * The state the model reads, rebuilt for every call: each call stands alone, so
 * its size does not grow with the run and a rate limit on tokens per minute is
 * predictable.
 */
export function watcherContext(
  session: DesignSession, trigger: ReviewEvent['trigger'], search: SearchState | null, notes: string[], lastResult?: unknown,
  extra: { running?: LiveFrame | null; userSays?: string[] } = {},
) {
  const brief = session.brief();
  const searches = session.records.filter((r) => r.fidelity === 'search');
  const shown = search?.free ?? ['patch_l'];
  const best = searches.filter((r) => !r.stopped_early).sort((a, b) => a.score - b.score)[0];
  const gap = session.meshGap();
  const variables = Object.fromEntries(Object.entries(brief.variables).map(([name, v]) => {
    const e = v as { mm: number; min_mm?: number; max_mm?: number; feature: string };
    return [name, e.min_mm !== undefined ? [e.mm, e.min_mm, e.max_mm] : [e.mm, e.feature + ' off']];
  }));
  return {
    trigger,
    goal: brief.goal,
    features: brief.features,
    enabled: brief.enabled,
    variables_mm_value_min_max: variables,
    budget: brief.budget,
    ...(search ? { search: { free: search.free, enabled: search.enabled, ...search.aims, solves_so_far: searches.length - search.startedAtSolve } } : {}),
    ...(best ? { best_search: { enabled: best.point.enabled, values_mm: Object.fromEntries(Object.entries(best.point.values).map(([k, v]) => [k, round(v, 2)])), row: solveRow(best, shown) } } : {}),
    newest_solves: { columns: [...shown, 'f0_ghz', 's11_target_db', 'z_target_ohm', 'bw_mhz', 'score'], rows: searches.slice(-NEWEST_ROWS).map((r) => solveRow(r, shown)) },
    confirms: session.records.filter((r) => r.fidelity === 'confirm').map((r) => ({ values_mm: r.point.values, row: solveRow(r, shown) })),
    ...(gap ? { mesh_gap: gap } : {}),
    ...(extra.running ? { running_solve: runningView(extra.running) } : {}),
    ...(lastResult !== undefined ? { last_result: lastResult } : {}),
    your_recent_notes: notes.slice(-3),
    ...(extra.userSays?.length ? { user_says: extra.userSays } : {}),
  };
}

function runningView(f: LiveFrame) {
  const m = f.metrics;
  return {
    steps: f.stepsDone,
    energy_down_db: Math.round(f.energyDecayDb),
    f0_ghz: round(m.f0_ghz),
    s11_target_db: round(m.s11_at_target_db, 1),
    ...(m.z_target_ohm ? { z_target_ohm: `${Math.round(m.z_target_ohm.re)}${m.z_target_ohm.im < 0 ? '-' : '+'}j${Math.abs(Math.round(m.z_target_ohm.im))}` } : {}),
  };
}

/** The decision from one model turn, or the reason it is not one. */
function parseDecision(turn: ChatTurn): SteerDecision | { error: string } {
  const call = turn.message.tool_calls?.find((c) => c?.function?.name === 'steer');
  if (!call) return { error: `no steer call (text: ${String(turn.message.content ?? '').slice(0, 200)})` };
  let d: SteerDecision;
  try {
    d = JSON.parse(call.function.arguments) as SteerDecision;
  } catch (e) {
    return { error: `steer arguments are not JSON: ${(e as Error).message}` };
  }
  if (!['continue', 'stop_solve', 'redirect', 'confirm', 'stop'].includes(d?.action)) return { error: `unknown action ${JSON.stringify(d?.action)}` };
  if (d.action === 'redirect' && !(Array.isArray(d.free) && d.free.length)) return { error: 'a redirect needs free variables' };
  return { ...d, note: typeof d.note === 'string' ? d.note.trim() : '' };
}

export async function runCoDesign(
  session: DesignSession,
  model: ChatModel,
  signal: SolveSignal,
  options: {
    maxReviews: number;
    onEvent?: (e: ReviewEvent) => void;
    /** The running solve's frames and stop switch (GPU); without it the model sees finished solves only. */
    live?: LiveWatch;
    /** The person's requests since the last call (typed in the view); each is shown to the model once. */
    takeUserSays?: () => string[];
    /** True once the person asked to end the run. */
    stopRequested?: () => boolean;
  },
): Promise<CoDesignResult> {
  const result: CoDesignResult = {
    ended: 'budget', reviews: 0, solvesReviewed: 0, meanLagSolves: 0, redirects: 0, modelMs: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, retryWaitMs: 0,
  };
  const notes: string[] = [];
  let lagTotal = 0;
  let watchReviews = 0;
  let seenUpTo = 0;
  const searchSolves = () => session.records.filter((r) => r.fidelity === 'search').length;

  /** One model call. Throws StopRun on an error that ends the run (spend cap, provider failure). */
  const ask = async (trigger: ReviewEvent['trigger'], search: SearchState | null, lastResult?: unknown): Promise<SteerDecision | null> => {
    if (result.reviews >= options.maxReviews) throw new StopRun('review_limit');
    const asked = searchSolves();
    // Only while a search is being watched: between searches nothing is running.
    const running = trigger === 'solve' || trigger === 'frame' ? options.live?.latest() ?? null : null;
    const userSays = options.takeUserSays?.() ?? [];
    const messages: ChatMessage[] = [
      { role: 'system', content: WATCHER_PROMPT },
      { role: 'user', content: JSON.stringify(watcherContext(session, trigger, search, notes, lastResult, { running, userSays })) },
    ];
    let turn: ChatTurn;
    try {
      turn = await model.chat(messages, [STEER_TOOL]);
    } catch (e) {
      throw new StopRun(e instanceof SpendCapError ? 'spend_cap' : 'model_error', (e as Error).message);
    }
    result.reviews++;
    result.modelMs += turn.stats.ms;
    result.costUsd += turn.stats.cost_usd;
    result.promptTokens += turn.stats.prompt_tokens ?? 0;
    result.completionTokens += turn.stats.completion_tokens ?? 0;
    result.retryWaitMs += turn.stats.retry_wait_ms ?? 0;
    const answered = searchSolves();
    // Every solve since the last call is in this call's newest rows (up to the six it shows).
    result.solvesReviewed += Math.min(NEWEST_ROWS, asked - seenUpTo);
    seenUpTo = asked;
    if (trigger === 'solve' || trigger === 'frame') {
      watchReviews++;
      lagTotal += answered - asked;
    }
    const decision = parseDecision(turn);
    options.onEvent?.({ type: 'review', trigger, solves_asked: asked, solves_answered: answered, stats: turn.stats, decision, ...(userSays.length ? { user_says: userSays } : {}) });
    if ('error' in decision) {
      notes.push(`(your last answer was refused: ${decision.error})`);
      return null;
    }
    notes.push(`${decision.action}: ${decision.note}`);
    return decision;
  };

  /** A blocking decision: asked again (up to three times) until the model gives a usable one. */
  const decide = async (trigger: ReviewEvent['trigger'], search: SearchState | null, lastResult?: unknown): Promise<SteerDecision> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const d = await ask(trigger, search, lastResult);
      if (d && d.action !== 'continue' && d.action !== 'stop_solve') return d;
      if (d) lastResult = { note: 'nothing is running: continue is not an option here; redirect, confirm or stop' };
    }
    throw new StopRun('model_error', 'three answers in a row could not be acted on');
  };

  let lastEnabled = [...session.current.enabled];
  /** Runs one search with the model watching every solve it can; returns the decision that ended it, if the model's. */
  const watchedSearch = async (plan: SteerDecision): Promise<{ outcome: unknown; interrupt: SteerDecision | null }> => {
    const off = new Set(plan.disable ?? []);
    // Based on the last search's features, not the current point: a search with no usable solve leaves the
    // current point where it was, and "search again" must not silently drop what that search enabled.
    const enabled = [...new Set([...lastEnabled, ...(plan.enable ?? [])])].filter((f) => !off.has(f));
    lastEnabled = enabled;
    const aims = {
      ...(plan.aim_ghz !== undefined ? { aim_ghz: plan.aim_ghz } : {}),
      ...(plan.aim_s11_db !== undefined ? { aim_s11_db: plan.aim_s11_db } : {}),
    };
    const search: SearchState = { free: plan.free!, enabled, aims, startedAtSolve: searchSolves() };
    if (plan.values && Object.keys(plan.values).length) {
      const jumped = await session.call('try_design', { enable: enabled, values: plan.values });
      if ((jumped as { error?: string }).error) return { outcome: { jump: jumped }, interrupt: null };
    }
    session.stopSearchRequested = false; // a late request from the last search's watcher must not stop this one
    let running = true;
    let interrupt: SteerDecision | null = null;
    const searchDone = session.call('optimise', {
      enable: enabled, free: plan.free, max_solves: Math.max(plan.free!.length + 1, session.searchSolvesFree), ...aims,
    }).finally(() => {
      running = false;
      signal.fire(); // wakes a watcher waiting for a solve that will not come
    });
    let watchError: unknown = null;
    const watcher = (async () => {
      let reviewed = searchSolves();
      let frameSeen: LiveFrame | null = null;
      // A frame worth a look: the running solve has rung down far enough and the model has not seen it yet.
      const freshFrame = () => {
        const f = options.live?.latest() ?? null;
        return f && f.energyDecayDb >= FRAME_READY_DB && f.solve !== frameSeen?.solve ? f : null;
      };
      while (running && !interrupt) {
        if (options.stopRequested?.()) {
          interrupt = { note: 'stopped by the person running the design', action: 'stop' };
          session.stopSearchRequested = true;
          break;
        }
        if (searchSolves() === reviewed && !freshFrame()) await signal.next();
        if (!running) break;
        const solved = searchSolves() !== reviewed;
        reviewed = searchSolves();
        const frame = solved ? null : freshFrame();
        if (!solved && !frame) continue; // woken by a frame not worth a look yet
        if (frame) frameSeen = frame;
        const d = await ask(frame ? 'frame' : 'solve', search);
        if (d?.action === 'stop_solve') {
          // The record says whether it stopped: an abort after the last energy check lets the solve finish.
          options.live?.stopSolve(`AI: ${d.note}`);
        } else if (d && d.action !== 'continue' && running) {
          interrupt = d;
          session.stopSearchRequested = true;
        }
      }
    })().catch((e) => {
      // The run ends, but not under a search still spending solves: stop it and let it return first.
      watchError = e;
      if (running) session.stopSearchRequested = true;
    });
    const [outcome] = await Promise.all([searchDone, watcher]);
    if (watchError) throw watchError;
    // Fail fast when the solver itself is broken: every solve of the search failed, so no redirect can help.
    const ran = session.records.filter((r) => r.fidelity === 'search').slice(search.startedAtSolve);
    if (ran.length >= 3 && ran.every((r) => r.error)) throw new StopRun('tool_error', `every solve of the search failed: ${ran[0].error}`);
    return { outcome, interrupt };
  };

  try {
    let plan = await decide('start', null);
    for (;;) {
      if (options.stopRequested?.() && plan.action !== 'stop') plan = { note: 'stopped by the person running the design', action: 'stop' };
      if (plan.action === 'stop') {
        result.ended = 'stopped';
        await session.call('finish', { summary: plan.note || 'stopped' });
        break;
      }
      if (plan.action === 'confirm') {
        const confirmed = await session.call('confirm', {});
        plan = await decide('confirm', null, confirmed);
        continue;
      }
      // redirect (also the opening plan). One the free search budget cannot run would be refused again and
      // again: confirm the best design instead while a confirm is left (which also frees the held solves), else end.
      if (session.searchSolvesFree < plan.free!.length + 1) {
        if (session.confirmSolvesLeft <= 0) {
          result.ended = 'budget';
          break;
        }
        const confirmed = await session.closingConfirm();
        if (!confirmed) {
          result.ended = 'budget';
          break;
        }
        plan = await decide('confirm', null, { ...confirmed, note: 'the search budget could not run your redirect, so the best search design was confirmed' });
        continue;
      }
      result.redirects++;
      const { outcome, interrupt } = await watchedSearch(plan);
      plan = interrupt ?? await decide('search_ended', null, outcome);
    }
  } catch (e) {
    if (!(e instanceof StopRun)) {
      result.ended = 'tool_error';
      result.error = (e as Error).message;
    } else {
      result.ended = e.reason;
      if (e.detail) result.error = e.detail;
    }
  }
  result.redirects = Math.max(0, result.redirects - 1); // the opening plan is not a redirect
  result.meanLagSolves = watchReviews ? round(lagTotal / watchReviews, 2) : 0;
  return result;
}

class StopRun extends Error {
  constructor(readonly reason: 'review_limit' | 'spend_cap' | 'model_error' | 'tool_error', readonly detail?: string) {
    super(detail ?? reason);
  }
}

/**
 * Fixed rules in the watcher's seat, for offline runs, tests and the control
 * arm of the comparison: the same context and the same steer tool, no model.
 * Rules: start with the inset; jump patch_l by the frequency error when the
 * newest solve is more than 3 % off; switch on the slot when patch_l is pinned
 * at its maximum; confirm a met design; aim off a confirm's mesh offset.
 * `latencyMs` delays every answer, to stand in for a model of that speed.
 */
export class RulesWatcher implements ChatModel {
  readonly label: string;
  private jumped = new Set<number>();

  constructor(private readonly latencyMs = 0) {
    this.label = latencyMs ? `rules watcher (${latencyMs} ms per answer)` : 'rules watcher';
  }

  async chat(messages: ChatMessage[]): Promise<ChatTurn> {
    const t0 = performance.now();
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const ctx = JSON.parse(String(messages[messages.length - 1].content)) as ReturnType<typeof watcherContext>;
    const d = this.decide(ctx);
    return {
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'steer', type: 'function', function: { name: 'steer', arguments: JSON.stringify(d) } }] },
      stats: { ms: Math.round(performance.now() - t0), prompt_tokens: null, completion_tokens: null, cost_usd: 0, usage_reported: true },
    };
  }

  private decide(ctx: ReturnType<typeof watcherContext>): SteerDecision {
    const target = ctx.goal.target_ghz;
    const vars = ctx.variables_mm_value_min_max as Record<string, [number, number | string, number?]>;
    // While a search runs the session's current point is still its start: the search's own features count.
    const enabled = ctx.search?.enabled ?? ctx.enabled;
    const matching = enabled.includes('stub') ? 'stub_l' : 'inset_d';
    const free = enabled.includes('slot') ? ['slot_l', 'patch_l', matching] : ['patch_l', matching];
    const searchLeft = (ctx.budget as { search_solves: number }).search_solves;
    if (ctx.trigger === 'start') return { note: 'Start with the inset for the match and patch length for frequency.', action: 'redirect', enable: [...new Set([...enabled, 'inset'])], free: ['patch_l', 'inset_d'] };
    if (ctx.trigger === 'confirm') {
      const r = ctx.last_result as { met?: boolean; f0_ghz?: number; search_mesh_f0_ghz?: number; confirm_solves_left?: number; error?: string };
      if (r.met) return { note: 'Confirmed on the fine mesh.', action: 'stop' };
      const gap = ctx.mesh_gap;
      if (gap && r.confirm_solves_left && searchLeft >= 8) {
        // Aim past the gap measured in this run: frequency both ways, depth only when the fine mesh is worse.
        const aim = Number((target / (1 + gap.f0_pct / 100)).toFixed(4));
        const depth = gap.s11_db > 0 ? { aim_s11_db: Number((ctx.goal.s11_max_db - gap.s11_db).toFixed(2)) } : {};
        return { note: `Fine mesh sits ${gap.f0_pct} % and ${gap.s11_db} dB from the search mesh; aim past it.`, action: 'redirect', free, aim_ghz: aim, ...depth };
      }
      return { note: 'Confirm missed and no budget is left to re-aim.', action: 'stop' };
    }
    if (ctx.trigger === 'search_ended') {
      const r = ctx.last_result as { met?: boolean; stop?: string };
      if (r?.met || r?.stop === 'aim met') return { note: 'Search meets the goal; check it on the fine mesh.', action: 'confirm' };
      if (searchLeft >= 8) return { note: 'Search ended short of the goal; search again from the best point.', action: 'redirect', free };
      return { note: 'Budget spent without meeting the goal.', action: 'stop' };
    }
    if (ctx.trigger === 'frame') {
      // The solve still running: stop it when its early resonance is far off, else let it finish.
      const r = ctx.running_solve;
      const offPct = r ? (100 * Math.abs(r.f0_ghz - target)) / target : 0;
      return r && offPct > 4 ? { note: `Running solve resonates at ${r.f0_ghz} GHz, ${offPct.toFixed(1)} % off: not worth finishing.`, action: 'stop_solve' } : { note: 'Running solve looks plausible; let it finish.', action: 'continue' };
    }
    // A solve while a search runs: read it from the newest row.
    const { columns, rows } = ctx.newest_solves;
    const newest = rows[rows.length - 1];
    const at = (name: string) => (columns.indexOf(name) >= 0 ? (newest?.[columns.indexOf(name)] as number | null) : null);
    const f0 = at('f0_ghz');
    const length = at('patch_l');
    const lengthMax = vars.patch_l?.[2];
    if (f0 && length !== null && typeof lengthMax === 'number' && length >= lengthMax - 0.05 && f0 > target * 1.01 && !enabled.includes('slot') && vars.slot_l) {
      return { note: 'patch_l is at its maximum and f0 is still high: add a slot to lengthen the current path.', action: 'redirect', enable: [...enabled, 'slot'], free: ['slot_l', 'patch_l', matching] };
    }
    if (f0 && length !== null && Math.abs(f0 - target) / target > 0.03 && !this.jumped.has(length)) {
      this.jumped.add(length);
      const next = Math.min(Number(((length * f0) / target).toFixed(3)), typeof lengthMax === 'number' ? lengthMax : Infinity);
      return { note: `f0 ${f0} GHz is ${((100 * (f0 - target)) / target).toFixed(1)} % off; scale patch_l by f0/target.`, action: 'redirect', free, values: { patch_l: next } };
    }
    return { note: 'Search is moving; continue.', action: 'continue' };
  }
}
