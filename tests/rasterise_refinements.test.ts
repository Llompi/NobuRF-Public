import { describe, expect, it } from 'vitest';
import { cellWidth } from '../src/engine/mesh';
import { correctedLine } from './edge_fixtures';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

/** The small patch fixture on a graded mesh with 0.25 mm at copper edges. */
function gradedJson() {
  const json = smallProjectJson();
  json.mesh.graded = { edge_cell: '0.25 mm', dielectric_cells: 4, max_growth: 1.3 };
  return json;
}

const has = (lines: Float64Array, v: number) => lines.some((x) => Math.abs(x - v) < 1e-12);
const nearest = (lines: Float64Array, v: number) => {
  let best = 0;
  for (let i = 1; i < lines.length; i++) if (Math.abs(lines[i] - v) < Math.abs(lines[best] - v)) best = i;
  return best;
};

describe('rasterise mesh refinements', () => {
  it('adds lines in the air margin, inside the board and inside a dielectric, with small cells there', () => {
    const plain = rasterise(parseProject(gradedJson())).model.mesh;
    const refined = rasterise(parseProject(gradedJson()), {
      refinements: { x: [{ at: 0.4, cellMm: 0.1 }], y: [{ at: -6, cellMm: 0.1 }], z: [{ at: 0.5, cellMm: 0.1 }, { at: 2.5, cellMm: 0.1 }] },
    }).model.mesh;
    expect(has(plain.y, -6)).toBe(false);
    expect(has(refined.x, 0.4)).toBe(true);
    expect(has(refined.y, -6)).toBe(true);
    expect(has(refined.z, 0.5)).toBe(true);
    expect(has(refined.z, 2.5)).toBe(true);
    // The copper and layer lines are still there: the board outline where drawn, the copper
    // edges at the sheet-edge offset for the refined z cells (tests/edge_placement.test.ts).
    for (const [v, inward] of [[-3, 1], [-1, 1], [1, -1], [3, -1]] as const) expect(correctedLine(refined.x, refined.z, 1, v, inward, 0.25)).toBeDefined();
    for (const v of [-5, 5]) expect(has(refined.x, v)).toBe(true);
    for (const v of [0, 1]) expect(has(refined.z, v)).toBe(true);
    // Cells either side of the line are about cellMm (the size field grows by max_growth away from it).
    const j = nearest(refined.y, -6);
    expect(cellWidth(refined.y, j)).toBeLessThanOrEqual(0.1 * 1.3);
    expect(cellWidth(refined.y, j - 1)).toBeLessThanOrEqual(0.1 * 1.3);
    // Splitting the substrate keeps its dielectric_cells limit (1 mm / 4).
    const inSubstrate = Array.from(refined.z).filter((z) => z >= 0 && z <= 1);
    for (let n = 1; n < inSubstrate.length; n++) expect(inSubstrate[n] - inSubstrate[n - 1]).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it('merges a refinement closer than edge_cell / 4 to a copper edge into it, with a warning', () => {
    // The refinement also keeps the feed edge at x = 1 mm where it is drawn (it would crowd the corrected edge's lines).
    const r = rasterise(parseProject(gradedJson()), { refinements: { x: [{ at: 1.04, cellMm: 0.25 }] } });
    expect(has(r.model.mesh.x, 1.04)).toBe(false);
    expect(has(r.model.mesh.x, 1)).toBe(true);
    expect(r.warnings.some((w) => w.includes('x = 1.04 mm merged into the line at 1 mm'))).toBe(true);
  });

  it('refuses refinements outside the box and on a uniform mesh', () => {
    expect(() => rasterise(parseProject(gradedJson()), { refinements: { y: [{ at: -500, cellMm: 0.1 }] } })).toThrow(/outside the box/);
    expect(() => rasterise(parseProject(smallProjectJson()), { refinements: { z: [{ at: 0.5, cellMm: 0.1 }] } })).toThrow(/graded mesh/);
  });
});
