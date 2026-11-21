import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { zinPoints } from '../scripts/noburf';
import { deembedLineJson, smallProjectJson } from './project_fixtures';

function runCliAsGiven(...args: string[]) {
  return spawnSync('npx', ['tsx', 'scripts/noburf.ts', ...args], { encoding: 'utf8' });
}

/** The golden values below are the CPU reference's, so every solve here asks for it (the CLI's default is the GPU). */
const runCli = (...args: string[]) => runCliAsGiven(...args, ...(args[0] === 'solve' ? ['--cpu'] : []));

/** Most tests here are about one output, so they skip the mesh check: 1.3 solves each. */
const solveCli = (path: string, ...args: string[]) => runCli('solve', path, '--mesh-check', 'off', ...args);

/**
 * The small fixture is 1 mm FR-4 up to 16 GHz: 0.112 wavelengths thick, just
 * past the validated 0.11, and 8.9 cells per wavelength in the FR-4, just
 * under 10, so every solve of it warns about both. Tests of other warnings
 * leave these out.
 */
const FIXTURE_WARNING = /^(warning: )?(outside the validated range: |layer "core": 8\.9 cells per wavelength)/;
const otherWarnings = (lines: string[]) => lines.filter((l) => l && !FIXTURE_WARNING.test(l));
const otherStderr = (stderr: string) => otherWarnings(stderr.split('\n')).join('\n');

describe('noburf CLI', () => {
  it('reports a non-finite Z_in as a string and a warning, never as null', () => {
    const spec = { fGHz: Float64Array.of(1, 2), zRe: Float64Array.of(Infinity, Infinity), zIm: Float64Array.of(0, 0), s11Db: Float64Array.of(0, 0), residual: 0 };
    const warnings: string[] = [];
    expect(zinPoints(spec, [1], warnings)).toEqual([{ f_ghz: 1, re_ohm: 'Infinity', im_ohm: 0 }]);
    expect(warnings).toEqual(['Z_in at 1 GHz is not finite (Infinity, 0): the port sees an open circuit']);
  });

  it('solves a small project and writes the results bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const projectPath = join(dir, 'small.json');
    const text = JSON.stringify(smallProjectJson(), null, 2);
    writeFileSync(projectPath, text);

    const run = solveCli(projectPath, '--out', join(dir, 'out'));
    expect(otherStderr(run.stderr)).toBe('');
    expect(run.status).toBe(0);

    const touchstone = readFileSync(join(dir, 'out', 's11.s1p'), 'utf8').trim().split('\n');
    expect(touchstone[1]).toBe('# GHz S RI R 50');
    const rows = touchstone.slice(2).map((line) => line.split(' ').map(Number));
    expect(rows).toHaveLength(41);
    expect(rows[0][0]).toBe(8);
    expect(rows[40][0]).toBe(16);
    for (const [, re, im] of rows) expect(Math.hypot(re, im)).toBeLessThanOrEqual(1 + 1e-6); // passive

    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    // Golden values from the CPU reference (Nov 2026). A change here is a
    // change in the physics or the post-processing and needs a reason.
    // Nov 20: the energy stop weighs eps_r and cell volume. The FR-4 now counts
    // fully in the peak, so this run reaches its 30 dB at 500 steps instead of
    // 600: the same stop level is less conservative here, and s11_min moves from
    // -3.0039 to -3.2124 dB (Z at 12 GHz was 4.4443 + j23.1345 ohm).
    expect(result.f0_ghz).toBe(9.8);
    expect(result.s11_min_db).toBeCloseTo(-3.2124, 3);
    expect(result.zin).toHaveLength(1);
    expect(result.zin[0].f_ghz).toBe(12);
    expect(result.zin[0].re_ohm).toBeCloseTo(4.2979, 3);
    expect(result.zin[0].im_ohm).toBeCloseTo(22.8301, 3);
    expect(result.steps).toBe(500);
    expect(result.stopped_on_energy).toBe(true);
    expect(result.energy_decay_db).toBeGreaterThanOrEqual(30);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(result.provenance).toMatchObject({
      noburf_project: 1,
      project_sha256: createHash('sha256').update(text).digest('hex'),
      mesh: { nx: 26, ny: 26, nz: 15, dx_mm: 1 },
      solver: `noburf ${pkg.version} (CPU reference)`,
      git_commit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      tracked_files_modified: spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim() !== '',
      excitation: { fMinGHz: 8, fMaxGHz: 16, nFreq: 41, z0: 50 },
      run_control: { maxSteps: 3000, stopAtEnergyDecayDb: 30, energyCheckEverySteps: 100 },
    });
    expect(result.provenance.mesh.courant).toBeCloseTo(0.99 / Math.sqrt(3), 12);
    expect(result.provenance.mesh.signature).toMatch(/^[0-9a-f]{16}$/);
    expect(otherWarnings(result.provenance.warnings)).toEqual([]);
  });

  it('writes far_field.json when the project asks for a far field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const json = smallProjectJson();
    json.boundaries.z_min = { type: 'pml', cells: 6 };
    json.mesh.air_margin_cells = { xy: 4, below: 4, above: 4 };
    json.outputs.far_field_ghz = [10, 12];
    writeFileSync(join(dir, 'p.json'), JSON.stringify(json));
    const run = solveCli(join(dir, 'p.json'), '--out', join(dir, 'out'));
    expect(otherStderr(run.stderr)).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/far field 10 GHz: D [\d.]+ dBi/);
    const farField = JSON.parse(readFileSync(join(dir, 'out', 'far_field.json'), 'utf8'));
    expect(farField.project).toBe('small-patch');
    expect(farField.huygens_box).toMatchObject({ lo_node: [8, 8, 8], size_mm: [13, 13, 4] });
    expect(farField.frequencies.map((f: { f_ghz: number }) => f.f_ghz)).toEqual([10, 12]);
    for (const f of farField.frequencies) {
      expect(f.pattern.theta_deg).toHaveLength(37);
      expect(f.pattern.phi_deg).toHaveLength(72);
      expect(f.pattern.directivity_dbi).toHaveLength(37);
      expect(f.pattern.directivity_dbi[0]).toHaveLength(72);
      expect(f.pattern.r_e_theta_v.re).toHaveLength(37);
      // A small patch on lossy FR-4: radiates upward, loses part of the accepted power in the dielectric.
      expect(f.peak_theta_deg).toBeLessThanOrEqual(45);
      expect(f.peak_directivity_dbi).toBeGreaterThan(3);
      expect(f.efficiency).toBeGreaterThan(0.05);
      expect(f.efficiency).toBeLessThan(1);
      expect(f.radiated_power_w).toBeLessThan(f.accepted_power_w);
      expect(Math.abs(f.sphere_to_box_power_ratio - 1)).toBeLessThan(0.03);
      expect(f.peak_gain_dbi).toBeCloseTo(f.peak_directivity_dbi + 10 * Math.log10(f.efficiency), 3);
      // The patch is resonant along y (L along y): E-plane at phi = 90, little cross-polar on boresight.
      expect(f.boresight_polarisation).toBe('y');
      expect(f.e_plane_phi_deg).toBe(90);
      expect(f.boresight_cross_polar_db).toBeLessThan(-20);
      expect(f.beamwidth_e_plane_deg).toBeGreaterThan(40);
      expect(f.beamwidth_h_plane_deg).toBeGreaterThan(40);
      expect(readFileSync(join(dir, 'out', `pattern_${f.f_ghz}ghz.svg`), 'utf8')).toMatch(/^<svg [^>]*>[\s\S]*E-plane \(φ = 90°\)[\s\S]*<\/svg>\n$/);
      expect(readFileSync(join(dir, 'out', `pattern_${f.f_ghz}ghz.glb`)).readUInt32LE(0)).toBe(0x46546c67);
    }
    expect(run.stdout).toMatch(/patterns: pattern_10ghz.svg, pattern_10ghz.glb, pattern_12ghz.svg, pattern_12ghz.glb/);
  });

  it('flags efficiency and gain as approximate when the run stops before ringing down', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const json = smallProjectJson();
    json.boundaries.z_min = { type: 'pml', cells: 6 };
    json.mesh.air_margin_cells = { xy: 4, below: 4, above: 4 };
    json.outputs.far_field_ghz = [12];
    json.analysis.stop = { energy_decay_db: 30, max_steps: 300 };
    writeFileSync(join(dir, 'p.json'), JSON.stringify(json));
    const run = solveCli(join(dir, 'p.json'), '--out', join(dir, 'out'));
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/warning: far field: the run stopped before the field rang down .*efficiency and gain are approximate/);
    const farField = JSON.parse(readFileSync(join(dir, 'out', 'far_field.json'), 'utf8'));
    expect(farField.caveat).toMatch(/efficiency and gain are approximate/);
  });

  it('marks a decay reached on the last allowed step as reached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const json = smallProjectJson();
    json.analysis.stop.max_steps = 500; // the small project reaches 30 dB at exactly 500 steps
    writeFileSync(join(dir, 'p.json'), JSON.stringify(json));
    const run = solveCli(join(dir, 'p.json'), '--out', join(dir, 'out'));
    expect(run.status).toBe(0);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.steps).toBe(500);
    expect(result.stopped_on_energy).toBe(true);
    expect(otherWarnings(result.provenance.warnings)).toEqual([]);
  });

  it('says when no energy check ran instead of reporting NaN dB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const json = smallProjectJson();
    json.analysis.stop.max_steps = 50;
    writeFileSync(join(dir, 'p.json'), JSON.stringify(json));
    const run = solveCli(join(dir, 'p.json'), '--out', join(dir, 'out'));
    expect(run.status).toBe(0);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.stopped_on_energy).toBe(false);
    expect(otherWarnings(result.provenance.warnings)).toEqual(['no energy check ran within 50 steps (one runs every 100); results are approximate']);
  });

  it('puts an error bar, physics checks and the validated envelope in result.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const json = smallProjectJson();
    json.mesh.graded = { edge_cell: '0.5 mm', dielectric_cells: 4, max_growth: 1.4 };
    writeFileSync(join(dir, 'p.json'), JSON.stringify(json));
    const run = runCli('solve', join(dir, 'p.json'), '--out', join(dir, 'out'), '--mesh-check', 'check');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/mesh check over 2 meshes \(mesh discretisation uncertainty only[^)]*\): f_res [\d.]+ GHz \+\/- [\d.]+ %/);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    const c = result.self_check.mesh_convergence;
    expect(c.levels.map((l: { scale: number }) => l.scale)).toEqual([1, 0.707107]);
    expect(c.levels[1].f_res_ghz).toBeCloseTo(c.f_res_ghz.value, 4); // the result is the finer mesh's
    expect(c.f_res_ghz).toMatchObject({ behaviour: 'two-level', order: 1 });
    expect(c.scope).toMatch(/excludes port and material model error/);
    expect(c.f_res_ghz.uncertainty).toBeGreaterThan(0);
    expect(result.self_check.checks.map((x: { name: string }) => x.name)).toEqual(['passivity', 'energy_decay']);
    expect(result.self_check.validated_envelope.filter((x: { inside: boolean }) => !x.inside).map((x: { parameter: string }) => x.parameter))
      .toEqual(['eps_r of "core"', 'thickness of "core" in wavelengths at 16 GHz', 'band (GHz)']);
  }, 60_000); // two graded solves; the uniform cells held around copper edges about double their cells

  it('runs no mesh check unless asked: it is opt-in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    writeFileSync(join(dir, 'p.json'), JSON.stringify(smallProjectJson()));
    const run = runCli('solve', join(dir, 'p.json'), '--out', join(dir, 'out'));
    expect(run.status).toBe(0);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.self_check.mesh_convergence).toEqual({ mode: 'off', unavailable: 'off' });
    expect(result.self_check.checks.length).toBeGreaterThan(0); // the free checks still run
  });

  it('says why a uniform mesh gets no error bar, and still solves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    writeFileSync(join(dir, 'p.json'), JSON.stringify(smallProjectJson()));
    const run = runCli('solve', join(dir, 'p.json'), '--out', join(dir, 'out'), '--mesh-check', 'check');
    expect(run.status).toBe(0);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.self_check.mesh_convergence.unavailable).toMatch(/uniform mesh rounds each layer to whole cells/);
    expect(otherWarnings(result.provenance.warnings)[0]).toMatch(/^no mesh error bar: a uniform mesh/);
  });

  it('de-embeds the feeds, writes the raw S beside the result and says what it removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    writeFileSync(join(dir, 'line.json'), JSON.stringify(deembedLineJson()));
    const run = solveCli(join(dir, 'line.json'), '--out', join(dir, 'out'));
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/de-embedded "p2": 3 mm of line, .*\(kit of "p1"\)/);
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    expect(result.deembedding.raw_file).toBe('sparams.raw.s2p');
    expect(result.deembedding.ports.map((p: any) => p.port)).toEqual(['p1', 'p2']);
    const rows = (name: string) => readFileSync(join(dir, 'out', name), 'utf8').trim().split('\n').filter((l) => !l.startsWith('!') && !l.startsWith('#'));
    expect(rows('sparams.raw.s2p')).toHaveLength(rows('sparams.s2p').length);
    expect(rows('sparams.raw.s2p')[5]).not.toBe(rows('sparams.s2p')[5]);
  });

  it('refuses de-embedding without the full S-matrix before it solves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const json = deembedLineJson();
    json.analysis.excite = ['p1'];
    writeFileSync(join(dir, 'line.json'), JSON.stringify(json));
    const run = solveCli(join(dir, 'line.json'), '--out', join(dir, 'out'));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/\$\.analysis\.excite: de-embedding needs the full S-matrix/);
    expect(run.stdout).not.toMatch(/steps/);
  });

  it('fails with the JSON path of a bad project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    const json = smallProjectJson();
    json.mesh.cell = 1;
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(json));
    const run = runCli('solve', join(dir, 'bad.json'));
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/\$\.mesh\.cell: bare number 1 is not a length/);
  });
});

describe('noburf CLI solver choice', () => {
  // Run without the ?raw import hooks (npx tsx, not the npm script), so the
  // WGSL never loads: the GPU solver is unavailable on every machine.
  const smallProjectPath = () => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-cli-'));
    writeFileSync(join(dir, 'p.json'), JSON.stringify(smallProjectJson()));
    return dir;
  };

  it('falls back to the CPU reference with a notice when the GPU solver cannot load', () => {
    const dir = smallProjectPath();
    const run = runCliAsGiven('solve', join(dir, 'p.json'), '--out', join(dir, 'out'), '--mesh-check', 'off');
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/^notice: solving on the CPU reference, which is much slower, because the GPU solver is unavailable: its WGSL shaders need the import hooks that `npm run noburf` loads$/m);
    expect(run.stdout).toMatch(/^solver: CPU reference \(no GPU\)$/m);
    expect(JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8')).provenance.solver).toMatch(/\(CPU reference\)$/);
  });

  it('fails before meshing when --gpu is given and the GPU solver cannot load', () => {
    const dir = smallProjectPath();
    const run = runCliAsGiven('solve', join(dir, 'p.json'), '--out', join(dir, 'out'), '--gpu');
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^--gpu: its WGSL shaders need the import hooks that `npm run noburf` loads$/m);
    expect(run.stdout).not.toMatch(/cells/);
  });

  it('says it uses the CPU reference with --cpu and runs no GPU check', () => {
    const dir = smallProjectPath();
    const run = runCliAsGiven('solve', join(dir, 'p.json'), '--out', join(dir, 'out'), '--mesh-check', 'off', '--cpu');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^solver: CPU reference \(--cpu\)$/m);
    expect(run.stderr).not.toMatch(/notice:/);
  });

  it('rejects --gpu together with --cpu', () => {
    const run = runCliAsGiven('solve', join(smallProjectPath(), 'p.json'), '--gpu', '--cpu');
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^usage: noburf solve <project\.json> \[--gpu \| --cpu\]/);
  });
});
