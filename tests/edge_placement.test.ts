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

  it('corrects both edges of a step in width under 1.5 edge cells, which is not a gap', () => {
    // A 2.5 mm section below the 2 mm feed: its edges are one edge cell beside the feed's, on another span.
    const json = graded();
    json.geometry.top.push({ id: 'wide', op: 'add', polygon: rect('-1.25 mm', '-patch / 2 - 2 mm', '1.25 mm', '-patch / 2 - 1 mm') });
    const { model, warnings } = rasterise(parseProject(json));
    for (const [v, inward] of [[1, -1], [-1, 1], [1.25, -1], [-1.25, 1]] as const) expect(corrected(model.mesh!.x, v, inward, model)).toBeDefined();
    expect(warnings.some((w) => /along x keep their drawn line/.test(w))).toBe(false);
  });

  it.each([0.6, 0.8, 1.2])('corrects and settles both edges of a step %s edge cells wide', (cells) => {
    const h = 1 + cells * EDGE_CELL;
    const json = graded();
    json.geometry.top.push({ id: 'wide', op: 'add', polygon: rect(`${-h} mm`, '-patch / 2 - 2 mm', `${h} mm`, '-patch / 2 - 1 mm') });
    const { model } = rasterise(parseProject(json));
    for (const [v, inward] of [[1, -1], [-1, 1], [h, -1], [-h, 1]] as const) expect(corrected(model.mesh!.x, v, inward, model)).toBeDefined();
  });

  /**
   * Every edge either keeps a line where it is drawn, or has a corrected line settled tightly on the
   * offset for its outside cell, with that cell in 0.5 to 1.2 edge cells and over twice the line's
   * depth (so the copper's midpoint edges stop at the line), and the cell inside at least half an
   * edge cell. The tight tolerance (0.75 of the settle step, against 2 for the plain helper) is what
   * a single settle sweep misses when one corrected line bounds another's cell.
   */
  const expectHeld = (json: ReturnType<typeof graded>, edges: number[]) => {
    const { model } = rasterise(parseProject(json));
    const x = model.mesh!.x;
    for (const v of edges.flatMap((h) => [h, -h])) {
      if (hasLine(x, v)) continue;
      const inward = v > 0 ? -1 : 1;
      const line = correctedLine(x, model.mesh!.z, 1, v, inward, EDGE_CELL, 0.75 * EDGE_LINE_SETTLE_CELLS);
      expect(line, `edge x = ${v}: neither drawn nor settled`).toBeDefined();
      const k = x.findIndex((l) => l === line);
      const outside = Math.abs(x[k - inward] - x[k]) / EDGE_CELL;
      expect(outside, `edge x = ${v}: cell outside its line`).toBeGreaterThanOrEqual(0.5);
      expect(outside, `edge x = ${v}: cell outside its line`).toBeLessThanOrEqual(1.2);
      expect(outside, `edge x = ${v}: cell outside against twice the depth`).toBeGreaterThan(2 * Math.abs(line! - v) / EDGE_CELL);
      expect(Math.abs(x[k + inward] - x[k]) / EDGE_CELL, `edge x = ${v}: cell inside its line`).toBeGreaterThanOrEqual(0.5);
    }
  };
  /** The 2 mm feed with two sections below it, `first` then `second` half-wide. */
  const twoSections = (first: number, second: number) => {
    const json = graded();
    json.geometry.top.push(
      { id: 'first', op: 'add', polygon: rect(`${-first} mm`, '-patch / 2 - 2 mm', `${first} mm`, '-patch / 2 - 1 mm') },
      { id: 'second', op: 'add', polygon: rect(`${-second} mm`, '-patch / 2 - 3 mm', `${second} mm`, '-patch / 2 - 2 mm') });
    return json;
  };
  // Each layout below broke an invariant on the first version of the settle (one sweep, no re-check
  // of the inside cell or the depth): 1.15/0.65 needs a second sweep (a single sweep leaves x = 1
  // off its offset), 0.75/1.2 left a 0.49 edge cell inside x = 0.75, and the others left an outside
  // cell under twice the depth (0.50 to 0.55 edge cell against depths of 0.27 to 0.28).
  it.each([[1.15, 0.65], [0.75, 1.2], [0.7, 1.4], [0.8, 1.3], [1.3, 0.75], [1.3, 0.9]])('holds every edge of a 2 mm feed above sections %s then %s mm half-wide: drawn, or settled with both cells in range', (first, second) => {
    expectHeld(twoSections(first, second), [1, first, second]);
  });

  // These end the layout passes on a phase whose lines cannot all be settled; an earlier pass with
  // the same corrections settles, so the edge named keeps its correction instead of its drawn line.
  it.each([[0.5, 1.4, 1], [0.55, 1.25, 0.55], [0.675, 1.15, 0.675]])('falls back to an earlier pass for sections %s then %s mm half-wide, keeping x = %s corrected', (first, second, edge) => {
    const json = twoSections(first, second);
    expectHeld(json, [1, first, second]);
    const x = rasterise(parseProject(json)).model.mesh!.x;
    expect(hasLine(x, edge)).toBe(false);
    expect(hasLine(x, -edge)).toBe(false);
  });

  it('keeps both sides of a gap under 1.5 edge cells drawn when another edge on the same line is beside it', () => {
    // A stub ending on the feed's edge line x = 1, facing a trace 0.2 mm (0.8 edge cell) away; the feed's own edge has nothing facing it.
    const json = graded();
    json.geometry.top.push({ id: 'stub', op: 'add', polygon: rect('-1 mm', '3.5 mm', '1 mm', '4.6 mm') }, { id: 'trace', op: 'add', polygon: rect('1.2 mm', '3.5 mm', '2.2 mm', '4.6 mm') });
    const { mesh } = rasterise(parseProject(json)).model;
    expect(hasLine(mesh!.x, 1)).toBe(true);
    expect(hasLine(mesh!.x, 1.2)).toBe(true);
  });

  it('treats copper facing an edge diagonally as a gap, and meshes a mirror-symmetric board symmetrically', () => {
    // Pieces beside the feed's span, 0.1 mm past each of its edges, copper facing the feed: listed left, feed, right.
    const json = graded();
    json.geometry.top.unshift({ id: 'left', op: 'add', polygon: rect('-2.1 mm', '-patch / 2 - 2 mm', '-1.1 mm', '-patch / 2 - 1 mm') });
    json.geometry.top.push({ id: 'right', op: 'add', polygon: rect('1.1 mm', '-patch / 2 - 2 mm', '2.1 mm', '-patch / 2 - 1 mm') });
    const x = rasterise(parseProject(json)).model.mesh!.x;
    for (const v of [1, 1.1, -1, -1.1]) expect(hasLine(x, v)).toBe(true);
    x.forEach((v, i) => expect(v).toBeCloseTo(-x[x.length - 1 - i], 9));
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
