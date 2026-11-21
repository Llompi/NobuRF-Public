/**
 * Core data contracts shared by the browser engine, the local bridge and the
 * (Saturday) OpenClaw tools. Keep this file dependency-free: it is imported
 * from Node (server/, tests/) and from the browser (src/).
 */

/** Uniform Yee grid. All lengths in millimetres, one cell = `dxMm` on every axis. */
export interface GridConfig {
  nx: number;
  ny: number;
  nz: number;
  /** Cell size (mm). Cubic cells keep the Courant limit simple: Sc <= 1/sqrt(3). */
  dxMm: number;
  /** Courant number c*dt/dx. Must be < 1/sqrt(3) ~ 0.577 for 3D stability. */
  courant: number;
  /** CPML thickness in cells: on every face for DSL models; the thickest face for projects (per-face values live in VoxelModel.cpml.faces). 0 leaves bare walls (see cpml.ts). */
  pmlCells: number;
  /** Ground-plane z index. The substrate sits on top of it. */
  groundK: number;
  /** Timesteps per solve when the run length is fixed. See README "Why 3000 steps, not 450". */
  stepsPerRun: number;
}

/** Gaussian-modulated sine excitation at the port, swept over [fMinGHz, fMaxGHz]. */
export interface ExcitationConfig {
  fMinGHz: number;
  fMaxGHz: number;
  /** Number of frequency points in the port DFT. */
  nFreq: number;
  /** Port reference impedance and source resistance (ohms). */
  z0: number;
}

/* ------------------------------------------------------------------------ */
/* Geometry DSL: what Kimi edits. Small, explicit, millimetre units.         */
/* ------------------------------------------------------------------------ */

export interface RectSlot {
  id: string;
  kind: 'rect_slot';
  /** Centre, relative to patch centre (mm). */
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
}

/** U-shaped slot (opening toward +y, i.e. away from the feed). */
export interface USlot {
  id: string;
  kind: 'u_slot';
  x_mm: number;
  y_mm: number;
  /** Outer width (x) and height (y) of the U. */
  w_mm: number;
  h_mm: number;
  /** Trace width of the slot. */
  t_mm: number;
}

/** Rectangle of added copper (tuning stub). Should touch the patch to matter. */
export interface Stub {
  id: string;
  kind: 'stub';
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
}

export type MicroFeature = RectSlot | USlot | Stub;

export interface MicroGeometryDSL {
  version: 1;
  name: string;
  target_ghz: number;
  /** tan_delta is applied as a conductivity exact at target_ghz (see voxelize.ts). */
  substrate: { eps_r: number; h_mm: number; tan_delta: number };
  ground: { w_mm: number; l_mm: number };
  /** Patch: `w_mm` along x (radiating edges), `l_mm` along y (resonant length). */
  patch: { w_mm: number; l_mm: number };
  /** Microstrip feed entering the patch from -y. */
  feed: { w_mm: number; len_mm: number; inset_depth_mm: number; inset_gap_mm: number };
  /** Chamfer leg length on two opposite corners (0 = none). Used for circular polarisation. */
  corner_chamfer_mm: number;
  features: MicroFeature[];
}

/** Surgical delta accepted by POST /api/apply_edit. All fields optional. */
export interface GeometryEdit {
  /** Optional one-line rationale from the agent (logged, not applied). */
  reason?: string;
  inset_depth_mm?: number;
  inset_gap_mm?: number;
  corner_chamfer_mm?: number;
  patch_w_mm?: number;
  patch_l_mm?: number;
  feed_w_mm?: number;
  upsert_feature?: MicroFeature;
  remove_feature_id?: string;
}

/* ------------------------------------------------------------------------ */
/* Telemetry: what Kimi reads back each turn. Keep it tiny (<~350 tokens).    */
/* ------------------------------------------------------------------------ */

export interface SimTelemetry {
  /** Iteration counter (number of applied edits since reset). */
  it: number;
  target_ghz: number;
  /** Frequency of the deepest S11 dip in the band. */
  f0_ghz: number;
  s11_min_db: number;
  s11_at_target_db: number;
  /** Input impedance at target frequency (ohms, rounded). */
  zin_target: [re: number, im: number];
  /** -10 dB bandwidth around f0 (GHz, 0 if the dip never reaches -10 dB). */
  bw10_ghz: number;
  /** Coarse S11 curve: [ghz, dB] pairs, ~12 points. */
  curve: Array<[number, number]>;
  solve_ms: number;
  steps: number;
  /** Notes for the agent, e.g. edits smaller than one grid cell. */
  warn: string[];
}

/** How long a solve runs. */
export interface RunControl {
  /** Hard cap on timesteps. */
  maxSteps: number;
  /**
   * Stop once the field energy has fallen this many dB below its peak, checked
   * only after the source has finished. null runs exactly maxSteps.
   */
  stopAtEnergyDecayDb: number | null;
  /** Steps between energy checks (energy-stop runs only). Each check costs about one field update. */
  energyCheckEverySteps: number;
}

/** Raw solver output, before it is reduced to telemetry. */
export interface PortSamples {
  /** Voltage V(t) of the active (excited) port at t = (n+1)*dt. */
  v: Float32Array;
  /** Current I(t) of the active port at t = (n+0.5)*dt, into the network. */
  i: Float32Array;
  /** V(t) and I(t) of every port, in VoxelModel.ports order; I flows up the column, into the network. */
  ports: Array<{ v: Float32Array; i: Float32Array }>;
  dtSec: number;
  /** Peak field energy over energy at the last check, in dB. NaN on fixed-length runs, which skip the energy checks. */
  energyDecayDb: number;
  /** True when the energy stop ended the run before maxSteps. */
  stoppedOnEnergy: boolean;
}

/**
 * Coax planes of a run (coax_feed.ts): the soft source of the excited coax
 * feed, if a coax carries the source, and the probe planes of every coax feed.
 * Each step, after the E update, the source adds s(t) * mode[m] to
 * e[edges[m]], then each probe reads V = sum of weights[m] * e[edges[m]].
 */
export interface CoaxRunPlanes {
  source: { edges: Uint32Array; mode: Float32Array } | null;
  probes: Array<{ edges: Uint32Array; weights: Float64Array }>;
}

/** A run with coax planes: every lumped port's V and I, and every probe's V at t = (n+1) dt. */
export interface CoaxRunSamples {
  ports: Array<{ v: Float32Array; i: Float32Array }>;
  coaxProbeVolts: Float64Array[];
  dtSec: number;
  steps: number;
  energyDecayDb: number;
  stoppedOnEnergy: boolean;
}

/* ------------------------------------------------------------------------ */
/* Race: the same agent task on two inference providers, side by side.       */
/* ------------------------------------------------------------------------ */

export type LaneStatus = 'idle' | 'running' | 'matched' | 'gave_up' | 'error';

export interface LaneState {
  id: string;
  /** Model name, e.g. "Kimi K3.1 Pro". */
  label: string;
  /** Inference host, e.g. "Cerebras" or "Fireworks (GPU)". */
  provider?: string;
  it: number;
  status: LaneStatus;
  /** Race time (same basis as elapsed_ms) when S11 at target first reached target_db, else null. */
  matched_ms: number | null;
  /**
   * Race time in ms: wall clock since the start, minus time this lane spent
   * waiting for the other lanes' solves on the shared GPU. Frozen once the lane finishes.
   */
  elapsed_ms: number;
  /** Sum of the model latency the harness reported with each edit. */
  llm_ms: number;
  /** Sum of completion tokens the harness reported with each edit. */
  tokens: number;
  /** Total time this lane's finished edits waited for the shared GPU. */
  queue_ms: number;
  /** Bridge clock when this lane's current edit started waiting for the GPU, or null if it is not waiting. */
  queued_since: number | null;
  telemetry: SimTelemetry | null;
  note?: string;
}

export interface RaceState {
  /** Bridge clock (epoch ms) when the race started. */
  t0: number;
  /** Bridge clock when this snapshot was taken, for client clock offset. */
  now: number;
  /** A lane is matched once S11 at target is at or below this. */
  target_db: number;
  /** True when edits are scripted (UI shows a DRY RUN watermark). */
  dry_run: boolean;
  /** Optional watermark text for a dry run, e.g. "SIMULATED SPEEDS · scripted model, not Kimi". */
  banner?: string;
  lanes: LaneState[];
}

/** Bridge <-> browser WebSocket protocol. */
export type BridgeToClient =
  | {
      type: 'run';
      id: string;
      dsl: MicroGeometryDSL;
      it: number;
      label?: string;
      reason?: string;
      /** Race lane this run belongs to; '*' = every lane (race baseline). Absent = main view. */
      lane?: string;
    }
  /** The bridge stopped waiting for this run (timeout) and did not apply it. The page must not show it as the current design. */
  | { type: 'discard'; id: string }
  | { type: 'meter'; rpm: number; tpm: number; rpmCap: number; tpmCap: number }
  | { type: 'race'; race: RaceState | null };

export type ClientToBridge =
  | { type: 'hello'; adapter: string }
  | { type: 'result'; id: string; telemetry: SimTelemetry }
  | { type: 'error'; id: string; message: string };
