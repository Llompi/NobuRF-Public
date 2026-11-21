import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID } from '../src/engine/config';
import { applyEdit, baselineGeometry } from '../src/engine/geometry';
import type { MicroGeometryDSL } from '../src/engine/types';
import { voxelize, type VoxelModel } from '../src/engine/voxelize';
import { patchProjectFromDsl } from '../src/project/from_dsl';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { exampleJson, smallProjectJson } from './project_fixtures';

/**
 * The demo grid with one more cell of air on each side of the board: project
 * files need at least one cell between the board and the PML, while
 * DEFAULT_GRID puts the board edge on the PML's inner face.
 */
const GRID = { ...DEFAULT_GRID, nx: DEFAULT_GRID.nx + 2, ny: DEFAULT_GRID.ny + 2 };

/** Edges whose float bits differ, as "x(i,j,k)" labels, so a failure says where. */
function differingEdges(a: Float32Array, b: Float32Array): string[] {
  const { nx, ny, nz } = GRID;
  const N = nx * ny * nz;
  const bitsA = new Uint32Array(a.buffer);
  const bitsB = new Uint32Array(b.buffer);
  const out: string[] = [];
  for (let n = 0; n < bitsA.length; n++) {
    if (bitsA[n] === bitsB[n]) continue;
    const c = n % N;
    out.push(`${'xyz'[Math.floor(n / N)]}(${c % nx},${Math.floor(c / nx) % ny},${Math.floor(c / (nx * ny))})`);
  }
  return out;
}

function expectSameModel(project: VoxelModel, reference: VoxelModel): void {
  expect(differingEdges(project.eDecay, reference.eDecay)).toEqual([]);
  expect(differingEdges(project.eCurl, reference.eCurl)).toEqual([]);
  expect(project.ports).toEqual(reference.ports);
  expect(project.cpml).toEqual(reference.cpml);
  expect(project.patchK).toBe(reference.patchK);
  expect(project.topCopper).toEqual(reference.topCopper);
  expect(project.signature).toBe(reference.signature);
  const { stepsPerRun: _a, ...projectGrid } = project.grid;
  const { stepsPerRun: _b, ...referenceGrid } = reference.grid;
  expect(projectGrid).toEqual(referenceGrid);
}

// Cut edges (slots, notch) stay off the Yee sample points, which are multiples
// of 0.25 mm here: there project cuts keep the copper and isTopCopper removes it.
// The inset gap is 0.9 mm (notch edge at |x| = 2.15) for the same reason.
const withFeatures = [
  { inset_depth_mm: 3, inset_gap_mm: 0.9 },
  { upsert_feature: { id: 'u1', kind: 'u_slot', x_mm: 0, y_mm: 1.2, w_mm: 6.2, h_mm: 5.2, t_mm: 0.7 } },
  { upsert_feature: { id: 's1', kind: 'rect_slot', x_mm: -5.3, y_mm: 2.7, w_mm: 1.2, h_mm: 2.3 } },
  { upsert_feature: { id: 'st', kind: 'stub', x_mm: 8.5, y_mm: -0.3, w_mm: 1, h_mm: 3.1 } },
] as const;

const cases: Array<[string, () => MicroGeometryDSL]> = [
  ['baseline patch', baselineGeometry],
  ['inset 4 mm', () => applyEdit(baselineGeometry(), { inset_depth_mm: 4, inset_gap_mm: 0.9 })],
  ['inset + U slot + rect slot + stub', () => withFeatures.reduce((g, e) => applyEdit(g, e), baselineGeometry())],
  ['chamfered corners', () => applyEdit(baselineGeometry(), { corner_chamfer_mm: 2, inset_depth_mm: 3.5, inset_gap_mm: 0.9 })],
  ['lossy FR-4', () => ({ ...baselineGeometry(), substrate: { eps_r: 4.4, h_mm: 1.5, tan_delta: 0.02 } })],
];

describe('project rasteriser reproduces voxelize() bit for bit on the demo grid (+1 cell of air)', () => {
  it.each(cases)('%s', (_name, dsl) => {
    const { model, warnings } = rasterise(patchProjectFromDsl(dsl(), GRID));
    expectSameModel(model, voxelize(dsl(), GRID));
    expect(warnings).toEqual([]);
  });

  it('legacy difference: isTopCopper also cuts copper exactly on a notch edge, a project cut does not', () => {
    // Default inset gap 1 mm: the notch edge |x| = 1.25 + 1 = 2.25 mm runs through the Ex
    // samples at (i + 1/2) dx for y = -6 ... -2.5 mm. Those 16 edges stay copper here.
    const dsl = applyEdit(baselineGeometry(), { inset_depth_mm: 4 });
    const legacy = voxelize(dsl, GRID);
    const { model } = rasterise(patchProjectFromDsl(dsl, GRID));
    const k = legacy.patchK;
    const expected = [];
    for (let j = 21; j <= 28; j++) for (const i of [28, 37]) expected.push(`x(${i},${j},${k})`);
    expect(differingEdges(model.eCurl, legacy.eCurl).sort()).toEqual(expected.sort());
    for (const label of expected) {
      const [i, j] = label.slice(2, -1).split(',').map(Number);
      const c = i + GRID.nx * (j + GRID.ny * k);
      expect([model.eCurl[c], legacy.eCurl[c]]).toEqual([0, legacy.eCurl[c]]);
      expect(legacy.eCurl[c]).toBeGreaterThan(0);
    }
    expect(differingEdges(model.eDecay, legacy.eDecay)).toEqual([]);
  });

  it('examples/patch-5g8.json (variables and expressions) is the baseline patch', () => {
    const { model, warnings } = rasterise(parseProject(exampleJson()));
    expectSameModel(model, voxelize(baselineGeometry(), GRID));
    // The DSL feed starts at y = -10.2 mm, the project's at the port node (-10 mm): no Yee edge lies between.
    expect(warnings).toEqual([]);
  });
});

describe('project rasteriser beyond the single-substrate patch', () => {
  const N = (m: VoxelModel) => m.grid.nx * m.grid.ny * m.grid.nz;
  const at = (m: VoxelModel, i: number, j: number, k: number) => i + m.grid.nx * (j + m.grid.ny * k);

  /** gnd | core (FR-4) | inner | prepreg (RO4003C) | top, with the port between gnd and inner. */
  const fourLayerJson = () => {
    const json = smallProjectJson();
    json.stackup.splice(2, 0,
      { type: 'copper', name: 'inner', material: 'pec' },
      { type: 'dielectric', name: 'prepreg', material: 'RO4003C', thickness: '1 mm' });
    json.geometry.inner = json.geometry.top.map((s: { id: string }) => ({ ...s, id: `inner_${s.id}` }));
    json.ports[0].between = ['gnd', 'inner'];
    return json;
  };

  it('averages two different dielectrics on the plane between them', () => {
    const { model: m } = rasterise(parseProject(fourLayerJson()));
    const { courant: Sc, groundK } = m.grid;
    // A board edge clear of copper: the corner of the board, plane groundK + 1.
    const c = at(m, m.grid.nx - 9, m.grid.ny - 9, groundK + 1);
    const ezLow = 2 * N(m) + at(m, m.grid.nx - 9, m.grid.ny - 9, groundK);
    expect(m.eCurl[ezLow]).toBeLessThan(Sc / 4.4); // FR-4 is lossy: curl < Sc/eps_r
    expect(m.eCurl[c]).toBeLessThan(Sc / ((4.4 + 3.55) / 2));
    expect(m.eCurl[c]).toBeGreaterThan(0.95 * Sc / ((4.4 + 3.55) / 2));
    expect(m.patchK).toBe(groundK + 2);
    expect([m.ports[0].k0, m.ports[0].k1]).toEqual([groundK, groundK + 1]);
  });

  it('refuses a port whose column passes through copper on a layer in between, unless an anti-pad is cut', () => {
    const json = fourLayerJson();
    json.stackup[3].material = 'FR-4'; // one eps_r along the column
    json.ports[0].between = ['gnd', 'top'];
    json.geometry.inner = [{ id: 'plane', op: 'add', polygon: json.board.outline }];
    expect(() => rasterise(parseProject(json))).toThrow(/port "p1" column at node \(13,9\) passes through copper on layer "inner"; cut an anti-pad/);
    json.geometry.inner.push({ id: 'antipad', op: 'cut', polygon: [['-1 mm', '-5 mm'], ['1 mm', '-5 mm'], ['1 mm', '-3 mm'], ['-1 mm', '-3 mm']] });
    expect(rasterise(parseProject(json)).model.ports[0].cells).toBe(2);
  });

  it('a cut removes only the edges strictly inside it: a 2 mm slot on 1 mm cells leaves its rim', () => {
    const json = smallProjectJson();
    json.geometry.top.splice(1, 0, { id: 'slot', op: 'cut', polygon: [['-1 mm', '-1 mm'], ['1 mm', '-1 mm'], ['1 mm', '1 mm'], ['-1 mm', '1 mm']] });
    const { model: m } = rasterise(parseProject(json));
    const ex = (i: number, j: number) => m.eCurl[at(m, i, j, m.patchK)];
    const ey = (i: number, j: number) => m.eCurl[N(m) + at(m, i, j, m.patchK)];
    // Node (13, 13) is the patch centre (0, 0). Inside: Ex at x = +-0.5, y = 0; Ey at x = 0, y = +-0.5.
    expect([ex(12, 13), ex(13, 13), ey(13, 12), ey(13, 13)].every((curl) => curl > 0)).toBe(true);
    // On the rim (y = +-1 or x = +-1): still copper.
    expect([ex(12, 12), ex(13, 14), ey(12, 13), ey(14, 12)]).toEqual([0, 0, 0, 0]);
  });

  it('accepts the documented minimum air margin of one cell', () => {
    const json = smallProjectJson();
    json.mesh.air_margin_cells.above = 1;
    expect(() => rasterise(parseProject(json))).not.toThrow();
  });

  it('refuses a port across dielectrics with different eps_r', () => {
    const json = fourLayerJson();
    json.ports[0].between = ['gnd', 'top'];
    json.geometry.inner = [];
    expect(() => rasterise(parseProject(json))).toThrow(/port "p1" spans dielectrics with different eps_r \(4\.4, 3\.55\)/);
  });

  it('makes a "pec" low face PEC by zeroing its tangential E', () => {
    const { model: m } = rasterise(parseProject(smallProjectJson()));
    expect(m.cpml.faces.zLow).toBe(0);
    const c = at(m, 3, 3, 0);
    expect(m.eCurl[c]).toBe(0); // Ex
    expect(m.eCurl[N(m) + c]).toBe(0); // Ey
    expect(m.eCurl[2 * N(m) + c]).toBeGreaterThan(0); // Ez is normal to the face
  });

  it('accepts the port layers in either order and orients the column upward', () => {
    const { model: m } = rasterise(parseProject(smallProjectJson())); // between: ["top", "gnd"]
    expect([m.ports[0].k0, m.ports[0].k1]).toEqual([m.grid.groundK, m.patchK]);
  });

  it('refuses a port that is not on copper', () => {
    const json = smallProjectJson();
    json.ports[0].x = '3 mm';
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.ports\[0\]: port "p1" node \(16,9\) is not on copper of layer "top"/);
  });

  it('warns about copper off the board and thickness snapped to the grid', () => {
    const json = smallProjectJson();
    json.stackup[1].thickness = '1.2 mm';
    json.geometry.top.push({ id: 'overhang', op: 'add', polygon: [['4 mm', '-1 mm'], ['7 mm', '-1 mm'], ['7 mm', '1 mm'], ['4 mm', '1 mm']] });
    // The fixture's 8.9 cells per wavelength in FR-4 at 16 GHz warns too; this test is about the other two.
    expect(rasterise(parseProject(json)).warnings.filter((w) => !/cells per wavelength/.test(w))).toEqual([
      'layer "core": 1.2 mm snapped to 1 cells (1 mm)',
      'layer "top": copper outside the board outline is ignored (10 edges)',
    ]);
  });
});
