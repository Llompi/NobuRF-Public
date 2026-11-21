/**
 * Check the sensitivity study (src/design/sensitivity.ts) against a slope that
 * is known in closed form: the resonance of a rectangular patch against its
 * length, from the cavity model (Balanis, Antenna Theory, 4th ed., 14.2):
 *
 *   f = c / (2 (L + 2 dL) sqrt(eps_eff)),   so   df/dL = -f / (L + 2 dL),
 *
 * with eps_eff and the fringing extension dL functions of W only. The patch is
 * Chang 1986, 45.5 x 30.5 mm on eps_r 2.33, h 3.175 mm (graded mesh), a
 * measured benchmark the solver matches within 1.2 % (docs/validation.md 7),
 * with its two sizes unlocked to +-20 %. The model's own f is not the
 * solver's, so the slope is compared both as printed and scaled to the
 * solver's resonance, -f0 / (L + 2 dL): the second asks only that the
 * solver's patch behaves like a cavity of the model's effective length.
 *
 * Also run: the same study with twice the default step (a slope that depends on the
 * step is not a slope), and a least-squares line through the solver's own
 * resonances at L +- 1, 3 and 5 steps (the slope the study should find, from
 * mostly independent solves).
 *
 *   node --import tsx --import ./src/node/register_raw_imports.mjs scripts/validate/sensitivity_patch.ts [--gpu]   -> docs/validation/data/sensitivity_patch.json
 *
 * Acceptance (docs/sensitivity.md has the history):
 *   1. df/dL within 10 % of the cavity model's -f0 / (L + 2 dL), solver f0;
 *   2. df/dL at the default step and at twice it agree within 3 %, both graded clean;
 *   3. df/dL within 3 % of the six-point line over +-5 steps;
 *   4. |df/dW| below |df/dL| / 3, same sign as the model.
 * Checks 1 and 4 were fixed before the first run. Checks 2 and 3 were changed
 * after it, on review: the first check 3 (a five-point line over +-2 steps)
 * was algebraically 0.2 x check 2's first slope + 0.8 x its second, so it
 * added no evidence, and check 2's tolerance widened with the spreads.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createEvaluator } from '../../src/design/evaluate';
import { DesignSession, type SensitivityReport } from '../../src/design/session';
import { designFromProject } from '../../src/design/design_file';
import { sensitivityTable } from '../design';

const C_MM_GHZ = 299.792458;
const SOURCE = 'examples/benchmarks/graded/chang1986-45.5x30.5.json';
const EPS_R = 2.33;
const H_MM = 3.175;

/** Cavity-model resonance (GHz) and effective length (mm). */
function cavity(lMm: number, wMm: number): { fGhz: number; lEffMm: number } {
  const epsEff = (EPS_R + 1) / 2 + ((EPS_R - 1) / 2) / Math.sqrt(1 + (12 * H_MM) / wMm);
  const dl = (0.412 * H_MM * (epsEff + 0.3) * (wMm / H_MM + 0.264)) / ((epsEff - 0.258) * (wMm / H_MM + 0.8));
  const lEffMm = lMm + 2 * dl;
  return { fGhz: C_MM_GHZ / (2 * lEffMm * Math.sqrt(epsEff)), lEffMm };
}

/** MHz per mm of the cavity model, by central difference of the closed form (exact to rounding). */
function cavitySlope(l: number, w: number, which: 'l' | 'w'): number {
  const e = 1e-4;
  const f = (dl: number, dw: number) => cavity(l + dl, w + dw).fGhz;
  return (1000 * (which === 'l' ? f(e, 0) - f(-e, 0) : f(0, e) - f(0, -e))) / (2 * e);
}

async function main(): Promise<void> {
  const useGpu = process.argv.includes('--gpu');
  const project = JSON.parse(readFileSync(SOURCE, 'utf8'));
  for (const name of ['patch_l', 'patch_w']) {
    const v = Number.parseFloat(project.variables[name].value);
    project.variables[name] = { value: `${v} mm`, min: `${(0.8 * v).toFixed(2)} mm`, max: `${(1.2 * v).toFixed(2)} mm` };
  }
  const design = designFromProject(project, undefined);
  const evaluator = createEvaluator(design.goal, { useGpu });
  const session = new DesignSession(design, evaluator, { maxSearchSolves: 1000, maxConfirmSolves: 0 });
  const t0 = performance.now();
  const study = (stepPct: number) => session.sensitivity({ rank_by: 'f0_mhz', step_pct: stepPct }, 'search');
  let r2: SensitivityReport, r4: SensitivityReport;
  let line: { slope: number; points: Array<[number, number]> };
  try {
    r2 = await study(2);
    const rowL = r2.rows.find((r) => r.variable.name === 'patch_l')!;
    const h = rowL.h;
    // Twice the step actually taken (the mesh floor may have set it), for patch_l; the base solve is reused.
    r4 = await study((200 * h) / (rowL.variable.max - rowL.variable.min));
    const l0 = session.current.values.patch_l;
    // L +- h, 3h, 5h: the outer four are solves the studies did not make.
    await session.call('sweep', { variable: 'patch_l', from_mm: l0 - 5 * h, to_mm: l0 + 5 * h, points: 6 });
    const points = [-5, -3, -1, 1, 3, 5].map((k) => {
      const x = l0 + k * h;
      // The sweep's reply is rounded; read the unrounded resonance from the session's records.
      const record = session.records.find((r) => r.metrics && Math.abs(r.point.values.patch_l - x) < 1e-9 && Math.abs(r.point.values.patch_w - session.current.values.patch_w) < 1e-9);
      if (!record?.metrics) throw new Error(`no solve at patch_l ${x}`);
      return [x, 1000 * record.metrics.f0_ghz] as [number, number];
    });
    line = { slope: leastSquaresSlope(points), points };
  } finally {
    await evaluator.close();
  }
  const slope = (r: SensitivityReport, name: string) => r.rows.find((row) => row.variable.name === name)!.slopes.f0_mhz!;
  const [l, w] = [session.current.values.patch_l, session.current.values.patch_w];
  const f0 = 1000 * r2.base.metrics!.f0_ghz;
  const model = cavity(l, w);
  const modelScaledL = -f0 / model.lEffMm;
  const sL2 = slope(r2, 'patch_l');
  const sL4 = slope(r4, 'patch_l');
  const sW = slope(r2, 'patch_w');
  const modelW = cavitySlope(l, w, 'w');
  const pct = (a: number, b: number) => (100 * (a - b)) / Math.abs(b);
  const checks = [
    { check: 'df/dL vs cavity model at the solver f0', solver: sL2.perUnit, reference: modelScaledL, off_pct: pct(sL2.perUnit, modelScaledL), pass: Math.abs(pct(sL2.perUnit, modelScaledL)) <= 10 },
    { check: 'df/dL, default step vs twice it, both clean', solver: sL2.perUnit, reference: sL4.perUnit, off_pct: pct(sL2.perUnit, sL4.perUnit),
      pass: Math.abs(pct(sL2.perUnit, sL4.perUnit)) <= 3 && sL2.grade === 'clean' && sL4.grade === 'clean' },
    { check: 'df/dL vs six-point line over +-5 steps', solver: sL2.perUnit, reference: line.slope, off_pct: pct(sL2.perUnit, line.slope), pass: Math.abs(pct(sL2.perUnit, line.slope)) <= 3 },
    { check: '|df/dW| < |df/dL| / 3, sign as the model', solver: sW.perUnit, reference: modelW, off_pct: pct(sW.perUnit, modelW),
      pass: Math.abs(sW.perUnit) < Math.abs(sL2.perUnit) / 3 && Math.sign(sW.perUnit) === Math.sign(modelW) },
  ];
  const result = {
    source: SOURCE,
    solver: useGpu ? 'WGSL (GPU)' : 'CPU reference',
    wall_s: Math.round((performance.now() - t0) / 1000),
    solver_f0_mhz: f0,
    cavity_model: { f_mhz: 1000 * model.fGhz, l_eff_mm: model.lEffMm, df_dl_mhz_per_mm: cavitySlope(l, w, 'l'), df_dl_at_solver_f0: modelScaledL, df_dw_mhz_per_mm: modelW },
    six_point_line: line,
    // Reported, not graded: how much the other metrics' slopes move with the step.
    step_dependence: Object.fromEntries(r2.metrics.map((m) => {
      const [a, b] = [r2.rows.find((r) => r.variable.name === 'patch_l')!.slopes[m.key], r4.rows.find((r) => r.variable.name === 'patch_l')!.slopes[m.key]];
      return [m.key, a && b ? { default_step: a.perUnit, double_step: b.perUnit, grade: [a.grade, b.grade], off_pct: pct(a.perUnit, b.perUnit) } : null];
    })),
    checks,
    study_default_step: r2,
    study_double_step: r4,
  };
  console.log(sensitivityTable(r2));
  console.log(`\nsolver f0 ${f0.toFixed(1)} MHz; cavity model ${(1000 * model.fGhz).toFixed(1)} MHz, L + 2 dL = ${model.lEffMm.toFixed(2)} mm`);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.check}: ${c.solver.toFixed(2)} vs ${c.reference.toFixed(2)} MHz/mm (${c.off_pct.toFixed(1)} %)`);
  mkdirSync('docs/validation/data', { recursive: true });
  writeFileSync('docs/validation/data/sensitivity_patch.json', JSON.stringify(result, null, 2) + '\n');
}

function leastSquaresSlope(points: Array<[number, number]>): number {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  return points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
