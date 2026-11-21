import type { CallStats, ChatMessage, ChatModel, ChatTool, ChatTurn, ToolCall } from './llm';
import { SpendCapError } from './spend';
import { DESIGN_TOOLS, type DesignSession } from './session';

export const STRATEGIST_PROMPT = `You direct the design of a planar antenna simulated with the NobuRF FDTD solver.
You choose the strategy; a Nelder-Mead optimiser and the solver find the numbers.

The brief gives the goal, the switchable features, every tunable variable with its range, and the solve budget.
The goal is met when S11 at the target is at or below s11_max_db and the S11 dip lies within f_tolerance_pct of the target
(and, when given, the bandwidth and axial-ratio limits hold). score is 0 exactly when the goal is met; lower is better.

Working rules:
- Reason from the physics. The resonant length (patch_l, along the feed) sets the frequency. Inset depth or a stub sets the match.
  A transverse slot lowers the resonance of a patch that cannot grow. Chamfered corners on a near-square patch give circular polarisation.
- Use the fewest features that can reach the goal; every feature is something to manufacture.
- Free at most 4 variables per optimise. Expect about 8 to 12 solves per free variable.
- A free variable that ends at its bound means the goal needs another feature or variable, not more solves of the same.
- If the frequency is right but the match stalls short of the goal with an inset, free the feed width (feed_w) with the inset:
  the feed line's impedance sets how deep the match can go.
- The search mesh can sit a percent or two off the confirm mesh. Confirm when a search meets the goal. If the confirm misses
  on frequency, optimise again with aim_ghz moved by the offset (aim = target * search_mesh_f0 / confirmed f0).
- Finish when a confirmed design meets the goal, or when the budget left cannot reach it. Say which, and why.
Keep text short; act through tools.`;

export interface StrategistEvent {
  type: 'model';
  turn: number;
  stats: CallStats;
  text: string | null;
  tool_calls: Array<{ name: string; arguments: string }>;
}

export interface StrategistResult {
  /** Why the loop ended. */
  ended: 'finished' | 'turn_limit' | 'no_tool_call' | 'spend_cap' | 'model_error' | 'tool_error';
  turns: number;
  modelMs: number;
  toolMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  callsWithoutUsage: number;
  /** Model calls retried after a rate limit or server error, and the time spent waiting (not in modelMs). */
  retries: number;
  retryWaitMs: number;
  error?: string;
}

/** Tools for the model: the session's, plus brief (the opening message carries it, MCP clients ask for it). */
export const STRATEGIST_TOOLS: readonly ChatTool[] = [
  { name: 'brief', description: 'The goal, features, variables with ranges, and budget left.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  ...DESIGN_TOOLS,
];

/** The tool call dispatcher shared by the direct loop and the MCP server. */
export async function callTool(session: DesignSession, name: string, args: Record<string, unknown>): Promise<unknown> {
  return name === 'brief' ? session.brief() : session.call(name, args);
}

/**
 * The strategist loop: the model reads the brief, calls tools, reads results,
 * until it calls finish, stops calling tools, or hits a limit. Model time and
 * tool (solver) time are kept apart, which is the with-vs-without-Cerebras
 * comparison: the solver part is the same on both lanes.
 */
export async function runStrategist(
  session: DesignSession,
  model: ChatModel,
  options: { maxTurns: number; onEvent?: (e: StrategistEvent) => void },
): Promise<StrategistResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: STRATEGIST_PROMPT },
    { role: 'user', content: `Brief:\n${JSON.stringify(session.brief())}` },
  ];
  const result: StrategistResult = { ended: 'turn_limit', turns: 0, modelMs: 0, toolMs: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, callsWithoutUsage: 0, retries: 0, retryWaitMs: 0 };
  let nudges = 0;
  for (let turn = 1; turn <= options.maxTurns; turn++) {
    let reply: ChatTurn;
    try {
      reply = await model.chat(messages, STRATEGIST_TOOLS);
    } catch (e) {
      // The run's solves and confirmed designs are still worth writing out.
      return { ...result, ended: e instanceof SpendCapError ? 'spend_cap' : 'model_error', error: (e as Error).message };
    }
    result.turns = turn;
    result.modelMs += reply.stats.ms;
    result.promptTokens += reply.stats.prompt_tokens ?? 0;
    result.completionTokens += reply.stats.completion_tokens ?? 0;
    result.costUsd += reply.stats.cost_usd;
    if (!reply.stats.usage_reported) result.callsWithoutUsage++;
    result.retries += reply.stats.retries ?? 0;
    result.retryWaitMs += reply.stats.retry_wait_ms ?? 0;
    const calls: ToolCall[] = reply.message.tool_calls ?? [];
    // A provider can send a call with no function; ending the run here keeps the paid-for solves in the summary.
    const malformed = calls.find((c) => typeof c?.function?.name !== 'string');
    options.onEvent?.({
      type: 'model', turn, stats: reply.stats, text: typeof reply.message.content === 'string' ? reply.message.content : null,
      tool_calls: calls.map((c) => ({ name: c?.function?.name ?? '(malformed)', arguments: c?.function?.arguments ?? '' })),
    });
    if (malformed) return { ...result, ended: 'model_error', error: `the model sent a malformed tool call: ${JSON.stringify(malformed).slice(0, 300)}` };
    messages.push(reply.message);
    if (!calls.length) {
      // Three text replies in a row end the run; the last one is kept as the summary the model meant to give.
      if (++nudges > 2) {
        const text = typeof reply.message.content === 'string' ? reply.message.content.trim() : '';
        if (text && !session.finished) session.finished = { summary: `(not called as finish) ${text}` };
        return { ...result, ended: 'no_tool_call' };
      }
      const budget = `${session.searchSolvesLeft} search solves and ${session.confirmSolvesLeft} confirm solves left`;
      messages.push({ role: 'user', content: `No tool call. ${budget}. Act through a tool; call finish when you are done.` });
      continue;
    }
    nudges = 0;
    for (const call of calls) {
      const t0 = performance.now();
      let output: unknown;
      let args: unknown = {};
      try {
        if (call.function.arguments) args = JSON.parse(call.function.arguments);
      } catch (e) {
        args = new Error(`arguments are not valid JSON: ${(e as Error).message}`);
      }
      if (args instanceof Error) output = { error: args.message };
      else if (typeof args !== 'object' || args === null || Array.isArray(args)) output = { error: 'arguments must be a JSON object' };
      else {
        try {
          output = await callTool(session, call.function.name, args as Record<string, unknown>);
        } catch (e) {
          return { ...result, toolMs: result.toolMs + performance.now() - t0, ended: 'tool_error', error: `${call.function.name}: ${(e as Error).message}` };
        }
      }
      result.toolMs += performance.now() - t0;
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
    if (session.finished) return { ...result, ended: 'finished' };
  }
  return result;
}

/**
 * A rule-based stand-in for the model, for offline runs and tests: no network,
 * no spend. It follows the same tools and reads the same results, with fixed
 * rules (inset first, a slot when the length runs out, aim off the confirm
 * offset). It is a baseline, not an AI.
 */
export class ScriptedStrategist implements ChatModel {
  readonly label = 'scripted rules (no model)';
  private calls = 0;

  constructor(private readonly session: DesignSession) {}

  async chat(messages: ChatMessage[]): Promise<ChatTurn> {
    const last = [...messages].reverse().find((m) => m.role === 'tool');
    const lastCall = [...messages].reverse().find((m) => m.role === 'assistant')?.tool_calls as ToolCall[] | undefined;
    const lastName = lastCall?.[0]?.function.name;
    const r = last ? (JSON.parse(String(last.content)) as Record<string, unknown>) : null;
    const [name, args] = this.decide(lastName, r);
    const id = `call_${++this.calls}`;
    return {
      message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      stats: { ms: 0, prompt_tokens: null, completion_tokens: null, cost_usd: 0, usage_reported: true },
    };
  }

  private decide(lastName: string | undefined, r: Record<string, unknown> | null): [string, object] {
    const s = this.session;
    const left = s.searchSolvesLeft;
    const enabled = s.current.enabled;
    const perSearch = Math.max(8, Math.min(24, Math.floor(left / 2)));
    const matching = enabled.includes('stub') ? 'stub_l' : 'inset_d';
    if (!lastName) return ['optimise', { enable: [...new Set([...enabled, 'inset'])], free: ['patch_l', 'inset_d'], max_solves: perSearch }];
    if (r?.error && lastName !== 'confirm') return ['finish', { summary: `Stopped: ${r.error}` }];
    if (lastName === 'optimise' || lastName === 'try_design') {
      if (r?.met || r?.stop === 'aim met') return ['confirm', {}];
      const atBound = (r?.at_bound as string[] | undefined) ?? [];
      if (left >= 8 && atBound.some((b) => b.startsWith('patch_l at its max')) && !enabled.includes('slot')) {
        return ['optimise', { enable: [...enabled, 'slot'], free: ['slot_l', 'patch_l', matching], max_solves: perSearch }];
      }
      if (left >= 8 && s.goal.max_axial_ratio_db !== undefined && !enabled.includes('chamfer')) {
        return ['optimise', { enable: [...enabled, 'chamfer'], free: ['chamfer', 'patch_w', 'patch_l'], max_solves: perSearch }];
      }
      return ['finish', { summary: `Search did not meet the goal within budget (score ${r?.score}).` }];
    }
    if (lastName === 'confirm') {
      if (r?.met) return ['finish', { summary: `Confirmed on the fine mesh: f0 ${r.f0_ghz} GHz, S11 at target ${r.s11_at_target_db} dB.` }];
      const f0 = r?.f0_ghz as number | undefined;
      if (f0 && left >= 8 && (r?.confirm_solves_left as number) > 0) {
        const t = s.goal.target_ghz;
        const searchF0 = (r?.search_mesh_f0_ghz as number | undefined) ?? t;
        return ['optimise', { free: ['patch_l', matching], max_solves: perSearch, aim_ghz: Number(((t * searchF0) / f0).toFixed(4)) }];
      }
      return ['finish', { summary: `Confirm missed the goal (f0 ${f0} GHz) and the budget is spent.` }];
    }
    return ['finish', { summary: 'Done.' }];
  }
}

/**
 * A person or another agent in the model's seat, for a like-for-like
 * comparison with the API lanes: it reads the same messages and answers with
 * one tool call per turn, typed as `name {json arguments}` (`brief`,
 * `optimise {"free":["patch_l"],"max_solves":12}`). It prints every message
 * the model would read since its last turn (the brief, tool results, a
 * nudge). A line that is not a tool call is answered with the reason and read
 * again. Model time is think time.
 */
export class ManualDriver implements ChatModel {
  readonly label = 'manual (tool calls typed on stdin)';
  private calls = 0;
  private readonly lines: AsyncIterator<string>;

  constructor(lines: AsyncIterable<string>, private readonly print: (text: string) => void = console.log) {
    this.lines = lines[Symbol.asyncIterator]();
  }

  async chat(messages: ChatMessage[]): Promise<ChatTurn> {
    const lastOwn = messages.map((m) => m.role).lastIndexOf('assistant');
    for (const m of messages.slice(lastOwn + 1)) if (m.role === 'user' || m.role === 'tool') this.print(`${m.role === 'tool' ? '<' : ''} ${m.content}`.trim());
    const t0 = performance.now();
    for (;;) {
      this.print('> tool {json}');
      const next = await this.lines.next();
      if (next.done) throw new Error('input closed before finish');
      const call = parseTypedCall(next.value);
      if (typeof call === 'string') {
        this.print(call);
        continue;
      }
      return {
        message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${++this.calls}`, type: 'function', function: call }] },
        stats: { ms: Math.round(performance.now() - t0), prompt_tokens: null, completion_tokens: null, cost_usd: 0, usage_reported: true },
      };
    }
  }
}

/** `name {json}` to a tool call, or the reason it is not one. */
function parseTypedCall(line: string): { name: string; arguments: string } | string {
  const m = line.trim().match(/^(\w+)\s*(.*)$/s);
  if (!m) return 'type a tool name, then its arguments as one JSON object';
  const [, name, rest] = m;
  if (!STRATEGIST_TOOLS.some((t) => t.name === name)) return `unknown tool ${name}; tools: ${STRATEGIST_TOOLS.map((t) => t.name).join(', ')}`;
  try {
    JSON.parse(rest || '{}');
  } catch (e) {
    return `arguments are not valid JSON: ${(e as Error).message}`;
  }
  return { name, arguments: rest || '{}' };
}
