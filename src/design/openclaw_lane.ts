import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { designAt, parseDesignFile, projectFor, startPoint } from './design_file';
import type { DesignGoal } from './goal';
import type { Lane } from './llm';
import { appendToInbox } from './inbox';
import { startModelProxy, type ProxyCall } from './model_proxy';
import type { JournalEntry } from './replay';
import { createEvaluator } from './evaluate';
import { DesignSession, type SolveRecord } from './session';
import type { SpendGuard } from './spend';
import { STRATEGIST_PROMPT } from './strategist';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** What a Node process, its shell and the GPU driver need on Linux, macOS and Windows; nothing else is passed on. */
const PASSED_ENV = /^(PATH|PATHEXT|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|USER|USERNAME|LOGNAME|SHELL|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|DISPLAY|WAYLAND_DISPLAY|XDG_[A-Z_]+|VK_[A-Z_]+|DXC_[A-Z_]+)$/i;

/**
 * The environment for the harness and anything it starts (and for the lobe solve): an allowlist of the system
 * variables a process needs, so no API key, token or credential under any name reaches OpenClaw, and it can
 * never reach a provider except through the proxy.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => PASSED_ENV.test(name)));
}

/** The opening rules for a session that starts from a person's sentence: the strategist's, plus how to begin. */
export const SENTENCE_PROMPT = `${STRATEGIST_PROMPT}

The person's message is a design request in their own words. First call start_design with what it asks for:
target frequency, board size (a size limit such as "under 30 mm" is the board), substrate and thickness when named,
and a bandwidth or circular polarisation only when asked. Then design it with the other tools, and call finish.`;

export interface OpenClawLaneOptions {
  lane: Lane;
  apiKey: string;
  guard: SpendGuard;
  /** The person's request, word for word. */
  sentence: string;
  /** This lane's run folder (created). */
  outDir: string;
  reasoningEffort: string;
  /** The largest reply OpenClaw may ask for; the proxy reserves it in full before each call. */
  maxCompletionTokens: number;
  gpu: boolean;
  searchSolves: number;
  confirmSolves: number;
  /** Agent deadline in seconds. */
  timeoutS: number;
  /** The openclaw executable (default `openclaw` on PATH; needs Node 24.16+). */
  openclawBin?: string;
  /** Test hook: a fake provider instead of the lane's real endpoint. */
  upstream?: string;
  onCall?: (call: ProxyCall) => void;
  /** Start OpenClaw now but hold its first model request until this settles (see startModelProxy); false ends the lane. */
  holdUntil?: Promise<boolean | void>;
  /** Called once OpenClaw has started and asked for its first turn (it is then held, with holdUntil). */
  onReady?: () => void;
  /** A scripted mid-run message: written to the session inbox this many seconds into the lane's clock. */
  say?: { atS: number; text: string };
}

/** Where the person's mid-run messages go for a lane's run folder (src/design/inbox.ts). */
export const inboxFor = (outDir: string) => join(resolve(outDir), 'session', 'inbox.jsonl');

/** OpenClaw's config for one lane: only the NobuRF tools, one model behind the local proxy. Plain JSON is valid JSON5. */
export function openClawConfig(o: { proxyUrl: string; proxyKey: string; mcpArgs: string[]; modelName: string; maxTokens: number; timeoutS: number }) {
  return {
    mcp: {
      servers: {
        noburf: {
          command: process.execPath,
          args: o.mcpArgs,
          enabled: true,
          connectionTimeoutMs: 20000,
          // An optimise call runs many solves; allow it 15 minutes.
          requestTimeoutMs: 900000,
        },
      },
    },
    // Only the MCP tools: every extra schema is prompt tokens on every turn. Tool search would hide them.
    tools: { profile: 'minimal', alsoAllow: ['bundle-mcp'], deny: ['session_status', 'gateway', 'presence'], toolSearch: false },
    // Only the proxy's model, with no fallbacks and no built-in or globally configured providers: when the proxy
    // refuses a call (spend cap), OpenClaw must stop, not fail over to a provider it may hold a real key for.
    agents: { defaults: { model: { primary: 'noburf-lane/model', fallbacks: [] } } },
    models: {
      mode: 'replace',
      providers: {
        'noburf-lane': {
          baseUrl: o.proxyUrl,
          // The proxy holds the real key; OpenClaw only gets the proxy's own per-run key.
          apiKey: o.proxyKey,
          api: 'openai-completions',
          // The proxy is on loopback, so OpenClaw would treat it as a local model server; a held first request or a
          // long high-effort turn must not trip its idle watchdog before the run's own deadline.
          timeoutSeconds: o.timeoutS,
          models: [{
            id: 'model', name: o.modelName, reasoning: true, input: ['text'], contextWindow: 131072, maxTokens: o.maxTokens,
            compat: { supportedReasoningEfforts: ['low', 'medium', 'high', 'max'] },
          }],
        },
      },
    },
  };
}

/**
 * Harnesses still running. Off Windows each is its own process group, which a Ctrl+C in the terminal does not
 * reach, so the runner ends them itself before it exits.
 */
const liveHarnesses = new Set<() => void>();
function endLiveHarnesses(): never {
  for (const kill of liveHarnesses) kill();
  process.exit(130);
}
// A crash (an uncaught exception, an unhandled rejection) exits without SIGINT: end the groups then too, or OpenClaw
// and its solver keep the GPU busy until OpenClaw's own timeout.
process.on('exit', () => {
  for (const kill of liveHarnesses) kill();
});

/** OpenClaw's own timeout for a held lane, which must outlast its start-up, its hold and its run (see armDeadline). */
const HELD_HARNESS_TIMEOUT_S = 6 * 3600;
/** Seconds a lane's harness may take to start and send its first model request (measured 240 to 514 s on a Windows laptop). */
const HARNESS_STARTUP_S = 900;

interface McpEntry {
  t: number;
  type: 'solve' | 'tool' | 'say';
  record?: SolveRecord;
  name?: string;
  ms?: number;
  /** say: the message, and when the person wrote it (t is when the model got it, with a tool result). */
  text?: string;
  said_at?: number;
  /** start_design: the goal it set. */
  result?: { goal?: DesignGoal };
}

/**
 * One lane: OpenClaw runs the agent, the model behind the spend-guarded proxy,
 * the NobuRF tools as an MCP server starting from the sentence. Writes the
 * same run folder as `design run` (journal.jsonl, summary.json,
 * best.project.json, design.json), so `design replay` reads it unchanged.
 */
export async function runOpenClawLane(o: OpenClawLaneOptions): Promise<{ outDir: string; summary: Record<string, unknown> }> {
  const outDir = resolve(o.outDir);
  const sessionDir = join(outDir, 'session');
  const workspace = join(outDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(workspace, 'AGENTS.md'), SENTENCE_PROMPT + '\n');
  // A held lane waits through its own start-up and the other lane's whole run, which OpenClaw's own timer (started
  // at spawn) cannot know. So a held OpenClaw gets a long timeout, and the lane's deadline below starts at release.
  const harnessTimeoutS = o.holdUntil ? HELD_HARNESS_TIMEOUT_S : o.timeoutS;
  let sayTimer: NodeJS.Timeout | undefined;
  let armDeadline = () => {};
  let firstRequestSeen = false;
  const proxy = await startModelProxy({
    lane: o.lane, apiKey: o.apiKey, guard: o.guard, reasoningEffort: o.reasoningEffort, maxCompletionTokens: o.maxCompletionTokens,
    upstream: o.upstream, onCall: o.onCall, holdUntil: o.holdUntil,
    onFirstRequest: () => {
      firstRequestSeen = true;
      o.onReady?.();
    },
    onFirstForward: () => {
      armDeadline();
      const say = o.say;
      if (say) sayTimer = setTimeout(() => appendToInbox(inboxFor(outDir), say.text), say.atS * 1000);
    },
  });
  const mcpArgs = [
    join(REPO_ROOT, 'scripts', 'design-mcp.mjs'), 'mcp', '--out', sessionDir, '--inbox', inboxFor(outDir),
    '--solves', String(o.searchSolves), '--confirms', String(o.confirmSolves), ...(o.gpu ? ['--gpu'] : []),
  ];
  const configPath = join(outDir, 'openclaw.json5');
  // It holds the proxy's key while the run is live: readable by this user only.
  writeFileSync(configPath, JSON.stringify(openClawConfig({ proxyUrl: proxy.url, proxyKey: proxy.key, mcpArgs, modelName: o.lane.model, maxTokens: o.maxCompletionTokens, timeoutS: harnessTimeoutS }), null, 2) + '\n', { mode: 0o600 });

  const spawnedAt = Date.now();
  let exitCode: number | null;
  let envelope: unknown = null;
  try {
    // The request goes in a file, never on the command line: on Windows the openclaw shim runs through cmd.exe,
    // which would split and reinterpret the person's words. Every other argument is quoted for the same reason.
    const messageFile = join(outDir, 'request.txt');
    writeFileSync(messageFile, o.sentence);
    const windows = process.platform === 'win32';
    const args = [
      'agent', 'exec', '--message-file', messageFile, '--config', configPath, '--cwd', workspace, '--code-mode', 'direct', '--json',
      '--thinking', o.reasoningEffort, '--timeout', String(harnessTimeoutS),
    ];
    // OpenClaw's own state (sessions, auth profiles, its SQLite database) in the run folder: no key onboarded into the
    // person's OpenClaw can reach this harness, and two lanes starting at once do not wait on one shared database.
    const child = spawn(windows ? `"${o.openclawBin ?? 'openclaw'}"` : o.openclawBin ?? 'openclaw', windows ? args.map((a) => `"${a}"`) : args, {
      // Its own process group off Windows, so the deadline ends OpenClaw and the MCP solver it started together.
      cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], shell: windows, detached: !windows, env: { ...scrubbedEnv(), OPENCLAW_STATE_DIR: resolve(outDir, 'openclaw-state') },
    });
    // Our own deadline too: a harness that hangs, or keeps retrying refused calls, must not hold the race. The whole
    // tree is ended (on Windows the child is cmd.exe), so an MCP solver mid-optimise does not run on into the next
    // lane's clock or write to the journal after it is read.
    const killHarness = () => {
      // Never after it has exited: its PID (and group id) may belong to another process by then.
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (windows) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL'); // the group is already gone
        }
      }
    };
    let deadline: NodeJS.Timeout | undefined;
    armDeadline = () => {
      deadline ??= setTimeout(killHarness, (o.timeoutS + 60) * 1000);
    };
    if (!o.holdUntil) armDeadline();
    // Told not to race while held: end the harness (the proxy refuses the held request).
    o.holdUntil?.then((race) => {
      if (race === false) killHarness();
    }, () => killHarness());
    if (!windows) {
      if (liveHarnesses.size === 0) {
        process.once('SIGINT', endLiveHarnesses);
        process.once('SIGTERM', endLiveHarnesses);
      }
      liveHarnesses.add(killHarness);
    }
    // A harness that stays up but never sends its first model request would otherwise hold the race until the
    // deadline above (about an hour by default). Start-up takes minutes on some Windows machines, so allow that.
    const startupDeadline = setTimeout(() => {
      if (firstRequestSeen) return;
      console.log(`${o.lane.id}: OpenClaw sent no model request within ${HARNESS_STARTUP_S} s; ending the lane`);
      killHarness();
    }, HARNESS_STARTUP_S * 1000);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    exitCode = await new Promise<number | null>((done, fail) => {
      child.on('error', fail);
      child.on('close', done);
    }).finally(() => {
      liveHarnesses.delete(killHarness);
      if (liveHarnesses.size === 0) {
        process.off('SIGINT', endLiveHarnesses);
        process.off('SIGTERM', endLiveHarnesses);
      }
      clearTimeout(deadline);
      clearTimeout(startupDeadline);
    });
    writeFileSync(join(outDir, 'openclaw.out.json'), stdout);
    writeFileSync(join(outDir, 'openclaw.err.log'), stderr);
    try {
      envelope = JSON.parse(stdout);
    } catch {
      envelope = null;
    }
  } finally {
    clearTimeout(sayTimer);
    await proxy.close();
  }
  writeFileSync(join(outDir, 'model-calls.json'), JSON.stringify(proxy.calls, null, 2) + '\n');
  const mcpJournalPath = join(sessionDir, 'journal.jsonl');
  const mcpEntries: McpEntry[] = existsSync(mcpJournalPath)
    ? readFileSync(mcpJournalPath, 'utf8').split('\n').filter(Boolean).flatMap(parseJournalLine)
    : [];
  const designPath = join(sessionDir, 'design.json');
  const design = existsSync(designPath) ? parseDesignFile(JSON.parse(readFileSync(designPath, 'utf8'))) : null;
  // The closing confirm runs here, after OpenClaw has exited (its MCP server may be killed with it), so it is
  // never lost and never overlaps the next lane. It is solver time and counts on the lane's clock, as in `design run`.
  // After a restart (the person changed the request mid-run) only the solves since the last start answer the goal.
  const starts = mcpEntries.flatMap((e, n) => (e.type === 'tool' && e.name === 'start_design' ? [n] : []));
  const lastStartAt = starts.at(-1) ?? 0;
  const confirmsUsed = mcpEntries.filter((e) => e.type === 'solve' && e.record?.fidelity === 'confirm').length;
  if (design) mcpEntries.push(...(await closingConfirm(design, mcpEntries.slice(lastStartAt), o, confirmsUsed)));
  const endedAt = Date.now();
  // The lane's clock starts when the agent sends its first model request: OpenClaw's own start-up (loading, starting
  // the MCP server) is the same fixed cost on every lane and has nothing to do with inference. It is reported apart.
  const t0 = Math.min(...proxy.calls.map((c) => c.started_at), endedAt);
  const wallMs = endedAt - t0;
  const journal = laneJournal(proxy.calls, mcpEntries, t0);
  writeFileSync(join(outDir, 'journal.jsonl'), journal.map((e) => JSON.stringify(e)).join('\n') + (journal.length ? '\n' : ''));

  const solves = mcpEntries.filter((e) => e.type === 'solve' && e.record?.metrics).map((e) => e.record!);
  const confirmed = mcpEntries.slice(lastStartAt)
    .filter((e) => e.type === 'solve' && e.record?.metrics && e.record.fidelity === 'confirm').map((e) => e.record!).sort((a, b) => a.score - b.score);
  const best = confirmed[0] ?? null;
  const answered = proxy.calls.filter((c) => c.http_status === 200);
  const modelMs = answered.reduce((s, c) => s + c.ended_at - c.started_at, 0);
  // Model time split at each call's first streamed token (reasoning included): before it, the provider's queue and
  // the prompt read; after it, generation. Under load a host can queue each call for a minute and then answer in a
  // fraction of a second, so the race reports the two apart.
  const timed = answered.flatMap((c) => (c.time_to_first_token_ms === null ? [] : [{ total: c.ended_at - c.started_at, ttft: c.time_to_first_token_ms }]));
  const firstTokenWaitMs = timed.reduce((s, c) => s + c.ttft, 0);
  const generatingMs = timed.reduce((s, c) => s + Math.max(0, c.total - c.ttft), 0);
  const waitMs = rateLimitWaits(proxy.calls).reduce((s, w) => s + w, 0);
  const toolMs = mcpEntries.filter((e) => e.type === 'tool').reduce((s, e) => s + (e.ms ?? 0), 0);
  const finished = mcpEntries.some((e) => e.type === 'tool' && e.name === 'finish');
  const refused = proxy.calls.filter((c) => c.http_status === 402).length;
  // On Windows OpenClaw can fail to delete its temp state (EBUSY on a sqlite file) after the turn completed: it then
  // exits 1 with error.kind "cleanup". That is not a harness failure.
  const errorKind = (envelope as { error?: { kind?: unknown } } | null)?.error?.kind ?? null;
  const cleanExit = exitCode === 0 || errorKind === 'cleanup';
  const round1 = (x: number) => Math.round(x * 10) / 10;
  const summary = {
    sentence: o.sentence,
    harness: 'OpenClaw',
    // A local stand-in played the model: the lane label names a model that never ran.
    ...(o.upstream ? { stand_in_provider: true } : {}),
    goal: design?.goal ?? null,
    model: `${o.lane.model} on ${o.lane.id}`,
    reasoning_effort: o.reasoningEffort,
    solver: o.gpu ? 'WGSL (GPU)' : 'CPU reference',
    ended: finished ? 'finished' : refused ? 'spend_cap' : cleanExit ? 'no_finish' : 'harness_error',
    openclaw_exit: exitCode,
    best_confirmed: best ? { met: best.score === 0, score: best.score, point: best.point, metrics: best.metrics } : null,
    timing: {
      wall_s: round1(wallMs / 1000),
      model_s: round1(modelMs / 1000),
      // Of model_s, for the calls that streamed: waiting for the first token (queue and prompt read), and generating.
      first_token_wait_s: round1(firstTokenWaitMs / 1000),
      generating_s: round1(generatingMs / 1000),
      rate_limit_wait_s: round1(waitMs / 1000),
      tools_s: round1(toolMs / 1000),
      // OpenClaw's own work between calls, failed calls and its shutdown.
      other_s: round1(Math.max(0, wallMs - modelMs - waitMs - toolMs) / 1000),
      // From spawning OpenClaw to its first model request; then, for a held lane, the wait for its turn.
      harness_startup_s: round1(Math.max(0, (proxy.firstArrivalAt ?? t0) - spawnedAt) / 1000),
      held_s: round1(Math.max(0, t0 - (proxy.firstArrivalAt ?? t0)) / 1000),
      model_turns: answered.length,
    },
    solves: { search: solves.filter((r) => r.fidelity === 'search').length, confirm: solves.filter((r) => r.fidelity === 'confirm').length },
    tokens: {
      prompt: answered.reduce((s, c) => s + (c.prompt_tokens ?? 0), 0),
      completion: answered.reduce((s, c) => s + (c.completion_tokens ?? 0), 0),
      reasoning: answered.reduce((s, c) => s + (c.reasoning_tokens ?? 0), 0),
      calls_without_usage: answered.filter((c) => !c.usage_reported).length,
    },
    calls_refused_by_spend_cap: refused,
    person_says: mcpEntries.filter((e) => e.type === 'say').map((e) => ({ text: e.text, said_s: round1(((e.said_at ?? e.t) - t0) / 1000), heard_s: round1((e.t - t0) / 1000) })),
    restarts: Math.max(0, mcpEntries.filter((e) => e.type === 'tool' && e.name === 'start_design').length - 1),
    cost_usd: Number(o.guard.spentThisRun.toFixed(5)),
    openclaw: envelope && typeof envelope === 'object' ? { status: (envelope as Record<string, unknown>).status ?? null, error_kind: errorKind } : null,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  if (design) {
    const bestSearch = solves.filter((r) => r.fidelity === 'search').sort((a, b) => a.score - b.score)[0];
    const point = best?.point ?? bestSearch?.point ?? startPoint(design);
    writeFileSync(join(outDir, 'best.project.json'), JSON.stringify(projectFor(design, point, 'confirm'), null, 2) + '\n');
    writeFileSync(join(outDir, 'design.json'), JSON.stringify(designAt(design, point), null, 2) + '\n');
  }
  return { outDir, summary };
}

/**
 * The lane's journal in `design run`'s shape (times from the lane's start):
 * a model entry when each answered call ends, with the tool calls it made, and
 * the MCP server's solve and tool entries. A rate-limited call is not a model
 * turn; its wait shows on the next turn as retry_wait_ms, as in the direct loop.
 */
export function laneJournal(calls: ProxyCall[], mcp: McpEntry[], t0: number): JournalEntry[] {
  const entries: Array<JournalEntry & { t_ms: number }> = [];
  const ordered = [...calls].sort((a, b) => a.started_at - b.started_at);
  const waits = rateLimitWaits(ordered);
  let waitMs = 0;
  let turn = 0;
  for (const [n, c] of ordered.entries()) {
    waitMs += waits[n];
    if (c.http_status !== 200) continue;
    entries.push({
      t_ms: c.ended_at - t0,
      type: 'model',
      turn: ++turn,
      stats: {
        ms: c.ended_at - c.started_at,
        completion_tokens: c.completion_tokens,
        ...(waitMs ? { retry_wait_ms: waitMs } : {}),
        ...(c.served_by ? { served_by: c.served_by } : {}),
      },
      text: null,
      // Harnesses name MCP tools after their server (OpenClaw: noburf__optimise); the journal uses the tool's own name.
      tool_calls: c.tool_calls.map((t) => ({ ...t, name: t.name.replace(/^noburf__/, '') })),
    } as JournalEntry & { t_ms: number });
    waitMs = 0;
  }
  for (const e of mcp) {
    if (e.type === 'solve') entries.push({ t_ms: e.t - t0, type: 'solve', record: e.record! } as JournalEntry & { t_ms: number });
    else if (e.type === 'say') entries.push({ t_ms: (e.said_at ?? e.t) - t0, type: 'say', text: e.text ?? '', heard_ms: e.t - t0 } as JournalEntry & { t_ms: number });
    else entries.push({ t_ms: e.t - t0, type: 'tool', name: e.name!, ...(e.result?.goal ? { goal: e.result.goal } : {}) } as JournalEntry & { t_ms: number });
  }
  return entries.sort((a, b) => a.t_ms - b.t_ms);
}

/**
 * Time lost to each rate-limited call: from its start to the start of the next call (the harness's backoff
 * included), or to its own end when it was the last. 0 for every other call. Calls ordered by start.
 */
export function rateLimitWaits(calls: ProxyCall[]): number[] {
  const ordered = [...calls].sort((a, b) => a.started_at - b.started_at);
  return ordered.map((c, n) => (c.http_status === 429 ? (ordered[n + 1]?.started_at ?? c.ended_at) - c.started_at : 0));
}

/**
 * When the agent stopped without a confirmed design that meets the goal and confirms are left, confirm its best
 * unconfirmed search design, as `design run` does. The session is rebuilt from the MCP journal's solves, so the
 * choice follows the same rule (DesignSession.closingConfirm), except that an aimed optimise result is not known
 * here and the best search score is used. Returns the journal entries it adds.
 */
async function closingConfirm(design: ReturnType<typeof parseDesignFile>, mcpEntries: McpEntry[], o: OpenClawLaneOptions, confirmsUsed: number): Promise<McpEntry[]> {
  const records = mcpEntries.filter((e) => e.type === 'solve' && e.record).map((e) => e.record!);
  const confirmsLeft = o.confirmSolves - confirmsUsed;
  if (confirmsLeft <= 0 || !records.some((r) => r.fidelity === 'search' && r.metrics)) return [];
  const added: McpEntry[] = [];
  const evaluator = createEvaluator(design.goal, { useGpu: o.gpu });
  try {
    const session = new DesignSession(design, evaluator, { maxSearchSolves: 0, maxConfirmSolves: confirmsLeft }, (e) => {
      if (e.type === 'solve') added.push({ t: Date.now(), type: 'solve', record: e.record });
    });
    session.records.push(...records);
    const t0 = Date.now();
    const result = await session.closingConfirm();
    if (result) added.push({ t: Date.now(), type: 'tool', name: 'closing_confirm', ms: Date.now() - t0 });
  } finally {
    await evaluator.close();
  }
  return added;
}

/** One journal line, or none if it is cut short (the MCP server can still be writing when a lane is killed). */
function parseJournalLine(line: string): McpEntry[] {
  try {
    return [JSON.parse(line) as McpEntry];
  } catch {
    return [];
  }
}
