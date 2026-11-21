/**
 * Kernel benchmark of the WGSL kernels as they ship: the real Fdtd3D engine,
 * driven headless through Dawn, on the shared problem of bench_problem.ts.
 * Per step the engine dispatches update_h, update_e and the (empty, 1-workgroup)
 * port pass; with pmlCells 0 there are no CPML passes.
 *
 * Usage: npm run bench:wgsl -- [--grids 64x64x48,128x128x96] [--seconds 3]
 */
import { parseArgs } from 'node:util';
import { DEFAULT_EXCITATION } from '../../src/engine/config';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { Fdtd3D } from '../../src/engine/fdtd3d';
import {
  BENCH_GRID_SIZES, CORRECTNESS_STEPS, benchGrid, benchInitialE, benchModel, checksum, maxRelativeDifference,
} from './bench_problem';
import { createNodeGpuDevice } from '../../src/node/gpu_device';

/**
 * Bytes per cell-update the two WGSL kernels must move at best (every array
 * element read or written once from DRAM, neighbours served by cache):
 * update_h reads e (12) and reads+writes h (24); update_e reads h (12),
 * reads+writes e (24), reads eDecay and eCurl (24). Kappa arrays are O(n), not O(N).
 */
const WGSL_BYTES_PER_CELL_UPDATE = 96;
/** Correctness bar: float32 rounding differences only (GPU fma vs CPU double). */
const CORRECTNESS_TOLERANCE = 1e-4;

const { values } = parseArgs({
  options: {
    grids: { type: 'string', default: BENCH_GRID_SIZES.map((s) => s.join('x')).join(',') },
    seconds: { type: 'string', default: '3' },
  },
});
const gridSizes = values.grids.split(',').map((text) => {
  const dims = text.split('x').map(Number);
  if (dims.length !== 3 || dims.some((d) => !Number.isInteger(d) || d < 4)) throw new Error(`bad grid "${text}", expected e.g. 64x64x48`);
  return dims as [number, number, number];
});
const targetSeconds = Number(values.seconds);

const { device, adapterName } = await createNodeGpuDevice();
console.log(`adapter: ${adapterName}`);
console.log(`GB/s counts ${WGSL_BYTES_PER_CELL_UPDATE} B per cell-update; maxRelDiff is E after ${CORRECTNESS_STEPS} steps vs the CPU reference`);
console.log(['grid', 'cells', 'steps', 'Mcells/s', 'GB/s', 'maxRelDiff', 'cpuChecksumE'].join('\t'));
let allCorrect = true;

for (const [nx, ny, nz] of gridSizes) {
  const grid = benchGrid(nx, ny, nz);
  const cells = nx * ny * nz;
  // Fdtd3D binds each field (3N floats) as one storage buffer. Software
  // adapters cap that at 128 MiB (N <= 11.2M); report the row instead of
  // letting bind-group validation kill the whole run.
  const fieldBytes = 3 * cells * 4;
  if (fieldBytes > device.limits.maxStorageBufferBindingSize) {
    console.log(`${nx}x${ny}x${nz}\t${cells}\tNOT RUN: one field buffer is ${fieldBytes} B, adapter maxStorageBufferBindingSize is ${device.limits.maxStorageBufferBindingSize} B`);
    continue;
  }
  const model = benchModel(grid);
  const e0 = benchInitialE(cells);
  const engine = new Fdtd3D(device, grid, 16, adapterName);
  engine.load(model, DEFAULT_EXCITATION);

  await engine.runFromState(e0, CORRECTNESS_STEPS);
  const gpuE = await engine.readE();
  const cpu = new CpuFdtd(model);
  cpu.e.set(e0);
  for (let n = 0; n < CORRECTNESS_STEPS; n++) {
    cpu.updateH();
    cpu.updateE();
  }
  const relDiff = maxRelativeDifference(gpuE, cpu.e);
  allCorrect &&= relDiff < CORRECTNESS_TOLERANCE;

  // runFromState also clears h and uploads e; time that alone (0 steps) and subtract it.
  const elapsedMs = async (steps: number) => {
    const t0 = performance.now();
    await engine.runFromState(e0, steps);
    return performance.now() - t0;
  };
  const setupMs = await elapsedMs(0);
  // The probe only sizes the timed run. Setup is not subtracted here: on big
  // grids it is as large as 10 steps, and the noisy difference could reach the
  // floor and push the run to the 5000-step cap. Overestimating is harmless.
  const probeSteps = 10;
  const probeMsPerStep = (await elapsedMs(probeSteps)) / probeSteps;
  const steps = Math.max(20, Math.min(5000, Math.round((targetSeconds * 1000) / probeMsPerStep)));
  const runMs = (await elapsedMs(steps)) - setupMs;
  engine.destroy();

  const mcellsPerSec = (cells * steps) / (runMs * 1e3);
  const gbPerSec = (mcellsPerSec * WGSL_BYTES_PER_CELL_UPDATE) / 1e3;
  const row = [`${nx}x${ny}x${nz}`, cells, steps, mcellsPerSec.toFixed(1), gbPerSec.toFixed(1), relDiff.toExponential(2), checksum(cpu.e).toPrecision(10)];
  console.log(row.join('\t'));
}
device.destroy();
if (!allCorrect) {
  console.error(`FAIL: GPU differs from the CPU reference by more than ${CORRECTNESS_TOLERANCE}`);
  process.exit(1);
}
