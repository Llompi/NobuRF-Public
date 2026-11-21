import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { startBridge, type Bridge } from '../server/bridge';
import type { BridgeToClient, SimTelemetry } from '../src/engine/types';

const fakeTelemetry = (it: number): SimTelemetry => ({
  it, target_ghz: 5.8, f0_ghz: 5.6, s11_min_db: -12, s11_at_target_db: -4, zin_target: [40, -10],
  bw10_ghz: 0.1, curve: [], solve_ms: 5, steps: 3000, warn: [],
});

/** Stand-in for the browser: answers every run with fake telemetry. */
async function fakeBrowser(port: number, behave: 'ok' | 'error' | 'silent' = 'ok'): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/sim-client`);
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'hello', adapter: 'fake' }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as BridgeToClient;
    if (msg.type !== 'run' || behave === 'silent') return;
    if (behave === 'error') ws.send(JSON.stringify({ type: 'error', id: msg.id, message: 'boom' }));
    // Deep inset = matched, so race tests can trigger a match.
    else ws.send(JSON.stringify({ type: 'result', id: msg.id, telemetry: {
      ...fakeTelemetry(msg.it), s11_at_target_db: msg.dsl.feed.inset_depth_mm >= 4 ? -20 : -4 } }));
  });
  return ws;
}

describe('bridge', () => {
  let b: Bridge;
  const url = (p: string) => `http://127.0.0.1:${b.port}${p}`;
  const post = (p: string, body: unknown) =>
    fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(async () => {
    b = await startBridge({ port: 0, solveTimeoutMs: 500, log: () => undefined });
  });
  afterEach(async () => {
    await b.close();
  });

  it('503s with a helpful message when no browser is connected', async () => {
    const r = await post('/api/apply_edit', { inset_depth_mm: 3 });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/no browser/);
  });

  it('round-trips an edit and commits state only on success', async () => {
    const ws = await fakeBrowser(b.port);
    const r = await post('/api/apply_edit', { inset_depth_mm: 3 });
    expect(r.status).toBe(200);
    expect((await r.json()).it).toBe(1);
    const st = await (await fetch(url('/api/state'))).json();
    expect(st.geometry.feed.inset_depth_mm).toBe(3);
    expect(st.it).toBe(1);

    const bad = await post('/api/apply_edit', { inset_depth_mm: -5 });
    expect(bad.status).toBe(422);
    const st2 = await (await fetch(url('/api/state'))).json();
    expect(st2.geometry.feed.inset_depth_mm).toBe(3);
    ws.close();
  });

  it('serialises concurrent edits in order', async () => {
    const ws = await fakeBrowser(b.port);
    const rs = await Promise.all([1, 2, 3].map((d) => post('/api/apply_edit', { inset_depth_mm: d })));
    const its = await Promise.all(rs.map(async (r) => (await r.json()).it));
    expect(its).toEqual([1, 2, 3]);
    const st = await (await fetch(url('/api/state'))).json();
    expect(st.geometry.feed.inset_depth_mm).toBe(3);
    ws.close();
  });

  it('times out a stuck browser without committing, and tells the page to discard the run', async () => {
    const ws = await fakeBrowser(b.port, 'silent');
    const received: BridgeToClient[] = [];
    ws.on('message', (raw) => received.push(JSON.parse(String(raw)) as BridgeToClient));
    const r = await post('/api/apply_edit', { inset_depth_mm: 2 });
    expect(r.status).toBe(504);
    const st = await (await fetch(url('/api/state'))).json();
    expect(st.it).toBe(0);
    const run = received.find((m) => m.type === 'run');
    expect(received).toContainEqual({ type: 'discard', id: run && run.type === 'run' ? run.id : 'missing' });
    ws.close();
  });

  it('closes an older tab with the "replaced" code when a newer tab connects', async () => {
    const olderTab = await fakeBrowser(b.port);
    const closed = new Promise<number>((resolve) => olderTab.once('close', (code) => resolve(code)));
    const newerTab = await fakeBrowser(b.port);
    expect(await closed).toBe(4000);
    expect((await post('/api/apply_edit', { inset_depth_mm: 3 })).status).toBe(200);
    newerTab.close();
  });

  it('surfaces a browser-side solver error', async () => {
    const ws = await fakeBrowser(b.port, 'error');
    const r = await post('/api/apply_edit', { inset_depth_mm: 2 });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/boom/);
    ws.close();
  });

  it('reset returns to the baseline and iteration 0', async () => {
    const ws = await fakeBrowser(b.port);
    await post('/api/apply_edit', { inset_depth_mm: 2 });
    const r = await post('/api/reset', {});
    expect((await r.json()).it).toBe(0);
    const st = await (await fetch(url('/api/state'))).json();
    expect(st.geometry.feed.inset_depth_mm).toBe(0);
    ws.close();
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const json = { 'content-type': 'application/json' };
    const r = await fetch(url('/api/apply_edit'), { method: 'POST', headers: json, body: '{nope' });
    expect(r.status).toBe(400);
    const big = await fetch(url('/api/apply_edit'), { method: 'POST', headers: json, body: 'x'.repeat(20_000) });
    expect(big.status).toBe(413);
  });

  it('refuses non-local origins and non-JSON posts', async () => {
    const evil = await fetch(url('/api/meter/record'), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{"tokens":1}',
    });
    expect(evil.status).toBe(403);
    const plain = await fetch(url('/api/meter/record'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"tokens":1}' });
    expect(plain.status).toBe(415);
    const local = await fetch(url('/api/meter/record'), {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: '{"tokens":1}',
    });
    expect(local.status).toBe(200);
  });

  it('refuses a non-local Host header (DNS rebinding)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port: b.port, path: '/api/state', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject).end();
    });
    expect(status).toBe(403);
  });

  it('survives junk on the browser socket', async () => {
    const ws = await fakeBrowser(b.port);
    ws.send('null');
    ws.send('{"type":"result"}');
    ws.send('not json');
    const r = await post('/api/apply_edit', { inset_depth_mm: 2 });
    expect(r.status).toBe(200);
    ws.close();
  });

  it('records tokens on the meter', async () => {
    const r = await post('/api/meter/record', { tokens: 1234 });
    expect(await r.json()).toMatchObject({ rpm: 1, tpm: 1234 });
  });

  describe('race lanes', () => {
    const start = () => post('/api/race/start', {
      lanes: [{ id: 'cerebras', label: 'Kimi K3.1 Pro', provider: 'Cerebras' }, { id: 'gpu', label: 'Kimi K3.1 Pro', provider: 'Fireworks (GPU)' }],
      target_db: -15,
      banner: 'SIMULATED SPEEDS',
      dry_run: true,
    });

    it('404s on an unknown lane', async () => {
      const ws = await fakeBrowser(b.port);
      expect((await fetch(url('/api/state?lane=nope'))).status).toBe(404);
      expect((await post('/api/apply_edit?lane=nope', { inset_depth_mm: 2 })).status).toBe(404);
      ws.close();
    });

    it('starts both lanes from one baseline solve and keeps their state separate', async () => {
      const ws = await fakeBrowser(b.port);
      const runs: BridgeToClient[] = [];
      ws.on('message', (raw) => runs.push(JSON.parse(String(raw))));
      const r = await start();
      expect(r.status).toBe(200);
      const st = await r.json();
      expect(st.lanes.map((l: { id: string }) => l.id)).toEqual(['cerebras', 'gpu']);
      expect(st.lanes[1].provider).toBe('Fireworks (GPU)');
      expect(st).toMatchObject({ dry_run: true, banner: 'SIMULATED SPEEDS' });
      expect(runs.filter((m) => m.type === 'run')).toHaveLength(1);
      expect(runs.find((m) => m.type === 'run')).toMatchObject({ lane: '*' });

      const e = await post('/api/apply_edit?lane=cerebras', { inset_depth_mm: 2, llm_ms: 300, tokens: 120 });
      const body = await e.json();
      expect(body.it).toBe(1);
      expect(typeof body.queue_ms).toBe('number');
      expect(runs.filter((m) => m.type === 'run').at(-1)).toMatchObject({ lane: 'cerebras' });

      const c = await (await fetch(url('/api/state?lane=cerebras'))).json();
      const g = await (await fetch(url('/api/state?lane=gpu'))).json();
      expect(c.geometry.feed.inset_depth_mm).toBe(2);
      expect(g.geometry.feed.inset_depth_mm).toBe(0);
      expect(g.it).toBe(0);
      // The main lane is untouched by the race.
      const m = await (await fetch(url('/api/state'))).json();
      expect(m.geometry.feed.inset_depth_mm).toBe(0);

      const race = await (await fetch(url('/api/race'))).json();
      expect(race.lanes[0]).toMatchObject({ it: 1, llm_ms: 300, tokens: 120, status: 'running', matched_ms: null });
      ws.close();
    });

    it('records the match time, keeps the lane open until finish, then rejects edits', async () => {
      const ws = await fakeBrowser(b.port);
      await start();
      await post('/api/apply_edit?lane=gpu', { inset_depth_mm: 4 });
      let race = await (await fetch(url('/api/race'))).json();
      expect(race.lanes[1].matched_ms).toBeGreaterThanOrEqual(0);
      expect(race.lanes[1].status).toBe('running');

      const f = await post('/api/race/finish?lane=gpu', { status: 'matched' });
      expect(f.status).toBe(200);
      race = await f.json();
      expect(race.lanes[1].status).toBe('matched');
      const frozen = race.lanes[1].elapsed_ms;
      await new Promise((r) => setTimeout(r, 30));
      race = await (await fetch(url('/api/race'))).json();
      expect(race.lanes[1].elapsed_ms).toBe(frozen);
      expect(race.lanes[0].status).toBe('running');

      expect((await post('/api/apply_edit?lane=gpu', { inset_depth_mm: 3 })).status).toBe(409);
      expect((await post('/api/race/finish?lane=cerebras', { status: 'won' })).status).toBe(400);
      ws.close();
    });

    it('leaves time spent queued behind the other lane out of the race clock', async () => {
      // A slow fake browser: every solve takes 150 ms.
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}/sim-client`);
      await new Promise((r) => ws.once('open', r));
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as BridgeToClient;
        if (msg.type !== 'run') return;
        setTimeout(() => ws.send(JSON.stringify({ type: 'result', id: msg.id, telemetry: {
          ...fakeTelemetry(msg.it), s11_at_target_db: msg.dsl.feed.inset_depth_mm >= 4 ? -20 : -4 } })), 150);
      });
      await start();
      // Both lanes edit at once; one of them waits ~150 ms for the other's solve.
      const [a, g] = await Promise.all([
        post('/api/apply_edit?lane=cerebras', { inset_depth_mm: 4 }).then((r) => r.json()),
        post('/api/apply_edit?lane=gpu', { inset_depth_mm: 4 }).then((r) => r.json()),
      ]);
      expect(Math.max(a.queue_ms, g.queue_ms)).toBeGreaterThanOrEqual(120);
      const race = await (await fetch(url('/api/race'))).json();
      const [mc, mg] = race.lanes.map((l: { matched_ms: number }) => l.matched_ms);
      // Without the queue correction the waiting lane would read ~300 ms; with it both read ~150 ms.
      expect(Math.abs(mc - mg)).toBeLessThan(80);
      ws.close();
    });

    it('keeps a finished lane\'s clock fixed when an edit it had queued is rejected later', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${b.port}/sim-client`);
      await new Promise((r) => ws.once('open', r));
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as BridgeToClient;
        if (msg.type === 'run') setTimeout(() => ws.send(JSON.stringify({ type: 'result', id: msg.id, telemetry: fakeTelemetry(msg.it) })), 150);
      });
      await start();
      const busy = post('/api/apply_edit?lane=cerebras', { inset_depth_mm: 2 });
      await new Promise((r) => setTimeout(r, 20));
      const queued = post('/api/apply_edit?lane=gpu', { inset_depth_mm: 2 });
      await new Promise((r) => setTimeout(r, 40));
      const finished = await (await post('/api/race/finish?lane=gpu', { status: 'gave_up' })).json();
      const frozen = finished.lanes[1].elapsed_ms;
      expect((await queued).status).toBe(409);
      await busy;
      const after = await (await fetch(url('/api/race'))).json();
      expect(after.lanes[1].elapsed_ms).toBe(frozen);
      ws.close();
    });

    it('refuses reset and run on race lanes', async () => {
      const ws = await fakeBrowser(b.port);
      await start();
      expect((await post('/api/reset?lane=gpu', {})).status).toBe(409);
      expect((await post('/api/run?lane=gpu', {})).status).toBe(409);
      ws.close();
    });

    it('validates race/start', async () => {
      const ws = await fakeBrowser(b.port);
      expect((await post('/api/race/start', { lanes: [] })).status).toBe(400);
      expect((await post('/api/race/start', { lanes: [{ id: 'a' }, { id: 'a' }] })).status).toBe(400);
      expect((await post('/api/race/start', { lanes: [{ id: 'main' }] })).status).toBe(400);
      expect((await post('/api/race/start', { lanes: [{ id: 'a b' }] })).status).toBe(400);
      expect((await post('/api/race/start', { lanes: [{ id: 'a' }], target_db: 5 })).status).toBe(400);
      ws.close();
    });
  });
});
