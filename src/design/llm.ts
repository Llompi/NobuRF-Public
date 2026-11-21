import { SpendCapError, type Price, type SpendGuard } from './spend';

/** An OpenAI-format chat message. Assistant messages are kept exactly as the provider sent them (reasoning included). */
export type ChatMessage = Record<string, unknown> & { role: 'system' | 'user' | 'assistant' | 'tool' };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatTool {
  name: string;
  description: string;
  parameters: object;
}

/** One model call, as the journal and the race summary see it. */
export interface CallStats {
  ms: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cost_usd: number;
  /** True when the provider reported usage; false when the call was charged its worst case. */
  usage_reported: boolean;
  served_by?: string;
  /** Why generation stopped ('stop', 'tool_calls', 'length': the completion budget ran out). */
  finish_reason?: string;
  /** Rate-limit or server-error answers retried before this one, and the time spent waiting them out. */
  retries?: number;
  retry_wait_ms?: number;
}

export interface ChatTurn {
  message: ChatMessage & { tool_calls?: ToolCall[]; content?: string | null };
  stats: CallStats;
}

export interface ChatModel {
  readonly label: string;
  chat(messages: ChatMessage[], tools: readonly ChatTool[]): Promise<ChatTurn>;
}

/** An OpenAI-compatible provider: Cerebras or OpenRouter. */
export interface Lane {
  id: string;
  baseUrl: string;
  model: string;
  keyEnv: string;
  price: Price;
  /** Provider-specific request fields. */
  extraBody: (reasoningEffort: string) => Record<string, unknown>;
  /** The completion budget's field name. */
  maxTokensField: 'max_completion_tokens' | 'max_tokens';
  /** 'required' (default) makes every reply a tool call, finish included; 'auto' lets the model answer in text. NOBURF_TOOL_CHOICE. */
  toolChoice: 'auto' | 'required';
}

/**
 * The two lanes of the with-vs-without-Cerebras comparison. Same model family,
 * same prompt and tools; only the host differs. Prices are conservative
 * defaults for the spend guard (override with NOBURF_PRICE_IN / NOBURF_PRICE_OUT,
 * USD per million tokens); OpenRouter reports its real cost per call.
 */
export function laneFor(id: string, env: NodeJS.ProcessEnv = process.env): Lane {
  // Validated by SpendGuard: a malformed override (NaN, negative) is refused, never treated as free.
  // An override may only raise a price: below the built-in one the guard would under-reserve.
  const priceOverride = (fallback: Price): Price => {
    const read = (name: 'NOBURF_PRICE_IN' | 'NOBURF_PRICE_OUT', builtIn: number) => {
      if (env[name] === undefined) return builtIn;
      const x = Number(env[name]);
      if (!(x >= builtIn)) throw new Error(`${name} must be a number of at least ${builtIn} (the built-in price, USD per million tokens), got "${env[name]}"`);
      return x;
    };
    return { inputPerM: read('NOBURF_PRICE_IN', fallback.inputPerM), outputPerM: read('NOBURF_PRICE_OUT', fallback.outputPerM) };
  };
  // 'required' by default: a model that answers in text wastes turns (gpt-oss did); finish is a tool, so it can still stop.
  const toolChoice = env.NOBURF_TOOL_CHOICE ?? 'required';
  if (toolChoice !== 'auto' && toolChoice !== 'required') throw new Error(`NOBURF_TOOL_CHOICE must be auto or required, got "${toolChoice}"`);
  switch (id) {
    case 'cerebras': {
      // Kimi on Cerebras goes live at the hackathon kickoff; until then a public model on the same key.
      const model = env.CEREBRAS_MODEL ?? 'gpt-oss-120b';
      const isGptOss = model === 'gpt-oss-120b';
      return {
        id,
        baseUrl: 'https://api.cerebras.ai/v1',
        model,
        keyEnv: 'CEREBRAS_API_KEY',
        // gpt-oss-120b's list price; any other model (Kimi included, until its price is published) an upper guess.
        price: priceOverride(isGptOss ? { inputPerM: 0.35, outputPerM: 0.75 } : { inputPerM: 3, outputPerM: 12 }),
        extraBody: (effort) => ({ reasoning_effort: effort }),
        maxTokensField: 'max_completion_tokens',
        toolChoice,
      };
    }
    case 'openrouter': {
      const pinned = env.OPENROUTER_PROVIDERS?.split(',').map((s) => s.trim()).filter(Boolean);
      const price = priceOverride({ inputPerM: 3, outputPerM: 12 });
      // OpenRouter refuses any host dearer than the price the guard reserves at, whatever the model.
      const maxPrice = { prompt: price.inputPerM, completion: price.outputPerM };
      return {
        id,
        baseUrl: 'https://openrouter.ai/api/v1',
        model: env.OPENROUTER_MODEL ?? 'moonshotai/kimi-k3.1-pro',
        keyEnv: 'OPENROUTER_API_KEY',
        price,
        extraBody: (effort) => ({
          reasoning: { effort },
          usage: { include: true },
          provider: {
            ...(pinned?.length ? { order: pinned, allow_fallbacks: false } : { sort: 'throughput', require_parameters: true }),
            max_price: maxPrice,
          },
        }),
        maxTokensField: 'max_tokens',
        toolChoice,
      };
    }
    default:
      throw new Error(`unknown model lane "${id}" (cerebras, openrouter or scripted)`);
  }
}

/**
 * Prompt size for the worst-case check. English runs about 4 characters per token, but dense JSON, numbers
 * and the provider's chat template can come close to 2, so 2 keeps the estimate above the bill.
 */
const estimateTokens = (messages: ChatMessage[], tools: readonly ChatTool[]) => Math.ceil(JSON.stringify([messages, tools]).length / 2);

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
/** The longest wait for one retry; a provider asking for more ends the run instead. */
const MAX_RETRY_WAIT_MS = 60_000;

/**
 * How long to wait before retrying: Retry-After, else the provider's per-minute
 * rate-limit reset (seconds), else a doubling backoff from 2 s. Infinity when the
 * daily request quota is spent: waiting cannot help.
 */
export function retryWaitMs(headers: Headers, attempt: number): number {
  if (headers.get('x-ratelimit-remaining-requests-day') === '0') return Infinity;
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const s = Number(retryAfter);
    const ms = Number.isFinite(s) ? s * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, ms);
  }
  const resets = ['x-ratelimit-reset-requests-minute', 'x-ratelimit-reset-tokens-minute']
    .map((h) => Number(headers.get(h)))
    .filter((s) => Number.isFinite(s) && s > 0);
  if (resets.length) return Math.max(...resets) * 1000;
  return 2000 * 2 ** attempt;
}

/** A chat model on an OpenAI-compatible HTTP API, with every call checked against the spend guard first. */
export class HttpChatModel implements ChatModel {
  readonly label: string;

  constructor(
    private readonly lane: Lane,
    private readonly apiKey: string,
    private readonly guard: SpendGuard,
    private readonly options: { reasoningEffort: string; maxCompletionTokens: number; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> },
  ) {
    this.label = `${lane.model} on ${lane.id}`;
  }

  /** Error text from a provider never carries the key on into logs. */
  private scrub(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[key]') : text;
  }

  async chat(messages: ChatMessage[], tools: readonly ChatTool[]): Promise<ChatTurn> {
    const body = {
      model: this.lane.model,
      messages,
      tools: tools.map((t) => ({ type: 'function', function: t })),
      tool_choice: this.lane.toolChoice,
      [this.lane.maxTokensField]: this.options.maxCompletionTokens,
      ...this.lane.extraBody(this.options.reasoningEffort),
    };
    const worstCase = this.guard.costUsd(estimateTokens(messages, tools), this.options.maxCompletionTokens);
    const doFetch = this.options.fetchImpl ?? fetch;
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let waitedMs = 0;
    for (let attempt = 0; ; attempt++) {
      // Charged before sending: a call that dies after the provider started on it may still be billed.
      const reservation = this.guard.reserve(worstCase);
      const t0 = performance.now();
      let response: Response;
      try {
        response = await doFetch(`${this.lane.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      } catch (e) {
        throw new Error(`${this.lane.id} call failed (${this.scrub((e as Error).message)}); charged its worst case $${worstCase.toFixed(4)}`);
      }
      const text = await response.text(); // a failure here keeps the worst-case charge
      const ms = performance.now() - t0;
      if (!response.ok) {
        // A refusal is not billed: release the reservation. A gateway error (502, 504) may sit in front
        // of a generation that ran and is billed: keep its worst case.
        this.guard.settle(reservation, response.status === 502 || response.status === 504 ? worstCase : 0);
        const wait = retryWaitMs(response.headers, attempt);
        if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES && wait <= MAX_RETRY_WAIT_MS) {
          console.error(`${this.lane.id} answered HTTP ${response.status}; retrying in ${(wait / 1000).toFixed(1)} s`);
          await sleep(wait);
          waitedMs += wait;
          continue;
        }
        const tries = attempt ? ` after ${attempt} retries over ${(waitedMs / 1000).toFixed(0)} s` : '';
        throw new Error(`${this.lane.id} answered HTTP ${response.status}${tries}: ${this.scrub(text.slice(0, 500))}`);
      }
      const json = JSON.parse(text) as {
        choices?: Array<{ message: ChatTurn['message']; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        provider?: string;
      };
      const usage = json.usage;
      const reported = typeof usage?.prompt_tokens === 'number' && typeof usage?.completion_tokens === 'number';
      const reportedCost = typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
      // The larger of the reported cost and tokens at the guard's price: a reported $0 with tokens used is not trusted.
      const tokenCost = reported ? this.guard.costUsd(usage!.prompt_tokens!, usage!.completion_tokens!) : null;
      const cost = tokenCost !== null ? Math.max(reportedCost ?? 0, tokenCost) : (reportedCost ?? worstCase);
      this.guard.settle(reservation, cost);
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error(`${this.lane.id} returned no message: ${this.scrub(text.slice(0, 500))}`);
      return {
        message: { ...message, role: 'assistant' },
        stats: {
          ms: Math.round(ms),
          prompt_tokens: reported ? usage!.prompt_tokens! : null,
          completion_tokens: reported ? usage!.completion_tokens! : null,
          cost_usd: cost,
          usage_reported: reported,
          ...(json.provider ? { served_by: json.provider } : {}),
          ...(json.choices?.[0]?.finish_reason ? { finish_reason: json.choices[0].finish_reason } : {}),
          ...(attempt ? { retries: attempt, retry_wait_ms: Math.round(waitedMs) } : {}),
        },
      };
    }
  }
}

/** A model call that takes longer than this is abandoned (and keeps its worst-case charge). */
const CALL_TIMEOUT_MS = 180_000;

export { SpendCapError };
