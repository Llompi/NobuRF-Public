import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCITATION } from '../src/engine/config';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { dualWidth } from '../src/engine/mesh';
import { correctedLine } from './edge_fixtures';
import { portSpectrum } from '../src/engine/port_dft';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson } from './project_fixtures';

const slow = process.env.SKIP_SLOW ? it.skip : it;

/** The small patch (6 mm on 1 mm FR-4) with PML on five faces, on a uniform or graded mesh. */
function project(mesh: 'coarse' | 'graded') {
  const json = smallProjectJson();
  const pml = { type: 'pml', cells: 8 };
  for (const f of ['x_min', 'x_max', 'y_min', 'y_max', 'z_max']) json.boundaries[f] = pml;
  json.analysis.stop.max_steps = 20000;
  if (mesh === 'graded') json.mesh.graded = { edge_cell: '0.25 mm', dielectric_cells: 4, max_growth: 1.3 };
  return rasterise(parseProject(json)).model;
}

describe('graded mesh from a project file', () => {
  it('puts lines on the patch, feed and port edges and the layer interfaces, and weights the port by them', () => {
    const m = project('graded');
    const has = (lines: Float64Array, v: number) => lines.some((x) => Math.abs(x - v) < 1e-12);
    // Copper edges sit the sheet-edge offset inside the drawn edge (tests/edge_placement.test.ts);
    // the board outline stays where it is drawn. The top copper is at z = 1 mm.
    const corrected = (lines: Float64Array, drawn: number, inward: -1 | 1) => correctedLine(lines, m.mesh.z, 1, drawn, inward, 0.25);
    for (const [v, inward] of [[-3, 1], [-1, 1], [1, -1], [3, -1]] as const) expect(corrected(m.mesh.x, v, inward)).toBeDefined();
    for (const [v, inward] of [[-4, 1], [-3, 1], [3, -1]] as const) expect(corrected(m.mesh.y, v, inward)).toBeDefined();
    for (const v of [-5, 5]) expect(has(m.mesh.x, v) && has(m.mesh.y, v)).toBe(true);
    for (const v of [0, 1]) expect(has(m.mesh.z, v)).toBe(true);
    const inSubstrate = Array.from(m.mesh.z).filter((z) => z >= 0 && z <= 1);
    expect(inSubstrate.length - 1).toBeGreaterThanOrEqual(4);
    const p = m.ports[0];
    expect(m.mesh.y[p.j]).toBe(corrected(m.mesh.y, -4, 1));
    expect(m.mesh.z[p.k1] - m.mesh.z[p.k0]).toBeCloseTo(1, 12);
    const dRef = m.grid.dxMm;
    expect(p.mesh.seriesLength).toBeCloseTo(1 / dRef, 9);
    expect(p.mesh.loopLengthX).toBeCloseTo(dualWidth(m.mesh.x, p.i) / dRef, 9);
    expect(p.mesh.loopLengthY).toBeCloseTo(dualWidth(m.mesh.y, p.j) / dRef, 9);
    expect(p.mesh.curlScaleX * p.mesh.loopLengthX).toBeCloseTo(1, 12);
  });

  /**
   * Resonance against a uniform 0.25 mm run of the same project, solved once
   * (f(S11 min) 11.00 GHz, 3000 steps, 36 s): the 1 mm uniform mesh reads
   * 9.67 GHz, the graded mesh with 0.25 mm at the edges must land within 3 %.
   */
  slow('lands near the fine uniform mesh where the coarse one cannot', () => {
    const FINE_UNIFORM_F0_GHZ = 11.0;
    const exc = { ...DEFAULT_EXCITATION, fMinGHz: 8, fMaxGHz: 16 };
    const f0 = (mesh: 'coarse' | 'graded') => {
      const run = new CpuFdtd(project(mesh)).run(exc, { maxSteps: 20000, stopAtEnergyDecayDb: 40, energyCheckEverySteps: 100 });
      const s = portSpectrum(run, exc);
      let k = 0;
      for (let n = 1; n < s.s11Db.length; n++) if (s.s11Db[n] < s.s11Db[k]) k = n;
      return s.fGHz[k];
    };
    expect(Math.abs(f0('graded') - FINE_UNIFORM_F0_GHZ) / FINE_UNIFORM_F0_GHZ).toBeLessThan(0.03);
    expect(Math.abs(f0('coarse') - FINE_UNIFORM_F0_GHZ) / FINE_UNIFORM_F0_GHZ).toBeGreaterThan(0.08);
  }, 120_000);
});
