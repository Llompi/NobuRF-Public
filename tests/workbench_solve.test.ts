import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dbMicrovoltPerMetre, driveScale } from '../src/engine/emc';
import { distanceRows, eirpDbm } from '../src/workbench/emissions_view';
import { volumeDftIndex } from '../src/engine/volume_dft';
import { cutComponent } from '../src/workbench/field_cut';
import { solveWorkbenchProject, type SolveProgress } from '../src/workbench/solve';
import type { ScatteringResult } from '../src/engine/port_dft';
import { deembedLineJson } from './project_fixtures';

/** The example patch on 1 mm cells with a far field: a few seconds on the CPU. */
function coarsePatch(): string {
  const p = JSON.parse(readFileSync('examples/patch-5g8.json', 'utf8'));
  p.mesh = { cell: '1 mm', air_margin_cells: { xy: 4, below: 4, above: 6 } };
  p.analysis.stop.max_steps = 3000;
  p.outputs.far_field_ghz = [5.8];
  return JSON.stringify(p);
}

describe('workbench solve (CPU)', () => {
  it('returns S11, Z, far field and field planes, and reports progress', async () => {
    const progress: SolveProgress[] = [];
    let started = false;
    const r = await solveWorkbenchProject(coarsePatch(), 'cpu', { onStart: () => (started = true), onProgress: (p) => progress.push(p) }, 'off');
    expect(started).toBe(true);
    expect(progress.length).toBeGreaterThan(3);
    const solving = progress.filter((p) => p.stage === 'solving');
    expect(solving.at(-1)!.decayDb).toBeGreaterThan(10);
    expect(progress.at(-1)!.stage).toBe('far-field'); // named, so the bar does not sit at 100 % meanwhile
    expect(r.solver).toMatch(/CPU/);
    expect(r.s.re[0][0]!.length).toBe(r.runs[0].spectrum.fGHz.length);
    // S11 from Z agrees with the spectrum's own dB values.
    const m = 40;
    const db = 20 * Math.log10(Math.hypot(r.s.re[0][0]![m], r.s.im[0][0]![m]));
    expect(db).toBeCloseTo(r.runs[0].spectrum.s11Db[m], 6);
    expect(r.farField!.entries[0].result.peakDirectivityDbi).toBeGreaterThan(3);
    const planes = r.fields!.planes;
    expect(planes.map((p) => p.frequencyGHz)).toEqual([5.8]);
    const n = r.fields!.xMm.length * r.fields!.yMm.length;
    expect(planes[0].ez.re.length).toBe(n);
    // The current flows on the patch: strongest well inside the board, near zero far outside it.
    const mag = (k: number) => Math.hypot(planes[0].jx.re[k], planes[0].jx.im[k], planes[0].jy.re[k], planes[0].jy.im[k]);
    const nx = r.fields!.xMm.length;
    const at = (x: number, y: number) => {
      const i = r.fields!.xMm.findIndex((v) => v >= x);
      const j = r.fields!.yMm.findIndex((v) => v >= y);
      return mag(i + nx * j);
    };
    expect(at(0, 0)).toBeGreaterThan(20 * at(15, 15));
  }, 120_000);

  it('keeps the field volume only when asked, without changing S, and its Ez cut matches the Ez plane', async () => {
    const hooks = { onStart: () => undefined, onProgress: () => undefined };
    const plain = await solveWorkbenchProject(coarsePatch(), 'cpu', hooks, 'off');
    const kept = await solveWorkbenchProject(coarsePatch(), 'cpu', hooks, 'off', true);
    expect(plain.fields!.volume).toBeNull();
    expect(plain.fields!.volumeSkipped).toMatch(/only when Cut is on/);
    expect(plain.fields!.volumeAsked).toBe(false);
    expect(Array.from(kept.s.re[0][0]!)).toEqual(Array.from(plain.s.re[0][0]!));
    expect(Array.from(kept.s.im[0][0]!)).toEqual(Array.from(plain.s.im[0][0]!));
    const fields = kept.fields!;
    const volume = fields.volume!;
    expect(volume.frequencies).toBe(1);
    expect(fields.volumeSkipped).toBeNull();
    // The raw Ez of the volume on the substrate's Ez half-plane is the Ez the existing field plot draws.
    const ezK = volume.zMm.findIndex((z, k) => z <= fields.ezZMm && volume.zMm[k + 1] > fields.ezZMm);
    const layout = { nx: fields.xMm.length, ny: fields.yMm.length, nz: volume.zMm.length, frequencies: 1 };
    const ez = fields.planes[0].ez;
    let worst = 0;
    let largest = 0;
    for (let c = 0; c < layout.nx * layout.ny; c++) {
      const at = volumeDftIndex(layout, 0, 'ez', c % layout.nx, Math.floor(c / layout.nx), ezK);
      largest = Math.max(largest, Math.hypot(ez.re[c], ez.im[c]));
      worst = Math.max(worst, Math.hypot(volume.accumulators[at] - ez.re[c], volume.accumulators[at + 1] - ez.im[c]));
    }
    expect(largest).toBeGreaterThan(0);
    expect(worst / largest).toBeLessThan(1e-4);
    // And a cut through the volume draws it.
    const cut = cutComponent(fields, volume, 0, { axis: 'z', index: ezK + 1 }, 'ez');
    expect(cut.re.some((v) => v !== 0)).toBe(true);
  }, 240_000);

  it('scans the near field at the asked heights and scales the 3 m field with the drive', async () => {
    const p = JSON.parse(coarsePatch());
    p.mesh.air_margin_cells.above = 10;
    p.outputs.near_field_mm = [2, 5];
    const r = await solveWorkbenchProject(JSON.stringify(p), 'cpu', { onStart: () => undefined, onProgress: () => undefined }, 'off');
    // 1 mm cells: the heights land on planes exactly.
    expect(r.nearField!.map((s) => s.meshHeightMm)).toEqual([2, 5]);
    const plane = r.nearField![0].planes[0];
    expect(plane.hz.re.length).toBe(r.fields!.xMm.length * r.fields!.yMm.length);
    // The field falls with height over the patch centre.
    const centre = r.fields!.xMm.indexOf(0) + r.fields!.xMm.length * r.fields!.yMm.indexOf(0);
    const ez = (s: number) => Math.hypot(r.nearField![s].planes[0].ez.re[centre], r.nearField![s].planes[0].ez.im[centre]);
    expect(ez(0)).toBeGreaterThan(ez(1));
    const entry = r.farField!.entries[0];
    const rows = distanceRows(r, 10);
    expect(rows.map((row) => row.distanceM)).toEqual([3, 10]);
    expect(rows[0].dbMicrovoltPerMetre).toBeCloseTo(dbMicrovoltPerMetre(driveScale(10, 50) * entry.fieldAt3mVPerM), 9);
    // Far zone: 10 m is 10.46 dB below 3 m, and E at 3 m is sqrt(30 EIRP) / 3 within 0.05 dB.
    expect(rows[0].dbMicrovoltPerMetre - rows[1].dbMicrovoltPerMetre).toBeCloseTo(20 * Math.log10(10 / 3), 1);
    const eirpW = 1e-3 * 10 ** (eirpDbm(r, 0, 10) / 10);
    expect(Math.abs(rows[0].dbMicrovoltPerMetre - dbMicrovoltPerMetre(Math.SQRT2 * Math.sqrt(30 * eirpW) / 3))).toBeLessThan(0.05);
  }, 120_000);

  it('refuses a scan above the free air and two heights on one plane', async () => {
    const hooks = { onStart: () => undefined, onProgress: () => undefined };
    const p = JSON.parse(coarsePatch());
    p.outputs.near_field_mm = [40];
    await expect(solveWorkbenchProject(JSON.stringify(p), 'cpu', hooks, 'off')).rejects.toThrow(/above the free air of the solve box/);
    p.outputs.near_field_mm = [2, 2.2];
    await expect(solveWorkbenchProject(JSON.stringify(p), 'cpu', hooks, 'off')).rejects.toThrow(/land on the same mesh plane/);
    // A 1 mm solder mask over the copper: a scan 1 mm up would interpolate Ez across its surface.
    p.stackup.push({ type: 'dielectric', name: 'mask', material: 'fr4_lossless', thickness: '1 mm' });
    p.outputs.near_field_mm = [1];
    await expect(solveWorkbenchProject(JSON.stringify(p), 'cpu', hooks, 'off')).rejects.toThrow(/in or next to a dielectric or metal/);
  });

  it('mesh check solves one finer mesh and returns that mesh\'s result', async () => {
    // A graded 1.5 mm FR-4 patch: coarse enough to solve twice in seconds.
    const p = JSON.parse(readFileSync('examples/patch-5g8-graded.json', 'utf8'));
    p.mesh = { cell: '1.5 mm', air_margin_cells: { xy: 2, below: 2, above: 6 }, graded: { edge_cell: '0.75 mm', dielectric_cells: 2, max_growth: 1.4 } };
    p.analysis.stop = { energy_decay_db: 30, max_steps: 4000 };
    const text = JSON.stringify(p);
    const scales = new Set<number>();
    const off = await solveWorkbenchProject(text, 'cpu', { onStart: () => {}, onProgress: () => {} }, 'off');
    const r = await solveWorkbenchProject(text, 'cpu', { onStart: () => {}, onProgress: (x) => x.meshScale && scales.add(x.meshScale) }, 'check');
    expect([...scales].map((x) => x.toFixed(3))).toEqual(['0.707']);
    expect(r.projectText).toBe(text);
    expect(Array.from(r.s.re[0][0]!)).not.toEqual(Array.from(off.s.re[0][0]!)); // the finer mesh's S, not the project mesh's
    expect(r.grid.boardCellMm).toBeLessThan(off.grid.boardCellMm);
    const c = r.accuracy!.convergence!;
    expect(c.levels.map((l) => l.scale.toFixed(3))).toEqual(['1.000', '0.707']);
    expect(c.fResGhz!.uncertainty).toBeGreaterThan(0);
    expect(r.accuracy!.checks.map((x) => [x.name, x.passed])).toEqual([['passivity', true], ['energy_decay', true]]);
    expect(r.warnings).toEqual(expect.arrayContaining(r.accuracy!.warnings));
  }, 120_000);

  /** S21's unwrapped phase in degrees at the last frequency. */
  const s21PhaseDeg = (s: ScatteringResult) => {
    let total = 0;
    let previous = 0;
    for (let m = 0; m < s.fGHz.length; m++) {
      const a = Math.atan2(s.im[1][0]![m], s.re[1][0]![m]);
      total += Math.atan2(Math.sin(a - previous), Math.cos(a - previous));
      previous = a;
    }
    return (total * 180) / Math.PI;
  };
  const quiet = { onStart: () => {}, onProgress: () => {} };

  it('de-embeds both feeds with one kit, also under a mesh check, and the line between the planes is the shorter one', async () => {
    const raw = deembedLineJson();
    raw.ports.forEach((p: any) => delete p.deembed);
    const atPorts = await solveWorkbenchProject(JSON.stringify(raw), 'cpu', quiet, 'off');
    // "check" on a uniform mesh runs no finer mesh (it says why) and de-embeds the project's own solve.
    const r = await solveWorkbenchProject(JSON.stringify(deembedLineJson()), 'cpu', quiet, 'check');
    expect(r.accuracy!.unavailable).toMatch(/uniform mesh/);
    expect(r.deembedding!.map((p) => [p.feed.portId, p.kit.solves, p.kit.reusedFrom])).toEqual([['p1', 3, null], ['p2', 0, 'p1']]);
    // 14 mm of line between the ports, 8 mm between the planes; the raw phase also carries the ports' own.
    const ratio = s21PhaseDeg(r.s) / s21PhaseDeg(atPorts.s);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(8 / 14);
    expect(r.runs[0].spectrum.zRe[0]).not.toBe(atPorts.runs[0].spectrum.zRe[0]);
  }, 120_000);

  it('refuses de-embedding without the full S-matrix before it solves anything', async () => {
    const json = deembedLineJson();
    json.analysis.excite = ['p1'];
    let started = false;
    await expect(solveWorkbenchProject(JSON.stringify(json), 'cpu', { onStart: () => (started = true), onProgress: () => {} }, 'off'))
      .rejects.toThrow(/full S-matrix/);
    expect(started).toBe(false);
  });
});
