/**
 * `noburf pair`: differential-pair figures from any Touchstone v1 S-parameter
 * file (a NobuRF solve, another solver, a VNA), as JSON on stdout or in a file.
 *   noburf pair board.s4p --pair 1,3 --pair 2,4 [--zdiff 90] [--zcomm 30] [--at 0.24]... [--out pair.json]
 * Each --pair names one end of a pair by its positive and negative port
 * numbers (1-based, as in the file); every port must be in one pair. There
 * is no default ordering, since files disagree on it (1,2 / 3,4 or 1,3 / 2,4).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { analyseDifferential, differentialJson, differentialSummaryLines, type PairSpec } from '../engine/differential';
import { parseTouchstone } from '../engine/touchstone';

export const PAIR_USAGE = 'usage: noburf pair <file.sNp> --pair <positive>,<negative> [--pair ...] [--zdiff <ohm>] [--zcomm <ohm>] [--at <GHz>]... [--out <file.json>]';

export async function runPairCommand(argv: string[]): Promise<void> {
  const [file, ...rest] = argv;
  const ports = /\.s(\d+)p$/i.exec(file ?? '');
  if (!ports) throw new Error(`${PAIR_USAGE}\nthe file name must end in .sNp, which gives the port count`);
  const portCount = Number(ports[1]);
  const pairs: PairSpec[] = [];
  const at: number[] = [];
  let zDiff: number | undefined;
  let zComm: number | undefined;
  let out: string | null = null;
  const positive = (flag: string, value: string | undefined) => {
    const x = Number(value);
    if (!(x > 0)) throw new Error(`${flag} needs a number above 0, got ${value ?? 'nothing'}`);
    return x;
  };
  for (let n = 0; n < rest.length; n++) {
    const [flag, value] = [rest[n], rest[n + 1]];
    if (flag === '--pair') {
      const numbers = (value ?? '').split(',').map(Number);
      if (numbers.length !== 2 || !numbers.every((x) => Number.isInteger(x) && x >= 1 && x <= portCount)) {
        throw new Error(`--pair needs two port numbers from 1 to ${portCount}, as positive,negative; got ${value ?? 'nothing'}`);
      }
      pairs.push({ id: `D${pairs.length + 1}`, positive: numbers[0] - 1, negative: numbers[1] - 1 });
    } else if (flag === '--zdiff') zDiff = positive(flag, value);
    else if (flag === '--zcomm') zComm = positive(flag, value);
    else if (flag === '--at') at.push(positive(flag, value));
    else if (flag === '--out' && value) out = value;
    else throw new Error(PAIR_USAGE);
    n++;
  }
  if (!pairs.length) throw new Error(`${PAIR_USAGE}\nname the pairs with --pair: files differ in how they order the ports`);
  const { s, z0 } = parseTouchstone(readFileSync(file, 'utf8'), portCount);
  const specs = pairs.map((p) => ({ ...p, ...(zDiff ? { differentialOhm: zDiff } : {}), ...(zComm ? { commonOhm: zComm } : {}) }));
  const portIds = Array.from({ length: portCount }, (_, n) => String(n + 1));
  const z0s = portIds.map(() => z0);
  const report = analyseDifferential(s, z0s, specs);
  const text = JSON.stringify({ file, ...differentialJson(report, portIds, specs, at) }, null, 2) + '\n';
  if (out) writeFileSync(out, text);
  // Wait for the pipe to take it all: the CLI exits as soon as this returns.
  else await new Promise((done) => process.stdout.write(text, done));
  for (const line of differentialSummaryLines(report)) console.error(line);
}
