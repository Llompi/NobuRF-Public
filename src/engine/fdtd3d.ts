import { assertRunControl, assertStableCourant, assertStableGrid, timestepSec } from './config';
import { activeConformalFaces } from './conformal';
import type { SparseRows } from './thin_sheets';
import { EnergyStop } from './energy_stop';
import { sourceEndStep, sourceParams } from './source';
import type { AxisCpml } from './cpml';
import type { CoaxEngineFactory } from './coax_feed';
import type { CoaxRunPlanes, ExcitationConfig, GridConfig, PortSamples, RunControl } from './types';
import { FACE_STATE_HEADER, sheetFaceLoss, type VoxelModel } from './voxelize';
import commonWgsl from './shaders/common.wgsl?raw';
import updateHWgsl from './shaders/update_h.wgsl?raw';
import updateEWgsl from './shaders/update_e.wgsl?raw';
import cpmlWgsl from './shaders/cpml.wgsl?raw';
import energyWgsl from './shaders/energy.wgsl?raw';
import portWgsl from './shaders/port.wgsl?raw';
import huygensDftWgsl from './shaders/huygens_dft.wgsl?raw';
import planeDftWgsl from './shaders/plane_dft.wgsl?raw';
import volumeDftWgsl from './shaders/volume_dft.wgsl?raw';
import coaxWgsl from './shaders/coax.wgsl?raw';
import sheetLossWgsl from './shaders/sheet_loss.wgsl?raw';
import conformalWgsl from './shaders/conformal.wgsl?raw';
import sparseRowsWgsl from './shaders/sparse_rows.wgsl?raw';
import lumpedWgsl from './shaders/lumped.wgsl?raw';
import lumpedEnergyWgsl from './shaders/lumped_energy.wgsl?raw';
import dispersionWgsl from './shaders/dispersion.wgsl?raw';
import { energyFactors, stateStride, type EdgeDispersion } from './dispersion';
import { VALUES_PER_SAMPLE_FREQUENCY, type HuygensSurface } from './huygens_box';
import { assertPlaneDftRequest, planeDftLength } from './plane_dft';
import { assertVolumeDftRequest, volumeDftLength } from './volume_dft';
import { gpuPortLimitExceeded, MAX_PORT_CELLS, MAX_PORTS } from './gpu_limits';

const WG = 64;
/**
 * Max steps per command buffer. Windows kills any GPU job that runs past ~2 s
 * (TDR -> DXGI_ERROR_DEVICE_HUNG -> device lost). 3000 steps in one submit is
 * ~0.55 s on a GTX 1660 Ti but several seconds on an integrated GPU, so the
 * fast path still splits the run; extra submits cost microseconds.
 */
const MAX_STEPS_PER_SUBMIT = 250;
/** Room for a whole 3000-step run recorded every 20 steps (150 frames, 7 samples per period at 7.5 GHz). */
const MAX_FRAMES = 160;
/** One PortDesc in port.wgsl: 12 words. */
const PORT_DESC_WORDS = 12;
const PARAMS_BYTES = 128;
const ENERGY_WG = 256;

/**
 * Dispatch `groups` workgroups of a flat kernel. One dimension holds at most
 * maxPerDimension (65535 by default), which a 1D dispatch hits at ~4.2M cells,
 * so the groups are laid out as rows of up to that width. The kernels rebuild
 * the flat index with flat_index() in common.wgsl and bounds-check it, since
 * the last row can overshoot. `rowWidth` defaults to the limit; tests narrow it.
 */
export function flatDispatchSize(groups: number, maxPerDimension: number, rowWidth = maxPerDimension): [x: number, y: number] {
  const x = Math.min(groups, rowWidth, maxPerDimension);
  const y = Math.ceil(groups / x);
  if (y > maxPerDimension) throw new Error(`${groups} workgroups exceed the device's ${maxPerDimension}^2 dispatch limit`);
  return [x, y];
}

interface DispersionPass {
  buffers: GPUBuffer[];
  state: GPUBuffer;
  pipes: { snapshot: GPUComputePipeline; update: GPUComputePipeline; energy: GPUComputePipeline };
  binds: { snapshot: GPUBindGroup; update: GPUBindGroup; energy: GPUBindGroup };
  /** The stored-energy correction of the listed edges at the last energy check, one partial sum per workgroup of 256 edges. */
  energyPartials: GPUBuffer;
  energyDispatch: [number, number];
  dispatch: [number, number];
}

export interface FieldRecordingOptions {
  /** Steps between frames. */
  stepsBetweenFrames: number;
  /** Step count at which recording starts (lets the recording sit in the ring-down). */
  firstStep: number;
  /** z index of the Ez plane inside the substrate. */
  substratePlaneK: number;
  /** z index of the plane just above the top copper, where tangential Ex and Ey are recorded for the far field. */
  aperturePlaneK: number;
}

/**
 * Coax wave-port planes for one run, in the TemPlane terms of coax_feed.ts
 * (runCoaxFeed is the CPU reference): a TEM soft source on one cross-section
 * and mode-voltage probes on others.
 */
export type CoaxPlanes = CoaxRunPlanes;

export interface RunOptions {
  /** Defaults to a fixed run of the engine's grid.stepsPerRun steps. */
  control?: RunControl;
  /**
   * Record field planes every few steps. Frames are copied GPU-side into one
   * buffer and read back once at the end with the port history, so recording
   * adds no mid-run stalls and no extra submits.
   */
  record?: FieldRecordingOptions;
  /**
   * Index into VoxelModel.ports of the port that carries the source; the others
   * are matched loads. Null: every lumped port is a load, which a run with a
   * coax source needs (a run has one source). Default 0, or null with a coax source.
   */
  activePort?: number | null;
  /** Coax source and probe planes; see CoaxPlanes. */
  coax?: CoaxPlanes;
  /**
   * Called after every energy check with the steps done so far and the energy
   * decay from its peak in dB. Given a callback, a fixed-length run also
   * checks energy every control.energyCheckEverySteps steps.
   */
  onProgress?: (stepsDone: number, energyDecayDb: number) => void;
  /**
   * Stops the run at the next energy check by throwing signal.reason (an
   * AbortError DOMException by default). Given a signal, a fixed-length run
   * also checks energy, since those checks are where the CPU waits for the GPU.
   */
  signal?: AbortSignal;
  /**
   * The active port's voltage and current so far, at the first energy check at
   * or after every `everySteps` steps: one extra read-back of the port history
   * then. Lets a caller estimate S11 while the run goes on (a live preview, an
   * early stop). The arrays are copies the caller may keep.
   */
  portHistory?: { everySteps: number; onHistory: (stepsDone: number, v: Float32Array, i: Float32Array) => void };
}

export interface FieldRecording extends FieldRecordingOptions {
  /** Each frame is one nx*ny plane, oldest first. Frame n is E after firstStep + (n+1)*stepsBetweenFrames steps. */
  substrateEz: Float32Array[];
  apertureEx: Float32Array[];
  apertureEy: Float32Array[];
}

export interface RunResult extends PortSamples {
  gpuMs: number;
  recording: FieldRecording | null;
  /** Mode voltage of each coax probe per step, in CoaxPlanes.probes order; empty without coax probes. */
  coaxProbeVolts: Float64Array[];
}

/**
 * WebGPU 3D FDTD engine. Buffers are allocated once per grid; each solve
 * uploads only the material arrays (eDecay and eCurl, 2.4 MB each, CPML
 * profiles, port indices) and clears the fields on the GPU. Per step: H pass,
 * CPML H passes (one per axis with a PML), E pass, CPML E passes, the coax
 * source and probes when the run has them, then a 1-workgroup port pass.
 * Nothing is read back until the end of the run, except the energy partial
 * sums when the run stops on energy decay.
 */
export class Fdtd3D {
  private readonly N: number;
  private readonly bufE: GPUBuffer;
  private readonly bufH: GPUBuffer;
  private readonly bufEDecay: GPUBuffer;
  private readonly bufECurl: GPUBuffer;
  private readonly bufCpml: GPUBuffer;
  private readonly bufPsiE: GPUBuffer;
  private readonly bufPsiH: GPUBuffer;
  private readonly bufEnergy: GPUBuffer;
  /** energy.wgsl's partials, then the lumped components' energy, then the dispersion partials (E, H); sized per model in loadDispersion. */
  private bufEnergyRead: GPUBuffer;
  private readonly bufDummy: GPUBuffer;
  private readonly bufPortEz: GPUBuffer;
  private readonly bufPortLength: GPUBuffer;
  private readonly bufPortDesc: GPUBuffer;
  /** Port history, [v, i] per port per step; sized for the loaded model's port count. */
  private bufHist: GPUBuffer;
  private readonly bufCounter: GPUBuffer;
  private readonly bufParams: GPUBuffer;
  private bufHistRead: GPUBuffer;
  private readonly bufFrames: GPUBuffer;
  private readonly bufFramesRead: GPUBuffer;
  private readonly pipeH: GPUComputePipeline;
  /** Sheet-loss pipelines by their number of high-pass terms (the shader's TERMS). */
  private readonly pipeSheetLoss = new Map<number, GPUComputePipeline>();
  private readonly sheetLossModule: GPUShaderModule;
  /** The loaded model's copper faces (sheetFaceLoss); null when it has none. */
  private sheetLoss: { buffers: GPUBuffer[]; pipeline: GPUComputePipeline; bind: GPUBindGroup; dispatch: [number, number]; state: GPUBuffer[] } | null = null;
  private readonly pipeConformal: GPUComputePipeline;
  /** The loaded model's faces next to conformal copper (activeConformalFaces); null when it has none. */
  private conformal: { buffers: GPUBuffer[]; bind: GPUBindGroup; dispatch: [number, number] } | null = null;
  private readonly pipeSparseRows: GPUComputePipeline;
  /** The loaded model's thin sheets (thin_sheets.ts): ghost fields and the two correction passes; null without sheets. */
  private thinSheets: { buffers: GPUBuffer[]; ghosts: GPUBuffer[]; h: SparsePass | null; e: SparsePass | null } | null = null;
  private readonly pipeLumped: GPUComputePipeline;
  private readonly pipeLumpedEnergy: GPUComputePipeline;
  /** The loaded model's lumped components (lumped.wgsl); null when it has none. */
  private lumped: { eIndex: Uint32Array; buffers: GPUBuffer[]; state: GPUBuffer; total: GPUBuffer; bind: GPUBindGroup; energyBind: GPUBindGroup; dispatch: [number, number] } | null = null;
  /** The loaded model's dispersive E and magnetic H edges (dispersion.wgsl); null for a field without any. */
  private dispersion: Record<'e' | 'h', DispersionPass | null> = { e: null, h: null };
  /** Snapshot and update pipelines per (field, max poles), compiled on first use. */
  private readonly dispersionPipes = new Map<string, DispersionPass['pipes']>();
  private readonly pipeE: GPUComputePipeline;
  private readonly pipePort: GPUComputePipeline;
  private readonly pipeEnergy: GPUComputePipeline;
  private readonly bindH: GPUBindGroup;
  private readonly bindE: GPUBindGroup;
  private bindPort: GPUBindGroup;
  private readonly bindEnergy: GPUBindGroup;
  /** One CPML pass per (field, axis); built in load() for axes that have a PML. */
  private cpmlPasses: Array<{ pipe: GPUComputePipeline; bind: GPUBindGroup; dispatch: [number, number]; field: 'e' | 'h' }> = [];
  private readonly cpmlPipes: Record<'e' | 'h', GPUComputePipeline[]>;
  private readonly energyGroups: number;
  private busy = false;
  /** Coax source and probe passes of the current run; null outside a run with coax planes. */
  private coax: CoaxPasses | null = null;
  /** Built on the first run with coax planes. */
  private coaxPipes: { source: GPUComputePipeline; probe: GPUComputePipeline } | null = null;
  /** Far-field box DFT, set by enableHuygensDft; null runs skip it entirely. */
  private huygens: DftKernel | null = null;
  /** z-plane field DFT, set by enablePlaneDft; null runs skip it entirely. */
  private planeDft: DftKernel | null = null;
  /** Whole-grid field DFT, set by enableVolumeDft; null runs skip it entirely. */
  private volumeDft: DftKernel | null = null;
  /** Step after which the source is off; energy checks before it never stop the run. */
  private sourceEnd = 0;
  /** The loaded model's ports and the source amplitude: run() writes the descriptors for its active port. */
  private ports: VoxelModel['ports'] = [];
  private sourceAmplitude = 0;

  static async create(grid: GridConfig, maxSteps: number): Promise<Fdtd3D> {
    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error('WebGPU is not available in this browser (try Chrome or Edge 113+, on an https:// or http://localhost page)');
    }
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found');
    // The default 128 MiB binding limit caps a field buffer (3N floats) at
    // 11.2M cells; ask for what this adapter actually supports.
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    // destroy() after every run also settles `lost`; only a real loss is worth an error in the console.
    device.lost.then((info) => {
      if (info.reason !== 'destroyed') console.error('[fdtd3d] device lost:', info.message);
    });
    return new Fdtd3D(device, grid, maxSteps, adapterLabel(adapter));
  }

  constructor(
    readonly device: GPUDevice,
    readonly grid: GridConfig,
    readonly maxSteps: number,
    readonly adapterName = 'unknown',
    /** Widest dispatch row. Tests set it low to exercise multi-row dispatches on small grids. */
    private readonly dispatchRowWidth = device.limits.maxComputeWorkgroupsPerDimension,
  ) {
    // Grid size is checked per face in load(), against the model's own PML.
    assertStableCourant(grid);
    const { nx, ny, nz } = grid;
    this.N = nx * ny * nz;
    const fieldBytes = 3 * this.N * 4;
    const S = GPUBufferUsage.STORAGE;
    const CD = GPUBufferUsage.COPY_DST;
    const CS = GPUBufferUsage.COPY_SRC;
    const mk = (size: number, usage: number, label: string) => device.createBuffer({ size, usage, label });

    this.bufE = mk(fieldBytes, S | CD | CS, 'E');
    this.bufH = mk(fieldBytes, S | CD, 'H');
    this.bufEDecay = mk(fieldBytes, S | CD, 'eDecay');
    this.bufECurl = mk(fieldBytes, S | CD, 'eCurl');
    this.bufCpml = mk(6 * (nx + ny + nz) * 4, S | CD, 'cpml');
    // psi for every axis at the grid's own PML thickness; load() checks the model fits.
    const psiFloats = 2 * grid.pmlCells * 2 * (ny * nz + nx * nz + nx * ny);
    this.bufPsiE = mk(Math.max(4, psiFloats * 4), S | CD, 'psiE');
    this.bufPsiH = mk(Math.max(4, psiFloats * 4), S | CD, 'psiH');
    this.energyGroups = Math.ceil(this.N / ENERGY_WG);
    this.bufEnergy = mk(this.energyGroups * 4, S | CS, 'energy');
    // One slot more than the partials for the lumped components' energy (lumped_energy.wgsl), 0 when unused;
    // loadDispersion adds room for the dispersive E and magnetic H edges' partials (dispersion.wgsl).
    this.bufEnergyRead = mk((this.energyGroups + 1) * 4, GPUBufferUsage.MAP_READ | CD, 'energyRead');
    this.bufDummy = mk(4, S, 'dummy');
    this.bufPortEz = mk(MAX_PORT_CELLS * 4, S | CD, 'portEz');
    this.bufPortLength = mk(MAX_PORT_CELLS * 4, S | CD, 'portLength');
    this.bufPortDesc = mk(MAX_PORTS * PORT_DESC_WORDS * 4, S | CD, 'portDesc');
    [this.bufHist, this.bufHistRead] = this.createHistory(1);
    this.bufCounter = mk(16, S | CD, 'counter');
    this.bufParams = mk(PARAMS_BYTES, GPUBufferUsage.UNIFORM | CD, 'params');
    // Three planes per frame: substrate Ez, aperture Ex, aperture Ey.
    this.bufFrames = mk(MAX_FRAMES * 3 * nx * ny * 4, CS | CD, 'frames');
    this.bufFramesRead = mk(MAX_FRAMES * 3 * nx * ny * 4, GPUBufferUsage.MAP_READ | CD, 'framesRead');

    const mod = (code: string, label: string) => device.createShaderModule({ code: commonWgsl + '\n' + code, label });
    const pipe = (code: string, label: string, constants?: Record<string, number>) =>
      device.createComputePipeline({ layout: 'auto', compute: { module: mod(code, label), entryPoint: 'main', constants }, label });
    this.pipeH = pipe(updateHWgsl, 'update_h');
    this.sheetLossModule = mod(sheetLossWgsl, 'sheet_loss');
    this.pipeConformal = pipe(conformalWgsl, 'conformal');
    this.pipeSparseRows = pipe(sparseRowsWgsl, 'sparse_rows');
    this.pipeLumped = pipe(lumpedWgsl, 'lumped');
    this.pipeLumpedEnergy = pipe(lumpedEnergyWgsl, 'lumped_energy');
    this.pipeE = pipe(updateEWgsl, 'update_e');
    this.pipePort = pipe(portWgsl, 'port');
    this.pipeEnergy = pipe(energyWgsl, 'energy');
    this.cpmlPipes = {
      e: [0, 1, 2].map((axis) => pipe(cpmlWgsl, `cpml_e_${axis}`, { AXIS: axis, FIELD_IS_E: 1 })),
      h: [0, 1, 2].map((axis) => pipe(cpmlWgsl, `cpml_h_${axis}`, { AXIS: axis, FIELD_IS_E: 0 })),
    };

    const bind = (p: GPUComputePipeline, bufs: GPUBuffer[]) =>
      device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: [this.bufParams, ...bufs].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    this.bindH = bind(this.pipeH, [this.bufE, this.bufH, this.bufCpml]);
    this.bindE = bind(this.pipeE, [this.bufE, this.bufH, this.bufEDecay, this.bufECurl, this.bufCpml]);
    this.bindPort = this.createPortBinding();
    this.bindEnergy = bind(this.pipeEnergy, [this.bufE, this.bufH, this.bufEDecay, this.bufECurl, this.bufCpml, this.bufEnergy]);
  }

  /** History buffers ([v, i] per port per step) for `portCount` ports. */
  private createHistory(portCount: number): [hist: GPUBuffer, read: GPUBuffer] {
    const bytes = this.maxSteps * 2 * Math.max(1, portCount) * 4;
    return [
      this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'hist' }),
      this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'histRead' }),
    ];
  }

  private createPortBinding(): GPUBindGroup {
    const bufs = [this.bufParams, this.bufE, this.bufH, this.bufPortEz, this.bufHist, this.bufCounter, this.bufPortLength, this.bufPortDesc];
    return this.device.createBindGroup({
      layout: this.pipePort.getBindGroupLayout(0),
      entries: bufs.map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
  }

  /** Upload materials + ports for a new geometry. ~2.4 MB write. */
  load(model: VoxelModel, exc: ExcitationConfig): void {
    const g = model.grid;
    if (g.nx !== this.grid.nx || g.ny !== this.grid.ny || g.nz !== this.grid.nz) {
      throw new Error('model grid does not match engine grid');
    }
    assertStableGrid(g, model.cpml.faces);
    const ports = model.ports;
    const portCells = ports.reduce((sum, p) => sum + p.cells, 0);
    const portLimit = gpuPortLimitExceeded(ports);
    if (portLimit) throw new Error(portLimit);
    const q = this.device.queue;
    q.writeBuffer(this.bufEDecay, 0, model.eDecay as Float32Array<ArrayBuffer>);
    q.writeBuffer(this.bufECurl, 0, model.eCurl as Float32Array<ArrayBuffer>);
    this.loadSheetLoss(model);
    this.loadConformal(model);
    this.loadThinSheets(model);
    this.loadLumped(model);
    this.loadDispersion(model);
    const axes: AxisCpml[] = [model.cpml.x, model.cpml.y, model.cpml.z];
    const profiles = new Float32Array(6 * (g.nx + g.ny + g.nz));
    let offset = 0;
    for (const ax of axes) {
      for (const arr of [ax.eB, ax.eC, ax.eDiffScale, ax.hB, ax.hC, ax.hDiffScale]) {
        profiles.set(arr, offset);
        offset += ax.n;
      }
    }
    q.writeBuffer(this.bufCpml, 0, profiles);
    const slabCells = axes.map((ax) => ((ax.low + ax.high) * this.N) / ax.n);
    const psiOffsets = [0, 2 * slabCells[0], 2 * (slabCells[0] + slabCells[1])];
    const psiFloats = 2 * (slabCells[0] + slabCells[1] + slabCells[2]);
    if (psiFloats * 4 > this.bufPsiE.size) {
      throw new Error(`model PML needs ${psiFloats} psi floats; engine was sized for ${this.bufPsiE.size / 4} (grid.pmlCells ${g.pmlCells})`);
    }
    this.cpmlPasses = [];
    for (const field of ['h', 'e'] as const) {
      [0, 1, 2].forEach((axis) => {
        if (slabCells[axis] === 0) return;
        const pipe = this.cpmlPipes[field][axis];
        const [target, source, psi] = field === 'e' ? [this.bufE, this.bufH, this.bufPsiE] : [this.bufH, this.bufE, this.bufPsiH];
        const extra = field === 'e' ? this.bufECurl : this.bufDummy;
        const bind = this.device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [this.bufParams, target, source, psi, this.bufCpml, extra].map((buffer, binding) => ({ binding, resource: { buffer } })),
        });
        this.cpmlPasses.push({ pipe, bind, dispatch: this.flatDispatch(Math.ceil(slabCells[axis] / WG)), field });
      });
    }
    // All ports' cells back to back; each cell's V weight is its series cell's length.
    const ez = new Uint32Array(MAX_PORT_CELLS);
    const portLength = new Float32Array(MAX_PORT_CELLS);
    let firstCell = 0;
    for (const p of ports) {
      ez.set(p.ezIndex, firstCell);
      for (let column = 0; column < p.columns; column++) portLength.set(p.mesh.cellLength, firstCell + column * p.seriesCells);
      firstCell += p.cells;
    }
    q.writeBuffer(this.bufPortEz, 0, ez);
    q.writeBuffer(this.bufPortLength, 0, portLength);
    if (ports.length !== this.ports.length) {
      this.bufHist.destroy();
      this.bufHistRead.destroy();
      [this.bufHist, this.bufHistRead] = this.createHistory(ports.length);
      this.bindPort = this.createPortBinding();
    }
    this.ports = ports;

    const dt = timestepSec(g);
    const sp = sourceParams(exc);
    const params = new ArrayBuffer(PARAMS_BYTES);
    const u32 = new Uint32Array(params);
    const f32 = new Float32Array(params);
    u32[0] = g.nx; u32[1] = g.ny; u32[2] = g.nz; u32[3] = this.N;
    f32[4] = g.courant;
    u32[8] = portCells;
    u32[9] = ports.length;
    u32[10] = this.maxSteps;
    f32[12] = sp.t0Sec / dt;
    f32[13] = sp.tauSec / dt;
    f32[14] = 2 * Math.PI * sp.fcHz * dt;
    axes.forEach((ax, a) => {
      u32[16 + a] = ax.low;
      u32[20 + a] = ax.high;
      u32[24 + a] = psiOffsets[a];
      u32[28 + a] = slabCells[a];
    });
    q.writeBuffer(this.bufParams, 0, params);
    this.sourceEnd = sourceEndStep(sp, dt);
    this.sourceAmplitude = sp.amplitude;
    this.writePortDescriptors(0);
  }

  /** The PortDesc array of port.wgsl, with the source on `activePort` (null: on none). */
  private writePortDescriptors(activePort: number | null): void {
    const desc = new ArrayBuffer(MAX_PORTS * PORT_DESC_WORDS * 4);
    const u32 = new Uint32Array(desc);
    const f32 = new Float32Array(desc);
    let firstCell = 0;
    this.ports.forEach((p, n) => {
      const w = n * PORT_DESC_WORDS;
      u32[w] = firstCell; u32[w + 1] = p.seriesCells; u32[w + 2] = p.columns;
      f32[w + 4] = p.ca; f32[w + 5] = p.cb; f32[w + 6] = p.cs;
      f32[w + 7] = n === activePort ? this.sourceAmplitude / p.mesh.seriesLength : 0;
      f32[w + 8] = p.mesh.curlScaleX; f32[w + 9] = p.mesh.curlScaleY;
      f32[w + 10] = p.mesh.loopLengthX; f32[w + 11] = p.mesh.loopLengthY;
      firstCell += p.cells;
    });
    this.device.queue.writeBuffer(this.bufPortDesc, 0, desc);
  }

  private flatDispatch(groups: number): [number, number] {
    return flatDispatchSize(groups, this.device.limits.maxComputeWorkgroupsPerDimension, this.dispatchRowWidth);
  }

  private encodeSteps(enc: GPUCommandEncoder, steps: number): void {
    const [gx, gy] = this.flatDispatch(Math.ceil(this.N / WG));
    // Each dispatch is its own usage scope, so WebGPU orders H -> CPML H -> E
    // -> CPML E -> port within a single pass; no per-step pass or submit is needed.
    const pass = enc.beginComputePass();
    const cpmlPass = (field: 'e' | 'h') => {
      for (const c of this.cpmlPasses) {
        if (c.field !== field) continue;
        pass.setPipeline(c.pipe);
        pass.setBindGroup(0, c.bind);
        pass.dispatchWorkgroups(...c.dispatch);
      }
    };
    const dispersionPass = (field: 'e' | 'h', stage: 'snapshot' | 'update') => {
      const d = this.dispersion[field];
      if (!d) return;
      pass.setPipeline(d.pipes[stage]);
      pass.setBindGroup(0, d.binds[stage]);
      pass.dispatchWorkgroups(...d.dispatch);
    };
    const sparsePass = (p: SparsePass | null) => {
      if (!p) return;
      pass.setPipeline(this.pipeSparseRows);
      pass.setBindGroup(0, p.bind);
      pass.dispatchWorkgroups(...p.dispatch);
    };
    for (let s = 0; s < steps; s++) {
      // Before the face loss, as in CpuFdtd.updateH: a magnetic edge's update divides that term by mu too.
      dispersionPass('h', 'snapshot');
      if (this.sheetLoss) {
        pass.setPipeline(this.sheetLoss.pipeline);
        pass.setBindGroup(0, this.sheetLoss.bind);
        pass.dispatchWorkgroups(...this.sheetLoss.dispatch);
      }
      pass.setPipeline(this.pipeH);
      pass.setBindGroup(0, this.bindH);
      pass.dispatchWorkgroups(gx, gy);
      cpmlPass('h');
      if (this.conformal) {
        pass.setPipeline(this.pipeConformal);
        pass.setBindGroup(0, this.conformal.bind);
        pass.dispatchWorkgroups(...this.conformal.dispatch);
      }
      sparsePass(this.thinSheets?.h ?? null);
      dispersionPass('h', 'update');
      dispersionPass('e', 'snapshot');
      pass.setPipeline(this.pipeE);
      pass.setBindGroup(0, this.bindE);
      pass.dispatchWorkgroups(gx, gy);
      cpmlPass('e');
      sparsePass(this.thinSheets?.e ?? null);
      dispersionPass('e', 'update');
      if (this.lumped) {
        pass.setPipeline(this.pipeLumped);
        pass.setBindGroup(0, this.lumped.bind);
        pass.dispatchWorkgroups(...this.lumped.dispatch);
      }
      for (const c of this.coax?.passes ?? []) {
        pass.setPipeline(c.pipe);
        pass.setBindGroup(0, c.bind);
        pass.dispatchWorkgroups(c.groups);
      }
      pass.setPipeline(this.pipePort);
      pass.setBindGroup(0, this.bindPort);
      pass.dispatchWorkgroups(1);
      for (const kernel of this.dftKernels()) {
        pass.setPipeline(kernel.pipe);
        pass.setBindGroup(0, kernel.bind);
        pass.dispatchWorkgroups(...kernel.dispatch);
      }
    }
    pass.end();
  }

  /** Run one solve from zero fields. Concurrent calls are rejected, not queued. */
  async run(opts: RunOptions = {}): Promise<RunResult> {
    if (this.busy) throw new Error('solver busy');
    this.busy = true;
    try {
      const control = opts.control ?? { maxSteps: this.grid.stepsPerRun, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };
      assertRunControl(control);
      opts.signal?.throwIfAborted();
      const coaxSource = opts.coax?.source ?? null;
      const activePort = opts.activePort === undefined ? (coaxSource ? null : 0) : opts.activePort;
      if (activePort === null) {
        if (!coaxSource) throw new Error('a run without a coax source needs an active lumped port');
      } else {
        if (coaxSource) throw new Error(`a run has one source: the coax source or active port ${activePort}, not both`);
        if (!Number.isInteger(activePort) || activePort < 0 || activePort >= this.ports.length) {
          throw new Error(`active port ${activePort} does not exist; the loaded model has ${this.ports.length} port(s)`);
        }
      }
      if (control.maxSteps > this.maxSteps) {
        throw new Error(`run of ${control.maxSteps} steps exceeds this engine's ${this.maxSteps}-step history buffer`);
      }
      this.writePortDescriptors(activePort);
      this.coax = opts.coax ? this.createCoaxPasses(opts.coax) : null;
      let steps = control.maxSteps;
      const check = control.energyCheckEverySteps;
      // Fixed-length runs skip the energy checks and their read-back stalls,
      // unless the caller wants progress or a way to cancel.
      const measureEnergy = control.stopAtEnergyDecayDb !== null || opts.onProgress !== undefined || opts.signal !== undefined || opts.portHistory !== undefined;
      let nextHistoryAt = opts.portHistory?.everySteps ?? Infinity;
      const energyStop = new EnergyStop(control, this.sourceEnd);
      const dispersionPasses = [this.dispersion.e, this.dispersion.h].filter((d): d is DispersionPass => d !== null);
      const t0 = performance.now();
      const dev = this.device;
      {
        const enc = dev.createCommandEncoder();
        enc.clearBuffer(this.bufE);
        enc.clearBuffer(this.bufH);
        for (const g of this.thinSheets?.ghosts ?? []) enc.clearBuffer(g);
        for (const b of this.sheetLoss?.state ?? []) enc.clearBuffer(b);
        enc.clearBuffer(this.bufPsiE);
        enc.clearBuffer(this.bufPsiH);
        enc.clearBuffer(this.bufHist);
        enc.clearBuffer(this.bufCounter);
        if (this.lumped) enc.clearBuffer(this.lumped.state);
        for (const d of [this.dispersion.e, this.dispersion.h]) if (d) enc.clearBuffer(d.state);
        for (const kernel of this.dftKernels()) enc.clearBuffer(kernel.accumulators);
        dev.queue.submit([enc.finish()]);
      }
      const planeFloats = this.grid.nx * this.grid.ny;
      const planeBytes = planeFloats * 4;
      const record = opts.record;
      if (record && (record.stepsBetweenFrames < 1 || record.stepsBetweenFrames > MAX_STEPS_PER_SUBMIT)) {
        throw new Error(`stepsBetweenFrames must be 1..${MAX_STEPS_PER_SUBMIT}, got ${record.stepsBetweenFrames}`);
      }
      const every = record?.stepsBetweenFrames ?? 0;
      const start = Math.max(0, record?.firstStep ?? 0);
      if (record && Math.ceil((steps - start) / every) > MAX_FRAMES) {
        throw new Error(`recording ${steps} steps every ${every} needs more than ${MAX_FRAMES} frames; raise stepsBetweenFrames`);
      }
      // Byte offsets of the recorded planes in the packed E buffer ([Ex | Ey | Ez] blocks).
      const planeSources = record
        ? [
            (2 * this.N + planeFloats * record.substratePlaneK) * 4,
            (0 * this.N + planeFloats * record.aperturePlaneK) * 4,
            (1 * this.N + planeFloats * record.aperturePlaneK) * 4,
          ]
        : [];
      let frameCount = 0;
      // Each submit holds at most MAX_STEPS_PER_SUBMIT steps (Windows GPU watchdog).
      // Within a submit, steps are split at frame boundaries and each frame is a
      // GPU-side copy between compute passes.
      let enc = dev.createCommandEncoder();
      let stepsInSubmit = 0;
      for (let done = 0; done < steps; ) {
        let n = Math.min(steps - done, MAX_STEPS_PER_SUBMIT - stepsInSubmit);
        // Submits end on energy-check boundaries, so CPU and GPU check after the same steps.
        if (measureEnergy) n = Math.min(n, check - (done % check));
        const recording = record !== undefined;
        if (recording) {
          const nextFrameStep = done < start ? start + every : done + every - ((done - start) % every);
          n = Math.min(n, nextFrameStep - done);
        }
        this.encodeSteps(enc, n);
        done += n;
        stepsInSubmit += n;
        if (recording && done >= start + every && (done - start) % every === 0) {
          planeSources.forEach((src, p) =>
            enc.copyBufferToBuffer(this.bufE, src, this.bufFrames, (frameCount * 3 + p) * planeBytes, planeBytes),
          );
          frameCount++;
        }
        const checkNow = measureEnergy && done % check === 0;
        if (checkNow) {
          const pass = enc.beginComputePass();
          pass.setPipeline(this.pipeEnergy);
          pass.setBindGroup(0, this.bindEnergy);
          pass.dispatchWorkgroups(...this.flatDispatch(this.energyGroups));
          if (this.lumped) {
            pass.setPipeline(this.pipeLumpedEnergy);
            pass.setBindGroup(0, this.lumped.energyBind);
            pass.dispatchWorkgroups(1);
          }
          for (const d of dispersionPasses) {
            pass.setPipeline(d.pipes.energy);
            pass.setBindGroup(0, d.binds.energy);
            pass.dispatchWorkgroups(...d.energyDispatch);
          }
          pass.end();
          enc.copyBufferToBuffer(this.bufEnergy, 0, this.bufEnergyRead, 0, this.energyGroups * 4);
          // The lumped slot reads 0 without components.
          if (this.lumped) enc.copyBufferToBuffer(this.lumped.total, 0, this.bufEnergyRead, this.energyGroups * 4, 4);
          else enc.clearBuffer(this.bufEnergyRead, this.energyGroups * 4, 4);
          let slot = this.energyGroups + 1;
          for (const d of dispersionPasses) {
            enc.copyBufferToBuffer(d.energyPartials, 0, this.bufEnergyRead, slot * 4, d.energyPartials.size);
            slot += d.energyPartials.size / 4;
          }
        }
        if (checkNow || stepsInSubmit >= MAX_STEPS_PER_SUBMIT || done >= steps) {
          dev.queue.submit([enc.finish()]);
          enc = dev.createCommandEncoder();
          stepsInSubmit = 0;
        }
        if (checkNow) {
          // A read-back stall per check, about one step's worth of time; simple first.
          await this.bufEnergyRead.mapAsync(GPUMapMode.READ);
          const partials = new Float32Array(this.bufEnergyRead.getMappedRange());
          let energy = 0;
          for (const x of partials) energy += x;
          this.bufEnergyRead.unmap();
          if (energyStop.check(done, energy)) steps = done;
          opts.signal?.throwIfAborted();
          opts.onProgress?.(done, energyStop.decayDb);
          if (opts.portHistory && activePort !== null && done >= nextHistoryAt && done < steps) {
            nextHistoryAt = done + opts.portHistory.everySteps;
            const portCount = this.ports.length;
            const bytes = done * 2 * portCount * 4;
            const copy = dev.createCommandEncoder();
            copy.copyBufferToBuffer(this.bufHist, 0, this.bufHistRead, 0, bytes);
            dev.queue.submit([copy.finish()]);
            await this.bufHistRead.mapAsync(GPUMapMode.READ, 0, bytes);
            const hist = new Float32Array(this.bufHistRead.getMappedRange(0, bytes));
            const v = new Float32Array(done);
            const i = new Float32Array(done);
            for (let k = 0; k < done; k++) {
              v[k] = hist[2 * (k * portCount + activePort)];
              i[k] = hist[2 * (k * portCount + activePort) + 1];
            }
            this.bufHistRead.unmap();
            opts.portHistory.onHistory(done, v, i);
          }
        }
      }
      const frameBytes = frameCount * 3 * planeBytes;
      const portCount = this.ports.length;
      const histBytes = steps * 2 * portCount * 4;
      const probeCount = this.coax?.probeCount ?? 0;
      const coaxHistBytes = steps * probeCount * 4;
      if (histBytes) enc.copyBufferToBuffer(this.bufHist, 0, this.bufHistRead, 0, histBytes);
      const coaxHistory = this.coax?.history ?? null;
      if (coaxHistory) enc.copyBufferToBuffer(coaxHistory.hist, 0, coaxHistory.read, 0, coaxHistBytes);
      if (frameCount) enc.copyBufferToBuffer(this.bufFrames, 0, this.bufFramesRead, 0, frameBytes);
      dev.queue.submit([enc.finish()]);
      const readBack = async (buffer: GPUBuffer, bytes: number) => {
        if (!bytes) return new Float32Array(0);
        await buffer.mapAsync(GPUMapMode.READ, 0, bytes);
        const out = new Float32Array(buffer.getMappedRange(0, bytes).slice(0));
        buffer.unmap();
        return out;
      };
      const hist = await readBack(this.bufHistRead, histBytes);
      const coaxHist = coaxHistory ? await readBack(coaxHistory.read, coaxHistBytes) : new Float32Array(0);
      let recordingOut: FieldRecording | null = null;
      if (record && frameCount) {
        await this.bufFramesRead.mapAsync(GPUMapMode.READ, 0, frameBytes);
        const all = new Float32Array(this.bufFramesRead.getMappedRange(0, frameBytes).slice(0));
        this.bufFramesRead.unmap();
        const plane = (f: number, p: number) => all.subarray((f * 3 + p) * planeFloats, (f * 3 + p + 1) * planeFloats);
        recordingOut = { ...record, substrateEz: [], apertureEx: [], apertureEy: [] };
        for (let f = 0; f < frameCount; f++) {
          recordingOut.substrateEz.push(plane(f, 0));
          recordingOut.apertureEx.push(plane(f, 1));
          recordingOut.apertureEy.push(plane(f, 2));
        }
      }
      const gpuMs = performance.now() - t0;

      const ports = this.ports.map((_, p) => {
        const v = new Float32Array(steps);
        const i = new Float32Array(steps);
        for (let s = 0; s < steps; s++) {
          v[s] = hist[2 * (s * portCount + p)];
          i[s] = hist[2 * (s * portCount + p) + 1];
        }
        return { v, i };
      });
      const coaxProbeVolts = Array.from({ length: probeCount }, (_, q) => {
        const v = new Float64Array(steps);
        for (let s = 0; s < steps; s++) v[s] = coaxHist[s * probeCount + q];
        return v;
      });
      const active = activePort === null ? { v: new Float32Array(0), i: new Float32Array(0) } : ports[activePort];
      return {
        ...active, ports, dtSec: timestepSec(this.grid), gpuMs, recording: recordingOut,
        energyDecayDb: energyStop.decayDb, stoppedOnEnergy: energyStop.reached, coaxProbeVolts,
      };
    } finally {
      for (const b of this.coax?.buffers ?? []) b.destroy();
      this.coax = null;
      this.busy = false;
    }
  }

  /**
   * Buffers and bind groups of the coax passes for one run (coax.wgsl). The
   * plane data is a few thousand edges, so it is uploaded per run, and the
   * buffers are destroyed when the run ends.
   */
  /** Upload the model's dispersive and magnetic edge lists (dispersion.ts) and their pole state. */
  private loadDispersion(model: VoxelModel): void {
    for (const d of [this.dispersion.e, this.dispersion.h]) for (const b of d?.buffers ?? []) b.destroy();
    this.dispersion = { e: null, h: null };
    // Checked before any upload, so a refused model leaves nothing half loaded.
    const limit = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize);
    for (const [field, d] of [['E', model.dispersion?.e], ['H', model.dispersion?.h]] as const) {
      const stateBytes = d ? d.index.length * stateStride(d.maxPoles) * 4 : 0;
      if (d && stateBytes > limit) {
        throw new Error(`the pole state of ${d.index.length} frequency-dependent ${field} edges (${d.maxPoles} poles each) needs ` +
          `${Math.ceil(stateBytes / 2 ** 20)} MiB, over this GPU's ${Math.floor(limit / 2 ** 20)} MiB buffer limit; use larger cells, ` +
          'or give the lossy layers dispersion { "model": "conductivity" } (a constant loss, no poles)');
      }
    }
    const build = (field: 'e' | 'h', d: EdgeDispersion | undefined): DispersionPass | null => {
      if (!d) return null;
      const key = `${field}:${d.maxPoles}`;
      let pipes = this.dispersionPipes.get(key);
      if (!pipes) {
        const module = this.device.createShaderModule({ code: commonWgsl + '\n' + dispersionWgsl, label: 'dispersion' });
        const constants = { FIELD_IS_E: field === 'e' ? 1 : 0, MAX_POLES: d.maxPoles };
        const pipe = (entryPoint: string) => this.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint, constants }, label: `dispersion_${field}_${entryPoint}` });
        pipes = { snapshot: pipe('snapshot'), update: pipe('update'), energy: pipe('energy') };
        this.dispersionPipes.set(key, pipes);
      }
      const S = GPUBufferUsage.STORAGE;
      const upload = (data: Uint32Array | Float32Array, label: string) => {
        const buffer = this.device.createBuffer({ size: Math.max(4, data.byteLength), usage: S | GPUBufferUsage.COPY_DST, label });
        this.device.queue.writeBuffer(buffer, 0, data as Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>);
        return buffer;
      };
      const index = upload(d.index, `${field}DispersionIndex`);
      const medium = upload(d.medium, `${field}DispersionMedium`);
      const media = upload(d.media, `${field}DispersionMedia`);
      const stateBytes = d.index.length * stateStride(d.maxPoles) * 4;
      const state = this.device.createBuffer({ size: stateBytes, usage: S | GPUBufferUsage.COPY_DST, label: `${field}DispersionState` });
      const energyWeights = upload(d.energy, `${field}DispersionEnergyWeights`);
      const energyGroups = Math.ceil(d.index.length / ENERGY_WG);
      const energyPartials = this.device.createBuffer({ size: energyGroups * 4, usage: S | GPUBufferUsage.COPY_SRC, label: `${field}DispersionEnergy` });
      const fieldBuffer = field === 'e' ? this.bufE : this.bufH;
      // Bindings 0..10 as in dispersion.wgsl; each entry point's auto layout keeps only the ones it uses.
      const factors = upload(energyFactors(model, field)!, `${field}DispersionEnergyFactors`);
      const all = [this.bufParams, fieldBuffer, this.bufEDecay, this.bufECurl, index, medium, media, state, energyWeights, factors, energyPartials];
      const bindFor = (p: GPUComputePipeline, used: number[]) => this.device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: used.map((binding) => ({ binding, resource: { buffer: all[binding] } })),
      });
      return {
        buffers: [index, medium, media, state, energyWeights, factors, energyPartials],
        state,
        energyPartials,
        energyDispatch: this.flatDispatch(energyGroups),
        pipes,
        binds: {
          snapshot: bindFor(pipes.snapshot, [1, 4, 7]),
          update: bindFor(pipes.update, [0, 1, 2, 3, 4, 5, 6, 7]),
          energy: bindFor(pipes.energy, [1, 4, 5, 7, 8, 9, 10]),
        },
        dispatch: this.flatDispatch(Math.ceil(d.index.length / 64)),
      };
    };
    this.dispersion = { e: build('e', model.dispersion?.e), h: build('h', model.dispersion?.h) };
    const dispersionSlots = [this.dispersion.e, this.dispersion.h].reduce((n, d) => n + (d ? d.energyPartials.size / 4 : 0), 0);
    this.bufEnergyRead.destroy();
    this.bufEnergyRead = this.device.createBuffer({ size: (this.energyGroups + 1 + dispersionSlots) * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'energyRead' });
  }

  private loadSheetLoss(model: VoxelModel): void {
    for (const b of this.sheetLoss?.buffers ?? []) b.destroy();
    this.sheetLoss = null;
    const { hIndex, rate, terms, weight, lowPass } = sheetFaceLoss(model);
    if (hIndex.length === 0) return;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    // WebGPU has no empty storage buffers: a frequency-independent model binds one-float stand-ins for its terms.
    const upload = (data: Uint32Array | Float32Array, label: string) => {
      const padded = data.length > 0 ? data : new Float32Array(1);
      const buffer = this.device.createBuffer({ size: padded.byteLength, usage, label });
      this.device.queue.writeBuffer(buffer, 0, padded as Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>);
      return buffer;
    };
    const blank = (floats: number, label: string) => this.device.createBuffer({ size: Math.max(1, floats) * 4, usage, label });
    // The carried remainder of each face's loss, as a fraction of H (applyFaceLoss), and the history of a
    // frequency-dependent impedance (FaceLoss); both cleared with H at the start of each run.
    const carry = blank(rate.length, 'sheetLossCarry');
    const history = blank(terms === 0 ? 0 : hIndex.length * (FACE_STATE_HEADER + terms), 'sheetLossState');
    const buffers = [upload(hIndex, 'sheetHIndex'), upload(rate, 'sheetLossRate'), carry, upload(weight, 'sheetLossWeight'), upload(lowPass, 'sheetLossLowPass'), history];
    let pipeline = this.pipeSheetLoss.get(terms);
    if (!pipeline) {
      pipeline = this.device.createComputePipeline({ layout: 'auto', compute: { module: this.sheetLossModule, entryPoint: 'main', constants: { TERMS: terms } }, label: `sheet_loss_${terms}` });
      this.pipeSheetLoss.set(terms, pipeline);
    }
    const bind = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      // The kernel reads no params, so its layout starts at binding 1.
      entries: [this.bufH, ...buffers].map((buffer, n) => ({ binding: n + 1, resource: { buffer } })),
    });
    this.sheetLoss = { buffers, pipeline, bind, dispatch: this.flatDispatch(Math.ceil(hIndex.length / 64)), state: [carry, history] };
  }

  /** Buffers and bind group of the conformal pass (conformal.wgsl) for the loaded model. */
  private loadConformal(model: VoxelModel): void {
    for (const b of this.conformal?.buffers ?? []) b.destroy();
    this.conformal = null;
    const faces = activeConformalFaces(model);
    if (!faces) return;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const buffers = [faces.hIndex, faces.eIndex, faces.coef].map((data, n) => {
      const buffer = this.device.createBuffer({ size: data.byteLength, usage, label: ['conformalHIndex', 'conformalEIndex', 'conformalCoef'][n] });
      this.device.queue.writeBuffer(buffer, 0, data as Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>);
      return buffer;
    });
    const bind = this.device.createBindGroup({
      layout: this.pipeConformal.getBindGroupLayout(0),
      // The kernel reads no params, so its layout starts at binding 1.
      entries: [this.bufH, this.bufE, ...buffers].map((buffer, n) => ({ binding: n + 1, resource: { buffer } })),
    });
    this.conformal = { buffers, bind, dispatch: this.flatDispatch(Math.ceil(faces.hIndex.length / 64)) };
  }

  /** Ghost fields and the two sparse correction passes (sparse_rows.wgsl) of the loaded model's thin sheets. */
  private loadThinSheets(model: VoxelModel): void {
    for (const b of [...(this.thinSheets?.buffers ?? []), ...(this.thinSheets?.ghosts ?? [])]) b.destroy();
    this.thinSheets = null;
    const sheets = model.thinSheets;
    if (!sheets) return;
    const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    const buffers: GPUBuffer[] = [];
    const upload = (data: Uint32Array | Float32Array, label: string) => {
      const buffer = this.device.createBuffer({ size: Math.max(4, data.byteLength), usage: S, label });
      if (data.byteLength > 0) this.device.queue.writeBuffer(buffer, 0, data as Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>);
      buffers.push(buffer);
      return buffer;
    };
    const [ghostE, ghostH] = [sheets.ghostE, sheets.ghostH].map((n, m) => this.device.createBuffer({ size: Math.max(4, n * 4), usage: S, label: m === 0 ? 'ghostE' : 'ghostH' }));
    const passOf = (rows: SparseRows, field: 'e' | 'h'): SparsePass | null => {
      if (rows.target.length === 0) return null;
      const [dst, dstGhost, src, srcGhost] = field === 'h' ? [this.bufH, ghostH, this.bufE, ghostE] : [this.bufE, ghostE, this.bufH, ghostH];
      const data = [upload(rows.target, `${field}RowTarget`), upload(rows.start, `${field}RowStart`), upload(rows.source, `${field}RowSource`), upload(rows.coef, `${field}RowCoef`)];
      const bind = this.device.createBindGroup({
        layout: this.pipeSparseRows.getBindGroupLayout(0),
        // The kernel reads no params, so its layout starts at binding 1.
        entries: [dst, dstGhost, src, srcGhost, ...data].map((buffer, n) => ({ binding: n + 1, resource: { buffer } })),
      });
      return { bind, dispatch: this.flatDispatch(Math.ceil(rows.target.length / 64)) };
    };
    this.thinSheets = { buffers, ghosts: [ghostE, ghostH], h: passOf(sheets.h, 'h'), e: passOf(sheets.e, 'e') };
  }

  /** Buffers of the lumped component pass (lumped.wgsl) and its energy sum (the read-back clears its slot each check without components). */
  private loadLumped(model: VoxelModel): void {
    for (const b of this.lumped?.buffers ?? []) b.destroy();
    this.lumped = null;
    const edges = model.lumped;
    if (!edges || edges.eIndex.length === 0) return;
    const S = GPUBufferUsage.STORAGE;
    const CD = GPUBufferUsage.COPY_DST;
    const upload = (data: Uint32Array | Float32Array, label: string) => {
      const buffer = this.device.createBuffer({ size: data.byteLength, usage: S | CD, label });
      this.device.queue.writeBuffer(buffer, 0, data as Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>);
      return buffer;
    };
    const eIndex = upload(edges.eIndex, 'lumpedEIndex');
    const coef = upload(edges.coef, 'lumpedCoef');
    const state = this.device.createBuffer({ size: edges.eIndex.length * 3 * 4, usage: S | CD, label: 'lumpedState' });
    const total = this.device.createBuffer({ size: 4, usage: S | GPUBufferUsage.COPY_SRC, label: 'lumpedEnergy' });
    // Neither kernel reads params, so their layouts start at binding 1.
    const bindFrom = (pipeline: GPUComputePipeline, buffers: GPUBuffer[]) => this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: buffers.map((buffer, n) => ({ binding: n + 1, resource: { buffer } })),
    });
    this.lumped = {
      eIndex: edges.eIndex,
      buffers: [eIndex, coef, state, total],
      state,
      total,
      bind: bindFrom(this.pipeLumped, [this.bufE, eIndex, coef, state]),
      energyBind: bindFrom(this.pipeLumpedEnergy, [coef, state, total]),
      dispatch: this.flatDispatch(Math.ceil(edges.eIndex.length / 64)),
    };
  }

  private createCoaxPasses(coax: CoaxPlanes): CoaxPasses {
    const dev = this.device;
    const fieldLength = 3 * this.N;
    // The port pass runs after the coax passes and owns its cells, so a plane edge there would read or feed a stale E.
    const portCells = new Set(this.ports.flatMap((p) => Array.from(p.ezIndex)));
    const assertEdges = (edges: Uint32Array, values: ArrayLike<number>, what: string) => {
      if (edges.length !== values.length) throw new Error(`${what}: ${edges.length} edges but ${values.length} values`);
      // Repeated source edges would race in the shader's +=.
      if (new Set(edges).size !== edges.length) throw new Error(`${what}: an edge is listed twice`);
      for (const e of edges) {
        if (e >= fieldLength) throw new Error(`${what}: edge ${e} is outside the ${fieldLength}-value E buffer`);
        if (portCells.has(e)) throw new Error(`${what}: edge ${e} is a lumped port cell`);
      }
    };
    if (coax.source) assertEdges(coax.source.edges, coax.source.mode, 'coax source');
    coax.probes.forEach((p, q) => assertEdges(p.edges, p.weights, `coax probe ${q}`));
    if (!this.coaxPipes) {
      const module = dev.createShaderModule({ code: commonWgsl + '\n' + coaxWgsl, label: 'coax' });
      const pipe = (entryPoint: string) => dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint }, label: `coax_${entryPoint}` });
      this.coaxPipes = { source: pipe('source'), probe: pipe('probe') };
    }
    const S = GPUBufferUsage.STORAGE;
    const CD = GPUBufferUsage.COPY_DST;
    const buffers: GPUBuffer[] = [];
    const upload = (data: Uint32Array<ArrayBuffer> | Float32Array<ArrayBuffer>, label: string) => {
      const buffer = dev.createBuffer({ size: Math.max(4, data.byteLength), usage: S | CD, label });
      dev.queue.writeBuffer(buffer, 0, data);
      buffers.push(buffer);
      return buffer;
    };
    const bind = (pipe: GPUComputePipeline, bufs: GPUBuffer[]) =>
      dev.createBindGroup({
        layout: pipe.getBindGroupLayout(0),
        entries: [this.bufParams, this.bufE, this.bufCounter, ...bufs].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
    const passes: CoaxPasses['passes'] = [];

    const source = coax.source;
    if (source) {
      const pipe = this.coaxPipes.source;
      const edges = upload(Uint32Array.from(source.edges), 'coaxSourceEdges');
      const mode = upload(Float32Array.from(source.mode, (m) => m * this.sourceAmplitude), 'coaxSourceMode');
      passes.push({ pipe, bind: bind(pipe, [edges, mode]), groups: Math.ceil(source.edges.length / WG) });
    }

    const probeCount = coax.probes.length;
    let history: CoaxPasses['history'] = null;
    if (probeCount) {
      const histBytes = this.maxSteps * probeCount * 4;
      history = {
        hist: dev.createBuffer({ size: histBytes, usage: S | GPUBufferUsage.COPY_SRC, label: 'coaxHist' }),
        read: dev.createBuffer({ size: histBytes, usage: GPUBufferUsage.MAP_READ | CD, label: 'coaxHistRead' }),
      };
      buffers.push(history.hist, history.read);
      const total = coax.probes.reduce((sum, p) => sum + p.edges.length, 0);
      const edges = new Uint32Array(total);
      const weights = new Float32Array(total);
      const planes = new Uint32Array(2 * probeCount);
      let first = 0;
      coax.probes.forEach((p, q) => {
        edges.set(p.edges, first);
        weights.set(p.weights, first);
        planes[2 * q] = first;
        planes[2 * q + 1] = p.edges.length;
        first += p.edges.length;
      });
      const pipe = this.coaxPipes.probe;
      const bufs = [upload(edges, 'coaxProbeEdges'), upload(weights, 'coaxProbeWeights'), upload(planes, 'coaxProbePlanes'), history.hist];
      passes.push({ pipe, bind: bind(pipe, bufs), groups: probeCount });
    }
    return { passes, probeCount, history, buffers };
  }

  /** Debug/test helper: read the whole E buffer back (3N floats). Slow; tests only. */
  async readE(): Promise<Float32Array> {
    const bytes = 3 * this.N * 4;
    const tmp = this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.bufE, 0, tmp, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await tmp.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(tmp.getMappedRange().slice(0));
    tmp.destroy();
    return out;
  }

  /** Test helper: set initial E (e.g. a Gaussian blob) and run without resetting fields. */
  async runFromState(e0: Float32Array<ArrayBufferLike>, steps: number): Promise<void> {
    const dev = this.device;
    const enc0 = dev.createCommandEncoder();
    enc0.clearBuffer(this.bufH);
    for (const g of this.thinSheets?.ghosts ?? []) enc0.clearBuffer(g);
    for (const b of this.sheetLoss?.state ?? []) enc0.clearBuffer(b);
    enc0.clearBuffer(this.bufPsiE);
    enc0.clearBuffer(this.bufPsiH);
    enc0.clearBuffer(this.bufCounter);
    dev.queue.submit([enc0.finish()]);
    dev.queue.writeBuffer(this.bufE, 0, e0 as Float32Array<ArrayBuffer>);
    if (this.lumped) {
      // The component's E before the step is e0, with no current or charge yet.
      const state = new Float32Array(3 * this.lumped.eIndex.length);
      this.lumped.eIndex.forEach((edge, n) => { state[3 * n] = e0[edge]; });
      dev.queue.writeBuffer(this.lumped.state, 0, state);
    }
    for (let done = 0; done < steps; done += MAX_STEPS_PER_SUBMIT) {
      const enc = dev.createCommandEncoder();
      this.encodeSteps(enc, Math.min(MAX_STEPS_PER_SUBMIT, steps - done));
      dev.queue.submit([enc.finish()]);
    }
    await dev.queue.onSubmittedWorkDone();
  }

  /**
   * Accumulate the far-field box DFT (huygens_box.ts) during every later run:
   * one extra dispatch per step over the box patches. Each run starts the
   * sums from zero; read them with readHuygensDft after the run.
   */
  enableHuygensDft(surface: HuygensSurface, frequenciesHz: readonly number[]): void {
    if (frequenciesHz.length === 0) throw new Error('enableHuygensDft: no frequencies');
    if (this.huygens) throw new Error('enableHuygensDft: already enabled on this engine');
    const patches = new Uint32Array(4 * surface.count);
    const hBelowWeightBits = new Uint32Array(surface.hBelowWeight.buffer, surface.hBelowWeight.byteOffset, surface.count);
    for (let s = 0; s < surface.count; s++) {
      patches[4 * s] = surface.cell[s];
      patches[4 * s + 1] = surface.normalAxis[s];
      patches[4 * s + 2] = hBelowWeightBits[s];
    }
    this.huygens = this.createDftKernel('huygens_dft', huygensDftWgsl, patches, frequenciesHz,
      surface.count * frequenciesHz.length * VALUES_PER_SAMPLE_FREQUENCY, surface.count);
  }

  /** The box DFT of the last run, in the layout of huygens_box.ts (float32). */
  async readHuygensDft(): Promise<Float32Array> {
    if (!this.huygens) throw new Error('readHuygensDft: enableHuygensDft was never called');
    return this.readDftAccumulators(this.huygens);
  }

  /**
   * Accumulate the DFT of Ex, Ey, Ez, Hx, Hy on the z planes `planesK` during
   * every later run: one extra dispatch per step over those planes. Each run
   * starts the sums from zero; read them with readPlaneDft after the run.
   */
  enablePlaneDft(planesK: readonly number[], frequenciesHz: readonly number[]): void {
    assertPlaneDftRequest(this.grid, planesK, frequenciesHz);
    if (this.planeDft) throw new Error('enablePlaneDft: already enabled on this engine');
    const layout = { nx: this.grid.nx, ny: this.grid.ny, planesK, frequenciesHz };
    this.planeDft = this.createDftKernel('plane_dft', planeDftWgsl, Uint32Array.from(planesK), frequenciesHz,
      planeDftLength(layout), planesK.length * this.grid.nx * this.grid.ny);
  }

  /** The plane DFT of the last run, in the layout of plane_dft.ts (planeDftIndex), float32. */
  async readPlaneDft(): Promise<Float32Array> {
    if (!this.planeDft) throw new Error('readPlaneDft: enablePlaneDft was never called');
    return this.readDftAccumulators(this.planeDft);
  }

  /**
   * Accumulate the DFT of all six components at every node during every later
   * run (layout of volume_dft.ts): one extra dispatch per step over the grid
   * and 48 B per node per frequency. Read it with readVolumeDft after the run.
   */
  enableVolumeDft(frequenciesHz: readonly number[]): void {
    assertVolumeDftRequest(frequenciesHz);
    if (this.volumeDft) throw new Error('enableVolumeDft: already enabled on this engine');
    const { nx, ny, nz } = this.grid;
    this.volumeDft = this.createDftKernel('volume_dft', volumeDftWgsl, Uint32Array.of(nx * ny * nz), frequenciesHz,
      volumeDftLength({ nx, ny, nz, frequencies: frequenciesHz.length }), nx * ny * nz);
  }

  /** The volume DFT of the last run, in the layout of volume_dft.ts (volumeDftIndex), float32. */
  async readVolumeDft(): Promise<Float32Array> {
    if (!this.volumeDft) throw new Error('readVolumeDft: enableVolumeDft was never called');
    return this.readDftAccumulators(this.volumeDft);
  }

  /** Stops the volume DFT for later runs and frees its buffers; read it first. */
  disableVolumeDft(): void {
    if (!this.volumeDft) throw new Error('disableVolumeDft: enableVolumeDft was never called');
    for (const b of [this.volumeDft.accumulators, this.volumeDft.readBack, ...this.volumeDft.inputs]) b.destroy();
    this.volumeDft = null;
  }

  private dftKernels(): DftKernel[] {
    return [this.huygens, this.planeDft, this.volumeDft].filter((k): k is DftKernel => k !== null);
  }

  /**
   * A running-DFT kernel dispatched after the port pass of every step. Its
   * shader binds Params, E, H, the step counter, `samples` (what to read), the
   * cycles per step of each frequency and the accumulators, in that order.
   */
  private createDftKernel(label: string, wgsl: string, samples: Uint32Array<ArrayBuffer>, frequenciesHz: readonly number[], accumulatorFloats: number, threads: number): DftKernel {
    const dev = this.device;
    const accumulatorBytes = accumulatorFloats * 4;
    if (accumulatorBytes > dev.limits.maxStorageBufferBindingSize) {
      throw new Error(`${label}: ${accumulatorBytes} B of accumulators exceeds this GPU's ${dev.limits.maxStorageBufferBindingSize} B binding limit; ask for fewer planes or frequencies`);
    }
    const S = GPUBufferUsage.STORAGE;
    const CD = GPUBufferUsage.COPY_DST;
    const dt = timestepSec(this.grid);
    const cyclesPerStep = Float32Array.from(frequenciesHz, (f) => f * dt);
    const bufSamples = dev.createBuffer({ size: samples.byteLength, usage: S | CD, label: `${label}Samples` });
    const bufCycles = dev.createBuffer({ size: cyclesPerStep.byteLength, usage: S | CD, label: `${label}CyclesPerStep` });
    const accumulators = dev.createBuffer({ size: accumulatorBytes, usage: S | CD | GPUBufferUsage.COPY_SRC, label: `${label}Accumulators` });
    const readBack = dev.createBuffer({ size: accumulatorBytes, usage: GPUBufferUsage.MAP_READ | CD, label: `${label}Read` });
    dev.queue.writeBuffer(bufSamples, 0, samples);
    dev.queue.writeBuffer(bufCycles, 0, cyclesPerStep);
    const module = dev.createShaderModule({ code: commonWgsl + '\n' + wgsl, label });
    const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' }, label });
    const bind = dev.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [this.bufParams, this.bufE, this.bufH, this.bufCounter, bufSamples, bufCycles, accumulators]
        .map((buffer, binding) => ({ binding, resource: { buffer } })),
    });
    return { pipe, bind, dispatch: this.flatDispatch(Math.ceil(threads / WG)), accumulators, readBack, inputs: [bufSamples, bufCycles] };
  }

  private async readDftAccumulators(kernel: DftKernel): Promise<Float32Array> {
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(kernel.accumulators, 0, kernel.readBack, 0, kernel.accumulators.size);
    this.device.queue.submit([enc.finish()]);
    await kernel.readBack.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(kernel.readBack.getMappedRange().slice(0));
    kernel.readBack.unmap();
    return out;
  }

  destroy(): void {
    for (const k of this.dftKernels()) for (const b of [k.accumulators, k.readBack, ...k.inputs]) b.destroy();
    for (const b of this.sheetLoss?.buffers ?? []) b.destroy();
    for (const b of this.conformal?.buffers ?? []) b.destroy();
    for (const b of [...(this.thinSheets?.buffers ?? []), ...(this.thinSheets?.ghosts ?? [])]) b.destroy();
    for (const b of this.lumped?.buffers ?? []) b.destroy();
    for (const d of [this.dispersion.e, this.dispersion.h]) for (const b of d?.buffers ?? []) b.destroy();
    for (const b of [this.bufE, this.bufH, this.bufEDecay, this.bufECurl, this.bufCpml, this.bufPsiE, this.bufPsiH,
      this.bufEnergy, this.bufEnergyRead, this.bufDummy, this.bufPortEz, this.bufPortLength, this.bufPortDesc, this.bufHist,
      this.bufCounter, this.bufParams, this.bufHistRead, this.bufFrames, this.bufFramesRead]) b.destroy();
  }
}

interface SparsePass {
  bind: GPUBindGroup;
  dispatch: [number, number];
}

interface CoaxPasses {
  /** Source, then probes: either can be absent. */
  passes: Array<{ pipe: GPUComputePipeline; bind: GPUBindGroup; groups: number }>;
  probeCount: number;
  /** Probe voltage per step and probe, and its read-back copy; null without probes. */
  history: { hist: GPUBuffer; read: GPUBuffer } | null;
  /** Every buffer of the run, destroyed when it ends. */
  buffers: GPUBuffer[];
}

interface DftKernel {
  pipe: GPUComputePipeline;
  bind: GPUBindGroup;
  dispatch: [number, number];
  accumulators: GPUBuffer;
  readBack: GPUBuffer;
  /** Sample list and frequencies: kept only to be destroyed with the engine. */
  inputs: GPUBuffer[];
}

function adapterLabel(a: GPUAdapter): string {
  const info = (a as GPUAdapter & { info?: GPUAdapterInfo }).info;
  if (!info) return 'webgpu';
  return [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'webgpu';
}

/**
 * solvePorts' engine on a WebGPU device: one Fdtd3D per model, sized for the
 * run, destroyed after it. Every run carries coax probes, so their length is
 * the step count.
 */
export function gpuCoaxEngine(device: GPUDevice, adapterName: string): CoaxEngineFactory {
  return async (model, exc, maxSteps) => {
    const gpu = new Fdtd3D(device, model.grid, maxSteps, adapterName);
    try {
      gpu.load(model, exc);
    } catch (error) {
      gpu.destroy();
      throw error;
    }
    return {
      run: async (control, activePort, coax, { onProgress, recorder }) => {
        if (recorder) throw new Error('the GPU engine cannot read the fields after every step; use the CPU engine for a step recorder');
        if (coax.probes.length === 0) throw new Error('a coax engine run needs at least one probe: its length is the step count');
        const r = await gpu.run({ control, activePort, coax, onProgress });
        return { ports: r.ports, coaxProbeVolts: r.coaxProbeVolts, dtSec: r.dtSec, steps: r.coaxProbeVolts[0].length, energyDecayDb: r.energyDecayDb, stoppedOnEnergy: r.stoppedOnEnergy };
      },
      destroy: () => gpu.destroy(),
    };
  };
}
