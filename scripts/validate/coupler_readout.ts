/**
 * Reads the Sheen 1990 branch-line coupler numbers in docs/validation.md
 * section 7.5 off the saved four-port result.
 *
 *   npx tsx scripts/validate/coupler_readout.ts [docs/validation/data/sheen1990-coupler-sma-4port.txt]
 *
 * The file holds column 1 of the S matrix (port 1 driven), one row per
 * frequency: f_GHz, S11, S21, S31, S41 in dB. Lines starting with # are notes.
 *
 * Prints the S31 = S41 crossover (linear interpolation between samples, and a
 * check that it is the only one in the file) and the S11 and S21 minima over
 * the whole file (nearest sample, no interpolation).
 */
import { readFileSync } from 'node:fs';

interface ColumnOneRow {
  frequencyGhz: number;
  s11Db: number;
  s21Db: number;
  s31Db: number;
  s41Db: number;
}

const defaultPath = 'docs/validation/data/sheen1990-coupler-sma-4port.txt';

function parseColumnOne(text: string): ColumnOneRow[] {
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const values = line.split(/\s+/).map(Number);
      if (values.length !== 5 || values.some((value) => !Number.isFinite(value))) {
        throw new Error(`expected five numbers per row, got: ${line}`);
      }
      const [frequencyGhz, s11Db, s21Db, s31Db, s41Db] = values;
      return { frequencyGhz, s11Db, s21Db, s31Db, s41Db };
    });
  if (rows.length < 2) throw new Error('fewer than two data rows');
  return rows;
}

function crossovers(rows: ColumnOneRow[]): { frequencyGhz: number; levelDb: number }[] {
  const found: { frequencyGhz: number; levelDb: number }[] = rows
    .filter((row) => row.s31Db === row.s41Db)
    .map((row) => ({ frequencyGhz: row.frequencyGhz, levelDb: row.s31Db }));
  for (let index = 1; index < rows.length; index++) {
    const before = rows[index - 1];
    const after = rows[index];
    const differenceBefore = before.s31Db - before.s41Db;
    const differenceAfter = after.s31Db - after.s41Db;
    if (differenceBefore * differenceAfter >= 0) continue;
    const fraction = differenceBefore / (differenceBefore - differenceAfter);
    found.push({
      frequencyGhz: before.frequencyGhz + fraction * (after.frequencyGhz - before.frequencyGhz),
      levelDb: before.s31Db + fraction * (after.s31Db - before.s31Db),
    });
  }
  return found.sort((first, second) => first.frequencyGhz - second.frequencyGhz);
}

function minimum(rows: ColumnOneRow[], pick: (row: ColumnOneRow) => number): ColumnOneRow {
  return rows.reduce((best, row) => (pick(row) < pick(best) ? row : best));
}

const rows = parseColumnOne(readFileSync(process.argv[2] ?? defaultPath, 'utf8'));
const firstGhz = rows[0].frequencyGhz;
const lastGhz = rows[rows.length - 1].frequencyGhz;

const crossings = crossovers(rows);
console.log(`${rows.length} rows, ${firstGhz} to ${lastGhz} GHz`);
for (const crossing of crossings) {
  console.log(`S31 = S41 at ${crossing.frequencyGhz.toFixed(3)} GHz, ${crossing.levelDb.toFixed(2)} dB`);
}
if (crossings.length !== 1) {
  throw new Error(`expected one S31 = S41 crossover between ${firstGhz} and ${lastGhz} GHz, found ${crossings.length}`);
}

const s11Null = minimum(rows, (row) => row.s11Db);
const s21Null = minimum(rows, (row) => row.s21Db);
console.log(`S11 minimum ${s11Null.s11Db.toFixed(2)} dB at ${s11Null.frequencyGhz.toFixed(3)} GHz`);
console.log(`S21 minimum ${s21Null.s21Db.toFixed(2)} dB at ${s21Null.frequencyGhz.toFixed(3)} GHz`);
