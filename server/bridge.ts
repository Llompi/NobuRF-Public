/**
 * Local tool bridge.
 *
 *   OpenClaw tools --HTTP--> bridge --WebSocket--> browser (WebGPU FDTD)
 *                   <--telemetry--      <--result--
 *
 * The bridge owns the canonical geometry. The browser is a stateless compute
 * worker: it receives the full DSL for every run, so a page reload can never
 * desynchronise what the agent thinks it edited from what was simulated.
 *
 * Endpoints (all JSON):
 *   GET  /api/health        -> { ok, browser: bool, adapter }
 *   GET  /api/state         -> { geometry, telemetry | null, it }
 *   POST /api/apply_edit    -> body GeometryEdit -> SimTelemetry (or 4xx with { error })
 *   POST /api/reset         -> resets to the mismatched baseline and re-solves -> SimTelemetry
 *   POST /api/run           -> re-solve the current geometry without editing -> SimTelemetry
 *   GET  /api/meter         -> { rpm, tpm, rpmCap, tpmCap }
 *   POST /api/meter/record  -> body { tokens } (called by the agent loop after each Cerebras call)
 *
 * Race (same task, two inference providers, one shared GPU):
 *   Every endpoint above that touches geometry takes ?lane=<id> (default "main").
 *   An unknown lane is a 404, so a typo in the harness shows up immediately.
 *   POST /api/race/start   -> body { lanes: [{ id, label, provider? }], target_db?, dry_run?, banner? }
 *                             resets every lane to the baseline, solves it once, starts the clocks
 *   POST /api/race/finish?lane=X -> body { status: "matched" | "gave_up" | "error", note? } stops X's clock
 *   GET  /api/race         -> RaceState | null
 *   apply_edit on a race lane also accepts llm_ms and tokens (stripped before the edit applies)
 *   and its response adds queue_ms (time spent waiting for the shared GPU).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { applyEdit, baselineGeometry, cloneGeometry, EditError, validateGeometry } from '../src/engine/geometry';
import type {
  BridgeToClient,
  ClientToBridge,
  GeometryEdit,
  LaneState,
  LaneStatus,
  MicroGeometryDSL,
  RaceState,
  SimTelemetry,
} from '../src/engine/types';
import { RateMeter } from './rate_meter';

export interface BridgeOptions {
  port?: number;
  /** Max time to wait for the browser to finish a solve. */
  solveTimeoutMs?: number;
  meter?: RateMeter;
  log?: (msg: string) => void;
}

export interface Bridge {
  server: Server;
  port: number;
  meter: RateMeter;
  close(): Promise<void>;
}

const MAX_BODY = 16 * 1024;

/**
 * The bridge drives a solver and an agent budget, so only this machine may use
 * it. Requests without an Origin (curl, Node, the OpenClaw tools) are local by
 * construction (we listen on 127.0.0.1). Browser requests must come from a
 * localhost page, which blocks a random website from posting to the bridge.
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false; // not a URL: not a local page
  }
}

/** Rejects DNS rebinding: a page on evil.example that resolves to 127.0.0.1 still sends Host: evil.example. */
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function isClientMessage(value: unknown): value is ClientToBridge {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as { type?: unknown; id?: unknown; adapter?: unknown; telemetry?: unknown; message?: unknown };
  if (msg.type === 'hello') return typeof msg.adapter === 'string';
  if (typeof msg.id !== 'string') return false;
  if (msg.type === 'error') return typeof msg.message === 'string';
  const t = msg.telemetry as Partial<SimTelemetry> | undefined;
  return msg.type === 'result' && typeof t === 'object' && t !== null && typeof t.s11_at_target_db === 'number' && typeof t.it === 'number';
}
const LANE_ID = /^[a-z0-9_-]{1,32}$/i;

interface Lane {
  id: string;
  label: string;
  provider?: string;
  geometry: MicroGeometryDSL;
  telemetry: SimTelemetry | null;
  it: number;
  status: LaneStatus;
  endedAt: number | null;
  matchedMs: number | null;
  llmMs: number;
  tokens: number;
  queueMs: number;
  queuedSince: number | null;
  note?: string;
}

const newLane = (id: string, label = id, provider?: string): Lane => ({
  id, label, provider, geometry: baselineGeometry(), telemetry: null, it: 0, status: 'idle',
  endedAt: null, matchedMs: null, llmMs: 0, tokens: 0, queueMs: 0, queuedSince: null,
});

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function startBridge(opts: BridgeOptions = {}): Promise<Bridge> {
  const log = opts.log ?? ((m: string) => console.log(`[bridge] ${m}`));
  const meter = opts.meter ?? new RateMeter();
  const solveTimeoutMs = opts.solveTimeoutMs ?? Number(process.env.BRIDGE_SOLVE_TIMEOUT_MS ?? 15_000);

  const lanes = new Map<string, Lane>([['main', newLane('main')]]);
  let race: { t0: number; targetDb: number; dryRun: boolean; banner?: string; ids: string[] } | null = null;
  let client: WebSocket | null = null;
  let adapter = '';
  const pending = new Map<string, { resolve: (t: SimTelemetry) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  // Serialise solves: the GPU runs one at a time, and edits must apply in order.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  function send(msg: BridgeToClient): void {
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(msg));
  }

  function laneOf(url: URL): Lane {
    const id = url.searchParams.get('lane') ?? 'main';
    const lane = lanes.get(id);
    if (!lane) throw new HttpError(404, `unknown lane "${id}" (known: ${[...lanes.keys()].join(', ')})`);
    return lane;
  }

  function raceState(): RaceState | null {
    if (!race) return null;
    const now = Date.now();
    const lanesOut: LaneState[] = race.ids.map((id) => {
      const l = lanes.get(id)!;
      return {
        id: l.id, label: l.label, provider: l.provider, it: l.it, status: l.status,
        elapsed_ms: raceTime(l, l.endedAt ?? now), matched_ms: l.matchedMs,
        llm_ms: l.llmMs, tokens: l.tokens, queue_ms: l.queueMs, queued_since: l.queuedSince,
        telemetry: l.telemetry, note: l.note,
      };
    });
    return { t0: race.t0, now, target_db: race.targetDb, dry_run: race.dryRun, banner: race.banner, lanes: lanesOut };
  }

  /**
   * A lane's race time: wall clock since the start minus the time it spent
   * queued behind other lanes' solves on the shared GPU. Its own solves count.
   */
  function raceTime(lane: Lane, atMs: number): number {
    if (!race) return 0;
    const waitingNow = lane.queuedSince !== null ? atMs - lane.queuedSince : 0;
    return atMs - race.t0 - lane.queueMs - waitingNow;
  }

  const broadcastRace = () => send({ type: 'race', race: raceState() });

  /** Bookkeeping after a race lane's solve commits. */
  function noteRaceResult(lane: Lane, t: SimTelemetry): void {
    if (!race || !race.ids.includes(lane.id)) return;
    if (lane.matchedMs === null && t.s11_at_target_db <= race.targetDb) lane.matchedMs = raceTime(lane, Date.now());
  }

  function solve(dsl: MicroGeometryDSL, iter: number, label?: string, reason?: string, lane?: string): Promise<SimTelemetry> {
    if (!client || client.readyState !== WebSocket.OPEN) {
      return Promise.reject(new HttpError(503, 'no browser connected: open the NobuRF page (npm run dev, then http://localhost:5173)'));
    }
    const id = randomUUID();
    return new Promise<SimTelemetry>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        send({ type: 'discard', id });
        reject(new HttpError(504, `browser did not finish the solve within ${solveTimeoutMs} ms`));
      }, solveTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ type: 'run', id, dsl, it: iter, label, reason, ...(lane ? { lane } : {}) });
    });
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, 'body too large');
      chunks.push(c as Buffer);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'body is not valid JSON');
    }
  }

  function reply(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      if (!isLocalOrigin(req.headers.origin) || !isLocalHost(req.headers.host)) {
        throw new HttpError(403, 'requests are only accepted from localhost pages');
      }
      // JSON only: a cross-site form or text/plain POST cannot set this header without a CORS preflight, which we never grant.
      const contentType = req.headers['content-type'] ?? '';
      if (req.method === 'POST' && !contentType.startsWith('application/json')) {
        throw new HttpError(415, 'send the body as JSON with content-type: application/json');
      }
      switch (route) {
        case 'GET /api/health':
          return reply(res, 200, { ok: true, browser: client?.readyState === WebSocket.OPEN, adapter });
        case 'GET /api/state': {
          const lane = laneOf(url);
          return reply(res, 200, { geometry: lane.geometry, telemetry: lane.telemetry, it: lane.it });
        }
        case 'GET /api/meter':
          return reply(res, 200, meter.snapshot());
        case 'POST /api/meter/record': {
          const body = (await readJson(req)) as { tokens?: unknown };
          meter.record(Number(body.tokens));
          const snap = meter.snapshot();
          send({ type: 'meter', ...snap });
          return reply(res, 200, snap);
        }
        case 'POST /api/apply_edit': {
          const lane = laneOf(url);
          const inRace = !!race && race.ids.includes(lane.id);
          const body = ((await readJson(req)) ?? {}) as GeometryEdit & { llm_ms?: unknown; tokens?: unknown };
          const { llm_ms, tokens, ...edit } = body;
          if (inRace && lane.status !== 'running') throw new HttpError(409, `lane "${lane.id}" has finished (${lane.status})`);
          // Model time is the agent's, not ours: count it even if the edit is rejected.
          if (inRace) {
            if (Number.isFinite(Number(llm_ms)) && Number(llm_ms) > 0) lane.llmMs += Number(llm_ms);
            if (Number.isFinite(Number(tokens)) && Number(tokens) > 0) lane.tokens += Number(tokens);
          }
          const queuedAt = Date.now();
          let queueMs = 0;
          if (inRace) {
            lane.queuedSince = queuedAt;
            broadcastRace();
          }
          const t = await serial(async () => {
            // A lane finished while this edit waited stops accruing wait at its end time.
            queueMs = Math.min(Date.now(), lane.endedAt ?? Infinity) - queuedAt;
            if (inRace) {
              lane.queueMs += Math.max(0, queueMs);
              lane.queuedSince = null;
              broadcastRace();
              // The lane may have been finished while this edit waited.
              if (lane.status !== 'running') throw new HttpError(409, `lane "${lane.id}" has finished (${lane.status})`);
            }
            let next: MicroGeometryDSL;
            try {
              next = applyEdit(lane.geometry, edit);
            } catch (e) {
              if (e instanceof EditError) throw new HttpError(422, e.message);
              throw e;
            }
            const { reason, ...delta } = edit;
            const result = await solve(
              next, lane.it + 1, JSON.stringify(delta), typeof reason === 'string' ? reason : undefined,
              lane.id === 'main' ? undefined : lane.id,
            );
            // Commit only after a successful solve, so a failed run leaves state untouched.
            lane.geometry = next;
            lane.it += 1;
            lane.telemetry = result;
            if (inRace) noteRaceResult(lane, result);
            return result;
          }).finally(() => {
            if (inRace) {
              if (lane.queuedSince !== null) {
                // Failed before its turn came (e.g. browser gone): close the wait.
                lane.queueMs += Math.max(0, Math.min(Date.now(), lane.endedAt ?? Infinity) - lane.queuedSince);
                lane.queuedSince = null;
              }
              broadcastRace();
            }
          });
          log(`apply_edit[${lane.id}] ${JSON.stringify(edit)} -> S11min ${t.s11_min_db} dB @ ${t.f0_ghz} GHz (${t.solve_ms} ms)`);
          return reply(res, 200, inRace ? { ...t, queue_ms: queueMs } : t);
        }
        case 'POST /api/reset': {
          const lane = laneOf(url);
          if (lane.id !== 'main') throw new HttpError(409, 'race lanes cannot be reset; start a new race with /api/race/start');
          const t = await serial(async () => {
            const base = baselineGeometry();
            validateGeometry(base);
            const result = await solve(base, 0, 'reset', undefined, lane.id === 'main' ? undefined : lane.id);
            lane.geometry = base;
            lane.it = 0;
            lane.telemetry = result;
            return result;
          });
          return reply(res, 200, t);
        }
        case 'POST /api/run': {
          const lane = laneOf(url);
          if (lane.id !== 'main') throw new HttpError(409, 'race lanes are re-solved only by their own edits');
          const t = await serial(async () => {
            const result = await solve(cloneGeometry(lane.geometry), lane.it, undefined, undefined, lane.id === 'main' ? undefined : lane.id);
            lane.telemetry = result;
            return result;
          });
          return reply(res, 200, t);
        }
        case 'GET /api/race':
          return reply(res, 200, raceState());
        case 'POST /api/race/start': {
          const body = (await readJson(req)) as {
            lanes?: Array<{ id?: unknown; label?: unknown; provider?: unknown }>;
            target_db?: unknown;
            dry_run?: unknown;
            banner?: unknown;
          };
          const specs = Array.isArray(body.lanes) ? body.lanes : [];
          if (specs.length < 1 || specs.length > 4) throw new HttpError(400, 'lanes must list 1 to 4 lanes');
          const ids = specs.map((l) => String(l.id ?? ''));
          for (const id of ids) {
            if (!LANE_ID.test(id) || id === 'main') throw new HttpError(400, `bad lane id "${id}" (letters, digits, - and _; not "main")`);
          }
          if (new Set(ids).size !== ids.length) throw new HttpError(400, 'lane ids must be unique');
          const targetDb = body.target_db === undefined ? -15 : Number(body.target_db);
          if (!Number.isFinite(targetDb) || targetDb > -3 || targetDb < -40) throw new HttpError(400, 'target_db must be between -40 and -3');
          const result = await serial(async () => {
            const base = baselineGeometry();
            validateGeometry(base);
            // One solve serves every lane: they all start from the same antenna.
            const t = await solve(base, 0, 'reset', undefined, '*');
            for (const id of [...lanes.keys()]) if (id !== 'main') lanes.delete(id);
            specs.forEach((sp, i) => {
              const lane = newLane(ids[i], String(sp.label ?? ids[i]).slice(0, 60),
                sp.provider === undefined ? undefined : String(sp.provider).slice(0, 60));
              lane.geometry = cloneGeometry(base);
              lane.telemetry = t;
              lane.status = 'running';
              lanes.set(lane.id, lane);
            });
            // Clocks start after the baseline solve, so it never counts against either lane.
            race = {
              t0: Date.now(), targetDb, dryRun: body.dry_run === true, ids,
              banner: typeof body.banner === 'string' && body.banner.trim() ? body.banner.slice(0, 80) : undefined,
            };
            return t;
          });
          broadcastRace();
          log(`race started: ${ids.join(' vs ')} (target ${targetDb} dB)`);
          return reply(res, 200, { ...raceState(), baseline: result });
        }
        case 'POST /api/race/finish': {
          const lane = laneOf(url);
          if (!race || !race.ids.includes(lane.id)) throw new HttpError(409, `lane "${lane.id}" is not in a race`);
          const body = (await readJson(req)) as { status?: unknown; note?: unknown };
          const status = String(body.status ?? '');
          if (!['matched', 'gave_up', 'error'].includes(status)) throw new HttpError(400, 'status must be matched, gave_up or error');
          if (lane.status === 'running') {
            lane.status = status as LaneStatus;
            lane.endedAt = Date.now();
            if (body.note !== undefined) lane.note = String(body.note).slice(0, 200);
          }
          broadcastRace();
          return reply(res, 200, raceState());
        }
        default:
          return reply(res, 404, { error: `no route ${route}` });
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) log(`${route} failed: ${message}`);
      return reply(res, status, { error: message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const isSimClient = new URL(req.url ?? '/', 'http://localhost').pathname === '/sim-client';
    if (!isSimClient || !isLocalOrigin(req.headers.origin) || !isLocalHost(req.headers.host)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    // A malformed frame (bad UTF-8, unmasked, oversized) raises 'error'; without a listener it kills the bridge.
    ws.on('error', (error) => {
      console.error(`[bridge] dropped a browser connection: ${error.message}`);
      ws.terminate();
    });
    // Latest tab wins. Older tabs are closed so two GPUs never race on one edit.
    if (client && client !== ws) {
      client.close(4000, 'replaced by a newer tab');
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new HttpError(503, 'browser tab was replaced mid-solve'));
        pending.delete(id);
      }
    }
    client = ws;
    log('browser connected');
    ws.on('message', (raw) => {
      let msg: ClientToBridge;
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (!isClientMessage(parsed)) throw new Error(`unexpected message shape: ${String(raw).slice(0, 80)}`);
        msg = parsed;
      } catch (e) {
        log(`ignored a bad message from the browser: ${(e as Error).message}`);
        return;
      }
      if (msg.type === 'hello') {
        adapter = msg.adapter;
        log(`adapter: ${adapter}`);
        send({ type: 'meter', ...meter.snapshot() });
        broadcastRace();
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return; // late answer after a timeout: ignore
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.telemetry);
      else p.reject(new HttpError(500, `browser solve failed: ${msg.message}`));
    });
    ws.on('close', () => {
      if (client === ws) {
        client = null;
        log('browser disconnected');
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new HttpError(503, 'browser disconnected mid-solve'));
          pending.delete(id);
        }
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? Number(process.env.BRIDGE_PORT ?? 8787), '127.0.0.1', () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    });
  });
  log(`listening on http://127.0.0.1:${port}  (ws path /sim-client)`);

  return {
    server,
    port,
    meter,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

// Run directly: `tsx server/bridge.ts`
// pathToFileURL handles Windows drive letters and backslashes (a `file://${argv[1]}` compare never matches there).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBridge().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
