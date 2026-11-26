import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveProject } from '../src/project/resolve';
import { designAt, parseDesignFile, projectFor } from '../src/design/design_file';
import { axialRatio, goalMet, goalScore, metricsFromSpectrum, type DesignGoal } from '../src/design/goal';
import { HttpChatModel, laneFor, retryWaitMs } from '../src/design/llm';
import { nelderMead } from '../src/design/nelder_mead';
import { microstripWidthMm, patchDesign, patchEstimateMm } from '../src/design/patch_template';
import { DesignSession } from '../src/design/session';
import { lorentzian, surrogateEvaluator } from './design_surrogate';
import { SpendCapError, SpendGuard } from '../src/design/spend';
import { ManualDriver, runStrategist, ScriptedStrategist } from '../src/design/strategist';

const GOAL: DesignGoal = { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 };

describe('goal', () => {
  it('finds the dip, S11 at the target and the -10 dB band', () => {
    const m = metricsFromSpectrum(lorentzian(5.8, -20), GOAL);
    expect(m.f0_ghz).toBeCloseTo(5.8, 2);
    expect(m.s11_at_target_db).toBeCloseTo(-20, 0);
    // |Γ|² = 0.1 at the band edge: 1 - 0.99 / (1 + x²) = 0.1 -> x = 0.333; width 2 x q f0.
    expect(m.bandwidth_mhz).toBeCloseTo(2 * 0.3333 * 0.02 * 5800, -1);
    expect(goalMet(m, GOAL)).toBe(true);
    expect(goalScore(m, GOAL)).toBe(0);
  });

  it('scores a far dip by its frequency error, so the optimiser has a slope', () => {
    const near = goalScore(metricsFromSpectrum(lorentzian(5.6, -20), GOAL), GOAL);
    const far = goalScore(metricsFromSpectrum(lorentzian(5.2, -20), GOAL), GOAL);
    expect(far).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(0);
  });

  it('has no band when the target is above the limit', () => {
    const m = metricsFromSpectrum(lorentzian(5.8, -6), GOAL);
    expect(m.bandwidth_mhz).toBe(0);
    expect(goalScore(m, GOAL)).toBeCloseTo(4 + 0, 0);
  });

  it('axial ratio: circular is 0 dB with the right sense, linear is capped', () => {
    expect(axialRatio(1, 0, 0, -1)).toEqual({ db: 0, sense: 'RHCP' }); // x - j y
    expect(axialRatio(1, 0, 0, 1)).toEqual({ db: 0, sense: 'LHCP' });
    expect(axialRatio(1, 0, 0, 0).db).toBe(40);
    // Ellipse with axes 1 and 0.5, in phase quadrature: AR = 2 (6.02 dB).
    expect(axialRatio(1, 0, 0, -0.5).db).toBeCloseTo(6.02, 2);
  });
});

describe('patch template', () => {
  it('textbook sizes: 5.8 GHz on 1.6 mm FR-4', () => {
    const { w, l } = patchEstimateMm(5.8, 4.4, 1.6);
    expect(w).toBeCloseTo(15.7, 1);
    expect(l).toBeGreaterThan(11.4);
    expect(l).toBeLessThan(12.2);
    expect(microstripWidthMm(50, 4.4, 1.6)).toBeCloseTo(3.06, 1);
  });

  it('builds a valid design file with every feature on or off', () => {
    const design = parseDesignFile(JSON.parse(JSON.stringify(patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 }))));
    for (const enabled of [[], ['inset'], ['slot', 'stub'], ['chamfer', 'inset', 'slot', 'stub']]) {
      for (const fidelity of ['search', 'confirm'] as const) {
        const project = projectFor(design, { enabled, values: {} }, fidelity);
        const ids = project.geometry.top.map((s) => s.id);
        for (const [name, f] of Object.entries(design.features)) {
          for (const id of f.shapes) expect(ids.includes(id)).toBe(enabled.includes(name));
        }
      }
    }
  });

  it('cuts that open a patch edge reach past it (a cut keeps copper on its own outline)', () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const r = resolveProject(projectFor(design, { enabled: ['inset', 'chamfer'], values: {} }, 'confirm'));
    const [halfW, halfL] = [r.variables.patch_w.value / 2, r.variables.patch_l.value / 2];
    const shape = (id: string) => r.copper.top.find((s) => s.id === id)!.polygon;
    for (const id of ['inset_left', 'inset_right']) expect(Math.min(...shape(id).map(([, y]) => y))).toBeLessThan(-halfL);
    expect(Math.max(...shape('chamfer_a').map(([x]) => x))).toBeGreaterThan(halfW);
    expect(Math.max(...shape('chamfer_a').map(([, y]) => y))).toBeGreaterThan(halfL);
    expect(Math.min(...shape('chamfer_b').map(([x]) => x))).toBeLessThan(-halfW);
    expect(Math.min(...shape('chamfer_b').map(([, y]) => y))).toBeLessThan(-halfL);
  });

  it('clamps the patch to a small board and refuses one with no room', () => {
    const small = patchDesign({ goal: GOAL, boardWMm: 16, boardLMm: 16 });
    const v = resolveProject(small.project).variables;
    expect(v.patch_l.value).toBe(10);
    expect(() => patchDesign({ goal: GOAL, boardWMm: 8, boardLMm: 8 })).toThrow(/no room/);
  });

  it("a switched-off feature's ranges do not fence in the base variables", async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 20, boardLMm: 20 });
    // stub_d's max falls below its value as patch_l grows; with the stub off that must not matter.
    expect(() => projectFor(design, { enabled: [], values: { patch_l: 13.5 } }, 'search')).not.toThrow();
    expect(() => projectFor(design, { enabled: ['stub'], values: { patch_l: 13.5 } }, 'search')).toThrow(/stub_d/);
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 10, maxConfirmSolves: 0 });
    expect(await session.call('sweep', { variable: 'slot_l', from_mm: 3, to_mm: 6, points: 2 })).toMatchObject({ error: expect.stringContaining('which is off') });
  });

  it('refuses a point outside a range, including one set by another variable', () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    expect(() => projectFor(design, { enabled: ['slot'], values: { slot_w: 0.2 } }, 'search')).toThrow(/below its min/);
    expect(() => projectFor(design, { enabled: ['slot'], values: { slot_l: 15 } }, 'search')).toThrow(/above its max "patch_w - 2 mm"/);
    // Both at once is fine: values are set together, not one at a time.
    expect(() => projectFor(design, { enabled: ['slot'], values: { patch_w: 20, slot_l: 15 } }, 'search')).not.toThrow();
    expect(() => projectFor(design, { enabled: [], values: { board_w: 30 } }, 'search')).toThrow(/locked/);
  });
});

describe('Nelder-Mead', () => {
  const batch = (f: (x: number[]) => number) => async (xs: number[][]) => xs.map(f);

  it('finds the minimum of a bowl inside the box', async () => {
    const r = await nelderMead(batch(([a, b]) => (a - 0.3) ** 2 + 2 * (b - 0.7) ** 2), [0.9, 0.1], { maxEvaluations: 200, tolerance: 1e-4 });
    expect(r.best[0]).toBeCloseTo(0.3, 2);
    expect(r.best[1]).toBeCloseTo(0.7, 2);
    expect(r.reason).toBe('converged');
  });

  it('stays in the box when the minimum is outside it', async () => {
    const r = await nelderMead(batch(([a]) => (a - 1.5) ** 2), [0.2], { maxEvaluations: 60 });
    expect(r.best[0]).toBe(1);
  });

  it('stops at the goal and never exceeds the budget', async () => {
    const goal = await nelderMead(batch(([a, b]) => Math.max(0, Math.abs(a - 0.5) + Math.abs(b - 0.5) - 0.2)), [0.1, 0.1], { maxEvaluations: 100, stopAt: 0 });
    expect(goal.reason).toBe('goal');
    expect(goal.value).toBe(0);
    for (const budget of [3, 4, 5, 7, 11]) {
      let calls = 0;
      const r = await nelderMead(async (xs) => {
        calls += xs.length;
        return xs.map(([a, b, c]) => Math.sin(5 * a) + Math.cos(7 * b) + c);
      }, [0.5, 0.5, 0.5], { maxEvaluations: budget, tolerance: 0 }).catch((e: Error) => e);
      if (budget < 4) expect(r).toBeInstanceOf(Error);
      else expect(calls).toBeLessThanOrEqual(budget);
    }
  });
});

describe('spend guard', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reserves the worst case, settles to the actual cost, and refuses past either cap', () => {
    dir = mkdtempSync(join(tmpdir(), 'spend-'));
    const ledger = join(dir, 'spend.json');
    const guard = new SpendGuard('cerebras', { inputPerM: 1, outputPerM: 2 }, 0.1, 0.25, ledger);
    expect(guard.costUsd(1e6, 1e6)).toBe(3);
    const r = guard.reserve(0.09);
    expect(guard.spentEver()).toBeCloseTo(0.09); // charged before the call
    guard.settle(r, 0.08);
    expect(guard.spentEver()).toBeCloseTo(0.08);
    expect(() => guard.reserve(0.05)).toThrow(SpendCapError); // run cap 0.1
    const second = new SpendGuard('cerebras', { inputPerM: 1, outputPerM: 2 }, 1, 0.25, ledger);
    second.settle(second.reserve(0.1), 0.1);
    expect(second.spentEver()).toBeCloseTo(0.18);
    expect(() => second.reserve(0.1)).toThrow(/cerebras spend cap/); // lifetime 0.25
    expect(second.spentEver()).toBeCloseTo(0.18); // a refused reservation charges nothing
    expect(new SpendGuard('openrouter', { inputPerM: 1, outputPerM: 2 }, 1, 0.25, ledger).spentEver()).toBe(0);
  });

  it('refuses malformed prices and amounts instead of treating them as free', () => {
    dir = mkdtempSync(join(tmpdir(), 'spend-'));
    expect(() => new SpendGuard('x', { inputPerM: Number('0.35usd'), outputPerM: 1 }, 1, 1, join(dir, 's.json'))).toThrow(/prices/);
    expect(() => new SpendGuard('x', { inputPerM: -1, outputPerM: 1 }, 1, 1, join(dir, 's.json'))).toThrow(/prices/);
    const guard = new SpendGuard('x', { inputPerM: 1, outputPerM: 1 }, 1, 1, join(dir, 's.json'));
    expect(() => guard.reserve(NaN)).toThrow();
    expect(() => guard.settle(guard.reserve(0.1), NaN)).toThrow();
  });

  it('stops on a corrupt ledger instead of starting from zero', () => {
    dir = mkdtempSync(join(tmpdir(), 'spend-'));
    const ledger = join(dir, 'spend.json');
    for (const text of ['{"oops"', '{"providers":{"cerebras":{"spent_usd":null,"calls":1}}}']) {
      writeFileSync(ledger, text);
      expect(() => new SpendGuard('cerebras', { inputPerM: 1, outputPerM: 1 }, 1, 1, ledger).reserve(0.01)).toThrow();
    }
  });

  it('waits for the ledger lock and clears a stale one', () => {
    dir = mkdtempSync(join(tmpdir(), 'spend-'));
    const ledger = join(dir, 'spend.json');
    writeFileSync(`${ledger}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${ledger}.lock`, old, old);
    const guard = new SpendGuard('x', { inputPerM: 1, outputPerM: 1 }, 1, 1, ledger);
    guard.reserve(0.01);
    expect(guard.spentEver()).toBeCloseTo(0.01);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });
});

describe('HTTP model', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the lane fields, keeps reasoning for replay, charges reported cost', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-'));
    const lane = laneFor('openrouter', { OPENROUTER_PROVIDERS: 'nebius' });
    const guard = new SpendGuard(lane.id, lane.price, 1, 1, join(dir, 'spend.json'));
    let sent: Record<string, unknown> = {};
    const model = new HttpChatModel(lane, 'k', guard, {
      reasoningEffort: 'low',
      maxCompletionTokens: 1000,
      fetchImpl: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return reply({ choices: [{ message: { role: 'assistant', content: null, reasoning: 'think', tool_calls: [] } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.002 }, provider: 'Nebius' });
      },
    });
    const turn = await model.chat([{ role: 'user', content: 'hi' }], []);
    expect(sent.reasoning).toEqual({ effort: 'low' });
    expect(sent.provider).toEqual({ order: ['nebius'], allow_fallbacks: false, max_price: { prompt: 3, completion: 12 } });
    expect(sent.max_tokens).toBe(1000);
    expect(turn.message.reasoning).toBe('think');
    expect(turn.stats).toMatchObject({ cost_usd: 0.002, served_by: 'Nebius', usage_reported: true });
    expect(guard.spentEver()).toBeCloseTo(0.002);
  });

  it('keeps the worst-case charge when the connection fails, and releases it on an HTTP error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-'));
    const lane = laneFor('cerebras', {});
    const guard = new SpendGuard(lane.id, lane.price, 1, 1, join(dir, 'spend.json'));
    const failing = new HttpChatModel(lane, 'k', guard, { reasoningEffort: 'low', maxCompletionTokens: 100, fetchImpl: async () => { throw new Error('socket hang up'); } });
    await expect(failing.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/worst case/);
    const afterFailure = guard.spentEver();
    expect(afterFailure).toBeGreaterThan(0);
    const refused = new HttpChatModel(lane, 'k', guard, { reasoningEffort: 'low', maxCompletionTokens: 100, fetchImpl: async () => reply({ error: 'bad' }, 400) });
    await expect(refused.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/HTTP 400/);
    expect(guard.spentEver()).toBeCloseTo(afterFailure, 10);
  });

  it('waits out a rate limit as the provider asks, records it, and gives up on a spent daily quota', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-'));
    const lane = laneFor('cerebras', {});
    const guard = new SpendGuard(lane.id, lane.price, 1, 1, join(dir, 'spend.json'));
    const limited = (headers: Record<string, string>) => new Response('{"error":"rate limited"}', { status: 429, headers });
    const answers = [limited({ 'retry-after': '3' }), limited({ 'x-ratelimit-reset-tokens-minute': '7.5' }),
      reply({ choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'length' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })];
    const waits: number[] = [];
    const model = new HttpChatModel(lane, 'k', guard, { reasoningEffort: 'low', maxCompletionTokens: 10, fetchImpl: async () => answers.shift()!, sleep: async (ms) => void waits.push(ms) });
    const turn = await model.chat([{ role: 'user', content: 'x' }], []);
    expect(waits).toEqual([3000, 7500]);
    expect(turn.stats).toMatchObject({ retries: 2, retry_wait_ms: 10500, finish_reason: 'length' });
    expect(retryWaitMs(new Headers(), 3)).toBe(16000);
    expect(retryWaitMs(new Headers({ 'x-ratelimit-remaining-requests-day': '0', 'retry-after': '1' }), 0)).toBe(Infinity);
    const spent = new HttpChatModel(lane, 'k', guard, {
      reasoningEffort: 'low', maxCompletionTokens: 10, sleep: async () => {},
      fetchImpl: async () => limited({ 'x-ratelimit-remaining-requests-day': '0' }),
    });
    await expect(spent.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/HTTP 429: /);
  });

  it('sends tool_choice from NOBURF_TOOL_CHOICE and refuses anything but auto or required', () => {
    expect(laneFor('cerebras', {}).toolChoice).toBe('required');
    expect(laneFor('openrouter', { NOBURF_TOOL_CHOICE: 'auto' }).toolChoice).toBe('auto');
    expect(() => laneFor('cerebras', { NOBURF_TOOL_CHOICE: 'any' })).toThrow(/auto or required/);
  });

  it('refuses free prices, price cuts and caps above the ceilings', () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-'));
    const ledger = join(dir, 'spend.json');
    expect(() => new SpendGuard('x', { inputPerM: 0, outputPerM: 1 }, 0.5, 4, ledger)).toThrow(/positive/);
    expect(() => new SpendGuard('x', { inputPerM: 1, outputPerM: 1 }, 0.5, 50, ledger)).toThrow(/at most \$4/);
    expect(() => new SpendGuard('x', { inputPerM: 1, outputPerM: 1 }, 5, 4, ledger)).toThrow(/at most \$1/);
    expect(() => laneFor('cerebras', { NOBURF_PRICE_IN: '0' })).toThrow(/at least 0.35/);
    expect(() => laneFor('openrouter', { NOBURF_PRICE_OUT: '2' })).toThrow(/at least 12/);
    const raised = laneFor('openrouter', { NOBURF_PRICE_IN: '5', NOBURF_PRICE_OUT: '20' });
    expect(raised.extraBody('low').provider).toEqual({ sort: 'throughput', require_parameters: true, max_price: { prompt: 5, completion: 20 } });
  });

  it('keeps the worst case on a gateway error, distrusts a $0 cost with tokens, and keeps the key out of errors', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-'));
    const lane = laneFor('openrouter', {});
    const guard = new SpendGuard(lane.id, lane.price, 1, 1, join(dir, 'spend.json'));
    const gateway = new HttpChatModel(lane, 'sk-secret', guard, { reasoningEffort: 'low', maxCompletionTokens: 100, sleep: async () => {}, fetchImpl: async () => new Response('bad gateway for sk-secret', { status: 502 }) });
    await expect(gateway.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(/HTTP 502 after 5 retries over \d+ s: bad gateway for \[key\]$/);
    expect(guard.spentEver()).toBeGreaterThan(6 * 100 * 12 / 1e6 - 1e-9); // six attempts, each kept at its worst case
    const before = guard.spentEver();
    const free = new HttpChatModel(lane, 'k', guard, { reasoningEffort: 'low', maxCompletionTokens: 100,
      fetchImpl: async () => reply({ choices: [{ message: { role: 'assistant', content: 'hi' } }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0 } }) });
    const turn = await free.chat([{ role: 'user', content: 'x' }], []);
    expect(turn.stats.cost_usd).toBeCloseTo((1000 * 3 + 100 * 12) / 1e6, 10);
    expect(guard.spentEver() - before).toBeCloseTo((1000 * 3 + 100 * 12) / 1e6, 10);
  });

  it('prices any Cerebras model but gpt-oss-120b at the conservative rate', () => {
    expect(laneFor('cerebras', { CEREBRAS_MODEL: 'qwen-3.8-27b' }).price).toEqual({ inputPerM: 3, outputPerM: 12 });
    expect(laneFor('cerebras', {}).price).toEqual({ inputPerM: 0.35, outputPerM: 0.75 });
  });

  it('charges the worst case when usage is missing, and refuses before sending past the cap', async () => {
    dir = mkdtempSync(join(tmpdir(), 'llm-'));
    const lane = laneFor('cerebras', {});
    expect(lane.model).toBe('gpt-oss-120b');
    const guard = new SpendGuard(lane.id, { inputPerM: 1000, outputPerM: 1000 }, 1, 1, join(dir, 'spend.json'));
    let calls = 0;
    const model = new HttpChatModel(lane, 'k', guard, {
      reasoningEffort: 'low',
      maxCompletionTokens: 500,
      fetchImpl: async () => {
        calls++;
        return reply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
      },
    });
    const turn = await model.chat([{ role: 'user', content: 'x' }], []);
    expect(turn.stats.usage_reported).toBe(false);
    expect(turn.stats.cost_usd).toBeGreaterThanOrEqual(0.5); // 500 completion tokens at $1000/M
    await expect(model.chat([{ role: 'user', content: 'x' }], [])).rejects.toThrow(SpendCapError);
    expect(calls).toBe(1);
  });
});

describe('design session and strategist loop', () => {
  it('scripted rules reach the goal on a roomy board with inset alone', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const evaluator = surrogateEvaluator(design.goal);
    const session = new DesignSession(design, evaluator, { maxSearchSolves: 60, maxConfirmSolves: 2 });
    const result = await runStrategist(session, new ScriptedStrategist(session), { maxTurns: 10 });
    expect(result.ended).toBe('finished');
    const best = session.bestConfirmed()!;
    expect(best.score).toBe(0);
    expect(best.point.enabled).toEqual(['inset']);
    expect(evaluator.count).toBe(session.records.length);
  });

  it('switches on the slot when the patch length runs out', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 16, boardLMm: 14 }); // patch_l at most 8 mm
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 80, maxConfirmSolves: 2 });
    const result = await runStrategist(session, new ScriptedStrategist(session), { maxTurns: 10 });
    expect(result.ended).toBe('finished');
    expect(session.current.enabled).toContain('slot');
    expect(session.bestConfirmed()!.score).toBe(0);
  });

  it('never spends more search solves than the budget, and reports tool mistakes to the model', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 12, maxConfirmSolves: 1 });
    expect(await session.call('optimise', { free: ['board_w'], max_solves: 5 })).toMatchObject({ error: expect.stringContaining('not a tunable variable') });
    expect(await session.call('optimise', { free: ['patch_l', 'inset_d', 'patch_w', 'feed_w', 'slot_l'], max_solves: 50 })).toMatchObject({ error: expect.stringContaining('1 to 4') });
    expect(await session.call('sweep', { variable: 'patch_l', from_mm: 10, to_mm: 12, points: 9 })).toMatchObject({ error: expect.stringContaining('2 to 8') });
    const opt = (await session.call('optimise', { enable: ['inset'], free: ['patch_l', 'inset_d', 'patch_w'], max_solves: 50 })) as Record<string, unknown>;
    expect(opt.solves).toBeLessThanOrEqual(12);
    expect(session.searchSolvesLeft).toBeGreaterThanOrEqual(0);
    const small = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 3, maxConfirmSolves: 0 });
    expect(await small.call('sweep', { variable: 'feed_w', from_mm: 1, to_mm: 2, points: 4 })).toMatchObject({ error: 'needs 4 search solves, 3 left' });
    await session.call('confirm', {});
    expect(await session.call('confirm', {})).toMatchObject({ error: 'no confirm solves left' });
  });

  it('holds search solves back until the first confirm', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 12, maxConfirmSolves: 1 });
    expect(session.searchReserve).toBe(2);
    await session.call('sweep', { variable: 'patch_l', from_mm: 10, to_mm: 12, points: 8 });
    expect(await session.call('sweep', { variable: 'patch_l', from_mm: 13, to_mm: 14, points: 3 })).toMatchObject({ error: 'needs 3 search solves, 2 free (2 more are held until the first confirm)' });
    expect(await session.call('optimise', { free: ['patch_l', 'feed_w'], max_solves: 10 })).toMatchObject({ error: expect.stringContaining('held until the first confirm') });
    await session.call('confirm', {});
    expect(session.searchSolvesFree).toBe(4);
  });

  it('refuses every tool call after finish', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 10, maxConfirmSolves: 1 });
    await session.call('finish', { summary: 'done' });
    expect(await session.call('try_design', {})).toEqual({ error: 'the session has finished; start a new one to keep designing' });
    expect(session.records).toHaveLength(0);
  });

  it('writes a design file to continue from even when an off feature no longer fits', () => {
    const design = parseDesignFile(patchDesign({ goal: GOAL, boardWMm: 20, boardLMm: 20 }));
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 10, maxConfirmSolves: 1 });
    for (const patch_l of [14, 5]) {
      const point = { enabled: ['inset', 'slot'], values: { ...session.current.values, patch_l, inset_d: 2, slot_l: 4, slot_y: 0 } };
      const next = parseDesignFile(JSON.parse(JSON.stringify(designAt(design, point))));
      const resumed = new DesignSession(next, surrogateEvaluator(next.goal), { maxSearchSolves: 10, maxConfirmSolves: 1 });
      expect(resumed.current).toMatchObject({ enabled: ['inset', 'slot'], values: { patch_l, inset_d: 2 } });
      expect(() => resumed.brief()).not.toThrow();
    }
  });

  it('brief lists features, ranges and the budget', () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const brief = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 30, maxConfirmSolves: 2 }).brief();
    expect(Object.keys(brief.features)).toEqual(['inset', 'slot', 'stub', 'chamfer']);
    expect(brief.variables.slot_w).toEqual({ mm: 1, range: 'min 0.5 mm, max patch_l / 4', feature: 'slot' }); // off: range as written
    expect(brief.variables.patch_l).toMatchObject({ max_mm: 18, feature: 'base' });
    expect(brief.locked).toHaveProperty('board_w');
    expect(brief.budget).toEqual({ search_solves: 30, confirm_solves: 2, search_solves_held_until_first_confirm: 5 });
    expect(JSON.stringify(brief).length).toBeLessThan(4000); // tokens on every turn
  });
});

describe('design file', () => {
  it('rejects a feature naming a shape or variable the project lacks', () => {
    const design = JSON.parse(JSON.stringify(patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 })));
    design.features.slot.shapes = ['nope'];
    expect(() => parseDesignFile(design)).toThrow(/no shape "nope"/);
  });

  it('round-trips through JSON with goal defaults filled in', () => {
    const design = JSON.parse(JSON.stringify(patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 })));
    design.goal = { target_ghz: 2.4 };
    expect(parseDesignFile(design).goal).toEqual({ target_ghz: 2.4, s11_max_db: -10, f_tolerance_pct: 1 });
  });
});

describe('MCP server', () => {
  it('answers initialize, lists the tools, serves the brief and reports bad calls as tool errors', async () => {
    const { spawn } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    try {
      const file = join(dir, 'p.design.json');
      writeFileSync(file, JSON.stringify(patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 })));
      const child = spawn(process.execPath, [join(__dirname, '..', 'scripts', 'design-mcp.mjs'), 'mcp', file, '--journal', join(dir, 'j.jsonl')], { cwd: dir });
      const lines = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'brief', arguments: {} } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'optimise', arguments: { free: ['nope'], max_solves: 3 } } },
      ];
      child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      await new Promise((done) => child.on('close', done));
      const replies = out.trim().split('\n').map((l) => JSON.parse(l));
      expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]);
      expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual(['brief', 'try_design', 'sweep', 'optimise', 'sensitivity', 'confirm', 'finish']);
      expect(JSON.parse(replies[2].result.content[0].text).goal.target_ghz).toBe(5.8);
      expect(replies[3].result.isError).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('dip frequency', () => {
  it('lands between frequency samples', () => {
    const fGHz = Float64Array.from({ length: 101 }, (_, k) => 4.35 + 0.029 * k);
    const s11Db = fGHz.map((f) => -20 + 400 * (f - 5.8) ** 2); // a parabola, so the vertex is exact
    expect(metricsFromSpectrum({ fGHz, s11Db }, GOAL).f0_ghz).toBeCloseTo(5.8, 6);
  });
});

describe('strategist loop resilience', () => {
  const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
  const turn = (name: string, args: string) => ({
    message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name, arguments: args } }] },
    stats: { ms: 1, prompt_tokens: 1, completion_tokens: 1, cost_usd: 0, usage_reported: true },
  });

  it('answers non-object arguments with a tool error, and ends cleanly when the model fails', async () => {
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 10, maxConfirmSolves: 0 });
    const seen: string[] = [];
    let calls = 0;
    const model = {
      label: 'test',
      chat: async (messages: Array<Record<string, unknown>>) => {
        const last = messages[messages.length - 1];
        if (last.role === 'tool') seen.push(String(last.content));
        if (++calls === 1) return turn('optimise', 'null');
        if (calls === 2) return turn('sweep', '{not json');
        throw new Error('HTTP 402: out of credit');
      },
    };
    const result = await runStrategist(session, model as never, { maxTurns: 5 });
    expect(seen).toEqual([JSON.stringify({ error: 'arguments must be a JSON object' }), expect.stringContaining('not valid JSON')]);
    expect(result).toMatchObject({ ended: 'model_error', error: 'HTTP 402: out of credit', turns: 2 });
  });

  it('tells a model that stops calling tools how much budget is left, then ends', async () => {
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 7, maxConfirmSolves: 2 });
    const nudges: string[] = [];
    const model = {
      label: 'test',
      chat: async (messages: Array<Record<string, unknown>>) => {
        const last = messages[messages.length - 1];
        if (last.role === 'user' && nudges.length < 3 && messages.length > 2) nudges.push(String(last.content));
        return { message: { role: 'assistant' as const, content: 'I think we are done.' }, stats: turn('x', '{}').stats };
      },
    };
    const result = await runStrategist(session, model as never, { maxTurns: 10 });
    expect(result.ended).toBe('no_tool_call');
    expect(nudges[0]).toContain('7 search solves and 2 confirm solves left');
    expect(session.finished?.summary).toBe('(not called as finish) I think we are done.');
  });
});

describe('closing confirm', () => {
  const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });

  it('confirms the best search design when the strategist stopped without confirming', async () => {
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 40, maxConfirmSolves: 1 });
    await session.call('optimise', { enable: ['inset'], free: ['patch_l', 'inset_d'], max_solves: 30 });
    const bestSearch = session.records.filter((r) => r.fidelity === 'search').sort((a, b) => a.score - b.score)[0];
    await session.call('try_design', { values: { patch_l: 9 } }); // the current design is no longer the best
    const closing = (await session.closingConfirm()) as Record<string, unknown>;
    expect(closing).toMatchObject({ met: true, confirm_solves_left: 0 });
    expect(session.bestConfirmed()!.point).toEqual(bestSearch.point);
    expect(await session.closingConfirm()).toBeNull(); // goal met on the confirm mesh: nothing more to do
  });

  it('prefers the result of an aimed search, ignoring values of switched-off features', async () => {
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 40, maxConfirmSolves: 2 });
    await session.call('optimise', { enable: ['inset'], free: ['patch_l', 'inset_d'], max_solves: 20 });
    await session.call('optimise', { free: ['patch_l'], max_solves: 12, aim_ghz: 5.5 }); // aimed off: worse on the search mesh
    const aimed = session.current;
    const search = session.records.filter((r) => r.fidelity === 'search');
    expect(search.find((r) => JSON.stringify(r.point) === JSON.stringify(aimed))!.score).toBeGreaterThan(Math.min(...search.map((r) => r.score)));
    await session.call('try_design', { values: { slot_l: 4 } }); // the slot is off: the same physical design
    expect(await session.closingConfirm()).toMatchObject({ values_mm: { patch_l: Number(aimed.values.patch_l.toFixed(3)) } });
  });

  it('does nothing without a confirm solve left or a search design', async () => {
    const none = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 10, maxConfirmSolves: 0 });
    await none.call('try_design', {});
    expect(await none.closingConfirm()).toBeNull();
    expect(await new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 10, maxConfirmSolves: 1 }).closingConfirm()).toBeNull();
  });
});

describe('manual driver', () => {
  it('turns typed lines into tool calls, explains bad lines, and fails when input closes', async () => {
    const design = patchDesign({ goal: GOAL, boardWMm: 24, boardLMm: 24 });
    const session = new DesignSession(design, surrogateEvaluator(design.goal), { maxSearchSolves: 10, maxConfirmSolves: 1 });
    const printed: string[] = [];
    async function* typed() {
      yield 'brief';
      yield 'try_design []';
      yield 'frobnicate {}';
      yield 'try_design {"values": {"patch_l": 11}';
      yield 'try_design {"enable": ["inset"]}';
    }
    const result = await runStrategist(session, new ManualDriver(typed(), (t) => printed.push(t)), { maxTurns: 5 });
    expect(printed.join('\n')).toContain('Brief:');
    expect(printed.filter((p) => p.startsWith('< {"goal"'))).toHaveLength(1); // the brief tool's result is shown too
    expect(printed).toContain('< {"error":"arguments must be a JSON object"}');
    expect(printed).toContain('unknown tool frobnicate; tools: brief, try_design, sweep, optimise, sensitivity, confirm, finish');
    expect(printed.some((p) => p.startsWith('arguments are not valid JSON'))).toBe(true);
    expect(session.current.enabled).toEqual(['inset']);
    expect(result).toMatchObject({ ended: 'model_error', error: 'input closed before finish', turns: 3, costUsd: 0 });
  });
});
