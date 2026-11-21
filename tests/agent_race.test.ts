import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendToInbox, InboxReader } from '../src/design/inbox';
import { laneFor } from '../src/design/llm';
import { startModelProxy, type ProxyCall } from '../src/design/model_proxy';
import { laneJournal, openClawConfig, scrubbedEnv } from '../src/design/openclaw_lane';
import { describeCall, replayFromJournal } from '../src/design/replay';
import { SpendGuard } from '../src/design/spend';
import { designFromRequest, parseDesignRequest, sizingNote } from '../src/design/start_design';
import { startFakeProvider } from './fake_provider';

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-race-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('start_design', () => {
  it('turns a request into a goal and a patch on the named substrate, with defaults for what it leaves out', () => {
    const request = parseDesignRequest({ target_ghz: 2.4, board_w_mm: 40, board_l_mm: 40 });
    expect(request).toMatchObject({ substrate: 'FR-4', thickness_mm: 1.6, s11_max_db: -10 });
    expect(request.min_bandwidth_mhz).toBeUndefined();
    const design = designFromRequest(request);
    expect(design.goal).toEqual({ target_ghz: 2.4, s11_max_db: -10, f_tolerance_pct: 1 });
    expect(design.project.stackup.find((l) => l.type === 'dielectric')).toMatchObject({ material: 'FR-4', thickness: '1.6 mm' });
  });

  it('sizes the patch from the substrate it simulates, so a lower permittivity gives a larger patch', () => {
    const patchL = (substrate: string) => {
      const d = designFromRequest(parseDesignRequest({ target_ghz: 5.8, board_w_mm: 30, board_l_mm: 30, substrate, thickness_mm: 0.813 }));
      return parseFloat(d.project.variables.patch_l.value);
    };
    expect(patchL('RO4003C')).toBeGreaterThan(patchL('FR-4'));
  });

  it('refuses what the solver cannot build, with a message the model can act on', () => {
    expect(() => parseDesignRequest({ target_ghz: 60, board_w_mm: 30, board_l_mm: 30 })).toThrow(/target_ghz must be between/);
    expect(() => parseDesignRequest({ target_ghz: 2.4, board_w_mm: 30 })).toThrow(/board_l_mm must be a number/);
    expect(() => parseDesignRequest({ target_ghz: 2.4, board_w_mm: 30, board_l_mm: 30, substrate: 'unobtainium' })).toThrow(/substrate must be one of FR-4, RO4003C/);
    expect(() => parseDesignRequest({ target_ghz: 2.4, board_w_mm: 30, board_l_mm: 30, colour: 'red' })).toThrow(/unknown argument: colour/);
    expect(() => designFromRequest(parseDesignRequest({ target_ghz: 2.4, board_w_mm: 9, board_l_mm: 9 }))).toThrow(/no room/);
  });

  it('builds a valid start on a board far smaller than the textbook patch, and says so', () => {
    const request = parseDesignRequest({ target_ghz: 1, board_w_mm: 12, board_l_mm: 12 });
    expect(() => designFromRequest(request)).not.toThrow(); // the feed starts no wider than a third of the clamped patch
    expect(sizingNote(request)).toMatchObject({ fits_board: false, note: expect.stringMatching(/clamped/) });
    expect(sizingNote(parseDesignRequest({ target_ghz: 5.8, board_w_mm: 30, board_l_mm: 30 })).fits_board).toBe(true);
  });

  it('reads well in the race view', () => {
    expect(describeCall('start_design', JSON.stringify({ target_ghz: 2.4, board_w_mm: 30, board_l_mm: 30, min_bandwidth_mhz: 100 })))
      .toBe('start: 2.4 GHz on a 30 x 30 mm FR-4 board, 100 MHz wide');
  });
});

describe('MCP server from a sentence', () => {
  it('offers start_design first, refuses other tools until it is called, then serves the brief and saves the design', async () => {
    const dir = tempDir();
    const out = join(dir, 'session');
    const child = spawn(process.execPath, [join(__dirname, '..', 'scripts', 'design-mcp.mjs'), 'mcp', '--out', out], { cwd: dir });
    const call = (id: number, name: string, args: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      call(2, 'optimise', { free: ['patch_l'] }),
      call(3, 'start_design', { target_ghz: 99, board_w_mm: 30, board_l_mm: 30 }),
      call(4, 'start_design', { target_ghz: 2.4, board_w_mm: 40, board_l_mm: 40 }),
      call(5, 'start_design', { target_ghz: 2.4, board_w_mm: 40, board_l_mm: 40 }),
      call(6, 'brief', {}),
    ];
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    await new Promise((done) => child.on('close', done));
    const replies = stdout.trim().split('\n').map((l) => JSON.parse(l));
    const text = (id: number) => JSON.parse(replies.find((r) => r.id === id).result.content[0].text);
    expect(replies[0].result.tools[0].name).toBe('start_design');
    expect(text(2).error).toMatch(/call start_design/);
    expect(text(3).error).toMatch(/target_ghz must be between/);
    expect(text(4).goal.target_ghz).toBe(2.4);
    expect(text(5).error).toMatch(/already been started/);
    expect(text(6).variables.patch_l).toBeDefined();
    expect(existsSync(join(out, 'design.json'))).toBe(true);
    const journal = readFileSync(join(out, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(journal).toEqual([expect.objectContaining({ type: 'tool', name: 'start_design' })]);
  }, 60_000);
});

describe('talking to it mid-run', () => {
  it('hands what the person wrote to the model with the next tool result, allows a restart after it, and holds finish for it', async () => {
    const dir = tempDir();
    const out = join(dir, 'session');
    const inbox = join(dir, 'inbox.jsonl');
    const child = spawn(process.execPath, [join(__dirname, '..', 'scripts', 'design-mcp.mjs'), 'mcp', '--out', out, '--inbox', inbox], { cwd: dir });
    let stdout = '';
    const waiting = new Map<number, (r: { result: { content: Array<{ text: string }> } }) => void>();
    child.stdout.on('data', (c) => {
      stdout += c;
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const reply = JSON.parse(stdout.slice(0, nl));
        stdout = stdout.slice(nl + 1);
        waiting.get(reply.id)?.(reply);
      }
    });
    let id = 0;
    const call = (name: string, args: object = {}) => new Promise<Record<string, unknown>>((done) => {
      const n = ++id;
      waiting.set(n, (r) => done(JSON.parse(r.result.content[0].text)));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });

    appendToInbox(inbox, 'actually make it 5.8 GHz');
    const first = await call('start_design', { target_ghz: 2.4, board_w_mm: 40, board_l_mm: 40 });
    expect(first.person_says).toEqual(['actually make it 5.8 GHz']);
    expect(first.note).toMatch(/start_design again/);
    const restart = await call('start_design', { target_ghz: 5.8, board_w_mm: 40, board_l_mm: 40 });
    expect((restart.goal as { target_ghz: number }).target_ghz).toBe(5.8);
    expect((await call('start_design', { target_ghz: 3, board_w_mm: 40, board_l_mm: 40 })).error).toMatch(/already been started/);
    appendToInbox(inbox, 'that will do, stop there');
    expect(await call('finish', { summary: 'done' })).toMatchObject({ finished: false, person_says: ['that will do, stop there'] });
    expect((await call('finish', { summary: 'done' })).person_says).toBeUndefined();
    child.stdin.end();
    await new Promise((done) => child.on('close', done));
    const journal = readFileSync(join(out, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(journal.filter((e) => e.type === 'say').map((e) => [e.text, typeof e.said_at])).toEqual([
      ['actually make it 5.8 GHz', 'number'], ['that will do, stop there', 'number'],
    ]);
    expect(JSON.parse(readFileSync(join(out, 'design.json'), 'utf8')).goal.target_ghz).toBe(5.8);
  }, 60_000);

  it('shows the message in the replay when it was written, and judges a restart by the new goal only', () => {
    const metrics = (s11: number) => ({ f0_ghz: 5.8, s11_min_db: s11, s11_at_target_db: s11, bandwidth_mhz: 200, bandwidth_open: false });
    const solve = (t_ms: number, fidelity: 'search' | 'confirm', s11: number, score: number) => ({ t_ms, type: 'solve' as const, record: { fidelity, score, metrics: metrics(s11) } });
    const model = (t_ms: number, name: string, args: object = {}) => ({ t_ms, type: 'model' as const, stats: { ms: 100, completion_tokens: 10 }, text: null, tool_calls: [{ name, arguments: JSON.stringify(args) }] });
    const log = replayFromJournal([
      model(100, 'start_design', { target_ghz: 2.4, board_w_mm: 40, board_l_mm: 40 }),
      { t_ms: 150, type: 'tool', name: 'start_design', goal: { target_ghz: 2.4, s11_max_db: -10, f_tolerance_pct: 1 } },
      solve(400, 'confirm', -20, 0), // met the old goal: must not count for the new one
      { t_ms: 450, type: 'say', text: 'make it 5.8 GHz', heard_ms: 500 },
      { t_ms: 500, type: 'tool', name: 'confirm' },
      model(600, 'start_design', { target_ghz: 5.8, board_w_mm: 40, board_l_mm: 40 }),
      { t_ms: 650, type: 'tool', name: 'start_design', goal: { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 } },
      solve(900, 'search', -6, 3),
 { t_ms: 950, type: 'tool', name: 'optimise' },
      model(1000, 'finish'),
      { t_ms: 1010, type: 'tool', name: 'finish' },
    ], { laneLabel: 'Kimi K3.1 Pro on Cerebras', goal: { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 }, modelS: 0.2, costUsd: 0 });
    expect(log.events.find((e) => e.type === 'say')).toEqual({ time_ms: 450, type: 'say', text: 'make it 5.8 GHz' });
    expect(log.events.filter((e) => e.type === 'edit').map((e) => e.edit)).toEqual(['start: 2.4 GHz on a 40 x 40 mm FR-4 board', 'restart: 5.8 GHz on a 40 x 40 mm FR-4 board', 'finish']);
    expect(log.result).toMatchObject({ met: false, mesh: 'search', s11_db_at_target: -6 });
    // Each goal from when it was set, and when the model got the message (after the confirm it interrupted returned).
    expect(log.events.filter((e) => e.type === 'goal').map((e) => [e.time_ms, e.task?.slice(0, 13)])).toEqual([[150, 'design a 2.4 '], [650, 'design a 5.8 ']]);
    const order = log.events.map((e) => e.type);
    expect(order.indexOf('heard')).toBeGreaterThan(order.indexOf('say'));
    expect(log.events.find((e) => e.type === 'heard')?.time_ms).toBe(500);
    expect(log.events.filter((e) => e.type === 'solve_done').at(-1)?.model_thinking).toBe(false); // after finish: no more thinking
  });

  it('reads only whole lines, and each message once', () => {
    const dir = tempDir();
    const file = join(dir, 'inbox.jsonl');
    const reader = new InboxReader(file);
    expect(reader.take()).toEqual([]);
    appendToInbox(file, 'one');
    writeFileSync(file, '{"t":1,"text":"half', { flag: 'a' });
    expect(reader.take().map((m) => m.text)).toEqual(['one']);
    writeFileSync(file, '"}\n', { flag: 'a' });
    expect(reader.peek().map((m) => m.text)).toEqual(['half']);
    expect(reader.take().map((m) => m.text)).toEqual(['half']);
    expect(reader.take()).toEqual([]);
    expect(() => appendToInbox(file, '   ')).toThrow(/empty/);
  });
});

describe('model proxy', () => {
  const guardFor = (dir: string, runCap = 0.5) => new SpendGuard('cerebras', { inputPerM: 3, outputPerM: 12 }, runCap, 4, join(dir, 'ledger.json'));

  it('forwards with the real key and the lane model, reads the tool calls and usage from the stream, and settles the spend', async () => {
    const dir = tempDir();
    const provider = await startFakeProvider({ timeInfo: { queue_time: 0.8, prompt_time: 0.01, completion_time: 0.1, total_time: 0.91, created: 1 } });
    const guard = guardFor(dir);
    const lane = laneFor('cerebras', { CEREBRAS_MODEL: 'moonshotai-kimi-k3.1-pro-trial' });
    const proxy = await startModelProxy({ lane, apiKey: 'real-key', guard, reasoningEffort: 'high', maxCompletionTokens: 4096, upstream: provider.url });
    try {
      const wrongKey = await fetch(`${proxy.url}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer guess' }, body: '{}' });
      expect(wrongKey.status).toBe(401); // another local process cannot spend through the proxy
      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.key}` },
        body: JSON.stringify({ model: 'model', stream: true, max_tokens: 100000, n: 4, messages: [{ role: 'user', content: 'a 5.8 GHz patch' }], tools: [{ type: 'function', function: { name: 'noburf__start_design' } }] }),
      });
      const text = await response.text();
      expect(text).toContain('noburf__start_design'); // streamed through untouched
      expect(provider.requests[0]).toMatchObject({ model: 'moonshotai-kimi-k3.1-pro-trial', reasoning_effort: 'high', stream_options: { include_usage: true }, max_completion_tokens: 4096 });
      // The budget the guard reserved is the only one the provider sees, for one completion.
      expect(provider.requests[0]).not.toHaveProperty('max_tokens');
      expect(provider.requests[0]).not.toHaveProperty('n');
      const [call] = proxy.calls;
      expect(call).toMatchObject({ http_status: 200, prompt_tokens: 1000, completion_tokens: 200, reasoning_tokens: 150, usage_reported: true, finish_reason: 'tool_calls' });
      // Cerebras's own timing is kept, and the last streamed token is timed so generation can leave the queue out.
      expect(call.server_timing).toEqual({ queue_s: 0.8, prompt_s: 0.01, completion_s: 0.1, total_s: 0.91 });
      expect(call.last_token_ms).toBeGreaterThanOrEqual(call.time_to_first_token_ms!);
      expect(call.tool_calls).toEqual([{ name: 'noburf__start_design', arguments: JSON.stringify({ target_ghz: 5.8, board_w_mm: 24, board_l_mm: 24, substrate: 'FR-4' }) }]);
      // Settled to tokens x price, not the 4096-token worst case reserved before the call.
      expect(call.cost_usd).toBeCloseTo((1000 * 3 + 200 * 12) / 1e6, 9);
      expect(guard.spentThisRun).toBeCloseTo(call.cost_usd, 9);
      expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8')).providers.cerebras.spent_usd).toBeCloseTo(call.cost_usd, 9);
    } finally {
      await proxy.close();
      await provider.close();
    }
  });

  it('holds the first request until the race says go, and times the call from then', async () => {
    const dir = tempDir();
    const provider = await startFakeProvider();
    let go!: () => void;
    const holdUntil = new Promise<void>((resolve) => (go = resolve));
    const seen: string[] = [];
    const guard = guardFor(dir);
    const proxy = await startModelProxy({
      lane: laneFor('cerebras'), apiKey: 'k', guard, reasoningEffort: 'high', maxCompletionTokens: 1024, upstream: provider.url,
      holdUntil, onFirstRequest: () => seen.push('arrived'), onFirstForward: () => seen.push('forwarded'),
    });
    try {
      const answer = fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.key}` },
        body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(seen).toEqual(['arrived']);
      expect(provider.requests).toHaveLength(0); // held: nothing sent, nothing reserved
      expect(guard.spentThisRun).toBe(0);
      const releasedAt = Date.now();
      go();
      expect((await answer).status).toBe(200);
      expect(seen).toEqual(['arrived', 'forwarded']);
      expect(proxy.firstArrivalAt).toBeLessThan(releasedAt - 250);
      expect(proxy.calls[0].started_at).toBeGreaterThanOrEqual(releasedAt);
    } finally {
      await proxy.close();
      await provider.close();
    }
  });

  it('answers 402 without calling the provider when the next call could pass the run cap', async () => {
    const dir = tempDir();
    const provider = await startFakeProvider();
    const proxy = await startModelProxy({ lane: laneFor('cerebras', {}), apiKey: 'k', guard: guardFor(dir, 0.01), reasoningEffort: 'low', maxCompletionTokens: 16384, upstream: provider.url });
    try {
      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.key}` },
        body: JSON.stringify({ model: 'model', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(402);
      expect((await response.json()).error.message).toMatch(/run spend cap/);
      expect(provider.requests).toHaveLength(0);
      expect(proxy.calls[0]).toMatchObject({ http_status: 402, cost_usd: 0 });
    } finally {
      await proxy.close();
      await provider.close();
    }
  });
});

describe('model proxy settlement', () => {
  const guardFor = (dir: string) => new SpendGuard('cerebras', { inputPerM: 3, outputPerM: 12 }, 0.5, 4, join(dir, 'ledger.json'));
  /** A provider that answers every call with handler, and records each request body. */
  async function upstream(handler: (res: http.ServerResponse) => void) {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      bodies.push(JSON.parse(text));
      handler(res);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      bodies,
      close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
    };
  }
  async function oneCall(handler: (res: http.ServerResponse) => void, body: Record<string, unknown> = {}, holdUntil?: Promise<boolean | void>) {
    const dir = tempDir();
    const provider = await upstream(handler);
    const guard = guardFor(dir);
    const proxy = await startModelProxy({ lane: laneFor('cerebras'), apiKey: 'real-key', guard, reasoningEffort: 'low', maxCompletionTokens: 1024, upstream: provider.url, holdUntil });
    try {
      const response = await fetch(`${proxy.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.key}` },
        body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'hi' }], ...body }),
      }).then(async (r) => ({ status: r.status, text: await r.text().catch((e: Error) => e.message) }), (e: Error) => ({ status: 0, text: e.message }));
      return { response, call: proxy.calls[0], guard, bodies: provider.bodies };
    } finally {
      await proxy.close();
      await provider.close();
    }
  }
  const json = (status: number, body: unknown) => (res: http.ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  it('releases a refused call (429) and keeps the worst case for a server error (500), scrubbing the key from both', async () => {
    const refused = await oneCall(json(429, { error: { message: 'slow down, real-key' } }));
    expect(refused.call).toMatchObject({ http_status: 429, cost_usd: 0 });
    expect(refused.guard.spentThisRun).toBe(0);
    const failed = await oneCall(json(500, { error: { message: 'boom for real-key' } }));
    expect(failed.call.cost_usd).toBeGreaterThan(0);
    expect(failed.guard.spentThisRun).toBeCloseTo(failed.call.cost_usd, 12); // may have been billed: the worst case stays
    for (const { response, call } of [refused, failed]) {
      expect(response.text).not.toContain('real-key');
      expect(response.text).toContain('[key]');
      expect(call.error).not.toContain('real-key');
    }
  });

  it('settles a non-streamed answer to its tokens, or to its reported cost when that is higher', async () => {
    const byTokens = await oneCall(json(200, { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
    expect(byTokens.call).toMatchObject({ usage_reported: true, prompt_tokens: 1000, completion_tokens: 100, finish_reason: 'stop' });
    expect(byTokens.call.cost_usd).toBeCloseTo((1000 * 3 + 100 * 12) / 1e6, 12);
    expect(byTokens.guard.spentThisRun).toBeCloseTo(byTokens.call.cost_usd, 12);
    const reported = await oneCall(json(200, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.01 } }));
    expect(reported.call.cost_usd).toBe(0.01);
    const under = await oneCall(json(200, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0.000001 } }));
    expect(under.call.cost_usd).toBeCloseTo((1000 * 3 + 100 * 12) / 1e6, 12); // a cost below tokens x price is not trusted
  });

  it('keeps the worst case when the answer has no usage, or the stream is cut off', async () => {
    const noUsage = await oneCall(json(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    expect(noUsage.call.usage_reported).toBe(false);
    expect(noUsage.call.cost_usd).toBeGreaterThan(0);
    expect(noUsage.guard.spentThisRun).toBeCloseTo(noUsage.call.cost_usd, 12);
    const cut = await oneCall((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'part' } }] })}\n\n`);
      setTimeout(() => res.destroy(), 50);
    }, { stream: true });
    expect(cut.guard.spentThisRun).toBeGreaterThan(0); // sent and partly answered: may have been billed
  });

  it('passes only the fields a chat turn needs, so a provider extra cannot bill past the reservation', async () => {
    const { bodies } = await oneCall(json(200, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      temperature: 0.2, tools: [], models: ['some/fallback'], plugins: [{ id: 'web' }], transforms: ['middle-out'], provider: { order: ['x'] },
    });
    expect(bodies[0]).toMatchObject({ temperature: 0.2, tools: [], messages: [{ role: 'user', content: 'hi' }] });
    for (const field of ['models', 'plugins', 'transforms']) expect(bodies[0]).not.toHaveProperty(field);
  });

  it('never sends a held request when the race says not to go', async () => {
    const { response, guard, bodies, call } = await oneCall(json(200, {}), {}, Promise.resolve(false));
    expect(response.status).toBe(503);
    expect(bodies).toHaveLength(0);
    expect(call).toBeUndefined();
    expect(guard.spentThisRun).toBe(0);
  });
});

describe('OpenClaw lane', () => {
  it('gives OpenClaw only the proxy URL and a placeholder key, and only the NobuRF tools', () => {
    const config = openClawConfig({ proxyUrl: 'http://127.0.0.1:1/v1', proxyKey: 'noburf-proxy-abc', mcpArgs: ['design-mcp.mjs', 'mcp', '--out', 's'], modelName: 'kimi', maxTokens: 8192, timeoutS: 1800 });
    const text = JSON.stringify(config);
    expect(text).not.toMatch(/CEREBRAS_API_KEY|OPENROUTER_API_KEY/);
    expect(config.models.providers['noburf-lane']).toMatchObject({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'noburf-proxy-abc' });
    expect(config.tools).toMatchObject({ profile: 'minimal', toolSearch: false });
  });

  it('starts the harness with system variables only, so no key or token under any name reaches it', () => {
    const env = scrubbedEnv({
      PATH: '/bin', HOME: '/home/j', SystemRoot: 'C:\\Windows', TEMP: '/tmp', LC_ALL: 'C',
      CEREBRAS_API_KEY: 'a', OPENROUTER_API_KEY: 'b', GITHUB_TOKEN: 'c', AWS_ACCESS_KEY_ID: 'd', STRIPE_KEY: 'e', GH_PAT: 'f', NOBURF_SPEND_LEDGER: 'l',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/j', SystemRoot: 'C:\\Windows', TEMP: '/tmp', LC_ALL: 'C' });
  });

  it('pins OpenClaw to the proxy model: no other providers and no fallbacks', () => {
    const config = openClawConfig({ proxyUrl: 'http://127.0.0.1:1/v1', proxyKey: 'k', mcpArgs: [], modelName: 'kimi', maxTokens: 8192, timeoutS: 1800 });
    expect(config.models.mode).toBe('replace');
    expect(config.agents.defaults.model).toEqual({ primary: 'noburf-lane/model', fallbacks: [] });
  });

  it('merges model calls and MCP entries into one journal on the lane clock, which the replay reads', () => {
    const t0 = 1_000_000;
    const call = (start: number, end: number, status: number, tools: string[] = []): ProxyCall => ({
      started_at: t0 + start, ended_at: t0 + end, http_status: status, time_to_first_token_ms: null, prompt_tokens: 10, completion_tokens: 100,
      reasoning_tokens: null, usage_reported: true, cost_usd: 0, tool_calls: tools.map((name) => ({ name: `noburf__${name}`, arguments: '{}' })),
    });
    const metrics = { f0_ghz: 5.8, s11_min_db: -12, s11_at_target_db: -12, bandwidth_mhz: 200, bandwidth_open: false };
    const journal = laneJournal(
      // The 429 answers in 50 ms; the harness backs off until 3000 ms. The wait is the whole gap.
      [call(9000, 9500, 200, ['finish']), call(0, 900, 200, ['start_design']), call(1000, 1050, 429), call(3000, 4000, 200, ['confirm'])],
      [
        { t: t0 + 950, type: 'tool', name: 'start_design', ms: 50 },
        { t: t0 + 8900, type: 'solve', record: { fidelity: 'confirm', point: { enabled: [], values: {} }, metrics, score: 0 } },
        { t: t0 + 8900, type: 'tool', name: 'confirm', ms: 4900 },
      ],
      t0,
    );
    expect(journal.map((e) => e.type)).toEqual(['model', 'tool', 'model', 'solve', 'tool', 'model']);
    const models = journal.filter((e) => e.type === 'model') as Array<{ stats: { ms: number; retry_wait_ms?: number }; tool_calls: Array<{ name: string }> }>;
    expect(models.map((m) => m.tool_calls[0].name)).toEqual(['start_design', 'confirm', 'finish']);
    expect(models[1].stats).toMatchObject({ ms: 1000, retry_wait_ms: 2000 }); // the rate-limited attempt shows as a wait
    const log = replayFromJournal(journal, { laneLabel: 'Kimi K3.1 Pro on Cerebras', goal: { target_ghz: 5.8, s11_max_db: -10, f_tolerance_pct: 1 }, modelS: 3.4, costUsd: 0, prompt: 'a 5.8 GHz patch', toolsS: 4.95 });
    expect(log).toMatchObject({ prompt: 'a 5.8 GHz patch', tools_s: 4.95, result: { met: true, mesh: 'confirm' } });
    expect(log.events.filter((e) => e.type === 'model_turn_done').map((e) => e.model_ms)).toEqual([900, 1000, 500]);
    expect(log.events.filter((e) => e.type === 'model_turn_done').map((e) => e.wait_ms)).toEqual([undefined, 2000, undefined]);
    expect(log.events.find((e) => e.type === 'edit')?.edit).toBe('start the design');
    // The confirm's own result keeps the lane on Solving; the tool's end hands the turn back to the model.
    expect(log.events.filter((e) => e.type === 'solve_done' && e.time_ms === 8900).map((e) => e.model_thinking)).toEqual([undefined, true]);
  });
});
