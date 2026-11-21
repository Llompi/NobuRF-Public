import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serverTiming, type ProxyCall } from '../src/design/model_proxy';
import { laneDirsIn, ledgerEntryFor, ledgerReport, modelTiming } from '../src/design/run_ledger';

const call = (over: Partial<ProxyCall>): ProxyCall => ({
  started_at: 0, ended_at: 1000, http_status: 200, time_to_first_token_ms: 200, prompt_tokens: 100, completion_tokens: 400,
  reasoning_tokens: 0, usage_reported: true, cost_usd: 0, tool_calls: [], ...over,
});

function lane(dir: string, model: string, wallS: number, calls: ProxyCall[], standIn = false) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    sentence: 'a 5.8 GHz patch', harness: 'OpenClaw', model, reasoning_effort: 'high', solver: 'WGSL (GPU)', ended: 'finished',
    ...(standIn ? { stand_in_provider: true } : {}),
    best_confirmed: { met: true, score: 0, metrics: { f0_ghz: 5.79, s11_min_db: -14.2 } },
    timing: { wall_s: wallS, model_s: wallS - 20, tools_s: 20, rate_limit_wait_s: 0, harness_startup_s: 11, model_turns: calls.length },
    tokens: { prompt: 1000, completion: 800, reasoning: 300 }, cost_usd: 0.01,
  }));
  writeFileSync(join(dir, 'model-calls.json'), JSON.stringify(calls));
}

describe('model timing split', () => {
  it('splits each call into the wait for the first token and generation to the last token', () => {
    const m = modelTiming([
      // 40 s in the queue, then 1 s of generation, then 0.5 s until the connection closed
      call({ started_at: 0, ended_at: 41500, time_to_first_token_ms: 40000, last_token_ms: 41000, completion_tokens: 2000 }),
      call({ started_at: 0, ended_at: 600, time_to_first_token_ms: 100, last_token_ms: 600, completion_tokens: 1000 }),
      call({ http_status: 429, completion_tokens: null, time_to_first_token_ms: null }),
    ]);
    expect(m.wait_s).toBe(40.1);
    expect(m.generation_s).toBe(1.5);
    expect(m.generation_tokens_per_s).toBe(2000); // 3000 tokens over 1.5 s, the queue left out
    expect(m.median_first_token_s).toBe(20.05);
    expect(m.server).toBeNull();
  });

  it('leaves burst replies out of tokens per second and counts calls with no streamed token as wait', () => {
    const m = modelTiming([call({ ended_at: 201, time_to_first_token_ms: 200, last_token_ms: 201 }), call({ ended_at: 3000, time_to_first_token_ms: null })]);
    expect(m.generation_tokens_per_s).toBeNull();
    expect(m.wait_s).toBe(3.2);
    expect(m.calls_unmeasured).toBe(1);
  });

  it("sums the provider's own timing when it reports one", () => {
    expect(serverTiming({ queue_time: 38.2, prompt_time: 0.05, completion_time: 0.45, total_time: 38.7, created: 1 })).toEqual({ queue_s: 38.2, prompt_s: 0.05, completion_s: 0.45, total_s: 38.7 });
    expect(serverTiming({ created: 1 })).toBeNull();
    expect(serverTiming(null)).toBeNull();
    const m = modelTiming([
      call({ completion_tokens: 900, server_timing: { queue_s: 30, prompt_s: 0.1, completion_s: 0.4 } }),
      call({ completion_tokens: 600, server_timing: { queue_s: 10, prompt_s: 0.1, completion_s: 0.2 } }),
      call({}),
    ]);
    expect(m.server).toEqual({ calls: 2, queue_s: 40, prompt_s: 0.2, completion_s: 0.6, completion_tokens_per_s: 2500 });
  });
});

describe('run ledger', () => {
  it('reads a race folder into one line per lane and compares the lanes with and without the queue', () => {
    const race = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'race-2026-11-21T20-00-00');
    // Cerebras: a long queue but fast generation. The GPU host: no queue, slow generation.
    lane(join(race, 'cerebras'), 'kimi on cerebras', 80, [call({ ended_at: 51000, time_to_first_token_ms: 50000, last_token_ms: 51000, completion_tokens: 2000 })]);
    lane(join(race, 'openrouter'), 'kimi on openrouter', 60, [call({ ended_at: 20500, time_to_first_token_ms: 500, last_token_ms: 20500, completion_tokens: 2000, served_by: 'HostA' })]);
    const dirs = laneDirsIn(race);
    expect(dirs.map((d) => d.split(/[\\/]/).pop())).toEqual(['cerebras', 'openrouter']);
    const entries = dirs.map((d) => ledgerEntryFor(d, { command: 'npm run design -- agent-race', openclawVersion: 'OpenClaw 2026.11.5', recording: null, now: new Date(0) })!);
    expect(entries[0]).toMatchObject({ lane: 'cerebras', race_dir: race, goal_met: true, best: { f0_ghz: 5.79, s11_db: -14.2 } });
    expect(entries[0].model_timing).toMatchObject({ wait_s: 50, generation_s: 1, generation_tokens_per_s: 2000 });
    expect(entries[1]).toMatchObject({ lane: 'openrouter', served_by: ['HostA'] });
    expect(entries[1].model_timing.generation_tokens_per_s).toBe(100);
    // Generation 20x faster on Cerebras even though its wall time is longer, and both are shown.
    expect(ledgerReport(entries)).toContain('| race-2026-11-21T20-00-00 | a 5.8 GHz patch | 1 / 20 | 20x | 2000 / 100 | 50 / 0.5 | 80 / 60 | 0.8x |  |');
  });

  it('names a single run by its lane and labels stand-in runs so they are never read as results', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'cerebras-2026-11-21T20-00-00');
    lane(dir, 'kimi on cerebras', 21, [call({})], true);
    const entry = ledgerEntryFor(dir, { command: 'x', openclawVersion: null, recording: null })!;
    expect(entry).toMatchObject({ lane: 'cerebras', race_dir: null, stand_in_provider: true });
    expect(ledgerReport([entry])).toContain('stand-in model, not a result');
  });

  it('skips a folder without a summary', () => {
    expect(ledgerEntryFor(mkdtempSync(join(tmpdir(), 'ledger-')), { command: 'x', openclawVersion: null, recording: null })).toBeNull();
  });
});
