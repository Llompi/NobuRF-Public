import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ProxyCall } from './model_proxy';

/**
 * The record of OpenClaw-driven runs, for the demo video and the with/without-Cerebras comparison: one line per
 * lane run in runs/ledger.jsonl, built only from what each run folder already holds (summary.json, the proxy's
 * model-calls.json). Nothing here changes how a run is made.
 *
 * Model time is split three ways, so a slow queue does not hide how fast the model itself is:
 * - wait: from sending a call to its first streamed token (the provider's queue, reading the prompt, the network);
 * - generation: from the first streamed token to the last, measured here; tokens per second use this time only;
 * - the provider's own timing, when it reports one (Cerebras time_info: queue, prompt and completion seconds).
 */
export interface ModelTiming {
  /** Sum over answered calls of the wait for the first token. */
  wait_s: number;
  /** Sum over answered calls of first token to last token. */
  generation_s: number;
  /** Completion tokens over generation time, from calls long enough to measure (see MIN_GENERATION_MS). */
  generation_tokens_per_s: number | null;
  median_first_token_s: number | null;
  /** Calls whose wait could not be measured (no streamed token); their whole time counts as wait. */
  calls_unmeasured: number;
  /** The provider's own figures, summed over the calls that carried them; null when none did. */
  server: { calls: number; queue_s: number; prompt_s: number; completion_s: number; completion_tokens_per_s: number | null } | null;
}

export interface LedgerEntry {
  recorded_at: string;
  run_dir: string;
  /** The race this lane belonged to (its folder), or null for a single `design agent` run. */
  race_dir: string | null;
  lane: string;
  model: string;
  harness: string;
  openclaw_version: string | null;
  /** Hosts that answered, from the proxy (OpenRouter names its host per call). */
  served_by: string[];
  /** A local stand-in played the model: the run proves the plumbing, not any speed. */
  stand_in_provider: boolean;
  request: string;
  reasoning_effort: string;
  solver: string;
  ended: string;
  goal_met: boolean | null;
  best: { f0_ghz?: number; s11_db?: number } | null;
  timing: {
    wall_s: number;
    model_s: number;
    tools_s: number;
    rate_limit_wait_s: number;
    harness_startup_s: number;
    model_turns: number;
  };
  model_timing: ModelTiming;
  tokens: { prompt: number; completion: number; reasoning: number };
  cost_usd: number;
  command: string;
  recording: string | null;
}

const round = (x: number, digits = 1) => Math.round(x * 10 ** digits) / 10 ** digits;
/** A reply that arrives in one burst has no generation time to measure: it would read as millions of tokens a second. */
const MIN_GENERATION_MS = 50;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The wait / generation / provider split over a lane's answered calls. */
export function modelTiming(calls: ProxyCall[]): ModelTiming {
  const answered = calls.filter((c) => c.http_status === 200);
  let waitMs = 0;
  let generationMs = 0;
  let rateTokens = 0;
  let rateMs = 0;
  let unmeasured = 0;
  for (const c of answered) {
    const total = c.ended_at - c.started_at;
    if (c.time_to_first_token_ms == null) {
      unmeasured++;
      waitMs += total;
      continue;
    }
    const generation = Math.max(0, (c.last_token_ms ?? total) - c.time_to_first_token_ms);
    waitMs += c.time_to_first_token_ms;
    generationMs += generation;
    if (c.completion_tokens != null && generation >= MIN_GENERATION_MS) {
      rateTokens += c.completion_tokens;
      rateMs += generation;
    }
  }
  const timed = answered.filter((c) => c.server_timing);
  const sum = (k: 'queue_s' | 'prompt_s' | 'completion_s') => timed.reduce((s, c) => s + (c.server_timing![k] ?? 0), 0);
  const serverTokens = timed.reduce((s, c) => s + (c.completion_tokens ?? 0), 0);
  const serverCompletion = sum('completion_s');
  const ttft = median(answered.flatMap((c) => (c.time_to_first_token_ms == null ? [] : [c.time_to_first_token_ms / 1000])));
  return {
    wait_s: round(waitMs / 1000),
    generation_s: round(generationMs / 1000),
    generation_tokens_per_s: rateMs > 0 ? round(rateTokens / (rateMs / 1000)) : null,
    median_first_token_s: ttft == null ? null : round(ttft, 2),
    calls_unmeasured: unmeasured,
    server: timed.length
      ? {
        calls: timed.length,
        queue_s: round(sum('queue_s'), 2),
        prompt_s: round(sum('prompt_s'), 2),
        completion_s: round(serverCompletion, 2),
        completion_tokens_per_s: serverCompletion > 0 ? round(serverTokens / serverCompletion) : null,
      }
      : null,
  };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

/** The ledger line for one lane's run folder, or null when the run left no summary (it never got going). */
export function ledgerEntryFor(runDir: string, context: { command: string; openclawVersion: string | null; recording: string | null; now?: Date }): LedgerEntry | null {
  const summaryPath = join(runDir, 'summary.json');
  if (!existsSync(summaryPath)) return null;
  const s = readJson(summaryPath);
  const callsPath = join(runDir, 'model-calls.json');
  const calls: ProxyCall[] = existsSync(callsPath) ? readJson(callsPath) : [];
  const best = s.best_confirmed ?? null;
  const metrics = best?.metrics ?? {};
  const raceDir = existsSync(join(dirname(runDir), 'replay-left.json')) || basename(dirname(runDir)).startsWith('race-') ? dirname(runDir) : null;
  const t = s.timing ?? {};
  return {
    recorded_at: (context.now ?? new Date()).toISOString(),
    run_dir: runDir,
    race_dir: raceDir,
    lane: basename(runDir).replace(/-\d{4}-\d{2}-\d{2}T.*$/, ''),
    model: s.model ?? '',
    harness: s.harness ?? 'unknown',
    openclaw_version: context.openclawVersion,
    served_by: [...new Set(calls.flatMap((c) => (c.served_by ? [c.served_by] : [])))],
    stand_in_provider: Boolean(s.stand_in_provider),
    request: s.sentence ?? '',
    reasoning_effort: s.reasoning_effort ?? '',
    solver: s.solver ?? '',
    ended: s.ended ?? 'unknown',
    goal_met: best ? Boolean(best.met) : null,
    best: best ? { f0_ghz: metrics.f0_ghz, s11_db: metrics.s11_min_db } : null,
    timing: {
      wall_s: t.wall_s ?? 0,
      model_s: t.model_s ?? 0,
      tools_s: t.tools_s ?? 0,
      rate_limit_wait_s: t.rate_limit_wait_s ?? 0,
      harness_startup_s: t.harness_startup_s ?? 0,
      model_turns: t.model_turns ?? 0,
    },
    model_timing: modelTiming(calls),
    tokens: { prompt: s.tokens?.prompt ?? 0, completion: s.tokens?.completion ?? 0, reasoning: s.tokens?.reasoning ?? 0 },
    cost_usd: s.cost_usd ?? 0,
    command: context.command,
    recording: context.recording,
  };
}

/** Lane folders under a run or race folder: the folder itself when it holds a summary, else its children that do. */
export function laneDirsIn(dir: string): string[] {
  if (existsSync(join(dir, 'summary.json'))) return [dir];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).map((n) => join(dir, n)).filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'summary.json'))).sort();
}

export function readLedger(path: string): LedgerEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as LedgerEntry];
    } catch {
      return [];
    }
  });
}

const fmt = (x: number | null | undefined) => (x == null ? 'n/a' : String(x));
const ratio = (slow: number | null | undefined, fast: number | null | undefined) => (slow && fast ? `${round(slow / fast)}x` : 'n/a');
const server = (e: LedgerEntry) => e.model_timing?.server ?? null;

/**
 * A plain report: every run, then each race with Cerebras beside the other lane. Wall time is shown as measured,
 * queue included; the generation columns leave the queue out. Stand-in runs are kept and labeled, never counted.
 */
export function ledgerReport(entries: LedgerEntry[]): string {
  const lines = [
    '# OpenClaw run ledger', '',
    `${entries.length} lane runs. OpenClaw drove every run; the model sat behind the local relay that holds the key.`, '',
    'How model time is split: **wait** runs from sending a call to its first token (the provider\'s queue, reading the prompt, the network). '
      + '**Generation** runs from the first token to the last, timed on this machine. Tokens per second use generation time only. '
      + '**Server** figures are the provider\'s own (Cerebras reports queue, prompt and completion time per call; the GPU host reports none). '
      + 'Wall time is the whole run as a person waits for it, queue included.', '',
  ];
  lines.push('| When (UTC) | Lane | Model | Ended | Goal | Wall s | Model s | Wait s | Generation s | Gen tok/s | Server queue s | Server compute s | Server tok/s | Solver s | Turns | Cost | Note |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const e of entries) {
    const m = e.model_timing;
    const sv = server(e);
    const goal = e.goal_met == null ? 'none' : e.goal_met ? 'met' : 'missed';
    const note = [
      e.stand_in_provider ? 'stand-in model, not a result' : '',
      e.served_by.length ? `served by ${e.served_by.join(', ')}` : '',
      m?.calls_unmeasured ? `${m.calls_unmeasured} call(s) without a streamed token, counted as wait` : '',
    ].filter(Boolean).join('; ');
    lines.push(`| ${e.recorded_at.slice(0, 16).replace('T', ' ')} | ${e.lane} | ${e.model} | ${e.ended} | ${goal} | ${e.timing.wall_s} | ${e.timing.model_s} | ${fmt(m?.wait_s)} | ${fmt(m?.generation_s)} | ${fmt(m?.generation_tokens_per_s)} | ${fmt(sv?.queue_s)} | ${sv ? round(sv.prompt_s + sv.completion_s, 2) : 'n/a'} | ${fmt(sv?.completion_tokens_per_s)} | ${e.timing.tools_s} | ${e.timing.model_turns} | $${e.cost_usd} | ${note} |`);
  }
  const races = new Map<string, LedgerEntry[]>();
  for (const e of entries) if (e.race_dir) races.set(e.race_dir, [...(races.get(e.race_dir) ?? []), e]);
  if (races.size) {
    lines.push('', '## Races: Cerebras beside the other lane', '');
    lines.push('Speed-ups are the other lane over Cerebras. "Generation" leaves every queue out; "wall" keeps it in.', '');
    lines.push('| Race | Request | Generation s (Cerebras / other) | Generation speed-up | Gen tok/s (Cerebras / other) | Wait s (Cerebras / other) | Wall s (Cerebras / other) | Wall speed-up | Note |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const [dir, lanes] of races) {
      const c = lanes.find((e) => e.lane === 'cerebras');
      const o = lanes.find((e) => e.lane !== 'cerebras');
      if (!c?.model_timing || !o?.model_timing) continue;
      const standIn = c.stand_in_provider || o.stand_in_provider ? 'stand-in model, not a result' : '';
      const cm = c.model_timing;
      const om = o.model_timing;
      lines.push(`| ${basename(dir)} | ${c.request.slice(0, 60)} | ${cm.generation_s} / ${om.generation_s} | ${ratio(om.generation_s, cm.generation_s)} | ${fmt(cm.generation_tokens_per_s)} / ${fmt(om.generation_tokens_per_s)} | ${cm.wait_s} / ${om.wait_s} | ${c.timing.wall_s} / ${o.timing.wall_s} | ${ratio(o.timing.wall_s, c.timing.wall_s)} | ${standIn} |`);
    }
  }
  return lines.join('\n') + '\n';
}
