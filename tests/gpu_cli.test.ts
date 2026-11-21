/**
 * The noburf CLI on the GPU (Dawn, headless) against the CPU reference, on
 * projects whose PML differs per face. Needs a WebGPU adapter: a GPU driver,
 * or a software one such as VK_ICD_FILENAMES=/opt/lavapipe/lvp_icd.json.
 * Without an adapter the test is reported as skipped, never as passed.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { smallProjectJson } from './project_fixtures';

function solve(projectPath: string, outDir: string, gpu: boolean) {
  const args = ['--import', 'tsx', '--import', './src/node/register_raw_imports.mjs', 'scripts/noburf.ts', 'solve', projectPath, '--out', outDir];
  args.push(gpu ? '--gpu' : '--cpu');
  return spawnSync('node', args, { encoding: 'utf8' });
}

const NO_ADAPTER = /found no WebGPU adapter|Cannot find (module|package) 'webgpu'/;

const cases: Array<[name: string, edit: (json: Record<string, any>) => void]> = [
  ['a pec floor and 6-cell PML elsewhere', () => {}],
  ['a thicker PML on one face', (json) => { json.boundaries.y_min = { type: 'pml', cells: 9 }; }],
];

describe('noburf --gpu matches the CPU reference', () => {
  for (const [name, edit] of cases) it(name, (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-gpu-'));
    const json = smallProjectJson();
    edit(json);
    const projectPath = join(dir, 'project.json');
    writeFileSync(projectPath, JSON.stringify(json));

    const gpu = solve(projectPath, join(dir, 'gpu'), true);
    if (gpu.status !== 0 && NO_ADAPTER.test(gpu.stderr)) ctx.skip();
    expect(gpu.stderr).not.toMatch(/error/i);
    expect(gpu.status).toBe(0);
    const cpu = solve(projectPath, join(dir, 'cpu'), false);
    expect(cpu.status).toBe(0);

    const read = (sub: string) => JSON.parse(readFileSync(join(dir, sub, 'result.json'), 'utf8'));
    const g = read('gpu');
    const c = read('cpu');
    expect(g.provenance.solver).toMatch(/\(WGSL on /);
    expect(g.provenance.mesh).toEqual(c.provenance.mesh);
    // The GPU sums the energy in float32, so the stop may land one check (100 steps) apart.
    expect(Math.abs(g.steps - c.steps)).toBeLessThanOrEqual(100);
    expect(g.stopped_on_energy).toBe(true);
    expect(g.f0_ghz).toBe(c.f0_ghz);
    expect(g.s11_min_db).toBeCloseTo(c.s11_min_db, 2);
    expect(g.zin[0].re_ohm).toBeCloseTo(c.zin[0].re_ohm, 1);
    expect(g.zin[0].im_ohm).toBeCloseTo(c.zin[0].im_ohm, 1);
  });

  it('far_field.json', (ctx) => {
    const dir = mkdtempSync(join(tmpdir(), 'noburf-gpu-'));
    const json = smallProjectJson();
    json.boundaries.z_min = { type: 'pml', cells: 6 };
    json.mesh.air_margin_cells = { xy: 4, below: 4, above: 4 };
    json.outputs.far_field_ghz = [10];
    const projectPath = join(dir, 'project.json');
    writeFileSync(projectPath, JSON.stringify(json));

    const gpu = solve(projectPath, join(dir, 'gpu'), true);
    if (gpu.status !== 0 && NO_ADAPTER.test(gpu.stderr)) ctx.skip();
    expect(gpu.status).toBe(0);
    const cpu = solve(projectPath, join(dir, 'cpu'), false);
    expect(cpu.status).toBe(0);

    const read = (sub: string) => JSON.parse(readFileSync(join(dir, sub, 'far_field.json'), 'utf8')).frequencies[0];
    const g = read('gpu');
    const c = read('cpu');
    expect(g.peak_theta_deg).toBe(c.peak_theta_deg);
    // The energy stop may land one check apart (see above), which shifts the DFT window slightly.
    expect(g.peak_directivity_dbi).toBeCloseTo(c.peak_directivity_dbi, 1);
    expect(g.efficiency).toBeCloseTo(c.efficiency, 2);
  });
});
