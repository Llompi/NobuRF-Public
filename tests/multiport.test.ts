import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { touchstoneLines } from '../src/engine/touchstone';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { scatteringMatrix, type ScatteringResult } from '../src/engine/port_dft';
import type { ExcitationConfig, PortSamples, RunControl } from '../src/engine/types';
import { rasterise } from '../src/project/rasterise';
import { parseProject } from '../src/project/schema';
import { smallProjectJson, twoPortLineJson } from './project_fixtures';

const magnitude = (s: ScatteringResult, i: number, j: number, m: number) => Math.hypot(s.re[i][j]![m], s.im[i][j]![m]);
const db = (x: number) => 20 * Math.log10(x);

/** Lines other than the validated-envelope notes, which this FR-4 two-port fixture always gets. */
const notEnvelope = (lines: string[]) => lines.filter((l) => l && !/^(warning: )?outside the validated range: /.test(l));

describe('two-port microstrip line on the CPU', () => {
  const project = parseProject(twoPortLineJson());
  const { model } = rasterise(project);
  const a = project.analysis;
  const exc: ExcitationConfig = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const control: RunControl = { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 };
  let runs: PortSamples[];
  let s: ScatteringResult;

  beforeAll(() => {
    const solver = new CpuFdtd(model);
    runs = [0, 1].map((activePort) => solver.run(exc, control, undefined, activePort));
    s = scatteringMatrix(runs.map((samples, activePort) => ({ activePort, samples })), [50, 50], exc);
  });

  it('records every port and reports the active one as v and i', () => {
    expect(model.ports).toHaveLength(2);
    for (const [n, run] of runs.entries()) {
      expect(run.ports).toHaveLength(2);
      expect(run.v).toBe(run.ports[n].v);
      expect(run.i).toBe(run.ports[n].i);
      expect(run.stoppedOnEnergy).toBe(true);
    }
    expect(s.method).toBe('full');
  });

  const worstReciprocity = (r: ScatteringResult) => {
    let worst = 0;
    for (let m = 0; m < r.fGHz.length; m++) {
      worst = Math.max(worst, Math.hypot(r.re[1][0]![m] - r.re[0][1]![m], r.im[1][0]![m] - r.im[0][1]![m]));
    }
    return worst;
  };

  it('is reciprocal: S21 = S12', () => {
    // The two runs stop on energy at different steps; each leaves a tail under the stop level.
    expect(worstReciprocity(s)).toBeLessThan(5e-3);
    // Run to the same step, the discrete scheme is reciprocal; what is left is float32 rounding.
    const solver = new CpuFdtd(model);
    const fixed = { ...control, maxSteps: Math.max(...runs.map((r) => r.v.length)), stopAtEnergyDecayDb: null };
    const equal = [0, 1].map((activePort) => ({ activePort, samples: solver.run(exc, fixed, undefined, activePort) }));
    expect(worstReciprocity(scatteringMatrix(equal, [50, 50], exc))).toBeLessThan(1e-5);
  });

  it('is passive: sum over i of |S_ij|^2 <= 1 for each column', () => {
    for (let m = 0; m < s.fGHz.length; m++) {
      for (const j of [0, 1]) expect(magnitude(s, 0, j, m) ** 2 + magnitude(s, 1, j, m) ** 2).toBeLessThanOrEqual(1 + 1e-3);
    }
  });

  it('passes a low frequency through: |S21| near 0 dB, S11 low', () => {
    expect(s.fGHz[0]).toBe(1);
    expect(db(magnitude(s, 1, 0, 0))).toBeGreaterThan(-1);
    expect(db(magnitude(s, 0, 0, 0))).toBeLessThan(-12);
  });

  it('matches the full S-matrix to a few % when only one port is excited', () => {
    const column = scatteringMatrix([{ activePort: 0, samples: runs[0] }], [50, 50], exc);
    expect(column.method).toBe('matched_loads');
    expect(column.re[0][1]).toBeNull();
    expect(column.maxPassiveIncidentRatio).toBeGreaterThan(0);
    expect(column.maxPassiveIncidentRatio).toBeLessThan(0.1);
    for (let m = 0; m < s.fGHz.length; m++) {
      for (const i of [0, 1]) {
        expect(Math.hypot(column.re[i][0]![m] - s.re[i][0]![m], column.im[i][0]![m] - s.im[i][0]![m])).toBeLessThan(0.05);
      }
    }
  });

  it('refuses an active port the model does not have', () => {
    expect(() => new CpuFdtd(model).run(exc, { ...control, maxSteps: 1 }, undefined, 2)).toThrow(/active port 2 does not exist; the model has 2 port\(s\)/);
  });
});

describe('multiport project validation', () => {
  it('rasterises every port', () => {
    const { model } = rasterise(parseProject(twoPortLineJson()));
    expect(model.ports.map((p) => [p.i, p.j, p.cells])).toEqual([[12, 8, 1], [12, 22, 1]]);
  });

  it.each([
    ['no ports', (j: any) => { j.ports = []; }, /\$\.ports: needs at least one port/],
    ['a duplicate port id', (j: any) => { j.ports[1].id = 'p1'; }, /\$\.ports\[1\]\.id: duplicate port id "p1"/],
    ['an unknown port in excite', (j: any) => { j.analysis.excite = ['p3']; }, /\$\.analysis\.excite\[0\]: "p3" is not a port id \(ports: p1, p2\)/],
    ['a port listed twice in excite', (j: any) => { j.analysis.excite = ['p2', 'p2']; }, /\$\.analysis\.excite\[1\]: port "p2" is listed twice/],
    ['an empty excite', (j: any) => { j.analysis.excite = []; }, /\$\.analysis\.excite: names no port/],
  ])('refuses %s', (_, mutate, message) => {
    const json = twoPortLineJson();
    mutate(json);
    expect(() => parseProject(json)).toThrow(message);
  });

  it('refuses two ports on one grid node', () => {
    const json = twoPortLineJson();
    json.ports[1].y = '-half_len';
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.ports\[1\]: port "p2" is on the same grid node \(12,8\) as port "p1"/);
  });

  it('refuses two ports that snap to one node', () => {
    const json = twoPortLineJson();
    json.ports[0].y = '-6 mm';
    json.ports[1].y = '-6.2 mm';
    expect(() => rasterise(parseProject(json))).toThrow(/port "p2" is on the same grid node \(12,9\) as port "p1"/);
  });

  it('names the port in per-port copper errors', () => {
    const json = twoPortLineJson();
    json.ports[1].x = '2.5 mm';
    expect(() => rasterise(parseProject(json))).toThrow(/\$\.ports\[1\]: port "p2" node \(\d+,\d+\) is not on copper of layer "top"/);
  });
});

describe('Touchstone v1 layout', () => {
  /** S_ij = i + j/10 at one frequency, so every position is recognisable. */
  const synthetic = (n: number): ScatteringResult => ({
    fGHz: Float64Array.of(2),
    re: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (__, j) => Float64Array.of(i + 1 + (j + 1) / 10))),
    im: Array.from({ length: n }, () => Array.from({ length: n }, () => Float64Array.of(0))),
    method: 'full',
    maxPassiveIncidentRatio: 0,
  });
  const values = (line: string) => line.trim().split(' ').map(Number).filter((_, k) => k % 2 === 0);

  it('writes two ports as S11 S21 S12 S22 on one line', () => {
    const [line] = touchstoneLines(synthetic(2));
    const fields = line.split(' ').map(Number);
    expect(fields[0]).toBe(2);
    expect(fields.slice(1).filter((_, k) => k % 2 === 0)).toEqual([1.1, 2.1, 1.2, 2.2]);
  });

  it('writes three ports as one matrix row per line', () => {
    const lines = touchstoneLines(synthetic(3))[0].split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0].split(' ').map(Number)[0]).toBe(2);
    expect(values(lines[0].slice(lines[0].indexOf(' ')))).toEqual([1.1, 1.2, 1.3]);
    expect(values(lines[2])).toEqual([3.1, 3.2, 3.3]);
  });

  it('wraps rows of more than four ports after four pairs', () => {
    const lines = touchstoneLines(synthetic(5))[0].split('\n');
    expect(lines).toHaveLength(10);
    expect(values(lines[0].slice(lines[0].indexOf(' ')))).toEqual([1.1, 1.2, 1.3, 1.4]);
    expect(values(lines[1])).toEqual([1.5]);
    expect(values(lines[9])).toEqual([5.5]);
  });
});

describe('noburf CLI with two ports', () => {
  const runCli = (...args: string[]) => spawnSync('npx', ['tsx', 'scripts/noburf.ts', ...args], { encoding: 'utf8' });
  const solve = (json: Record<string, any>) => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-multiport-'));
    writeFileSync(join(dir, 'p.json'), JSON.stringify(json));
    // The mesh check has its own tests (verify.test.ts, noburf_cli.test.ts); the expected values are the CPU reference's.
    return { dir, run: runCli('solve', join(dir, 'p.json'), '--out', join(dir, 'out'), '--mesh-check', 'off', '--cpu') };
  };

  it('writes sparams.s2p and the S summary', () => {
    const { dir, run } = solve(twoPortLineJson());
    expect(notEnvelope(run.stderr.split('\n'))).toEqual([]);
    expect(run.status).toBe(0);
    const lines = readFileSync(join(dir, 'out', 'sparams.s2p'), 'utf8').trim().split('\n');
    expect(lines[0]).toMatch(/^! NobuRF two-port-line: ports 1 "p1", 2 "p2"; \d+ \+ \d+ steps$/);
    expect(lines[1]).toBe('# GHz S RI R 50');
    const rows = lines.slice(2).map((line) => line.split(' ').map(Number));
    expect(rows).toHaveLength(19);
    for (const row of rows) {
      expect(row).toHaveLength(9);
      // S21 = S12, up to the tails the two energy-stopped runs leave
      expect(Math.hypot(row[3] - row[5], row[4] - row[6])).toBeLessThan(5e-3);
    }
    // Both runs to the same step (a stop level never reached): S21 = S12 to float32 rounding, as written to the file.
    const fixed = twoPortLineJson();
    fixed.analysis.stop = { energy_decay_db: 200, max_steps: 700 };
    const same = solve(fixed);
    expect(same.run.status).toBe(0);
    expect(same.run.stderr).toMatch(/results are approximate/);
    const sameRows = readFileSync(join(same.dir, 'out', 'sparams.s2p'), 'utf8').trim().split('\n').slice(2).map((line) => line.split(' ').map(Number));
    for (const row of sameRows) expect(Math.hypot(row[3] - row[5], row[4] - row[6])).toBeLessThan(1e-5);
    expect(existsSync(join(dir, 'out', 's11.s1p'))).toBe(false);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.ports.map((p: any) => [p.id, p.z0_ohm, p.excited])).toEqual([['p1', 50, true], ['p2', 50, true]]);
    expect(result.s_parameters).toMatchObject({ file: 'sparams.s2p', method: 'full' });
    expect(result.s_parameters.summary.map((r: any) => r.s)).toEqual(['S11', 'S21', 'S12', 'S22']);
    expect(result.runs.map((r: any) => r.excited_port)).toEqual(['p1', 'p2']);
    expect(result.runs[0].zin).toHaveLength(1);
    expect(result.provenance.excited_ports).toEqual(['p1', 'p2']);
    expect(notEnvelope(result.provenance.warnings)).toEqual([]);
  });

  it('excites only the listed ports and writes no Touchstone file for a partial matrix', () => {
    const json = twoPortLineJson();
    json.analysis.excite = ['p2'];
    const { dir, run } = solve(json);
    expect(run.status).toBe(0);
    expect(existsSync(join(dir, 'out', 'sparams.s2p'))).toBe(false);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.s_parameters).toMatchObject({ file: null, method: 'matched_loads' });
    expect(result.s_parameters.summary.map((r: any) => r.s)).toEqual(['S12', 'S22']);
    expect(result.provenance.excited_ports).toEqual(['p2']);
    expect(notEnvelope(result.provenance.warnings)[0]).toMatch(/^sparams\.s2p not written: only ports p2 were excited/);
  });

  it('refuses ports with different reference impedances', () => {
    const json = twoPortLineJson();
    json.ports[1].reference_impedance_ohm = 75;
    const { run } = solve(json);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/ports have different reference impedances \(50, 75 ohm\); the s2p file needs one/);
  });

  it('keeps the one-port bundle and records the excited port', () => {
    const { dir, run } = solve({ ...smallProjectJson(), analysis: { ...smallProjectJson().analysis, stop: { energy_decay_db: 30, max_steps: 100 } } });
    expect(run.status).toBe(0);
    expect(existsSync(join(dir, 'out', 's11.s1p'))).toBe(true);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.provenance.excited_ports).toEqual(['p1']);
    expect(result.ports).toEqual([{ id: 'p1', z0_ohm: 50, node: { i: expect.any(Number), j: expect.any(Number) }, excited: true }]);
  });
});
