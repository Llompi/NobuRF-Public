/**
 * Records OpenClaw-driven design runs for the demo video and the with/without-Cerebras comparison, without
 * changing how they run: it starts `design agent` or `design agent-race` as is, shows and records its terminal
 * (an asciinema v2 .cast, playable with `asciinema play` or rendered to video with `agg`), then adds one line per
 * lane to runs/ledger.jsonl and rewrites runs/ledger.md.
 *
 *   npm run record -- agent-race "<request>" [agent-race options]
 *   npm run record -- agent "<request>" [agent options]
 *   npm run record -- report            (rewrites runs/ledger.md from the ledger)
 *
 * Keys stay where `design` reads them (environment or .env); this script never reads or prints them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrubbedEnv } from '../src/design/openclaw_lane';
import { laneDirsIn, ledgerEntryFor, ledgerReport, readLedger } from '../src/design/run_ledger';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RUNS = join('runs', 'agent');
const LEDGER = join('runs', 'ledger.jsonl');
const REPORT = join('runs', 'ledger.md');
const COLS = 120;
const ROWS = 34;

function openclawVersion(): string | null {
  const bin = process.env.OPENCLAW_BIN ?? 'openclaw';
  const windows = process.platform === 'win32';
  const r = spawnSync(windows ? `"${bin}"` : bin, ['--version'], { encoding: 'utf8', shell: windows, env: scrubbedEnv(), timeout: 30000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Terminal output for the recording: CRLF line ends, and OpenClaw's own tool names (noburf__*) in bold blue. */
const forTerminal = (text: string) => text.replace(/\r?\n/g, '\r\n').replace(/\bnoburf__\w+/g, (m) => `\x1b[1;34m${m}\x1b[0m`);

const quote = (a: string) => (/^[\w./:,=-]+$/.test(a) ? a : JSON.stringify(a));

/** The report, with each line re-read from its run folder when that is still here (so later fixes apply to old runs). */
function writeReport() {
  const entries = readLedger(LEDGER).map((e) => ledgerEntryFor(e.run_dir, { command: e.command, openclawVersion: e.openclaw_version, recording: e.recording, now: new Date(e.recorded_at) }) ?? e);
  writeFileSync(REPORT, ledgerReport(entries));
  console.log(`ledger: ${LEDGER}, report: ${REPORT}`);
}

async function record(args: string[]) {
  const [command] = args;
  if (command !== 'agent' && command !== 'agent-race') throw new Error('record runs `agent` or `agent-race`; `record report` rewrites the report');
  mkdirSync(RUNS, { recursive: true });
  const before = new Set(readdirSync(RUNS));
  const version = openclawVersion();
  const shown = `npm run design -- ${args.map(quote).join(' ')}`;
  const started = Date.now();
  const castPath = join('runs', `recording-${new Date(started).toISOString().replace(/[:.]/g, '-')}.cast`);
  writeFileSync(castPath, JSON.stringify({ version: 2, width: COLS, height: ROWS, timestamp: Math.floor(started / 1000), title: `NobuRF, driven by ${version ?? 'OpenClaw'}` }) + '\n');
  const out = (text: string) => {
    process.stdout.write(text);
    appendFileSync(castPath, JSON.stringify([(Date.now() - started) / 1000, 'o', forTerminal(text)]) + '\n');
  };
  out(`${version ?? 'OpenClaw (version not found: set OPENCLAW_BIN)'} drives every lane: openclaw agent exec, with NobuRF's tools over MCP\n`);
  out(`$ ${shown}\n`);

  const child = spawn(process.execPath, [
    '--import', 'tsx', '--import', pathToFileURL(join(ROOT, 'src', 'node', 'register_raw_imports.mjs')).href,
    join(ROOT, 'scripts', 'design.ts'), ...args,
  ], { stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out(String(d)));
  child.stderr.on('data', (d) => out(String(d)));
  const code = await new Promise<number | null>((done, fail) => {
    child.on('error', fail);
    child.on('close', done);
  });
  out(`\n[recorder] design exited ${code} after ${((Date.now() - started) / 1000).toFixed(1)} s\n`);

  // This run's folders: what appeared under runs/agent, or the --out an agent run was given.
  const outAt = args.indexOf('--out');
  const made = outAt >= 0 ? [resolve(args[outAt + 1])] : readdirSync(RUNS).filter((n) => !before.has(n)).map((n) => resolve(RUNS, n));
  const lanes = made.flatMap(laneDirsIn);
  if (!lanes.length) {
    console.log(`no run folder with a summary appeared; the recording is ${castPath}`);
    process.exitCode = code ?? 1;
    return;
  }
  // The recording sits with its run (the race folder, or the single lane's folder).
  const home = made.length === 1 ? made[0] : resolve('runs');
  const recording = join(home, 'terminal.cast');
  renameSync(castPath, recording);
  for (const dir of lanes) {
    const entry = ledgerEntryFor(dir, { command: shown, openclawVersion: version, recording });
    if (entry) appendFileSync(LEDGER, JSON.stringify(entry) + '\n');
  }
  console.log(`recorded ${lanes.length} lane run(s); terminal recording ${recording}`);
  writeReport();
  process.exitCode = code ?? 1;
}

const args = process.argv.slice(2);
if (args[0] === 'report') {
  if (!existsSync(LEDGER)) throw new Error(`no ledger yet at ${LEDGER}`);
  writeReport();
} else {
  await record(args);
}
