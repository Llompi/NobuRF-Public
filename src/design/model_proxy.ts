import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Lane } from './llm';
import { SpendCapError, type SpendGuard } from './spend';

/**
 * A local OpenAI-compatible endpoint between an agent harness (OpenClaw) and
 * one provider, one per race lane. The harness gets a placeholder key and this
 * URL; the proxy adds the real key, so the key never enters the harness's
 * config or logs.
 *
 * It does two jobs the harness cannot do for us:
 * - Spend: every chat call reserves its worst case with the same SpendGuard as
 *   `design run` before it is forwarded, and is settled to the provider's
 *   reported cost after. A call that would pass a cap is answered 402 and never
 *   reaches the provider. This closes the "OpenClaw runs are not guarded" gap.
 * - Measurement: model time, time to first token, the provider's token usage
 *   and the tool calls in each reply, measured the same way for every lane,
 *   outside both the harness and the provider. Token counts are only ever the
 *   provider's reported usage, never estimated.
 */

export interface ProxyCall {
  /** Epoch ms when the call was forwarded and when its reply ended. */
  started_at: number;
  ended_at: number;
  http_status: number;
  time_to_first_token_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  usage_reported: boolean;
  cost_usd: number;
  served_by?: string;
  finish_reason?: string;
  tool_calls: Array<{ name: string; arguments: string }>;
  error?: string;
}

export interface ModelProxy {
  /** Base URL for the harness, ending in /v1. */
  url: string;
  /** The key the harness must send: random per run, so no other local process can spend through the proxy. */
  key: string;
  calls: ProxyCall[];
  /** When the harness's first model request arrived (before any hold), ms since the epoch; null before. */
  readonly firstArrivalAt: number | null;
  close(): Promise<void>;
}

/** Worst-case prompt tokens from the request's size: one per UTF-8 byte (a token is never shorter than a byte). */
const promptTokensUpperBound = (requestText: string) => Buffer.byteLength(requestText, 'utf8');
/** The request fields passed to the provider; the proxy adds the lane's own (model, reply budget, routing, effort). */
const FORWARDED_FIELDS = new Set(['messages', 'tools', 'tool_choice', 'stream', 'stream_options', 'temperature', 'top_p', 'stop', 'parallel_tool_calls']);
/** Errors that mean the request never left this machine, so nothing can have been billed. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);
/** Answers that mean the provider refused the request before generating: not billed. Anything else keeps its worst case. */
const REFUSED_STATUS = new Set([400, 401, 402, 403, 404, 413, 422, 429]);
/** Longest a call may take, reply included. A call cut off here may have been billed and keeps its worst case. */
const CALL_TIMEOUT_MS = 10 * 60_000;

interface StreamState {
  usage: Record<string, unknown> | null;
  servedBy: string | null;
  finishReason: string | null;
  firstTokenAt: number | null;
  toolCalls: Map<number, { name: string; arguments: string }>;
}

function readStreamEvent(state: StreamState, event: Record<string, unknown>, now: number): void {
  if (event.usage) state.usage = event.usage as Record<string, unknown>;
  if (typeof event.provider === 'string') state.servedBy = event.provider;
  const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0];
  if (!choice) return;
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason;
  const delta = choice.delta as Record<string, unknown> | undefined;
  if (!delta) return;
  if (state.firstTokenAt === null && (delta.content || delta.reasoning || delta.reasoning_content || delta.tool_calls)) state.firstTokenAt = now;
  for (const part of (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? []) {
    const index = typeof part.index === 'number' ? part.index : state.toolCalls.size;
    const call = state.toolCalls.get(index) ?? { name: '', arguments: '' };
    const fn = part.function as { name?: string; arguments?: string } | undefined;
    if (fn?.name) call.name += fn.name;
    if (fn?.arguments) call.arguments += fn.arguments;
    state.toolCalls.set(index, call);
  }
}

export async function startModelProxy(options: {
  lane: Lane;
  apiKey: string;
  guard: SpendGuard;
  /** Reasoning effort sent to the provider on every call, in its own dialect (lane.extraBody). */
  reasoningEffort: string;
  /** The reply budget: written into every request and reserved in full, whatever the harness asked for. */
  maxCompletionTokens: number;
  /** Override the upstream base URL (tests point it at a local fake provider). */
  upstream?: string;
  onCall?: (call: ProxyCall) => void;
  /**
   * Hold every request until this settles: the harness starts and asks for its first turn, then waits here, so a
   * race can start both harnesses early and its clock can start with no start-up gap. Held time is not call time.
   * If it resolves to false, held requests are refused and never reach the provider.
   */
  holdUntil?: Promise<boolean | void>;
  /** Called once, when the first request arrives (and is held, if holdUntil is set). */
  onFirstRequest?: () => void;
  /** Called once, when the first request goes to the provider: the lane's clock starts. */
  onFirstForward?: () => void;
}): Promise<ModelProxy> {
  const { lane, apiKey, guard } = options;
  const upstream = (options.upstream ?? lane.baseUrl).replace(/\/$/, '');
  const calls: ProxyCall[] = [];
  const key = `noburf-proxy-${randomBytes(16).toString('hex')}`;
  let firstArrivalAt: number | null = null;
  let forwarded = false;
  // Set when the lane ends: a request still held, or still being read, must then never reserve money or reach the
  // provider, and a call in flight is cut off (it keeps its worst case, as any call cut off after sending does).
  let closed = false;
  const closing = new AbortController();

  const sendJson = (response: http.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  async function forward(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let text = '';
    for await (const chunk of request) text += chunk;
    if (firstArrivalAt === null) {
      firstArrivalAt = Date.now();
      options.onFirstRequest?.();
    }
    // false: the lane will not race after all, so the held request never goes out.
    if (options.holdUntil && (await options.holdUntil) === false) closed = true;
    if (closed) return sendJson(response, 503, { error: { message: 'proxy: the lane has ended' } });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text);
    } catch (e) {
      return sendJson(response, 400, { error: { message: `proxy: request body is not JSON (${(e as Error).message})` } });
    }
    // The lane's own fields (OpenRouter's routing and price ceiling, the reasoning effort) on every call, and the
    // model the lane names: the harness cannot point a lane at a different model or a dearer host.
    // The reply budget the guard reserves is the one the provider gets: one completion, no larger token field.
    // Only the fields a chat turn needs pass through: a provider extra such as OpenRouter's models (fallbacks),
    // plugins or transforms could bill more than the reserved worst case, or route around the lane's host.
    const rest = Object.fromEntries(Object.entries(body).filter(([name]) => FORWARDED_FIELDS.has(name)));
    body = { ...rest, ...lane.extraBody(options.reasoningEffort), model: lane.model, [lane.maxTokensField]: options.maxCompletionTokens };
    if (body.stream) body.stream_options = { ...(body.stream_options as object ?? {}), include_usage: true };
    const requestText = JSON.stringify(body);
    let reservation;
    try {
      reservation = guard.reserve(guard.costUsd(promptTokensUpperBound(requestText), options.maxCompletionTokens));
    } catch (e) {
      if (e instanceof SpendCapError) {
        const now = Date.now();
        const refused: ProxyCall = {
          started_at: now, ended_at: now, http_status: 402, time_to_first_token_ms: null, prompt_tokens: null, completion_tokens: null,
          reasoning_tokens: null, usage_reported: false, cost_usd: 0, tool_calls: [], error: e.message,
        };
        calls.push(refused);
        options.onCall?.(refused);
        return sendJson(response, 402, { error: { message: e.message, type: 'spend_cap' } });
      }
      throw e;
    }

    const startedAt = Date.now();
    if (!forwarded) {
      forwarded = true;
      options.onFirstForward?.();
    }
    const call: ProxyCall = {
      started_at: startedAt, ended_at: startedAt, http_status: 0, time_to_first_token_ms: null,
      prompt_tokens: null, completion_tokens: null, reasoning_tokens: null, usage_reported: false, cost_usd: reservation.worstCaseUsd, tool_calls: [],
    };
    const finish = () => {
      call.ended_at = Date.now();
      calls.push(call);
      options.onCall?.(call);
    };
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(`${upstream}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: requestText,
        signal: AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), closing.signal]),
      });
    } catch (e) {
      call.error = String((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message);
      // Released only when the request never left this machine; a timeout or a reset after sending may have been billed.
      if (NOT_SENT.has(call.error)) {
        guard.settle(reservation, 0);
        call.cost_usd = 0;
      } else {
        reservation.settled = true;
      }
      finish();
      return sendJson(response, 502, { error: { message: `proxy could not reach ${upstream}: ${call.error}` } });
    }
    call.http_status = upstreamResponse.status;
    response.writeHead(upstreamResponse.status, { 'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-cache' });
    const state: StreamState = { usage: null, servedBy: null, finishReason: null, firstTokenAt: null, toolCalls: new Map() };
    const streamed = Boolean(body.stream) && upstreamResponse.status === 200;
    const decoder = new TextDecoder();
    let pending = '';
    let whole = '';
    try {
      for await (const chunk of upstreamResponse.body as unknown as AsyncIterable<Uint8Array>) {
        // An error body is held back and scrubbed below before the harness sees it: a provider may echo the key.
        if (upstreamResponse.status === 200) response.write(chunk);
        const piece = decoder.decode(chunk, { stream: true });
        if (!streamed) {
          whole += piece;
          continue;
        }
        pending += piece;
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
          try {
            readStreamEvent(state, JSON.parse(line.slice(5)), Date.now());
          } catch {
            // passed through untouched
          }
        }
      }
    } catch (e) {
      // Lost after sending: the generation may have run, so the worst case stays charged.
      reservation.settled = true;
      call.error = `reply cut off: ${(e as Error).message}`;
      finish();
      response.destroy(e as Error);
      return;
    }
    const scrubbed = whole.split(apiKey).join('[key]');
    if (upstreamResponse.status === 200) response.end();
    else response.end(scrubbed);
    if (upstreamResponse.status !== 200) {
      // A refusal is not billed; any other error answer (500, 502, 503, 504, a timeout) may come after generation ran.
      const refused = REFUSED_STATUS.has(upstreamResponse.status);
      if (refused) guard.settle(reservation, 0);
      else reservation.settled = true;
      call.cost_usd = refused ? 0 : reservation.worstCaseUsd;
      call.error = scrubbed.slice(0, 300);
      finish();
      return;
    }
    if (!streamed) {
      try {
        const completion = JSON.parse(whole);
        state.usage = completion.usage ?? null;
        state.servedBy = completion.provider ?? null;
        const choice = completion.choices?.[0];
        state.finishReason = choice?.finish_reason ?? null;
        (choice?.message?.tool_calls ?? []).forEach((c: { function?: { name?: string; arguments?: string } }, n: number) =>
          state.toolCalls.set(n, { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '' }));
      } catch {
        // unreadable: keeps the worst case below
      }
    }
    const usage = state.usage as { prompt_tokens?: number; completion_tokens?: number; cost?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null;
    if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      call.usage_reported = true;
      call.prompt_tokens = usage.prompt_tokens;
      call.completion_tokens = usage.completion_tokens;
      call.reasoning_tokens = usage.completion_tokens_details?.reasoning_tokens ?? null;
      // A reported cost below tokens x price is not trusted (as in the direct loop).
      const byTokens = guard.costUsd(usage.prompt_tokens, usage.completion_tokens);
      call.cost_usd = typeof usage.cost === 'number' && usage.cost >= byTokens ? usage.cost : byTokens;
      guard.settle(reservation, call.cost_usd);
    } else {
      reservation.settled = true; // no usage: the worst case stays charged
    }
    if (state.firstTokenAt !== null) call.time_to_first_token_ms = state.firstTokenAt - startedAt;
    if (state.servedBy) call.served_by = state.servedBy;
    if (state.finishReason) call.finish_reason = state.finishReason;
    call.tool_calls = [...state.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
    finish();
  }

  const server = http.createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://proxy').pathname;
    if (request.headers.authorization !== `Bearer ${key}`) return sendJson(response, 401, { error: { message: 'proxy: wrong key' } });
    if (request.method === 'POST' && route === '/v1/chat/completions') {
      forward(request, response).catch((e) => {
        if (!response.headersSent) sendJson(response, 500, { error: { message: `proxy error: ${(e as Error).message}` } });
        else response.destroy(e as Error);
      });
      return;
    }
    if (request.method === 'GET' && route === '/v1/models') return sendJson(response, 200, { object: 'list', data: [{ id: lane.model, object: 'model' }] });
    sendJson(response, 404, { error: { message: `proxy: no route ${request.method} ${route}` } });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    key,
    calls,
    get firstArrivalAt() {
      return firstArrivalAt;
    },
    // A request still held when the lane ends must not keep the proxy open.
    close: () => new Promise<void>((done) => {
      closed = true;
      closing.abort();
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}
