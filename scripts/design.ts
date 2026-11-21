/**
 * AI-directed antenna design on the headless solver.
 *
 *   npm run design -- new --target 5.8 --board 20x20 [--s11 -10] [--bandwidth 300] [--axial-ratio 3]
 *                         [--substrate FR-4:4.4:1.6] --out my.design.json
 *   npm run design -- new --target 5.8 --from my-project.json [--s11 -10] ... --out my.design.json
 *                         (tunes the project's own unlocked variables within their min and max)
 *   npm run design -- run my.design.json [--model scripted|manual|cerebras|openrouter] [--gpu]
 *                         [--solves 60] [--confirms 3] [--turns 16] [--workers N] [--effort low] [--run-cap 0.5]
 *   npm run design -- mcp my.design.json [--gpu] [--solves 60] [--confirms 3] [--max-calls 40]   (stdio MCP server, for OpenClaw)
 *
 * The model chooses the strategy (features, free variables, aims); a
 * Nelder-Mead optimiser and the FDTD solver do the search. See docs/design-agent.md.
 * Keys come from the environment or a .env file in the working directory, never the command line.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { designAt, designFromProject, parseDesignFile, tuningDesignFromProject, projectFor, type DesignFile } from '../src/design/design_file';
import { createEvaluator } from '../src/design/evaluate';
import { decideUseGpu } from './noburf';
import type { DesignGoal } from '../src/design/goal';
import { HttpChatModel, laneFor, type ChatModel } from '../src/design/llm';
import { patchDesign } from '../src/design/patch_template';
import { parseProject } from '../src/project/schema';
import { replayFromJournal, servedBy } from '../src/design/replay';
import { DesignSession, type SensitivityReport, type SessionEvent } from '../src/design/session';
import { DEFAULT_LEDGER, MAX_PROVIDER_CAP_USD, SpendGuard } from '../src/design/spend';
import { callTool, ManualDriver, runStrategist, ScriptedStrategist, STRATEGIST_TOOLS, type StrategistEvent, type StrategistResult } from '../src/design/strategist';

const USAGE = `usage: design new --target <GHz> --board <W>x<L> [--s11 dB] [--bandwidth MHz] [--axial-ratio dB] [--substrate name:eps_r:h_mm] --out <file>
       design new --target <GHz> --from <project.json> [--s11 dB] [--bandwidth MHz] [--axial-ratio dB] --out <file>
       design run <file> [--model scripted|manual|cerebras|openrouter] [--gpu] [--solves N] [--confirms N] [--turns N] [--workers N] [--effort low] [--run-cap USD]
       design mcp <file> [--gpu] [--solves N] [--confirms N] [--workers N] [--max-calls 40]
       design race <file> [--lanes cerebras,openrouter] [run options]   (both lanes, one after the other, then replay logs)
       design replay <run folder> <run folder> [--labels "left|right"] [--out <folder>]
       design sensitivity <design or project file> [--variables a,b] [--rank f0_mhz|s11_target_db|zin_target_ohm|s11_min_db]
                         [--fidelity search|confirm] [--step-pct 2] [--check-step] [--target GHz] [--gpu | --cpu] [--workers N] [--out report.json]`;

/** Lifetime cap per provider for this tool, under the owner's $5 credit with room for the other tools that use the same key. */
const DEFAULT_PROVIDER_CAP_USD = MAX_PROVIDER_CAP_USD;
/**
 * The largest reply a call may ask for, by reasoning effort; the spend guard reserves it in full before each call.
 * At low effort the largest real reply on Nov 19 was 387 tokens (Kimi, reasoning included), so 1024 leaves room
 * without the 4096-token reservation that stopped Kimi runs after 2 to 4 turns.
 */
const MAX_COMPLETION_TOKENS: Record<string, number> = { low: 1024, medium: 2048, high: 4096, max: 4096 };
/** About the size of the first call (system prompt, brief and tool schemas), for the run-cap check. */
const OPENING_PROMPT_TOKENS = 3000;

function flags(argv: string[], booleans: string[]): { positional: string[]; opts: Map<string, string> } {
  const positional: string[] = [];
  const opts = new Map<string, string>();
  for (let n = 0; n < argv.length; n++) {
    const a = argv[n];
    if (!a.startsWith('--')) positional.push(a);
    else if (booleans.includes(a)) opts.set(a, 'true');
    else if (n + 1 < argv.length) opts.set(a, argv[++n]);
    else throw new Error(`${a} needs a value\n${USAGE}`);
  }
  return { positional, opts };
}

const numberOpt = (opts: Map<string, string>, name: string, fallback?: number): number | undefined => {
  const v = opts.get(name);
  if (v === undefined) return fallback;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${name} must be a number, got "${v}"`);
  return x;
};

function newDesign(argv: string[]): void {
  const { opts } = flags(argv, []);
  const target = numberOpt(opts, '--target');
  const board = opts.get('--board')?.match(/^\s*([\d.]+)\s*[x×]\s*([\d.]+)\s*(mm)?\s*$/i);
  const from = opts.get('--from');
  const out = opts.get('--out');
  if (board && from) throw new Error('--board makes a new patch and --from tunes your own project: give one of them');
  if (!target || !out || (!board && !from)) throw new Error(USAGE);
  if (from && !existsSync(from)) throw new Error(`--from: no file ${from}`);
  const goal: DesignGoal = {
    target_ghz: target,
    s11_max_db: numberOpt(opts, '--s11', -10)!,
    f_tolerance_pct: 1,
    ...(opts.has('--bandwidth') ? { min_bandwidth_mhz: numberOpt(opts, '--bandwidth') } : {}),
    ...(opts.has('--axial-ratio') ? { max_axial_ratio_db: numberOpt(opts, '--axial-ratio') } : {}),
  };
  let substrate;
  if (opts.has('--substrate')) {
    const [material, epsR, h] = opts.get('--substrate')!.split(':');
    substrate = { material, epsR: Number(epsR), thicknessMm: Number(h) };
    if (!material || !(substrate.epsR >= 1) || !(substrate.thicknessMm > 0)) throw new Error('--substrate is name:eps_r:thickness_mm, e.g. FR-4:4.4:1.6');
  }
  if (from && substrate) throw new Error('--substrate is for a new patch; a project from --from keeps its own stackup');
  const design = from
    ? tuningDesignFromProject(parseProject(JSON.parse(readFileSync(from, 'utf8'))), goal)
    : patchDesign({ goal, boardWMm: Number(board![1]), boardLMm: Number(board![2]), substrate });
  parseDesignFile(design); // the template must itself be valid
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(design, null, 2) + '\n');
  console.log(`wrote ${out}: ${design.project.name}, goal ${JSON.stringify(goal)}`);
}

function loadDesign(path: string): DesignFile {
  return parseDesignFile(JSON.parse(readFileSync(path, 'utf8')));
}

function sessionFor(design: DesignFile, opts: Map<string, string>, onEvent: (e: SessionEvent) => void) {
  const evaluator = createEvaluator(design.goal, { useGpu: opts.has('--gpu'), workers: numberOpt(opts, '--workers') });
  const session = new DesignSession(design, evaluator, {
    maxSearchSolves: numberOpt(opts, '--solves', 60)!,
    maxConfirmSolves: numberOpt(opts, '--confirms', 3)!,
  }, onEvent);
  return { evaluator, session };
}

function modelFor(lane: string, session: DesignSession, opts: Map<string, string>): ChatModel {
  if (lane === 'scripted') return new ScriptedStrategist(session);
  if (lane === 'manual') return new ManualDriver(createInterface({ input: process.stdin, terminal: false }));
  const l = laneFor(lane);
  const key = process.env[l.keyEnv];
  if (!key) throw new Error(`${l.keyEnv} is not set (environment or .env)`);
  const providerCap = Number(process.env.NOBURF_PROVIDER_CAP_USD ?? DEFAULT_PROVIDER_CAP_USD);
  const guard = new SpendGuard(l.id, l.price, numberOpt(opts, '--run-cap', 0.5)!, providerCap, process.env.NOBURF_SPEND_LEDGER ?? DEFAULT_LEDGER);
  const effort = opts.get('--effort') ?? 'low';
  const maxCompletionTokens = MAX_COMPLETION_TOKENS[effort];
  if (!maxCompletionTokens) throw new Error(`--effort is low, medium, high or max, not "${effort}"`);
  // Every call reserves its worst case first, so a run cap below a few calls' worth stops the run before it starts.
  const perCall = guard.costUsd(OPENING_PROMPT_TOKENS, maxCompletionTokens);
  if (guard.runCapUsd < 3 * perCall) {
    throw new Error(`--run-cap $${guard.runCapUsd} is too small for ${l.model}: each call reserves up to $${perCall.toFixed(4)} before it is sent, so allow at least $${(3 * perCall).toFixed(2)}`);
  }
  console.log(`${l.model} on ${l.id}: spent so far $${guard.spentEver().toFixed(4)} of the $${providerCap} cap (${guard.ledgerPath}); run cap $${guard.runCapUsd}, each call reserves up to $${perCall.toFixed(4)} first`);
  return new HttpChatModel(l, key, guard, { reasoningEffort: effort, maxCompletionTokens });
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** One design run; returns its output folder. */
async function run(argv: string[]): Promise<string> {
  const { positional: [path], opts } = flags(argv, ['--gpu']);
  if (!path) throw new Error(USAGE);
  const design = loadDesign(path);
  const lane = opts.get('--model') ?? 'scripted';
  const outDir = join(dirname(path), `${basename(path).replace(/\.json$/i, '')}.runs`, `${lane}-${stamp()}`);
  mkdirSync(outDir, { recursive: true });
  const journal = join(outDir, 'journal.jsonl');
  const t0 = performance.now();
  const log = (e: SessionEvent | StrategistEvent) => {
    writeFileSync(journal, JSON.stringify({ t_ms: Math.round(performance.now() - t0), ...e }) + '\n', { flag: 'a' });
    if (e.type === 'model') console.log(`model ${e.stats.ms} ms${e.stats.finish_reason ? ` (${e.stats.finish_reason})` : ''}: ${e.tool_calls.map((c) => `${c.name} ${c.arguments}`).join('; ') || e.text}`);
    // The manual driver prints the results itself, as the model reads them.
    if (e.type === 'tool' && (lane !== 'manual' || e.name === 'closing_confirm')) console.log(`  ${e.name} (${(e.ms / 1000).toFixed(1)} s) -> ${JSON.stringify(e.result)}`);
  };
  const { evaluator, session } = sessionFor(design, opts, log);
  const model = modelFor(lane, session, opts);
  let result: StrategistResult;
  let closing: Awaited<ReturnType<DesignSession['closingConfirm']>> = null;
  let closingMs = 0;
  try {
    result = await runStrategist(session, model, { maxTurns: numberOpt(opts, '--turns', 16)!, onEvent: log });
    // A strategist that stopped without a confirmed design meeting the goal still gets its best search design checked.
    const tc = performance.now();
    closing = result.ended === 'tool_error' ? null : await session.closingConfirm();
    closingMs = performance.now() - tc;
    if (closing) log({ type: 'tool', name: 'closing_confirm', args: {}, result: closing, ms: Math.round(closingMs) });
  } catch (error) {
    // A crash mid-loop: the journal already holds every call and its cost; this adds the best design found
    // so far, so a paid-for run is never lost to one exception. (A killed process leaves only the journal.)
    const best = session.bestConfirmed();
    try {
      writeFileSync(join(outDir, 'interrupted.json'), JSON.stringify({
        error: (error as Error).message,
        best_confirmed: best ? { met: best.score === 0, score: best.score, point: best.point, metrics: best.metrics } : null,
        solves: session.records.length,
        journal: 'journal.jsonl',
      }, null, 2) + '\n');
      console.error(`Run interrupted; what was found so far is in ${join(outDir, 'interrupted.json')}`);
    } catch (writeError) {
      console.error(`Run interrupted, and interrupted.json could not be written (${(writeError as Error).message}); see ${journal}`);
    }
    throw error;
  } finally {
    await evaluator.close();
  }
  const wallMs = performance.now() - t0;
  const best = session.bestConfirmed();
  const summary = {
    design: path,
    goal: design.goal,
    model: model.label,
    solver: opts.has('--gpu') ? 'WGSL (GPU)' : 'CPU reference',
    ended: result.ended,
    ...(result.error ? { error: result.error } : {}),
    strategist_summary: session.finished?.summary ?? null,
    closing_confirm: closing,
    best_confirmed: best ? { met: best.score === 0, score: best.score, point: best.point, metrics: best.metrics } : null,
    timing: {
      wall_s: round1(wallMs / 1000),
      model_s: round1(result.modelMs / 1000),
      rate_limit_wait_s: round1(result.retryWaitMs / 1000),
      model_retries: result.retries,
      tools_s: round1((result.toolMs + closingMs) / 1000),
      model_share: round1((100 * result.modelMs) / wallMs) / 100,
      model_turns: result.turns,
    },
    solves: { search: session.records.filter((r) => r.fidelity === 'search').length, confirm: session.records.filter((r) => r.fidelity === 'confirm').length, solver_s: round1(evaluator.solveMs / 1000) },
    tokens: { prompt: result.promptTokens, completion: result.completionTokens, calls_without_usage: result.callsWithoutUsage },
    cost_usd: Number(result.costUsd.toFixed(5)),
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const finalPoint = best?.point ?? session.current;
  writeFileSync(join(outDir, 'best.project.json'), JSON.stringify(projectFor(design, finalPoint, 'confirm'), null, 2) + '\n');
  writeFileSync(join(outDir, 'design.json'), JSON.stringify(designAt(design, finalPoint), null, 2) + '\n');
  console.log(`\n${result.ended}: ${summary.strategist_summary ?? result.error ?? ''}`);
  console.log(`best confirmed: ${best ? JSON.stringify(best.metrics) : 'none'}`);
  console.log(`wall ${summary.timing.wall_s} s = model ${summary.timing.model_s} s + tools ${summary.timing.tools_s} s + rate-limit waits ${summary.timing.rate_limit_wait_s} s; $${summary.cost_usd} -> ${outDir}`);
  return outDir;
}

/**
 * A readable lane name from a run's model label ("moonshotai/kimi-k3.1-pro on openrouter") and the hosts that
 * actually answered: an OpenRouter lane is named by what served it, never assumed to be a GPU host.
 */
function laneLabel(modelLabel: string, hosts: string[]): string {
  const [model, provider] = modelLabel.split(' on ');
  const name = /kimi-k3\.?1-pro/i.test(model) ? 'Kimi K3.1 Pro' : model;
  const host = provider === 'cerebras' ? 'Cerebras' : provider === 'openrouter' ? `${hosts.length ? hosts.join(' + ') : 'an unreported host'} via OpenRouter` : provider ?? '';
  return host ? `${name} on ${host}` : name;
}

/**
 * Race replay logs from finished runs, for launch/race-replay/index.html. Each
 * lane keeps its own clock from its own start, so lanes run one after another
 * on the same machine race fairly: same solver, no contention.
 */
function replay(argv: string[]): string[] {
  const { positional: runDirs, opts } = flags(argv, []);
  if (runDirs.length !== 2) throw new Error(`replay takes two run folders, one per lane\n${USAGE}`);
  const labels = opts.get('--labels')?.split('|');
  const outDir = opts.get('--out') ?? join(dirname(runDirs[0]), `race-${stamp()}`);
  mkdirSync(outDir, { recursive: true });
  const files = runDirs.map((dir, n) => {
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    const journal = readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const hosts = servedBy(journal);
    if (hosts.some((h) => /cerebras/i.test(h)) && !/ on cerebras$/.test(summary.model)) console.log(`warning: ${dir} was served by ${hosts.join(', ')}, Cerebras included`);
    const log = withContext(dir, () => replayFromJournal(journal, {
      laneLabel: labels?.[n] ?? laneLabel(summary.model, hosts),
      goal: summary.goal,
      modelS: summary.timing.model_s,
      costUsd: summary.cost_usd,
    }));
    const file = join(outDir, `replay-${n === 0 ? 'left' : 'right'}.json`);
    writeFileSync(file, JSON.stringify(log, null, 2) + '\n');
    console.log(`${log.lane_label}: ${log.result.met ? 'met' : 'missed'}, model ${log.model_s} s, $${log.cost_usd} -> ${file}`);
    return file;
  });
  // The view fetches the logs by URL: serve the repo root and pass paths from it.
  const url = (f: string) => '/' + relative(process.cwd(), resolve(f)).split(sep).join('/');
  console.log(`\nplay it: python3 -m http.server 8000, then open http://localhost:8000/launch/race-replay/?left=${url(files[0])}&right=${url(files[1])}`);
  return files;
}

function withContext<T>(where: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
}

/** Two lanes on the same design, one after the other, then their replay logs. */
async function race(argv: string[]): Promise<void> {
  const lanesAt = argv.indexOf('--lanes');
  const lanes = (lanesAt >= 0 ? argv[lanesAt + 1] ?? '' : 'cerebras,openrouter').split(',').map((l) => l.trim());
  if (lanes.length !== 2 || lanes.some((l) => !l)) throw new Error(`--lanes names two lanes, e.g. cerebras,openrouter\n${USAGE}`);
  const rest = lanesAt >= 0 ? [...argv.slice(0, lanesAt), ...argv.slice(lanesAt + 2)] : argv;
  if (rest.includes('--model')) throw new Error('race takes --lanes, not --model');
  // Both lanes' keys before either spends anything.
  for (const lane of lanes) {
    if (lane === 'scripted' || lane === 'manual') continue;
    const keyEnv = laneFor(lane).keyEnv;
    if (!process.env[keyEnv]) throw new Error(`${keyEnv} is not set (environment or .env): lane ${lane} cannot run`);
  }
  if (lanes.includes('openrouter') && !process.env.OPENROUTER_PROVIDERS) {
    console.log('note: OPENROUTER_PROVIDERS is not set, so OpenRouter picks the fastest host per call; the lane is labelled by the hosts that answered');
  }
  const dirs: string[] = [];
  for (const lane of lanes) {
    console.log(`\n=== lane ${lane} ===`);
    dirs.push(await run([...rest, '--model', lane]));
  }
  try {
    replay(dirs);
  } catch (e) {
    // A lane that solved nothing (a refused key, a spent quota) still leaves its run folder to read.
    throw new Error(`no race replay: ${(e as Error).message}. The runs are in ${dirs.join(' and ')}`);
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * A stdio MCP server (JSON-RPC 2.0, one message per line) exposing the design
 * tools, so OpenClaw can be the harness. stdout carries only protocol messages.
 */
async function mcp(argv: string[]): Promise<void> {
  const { positional: [path], opts } = flags(argv, ['--gpu']);
  if (!path) throw new Error(USAGE);
  console.log = console.error; // anything else goes to stderr
  const design = loadDesign(path);
  const journal = opts.get('--journal') ?? join(dirname(path), `${basename(path).replace(/\.json$/i, '')}.mcp-${stamp()}.jsonl`);
  const { session } = sessionFor(design, opts, (e) => writeFileSync(journal, JSON.stringify({ t: Date.now(), ...e }) + '\n', { flag: 'a' }));
  const send = (msg: object): void => void process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const maxCalls = numberOpt(opts, '--max-calls', 40)!;
  let toolCalls = 0;
  const handle = async (req: { id?: number | string; method: string; params?: Record<string, unknown> }) => {
    switch (req.method) {
      case 'initialize':
        return {
          protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'noburf-design', version: '0.1.0' },
          instructions: 'Antenna design tools: call brief first, then optimise / sweep / try_design, confirm, and finish.',
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: STRATEGIST_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) };
      case 'tools/call': {
        const name = String(req.params?.name);
        if (!STRATEGIST_TOOLS.some((t) => t.name === name)) return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
        // The client's model calls are not guarded here: bound the session instead, so a looping client stops getting answers.
        if (++toolCalls > maxCalls) return { isError: true, content: [{ type: 'text', text: `tool call limit (${maxCalls}) reached; call nothing more` }] };
        let output: unknown;
        try {
          output = await callTool(session, name, (req.params?.arguments as Record<string, unknown>) ?? {});
        } catch (e) {
          output = { error: `${name} failed: ${(e as Error).message}` }; // a tool failure is a tool result, not a protocol error
        }
        const isError = typeof output === 'object' && output !== null && 'error' in output;
        return { isError, content: [{ type: 'text', text: JSON.stringify(output) }] };
      }
      default:
        throw Object.assign(new Error(`method not found: ${req.method}`), { code: -32601 });
    }
  };
  // One request at a time: tool calls share the session and the solver.
  let queue = Promise.resolve();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let req: { id?: number | string; method: string; params?: Record<string, unknown> };
      try {
        req = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      if (req.id === undefined) continue; // a notification (cancellation is not supported: a started solve finishes)
      // ping and tools/list answer at once, even while a long optimise holds the queue.
      if (req.method === 'ping' || req.method === 'tools/list' || req.method === 'initialize') {
        void handle(req).then((result) => send({ id: req.id, result }));
        continue;
      }
      queue = queue.then(async () => {
        try {
          send({ id: req.id, result: await handle(req) });
        } catch (e) {
          send({ id: req.id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } });
        }
      });
    }
  });
  await new Promise<void>((done) => process.stdin.on('end', () => void queue.then(done)));
}

/** Rank the variables of a design (at its current point) or a project by their effect on the results. */
async function sensitivity(argv: string[]): Promise<SensitivityReport> {
  const { positional: [path], opts } = flags(argv, ['--gpu', '--cpu', '--check-step']);
  if (!path) throw new Error(USAGE);
  if (opts.has('--gpu') && opts.has('--cpu')) throw new Error(`--gpu and --cpu cannot be used together\n${USAGE}`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const isDesign = json?.noburf_design === 1;
  const design = isDesign ? parseDesignFile(json) : designFromProject(json, numberOpt(opts, '--target'));
  const fidelity = opts.get('--fidelity') ?? (isDesign ? 'search' : 'confirm');
  if (fidelity !== 'search' && fidelity !== 'confirm') throw new Error(`--fidelity is search or confirm, not "${fidelity}"`);
  // As noburf solve: the GPU when there is one, else the CPU reference with a notice; --gpu makes a missing GPU an error.
  const useGpu = await decideUseGpu(opts.has('--cpu') ? 'cpu' : opts.has('--gpu') ? 'gpu' : 'auto');
  const sessionOpts = new Map([...opts, ['--solves', '100000'], ['--confirms', '100000']]);
  sessionOpts.delete('--gpu');
  if (useGpu) sessionOpts.set('--gpu', 'true');
  const { evaluator, session } = sessionFor(design, sessionOpts, () => {});
  const t0 = performance.now();
  let report: SensitivityReport;
  try {
    report = await session.sensitivity({
      ...(opts.has('--variables') ? { variables: opts.get('--variables')!.split(',').map((v) => v.trim()) } : {}),
      ...(opts.has('--rank') ? { rank_by: opts.get('--rank') } : {}),
      ...(opts.has('--step-pct') ? { step_pct: numberOpt(opts, '--step-pct') } : {}),
      ...(opts.has('--check-step') ? { check_step: true } : {}),
    }, fidelity);
  } finally {
    await evaluator.close();
  }
  const wallS = (performance.now() - t0) / 1000;
  const mesh = fidelity === 'search' && isDesign ? 'search mesh' : isDesign ? 'confirm mesh' : "the project's mesh";
  const b = report.base.metrics;
  if (b) console.log(`\nat the current design: resonance ${(1000 * b.f0_ghz).toFixed(0)} MHz, dip ${b.s11_min_db.toFixed(1)} dB, S11 at ${design.goal.target_ghz} GHz ${b.s11_at_target_db.toFixed(1)} dB`);
  console.log(`${design.project.name}: ${report.solves} solves on ${mesh} in ${wallS.toFixed(0)} s (${useGpu ? 'GPU' : 'CPU'}), ranked by ${report.rankBy}`);
  console.log(sensitivityTable(report));
  const out = opts.get('--out') ?? join(dirname(path), `${basename(path).replace(/\.json$/i, '')}.sensitivity-${stamp()}.json`);
  writeFileSync(out, JSON.stringify({ file: path, wall_s: round1(wallS), solver: useGpu ? 'WGSL (GPU)' : 'CPU reference', ...report }, null, 2) + '\n');
  console.log(`\n-> ${out}`);
  return report;
}

/**
 * The report as text: per variable its value, range and step, then for each
 * metric the slope per unit of the variable with its spread and the change across the range.
 */
export function sensitivityTable(report: SensitivityReport): string {
  const sig = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));
  const lines: string[] = [];
  for (const row of report.rows) {
    const v = row.variable;
    const u = v.unit;
    lines.push(`\n${v.name} = ${v.value.toFixed(3)} ${u}, range ${v.min.toFixed(2)} to ${v.max.toFixed(2)} ${u}, step ${row.h.toFixed(3)} ${u} ${row.scheme}`);
    for (const m of report.metrics) {
      const s = row.slopes[m.key];
      const label = `  ${m.label}`.padEnd(26);
      if (!s) lines.push(`${label}n/a`);
      else lines.push(`${label}${sig(s.perUnit).padStart(8)} ${m.unit}/${u} ± ${sig(s.spread)}${s.stepError !== undefined ? `, step error ${sig(s.stepError)}` : ''}`.padEnd(62) +
        `  across range ${sig(s.acrossRange)} ${m.unit}  ${s.grade}${s.curved ? ', curved' : ''}`);
    }
    for (const n of row.notes) lines.push(`  note: ${n}`);
  }
  for (const s of report.skipped) lines.push(`\n${s.name}: skipped, ${s.reason}`);
  lines.push('\nclean: the slopes below and above the value agree within 25 %; sign only: the direction is known, the size is not;',
    'unresolved: the result turns, jumps or is flat within the step; curved: the across-range figure is a poor linear estimate.');
  return lines.join('\n');
}

/** Exported for scripts/design-mcp.mjs, which starts this file from any working directory. */
export async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'new') return newDesign(rest);
  if (command === 'run') return void (await run(rest));
  if (command === 'race') return race(rest);
  if (command === 'replay') return void replay(rest);
  if (command === 'mcp') return mcp(rest);
  if (command === 'sensitivity') return void (await sensitivity(rest));
  throw new Error(USAGE);
}

export function runMain(): void {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runMain();
