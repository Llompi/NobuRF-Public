/**
 * The workbench's solve: the same path as `noburf solve` (scripts/noburf.ts),
 * without the file system, plus the field monitors the result views draw.
 * Runs inside the solve worker, so it never blocks the page.
 *
 * WebGPU when the worker has an adapter, else the CPU reference solver. Both
 * report progress at each energy check and accumulate the same z-plane field
 * DFT (engine/plane_dft.ts) for the field plots.
 */
import { ENERGY_STOP_RUN, timestepSec } from '../engine/config';
import { solvePorts, type CoaxPort } from '../engine/coax_feed';
import { boresightPolarisation, patternFigures } from '../engine/far_field_pattern';
import { CpuFdtd, type StepRecorder } from '../engine/fdtd_cpu';
import { PlaneDftRecorder } from '../engine/plane_dft';
import { VolumeDftRecorder, volumeDftBytes } from '../engine/volume_dft';
import { HuygensDftRecorder, huygensBoxInsidePml, huygensSurface, type HuygensSurface } from '../engine/huygens_box';
import { largestCell, smallestCell, type MeshLines } from '../engine/mesh';
import { boxSources, fieldStrengthAt, scanPlane, scanPlanesK, type ScanPlane } from '../engine/near_field';
import { nearToFarField, sourcePhasor, type FarFieldResult } from '../engine/near_to_far';
import { type PlaneDftLayout } from '../engine/plane_dft';
import { portSpectrum, s11FromZ, scatteringMatrix, type ScatteringResult, type Spectrum } from '../engine/port_dft';
import type { ExcitationConfig, PortSamples, RunControl } from '../engine/types';
import type { VoxelModel } from '../engine/voxelize';
import { checkDeembedding, deembedProject, type KitSolver, type PortDeembedding } from '../project/deembed_kit';
import { rasterise } from '../project/rasterise';
import { resolveProject, type ResolvedProject } from '../project/resolve';
import { parseProject } from '../project/schema';
import { assessAccuracy, boardCellSizeMm, type AccuracyMode, type AccuracyReport } from '../verify/accuracy';
import { DEFAULT_DELTA_S } from '../verify/convergence';
import { fieldPlanesFromDft, planeDftRequest, type FieldPlanes } from './plane_dft';

export type SolverChoice = 'auto' | 'cpu';

export interface SolveProgress {
  /** 0-based run (one per excited port) and how many runs there are. */
  run: number;
  runs: number;
  step: number;
  maxSteps: number;
  /** Energy fall since its peak, dB; null before the first check or on the GPU. */
  decayDb: number | null;
  targetDb: number;
  /** The time loop, then the work after it that has no step count. */
  stage: 'solving' | 'reading-fields' | 'far-field';
  /** Set while a mesh-check level runs: its cell size relative to the project's mesh. */
  meshScale?: number;
}

export interface SolveStart {
  solver: string;
  nx: number;
  ny: number;
  nz: number;
  smallestCellMm: number;
  largestCellMm: number;
  runs: number;
  maxSteps: number;
  warnings: string[];
}

export interface RunSummary {
  portId: string;
  steps: number;
  energyDecayDb: number;
  stoppedOnEnergy: boolean;
  /** Z_in at this port with every other port loaded by its reference impedance. */
  spectrum: Spectrum;
}

export interface FarFieldSummary {
  result: FarFieldResult;
  polarisation: 'x' | 'y';
  beamwidthEPlaneDeg: number | null;
  beamwidthHPlaneDeg: number | null;
  frontToBackDb: number;
  crossPolarDb: number;
  /** |E| (V/m, peak, 1 V source) at 3 m and 10 m in the direction of peak directivity, from the full transform. */
  fieldAt3mVPerM: number;
  fieldAt10mVPerM: number;
}

/** E and H on a plane above the board, like an EMC near-field probe scan. */
export interface NearFieldScan {
  /** The height asked for, above the top copper, and the height of the mesh plane it landed on. */
  heightMm: number;
  meshHeightMm: number;
  /** One per field-plot frequency, in the order of FieldMaps.planes: V/m and A/m, peak, for a 1 V source. */
  planes: ScanPlane[];
}

export interface FieldMaps {
  /** Node coordinates (mm) of the planes, and how many PML cells to leave out on each side. */
  xMm: Float64Array;
  yMm: Float64Array;
  pml: { xLow: number; xHigh: number; yLow: number; yHigh: number };
  ezLayer: string;
  ezZMm: number;
  copperLayer: string;
  copperZMm: number;
  /** 1 on the nodes of the copper layer that lie on copper, for outlines over the maps. */
  copperMask: Uint8Array;
  planes: FieldPlanes[];
  /** E and H at every node for cuts through the solve box, or why they were not kept. */
  volume: FieldVolume | null;
  volumeSkipped: string | null;
  /** Whether the solve was asked to keep the volume (Cut mode on when it started). */
  volumeAsked: boolean;
}

/**
 * The whole-grid field DFT of the first run (engine/volume_dft.ts), for the
 * first `frequencies` entries of FieldMaps.planes: as many as fit
 * VOLUME_BUDGET_BYTES. src/workbench/field_cut.ts reads cuts from it.
 */
export interface FieldVolume {
  zMm: Float64Array;
  /** CPML cells on the low and high z faces (x and y are in FieldMaps.pml). */
  pmlZ: { low: number; high: number };
  frequencies: number;
  accumulators: Float32Array;
}

export interface WorkbenchResult {
  projectName: string;
  /** The exact project text that was solved, so the page can tell when results go stale. */
  projectText: string;
  /** outputs.zin_at_ghz: where the views report Z and put their marker. */
  zinGHz: number[];
  /** Port positions (mm) and the copper layers each spans, in file order. */
  ports: Array<{ id: string; xMm: number; yMm: number; between: [string, string] }>;
  solver: string;
  solveMs: number;
  grid: { nx: number; ny: number; nz: number; smallestCellMm: number; largestCellMm: number; boardCellMm: number };
  portIds: string[];
  z0: number[];
  excited: number[];
  runs: RunSummary[];
  /** S_ij over the band; for one port, S11 from Z_in. Columns of unexcited ports are null. */
  s: ScatteringResult;
  farField: { entries: FarFieldSummary[]; caveat: string | null } | null;
  fields: FieldMaps | null;
  nearField: NearFieldScan[] | null;
  /** The self-check: mesh convergence, passivity, reciprocity, energy decay, validated envelope. */
  accuracy: AccuracyReport | null;
  /** Ports de-embedded along their feeds (ports[].deembed): s and the runs' spectra then refer to the reference planes. Null when none. */
  deembedding: PortDeembedding[] | null;
  warnings: string[];
}

export interface SolveHooks {
  onStart(start: SolveStart): void;
  onProgress(progress: SolveProgress): void;
}

/** Most field-plot frequencies: each adds a plane DFT every CPU step. */
const MAX_FIELD_FREQUENCIES = 4;
/**
 * Most memory the whole-grid field DFT may take: 64 MiB, half of WebGPU's
 * guaranteed storage binding size. The GPU holds it twice while it runs
 * (accumulators and their read-back buffer), so up to 128 MiB there, which keeps the GPU's accumulator and
 * read-back buffers and the copy sent to the page modest. The patch example
 * (66 x 66 x 48 nodes) needs 10 MiB per frequency.
 */
export const VOLUME_BUDGET_BYTES = 64 * 2 ** 20;

/** How many of the field frequencies the volume DFT can keep on this grid, 0 to all. */
export function volumeFrequencies(grid: { nx: number; ny: number; nz: number }, frequencies: number): number {
  let n = frequencies;
  while (n > 0 && volumeDftBytes(grid, n) > VOLUME_BUDGET_BYTES) n--;
  return n;
}

/** Field plots at the far-field and Z_in frequencies, else mid-band. */
export function fieldFrequenciesGHz(project: ReturnType<typeof parseProject>): number[] {
  const a = project.analysis;
  const listed = [...(project.outputs.far_field_ghz ?? []), ...project.outputs.zin_at_ghz];
  const unique = [...new Set(listed)].slice(0, MAX_FIELD_FREQUENCIES);
  return unique.length ? unique : [(a.f_min_ghz + a.f_max_ghz) / 2];
}

/**
 * z of every copper layer (mm, stackup bottom at 0) as the rasteriser places
 * it: on a uniform mesh each dielectric is a whole number of cells.
 */
export function copperLayerZ(r: ResolvedProject): Map<string, number> {
  const z = new Map<string, number>();
  let top = 0;
  for (const layer of r.stackup) {
    if (layer.type === 'copper') z.set(layer.name, top);
    else top += r.graded ? layer.thicknessMm : Math.round(layer.thicknessMm / r.cellMm) * r.cellMm;
  }
  return z;
}

const nearestIndex = (lines: Float64Array, value: number) => {
  let best = 0;
  for (let n = 1; n < lines.length; n++) if (Math.abs(lines[n] - value) < Math.abs(lines[best] - value)) best = n;
  return best;
};

/** The planes to monitor: the top copper layer and the middle of the dielectric under it. */
function monitorPlanes(r: ResolvedProject, mesh: MeshLines) {
  const copperZ = copperLayerZ(r);
  const copperNames = [...copperZ.keys()];
  const copperLayer = copperNames.at(-1)!;
  const copperZMm = copperZ.get(copperLayer)!;
  const below = copperNames.length > 1 ? copperZ.get(copperNames.at(-2)!)! : 0;
  const index = r.stackup.findIndex((l) => l.type === 'copper' && l.name === copperLayer);
  const dielectric = r.stackup.slice(0, index).reverse().find((l) => l.type === 'dielectric')!;
  const ezZMm = (below + copperZMm) / 2;
  // Ez of cell k sits at the cell's centre; take the cell that contains the mid-plane.
  let ezK = 0;
  while (ezK + 1 < mesh.z.length - 1 && mesh.z[ezK + 1] <= ezZMm) ezK++;
  return { copperLayer, copperZMm, copperK: nearestIndex(mesh.z, copperZMm), ezLayer: dielectric.name, ezZMm, ezK };
}

/** Calls each recorder in turn. */
const allOf = (recorders: Array<StepRecorder | undefined>): StepRecorder => ({
  afterStep: (n, sim) => recorders.forEach((r) => r?.afterStep(n, sim)),
});

/** Progress every `every` steps, with the energy fall since its peak (the quantity the energy stop uses). */
function progressRecorder(every: number, report: (step: number, decayDb: number | null) => void): StepRecorder {
  let peak = 0;
  return {
    afterStep(n, sim) {
      if ((n + 1) % every !== 0) return;
      const energy = sim.energy();
      peak = Math.max(peak, energy);
      report(n + 1, peak > 0 && energy > 0 ? 10 * Math.log10(peak / energy) : null);
    },
  };
}

interface Solved {
  runs: PortSamples[];
  solver: string;
  huygensAccumulators: ArrayLike<number> | null;
  /** The plane DFT of the first run, in `layout`. */
  planeAccumulators: ArrayLike<number>;
  /** The volume DFT of the first run, or null when it was not asked for. */
  volumeAccumulators: Float32Array | null;
}

async function gpuAvailable(): Promise<boolean> {
  const gpu = (globalThis.navigator as Navigator | undefined)?.gpu;
  if (!gpu) return false;
  return (await gpu.requestAdapter({ powerPreference: 'high-performance' })) !== null;
}

/**
 * `work`, or a rejection as soon as `device` is lost. Losing the device is
 * not reported through the work's own promises: a pending buffer map may
 * never settle, which would leave the solve running forever.
 */
export function failOnDeviceLoss<T>(device: Pick<GPUDevice, 'lost'>, work: Promise<T>): Promise<T> {
  const lost = device.lost.then((info): never => {
    throw new Error(`The GPU stopped during the solve (${info.message || info.reason}). Drivers do this when a GPU job runs too long or the laptop switches graphics cards. Solve again, or choose "CPU only".`);
  });
  // destroy() at the end of every solve settles `lost` too; nothing waits on it then.
  lost.catch(() => undefined);
  return Promise.race([work, lost]);
}

async function solveOnGpu(
  model: VoxelModel, exc: ExcitationConfig, control: RunControl, farField: { surface: HuygensSurface; frequenciesHz: number[] } | null,
  excited: number[], layout: PlaneDftLayout, volumeHz: number[], hooks: SolveHooks,
): Promise<Solved> {
  const { Fdtd3D } = await import('../engine/fdtd3d');
  let engine: InstanceType<typeof Fdtd3D>;
  try {
    engine = await Fdtd3D.create(model.grid, control.maxSteps);
  } catch (error) {
    throw new Error(`WebGPU setup failed for this ${model.grid.nx} × ${model.grid.ny} × ${model.grid.nz} grid: ${(error as Error).message}. Choose "CPU only" to solve it on the processor.`);
  }
  // A lost device (driver reset, GPU switch) can leave a readback pending forever; this ends the solve instead.
  const untilLost = <T>(work: Promise<T>) => failOnDeviceLoss(engine.device, work);
  try {
    engine.load(model, exc);
    if (farField) engine.enableHuygensDft(farField.surface, farField.frequenciesHz);
    engine.enablePlaneDft(layout.planesK, layout.frequenciesHz);
    if (volumeHz.length) engine.enableVolumeDft(volumeHz);
    const target = control.stopAtEnergyDecayDb ?? 0;
    const runs: PortSamples[] = [];
    let huygensAccumulators: Float32Array | null = null;
    let planeAccumulators: ArrayLike<number> = new Float32Array(0);
    let volumeAccumulators: Float32Array | null = null;
    // The field plots and the far field show the first excited port's run; each run restarts the DFT sums.
    for (const [n, activePort] of excited.entries()) {
      hooks.onProgress({ run: n, runs: excited.length, step: 0, maxSteps: control.maxSteps, decayDb: null, targetDb: target, stage: 'solving' });
      runs.push(await untilLost(engine.run({ control, activePort,
        onProgress: (step, decayDb) => hooks.onProgress({ run: n, runs: excited.length, step, maxSteps: control.maxSteps, decayDb, targetDb: target, stage: 'solving' }) })));
      if (n > 0) continue;
      hooks.onProgress({ run: n, runs: excited.length, step: control.maxSteps, maxSteps: control.maxSteps, decayDb: null, targetDb: target, stage: 'reading-fields' });
      if (farField) huygensAccumulators = await untilLost(engine.readHuygensDft());
      planeAccumulators = await untilLost(engine.readPlaneDft());
      if (volumeHz.length) {
        volumeAccumulators = await untilLost(engine.readVolumeDft());
        // Only the first run's fields are drawn: the other runs need not pay for the whole-grid DFT.
        engine.disableVolumeDft();
      }
    }
    return { runs, solver: `WebGPU, ${engine.adapterName}`, huygensAccumulators, planeAccumulators, volumeAccumulators };
  } finally {
    engine.destroy();
    engine.device.destroy();
  }
}

function solveOnCpu(
  model: VoxelModel, exc: ExcitationConfig, control: RunControl, farField: { surface: HuygensSurface; frequenciesHz: number[] } | null,
  excited: number[], layout: PlaneDftLayout, volumeHz: number[], hooks: SolveHooks,
): Solved {
  const dt = timestepSec(model.grid);
  const huygens = farField ? new HuygensDftRecorder(farField.surface, farField.frequenciesHz, dt) : undefined;
  const planeDft = new PlaneDftRecorder(model.grid, layout.planesK, layout.frequenciesHz, dt);
  const volumeDft = volumeHz.length ? new VolumeDftRecorder(model.grid, volumeHz, dt) : undefined;
  const solver = new CpuFdtd(model);
  const target = control.stopAtEnergyDecayDb ?? 0;
  const runs = excited.map((activePort, n) => {
    const progress = progressRecorder(control.energyCheckEverySteps, (step, decayDb) =>
      hooks.onProgress({ run: n, runs: excited.length, step, maxSteps: control.maxSteps, decayDb, targetDb: target, stage: 'solving' }));
    // The field plots and the far field show the first excited port's run.
    const first = n === 0;
    return solver.run(exc, control, allOf([progress, first ? huygens : undefined, first ? planeDft : undefined, first ? volumeDft : undefined]), activePort);
  });
  return {
    runs, solver: 'CPU reference solver', huygensAccumulators: huygens?.accumulators ?? null,
    planeAccumulators: planeDft.accumulators, volumeAccumulators: volumeDft?.accumulators ?? null,
  };
}

/**
 * Coax ports (SMA edge connectors, coax probes), mixed with any lumped ports:
 * one CPU run per excited port and a calibration run per coax line
 * (coax_feed.ts solvePorts). S is referred to each port's reference
 * impedance; the field maps come from the first run.
 */
async function solveCoaxOnCpu(
  model: VoxelModel, coaxPorts: readonly CoaxPort[], z0: number[], excited: number[], exc: ExcitationConfig, control: RunControl,
  layout: PlaneDftLayout, volumeHz: number[], hooks: SolveHooks,
): Promise<{ runs: Array<Omit<RunSummary, 'portId'>>; s: ScatteringResult; lineImpedanceOhm: Array<number | null>; planeAccumulators: Float64Array; volumeAccumulators: Float32Array | null }> {
  const dt = timestepSec(model.grid);
  const planeDft = new PlaneDftRecorder(model.grid, layout.planesK, layout.frequenciesHz, dt);
  const volumeDft = volumeHz.length ? new VolumeDftRecorder(model.grid, volumeHz, dt) : undefined;
  // Progress covers every run, the calibration runs (one per coax port, after the board runs) included.
  const solved = await solvePorts(model, coaxPorts, z0, excited, exc, control, {
    recorder: allOf([planeDft, volumeDft]),
    onProgress: (run, runs, step, decayDb) =>
      hooks.onProgress({ run, runs, step, maxSteps: control.maxSteps, decayDb, targetDb: control.stopAtEnergyDecayDb ?? 0, stage: 'solving' }),
  });
  return {
    runs: solved.runs.map((run) => ({
      steps: run.steps, energyDecayDb: run.energyDecayDb, stoppedOnEnergy: run.stoppedOnEnergy,
      spectrum: spectrumFromScattering(solved.scattering, run.activePort, z0[run.activePort]),
    })),
    s: solved.scattering,
    lineImpedanceOhm: solved.lineImpedanceOhm,
    planeAccumulators: planeDft.accumulators,
    volumeAccumulators: volumeDft?.accumulators ?? null,
  };
}

/** Z_in and |S_jj| in dB at port j, from the diagonal of S: Z = z0 (1 + S) / (1 - S). */
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

function fieldMaps(
  model: VoxelModel, planes: ReturnType<typeof monitorPlanes>, solvedPlanes: FieldPlanes[],
  volumeAccumulators: Float32Array | null, volumeHz: number[], fieldVolume: boolean,
): FieldMaps {
  const pml = model.cpml.faces;
  const volume: FieldVolume | null = volumeAccumulators && {
    zMm: model.mesh.z, pmlZ: { low: pml.zLow, high: pml.zHigh }, frequencies: volumeHz.length, accumulators: volumeAccumulators,
  };
  return {
    xMm: model.mesh.x, yMm: model.mesh.y,
    pml: { xLow: pml.xLow, xHigh: pml.xHigh, yLow: pml.yLow, yHigh: pml.yHigh },
    ezLayer: planes.ezLayer, ezZMm: planes.ezZMm, copperLayer: planes.copperLayer, copperZMm: planes.copperZMm,
    copperMask: copperMask(model, planes.copperK),
    planes: solvedPlanes,
    volume,
    volumeSkipped: fieldVolume ? volumeSkippedReason(model.grid, solvedPlanes.length, volumeHz.length)
      : 'Cuts record E and H everywhere in the box, which slows the solve, so they are recorded only when Cut is on as the solve starts.',
    volumeAsked: fieldVolume,
  };
}

/** Why cuts are missing at some or all field frequencies, in the words the model view shows; null when every frequency has them. */
function volumeSkippedReason(grid: { nx: number; ny: number; nz: number }, frequencies: number, kept: number): string | null {
  if (kept === frequencies) return null;
  const perFrequencyMiB = volumeDftBytes(grid, 1) / 2 ** 20;
  const budgetMiB = VOLUME_BUDGET_BYTES / 2 ** 20;
  return `Cuts through the box need ${perFrequencyMiB.toFixed(0)} MiB per frequency on this ${grid.nx} × ${grid.ny} × ${grid.nz} grid, ` +
    `over the ${budgetMiB} MiB kept for them, so ${kept === 0 ? 'none were kept' : `only the first ${kept === 1 ? 'frequency has' : `${kept} frequencies have`} them`}.`;
}

/** Nodes of plane k that touch a copper edge: an Ex or Ey edge there carries no curl (PEC, or a lossy sheet). */
function copperMask(model: VoxelModel, k: number): Uint8Array {
  const { nx, ny, nz } = model.grid;
  const N = nx * ny * nz;
  const mask = new Uint8Array(nx * ny);
  const isMetal = (index: number) => model.eCurl[index] === 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cell = i + nx * (j + ny * k);
    const edges = [cell, N + cell, i > 0 ? cell - 1 : -1, j > 0 ? N + cell - nx : -1];
    if (edges.some((e) => e >= 0 && isMetal(e))) mask[i + nx * j] = 1;
  }
  return mask;
}

/**
 * The node plane of each near-field scan height (mm above the top copper),
 * checked against where the solver's fields are free-space fields: above the
 * copper and below the PML on top.
 */
export function nearFieldPlanes(heightsMm: readonly number[], model: VoxelModel, copperK: number): Array<{ heightMm: number; k: number; meshHeightMm: number }> {
  const z = model.mesh.z;
  const lastClean = model.grid.nz - model.cpml.faces.zHigh - 2;
  const planes = heightsMm.map((heightMm) => {
    const k = nearestIndex(z, z[copperK] + heightMm);
    const meshHeightMm = z[k] - z[copperK];
    if (k <= copperK) throw new Error(`The near-field scan at ${heightMm} mm is closer to the copper than one cell (${(z[copperK + 1] - z[copperK]).toPrecision(2)} mm). Scan higher.`);
    if (k > lastClean) {
      throw new Error(`The near-field scan at ${heightMm} mm is above the free air of the solve box (up to ${(z[lastClean] - z[copperK]).toFixed(1)} mm over the copper). ` +
        'Raise mesh.air_margin_cells.above, or scan lower.');
    }
    if (!airAround(model, k)) {
      throw new Error(`The near-field scan at ${heightMm} mm lies in or next to a dielectric or metal above the copper (a solder mask, say). ` +
        'Scan higher, where there is only air within a cell of the plane.');
    }
    return { heightMm, k, meshHeightMm };
  });
  for (let n = 1; n < planes.length; n++) {
    const same = planes.find((p, m) => m < n && p.k === planes[n].k);
    if (same) throw new Error(`The near-field scans at ${same.heightMm} and ${planes[n].heightMm} mm land on the same mesh plane (${planes[n].meshHeightMm.toFixed(2)} mm). Drop one.`);
  }
  return planes;
}

/**
 * True when every E edge the scan at node plane k reads is plain air: Ex and Ey
 * on the plane, and Ez in the cells below and above it, which it interpolates
 * between (across a dielectric surface that would be wrong).
 */
function airAround(model: VoxelModel, k: number): boolean {
  const { nx, ny, nz, courant } = model.grid;
  const N = nx * ny * nz;
  const airCurl = Math.fround(courant);
  const edges: Array<[component: number, plane: number]> = [[0, k], [1, k], [2, k - 1], [2, k]];
  for (const [component, plane] of edges) {
    for (let c = 0; c < nx * ny; c++) {
      const index = component * N + plane * nx * ny + c;
      if (model.eDecay[index] !== 1 || model.eCurl[index] !== airCurl) return false;
    }
  }
  return true;
}

/** One-port S11 as a ScatteringResult, from Z_in. */
function oneportScattering(spec: Spectrum, z0: number): ScatteringResult {
  const re = new Float64Array(spec.fGHz.length);
  const im = new Float64Array(spec.fGHz.length);
  spec.fGHz.forEach((_, m) => {
    const [zr, zi] = [spec.zRe[m], spec.zIm[m]];
    if (!Number.isFinite(zr) || !Number.isFinite(zi)) {
      re[m] = 1;
      return;
    }
    const den = (zr + z0) ** 2 + zi * zi;
    re[m] = ((zr - z0) * (zr + z0) + zi * zi) / den;
    im[m] = (2 * zi * z0) / den;
  });
  return { fGHz: spec.fGHz, re: [[re]], im: [[im]], method: 'full', maxPassiveIncidentRatio: 0 };
}

/** The warning for a run that hit max_steps before the field fell as far as asked. */
function notRungDown(run: RunSummary, multiport: boolean, stop: { energy_decay_db: number; max_steps: number }): string {
  const which = multiport ? `Port ${run.portId}: ` : '';
  const fell = Number.isFinite(run.energyDecayDb) ? `the field fell ${run.energyDecayDb.toFixed(1)} dB` : 'no energy check ran';
  const text = `${which}${fell} of the ${stop.energy_decay_db} dB asked for within ${stop.max_steps} steps, so the results are approximate. Raise analysis.stop.max_steps.`;
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * The solve and its self-check (verify/accuracy.ts). "check" adds one finer
 * mesh; "refine" up to two, until S and the resonance settle. Either way the
 * result is the finest mesh's.
 */
export async function solveWorkbenchProject(projectText: string, choice: SolverChoice, hooks: SolveHooks, accuracy: AccuracyMode, fieldVolume = false): Promise<WorkbenchResult> {
  // A mesh check solves several meshes and shows the finest, which is not known in advance: no level records cuts.
  const baseline = await solveOnce(projectText, choice, hooks, fieldVolume && accuracy === 'off');
  if (accuracy === 'off') return deembedResult(baseline, choice, hooks);
  const json = JSON.parse(projectText);
  const levelOf = (r: WorkbenchResult) => ({ s: r.s, cells: r.grid.nx * r.grid.ny * r.grid.nz, hMm: r.grid.boardCellMm, runs: r.runs, result: r });
  const solveLevel = async (levelJson: Record<string, any>, scale: number) => {
    const levelHooks: SolveHooks = { onStart: () => undefined, onProgress: (p) => hooks.onProgress({ ...p, meshScale: scale }) };
    return levelOf(await solveOnce(JSON.stringify(levelJson), choice, levelHooks, false));
  };
  const { report, finest } = await assessAccuracy(json, levelOf(baseline), solveLevel, resolveProject(parseProject(json)), { mode: accuracy, tolerance: DEFAULT_DELTA_S });
  // De-embedded with kits on the finest level's mesh (its project text, before the line below replaces it).
  const r = await deembedResult(finest.result, choice, hooks);
  // The finest level's numbers, under the project as the user wrote it, so staleness checks still match.
  const fields = r.fields && fieldVolume
    ? { ...r.fields, volumeAsked: true, volumeSkipped: 'Cuts are recorded only with Mesh check off: the check solves several meshes and keeps the finest.' }
    : r.fields;
  return { ...r, fields, projectName: baseline.projectName, projectText, accuracy: report, warnings: [...r.warnings, ...report.warnings] };
}

/**
 * The ports that ask for it (ports[].deembed) removed with their feeds, as
 * noburf solve does: each feed's kit is solved like the project, then its
 * error box is taken out of S, and the runs' Z follow the new S.
 */
async function deembedResult(r: WorkbenchResult, choice: SolverChoice, hooks: SolveHooks): Promise<WorkbenchResult> {
  const project = parseProject(JSON.parse(r.projectText));
  if (!resolveProject(project).ports.some((p) => p.deembedMm !== null)) return r;
  const kitHooks: SolveHooks = { onStart: () => undefined, onProgress: hooks.onProgress };
  const kitWarnings: string[] = [];
  const solveKit: KitSolver = async (kit) => {
    const solved = await solveOnce(JSON.stringify(kit), choice, kitHooks, false);
    kitWarnings.push(...solved.warnings.map((w) => `Calibration kit ${kit.name}: ${w}`));
    return solved.s;
  };
  const done = await deembedProject(project, r.s, solveKit);
  return {
    ...r,
    s: done.s,
    runs: r.runs.map((run, n) => ({ ...run, spectrum: spectrumFromScattering(done.s, r.excited[n], r.z0[r.excited[n]]) })),
    deembedding: done.ports,
    warnings: [...r.warnings, ...done.warnings, ...kitWarnings],
  };
}

async function solveOnce(projectText: string, choice: SolverChoice, hooks: SolveHooks, fieldVolume: boolean): Promise<WorkbenchResult> {
  const project = parseProject(JSON.parse(projectText));
  const resolved = resolveProject(project);
  // De-embedding's refusals come before the solve, not after it.
  checkDeembedding(project);
  const { model, warnings, coaxPorts } = rasterise(project);
  const portIds = project.ports.map((p) => p.id);
  const z0 = project.ports.map((p) => p.reference_impedance_ohm);
  const multiport = portIds.length > 1;
  const coax = coaxPorts.length > 0;
  // With a coax port, S is renormalised from the coax line to each port's reference impedance, which needs every port excited.
  const excited = coax && multiport ? portIds.map((_, n) => n) : resolved.excite;
  if (excited.length > resolved.excite.length) warnings.push('Every port is excited: with a coax port, S is renormalized from the meshed coax to the reference impedance, which takes a run from each port.');
  // One value for all ports, so the Touchstone file's single R and the line views stay right.
  if (multiport && excited.length === portIds.length && new Set(z0).size > 1) {
    throw new Error(`The ports have different reference impedances (${z0.join(', ')} Ω). The S-matrix needs one value for all of them.`);
  }
  const farFieldGhz = project.outputs.far_field_ghz ?? [];
  if (multiport && farFieldGhz.length) throw new Error('The far field is computed for one-port projects only. Remove outputs.far_field_ghz or all but one port.');

  const a = project.analysis;
  const exc: ExcitationConfig = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: z0[excited[0]] };
  const control: RunControl = { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: ENERGY_STOP_RUN.energyCheckEverySteps };
  const farField = farFieldGhz.length
    ? { surface: huygensSurface(model, huygensBoxInsidePml(model)), frequenciesHz: farFieldGhz.map((f) => f * 1e9) }
    : null;
  const planes = monitorPlanes(resolved, model.mesh);
  const scans = nearFieldPlanes(project.outputs.near_field_mm ?? [], model, planes.copperK);
  const layout: PlaneDftLayout = {
    nx: model.grid.nx, ny: model.grid.ny, frequenciesHz: fieldFrequenciesGHz(project).map((f) => f * 1e9),
    planesK: [...new Set([...planeDftRequest(planes), ...scans.flatMap((scan) => scanPlanesK(scan.k))])],
  };

  const volumeHz = fieldVolume ? layout.frequenciesHz.slice(0, volumeFrequencies(model.grid, layout.frequenciesHz.length)) : [];

  // Coax ports run on the CPU only (coax_feed.ts).
  const useGpu = !coax && choice === 'auto' && (await gpuAvailable());
  const grid = {
    nx: model.grid.nx, ny: model.grid.ny, nz: model.grid.nz,
    smallestCellMm: smallestCell(model.mesh), largestCellMm: largestCell(model.mesh), boardCellMm: boardCellSizeMm(model.mesh, resolved),
  };
  const startWarnings = [...warnings];
  if (choice === 'auto' && !coax && !useGpu) {
    startWarnings.push('This browser has no WebGPU adapter, so the solve runs on the CPU, which is much slower. Chrome or Edge with hardware acceleration on uses the GPU.');
  }
  hooks.onStart({ solver: useGpu ? 'WebGPU' : 'CPU', ...grid, runs: excited.length, maxSteps: control.maxSteps, warnings: startWarnings });

  const t0 = performance.now();
  if (coax) {
    if (farField) throw new Error('The far field is not computed with an SMA connector or coax probe yet. Remove outputs.far_field_ghz, or use lumped ports.');
    if (scans.length) throw new Error('The near-field scan is not computed with an SMA connector or coax probe yet. Remove outputs.near_field_mm, or use lumped ports.');
    const solved = await solveCoaxOnCpu(model, coaxPorts, z0, excited, exc, control, layout, volumeHz, hooks);
    const solveMs = performance.now() - t0;
    const runs: RunSummary[] = solved.runs.map((run, n) => ({ portId: portIds[excited[n]], ...run }));
    runs.forEach((run) => run.stoppedOnEnergy || warnings.push(notRungDown(run, multiport, a.stop)));
    const lines = solved.lineImpedanceOhm.flatMap((z, n) => (z === null ? [] : [`${portIds[n]} ${z.toFixed(1)} Ω`]));
    return {
      projectName: project.name, projectText, zinGHz: project.outputs.zin_at_ghz,
      ports: resolved.ports.map((p) => ({ id: p.id, xMm: p.xMm, yMm: p.yMm, between: p.between })),
      solver: `CPU reference solver. S at the connector flanges, renormalized from the meshed coax (${lines.join(', ')}) to each port's reference impedance`, solveMs, grid,
      portIds, z0, excited, runs, s: solved.s, farField: null,
      fields: fieldMaps(model, planes, fieldPlanesFromDft(solved.planeAccumulators, layout, planes), solved.volumeAccumulators, volumeHz, fieldVolume), nearField: null, accuracy: null, deembedding: null, warnings,
    };
  }
  const solved = useGpu
    ? await solveOnGpu(model, exc, control, farField, excited, layout, volumeHz, hooks)
    : solveOnCpu(model, exc, control, farField, excited, layout, volumeHz, hooks);
  const solveMs = performance.now() - t0;

  const runs: RunSummary[] = solved.runs.map((run, n) => ({
    portId: portIds[excited[n]],
    steps: run.v.length,
    energyDecayDb: run.energyDecayDb,
    stoppedOnEnergy: run.stoppedOnEnergy,
    spectrum: portSpectrum(run, { ...exc, z0: z0[excited[n]] }),
  }));
  runs.forEach((run) => run.stoppedOnEnergy || warnings.push(notRungDown(run, multiport, a.stop)));
  const s = multiport
    ? scatteringMatrix(solved.runs.map((r, n) => ({ activePort: excited[n], samples: r })), z0, exc)
    : oneportScattering(runs[0].spectrum, z0[0]);

  let farFieldOut: WorkbenchResult['farField'] = null;
  if (farField && solved.huygensAccumulators) {
    hooks.onProgress({ run: 0, runs: excited.length, step: control.maxSteps, maxSteps: control.maxSteps, decayDb: null, targetDb: control.stopAtEnergyDecayDb ?? 0, stage: 'far-field' });
    const results = nearToFarField({ ...farField, accumulators: solved.huygensAccumulators, samples: solved.runs[0], exc });
    const dt = timestepSec(model.grid);
    farFieldOut = {
      entries: results.map((result, n) => {
        const polarisation = boresightPolarisation(result);
        const f = patternFigures(result, polarisation);
        const sources = boxSources(farField.surface, solved.huygensAccumulators!, farField.frequenciesHz, n, exc, dt, solved.runs[0].v.length);
        const at = (distanceM: number) => fieldStrengthAt(sources, distanceM, result.peakThetaDeg, result.peakPhiDeg);
        return {
          result, polarisation,
          beamwidthEPlaneDeg: f.beamwidthEPlaneDeg, beamwidthHPlaneDeg: f.beamwidthHPlaneDeg,
          frontToBackDb: f.frontToBackDb, crossPolarDb: f.boresightCrossPolarDb,
          fieldAt3mVPerM: at(3), fieldAt10mVPerM: at(10),
        };
      }),
      caveat: solved.runs[0].stoppedOnEnergy ? null
        : 'The run stopped before the field rang down, so efficiency and gain are approximate. The pattern shape is less affected.',
    };
  }

  const fields = fieldMaps(model, planes, fieldPlanesFromDft(solved.planeAccumulators, layout, planes), solved.volumeAccumulators, volumeHz, fieldVolume);
  const source = (frequencyHz: number) => sourcePhasor(exc, timestepSec(model.grid), solved.runs[0].v.length, frequencyHz);
  const nearField = scans.length === 0 ? null : scans.map(({ heightMm, k, meshHeightMm }): NearFieldScan => ({
    heightMm, meshHeightMm,
    planes: layout.frequenciesHz.map((frequencyHz, frequencyIndex) => scanPlane({
      accumulators: solved.planeAccumulators, layout, frequencyIndex, k, mesh: model.mesh,
      dRefMm: model.grid.dxMm, dtSec: timestepSec(model.grid), source: source(frequencyHz),
    })),
  }));
  return {
    projectName: project.name, projectText, zinGHz: project.outputs.zin_at_ghz,
    ports: resolved.ports.map((p) => ({ id: p.id, xMm: p.xMm, yMm: p.yMm, between: p.between })), solver: solved.solver, solveMs, grid,
    portIds, z0, excited, runs, s, farField: farFieldOut, fields, nearField, accuracy: null, deembedding: null, warnings,
  };
}

