/**
 * NobuRF self-verification suite: physics the solver must satisfy, checked
 * without any outside software. See docs/self-verify.md.
 *
 *   npm run selfverify -- [--tier quick|full] [--seed <text>] [--only <family>] [--out <dir>]
 *
 * Each family runs in its own process (in parallel), once with the seed and
 * once with every seed in REGRESSION_SEEDS. The seed defaults to the commit
 * under test, so each commit draws new random cases; the regression seeds
 * are fixed cases that once exposed a defect, so a fix cannot dodge them by
 * drawing different cases. Writes selfverify-<tier>-<seed>.md and .json to
 * --out (default: the current directory). Exit code 1 when any check fails
 * or is inconclusive: inconclusive is not a pass.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCavity } from './families/cavity';
import { runEnergy } from './families/energy';
import { runStripline } from './families/stripline';
import { runTwoPort } from './families/two_port';
import type { Check } from './measure';
import { headCommitSeed, seededRng, type Rng } from './rng';

type Tier = 'quick' | 'full';

/**
 * Fixed seeds run besides the commit's own, per family. Add a seed when it exposes a defect; never remove one.
 * Only the stripline has them so far (two-port is the slow family, about 6 minutes a seed on 4 CPU cores).
 */
const REGRESSION_SEEDS: Record<string, string[]> = { stripline: ['stripline-study-1', 'c60001001e10850132c6f89058232480c6c8780a'] };
const FAMILIES: Record<string, (rng: Rng, tier: Tier) => Check[]> = {
  'pec-box': runCavity,
  'conserved-energy': runEnergy,
  stripline: runStripline,
  'two-port': runTwoPort,
};

interface Options { tier: Tier; seed: string; only: string[]; out: string; child: string | null }

function parseArgs(argv: string[]): Options {
  const options: Options = { tier: 'quick', seed: '', only: [], out: '.', child: null };
  for (let n = 0; n < argv.length; n++) {
    const [flag, value] = [argv[n], argv[n + 1]];
    if (flag === '--tier' && (value === 'quick' || value === 'full')) options.tier = value;
    else if (flag === '--seed' && value) options.seed = value;
    else if (flag === '--only' && value && value in FAMILIES) options.only.push(value);
    else if (flag === '--out' && value) options.out = value;
    else if (flag === '--child' && value && value in FAMILIES) options.child = value;
    else throw new Error(`usage: selfverify [--tier quick|full] [--seed <text>] [--only ${Object.keys(FAMILIES).join('|')}] [--out <dir>]; bad argument ${flag}`);
    n++;
  }
  options.seed ||= headCommitSeed();
  return options;
}

/** Run one family in a child process; it prints its checks as JSON on the last stdout line. */
function runChild(family: string, seed: string, options: Options): Promise<{ checks: Check[]; seconds: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--child', family, '--tier', options.tier, '--seed', seed], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      const seconds = (Date.now() - started) / 1000;
      // A crash is reported as a failed check, so the other families still report and the run still fails.
      if (code !== 0) {
        return resolve({ seconds, checks: [{ family, case: `(all, seed ${seed.slice(0, 12)})`, check: 'family ran to the end', verdict: 'fail', measured: null, expected: null, tolerance: null, note: `exited with code ${code}; see stderr` }] });
      }
      const last = out.trim().split('\n').at(-1)!;
      const checks = (JSON.parse(last) as Check[]).map((c) => (seed === options.seed ? c : { ...c, case: `[seed ${seed.slice(0, 12)}] ${c.case}` }));
      resolve({ checks, seconds });
    });
  });
}

const fmt = (v: number | null) => (v === null ? '' : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : v.toPrecision(6));

function report(checks: Check[], options: Options, timings: Record<string, number>): string {
  const count = (v: Check['verdict']) => checks.filter((c) => c.verdict === v).length;
  const lines = [
    `# NobuRF self-verification, ${options.tier} tier`,
    '',
    `Seed \`${options.seed}\` plus regression seeds ${Object.entries(REGRESSION_SEEDS).map(([f, seeds]) => `${f}: ${seeds.map((s) => `\`${s.slice(0, 12)}\``).join(', ')}`).join('; ')}. ${checks.length} checks: ${count('pass')} pass, ${count('fail')} fail, ${count('inconclusive')} inconclusive.`,
    '',
  ];
  for (const family of Object.keys(timings)) {
    lines.push(`## ${family} (${timings[family].toFixed(0)} s)`, '', '| Case | Check | Verdict | Measured | Expected | Tolerance | Note |', '|---|---|---|---|---|---|---|');
    for (const c of checks.filter((x) => x.family === family)) {
      const verdict = c.verdict === 'pass' ? 'pass' : c.verdict === 'fail' ? '**FAIL**' : '*inconclusive*';
      lines.push(`| ${c.case} | ${c.check} | ${verdict} | ${fmt(c.measured)} | ${fmt(c.expected)} | ${fmt(c.tolerance)} | ${c.note.replace(/\|/g, '/')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.child) {
    const checks = FAMILIES[options.child](seededRng(options.seed).fork(options.child), options.tier);
    process.stdout.write(`\n${JSON.stringify(checks)}\n`);
    return;
  }
  const families = options.only.length > 0 ? options.only : Object.keys(FAMILIES);
  const jobs = families.flatMap((family) => [options.seed, ...(REGRESSION_SEEDS[family] ?? []).filter((s) => s !== options.seed)].map((seed) => ({ family, seed })));
  // At most four solver processes at once.
  const results: Array<{ checks: Check[]; seconds: number }> = [];
  for (let n = 0; n < jobs.length; n += 4) {
    results.push(...(await Promise.all(jobs.slice(n, n + 4).map((j) => runChild(j.family, j.seed, options)))));
  }
  const checks = results.flatMap((r) => r.checks);
  const timings: Record<string, number> = {};
  jobs.forEach((j, n) => { timings[j.family] = (timings[j.family] ?? 0) + results[n].seconds; });
  const markdown = report(checks, options, timings);
  mkdirSync(options.out, { recursive: true });
  const stem = join(options.out, `selfverify-${options.tier}-${options.seed.slice(0, 12)}`);
  writeFileSync(`${stem}.md`, markdown);
  writeFileSync(`${stem}.json`, JSON.stringify({ tier: options.tier, seed: options.seed, checks }, null, 1));
  console.log(markdown);
  console.log(`Report: ${stem}.md`);
  process.exitCode = checks.every((c) => c.verdict === 'pass') ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 2;
});
