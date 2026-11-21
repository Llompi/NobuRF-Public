/**
 * The parity checks of src/selftest.ts (checks 1 and 3) plus the strip port, a graded mesh,
 * the far-field box DFT, a two-port line, the coax feed and conformal copper, run on the real
 * Fdtd3D engine in Node through Dawn instead of in a browser tab. These cover
 * every kernel: bulk H/E, CPML on all faces, the port and the energy sum.
 * Each check runs twice: with the device's dispatch width, and with rows of
 * 7 workgroups, so the multi-row dispatch of large grids runs on small ones.
 * Run: npm run test:gpu:node (see bench/README.md).
 */
import { DEFAULT_EXCITATION, DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { addCoaxFeed, coaxCalibrationModel, runCoaxFeed, solvePorts, type CoaxFeed } from '../../src/engine/coax_feed';
import { shortDipoleModel } from '../../src/engine/dipole_model';
import { HuygensDftRecorder, huygensBoxInsidePml, huygensSurface } from '../../src/engine/huygens_box';
import { gradedLines } from '../../src/engine/mesh';
import { PlaneDftRecorder } from '../../src/engine/plane_dft';
import { VolumeDftRecorder } from '../../src/engine/volume_dft';
import { nearToFarField } from '../../src/engine/near_to_far';
import { CpuFdtd, vacuumModel } from '../../src/engine/fdtd_cpu';
import { Fdtd3D, gpuCoaxEngine } from '../../src/engine/fdtd3d';
import { baselineGeometry } from '../../src/engine/geometry';
import type { GridConfig } from '../../src/engine/types';
import { voxelize } from '../../src/engine/voxelize';
import { readFileSync } from 'node:fs';
import { rasterise } from '../../src/project/rasterise';
import { parseProject } from '../../src/project/schema';
import { dispersiveProjectJson, rect, smallProjectJson, smaEdgeLineJson, smaThroughLineJson, twoPortLineJson } from '../../tests/project_fixtures';
import { maxRelativeDifference } from './bench_problem';
import { createNodeGpuDevice } from '../../src/node/gpu_device';
import { CONFORMAL_SOLID_COURANT } from '../../src/engine/conformal';
import { addConformalSolids, ribbonMesh, sphereMesh, tubeMesh } from '../../src/project/conformal_solids';
import { addConformalSheets } from '../../src/project/conformal_sheets';

/** Same tolerance as the browser self-test. */
const PARITY_TOLERANCE = 1e-3;

const { device, adapterName } = await createNodeGpuDevice();
console.log(`adapter: ${adapterName}`);
let allPass = true;
const report = (name: string, pass: boolean, detail: string) => {
  allPass &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
};

const ROW_WIDTHS = [device.limits.maxComputeWorkgroupsPerDimension, 7];

// Check 1: vacuum with a CPML on every face, dipole pair start, 1000 steps.
for (const rowWidth of ROW_WIDTHS) {
  const grid: GridConfig = { ...DEFAULT_GRID, nx: 32, ny: 32, nz: 32, groundK: 10, stepsPerRun: 1000 };
  const steps = 1000;
  const N = grid.nx * grid.ny * grid.nz;
  const model = vacuumModel(grid);
  const e0 = new Float32Array(3 * N);
  e0[2 * N + 16 + 32 * (16 + 32 * 15)] = 1;
  e0[2 * N + 16 + 32 * (16 + 32 * 17)] = -1;
  const gpu = new Fdtd3D(device, grid, 16, adapterName, rowWidth);
  gpu.load(model, DEFAULT_EXCITATION);
  const t0 = performance.now();
  await gpu.runFromState(e0, steps);
  const gpuE = await gpu.readE();
  const gpuMs = performance.now() - t0;
  gpu.destroy();
  const cpu = new CpuFdtd(model);
  cpu.e.set(e0);
  for (let n = 0; n < steps; n++) {
    cpu.updateH();
    cpu.updateE();
  }
  const rel = maxRelativeDifference(gpuE, cpu.e);
  report(`GPU vs CPU vacuum + CPML parity (32^3, 1000 steps, rows of ${rowWidth})`, rel < PARITY_TOLERANCE, `max rel diff ${rel.toExponential(2)}, GPU ${gpuMs.toFixed(0)} ms`);
}

// Check 3: demo grid, lossy FR-4 patch, port V(t) and the energy decay over
// the first 600 steps (the stop target is never reached; the decay is still measured).
for (const rowWidth of ROW_WIDTHS) {
  const steps = 600;
  const dsl = baselineGeometry();
  const lossy = voxelize({ ...dsl, substrate: { ...dsl.substrate, tan_delta: 0.02 } }, DEFAULT_GRID);
  const control = { maxSteps: steps, stopAtEnergyDecayDb: 200, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, DEFAULT_GRID, steps, adapterName, rowWidth);
  gpu.load(lossy, DEFAULT_EXCITATION);
  const gpuRun = await gpu.run({ control });
  gpu.destroy();
  const cpuRun = new CpuFdtd(lossy).run(DEFAULT_EXCITATION, control);
  const rel = maxRelativeDifference(gpuRun.v, cpuRun.v);
  const decayDiffDb = Math.abs(gpuRun.energyDecayDb - cpuRun.energyDecayDb);
  report(`port V(t) and energy decay GPU vs CPU (600 steps, 196k cells, lossy FR-4, rows of ${rowWidth})`,
    rel < PARITY_TOLERANCE && decayDiffDb < 0.01 && gpuRun.energyDecayDb > 0,
    `max rel diff ${rel.toExponential(2)}, decay ${gpuRun.energyDecayDb.toFixed(3)} vs ${cpuRun.energyDecayDb.toFixed(3)} dB, GPU ${gpuRun.gpuMs.toFixed(0)} ms`);
}

// Check 4: the strip port (5 columns across the feed), V(t) and I(t) over the first 300 steps.
{
  const steps = 300;
  const strip = voxelize(baselineGeometry(), DEFAULT_GRID, DEFAULT_EXCITATION.z0, 'strip');
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, DEFAULT_GRID, steps, adapterName);
  gpu.load(strip, DEFAULT_EXCITATION);
  const gpuRun = await gpu.run({ control });
  gpu.destroy();
  const cpuRun = new CpuFdtd(strip).run(DEFAULT_EXCITATION, control);
  const relV = maxRelativeDifference(gpuRun.v, cpuRun.v);
  const relI = maxRelativeDifference(gpuRun.i, cpuRun.i);
  report(`strip port V(t), I(t) GPU vs CPU (${strip.ports[0].columns} columns, 300 steps)`, Math.max(relV, relI) < PARITY_TOLERANCE,
    `max rel diff V ${relV.toExponential(2)}, I ${relI.toExponential(2)}`);
}

// Check 5: graded mesh (examples/patch-5g8-graded.json): every difference
// scaled by its cell width, CPML on unequal cells and the weighted port.
{
  const steps = 400;
  const json = JSON.parse(readFileSync(new URL('../../examples/patch-5g8-graded.json', import.meta.url), 'utf8'));
  const { model } = rasterise(parseProject(json));
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, model.grid, steps, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  const gpuRun = await gpu.run({ control });
  gpu.destroy();
  const cpuRun = new CpuFdtd(model).run(DEFAULT_EXCITATION, control);
  const relV = maxRelativeDifference(gpuRun.v, cpuRun.v);
  const relI = maxRelativeDifference(gpuRun.i, cpuRun.i);
  const g = model.grid;
  report(`graded mesh port V(t), I(t) GPU vs CPU (${g.nx}x${g.ny}x${g.nz}, ${steps} steps)`, Math.max(relV, relI) < PARITY_TOLERANCE,
    `max rel diff V ${relV.toExponential(2)}, I ${relI.toExponential(2)}`);
}

// Check 6: the far-field Huygens-box DFT kernel against the CPU recorder, on
// the short dipole (2 frequencies, a fixed 400 steps), then the whole
// transform from each: peak directivity and efficiency. Once on a uniform
// 1 mm mesh, once on a graded one, where the box faces sit between unequal
// cells and the kernel interpolates H with per-patch weights.
async function farFieldParity(label: string, grid: GridConfig, model: ReturnType<typeof shortDipoleModel>): Promise<void> {
  const steps = grid.stepsPerRun;
  const exc = { fMinGHz: 1, fMaxGHz: 5, nFreq: 41, z0: 50 };
  const surface = huygensSurface(model, huygensBoxInsidePml(model));
  const frequenciesHz = [2e9, 4e9];
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, grid, steps, adapterName);
  gpu.load(model, exc);
  gpu.enableHuygensDft(surface, frequenciesHz);
  const gpuRun = await gpu.run({ control });
  const gpuAccumulators = await gpu.readHuygensDft();
  gpu.destroy();
  const recorder = new HuygensDftRecorder(surface, frequenciesHz, timestepSec(grid));
  const cpuRun = new CpuFdtd(model).run(exc, control, recorder);
  const rel = maxRelativeDifference(gpuAccumulators, Float32Array.from(recorder.accumulators));
  const farField = (accumulators: ArrayLike<number>, samples: typeof cpuRun) =>
    nearToFarField({ surface, accumulators, frequenciesHz, samples, exc }).at(-1)!;
  const g = farField(gpuAccumulators, gpuRun);
  const c = farField(recorder.accumulators, cpuRun);
  const directivityDiffDb = Math.abs(g.peakDirectivityDbi - c.peakDirectivityDbi);
  const efficiencyDiff = Math.abs(g.efficiency - c.efficiency);
  report(`far-field box DFT GPU vs CPU (${label}, ${surface.count} patches, ${steps} steps)`,
    rel < PARITY_TOLERANCE && directivityDiffDb < 0.01 && efficiencyDiff < 1e-3,
    `max rel diff ${rel.toExponential(2)}, peak D ${g.peakDirectivityDbi.toFixed(3)} vs ${c.peakDirectivityDbi.toFixed(3)} dBi, ` +
    `efficiency ${g.efficiency.toFixed(4)} vs ${c.efficiency.toFixed(4)}`);
}
{
  const uniform: GridConfig = { ...DEFAULT_GRID, nx: 40, ny: 40, nz: 40, dxMm: 1, groundK: 0, stepsPerRun: 400 };
  await farFieldParity('short dipole', uniform, shortDipoleModel(uniform, 2, 50));
  const axis = gradedLines(
    [{ start: -40, end: -2, maxCellMm: 4 }, { start: -2, end: 2, maxCellMm: 0.5 }, { start: 2, end: 40, maxCellMm: 4 }],
    { maxCellMm: 4, maxGrowth: 1.3 },
  );
  const n = axis.length;
  const graded: GridConfig = { ...DEFAULT_GRID, nx: n, ny: n, nz: n, dxMm: 0.5, groundK: 0, stepsPerRun: 400 };
  await farFieldParity('short dipole, graded mesh', graded, shortDipoleModel(graded, 4, 50, { x: axis, y: axis, z: axis }));
}

// Check 7: two ports (twoPortLineJson in tests/project_fixtures.ts), one engine and
// one run per active port: V(t), I(t) of both ports in both runs. The copper is a
// poor conductor (Rs about 1.6 ohm at 12 GHz, 1e4 S/m) so the face loss (sheet_loss.wgsl)
// moves V(t) well past the parity tolerance; the run is checked against PEC copper too.
// (1e3 S/m, used before the skin-effect impedance, now sits near the face update's
// stability limit at the grid's highest frequency, and rasterise refuses it.)
{
  const steps = 400;
  const json = twoPortLineJson();
  json.materials = { poor_conductor: { conductivity_s_per_m: 1e4 } };
  for (const layer of json.stackup) if (layer.type === 'copper') layer.material = 'poor_conductor';
  const { model } = rasterise(parseProject(json));
  const pecModel = rasterise(parseProject(twoPortLineJson())).model;
  const lossEffect = maxRelativeDifference(
    new CpuFdtd(model).run(DEFAULT_EXCITATION, { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 }).v,
    new CpuFdtd(pecModel).run(DEFAULT_EXCITATION, { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 }).v);
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, model.grid, steps, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  let worst = 0;
  for (const activePort of [0, 1]) {
    const gpuRun = await gpu.run({ control, activePort });
    const cpuRun = new CpuFdtd(model).run(DEFAULT_EXCITATION, control, undefined, activePort);
    for (const [n, port] of cpuRun.ports.entries()) {
      worst = Math.max(worst, maxRelativeDifference(gpuRun.ports[n].v, port.v), maxRelativeDifference(gpuRun.ports[n].i, port.i));
    }
  }
  gpu.destroy();
  report(`two-port V(t), I(t) GPU vs CPU (both ports, each active in turn, lossy copper faces, ${steps} steps)`, worst < PARITY_TOLERANCE && lossEffect > 10 * PARITY_TOLERANCE,
    `max rel diff ${worst.toExponential(2)}, copper loss moves V(t) by ${lossEffect.toExponential(2)} against PEC`);
}

// Check 8: the z-plane field DFT kernel against PlaneDftRecorder on the small
// patch (three planes, two frequencies). The same engine then reports progress
// at each energy check of a fixed-length run, and stops on an abort signal.
{
  const steps = 400;
  const { model } = rasterise(parseProject(smallProjectJson()));
  const grid = model.grid;
  const planesK = [0, model.ports[0].k0, model.ports[0].k1 + 1];
  const frequenciesHz = [9e9, 12e9];
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, grid, steps, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  gpu.enablePlaneDft(planesK, frequenciesHz);
  const progress: number[] = [];
  await gpu.run({ control, onProgress: (stepsDone) => progress.push(stepsDone) });
  const gpuAccumulators = await gpu.readPlaneDft();
  const recorder = new PlaneDftRecorder(grid, planesK, frequenciesHz, timestepSec(grid));
  new CpuFdtd(model).run(DEFAULT_EXCITATION, control, recorder);
  const rel = maxRelativeDifference(gpuAccumulators, Float32Array.from(recorder.accumulators));
  report(`plane DFT GPU vs CPU (${planesK.length} planes, ${frequenciesHz.length} frequencies, ${steps} steps)`, rel < PARITY_TOLERANCE,
    `max rel diff ${rel.toExponential(2)}`);
  const abort = new AbortController();
  let stoppedAt = 0;
  const aborted = await gpu
    .run({ control, signal: abort.signal, onProgress: (stepsDone) => { stoppedAt = stepsDone; if (stepsDone === 200) abort.abort(); } })
    .then(() => null, (error: unknown) => error);
  const nextRun = await gpu.run({ control });
  gpu.destroy();
  report('progress at each energy check, abort stops the run, the engine runs again after it',
    progress.join() === '100,200,300,400' && aborted instanceof Error && aborted.name === 'AbortError' && stoppedAt === 200 && nextRun.v.length === steps,
    `progress at [${progress.join(', ')}], aborted with ${aborted instanceof Error ? aborted.name : String(aborted)} after ${stoppedAt} steps`);
}

// Check 8b: the whole-grid field DFT kernel (cuts in the workbench) against
// VolumeDftRecorder on the small patch, two frequencies.
{
  const steps = 400;
  const { model } = rasterise(parseProject(smallProjectJson()));
  const grid = model.grid;
  const frequenciesHz = [9e9, 12e9];
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, grid, steps, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  gpu.enableVolumeDft(frequenciesHz);
  await gpu.run({ control });
  const gpuAccumulators = await gpu.readVolumeDft();
  // The workbench drops the volume DFT after the first run; the engine must keep running without it.
  gpu.disableVolumeDft();
  const afterDisable = await gpu.run({ control });
  gpu.destroy();
  const recorder = new VolumeDftRecorder(grid, frequenciesHz, timestepSec(grid));
  new CpuFdtd(model).run(DEFAULT_EXCITATION, control, recorder);
  const rel = maxRelativeDifference(gpuAccumulators, recorder.accumulators);
  report(`volume DFT GPU vs CPU (${grid.nx}x${grid.ny}x${grid.nz} nodes, ${frequenciesHz.length} frequencies, ${steps} steps), then a run without it`,
    rel < PARITY_TOLERANCE && afterDisable.v.length === steps,
    `max rel diff ${rel.toExponential(2)}`);
}

// Check 9: the coax feed (coax_feed.ts) on the SMA edge-launch line, a model
// whose lumped stand-in port addCoaxFeed removes: the TEM source and both probe voltages against
// runCoaxFeed, then the same on the calibration coax on a second engine. The
// run is long enough for the pulse peak to pass both probes.
{
  const steps = 1200;
  const project = parseProject(smaEdgeLineJson());
  const { model: board, coaxPorts } = rasterise(project);
  const a = project.analysis;
  const exc = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const feedRun = addCoaxFeed(board, coaxPorts[0].spec);
  const calRun = coaxCalibrationModel(feedRun.model, feedRun.feed);
  const planes = (feed: CoaxFeed) => ({ source: feed.source, probes: feed.probes });
  for (const [label, { model, feed }] of [['feed model', feedRun], ['calibration coax', calRun]] as const) {
    const gpu = new Fdtd3D(device, model.grid, steps, adapterName);
    gpu.load(model, exc);
    const gpuRun = await gpu.run({ control, coax: planes(feed) });
    gpu.destroy();
    const cpuRun = runCoaxFeed(model, feed, exc, control);
    const rel = Math.max(...cpuRun.probeVolts.map((v, q) =>
      maxRelativeDifference(Float32Array.from(gpuRun.coaxProbeVolts[q]), Float32Array.from(v))));
    const peak = Math.max(...cpuRun.probeVolts[1].map(Math.abs));
    const g = model.grid;
    report(`coax probe V(t) GPU vs CPU (${label}, ${g.nx}x${g.ny}x${g.nz}, ${feed.source.edges.length} edges per plane, ${steps} steps)`,
      rel < PARITY_TOLERANCE && gpuRun.ports.length === 0 && peak > 0.1,
      `max rel diff ${rel.toExponential(2)}, near-probe peak ${peak.toFixed(3)} V, GPU ${gpuRun.gpuMs.toFixed(0)} ms`);
  }
}

// Check 10: solvePorts on the GPU engine against the CPU, on a line with an SMA
// at one end and a lumped port at the other: coax source runs and a lumped
// source run with coax probes, the calibration coax, and the S assembly.
{
  const json = smaThroughLineJson();
  json.ports[1] = { id: 'out', x: '0 mm', y: 'half_len', between: ['top', 'gnd'], reference_impedance_ohm: 50 };
  const project = parseProject(json);
  const { model, coaxPorts } = rasterise(project);
  const a = project.analysis;
  const exc = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 };
  const control = { maxSteps: 1500, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const t0 = performance.now();
  const gpuSolve = await solvePorts(model, coaxPorts, [50, 50], [0, 1], exc, control, { engine: gpuCoaxEngine(device, adapterName) });
  const gpuMs = performance.now() - t0;
  const cpuSolve = await solvePorts(model, coaxPorts, [50, 50], [0, 1], exc, control);
  let worst = 0;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) for (let m = 0; m < exc.nFreq; m++) {
    worst = Math.max(worst, Math.hypot(gpuSolve.scattering.re[i][j]![m] - cpuSolve.scattering.re[i][j]![m], gpuSolve.scattering.im[i][j]![m] - cpuSolve.scattering.im[i][j]![m]));
  }
  // 1500 steps do not ring the line down, so S itself is rough; GPU and CPU must still agree on it.
  const s21 = Math.hypot(cpuSolve.scattering.re[1][0]![0], cpuSolve.scattering.im[1][0]![0]);
  report(`solvePorts GPU vs CPU (SMA + lumped port, ${model.grid.nx}x${model.grid.ny}x${model.grid.nz}, 2 runs + calibration, ${control.maxSteps} steps)`,
    worst < PARITY_TOLERANCE && s21 > 0,
    `max |dS| ${worst.toExponential(2)}, |S21| at ${exc.fMinGHz} GHz ${s21.toFixed(3)}, GPU ${gpuMs.toFixed(0)} ms`);
}

// Check 11: frequency-dependent and magnetic materials (dispersion.wgsl): the small
// patch on Djordjevic-Sarkar FR-4 under a lossy Lorentz-ferrite cover, so both
// fields have dispersive edges, interface mixes and the Hz series mean. Checked
// against the CPU, and against the plain FR-4 patch to show the passes matter.
// The energy stop is on (at a level it never reaches) so the poles' stored energy is summed too.
{
  const steps = 600;
  const control = { maxSteps: steps, stopAtEnergyDecayDb: 200, energyCheckEverySteps: 100 };
  const { model } = rasterise(parseProject(dispersiveProjectJson()));
  const plain = rasterise(parseProject(smallProjectJson())).model;
  const cpuRun = new CpuFdtd(model).run(DEFAULT_EXCITATION, control);
  const effect = maxRelativeDifference(cpuRun.v, new CpuFdtd(plain).run(DEFAULT_EXCITATION, control).v);
  const gpu = new Fdtd3D(device, model.grid, steps, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  const first = await gpu.run({ control });
  const second = await gpu.run({ control }); // the pole state must start from zero again
  gpu.destroy();
  const rel = Math.max(maxRelativeDifference(first.v, cpuRun.v), maxRelativeDifference(first.i, cpuRun.i), maxRelativeDifference(second.v, cpuRun.v));
  const d = model.dispersion!;
  report(`dispersive + magnetic V(t), I(t) GPU vs CPU (${d.e!.index.length} E edges with up to ${d.e!.maxPoles} poles, ${d.h!.index.length} H edges, ${steps} steps, two runs)`,
    rel < PARITY_TOLERANCE && effect > 10 * PARITY_TOLERANCE && Math.abs(first.energyDecayDb - cpuRun.energyDecayDb) < 0.01,
    `max rel diff ${rel.toExponential(2)}, the materials move V(t) by ${effect.toExponential(2)} against plain FR-4, decay ${first.energyDecayDb.toFixed(3)} vs ${cpuRun.energyDecayDb.toFixed(3)} dB`);
}

// Check 12: lumped components (lumped.wgsl, lumped_energy.wgsl) on the
// two-port line over Djordjevic-Sarkar FR-4: a series RLC across a gap in the
// trace, three columns wide, and a parallel RLC from the trace to ground,
// whose column runs through the dispersive substrate. V(t), I(t) of both
// ports and the energy decay, which counts the components' stored energy.
{
  const steps = 600;
  const json = twoPortLineJson();
  json.materials = { 'FR-4 wideband': { eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 1 } } };
  json.stackup[1].material = 'FR-4 wideband';
  json.geometry.top = [
    { id: 'in', op: 'add', polygon: rect('-1 mm', '-half_len', '1 mm', '-1 mm') },
    { id: 'out', op: 'add', polygon: rect('-1 mm', '1 mm', '1 mm', 'half_len') },
  ];
  json.components = [
    { id: 'series_rlc', layer: 'top', from: ['0 mm', '-1 mm'], to: ['0 mm', '1 mm'], width: '2 mm', r_ohm: 10, l_nh: 2, c_pf: 1, connection: 'series' },
    { id: 'shunt_rlc', x: '0 mm', y: '-3 mm', between: ['top', 'gnd'], r_ohm: 300, l_nh: 3, c_pf: 0.5, connection: 'parallel' },
  ];
  const { model } = rasterise(parseProject(json));
  const control = { maxSteps: steps, stopAtEnergyDecayDb: 200, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, model.grid, steps, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  const gpuRun = await gpu.run({ control });
  gpu.destroy();
  const cpuRun = new CpuFdtd(model).run(DEFAULT_EXCITATION, control);
  let worst = 0;
  for (const [n, port] of cpuRun.ports.entries()) {
    worst = Math.max(worst, maxRelativeDifference(gpuRun.ports[n].v, port.v), maxRelativeDifference(gpuRun.ports[n].i, port.i));
  }
  const decayDiffDb = Math.abs(gpuRun.energyDecayDb - cpuRun.energyDecayDb);
  report(`lumped components on dispersive FR-4, V(t), I(t) and energy decay GPU vs CPU (${model.lumped!.eIndex.length} component edges, ${model.dispersion!.e!.index.length} dispersive edges, ${steps} steps)`,
    worst < PARITY_TOLERANCE && decayDiffDb < 0.01,
    `max rel diff ${worst.toExponential(2)}, decay ${gpuRun.energyDecayDb.toFixed(3)} vs ${cpuRun.energyDecayDb.toFixed(3)} dB`);
}

// Check 13: conformal copper (conformal.wgsl): the small patch turned by 30
// degrees with mesh.conformal, on Djordjevic-Sarkar FR-4 so its partly covered
// edges also go through the dispersion pass, GPU vs CPU port V(t). The conformal faces must
// move V(t) well past the parity tolerance against the same model without
// them (same edges, same time step), so the pass is known to matter.
{
  const steps = 400;
  const turned = () => {
    const json = smallProjectJson();
    const t = Math.PI / 6;
    const turn = (x: number, y: number) => [`${x * Math.cos(t) - y * Math.sin(t)} mm`, `${x * Math.sin(t) + y * Math.cos(t)} mm`];
    json.geometry.top[0].polygon = [[-3, -3], [3, -3], [3, 3], [-3, 3]].map(([x, y]) => turn(x, y));
    json.mesh.conformal = true;
    json.materials = { 'FR-4 wideband': { eps_r: 4.4, tan_delta: 0.02, dispersion: { model: 'djordjevic_sarkar', at_ghz: 1 } } };
    json.stackup[1].material = 'FR-4 wideband';
    return rasterise(parseProject(json)).model;
  };
  const model = turned();
  const control = { maxSteps: steps, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
  const gpu = new Fdtd3D(device, model.grid, steps, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  const gpuRun = await gpu.run({ control });
  gpu.destroy();
  const cpuV = new CpuFdtd(model).run(DEFAULT_EXCITATION, control).v;
  const worst = maxRelativeDifference(gpuRun.v, cpuV);
  const conformalEffect = maxRelativeDifference(cpuV, new CpuFdtd({ ...model, conformal: undefined }).run(DEFAULT_EXCITATION, control).v);
  report(`conformal copper V(t) GPU vs CPU (patch turned 30 deg on dispersive FR-4, ${model.conformal?.hIndex.length ?? 0} conformal faces, ${steps} steps)`,
    worst < PARITY_TOLERANCE && conformalEffect > 10 * PARITY_TOLERANCE,
    `max rel diff ${worst.toExponential(2)}, the face pass moves V(t) by ${conformalEffect.toExponential(2)}`);
}

// Check 14: conformal 3D solids (conformal_solids.ts): a sphere and a rod turned
// about all three axes, in vacuum with a CPML, so the face pass corrects Hx, Hy
// and Hz faces. GPU vs CPU E after 800 steps from a two-edge start.
{
  const grid: GridConfig = { ...DEFAULT_GRID, nx: 40, ny: 40, nz: 40, groundK: 10, stepsPerRun: 800, courant: CONFORMAL_SOLID_COURANT };
  const N = grid.nx * grid.ny * grid.nz;
  const h = grid.dxMm;
  const model = addConformalSolids(vacuumModel(grid), [
    sphereMesh([20.3 * h, 19.6 * h, 22.2 * h], 5.3 * h, 96),
    tubeMesh([[12.2 * h, 25.1 * h, 13.4 * h], [27.7 * h, 28.3 * h, 26.9 * h]], 1.7 * h, 48),
  ]);
  const e0 = new Float32Array(3 * N);
  e0[2 * N + 12 + 40 * (12 + 40 * 18)] = 1;
  e0[N + 26 + 40 * (12 + 40 * 20)] = -1;
  const steps = 800;
  const gpu = new Fdtd3D(device, grid, 16, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  await gpu.runFromState(e0, steps);
  const gpuE = await gpu.readE();
  gpu.destroy();
  const cpu = new CpuFdtd(model);
  cpu.e.set(e0);
  for (let n = 0; n < steps; n++) {
    cpu.updateH();
    cpu.updateE();
  }
  const comps = new Set(Array.from(model.conformal!.hIndex, (f) => Math.floor(f / N)));
  const rel = maxRelativeDifference(gpuE, cpu.e);
  report(`conformal solids E GPU vs CPU (sphere and turned rod, ${model.conformal!.hIndex.length} faces on ${comps.size} orientations, ${steps} steps)`,
    rel < PARITY_TOLERANCE && comps.size === 3, `max rel diff ${rel.toExponential(2)}`);
}

// Check 15: thin sheets (conformal_sheets.ts): a closed sphere sheet and an
// open strip turned about all three axes, in vacuum with a CPML, so both
// sparse passes and the ghost fields run. GPU vs CPU E after 800 steps from a
// start on both sides of the sphere sheet.
{
  const grid: GridConfig = { ...DEFAULT_GRID, nx: 40, ny: 40, nz: 40, groundK: 10, stepsPerRun: 800, courant: CONFORMAL_SOLID_COURANT };
  const N = grid.nx * grid.ny * grid.nz;
  const h = grid.dxMm;
  const model = addConformalSheets(vacuumModel(grid), [
    sphereMesh([20.3 * h, 19.6 * h, 22.2 * h], 5.3 * h, 96),
    ribbonMesh([[11.2 * h, 24.1 * h, 12.4 * h], [27.7 * h, 29.3 * h, 27.9 * h]], [[0.8, -0.36, -0.48], [0.8, -0.36, -0.48]], 2.3 * h),
  ]);
  const e0 = new Float32Array(3 * N);
  e0[2 * N + 20 + 40 * (20 + 40 * 22)] = 1; // inside the sphere
  e0[N + 26 + 40 * (12 + 40 * 20)] = -1; // outside
  const steps = 800;
  const gpu = new Fdtd3D(device, grid, 16, adapterName);
  gpu.load(model, DEFAULT_EXCITATION);
  await gpu.runFromState(e0, steps);
  const gpuE = await gpu.readE();
  gpu.destroy();
  const march = (m: typeof model) => {
    const cpu = new CpuFdtd(m);
    cpu.e.set(e0);
    for (let n = 0; n < steps; n++) {
      cpu.updateH();
      cpu.updateE();
    }
    return cpu.e;
  };
  const cpuE = march(model);
  const rel = maxRelativeDifference(gpuE, cpuE);
  const sheetEffect = maxRelativeDifference(cpuE, march({ ...model, thinSheets: undefined }));
  const sheets = model.thinSheets!;
  report(`thin sheets E GPU vs CPU (sphere sheet and turned strip, ${sheets.ghostE} ghost E, ${sheets.ghostH} ghost H, ${steps} steps)`,
    rel < PARITY_TOLERANCE && sheetEffect > 10 * PARITY_TOLERANCE, `max rel diff ${rel.toExponential(2)}, the sheets move E by ${sheetEffect.toExponential(2)}`);
}

device.destroy();
process.exit(allPass ? 0 : 1);
