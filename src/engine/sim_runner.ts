import { DEFAULT_EXCITATION, DEFAULT_GRID } from './config';
import { Fdtd3D, type FieldRecording } from './fdtd3d';
import { portSpectrum, type PortSpectrum } from './port_dft';
import { buildTelemetry } from './telemetry';
import type { ExcitationConfig, GridConfig, MicroGeometryDSL, SimTelemetry } from './types';
import { voxelize, type VoxelModel } from './voxelize';

export interface SolveOutcome {
  telemetry: SimTelemetry;
  spectrum: PortSpectrum;
  model: VoxelModel;
  /** Field planes over the whole run, for the field plot and far field. */
  recording: FieldRecording;
  /** True when the geometry voxelised identically to this caller's previous run and that result was reused. */
  cached: boolean;
}

export interface SolveOptions {
  /**
   * Who is asking. The no-change shortcut only compares against the same
   * caller's previous geometry, so two race lanes never share a cached result.
   */
  callerId: string;
}

/** Whole run, every 20 steps: 150 frames, enough for a DFT up to 7.5 GHz. */
const STEPS_BETWEEN_FRAMES = 20;

interface CachedSolve {
  signature: string;
  telemetry: SimTelemetry;
  spectrum: PortSpectrum;
  recording: FieldRecording;
}

/**
 * Browser-side pipeline: DSL -> voxels -> WebGPU FDTD -> DFT -> telemetry.
 *
 * Edits smaller than half a cell can voxelise to exactly the same grid. Instead
 * of burning a solve (and an agent turn) on a no-op, we detect it with the voxel
 * signature and hand back the caller's previous result with an explicit warning,
 * so the agent learns the grid resolution instead of thinking its edit did nothing.
 */
export class SimRunner {
  private readonly previousByCaller = new Map<string, CachedSolve>();

  private constructor(
    readonly engine: Fdtd3D,
    readonly grid: GridConfig,
    readonly exc: ExcitationConfig,
  ) {}

  static async create(grid = DEFAULT_GRID, exc = DEFAULT_EXCITATION): Promise<SimRunner> {
    return new SimRunner(await Fdtd3D.create(grid, grid.stepsPerRun), grid, exc);
  }

  /** Forget every caller's previous geometry (a new race starts every lane from the baseline). */
  forgetCallers(): void {
    this.previousByCaller.clear();
  }

  async solve(dsl: MicroGeometryDSL, it: number, { callerId }: SolveOptions): Promise<SolveOutcome> {
    const t0 = performance.now();
    const model = voxelize(dsl, this.grid, this.exc.z0);
    const previous = this.previousByCaller.get(callerId);
    if (previous && previous.signature === model.signature) {
      // Same iteration = a plain re-run (/api/run), not an edit: no warning.
      const isRerun = previous.telemetry.it === it;
      const telemetry: SimTelemetry = {
        ...previous.telemetry,
        it,
        solve_ms: 0,
        warn: isRerun ? previous.telemetry.warn : [`no_voxel_change: edit is below the ${this.grid.dxMm} mm grid, geometry unchanged`],
      };
      return { telemetry, spectrum: previous.spectrum, model, recording: previous.recording, cached: true };
    }
    this.engine.load(model, this.exc);
    const res = await this.engine.run({
      record: {
        stepsBetweenFrames: STEPS_BETWEEN_FRAMES,
        firstStep: 0,
        substratePlaneK: model.ports[0].k0 + 1,
        aperturePlaneK: model.ports[0].k1 + 1,
      },
    });
    const spectrum = portSpectrum(res, this.exc);
    const telemetry = buildTelemetry({
      spec: spectrum,
      targetGHz: dsl.target_ghz,
      it,
      solveMs: performance.now() - t0,
      steps: res.v.length,
    });
    if (!res.recording) throw new Error('solver returned no field recording');
    this.previousByCaller.set(callerId, { signature: model.signature, telemetry, spectrum, recording: res.recording });
    return { telemetry, spectrum, model, recording: res.recording, cached: false };
  }
}
