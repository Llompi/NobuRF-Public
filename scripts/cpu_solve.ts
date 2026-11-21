/**
 * Run the CPU reference solver on the default demo grid and print telemetry.
 * Slow (tens of seconds) but needs no GPU: useful to sanity-check physics or
 * a geometry change from the terminal.
 *   npx tsx scripts/cpu_solve.ts '{"inset_depth_mm":3.5}' [fixed steps; default: energy stop at -50 dB]
 *   npx tsx scripts/cpu_solve.ts '[{"patch_l_mm":11.6},{"inset_depth_mm":3.5}]'   # edits applied in order
 */
import { DEFAULT_EXCITATION, DEFAULT_GRID, ENERGY_STOP_RUN } from '../src/engine/config';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { applyEdit, baselineGeometry } from '../src/engine/geometry';
import { portSpectrum } from '../src/engine/port_dft';
import { buildTelemetry } from '../src/engine/telemetry';
import { voxelize } from '../src/engine/voxelize';

const edit = process.argv[2] ? JSON.parse(process.argv[2]) : null;
const control = process.argv[3]
  ? { maxSteps: Number(process.argv[3]), stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 }
  : ENERGY_STOP_RUN;
const edits = edit ? (Array.isArray(edit) ? edit : [edit]) : [];
const g = edits.reduce((acc, e) => applyEdit(acc, e), baselineGeometry());
const model = voxelize(g, DEFAULT_GRID, DEFAULT_EXCITATION.z0);
const t0 = performance.now();
const samples = new CpuFdtd(model).run(DEFAULT_EXCITATION, control);
const ms = performance.now() - t0;
const spec = portSpectrum(samples, DEFAULT_EXCITATION);
console.log(JSON.stringify(buildTelemetry({ spec, targetGHz: g.target_ghz, it: 0, solveMs: ms, steps: samples.v.length })));
console.log(`energy decay ${samples.energyDecayDb.toFixed(1)} dB, stopped on energy: ${samples.stoppedOnEnergy}`);
