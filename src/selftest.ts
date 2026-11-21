/**
 * In-browser verification of the WebGPU kernels against the CPU reference.
 * Open /selftest.html in Chrome, or run `npm run test:gpu` (headless Chromium).
 * Results land in window.__selftest for the Playwright runner.
 */
import { DEFAULT_EXCITATION, DEFAULT_GRID, ENERGY_STOP_RUN } from './engine/config';
import { CpuFdtd, vacuumModel } from './engine/fdtd_cpu';
import { Fdtd3D } from './engine/fdtd3d';
import { baselineGeometry } from './engine/geometry';
import { portSpectrum } from './engine/port_dft';
import { buildTelemetry } from './engine/telemetry';
import type { GridConfig, SimTelemetry } from './engine/types';
import { voxelize } from './engine/voxelize';

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const out = document.getElementById('out')!;
const log = (c: Check) => {
  checks.push(c);
  out.innerHTML = checks.map((x) => `<span class="${x.pass ? 'pass' : 'fail'}">${x.pass ? 'PASS' : 'FAIL'}</span> ${x.name}: ${x.detail}`).join('\n');
};

const smallGrid: GridConfig = { ...DEFAULT_GRID, nx: 32, ny: 32, nz: 32, groundK: 10, stepsPerRun: 1000 };

async function device(): Promise<{ dev: GPUDevice; name: string }> {
  const a = await navigator.gpu.requestAdapter();
  if (!a) throw new Error('no adapter');
  const info = (a as GPUAdapter & { info?: GPUAdapterInfo }).info;
  return { dev: await a.requestDevice(), name: [info?.vendor, info?.architecture].filter(Boolean).join(' ') };
}

function maxAbs(a: Float32Array): number {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}

async function run(): Promise<void> {
  const { dev, name } = await device();
  log({ name: 'adapter', pass: true, detail: name || 'webgpu' });

  // 1. Stability + parity in vacuum with a CPML on every face.
  {
    const g = smallGrid;
    const N = g.nx * g.ny * g.nz;
    const model = vacuumModel(g);
    const e0 = new Float32Array(3 * N);
    // Divergence-free-ish start: a z-directed dipole pair, so nothing static survives.
    e0[2 * N + 16 + 32 * (16 + 32 * 15)] = 1;
    e0[2 * N + 16 + 32 * (16 + 32 * 17)] = -1;
    const gpu = new Fdtd3D(dev, g, 16);
    gpu.load(model, DEFAULT_EXCITATION);
    await gpu.runFromState(e0, 1000);
    const eg = await gpu.readE();
    const cpu = new CpuFdtd(model);
    cpu.e.set(e0);
    for (let n = 0; n < 1000; n++) { cpu.updateH(); cpu.updateE(); }
    let finite = true;
    let diff = 0;
    for (let n = 0; n < eg.length; n++) {
      if (!Number.isFinite(eg[n])) finite = false;
      diff = Math.max(diff, Math.abs(eg[n] - cpu.e[n]));
    }
    const ref = Math.max(maxAbs(cpu.e), 1e-30);
    log({ name: 'stability 1000 steps (GPU)', pass: finite, detail: `finite=${finite}, max|E|=${maxAbs(eg).toExponential(2)} (start 1.0)` });
    log({ name: 'GPU vs CPU vacuum parity', pass: diff / ref < 1e-3 || diff < 1e-6, detail: `max abs diff ${diff.toExponential(2)}, ref ${ref.toExponential(2)}` });
    gpu.destroy();
  }

  // 2. PEC sheet (plan test 2).
  {
    const g = smallGrid;
    const N = g.nx * g.ny * g.nz;
    const model = vacuumModel(g);
    const kz = g.nz / 2;
    for (let c = kz * g.nx * g.ny; c < (kz + 1) * g.nx * g.ny; c++) { model.eCurl[c] = 0; model.eCurl[N + c] = 0; }
    const e0 = new Float32Array(3 * N);
    e0[2 * N + 16 + 32 * (16 + 32 * 9)] = 1;
    e0[2 * N + 16 + 32 * (16 + 32 * 11)] = -1;
    const gpu = new Fdtd3D(dev, g, 16);
    gpu.load(model, DEFAULT_EXCITATION);
    let front = 0, back = 0;
    let e: Float32Array = e0;
    for (let chunk = 0; chunk < 8; chunk++) {
      await gpu.runFromState(e, 50);
      e = await gpu.readE();
      for (let k = 0; k < g.nz; k++) {
        for (let c = k * g.nx * g.ny; c < (k + 1) * g.nx * g.ny; c++) {
          const a = Math.abs(e[c]) + Math.abs(e[N + c]) + Math.abs(e[2 * N + c]);
          if (k < kz - 1) front = Math.max(front, a);
          if (k > kz + 1) back = Math.max(back, a);
        }
      }
    }
    const db = 20 * Math.log10(front / Math.max(back, 1e-30));
    log({ name: 'PEC sheet attenuation (GPU)', pass: db > 40, detail: `${db.toFixed(1)} dB (needs > 40)` });
    gpu.destroy();
  }

  // 3. Full demo grid with lossy FR-4 (tan delta 0.02): port history GPU vs CPU over the first 300 steps.
  const dsl = baselineGeometry();
  const gpu = new Fdtd3D(dev, DEFAULT_GRID, ENERGY_STOP_RUN.maxSteps);
  {
    const lossy = voxelize({ ...dsl, substrate: { ...dsl.substrate, tan_delta: 0.02 } }, DEFAULT_GRID);
    gpu.load(lossy, DEFAULT_EXCITATION);
    const fixed300 = { maxSteps: 300, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
    const short = await gpu.run({ control: fixed300 });
    const ref = new CpuFdtd(lossy).run(DEFAULT_EXCITATION, fixed300);
    let dv = 0;
    for (let n = 0; n < 300; n++) dv = Math.max(dv, Math.abs(short.v[n] - ref.v[n]));
    const rel = dv / Math.max(maxAbs(ref.v), 1e-30);
    log({ name: 'port V(t) GPU vs CPU (300 steps, 196k cells, lossy FR-4)', pass: rel < 1e-3, detail: `relative max diff ${rel.toExponential(2)}` });
  }
  const model = voxelize(dsl, DEFAULT_GRID);
  gpu.load(model, DEFAULT_EXCITATION);

  // 4. Full solve timing + telemetry.
  let telemetry: SimTelemetry | null = null;
  {
    const t0 = performance.now();
    const res = await gpu.run();
    const spec = portSpectrum(res, DEFAULT_EXCITATION);
    telemetry = buildTelemetry({ spec, targetGHz: dsl.target_ghz, it: 0, solveMs: performance.now() - t0, steps: res.v.length });
    const sane = telemetry.s11_min_db < -2 && telemetry.s11_min_db > -15 && telemetry.f0_ghz > 4.8 && telemetry.f0_ghz < 6.2;
    log({ name: 'baseline solve (3000 steps)', pass: sane, detail: `${telemetry.solve_ms} ms, f0 ${telemetry.f0_ghz} GHz, S11min ${telemetry.s11_min_db} dB` });
  }

  // 5. Energy stop on the GPU: ends on a check boundary once the fields are 50 dB down.
  {
    const t0 = performance.now();
    const res = await gpu.run({ control: ENERGY_STOP_RUN });
    const steps = res.v.length;
    const pass = res.stoppedOnEnergy && res.energyDecayDb >= 50 && steps % ENERGY_STOP_RUN.energyCheckEverySteps === 0;
    log({ name: 'energy stop (-50 dB)', pass, detail: `${steps} steps, ${res.energyDecayDb.toFixed(1)} dB, ${Math.round(performance.now() - t0)} ms` });
  }
  gpu.destroy();
  (window as unknown as { __selftest: unknown }).__selftest = { done: true, checks, telemetry };
}

run().catch((e) => {
  log({ name: 'self-test crashed', pass: false, detail: String((e as Error)?.stack ?? e) });
  (window as unknown as { __selftest: unknown }).__selftest = { done: true, checks, error: String(e) };
});
