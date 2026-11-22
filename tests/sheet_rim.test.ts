import { describe, expect, it } from 'vitest';
import { rimBetaRange, rimGrowCells, rimTieScale, sheetRimShiftCells, type SheetRimTable } from '../src/engine/sheet_rim';
import TABLE from '../src/engine/sheet_rim_table.json';

const table = TABLE as SheetRimTable;

describe('sheet rim half-plane', () => {
  it('matches the shipped table (regenerate with scripts/validate/sheet_rim_table.ts)', () => {
    for (const [m, n] of [[0, 20], [4, 8], [9, 33], [12, 20]]) {
      expect(sheetRimShiftCells(table.s[m], table.beta[n])).toBeCloseTo(table.shift[m][n], 4);
    }
  });

  it('puts the plain sheet rim 0.15 to 0.34 cell past the last crossed edge, tending to the on-plane 0.3535', () => {
    const plain = table.beta.indexOf(1);
    expect(plain).toBeGreaterThan(0);
    expect(table.shift[table.s.indexOf(0.5)][plain]).toBeCloseTo(0.1462, 3);
    expect(table.shift[0][plain]).toBeGreaterThan(0.34);
    expect(table.shift[0][plain]).toBeLessThan(0.3535);
  });

  it('moves the rim monotonically with the tie scale', () => {
    for (const row of table.shift) for (let n = 1; n < row.length; n++) expect(row[n]).toBeGreaterThan(row[n - 1]);
  });

  it('reaches exactly one cell within the tie scales the solver uses, centred on the grown rim', () => {
    for (const s of [0.01, 0.03, 0.2, 0.37, 0.5, 0.9]) {
      const [lo, hi] = rimBetaRange(table, s);
      expect(lo * hi).toBeCloseTo(1, 9);
      const [near, far] = [sheetRimShiftCells(s, lo), sheetRimShiftCells(s, hi)];
      // Exact at the table's s; interpolating between its rows costs under 0.01 cell.
      expect(Math.abs(far - near - 1)).toBeLessThan(0.01);
      expect(Math.abs(near + rimGrowCells(table, s))).toBeLessThan(0.01);
    }
  });

  it('inverts the table: the scale it returns puts the rim where asked', () => {
    for (const s of [0.07, 0.37, 0.63]) {
      for (const t of [-0.3, 0, 0.2, 0.55]) {
        const beta = rimTieScale(table, s, t);
        expect(sheetRimShiftCells(s, beta)).toBeCloseTo(t, 2);
      }
    }
  });
});
