/**
 * Headless NobuRF: solve a project file and write a results bundle.
 *   npm run noburf -- solve examples/patch-5g8.json [--gpu | --cpu] [--out dir]
 *   npm run noburf -- import ...   (Gerber / DXF / STEP copper into a project; see src/import/command.ts)
 * By default the solve runs the WGSL kernels through Dawn (headless WebGPU)
 * when a WebGPU adapter is found and the model fits the GPU engine, and
 * otherwise says why and runs the CPU reference. --gpu fails instead of falling back;
 * --cpu skips the GPU. The GPU path needs the ?raw import hooks, which the
 * npm script loads.
 * Default output directory: <project file without .json>.results/ next to it.
 * Bundle: s11.s1p (Touchstone v1) and result.json (summary + provenance),
 * plus, when the project lists outputs.far_field_ghz, far_field.json and per
 * frequency pattern_<f>ghz.svg (E- and H-plane cuts) and pattern_<f>ghz.glb
 * (the 3D directivity lobe as glTF).
 * A project with N > 1 ports runs once per excited port and writes
 * sparams.s<N>p (Touchstone v1) when every port is excited, and with
 * outputs.differential_pairs also differential.json (mixed-mode S, TDR, skew).
 *   npm run noburf -- pair <file.sNp> --pair 1,3 --pair 2,4 ...   (any Touchstone file; see src/node/pair_command.ts)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENERGY_STOP_RUN, timestepSec } from '../src/engine/config';
import { solvePorts } from '../src/engine/coax_feed';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { gpuPortLimitExceeded } from '../src/engine/gpu_limits';
import { boresightPolarisation, patternFigures } from '../src/engine/far_field_pattern';
import { largestCell, type MeshLines } from '../src/engine/mesh';
import { HuygensDftRecorder, huygensBoxInsidePml, huygensSurface, type HuygensSurface } from '../src/engine/huygens_box';
import { nearToFarField, type FarFieldResult } from '../src/engine/near_to_far';
import { touchstoneLines } from '../src/engine/touchstone';
import { interp, portSpectrum, s11FromZ, scatteringMatrix, type ScatteringResult, type Spectrum } from '../src/engine/port_dft';
import type { ExcitationConfig, PortSamples, RunControl } from '../src/engine/types';
import type { VoxelModel } from '../src/engine/voxelize';
import { runImportCommand } from '../src/import/command';
import { checkDeembedding, deembedProject, type KitSolver, type PortDeembedding } from '../src/project/deembed_kit';
import { analyseDifferential, constantLossNote, differentialJson, differentialSummaryLines, pairSpecsFromIds, TIMING_ENERGY_DECAY_DB } from '../src/engine/differential';
import { PAIR_USAGE, runPairCommand } from '../src/node/pair_command';
import { rasterise } from '../src/project/rasterise';
import { constantLossDielectrics, resolveProject } from '../src/project/resolve';
import { parseProject, PROJECT_SCHEMA_VERSION, type Project } from '../src/project/schema';
import { encodeGlb } from '../src/viewer/glb';
import { lobeMesh } from '../src/viewer/lobe_mesh';
import { patternCutsSvg } from '../src/viewer/pattern_plot';
import { assessAccuracy, BAND_SCOPE, boardCellSizeMm, convergenceSummary, type AccuracyMode, type AccuracyReport } from '../src/verify/accuracy';
import { onePortScattering, passivityCheck, reciprocityCheck } from '../src/verify/checks';
import { DEFAULT_DELTA_S, type GciEstimate } from '../src/verify/convergence';

const USAGE = 'usage: noburf solve <project.json> [--gpu | --cpu] [--out <dir>] [--mesh-check off|check|refine] [--delta-s <tolerance>]\n       noburf import ... (run "noburf import" for its options)\n       ' + PAIR_USAGE.replace('usage: ', '');

/** "auto": the GPU when a WebGPU adapter is found, else the CPU reference with a notice. */
export type SolverChoice = 'auto' | 'gpu' | 'cpu';

function parseArgs(argv: string[]): { projectPath: string; outDir: string; solverChoice: SolverChoice; accuracy: AccuracyMode; deltaS: number } {
  const [command, projectPath, ...rest] = argv;
  if (command !== 'solve' || !projectPath) throw new Error(USAGE);
  let outDir = projectPath.replace(/\.json$/i, '') + '.results';
  let solverChoice: SolverChoice = 'auto';
  let accuracy: AccuracyMode = 'off'; // opt-in: a mesh check costs about 3 times one solve
  let deltaS = DEFAULT_DELTA_S;
  for (let n = 0; n < rest.length; n++) {
    if ((rest[n] === '--gpu' || rest[n] === '--cpu') && solverChoice === 'auto') solverChoice = rest[n] === '--gpu' ? 'gpu' : 'cpu';
    else if (rest[n] === '--out' && rest[n + 1]) outDir = rest[++n];
    else if (rest[n] === '--mesh-check' && ['check', 'refine', 'off'].includes(rest[n + 1])) accuracy = rest[++n] as AccuracyMode;
    else if (rest[n] === '--delta-s' && Number(rest[n + 1]) > 0) deltaS = Number(rest[++n]);
    else throw new Error(USAGE);
  }
  return { projectPath, outDir, solverChoice, accuracy, deltaS };
}

/**
 * Whether this run solves on the GPU, decided once before any meshing so
 * --gpu fails fast. "auto" falls back to the CPU reference with a notice on
 * stderr when the GPU solver cannot load or there is no WebGPU adapter.
 */
export async function decideUseGpu(choice: SolverChoice): Promise<boolean> {
  if (choice === 'cpu') {
    console.log('solver: CPU reference (--cpu)');
    return false;
  }
  let adapterName: string | null;
  try {
    await import('../src/engine/fdtd3d'); // its WGSL needs the ?raw import hooks, which the npm script loads
    const { findNodeGpuAdapterName, NO_WEBGPU_ADAPTER_MESSAGE } = await import('../src/node/gpu_device');
    adapterName = await findNodeGpuAdapterName();
    if (!adapterName) throw new Error(NO_WEBGPU_ADAPTER_MESSAGE);
  } catch (e) {
    const message = (e as Error).message;
    const reason = message.includes('.wgsl') ? 'its WGSL shaders need the import hooks that `npm run noburf` loads' : message.split('\n')[0];
    if (choice === 'gpu') throw new Error(`--gpu: ${reason}`);
    console.log('solver: CPU reference (no GPU)');
    console.warn(`notice: solving on the CPU reference, which is much slower, because the GPU solver is unavailable: ${reason}\n` +
      'notice: pass --cpu to choose the CPU without this check, or --gpu to make a missing GPU an error.');
    return false;
  }
  console.log(`solver: GPU (${adapterName})`);
  return true;
}

/** The far-field box and its frequencies, when the project asks for a far field. */
interface FarFieldRequest {
  surface: HuygensSurface;
  frequenciesHz: number[];
}

interface Solved {
  /** One run per excited port, in the order asked for. */
  runs: PortSamples[];
  solver: string;
  /** Box DFTs (huygens_box.ts layout), when a far field was requested. */
  huygensAccumulators: ArrayLike<number> | null;
}

/** solvePorts' engine on a headless WebGPU device. Loaded lazily: the CPU path needs no GPU packages. */
async function gpuEngine() {
  const { createNodeGpuDevice } = await import('../src/node/gpu_device');
  const { gpuCoaxEngine } = await import('../src/engine/fdtd3d');
  const { device, adapterName } = await createNodeGpuDevice();
  return { factory: gpuCoaxEngine(device, adapterName), adapterName };
}

/** Port samples from the WGSL kernels on a headless WebGPU device. Loaded lazily: the CPU path needs no GPU packages. */
async function solveOnGpu(model: VoxelModel, exc: ExcitationConfig, control: RunControl, farField: FarFieldRequest | null, excited: number[]): Promise<Solved> {
  const { createNodeGpuDevice } = await import('../src/node/gpu_device');
  const { Fdtd3D } = await import('../src/engine/fdtd3d');
  const { device, adapterName } = await createNodeGpuDevice();
  const engine = new Fdtd3D(device, model.grid, control.maxSteps, adapterName);
  engine.load(model, exc);
  if (farField) engine.enableHuygensDft(farField.surface, farField.frequenciesHz);
  const runs: PortSamples[] = [];
  for (const activePort of excited) runs.push(await engine.run({ control, activePort }));
  const huygensAccumulators = farField ? await engine.readHuygensDft() : null;
  engine.destroy();
  return { runs, solver: `WGSL on ${adapterName}`, huygensAccumulators };
}

function solveOnCpu(model: VoxelModel, exc: ExcitationConfig, control: RunControl, farField: FarFieldRequest | null, excited: number[]): Solved {
  const recorder = farField ? new HuygensDftRecorder(farField.surface, farField.frequenciesHz, timestepSec(model.grid)) : undefined;
  const solver = new CpuFdtd(model);
  const runs = excited.map((activePort) => solver.run(exc, control, recorder, activePort));
  return { runs, solver: 'CPU reference', huygensAccumulators: recorder?.accumulators ?? null };
}

/** min and max of |S_ij| in dB over the band, for every measured S_ij. */
export function scatteringSummary(s: ScatteringResult, portIds: string[]) {
  const out: Array<{ s: string; to: string; from: string; min_db: number; min_at_ghz: number; max_db: number; max_at_ghz: number }> = [];
  for (let j = 0; j < portIds.length; j++) {
    for (let i = 0; i < portIds.length; i++) {
      const [re, im] = [s.re[i][j], s.im[i][j]];
      if (!re || !im) continue;
      const db = Array.from(re, (x, m) => 20 * Math.log10(Math.hypot(x, im[m])));
      let [lo, hi] = [0, 0];
      db.forEach((x, m) => {
        if (x < db[lo]) lo = m;
        if (x > db[hi]) hi = m;
      });
      out.push({ s: `S${i + 1}${j + 1}`, to: portIds[i], from: portIds[j], min_db: db[lo], min_at_ghz: s.fGHz[lo], max_db: db[hi], max_at_ghz: s.fGHz[hi] });
    }
  }
  return out;
}

/** Six significant digits: enough for a pattern, a third of the file size of full doubles. */
const round6 = (x: number) => Number(x.toPrecision(6));
const rows = (values: Float64Array, columns: number) =>
  Array.from({ length: values.length / columns }, (_, row) => Array.from(values.subarray(row * columns, (row + 1) * columns), round6));

/**
 * The far field is a Fourier transform of the whole run; a run cut off before
 * the field rang down leaves energy out of both the box and the port
 * transforms, unequally, so efficiency and gain are the first numbers to go.
 */
function truncatedRunCaveat(energyDecayDb: number): string {
  // energyDecayDb is peak over current energy, positive; NaN when no check ran.
  const decay = Number.isFinite(energyDecayDb) ? `${energyDecayDb.toFixed(1)} dB` : 'an unknown amount';
  return `the run stopped before the field rang down (energy fell ${decay}); efficiency and gain are approximate, the pattern shape less so`;
}

/** Datasheet figures for the far_field.json entry, with the polarisation they assume. */
function patternFiguresJson(r: FarFieldResult) {
  const polarisation = boresightPolarisation(r);
  const f = patternFigures(r, polarisation);
  const roundOrNull = (x: number | null) => (x === null ? null : round6(x));
  return {
    boresight_polarisation: polarisation,
    e_plane_phi_deg: f.ePlanePhiDeg,
    beamwidth_e_plane_deg: roundOrNull(f.beamwidthEPlaneDeg),
    beamwidth_h_plane_deg: roundOrNull(f.beamwidthHPlaneDeg),
    front_to_back_db: round6(f.frontToBackDb),
    boresight_cross_polar_db: round6(f.boresightCrossPolarDb),
  };
}

/** Polar cut plot (SVG) and 3D lobe (glTF) per far-field frequency, named by frequency. */
function writePatternFiles(outDir: string, projectName: string, results: FarFieldResult[]): string[] {
  return results.flatMap((r) => {
    const fGhz = r.frequencyHz / 1e9;
    const stem = `pattern_${fGhz}ghz`;
    const caption = `${projectName}: peak directivity ${r.peakDirectivityDbi.toFixed(2)} dBi, gain ${r.peakGainDbi.toFixed(2)} dBi, ` +
      `radiation efficiency ${(100 * r.efficiency).toFixed(1)} %`;
    writeFileSync(join(outDir, `${stem}.svg`), patternCutsSvg({ pattern: r, frequencyGHz: fGhz, polarisation: boresightPolarisation(r), caption }));
    const lobe = lobeMesh(r.thetaDeg, r.phiDeg, r.directivityDbi, LOBE_RANGE_DB);
    writeFileSync(join(outDir, `${stem}.glb`), encodeGlb(lobe, `${projectName} directivity ${fGhz} GHz`, LOBE_RADIUS_M));
    return [`${stem}.svg`, `${stem}.glb`];
  });
}

/** The exported lobe: 30 dB of pattern, peak at 0.1 m so it sits next to a board at true scale in a CAD viewer. */
const LOBE_RANGE_DB = 30;
const LOBE_RADIUS_M = 0.1;

/** far_field.json: one entry per requested frequency. */
export function farFieldReport(projectName: string, surface: HuygensSurface, mesh: MeshLines, results: FarFieldResult[], run: Pick<PortSamples, 'stoppedOnEnergy' | 'energyDecayDb'>) {
  const { lo, hi } = surface.box;
  const sizeMm = [mesh.x, mesh.y, mesh.z].map((nodes, a) => round6(nodes[hi[a]] - nodes[lo[a]]));
  return {
    project: projectName,
    method: 'near-to-far-field transform of the tangential E and H on a closed box in the air around the board (Taflove & Hagness ch. 8)',
    units: 'powers in W and r*E in V for a 1 V peak source behind the port reference resistance; the r*E phasors omit exp(-j k r)',
    huygens_box: { lo_node: lo, hi_node: hi, size_mm: sizeMm, patches: surface.count },
    ...(run.stoppedOnEnergy ? {} : { caveat: truncatedRunCaveat(run.energyDecayDb) }),
    frequencies: results.map((r) => ({
      f_ghz: r.frequencyHz / 1e9,
      peak_directivity_dbi: round6(r.peakDirectivityDbi),
      peak_theta_deg: r.peakThetaDeg,
      peak_phi_deg: r.peakPhiDeg,
      peak_gain_dbi: round6(r.peakGainDbi),
      peak_realised_gain_dbi: round6(r.peakRealisedGainDbi),
      radiated_power_w: r.radiatedPowerW,
      accepted_power_w: r.acceptedPowerW,
      efficiency: round6(r.efficiency),
      mismatch_factor: round6(r.mismatchFactor),
      sphere_to_box_power_ratio: round6(r.sphereIntegralPowerW / r.radiatedPowerW),
      ...patternFiguresJson(r),
      pattern: {
        theta_deg: Array.from(r.thetaDeg),
        phi_deg: Array.from(r.phiDeg),
        directivity_dbi: rows(r.directivityDbi, r.phiDeg.length),
        r_e_theta_v: { re: rows(r.rEThetaRe, r.phiDeg.length), im: rows(r.rEThetaIm, r.phiDeg.length) },
        r_e_phi_v: { re: rows(r.rEPhiRe, r.phiDeg.length), im: rows(r.rEPhiIm, r.phiDeg.length) },
      },
    })),
  };
}

/** Reflection coefficient from Z_in. An open port (Z infinite) reflects fully. */
/** Z and S_jj of port j over the band, from an S-matrix referred to z0 at that port: Z = z0 (1 + S) / (1 - S). */
function spectrumFromScattering(s: ScatteringResult, j: number, z0: number): Spectrum {
  const n = s.fGHz.length;
  const out = { fGHz: s.fGHz, zRe: new Float64Array(n), zIm: new Float64Array(n), s11Db: new Float64Array(n) };
  for (let m = 0; m < n; m++) {
    const [sr, si] = [s.re[j][j]![m], s.im[j][j]![m]];
    const den = (1 - sr) ** 2 + si * si;
    out.zRe[m] = (z0 * (1 - sr * sr - si * si)) / den;
    out.zIm[m] = (z0 * 2 * si) / den;
    out.s11Db[m] = s11FromZ(out.zRe[m], out.zIm[m], z0);
  }
  return out;
}

function gamma(zRe: number, zIm: number, z0: number): [number, number] {
  if (!Number.isFinite(zRe) || !Number.isFinite(zIm)) return [1, 0];
  const den = (zRe + z0) ** 2 + zIm ** 2;
  return [((zRe - z0) * (zRe + z0) + zIm * zIm) / den, (2 * zIm * z0) / den];
}

/** Z_in at the requested frequencies. A non-finite value (open port) is kept as a string and warned about, never dropped. */
export function zinPoints(spec: Spectrum, freqsGHz: number[], warnings: string[]) {
  return freqsGHz.map((f) => {
    const [re, im] = [interp(spec.fGHz, spec.zRe, f), interp(spec.fGHz, spec.zIm, f)];
    if (!Number.isFinite(re) || !Number.isFinite(im)) warnings.push(`Z_in at ${f} GHz is not finite (${re}, ${im}): the port sees an open circuit`);
    return { f_ghz: f, re_ohm: finiteOrString(re), im_ohm: finiteOrString(im) };
  });
}

/** JSON has no Infinity or NaN; JSON.stringify would write null. */
const finiteOrString = (x: number) => (Number.isFinite(x) ? x : String(x));

/**
 * The solver source this result came from: the commit, plus whether tracked
 * files differ from it. Without git the result says so and a warning is added.
 */
function solverSource(warnings: string[]): { git_commit: string | null; tracked_files_modified: boolean | null } {
  const cwd = dirname(fileURLToPath(import.meta.url));
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' });
  if (head.status !== 0 || status.status !== 0) {
    warnings.push('solver source not recorded: git or the repository is unavailable');
    return { git_commit: null, tracked_files_modified: null };
  }
  return { git_commit: head.stdout.trim(), tracked_files_modified: status.stdout.trim() !== '' };
}

/** Everything one solve produces, before it is written to disk. */
export interface ProjectSolve {
  project: Project;
  model: VoxelModel;
  exc: ExcitationConfig;
  control: RunControl;
  /** Indices into project.ports of the excited ports, one run each, in project order. */
  excited: number[];
  /** The runs' lumped-port records, in the order of `excited`; empty when a coax feed (sma_edge, coax_probe) is among the ports. */
  runs: PortSamples[];
  /** Per run, in the order of `excited`: length, energy decay, and the excited port's spectrum (others matched). */
  runSummaries: Array<{ steps: number; energyDecayDb: number; stoppedOnEnergy: boolean; spec: Spectrum }>;
  /** The first run's port V/I record; null with a coax feed. */
  samples: PortSamples | null;
  /** Steps and energy decay of the first run. */
  steps: number;
  energyDecayDb: number;
  stoppedOnEnergy: boolean;
  /** The first excited port's spectrum: from V/I, or for a coax feed de-embedded to its flange. */
  spec: Spectrum;
  /** The S-matrix (columns of the excited ports) for a project with several ports; null for one port. */
  scattering: ScatteringResult | null;
  solver: string;
  solveMs: number;
  /** Git commit and working-tree state, recorded before the solve. */
  source: ReturnType<typeof solverSource>;
  farField: FarFieldRequest | null;
  huygensAccumulators: ArrayLike<number> | null;
  warnings: string[];
}

/**
 * The solve path of `noburf solve`: parse, rasterise, run to the energy stop,
 * transform the port record. Exported so benchmark and validation scripts run
 * exactly what the CLI runs.
 */
export async function solveProjectText(text: string, sourceName: string, useGpu: boolean, cpuWhenModelExceedsGpu = false): Promise<ProjectSolve> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`${sourceName} is not valid JSON: ${(e as Error).message}`);
  }
  const project = parseProject(json);
  const { model, warnings, coaxPorts } = rasterise(project);
  const gpuLimit = useGpu ? gpuPortLimitExceeded(model.ports) : null;
  if (gpuLimit && !cpuWhenModelExceedsGpu) throw new Error(`${gpuLimit}; pass --cpu to solve on the CPU reference`);
  if (gpuLimit) {
    console.warn(`notice: solving on the CPU reference, which is much slower, because ${gpuLimit}`);
    useGpu = false;
  }
  if (project.outputs.near_field_mm) warnings.push('$.outputs.near_field_mm: the near-field scan is drawn in the workbench (Emissions view); the CLI does not write it');
  const portIds = project.ports.map((p) => p.id);
  const z0s = project.ports.map((p) => p.reference_impedance_ohm);
  const excited = resolveProject(project).excite;
  const multiport = project.ports.length > 1;
  if (multiport && excited.length === portIds.length && new Set(z0s).size > 1) {
    throw new Error(`ports have different reference impedances (${z0s.join(', ')} ohm); the s${portIds.length}p file needs one ` +
      'and renormalisation is not implemented yet');
  }
  const farFieldGhz = project.outputs.far_field_ghz ?? [];
  if (multiport && farFieldGhz.length) throw new Error('$.outputs.far_field_ghz: the far field is computed for one-port projects only today');
  const port = project.ports[excited[0]];
  const a = project.analysis;
  const exc: ExcitationConfig = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: port.reference_impedance_ohm };
  const control: RunControl = {
    maxSteps: a.stop.max_steps,
    stopAtEnergyDecayDb: a.stop.energy_decay_db,
    energyCheckEverySteps: ENERGY_STOP_RUN.energyCheckEverySteps,
  };
  const { nx, ny, nz } = model.grid;
  const componentCount = project.components?.length ?? 0;
  console.log(`${project.name}: ${nx}x${ny}x${nz} cells, up to ${control.maxSteps} steps` +
    (multiport ? `, ${excited.length} run(s) (ports ${excited.map((n) => portIds[n]).join(', ')})` : '') +
    (componentCount ? `, ${componentCount} lumped component(s)` : ''));

  const farField: FarFieldRequest | null = farFieldGhz.length
    ? { surface: huygensSurface(model, huygensBoxInsidePml(model)), frequenciesHz: farFieldGhz.map((f) => f * 1e9) }
    : null;

  // Recorded before the solve: the source can change while a long run is going.
  const source = solverSource(warnings);
  const truncated = (energyDecayDb: number) => (Number.isNaN(energyDecayDb)
    ? `no energy check ran within ${a.stop.max_steps} steps (one runs every ${control.energyCheckEverySteps}); results are approximate`
    : `energy fell only ${energyDecayDb.toFixed(1)} dB of the requested ${a.stop.energy_decay_db} dB within ${a.stop.max_steps} steps; results are approximate`);
  const runLabel = (n: number) => (multiport ? `port "${portIds[excited[n]]}" run: ` : '');
  if (coaxPorts.length > 0) {
    if (farField) throw new Error('$.outputs.far_field_ghz: the far field is not computed with an sma_edge or coax_probe port yet');
    const t0 = performance.now();
    const gpu = useGpu ? await gpuEngine() : null;
    const solved = await solvePorts(model, coaxPorts, z0s, excited, exc, control, { engine: gpu?.factory });
    const solveMs = performance.now() - t0;
    solved.runs.forEach((r, n) => r.stoppedOnEnergy || warnings.push(runLabel(n) + truncated(r.energyDecayDb)));
    solved.unsplitGHz.forEach((fs, n) => fs.length && warnings.push(`port "${portIds[n]}": at ${fs.length} of ${exc.nFreq} frequencies ` +
      `(${Math.min(...fs).toFixed(2)} to ${Math.max(...fs).toFixed(2)} GHz) its probes are too close in wavelengths to split the waves on its coax, ` +
      'so the reflection from its far end is taken as zero there while another port drives'));
    const runSummaries = solved.runs.map((r, n) => ({ ...r, spec: spectrumFromScattering(solved.scattering, excited[n], z0s[excited[n]]) }));
    const lines = solved.lineImpedanceOhm.flatMap((z, n) => (z === null ? [] : [`"${portIds[n]}" ${z.toFixed(1)}`]));
    return {
      project, model, exc, control, excited, runs: [], runSummaries, samples: null, ...solved.runs[0], spec: runSummaries[0].spec,
      scattering: multiport ? solved.scattering : null, solver: `${gpu ? `WGSL on ${gpu.adapterName}` : 'CPU reference'}, coax feeds (line ohm on this mesh: ${lines.join(', ')})`,
      solveMs, source, farField: null, huygensAccumulators: null, warnings,
    };
  }
  const t0 = performance.now();
  const { runs, solver, huygensAccumulators } = useGpu
    ? await solveOnGpu(model, exc, control, farField, excited)
    : solveOnCpu(model, exc, control, farField, excited);
  const solveMs = performance.now() - t0;
  runs.forEach((samples, n) => samples.stoppedOnEnergy || warnings.push(runLabel(n) + truncated(samples.energyDecayDb)));
  const samples = runs[0];
  const runSummaries = runs.map((r, n) => ({
    steps: r.v.length, energyDecayDb: r.energyDecayDb, stoppedOnEnergy: r.stoppedOnEnergy, spec: portSpectrum(r, { ...exc, z0: z0s[excited[n]] }),
  }));
  const spec = runSummaries[0].spec;
  const scattering = multiport ? scatteringMatrix(runs.map((r, n) => ({ activePort: excited[n], samples: r })), z0s, exc) : null;
  return {
    project, model, exc, control, excited, runs, runSummaries, samples, steps: samples.v.length, energyDecayDb: samples.energyDecayDb, stoppedOnEnergy: samples.stoppedOnEnergy,
    spec, scattering, solver, solveMs, source, farField, huygensAccumulators: huygensAccumulators ?? null, warnings,
  };
}

/** A solve as the mesh check sees it: S, the grid's size, the runs' energy decay, and the solve itself. */
function levelOf(solved: ProjectSolve) {
  const { nx, ny, nz } = solved.model.grid;
  const hMm = boardCellSizeMm(solved.model.mesh, resolveProject(solved.project));
  return { s: scatteringOf(solved), cells: nx * ny * nz, hMm, runs: solved.runSummaries, solved };
}

function scatteringOf(solved: ProjectSolve): ScatteringResult {
  if (solved.scattering) return solved.scattering;
  const { spec, exc } = solved;
  const n = spec.fGHz.length;
  const [re, im] = [new Float64Array(n), new Float64Array(n)];
  for (let m = 0; m < n; m++) [re[m], im[m]] = gamma(spec.zRe[m], spec.zIm[m], exc.z0);
  return onePortScattering(spec.fGHz, re, im);
}

const roundOrNull = (x: number | null) => (x === null ? null : round6(x));
const gciJson = (e: GciEstimate | null) => e && {
  value: round6(e.value), uncertainty: round6(e.uncertainty), behaviour: e.behaviour, order: roundOrNull(e.order), observed_order: roundOrNull(e.observedOrder), extrapolated: roundOrNull(e.extrapolated),
};

/** result.json's "self_check" entry. */
function accuracyJson(r: AccuracyReport) {
  const c = r.convergence;
  return {
    mesh_convergence: c ? {
      method: 'Grid Convergence Index over the baseline and finer meshes (Roache 1994; Celik et al. 2008, J. Fluids Eng. 130, 078001; order clamped to 0.8 to 2 after Eca and Hoekstra 2014); Delta S as in adaptive FEM meshing',
      scope: BAND_SCOPE,
      mode: c.mode, ratio: round6(c.ratio), delta_s_tolerance: c.tolerance, converged: c.converged,
      levels: c.levels.map((l) => ({ scale: round6(l.scale), cells: l.cells, h_mm: round6(l.hMm), f_res_ghz: roundOrNull(l.fResGhz), s11_min: roundOrNull(l.s11Min), delta_s: roundOrNull(l.deltaS) })),
      f_res_ghz: gciJson(c.fResGhz),
      s11_min: gciJson(c.s11Min),
      refine_stopped: c.refineStopped,
    } : { mode: r.mode, unavailable: r.unavailable },
    checks: r.checks.map((x) => ({ name: x.name, passed: x.passed, marginal: x.marginal, worst: round6(x.worst), at_ghz: x.atGhz, limit: x.limit, detail: x.detail })),
    validated_envelope: r.envelope,
  };
}

/**
 * The solve with its self-check. With "refine" the returned solve is the
 * finest mesh's, and every output is written from it.
 */
export async function verifiedSolve(text: string, sourceName: string, useGpu: boolean, mode: AccuracyMode, deltaS: number, cpuWhenModelExceedsGpu = false) {
  const baseline = levelOf(await solveProjectText(text, sourceName, useGpu, cpuWhenModelExceedsGpu));
  const solveLevel = async (json: Record<string, any>, scale: number) => {
    console.log(`mesh level: cells x${scale.toFixed(3)}`);
    return levelOf(await solveProjectText(JSON.stringify(json), `${sourceName} (mesh x${scale})`, useGpu, cpuWhenModelExceedsGpu));
  };
  const { report, finest } = await assessAccuracy(JSON.parse(text), baseline, solveLevel, resolveProject(baseline.solved.project), { mode, tolerance: deltaS });
  finest.solved.warnings.push(...report.warnings);
  return { solved: finest.solved, accuracy: report };
}

/**
 * The ports that ask for it (ports[].deembed) removed with their feed lines:
 * each feed's calibration kit is solved the same way as the project, then the
 * error boxes are taken out of the full S-matrix (src/project/deembed_kit.ts).
 * Null when no port asks.
 */
export async function deembedSolve(solved: ProjectSolve, useGpu: boolean, cpuWhenModelExceedsGpu = false) {
  if (!resolveProject(solved.project).ports.some((p) => p.deembedMm !== null)) return null;
  const raw = scatteringOf(solved);
  const kitWarnings: string[] = [];
  const solveKit: KitSolver = async (kit) => {
    const run = await solveProjectText(JSON.stringify(kit), kit.name, useGpu, cpuWhenModelExceedsGpu);
    // The kit's own solver-source note repeats the project's; its run warnings (a truncated run) matter.
    kitWarnings.push(...run.warnings.filter((w) => !solved.warnings.includes(w)).map((w) => `kit "${kit.name}": ${w}`));
    return scatteringOf(run);
  };
  const done = await deembedProject(solved.project, raw, solveKit, (line) => console.log(line));
  return { raw, ...done, warnings: [...done.warnings, ...kitWarnings] };
}

const roundOrNullArray = (xs: Array<number | null>) => xs.map(roundOrNull);

/** result.json's "deembedding" entry. */
function deembeddingJson(ports: PortDeembedding[], rawFile: string, s: ScatteringResult) {
  const passive = passivityCheck(s);
  const reciprocal = reciprocityCheck(s);
  return {
    method: 'thru-line calibration (Engen and Hoer 1979) on a kit built from each feed: a mirror-symmetric thru of two feeds and longer lines; ' +
      'results refer to a plane deembed.length along the line, in the port\'s reference impedance, with the line impedance taken in the low-frequency limit',
    raw_file: rawFile,
    checks: [passive, ...(reciprocal ? [reciprocal] : [])].map((x) => ({ name: x.name, passed: x.passed, marginal: x.marginal, worst: round6(x.worst), at_ghz: x.atGhz, limit: x.limit, detail: x.detail })),
    ports: ports.map((p) => ({
      port: p.feed.portId,
      length_mm: p.feed.lengthMm,
      feed: {
        direction: p.feed.direction, signal_layer: p.feed.signalLayer, reference_layer: p.feed.referenceLayer, solid_layers: p.feed.solidLayers,
        width_mm: round6(p.feed.edgesMm[1] - p.feed.edgesMm[0]), offset_mm: round6((p.feed.edgesMm[0] + p.feed.edgesMm[1]) / 2), overhang_mm: round6(p.feed.overhangMm),
      },
      kit: {
        solves: p.kit.solves, reused_from: p.kit.reusedFrom, extra_lines_mm: p.kit.extraLinesMm.map(round6),
        band: { f_min_ghz: round6(p.kit.band.fMinGHz), f_max_ghz: p.kit.band.fMaxGHz, n_freq: p.kit.band.nFreq },
      },
      line: {
        z_ohm: round6(p.zLineOhm), z_fit_points: p.zFitPoints, z_fit_max_ghz: round6(p.zFitMaxGHz),
        eps_eff: roundOrNullArray(p.epsEff), loss_db_per_mm: roundOrNullArray(p.lossDbPerMm),
      },
      half_thru_ghz: p.halfThruGHz.map(round6),
    })),
  };
}

const rawFileName = (file: string) => file.replace(/\.(s\d+p)$/, '.raw.$1');

async function main(): Promise<void> {
  if (process.argv[2] === 'import') return runImportCommand(process.argv.slice(3));
  if (process.argv[2] === 'pair') return runPairCommand(process.argv.slice(3));
  const { projectPath, outDir, solverChoice, accuracy: accuracyMode, deltaS } = parseArgs(process.argv.slice(2));
  const text = readFileSync(projectPath, 'utf8');
  // De-embedding's refusals come before the solve, not after it. Bad JSON is left to the solve, which names the file.
  const json = (() => { try { return JSON.parse(text); } catch { return null; } })();
  if (json !== null) checkDeembedding(parseProject(json));
  const useGpu = await decideUseGpu(solverChoice);
  const { solved, accuracy: report } = await verifiedSolve(text, projectPath, useGpu, accuracyMode, deltaS, solverChoice === 'auto');
  const accuracy = accuracyJson(report);
  const deembedded = await deembedSolve(solved, useGpu, solverChoice === 'auto');
  const { project, model, exc, control, excited, samples, steps, energyDecayDb, stoppedOnEnergy, solver, solveMs, source, farField, huygensAccumulators, warnings } = solved;
  const z0All = project.ports.map((p) => p.reference_impedance_ohm);
  // With de-embedding every result below refers to the reference planes; the raw solve is kept beside it.
  const scattering = deembedded && solved.scattering ? deembedded.s : solved.scattering;
  const spec = deembedded ? spectrumFromScattering(deembedded.s, excited[0], z0All[excited[0]]) : solved.spec;
  const runSummaries = deembedded
    ? solved.runSummaries.map((run, n) => ({ ...run, spec: spectrumFromScattering(deembedded.s, excited[n], z0All[excited[n]]) }))
    : solved.runSummaries;
  if (deembedded) warnings.push(...deembedded.warnings);
  if (deembedded && farField) warnings.push('far_field.json is computed from the fields at the port; de-embedding changes the network results only');
  const portIds = project.ports.map((p) => p.id);
  const { nx, ny, nz } = model.grid;
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const portsInfo = project.ports.map((p, n) => ({
    id: p.id, z0_ohm: p.reference_impedance_ohm, node: { i: model.ports[n].i, j: model.ports[n].j }, excited: excited.includes(n),
  }));
  const provenance = {
    noburf_project: PROJECT_SCHEMA_VERSION,
    project_sha256: createHash('sha256').update(text).digest('hex'),
    mesh: { nx, ny, nz, dx_mm: model.grid.dxMm, max_cell_mm: largestCell(model.mesh), graded: project.mesh.graded !== undefined, courant: model.grid.courant, pml_cells: model.cpml.faces, signature: model.signature },
    excitation: exc,
    excited_ports: excited.map((n) => portIds[n]),
    components: project.components ?? [],
    run_control: control,
    solver: `noburf ${pkg.version} (${solver})`,
    ...source,
    warnings,
  };
  mkdirSync(outDir, { recursive: true });

  if (!scattering) {
    const port = project.ports[0];
    let iMin = 0;
    for (let m = 1; m < spec.s11Db.length; m++) if (spec.s11Db[m] < spec.s11Db[iMin]) iMin = m;
    const z0 = exc.z0;
    const touchstone = [
      `! NobuRF ${project.name}: port "${port.id}"${port.kind === 'sma_edge' || port.kind === 'coax_probe' ? ' (coax feed, referred to its flange)' : ''}` +
        `${deembedded ? `, de-embedded ${deembedded.ports[0].feed.lengthMm} mm along its feed` : ''}, ${steps} steps`,
      `# GHz S RI R ${z0}`,
      ...Array.from(spec.fGHz, (f, m) => {
        const [re, im] = gamma(spec.zRe[m], spec.zIm[m], z0);
        return `${f.toFixed(6)} ${re.toExponential(9)} ${im.toExponential(9)}`;
      }),
    ].join('\n') + '\n';
    const result = {
      project: project.name,
      f0_ghz: spec.fGHz[iMin],
      s11_min_db: spec.s11Db[iMin],
      zin: zinPoints(spec, project.outputs.zin_at_ghz, warnings),
      steps,
      energy_decay_db: finiteOrString(energyDecayDb),
      stopped_on_energy: stoppedOnEnergy,
      solve_ms: Math.round(solveMs),
      ports: portsInfo,
      ...(deembedded ? { deembedding: deembeddingJson(deembedded.ports, 's11.raw.s1p', deembedded.s) } : {}),
      self_check: accuracy,
      provenance,
    };
    if (deembedded) {
      const raw = [`! NobuRF ${project.name}: port "${port.id}" at the port, before de-embedding`, `# GHz S RI R ${z0}`, ...touchstoneLines(deembedded.raw)];
      writeFileSync(join(outDir, 's11.raw.s1p'), raw.join('\n') + '\n');
    }
    writeFileSync(join(outDir, 's11.s1p'), touchstone);
    writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`f0 ${result.f0_ghz.toFixed(3)} GHz, S11 min ${result.s11_min_db.toFixed(1)} dB, ${result.steps} steps -> ${outDir}`);
    if (farField && samples) {
      if (!huygensAccumulators) throw new Error('internal: a far field was requested but the solver returned no box DFT');
      const farFieldResults = nearToFarField({ ...farField, accumulators: huygensAccumulators, samples, exc });
      writeFileSync(join(outDir, 'far_field.json'), JSON.stringify(farFieldReport(project.name, farField.surface, model.mesh, farFieldResults, samples)) + '\n');
      const files = writePatternFiles(outDir, project.name, farFieldResults);
      if (!samples.stoppedOnEnergy) console.warn(`warning: far field: ${truncatedRunCaveat(samples.energyDecayDb)}`);
      for (const r of farFieldResults) {
        console.log(`far field ${r.frequencyHz / 1e9} GHz: D ${r.peakDirectivityDbi.toFixed(2)} dBi at theta ${r.peakThetaDeg}, phi ${r.peakPhiDeg}; ` +
          `G ${r.peakGainDbi.toFixed(2)} dBi; efficiency ${r.efficiency.toFixed(3)}`);
      }
      console.log(`patterns: ${files.join(', ')}`);
    }
  } else {
    const z0s = project.ports.map((p) => p.reference_impedance_ohm);
    const fileName = `sparams.s${portIds.length}p`;
    const writesTouchstone = scattering.method === 'full';
    if (writesTouchstone) {
      const header = [
        `! NobuRF ${project.name}: ports ${portIds.map((id, n) => `${n + 1} "${id}"`).join(', ')}; ${runSummaries.map((r) => r.steps).join(' + ')} steps` +
          (deembedded ? `; de-embedded: ${deembedded.ports.map((p) => `"${p.feed.portId}" ${p.feed.lengthMm} mm`).join(', ')}` : ''),
        `# GHz S RI R ${z0s[0]}`,
      ];
      writeFileSync(join(outDir, fileName), [...header, ...touchstoneLines(scattering)].join('\n') + '\n');
      if (deembedded) {
        const raw = [`! NobuRF ${project.name}: at the ports, before de-embedding`, header[1], ...touchstoneLines(deembedded.raw)];
        writeFileSync(join(outDir, rawFileName(fileName)), raw.join('\n') + '\n');
      }
    } else {
      warnings.push(`${fileName} not written: only ports ${provenance.excited_ports.join(', ')} were excited; result.json has their S-matrix columns, ` +
        `which assume the unexcited ports are matched (incident wave at most ${(100 * scattering.maxPassiveIncidentRatio).toFixed(1)} % of the excited one)`);
    }
    const pairDefs = project.outputs.differential_pairs;
    let differential: { file: string; throughs: unknown; ends: unknown } | null = null;
    if (pairDefs && !writesTouchstone) warnings.push('differential.json not written: mixed-mode S needs every port excited');
    else if (pairDefs) {
      // A pairing the analysis refuses (a port left out of every pair, say) must not cost the solve's other outputs.
      try {
        const pairs = pairSpecsFromIds(pairDefs, portIds);
        const report = analyseDifferential(scattering, z0s, pairs);
        const json = differentialJson(report, portIds, pairs, project.outputs.zin_at_ghz);
        writeFileSync(join(outDir, 'differential.json'), JSON.stringify(json, null, 2) + '\n');
        differential = { file: 'differential.json', throughs: json.throughs, ends: json.ends };
        for (const line of differentialSummaryLines(report)) console.log(line);
        const decay = Math.min(...runSummaries.map((r) => r.energyDecayDb));
        if (!(decay >= TIMING_ENERGY_DECAY_DB - 5)) {
          warnings.push(`differential.json: the runs stopped at ${Number.isFinite(decay) ? `${decay.toFixed(0)} dB energy decay` : "an unchecked energy decay"}; skew and the TDR level rest on the lowest frequencies, which need about ${TIMING_ENERGY_DECAY_DB} dB (analysis.stop.energy_decay_db)`);
        }
        const leaky = constantLossDielectrics(resolveProject(project));
        if (leaky.length && !report.timeDomainProblem) warnings.push(`differential.json: ${constantLossNote(leaky)}`);
      } catch (error) {
        warnings.push(`differential.json not written: ${(error as Error).message}`);
      }
    }
    const result = {
      project: project.name,
      ports: portsInfo,
      ...(differential ? { differential } : {}),
      s_parameters: {
        file: writesTouchstone ? fileName : null,
        method: scattering.method,
        max_passive_incident_ratio: scattering.maxPassiveIncidentRatio,
        summary: scatteringSummary(scattering, portIds),
      },
      ...(deembedded ? { deembedding: deembeddingJson(deembedded.ports, rawFileName(fileName), deembedded.s) } : {}),
      runs: runSummaries.map((run, n) => ({
        excited_port: portIds[excited[n]],
        zin: zinPoints(run.spec, project.outputs.zin_at_ghz, warnings),
        steps: run.steps,
        energy_decay_db: finiteOrString(run.energyDecayDb),
        stopped_on_energy: run.stoppedOnEnergy,
      })),
      solve_ms: Math.round(solveMs),
      self_check: accuracy,
      provenance,
    };
    writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    for (const row of result.s_parameters.summary) {
      console.log(`${row.s} (${row.from} -> ${row.to}): ${row.min_db.toFixed(2)} to ${row.max_db.toFixed(2)} dB`);
    }
    console.log(`${runSummaries.length} run(s), ${scattering.method} S-matrix -> ${outDir}`);
  }
  for (const p of deembedded?.ports ?? []) {
    const ee = p.epsEff.filter((x): x is number => x !== null);
    console.log(`de-embedded "${p.feed.portId}": ${p.feed.lengthMm} mm of line, Z ${p.zLineOhm.toFixed(2)} ohm` +
      (ee.length ? `, eps_eff ${Math.min(...ee).toFixed(3)} to ${Math.max(...ee).toFixed(3)}` : '') + (p.kit.reusedFrom ? ` (kit of "${p.kit.reusedFrom}")` : `, ${p.kit.solves} kit solves`));
  }
  if (report.convergence) console.log(convergenceSummary(report.convergence));
  for (const c of report.checks) console.log(`${c.name}: ${c.passed ? 'pass' : 'FAIL'}, ${c.detail}`);
  for (const w of warnings) console.warn(`warning: ${w}`);
}

// Run only when executed, so tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(
    () => process.exit(0), // Dawn keeps the event loop alive after the device is done.
    (e) => {
      console.error((e as Error).message);
      process.exit(1);
    },
  );
}
