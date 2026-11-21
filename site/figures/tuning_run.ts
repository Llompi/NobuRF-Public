// S11 spectrum after each edit of the five-edit tuning run (Figure 3 on the landing page).
// Needs the solver from PR #1. From the repo root: npx tsx site/figures/tuning_run.ts site/figures/data/tuning_run_0.5mm.json
// Typed arrays are converted to plain arrays before writing.
import { writeFileSync } from 'node:fs';
import { DEFAULT_EXCITATION, DEFAULT_GRID } from '../../src/engine/config';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { applyEdit, baselineGeometry } from '../../src/engine/geometry';
import { portSpectrum } from '../../src/engine/port_dft';
import { voxelize } from '../../src/engine/voxelize';

const tuningSteps = [
  { label: 'edge-fed start', edit: null },
  { label: 'inset 2.5 mm', edit: { inset_depth_mm: 2.5 } },
  { label: 'inset 3.5 mm', edit: { inset_depth_mm: 3.5 } },
  { label: 'length 11.6 mm', edit: { patch_l_mm: 11.6 } },
  { label: 'inset 3 mm', edit: { inset_depth_mm: 3 } },
  { label: 'trim slot 16 × 0.3 mm', edit: { upsert_feature: { id: 'trim', kind: 'rect_slot', x_mm: 0, y_mm: 5.65, w_mm: 16, h_mm: 0.3 } } },
];
let geometry = baselineGeometry();
const results = [];
for (const step of tuningSteps) {
  if (step.edit) geometry = applyEdit(geometry, step.edit as Parameters<typeof applyEdit>[1]);
  const model = voxelize(geometry, DEFAULT_GRID, DEFAULT_EXCITATION.z0);
  const samples = new CpuFdtd(model).run(DEFAULT_EXCITATION, DEFAULT_GRID.stepsPerRun);
  const spectrum = portSpectrum(samples, DEFAULT_EXCITATION);
  results.push({
    label: step.label,
    geometry: structuredClone(geometry),
    f_ghz: Array.from(spectrum.fGHz, (frequencyGhz) => Number(frequencyGhz.toFixed(4))),
    s11_db: Array.from(spectrum.s11Db, (s11Db) => Number(s11Db.toFixed(3))),
  });
  console.log(step.label, 'done');
}
writeFileSync(process.argv[2], JSON.stringify(results));
