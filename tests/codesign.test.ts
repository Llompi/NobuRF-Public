import { describe, expect, it } from 'vitest';
import { EarlyStopRule, RulesWatcher, runCoDesign, SolveSignal, watcherContext, type LiveWatch, type ReviewEvent, type SteerDecision } from '../src/design/codesign';
import type { LiveFrame } from '../src/design/evaluate';
import type { DesignGoal } from '../src/design/goal';
import type { ChatModel, ChatTurn } from '../src/design/llm';
import { patchDesign } from '../src/design/patch_template';
import { DesignSession, type SessionEvent } from '../src/design/session';
import { SpendCapError } from '../src/design/spend';
import { surrogateEvaluator } from './design_surrogate';

const GOAL: DesignGoal = { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 };

/** A session wired to a solve signal, as scripts/design.ts wires it. */
function setup(boardMm: number, solveDelayMs: number, limits = { maxSearchSolves: 60, maxConfirmSolves: 2 }) {
  const design = patchDesign({ goal: GOAL, boardWMm: boardMm, boardLMm: boardMm });
  // Start 10 % high and mismatched, so a search takes more than its first simplex.
  design.project.variables.patch_l.value = '10.6 mm';
  design.project.variables.inset_d.value = '1 mm';
  const signal = new SolveSignal();
  const events: SessionEvent[] = [];
  const session = new DesignSession(design, surrogateEvaluator(design.goal, solveDelayMs), limits, (e) => {
    events.push(e);
    if (e.type === 'solve') signal.fire();
  });
  return { session, signal, events };
}

const steer = (args: object, ms = 0): ChatTurn => ({
  message: { role: 'assistant', content: null, tool_calls: [{ id: 's', type: 'function', function: { name: 'steer', arguments: JSON.stringify(args) } }] },
  stats: { ms, prompt_tokens: 100, completion_tokens: 10, cost_usd: 0, usage_reported: true },
});

describe('co-design watcher', () => {
  it('rules in the watcher seat reach a confirmed design on a roomy board', async () => {
    const { session, signal } = setup(24, 2);
    const result = await runCoDesign(session, new RulesWatcher(), signal, { maxReviews: 200 });
    expect(result.ended).toBe('stopped');
    expect(session.bestConfirmed()!.score).toBe(0);
    expect(result.solvesReviewed).toBeGreaterThan(0);
  });

  it('a watcher slower than the solver acts on stale solves', async () => {
    const fast = setup(24, 20);
    const fastResult = await runCoDesign(fast.session, new RulesWatcher(1), fast.signal, { maxReviews: 200 });
    const slow = setup(24, 20);
    const slowResult = await runCoDesign(slow.session, new RulesWatcher(150), slow.signal, { maxReviews: 200 });
    expect(fastResult.meanLagSolves).toBeLessThan(1);
    expect(slowResult.meanLagSolves).toBeGreaterThan(2);
  });

  it('a redirect stops the running search before its next solve', async () => {
    const { session, signal, events } = setup(24, 5);
    let calls = 0;
    const model: ChatModel = {
      label: 'test',
      chat: async () => {
        calls++;
        if (calls === 1) return steer({ note: 'start', action: 'redirect', enable: ['inset'], free: ['patch_l', 'inset_d'] });
        if (calls === 2) return steer({ note: 'switch to the length alone', action: 'redirect', free: ['patch_l'] });
        return steer({ note: 'done', action: 'stop' });
      },
    };
    const result = await runCoDesign(session, model, signal, { maxReviews: 10 });
    expect(result.ended).toBe('stopped');
    const optimises = events.filter((e): e is Extract<SessionEvent, { type: 'tool' }> => e.type === 'tool' && e.name === 'optimise');
    expect((optimises[0].result as { stop: string }).stop).toBe('stopped by the watcher');
    expect(optimises[1].args).toMatchObject({ free: ['patch_l'] });
    expect(session.stopSearchRequested).toBe(false);
  });

  it('a spend cap while watching ends the run without leaving the search spending solves', async () => {
    const { session, signal } = setup(24, 5);
    let calls = 0;
    const model: ChatModel = {
      label: 'test',
      chat: async () => {
        if (++calls === 1) return steer({ note: 'start', action: 'redirect', enable: ['inset'], free: ['patch_l', 'inset_d'] });
        throw new SpendCapError('run cap reached');
      },
    };
    const result = await runCoDesign(session, model, signal, { maxReviews: 10 });
    expect(result.ended).toBe('spend_cap');
    const solves = session.records.length;
    expect(solves).toBeLessThan(10); // stopped at the next solve, not after the whole search
    await new Promise((r) => setTimeout(r, 30));
    expect(session.records.length).toBe(solves);
  });

  it('asks again when the model answers continue with nothing running, and records refused answers', async () => {
    const { session, signal } = setup(24, 1);
    const reviews: ReviewEvent[] = [];
    const answers = [{ note: 'hm', action: 'continue' }, { note: 'no free', action: 'redirect' }, { note: 'ok', action: 'stop' }];
    const model: ChatModel = { label: 'test', chat: async () => steer(answers.shift()!) };
    const result = await runCoDesign(session, model, signal, { maxReviews: 10, onEvent: (e) => reviews.push(e) });
    expect(result.ended).toBe('stopped');
    expect(reviews.map((r) => ('error' in r.decision ? 'refused' : r.decision.action))).toEqual(['continue', 'refused', 'stop']);
  });

  it('keeps the context the model reads small and the same shape every call', async () => {
    const { session } = setup(24, 0);
    await session.call('optimise', { enable: ['inset'], free: ['patch_l', 'inset_d'], max_solves: 12 });
    const ctx = watcherContext(session, 'solve', { free: ['patch_l', 'inset_d'], enabled: ['inset'], aims: {}, startedAtSolve: 0 }, ['continue: fine']);
    expect(ctx.newest_solves.rows.length).toBe(6);
    expect(ctx.newest_solves.columns).toEqual(['patch_l', 'inset_d', 'f0_ghz', 's11_target_db', 'z_target_ohm', 'bw_mhz', 'score']);
    // About 2 characters per token in dense JSON: well under 2,000 tokens a call.
    expect(JSON.stringify(ctx).length).toBeLessThan(4000);
  });

  it('enable adds features and disable removes them; unnamed features stay on', async () => {
    const { session, signal, events } = setup(24, 1);
    const answers = [
      { note: 'start', action: 'redirect', enable: ['inset'], free: ['patch_l', 'inset_d'] },
      { note: 'add the slot', action: 'redirect', enable: ['slot'], free: ['slot_l', 'inset_d'] },
      { note: 'drop the slot', action: 'redirect', disable: ['slot'], free: ['patch_l'] },
      { note: 'done', action: 'stop' },
    ];
    // Each answer is used once, by whichever review comes next (start, a solve, or a search end).
    const model: ChatModel = { label: 'test', chat: async () => steer(answers.length > 1 ? answers.shift()! : answers[0]) };
    await runCoDesign(session, model, signal, { maxReviews: 20 });
    const searches = events.filter((e): e is Extract<SessionEvent, { type: 'tool' }> => e.type === 'tool' && e.name === 'optimise');
    expect(searches.map((e) => (e.args as { enable: string[] }).enable)).toEqual([['inset'], ['inset', 'slot'], ['inset']]);
  });

  it('a redirect the search budget cannot run confirms the best design instead of being refused again and again', async () => {
    const { session, signal, events } = setup(24, 1, { maxSearchSolves: 12, maxConfirmSolves: 1 });
    // Keeps asking for the same three-variable search: 4 solves each, 2 free solves are held for the confirm's re-aim.
    const model: ChatModel = { label: 'test', chat: async () => steer({ note: 'again', action: 'redirect', enable: ['inset'], free: ['patch_l', 'inset_d', 'feed_w'] }) };
    const result = await runCoDesign(session, model, signal, { maxReviews: 40 });
    expect(['budget', 'review_limit']).toContain(result.ended);
    expect(session.records.filter((r) => r.fidelity === 'confirm')).toHaveLength(1);
    const refused = events.filter((e) => e.type === 'tool' && (e.result as { error?: string })?.error);
    expect(refused.length).toBeLessThan(3);
    expect(result.reviews).toBeLessThan(40);
  });

  it('with live frames, the watcher stops a running solve that is far off and the search goes on', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    design.project.variables.patch_l.value = '10.6 mm';
    design.project.variables.inset_d.value = '1 mm';
    const signal = new SolveSignal();
    let latest: LiveFrame | null = null;
    const evaluator = surrogateEvaluator(design.goal, 40, { everySteps: 250, onFrame: (f) => { latest = f; signal.fire(); } });
    const session = new DesignSession(design, evaluator, { maxSearchSolves: 60, maxConfirmSolves: 2 }, (e) => {
      if (e.type === 'solve') {
        latest = null;
        signal.fire();
      }
    });
    const live: LiveWatch = { latest: () => latest, stopSolve: (reason) => evaluator.stopCurrent(reason) };
    const reviews: ReviewEvent[] = [];
    await runCoDesign(session, new RulesWatcher(1), signal, { maxReviews: 300, live, onEvent: (e) => reviews.push(e) });
    expect(reviews.some((r) => r.trigger === 'frame')).toBe(true);
    const stopped = session.records.filter((r) => r.stopped_early);
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.every((r) => r.stopped_early!.reason.startsWith('AI:') && r.fidelity === 'search')).toBe(true);
    expect(session.bestConfirmed()!.score).toBe(0);
  });

  it('the early-stop rule waits for two agreeing frames past 10 dB and a resonance far off the target', () => {
    const frame = (solve: number, f0: number, db: number): LiveFrame => ({ solve, stepsDone: db * 30, energyDecayDb: db, metrics: { f0_ghz: f0, s11_min_db: -5, s11_at_target_db: -2, bandwidth_mhz: 0, bandwidth_open: false }, spectrum: { fGHz: [], s11Db: [] } });
    const rule = new EarlyStopRule();
    expect(rule.consider(frame(1, 6.3, 12), GOAL)).toBeNull(); // first frame of the solve
    expect(rule.consider(frame(1, 6.31, 15), GOAL)).toMatch(/off the target/);
    expect(rule.consider(frame(2, 6.3, 5), GOAL)).toBeNull(); // new solve
    expect(rule.consider(frame(2, 6.3, 8), GOAL)).toBeNull(); // not rung down far enough
    expect(rule.consider(frame(2, 5.9, 12), GOAL)).toBeNull(); // moving
    expect(rule.consider(frame(2, 5.9, 14), GOAL)).toBeNull(); // steady but only 1.7 % off
  });

  it("shows the person's requests to the model once, and ends the run when they ask", async () => {
    const { session, signal } = setup(24, 5);
    const says = ['keep patch_w at 14 mm'];
    let stop = false;
    const seen: string[][] = [];
    const model: ChatModel = {
      label: 'test',
      chat: async (messages) => {
        const ctx = JSON.parse(String(messages[1].content)) as { user_says?: string[] };
        seen.push(ctx.user_says ?? []);
        if (seen.length === 3) stop = true;
        return steer(seen.length === 1 ? { note: 'start', action: 'redirect', enable: ['inset'], free: ['patch_l', 'inset_d'] } : { note: 'fine', action: 'continue' });
      },
    };
    const result = await runCoDesign(session, model, signal, { maxReviews: 50, takeUserSays: () => says.splice(0), stopRequested: () => stop });
    expect(seen[0]).toEqual(['keep patch_w at 14 mm']);
    expect(seen.slice(1).every((s) => s.length === 0)).toBe(true);
    expect(result.ended).toBe('stopped');
    expect(seen.length).toBeLessThan(6);
  });

  it('ends the run when every solve of a search fails, instead of redirecting into the broken solver', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const broken = { ...surrogateEvaluator(design.goal), evaluateAll: async (projects: unknown[]) => projects.map(() => ({ status: 'rejected' as const, reason: new Error('no shader') })) };
    const session = new DesignSession(design, broken, { maxSearchSolves: 60, maxConfirmSolves: 2 });
    const result = await runCoDesign(session, new RulesWatcher(0), new SolveSignal(), { maxReviews: 50 });
    expect(result.ended).toBe('tool_error');
    expect(result.error).toMatch(/no shader/);
    expect(result.reviews).toBeLessThan(10);
  });

  it('measures the mesh gap from confirmed designs and the rules watcher aims past it', async () => {
    const { session, signal } = setup(24, 0);
    expect(session.meshGap()).toBeNull();
    await runCoDesign(session, new RulesWatcher(0), signal, { maxReviews: 200 });
    // The surrogate ignores the mesh, so the measured gap is zero: nothing assumed, nothing invented.
    expect(session.meshGap()).toEqual({ pairs: expect.any(Number), f0_pct: 0, s11_db: 0 });
    expect(session.meshGap()!.pairs).toBeGreaterThan(0);

    const ctx = { ...watcherContext(session, 'confirm', null, [], { met: false, confirm_solves_left: 1 }), mesh_gap: { pairs: 1, f0_pct: 1.2, s11_db: 1.7 } };
    ctx.budget.search_solves = 20;
    const turn = await new RulesWatcher(0).chat([{ role: 'system', content: '' }, { role: 'user', content: JSON.stringify(ctx) }]);
    const d = JSON.parse(turn.message.tool_calls![0].function.arguments) as SteerDecision;
    expect(d.action).toBe('redirect');
    expect(d.aim_ghz).toBeCloseTo(GOAL.target_ghz / 1.012, 3);
    expect(d.aim_s11_db).toBeCloseTo(GOAL.s11_max_db - 1.7, 2);
  });
});

