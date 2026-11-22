/**
 * Writes src/engine/sheet_rim_table.json: where a thin sheet's rim sits on
 * the grid (cells past the last crossed edge) for sheet fractions s and tie
 * scales beta, from the discrete half-plane problem (src/engine/sheet_rim.ts).
 * Nothing is fitted; tests/sheet_rim.test.ts recomputes sample entries.
 *
 *   npx tsx scripts/validate/sheet_rim_table.ts
 */
import { writeFileSync } from 'node:fs';
import { sheetRimShiftCells, type SheetRimTable } from '../../src/engine/sheet_rim';

const TABLE_S = [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
// 0.01 to 100, ten per decade (index 20 is exactly 1): wide enough that a range of tie scales reaches a full
// cell at every s in the table (rimBetaRange).
const TABLE_BETA = Array.from({ length: 41 }, (_, n) => Number((10 ** ((n - 20) / 10)).toPrecision(6)));

const table: SheetRimTable = {
  s: TABLE_S,
  beta: TABLE_BETA,
  shift: TABLE_S.map((s) => TABLE_BETA.map((beta) => Number(sheetRimShiftCells(s, beta).toFixed(5)))),
};
writeFileSync(new URL('../../src/engine/sheet_rim_table.json', import.meta.url), `${JSON.stringify(table)}\n`);
console.log(TABLE_S.map((s, m) => `s ${s}: beta 1 -> ${table.shift[m][20]}`).join('\n'));
