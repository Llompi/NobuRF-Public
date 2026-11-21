import { describe, expect, it } from 'vitest';
import { componentImpedance, edgeMedium, LUMPED_COEF, LUMPED_COEFS_PER_EDGE } from '../src/engine/lumped';
import { idx3 } from '../src/engine/voxelize';
import { rasterise } from '../src/project/rasterise';
import { resolveProject } from '../src/project/resolve';
import { parseProject, ProjectError } from '../src/project/schema';
import { rect, twoPortLineJson } from './project_fixtures';

/** twoPortLineJson's trace cut at y = -1 .. 1 mm, so a component can bridge the gap. */
function gapLineJson(components: unknown[]): Record<string, any> {
  const json = twoPortLineJson();
  json.geometry.top = [
    { id: 'in', op: 'add', polygon: rect('-1 mm', '-half_len', '1 mm', '-1 mm') },
    { id: 'out', op: 'add', polygon: rect('-1 mm', '1 mm', '1 mm', 'half_len') },
  ];
  json.components = components;
  return json;
}
const series = { id: 'R1', layer: 'top', from: ['0 mm', '-1 mm'], to: ['0 mm', '1 mm'], r_ohm: 50 };
const shunt = { id: 'C1', x: '0 mm', y: '-3 mm', between: ['top', 'gnd'], c_pf: 1 };

describe('components in the project file', () => {
  it('parses both placements and resolves values to SI units', () => {
    const r = resolveProject(parseProject(gapLineJson([series, { ...shunt, l_nh: 2, connection: 'parallel' }])));
    expect(r.components[0]).toEqual({
      id: 'R1', values: { resistanceOhm: 50, inductanceH: null, capacitanceF: null, connection: 'series' },
      place: { kind: 'layer', layer: 'top', axis: 1, fromMm: -1, toMm: 1, acrossMm: 0, widthMm: null },
    });
    expect(r.components[1].values).toEqual({ resistanceOhm: null, inductanceH: 2e-9, capacitanceF: 1e-12, connection: 'parallel' });
    expect(r.components[1].place).toEqual({ kind: 'between', xMm: 0, yMm: -3, between: ['top', 'gnd'] });
  });

  it('a project without components is unchanged', () => {
    const json = twoPortLineJson();
    expect(parseProject(json)).not.toHaveProperty('components');
    expect(rasterise(parseProject(json)).model.lumped).toBeUndefined();
  });

  const rejects: Array<[string, unknown, RegExp]> = [
    ['no value', { ...series, r_ohm: undefined }, /at least one of r_ohm, l_nh, c_pf/],
    ['two values without a connection', { ...series, l_nh: 1 }, /connection.*is needed with more than one/],
    ['an unknown connection', { ...series, connection: 'both' }, /must be "series" or "parallel"/],
    ['a zero resistance', { ...series, r_ohm: 0 }, /out of range/],
    ['both placements', { ...series, between: ['top', 'gnd'] }, /unknown key/],
    ['neither placement', { id: 'X', r_ohm: 1 }, /either "between".*or "layer"/],
    ['a diagonal part', { ...series, to: ['1 mm', '1 mm'] }, /exactly one of x and y/],
    ['a dielectric layer', { ...series, layer: 'core' }, /not a copper layer/],
    ['an id taken by a port', { ...series, id: 'p1' }, /already used by a port/],
  ];
  for (const [what, component, message] of rejects) {
    it(`rejects ${what}`, () => {
      const json = gapLineJson([JSON.parse(JSON.stringify(component))]);
      expect(() => parseProject(json)).toThrow(message);
      expect(() => parseProject(json)).toThrow(ProjectError);
    });
  }
});

describe('rasterising components', () => {
  it('a part across the gap covers the Ey edges between its pads, one column', () => {
    const { model } = rasterise(parseProject(gapLineJson([series])));
    const g = model.grid;
    const N = g.nx * g.ny * g.nz;
    const port = model.ports[0];
    // The gap is 2 mm on 1 mm cells: two Ey edges at x = 0 on the top copper plane.
    const j0 = port.j + 6;
    expect(Array.from(model.lumped!.eIndex)).toEqual([N + idx3(g, port.i, j0, port.k1), N + idx3(g, port.i, j0 + 1, port.k1)]);
    expect(model.lumped!.coef.length).toBe(2 * LUMPED_COEFS_PER_EDGE);
    // Main-kernel coefficients now carry the resistor; the energy formula still reads the interface eps_r.
    const e = model.lumped!.eIndex[0];
    expect(model.eCurl[e]).toBe(model.lumped!.coef[LUMPED_COEF.cb]);
    expect(edgeMedium(g.courant, model.eDecay[e], model.eCurl[e]).epsR).toBeCloseTo((4.4 + 1) / 2, 5);
  });

  it('width spreads the part over every grid line across it', () => {
    const { model } = rasterise(parseProject(gapLineJson([{ ...series, width: '2 mm' }])));
    expect(model.lumped!.eIndex.length).toBe(3 * 2);
  });

  it('a part between layers covers the Ez column at its node', () => {
    const { model } = rasterise(parseProject(gapLineJson([shunt])));
    const g = model.grid;
    const port = model.ports[0];
    expect(Array.from(model.lumped!.eIndex)).toEqual([2 * g.nx * g.ny * g.nz + idx3(g, port.i, port.j + 4, port.k0)]);
  });

  it('changes the model signature with the value', () => {
    const a = rasterise(parseProject(gapLineJson([series]))).model.signature;
    const b = rasterise(parseProject(gapLineJson([{ ...series, r_ohm: 51 }]))).model.signature;
    const c = rasterise(parseProject(gapLineJson([{ ...series, r_ohm: 50, l_nh: 1, connection: 'series' }]))).model.signature;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  const fails: Array<[string, unknown[], RegExp]> = [
    ['a part over unbroken copper', [{ ...series, from: ['0 mm', '-4 mm'], to: ['0 mm', '-2 mm'] }], /copper of layer "top" under it/],
    ['a part with a free end', [{ ...series, from: ['0 mm', '-1 mm'], to: ['3 mm', '-1 mm'] }], /needs copper of layer "top" at both ends/],
    ['a part wider than its pads', [{ ...series, width: '4 mm' }], /needs copper of layer "top" at both ends/],
    ['a part placed pad centre to pad centre', [{ ...series, from: ['0 mm', '-3 mm'], to: ['0 mm', '3 mm'] }], /copper of layer "top" under it at y = -3 mm; from and to are the two edges of the gap/],
    ['a part shorter than a cell', [{ ...series, from: ['0 mm', '-1 mm'], to: ['0 mm', '-0.8 mm'] }], /shorter than one cell/],
    ['a shunt part off the copper', [{ ...shunt, x: '3 mm' }], /does not touch copper of layer "top"/],
    ['a shunt part on a port', [{ ...shunt, y: '-half_len' }], /sits on the cells of a port/],
    ['two parts on one edge', [shunt, { ...shunt, id: 'C2' }], /overlaps component "C1"/],
  ];
  for (const [what, components, message] of fails) {
    it(`rejects ${what}`, () => {
      expect(() => rasterise(parseProject(gapLineJson(components)))).toThrow(message);
    });
  }

  it('rejects a part that copper beside it joins end to end', () => {
    const json = gapLineJson([series]);
    json.geometry.top.push({ id: 'bridge', op: 'add', polygon: rect('1 mm', '-2 mm', '3 mm', '2 mm') });
    expect(() => rasterise(parseProject(json))).toThrow(/shorted by copper of layer "top" that joins its two ends/);
  });
});

describe('componentImpedance', () => {
  it('series adds, parallel adds admittances; a parallel RLC is R at resonance', () => {
    const f0 = 1 / (2 * Math.PI * Math.sqrt(2e-9 * 1e-12));
    const parallel = componentImpedance({ resistanceOhm: 75, inductanceH: 2e-9, capacitanceF: 1e-12, connection: 'parallel' }, f0);
    expect(parallel[0]).toBeCloseTo(75, 9);
    expect(parallel[1]).toBeCloseTo(0, 9);
    const seriesZ = componentImpedance({ resistanceOhm: 5, inductanceH: 2e-9, capacitanceF: 1e-12, connection: 'series' }, f0);
    expect(seriesZ[0]).toBeCloseTo(5, 9);
    expect(seriesZ[1]).toBeCloseTo(0, 6);
  });
});
