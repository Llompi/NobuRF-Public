import { describe, expect, it } from 'vitest';
import {
  constantResponse, djordjevicSarkarExact, djordjevicSarkarResponse, relativeValue, tableResponse, type DjordjevicSarkar, type PermittivityPoint,
} from '../src/engine/dispersion';
import { TABLE_FIT_NOTE } from '../src/project/materials';
import { rasterise } from '../src/project/rasterise';
import { parseProject, ProjectError } from '../src/project/schema';
import { measureSlab, SLAB_DEFAULT, slabExact } from '../scripts/validate/dispersive_slab';
import { smallProjectJson } from './project_fixtures';

const FR4_DS: DjordjevicSarkar = { epsR: 4.4, tanDelta: 0.02, atHz: 1e9, fLowHz: 1e3, fHighHz: 1e12 };

/** A datasheet-style table: rows log-spaced from fMin to fMax, read off a model. */
function sampled(at: (fHz: number) => [number, number], fMinHz: number, fMaxHz: number, rows: number): PermittivityPoint[] {
  return Array.from({ length: rows }, (_, n) => {
    const fHz = fMinHz * (fMaxHz / fMinHz) ** (n / (rows - 1));
    const [re, im] = at(fHz);
    return { fHz, epsR: re, tanDelta: -im / re };
  });
}

/** Worst relative error of eps' and of eps'' on 200 log-spaced points, rows and between them. */
function worstBetweenRows(fit: ReturnType<typeof tableResponse>['response'], exact: (fHz: number) => [number, number], fMinHz: number, fMaxHz: number): [number, number] {
  let worst: [number, number] = [0, 0];
  for (let n = 0; n <= 200; n++) {
    const f = fMinHz * (fMaxHz / fMinHz) ** (n / 200);
    const [re, im] = exact(f);
    const [fr, fi] = relativeValue(fit, f);
    worst = [Math.max(worst[0], Math.abs(fr / re - 1)), Math.max(worst[1], Math.abs(fi / im - 1))];
  }
  return worst;
}

describe('measured permittivity tables', () => {
  it('recovers the Djordjevic-Sarkar closed form from a 10-row table: eps\' to 1e-5, eps\'\' to 1e-4, between the rows too', () => {
    for (const [fMin, fMax, rows] of [[1e9, 10e9, 10], [0.1e9, 40e9, 12], [1e6, 1e9, 8]]) {
      const exact = (f: number) => djordjevicSarkarExact(FR4_DS, f);
      const { response, fitError } = tableResponse(sampled(exact, fMin, fMax, rows));
      expect(fitError).toBeLessThan(1e-4);
      expect(response.lossRate).toBe(0);
      expect(response.inf).toBeGreaterThanOrEqual(1);
      expect(Math.min(...response.poles.map((p) => p.delta))).toBeGreaterThan(0);
      const [re, im] = worstBetweenRows(response, exact, fMin, fMax);
      expect(re).toBeLessThan(1e-5);
      expect(im).toBeLessThan(1e-4);
    }
  });

  /**
   * The limit of fixed relaxation frequencies: one sharp relaxation between two
   * of them is the hardest shape there is (laminates spread theirs over
   * decades). The fit lands within 7 % of its peak loss and says so, above
   * TABLE_FIT_NOTE, so such a material belongs in a "poles" model instead.
   */
  it('a single Debye relaxation off the fit\'s grid comes within 7 % and reports it', () => {
    const debye = { inf: 2.5, lossRate: 0, poles: [{ type: 'debye' as const, delta: 1.7, fRelaxHz: 3.3e9 }] };
    const exact = (f: number) => relativeValue(debye, f);
    const { response, fitError } = tableResponse(sampled(exact, 0.5e9, 20e9, 15));
    expect(fitError).toBeGreaterThan(TABLE_FIT_NOTE);
    const [re, im] = worstBetweenRows(response, exact, 0.5e9, 20e9);
    expect(re).toBeLessThan(0.02);
    expect(im).toBeLessThan(0.07);
  });

  it('a table no causal material can pass through (loss with no change in eps\') is fitted as near as causality allows and says how far', () => {
    // Constant eps' 4 with tan delta 0.05: Kramers-Kronig needs eps' to fall about 3 % per decade with that loss.
    const rows = sampled(() => [4, -0.2], 1e9, 100e9, 9);
    const { fitError } = tableResponse(rows);
    expect(fitError).toBeGreaterThan(0.01);
    expect(fitError).toBeLessThan(0.2);
  });

  it('a slab made from the table reflects and transmits as the Djordjevic-Sarkar slab, 2 to 10 GHz (within 0.006)', () => {
    const { response } = tableResponse(sampled((f) => djordjevicSarkarExact(FR4_DS, f), 1e9, 12e9, 8));
    const reference = { eps: djordjevicSarkarResponse(FR4_DS, 1e9, 12e9), mu: constantResponse(1) };
    const d = SLAB_DEFAULT.cells * SLAB_DEFAULT.dxMm * 1e-3;
    for (const r of measureSlab({ eps: response, mu: constantResponse(1) }, [2e9, 4e9, 6e9, 8e9, 10e9])) {
      const exact = slabExact(reference, d, r.fHz);
      expect(Math.hypot(r.gamma[0] - exact.gamma[0], r.gamma[1] - exact.gamma[1])).toBeLessThan(6e-3);
      expect(Math.hypot(r.t[0] - exact.t[0], r.t[1] - exact.t[1])).toBeLessThan(6e-3);
    }
  });

  const tableJson = (points: unknown, extra: Record<string, unknown> = {}) => {
    const json = smallProjectJson();
    json.materials = { measured: { dispersion: { model: 'table', points }, ...extra } };
    json.stackup[1].material = 'measured';
    return json;
  };
  const ROWS = [{ f_ghz: 1, eps_r: 3.5, tan_delta: 0.004 }, { f_ghz: 5, eps_r: 3.48, tan_delta: 0.0042 }, { f_ghz: 20, eps_r: 3.46, tan_delta: 0.0045 }];

  it('a project material can be a table alone: eps_r and tan_delta default to its middle row, and the solver uses the fit', () => {
    const p = parseProject(tableJson(ROWS));
    expect(p.materials.measured).toMatchObject({ eps_r: 3.48, tan_delta: 0.0042 });
    const { model, warnings } = rasterise(p);
    expect(model.dispersion?.e).toBeDefined();
    // smallProjectJson's band is 8-16 GHz, inside the table, and three smooth rows fit closely: no note.
    expect(warnings.filter((w) => w.includes('table'))).toEqual([]);
  });

  it('notes a band beyond the table and a loose fit, and rejects rows out of order or too few', () => {
    const narrow = [{ f_ghz: 9, eps_r: 3.5, tan_delta: 0.004 }, { f_ghz: 12, eps_r: 3.5, tan_delta: 0.01 }];
    const { warnings } = rasterise(parseProject(tableJson(narrow)));
    expect(warnings.some((w) => /table spans 9 to 12 GHz and the analysis band goes beyond it/.test(w))).toBe(true);
    expect(warnings.some((w) => /table is fitted to [\d.]+ % at worst/.test(w))).toBe(true);
    expect(() => parseProject(tableJson([ROWS[1], ROWS[0]]))).toThrow(ProjectError);
    expect(() => parseProject(tableJson([ROWS[0]]))).toThrow(/2 to 200 rows/);
    expect(() => parseProject(tableJson(ROWS, { eps_r: 3.4, tan_delta: 0.003 }))).not.toThrow();
    // Without a table, eps_r stays required.
    const json = smallProjectJson();
    json.materials = { plain: { tan_delta: 0.01 } };
    json.stackup[1].material = 'plain';
    expect(() => parseProject(json)).toThrow(/eps_r/);
  });
});
