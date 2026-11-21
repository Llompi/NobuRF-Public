import { describe, expect, it } from 'vitest';
import { solveProjectText } from '../scripts/noburf';
import { solveWorkbenchProject } from '../src/workbench/solve';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { rect, smaEdgeLineJson, smaThroughLineJson, smallProjectJson } from './project_fixtures';

const slow = process.env.SKIP_SLOW ? it.skip : it;

describe('sma_edge port', () => {
  it('parses, sits on the board edge and meshes the connector', () => {
    const { model, coaxPorts: [{ spec: coaxFeed }] } = rasterise(parseProject(smaEdgeLineJson()));
    
    // Board edge y = -7 mm; the pin rests on the 1 mm FR-4 top copper.
    expect(coaxFeed.flangeMm).toBe(-7);
    expect(coaxFeed.axisMm[1]).toBeCloseTo(1.635, 12);
    // Lines at the flange, the source plane and both probes.
    for (const d of [0, 6, 10, 14]) expect(model.mesh.y.some((y) => Math.abs(y - (-7 - d)) < 1e-9)).toBe(true);
    // The lumped port at the flange stands in until solveCoaxFeed swaps it for the connector.
    expect(model.ports).toHaveLength(1);
  });

  it.each([2.01, 1.84, 3.05, 0.6])('meshes a %s mm trace without sliver cells around the pin', (widthMm) => {
    const json = smaEdgeLineJson();
    const half = `${widthMm / 2} mm`;
    json.geometry.top[0].polygon = rect(`-${half}`, '-half_len', half, 'half_len');
    const { model } = rasterise(parseProject(json));
    // The connector's 0.125 mm cross lattice is fitted to the trace edges, so no cell is a sliver of it.
    expect(model.grid.dxMm).toBeGreaterThan(0.1);
  });

  it('widens the air only where the connector reaches', () => {
    const json = smaEdgeLineJson();
    json.mesh.air_margin_cells = { xy: 4, below: 1, above: 1 };
    const { model, coaxPorts: [{ spec: coaxFeed }] } = rasterise(parseProject(json));
    const pml = 6;
    const [x, y, z] = [model.mesh.x, model.mesh.y, model.mesh.z];
    // x and y_max keep the 4 mm margin; y_min reaches past the coax run (about 16 mm), z past the body.
    expect(x[pml]).toBeCloseTo(-8, 9);
    expect(x[x.length - 1 - pml]).toBeCloseTo(8, 9);
    expect(y[y.length - 1 - pml]).toBeCloseTo(11, 9);
    expect(-7 - y[pml]).toBeGreaterThan(16);
    expect(-7 - y[pml]).toBeLessThan(19);
    expect(z[0]).toBeLessThan(coaxFeed.axisMm[1] - 3.175);
    expect(z[z.length - 1 - pml]).toBeGreaterThan(coaxFeed.axisMm[1] + 3.175);
  });

  it.each([0.3, 0.45, 0.6, 0.75, 0.9])('keeps whole cells past the connector at %s mm cells, and widens x for a port near the side', (cellMm) => {
    const json = smaEdgeLineJson();
    json.mesh.cell = `${cellMm} mm`;
    json.mesh.air_margin_cells = { xy: 1, below: 1, above: 1 };
    // Pin at x = 3 mm on the 8 mm wide board: the 6.35 mm body reaches past x = 4 mm.
    json.geometry.top[0].polygon = rect('2 mm', '-half_len', '4 mm', 'half_len');
    json.ports[0].x = '3 mm';
    const { model } = rasterise(parseProject(json));
    // The connector's own 0.125 mm lattice is the smallest cell: no sliver where its air ends.
    expect(model.grid.dxMm).toBeCloseTo(0.125, 6);
    expect(model.mesh.x.at(-1)!).toBeGreaterThan(3 + 3.175);
  });

  it('keeps lumped ports as they were, with or without kind', () => {
    const json = smallProjectJson();
    json.ports[0].kind = 'lumped';
    expect(rasterise(parseProject(json)).coaxPorts).toEqual([]);
    expect(parseProject(json).ports[0]).toMatchObject({ kind: 'lumped', y: '-patch / 2 - 1 mm' });
  });

  it.each([
    ['an unknown kind', (j: any) => { j.ports[0].kind = 'n_type'; }, /\$\.ports\[0\]\.kind: must be "lumped", "sma_edge" or "coax_probe"/],
    ['a y on an SMA', (j: any) => { j.ports[0].y = '0 mm'; }, /\$\.ports\[0\]\.y: unknown key/],
    ['an unknown edge', (j: any) => { j.ports[0].edge = 'z_max'; }, /\$\.ports\[0\]\.edge: must be one of "x_min", "x_max", "y_min", "y_max"/],
    ['x on an x edge', (j: any) => { j.ports[0].edge = 'x_max'; }, /\$\.ports\[0\]\.x: unknown key/],
  ])('rejects %s when parsing', (_, edit, error) => {
    const json = smaEdgeLineJson();
    edit(json);
    expect(() => parseProject(json)).toThrow(error);
  });

  it.each([
    ['a uniform mesh', (j: any) => { delete j.mesh.graded; }, /\$\.mesh: the sma_edge port "sma" needs a graded mesh/],
    ['a second connector on top of the first', (j: any) => { j.ports.push({ ...j.ports[0], id: 'sma2', x: '3 mm' }); }, /\$\.ports\[1\]: the connector of port "sma2" overlaps the one of port "sma"/],
    ['a PEC y_min wall', (j: any) => { j.boundaries.y_min = { type: 'pec' }; }, /\$\.boundaries\.y_min: must be a PML/],
    ['the layers swapped', (j: any) => { j.ports[0].between = ['gnd', 'top']; }, /\$\.ports\[0\]\.between: must be \[top copper layer/],
    ['a trace short of the board edge', (j: any) => { j.geometry.top[0].polygon = rect('-1 mm', '-5 mm', '1 mm', 'half_len'); }, /port "sma" needs copper of layer "top" reaching the board edge at x = 0 mm/],
  ])('rejects %s when meshing', (_, edit, error) => {
    const json = smaEdgeLineJson();
    edit(json);
    expect(() => rasterise(parseProject(json))).toThrow(error);
  });

  it('is refused with a far field, before any solving', async () => {
    const json = smaEdgeLineJson();
    json.boundaries.z_min = { type: 'pml', cells: 6 };
    json.mesh.air_margin_cells = { xy: 18, below: 6, above: 6 };
    json.outputs.far_field_ghz = [5];
    await expect(solveProjectText(JSON.stringify(json), 'p.json', false)).rejects.toThrow(/far field is not computed with an sma_edge or coax_probe port/);
  });

  slow('solves in the workbench too, on the CPU, with the same stub resonances and field maps', async () => {
    let started: { solver: string } | undefined;
    const r = await solveWorkbenchProject(JSON.stringify(smaEdgeLineJson()), 'auto', { onStart: (s) => (started = s), onProgress: () => {} }, 'off');
    expect(started?.solver).toBe('CPU');
    expect(r.solver).toMatch(/connector flanges/);
    const { fGHz, zIm, zRe, s11Db } = r.runs[0].spectrum;
    const rising = fGHz.findIndex((_, m) => m > 0 && zIm[m - 1] < 0 && zIm[m] >= 0);
    const quarterWaveGHz = fGHz[rising - 1] + ((fGHz[rising] - fGHz[rising - 1]) * -zIm[rising - 1]) / (zIm[rising] - zIm[rising - 1]);
    expect(quarterWaveGHz).toBeGreaterThan(2.6);
    expect(quarterWaveGHz).toBeLessThan(2.95);
    expect(fGHz[zRe.indexOf(Math.max(...zRe))]).toBeCloseTo(5.5, 6);
    // S11 from Z agrees with the feed's own S11 in dB.
    s11Db.forEach((db, m) => expect(20 * Math.log10(Math.hypot(r.s.re[0][0]![m], r.s.im[0][0]![m]))).toBeCloseTo(db, 3));
    expect(r.fields?.planes.length).toBeGreaterThan(0);
  }, 600_000);

  slow('solves a line between two SMAs in the workbench: full S-matrix, low loss, a run per port', async () => {
    const r = await solveWorkbenchProject(JSON.stringify(smaThroughLineJson()), 'auto', { onStart: () => {}, onProgress: () => {} }, 'off');
    expect(r.excited).toEqual([0, 1]);
    expect(r.runs.map((run) => run.portId)).toEqual(['in', 'out']);
    expect(r.s.re).toHaveLength(2);
    r.s.fGHz.forEach((_, m) => {
      expect(20 * Math.log10(Math.hypot(r.s.re[1][0]![m], r.s.im[1][0]![m]))).toBeGreaterThan(-1.5);
      expect(Math.hypot(r.s.re[1][0]![m] - r.s.re[0][1]![m], r.s.im[1][0]![m] - r.s.im[0][1]![m])).toBeLessThan(0.02);
    });
    expect(r.solver).toMatch(/in [\d.]+ Ω, out [\d.]+ Ω/);
  }, 900_000);

  slow('solves an open-ended line through the connector: stub resonances at the flange', async () => {
    const solved = await solveProjectText(JSON.stringify(smaEdgeLineJson()), 'p.json', false);
    expect(solved.samples).toBeNull();
    expect(solved.stoppedOnEnergy).toBe(true);
    expect(solved.spec.fGHz).toHaveLength(13);
    // Open end 14 mm away: only radiation and FR-4 loss, under 1.5 dB round trip.
    for (const db of solved.spec.s11Db) expect(db).toBeGreaterThan(-1.5);
    // A 14 mm open stub: series resonance (Im Z through zero, rising) at a quarter wave,
    // about 2.77 GHz, and parallel resonance (Re Z peak) at a half wave, 5.5 GHz.
    // A floating pin or a phase error in the de-embedding moves or removes both.
    const { fGHz, zRe, zIm } = solved.spec;
    const rising = fGHz.findIndex((_, m) => m > 0 && zIm[m - 1] < 0 && zIm[m] >= 0);
    expect(rising).toBeGreaterThan(0);
    const quarterWaveGHz = fGHz[rising - 1] + ((fGHz[rising] - fGHz[rising - 1]) * -zIm[rising - 1]) / (zIm[rising] - zIm[rising - 1]);
    expect(quarterWaveGHz).toBeGreaterThan(2.6);
    expect(quarterWaveGHz).toBeLessThan(2.95);
    const peak = zRe.indexOf(Math.max(...zRe));
    expect(fGHz[peak]).toBeCloseTo(5.5, 6);
    expect(zRe[peak]).toBeGreaterThan(300);
    expect(solved.solver).toMatch(/coax feeds/);
  }, 600_000);
});
