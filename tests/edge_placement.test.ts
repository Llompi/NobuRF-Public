import { describe, expect, it } from 'vitest';
import { EDGE_LINE_SETTLE_CELLS, rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { SHEET_EDGE_OFFSET_ACCURACY_CELLS, sheetEdgeOffsetCells, yeeEdgeOffset } from '../src/engine/yee_edge';
import { correctedLine } from './edge_fixtures';
import { rect, smallProjectJson } from './project_fixtures';

const EDGE_CELL = 0.25;
/** The fixture with 0.25 mm edge cells and 0.25 mm substrate cells: square cells under the top copper. */
const graded = () => {
  const json = smallProjectJson();
  json.mesh.graded = { edge_cell: `${EDGE_CELL} mm`, dielectric_cells: 4, max_growth: 1.3 };
  return json;
};
const hasLine = (lines: Float64Array, v: number) => lines.some((l) => Math.abs(l - v) < 1e-9);
const withFeedWidth = (widthMm: number) => {
  const json = graded();
  json.geometry.top[1].polygon = rect(`${-widthMm / 2} mm`, '-patch / 2 - 1 mm', `${widthMm / 2} mm`, '-patch / 2');
  return json;
};

const plainModel = rasterise(parseProject(graded())).model;
/** The top copper is at z = 1 mm. */
const corrected = (lines: Float64Array, drawn: number, inward: -1 | 1, model = plainModel) => correctedLine(lines, model.mesh!.z, 1, drawn, inward, EDGE_CELL);

describe('copper edge placement on graded meshes', () => {
  it('derives the edge offset from a discrete half-plane: 0.3535 cells on square cells, more on taller ones', () => {
    expect(yeeEdgeOffset(80)).toBeCloseTo(0.3535, 4);
    expect(yeeEdgeOffset(40)).toBeCloseTo(0.3535, 3);
    expect(sheetEdgeOffsetCells(1.1, 1.1)).toBeCloseTo(0.3717, 3);
    expect(sheetEdgeOffsetCells(0.9, 0.9)).toBeCloseTo(0.3362, 3);
  });

  it('puts the line at each copper edge the sheet-edge offset for its own cells inside the copper', () => {
    const { mesh } = plainModel;
    // The 6 mm patch and the 2 mm feed, in x.
    for (const [v, inward] of [[3, -1], [-3, 1], [1, -1], [-1, 1]] as const) expect(corrected(mesh!.x, v, inward)).toBeDefined();
    for (const v of [3, -3, 1, -1]) expect(hasLine(mesh!.x, v)).toBe(false);
    // In y: the patch's top, its bottom where the feed joins only part of it, and the feed's end.
    for (const [v, inward] of [[3, -1], [-3, 1], [-4, 1]] as const) expect(corrected(mesh!.y, v, inward)).toBeDefined();
    // Independently of the mesher's cached solve: the depth of the patch's right edge line, over the
    // cell outside it, is the offset of a larger half-plane solve (L 80) for the z cells there.
    const line = corrected(mesh!.x, 3, -1)!;
    const n = mesh!.x.findIndex((v) => v === line);
    const cell = mesh!.x[n + 1] - line;
    const k = mesh!.z.findIndex((v) => Math.abs(v - 1) < 1e-9);
    const direct = yeeEdgeOffset(80, (mesh!.z[k] - mesh!.z[k - 1]) / cell, (mesh!.z[k + 1] - mesh!.z[k]) / cell);
    // L = 80 against the mesher's L = 40: their difference, plus the settle tolerance.
    expect(Math.abs((3 - line) / cell - direct)).toBeLessThan(SHEET_EDGE_OFFSET_ACCURACY_CELLS + EDGE_LINE_SETTLE_CELLS);
    expect(direct).toBeGreaterThan(0.3);
    // The ground plane's rim is the board outline and stays put.
    for (const v of [5, -5]) expect(hasLine(mesh!.x, v)).toBe(true);
  });

  it('keeps uniform edge cells either side of a corrected line, past the drawn edge', () => {
    const { mesh } = plainModel;
    const line = corrected(mesh!.y, 3, -1)!;
    const k = mesh!.y.findIndex((v) => v === line);
    // The next line out is past the drawn edge (y = 3), so the copper still ends on the moved line.
    expect(mesh!.y[k + 1]).toBeGreaterThan(3);
    // Four edge cells each side, well inside the hold (the smaller of 20 edge cells and the distance to the other copper): no cell wider than edge_cell.
    for (let n = k - 4; n < k + 4; n++) expect((mesh!.y[n + 1] - mesh!.y[n]) / EDGE_CELL).toBeLessThanOrEqual(1 + 1e-9);
    expect((mesh!.y[k + 1] - mesh!.y[k]) / EDGE_CELL).toBeGreaterThanOrEqual(0.5);
  });

  it('moves a port drawn on a moved edge onto the moved line, without a snap warning', () => {
    const { model, warnings } = rasterise(parseProject(graded()));
    const j = model.ports[0].j;
    expect(model.mesh!.y[j]).toBe(corrected(model.mesh!.y, -4, 1, model));
    expect(warnings.some((w) => w.includes('snapped'))).toBe(false);
  });

  it('keeps an edge where it is drawn when another edge at the same place cannot move', () => {
    // A 0.4 mm stub (under two edge cells) whose left edge lines up with the patch's right edge.
    const json = graded();
    json.geometry.top.push({ id: 'stub', op: 'add', polygon: rect('3 mm', '3.5 mm', '3.4 mm', '4.5 mm') });
    const { mesh } = rasterise(parseProject(json)).model;
    expect(hasLine(mesh!.x, 3)).toBe(true);
    expect(corrected(mesh!.x, 3, -1)).toBeUndefined();
  });

  it('keeps edges where they are drawn across a gap under 1.5 edge cells', () => {
    // A trace 0.3 mm (1.2 edge cells) above the patch.
    const json = graded();
    json.geometry.top.push({ id: 'trace', op: 'add', polygon: rect('-2 mm', '3.3 mm', '2 mm', '4.3 mm') });
    const { mesh } = rasterise(parseProject(json)).model;
    for (const v of [3, 3.3]) expect(hasLine(mesh!.y, v)).toBe(true);
  });

  it('corrects edges over z cells down to a quarter of the cell beside them, and names the edges it leaves', () => {
    const json = graded();
    json.mesh.graded.dielectric_cells = 10; // 0.1 mm substrate cells under 0.25 mm edge cells
    const fine = rasterise(parseProject(json)).model;
    for (const [v, inward] of [[3, -1], [-3, 1], [1, -1], [-1, 1]] as const) expect(corrected(fine.mesh!.x, v, inward, fine)).toBeDefined();
    json.mesh.graded.dielectric_cells = 25; // 0.04 mm: under a quarter
    const { model, warnings } = rasterise(parseProject(json));
    for (const v of [3, -3, 1, -1]) expect(hasLine(model.mesh!.x, v)).toBe(true);
    expect(warnings.some((w) => /copper edge\(s\) along x keep their drawn line/.test(w) && w.includes('z cells at layer "top"'))).toBe(true);
  });

  it('leaves the edges of copper under two edge cells wide where they are drawn', () => {
    const { mesh } = rasterise(parseProject(withFeedWidth(0.4))).model;
    for (const v of [0.2, -0.2]) expect(hasLine(mesh!.x, v)).toBe(true);
  });

  it('corrects strips two and 2.4 edge cells wide with their port in the middle, for the cell their grading gives', () => {
    for (const width of [0.5, 0.6]) {
      const model = rasterise(parseProject(withFeedWidth(width))).model;
      expect(hasLine(model.mesh!.x, 0)).toBe(true);
      for (const [v, inward] of [[width / 2, -1], [-width / 2, 1]] as const) expect(corrected(model.mesh!.x, v, inward, model)).toBeDefined();
    }
  });

  it('leaves uniform meshes alone', () => {
    const { mesh } = rasterise(parseProject(smallProjectJson())).model;
    for (const v of [3, -3, 1, -1]) expect(hasLine(mesh!.x, v)).toBe(true);
  });
});
