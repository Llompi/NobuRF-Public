import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { interp } from '../engine/port_dft';
import type { Project } from '../project/schema';
import { solvedFarField, solveProjectText, type LiveSolve } from '../../scripts/noburf';
import type { Spectrum } from '../engine/port_dft';
import { axialRatio, metricsFromSpectrum, roundedSpectrum, type DesignGoal, type DesignMetrics } from './goal';

export interface Evaluation {
  /** Against the design goal. */
  metrics: DesignMetrics;
  /** S11 and Z_in over the band, so the metrics can be taken again against another aim. */
  spectrum: { fGHz: number[]; s11Db: number[]; zRe?: number[]; zIm?: number[] };
  /** Cells of the grid, so a study can tell when a change of value also changed the mesh. */
  cells?: number;
  steps: number;
  solveMs: number;
  /** Solver warnings (truncated run, mesh), passed on so nobody trusts a bad number silently. */
  warnings: string[];
  /** Set when the solve was stopped before its energy stop: the numbers are from the signal so far. */
  stoppedEarly?: { steps: number; energyDecayDb: number; reason: string };
}

/** A running solve, seen partway: S11 from the port signal so far, measured against the goal. */
export interface LiveFrame {
  /** Counts solves this evaluator has started, from 1. */
  solve: number;
  stepsDone: number;
  energyDecayDb: number;
  metrics: DesignMetrics;
  /** S11 so far over the band, for the live view (dB, 3 decimals). */
  spectrum: { fGHz: number[]; s11Db: number[] };
}

/** What the evaluator streams while a watched solve runs (GPU only). */
export interface LiveOptions {
  /** Steps between frames; each frame costs one read-back of the port history. */
  everySteps: number;
  onFrame: (frame: LiveFrame) => void;
}

const zAt = (spec: Spectrum, ghz: number) => ({ re: interp(spec.fGHz, spec.zRe, ghz), im: interp(spec.fGHz, spec.zIm, ghz) });

/**
 * Solve one project exactly as `noburf solve` does, and measure it against the
 * goal. The CLI's one progress line per solve is kept out of the output.
 */
export async function solveForMetrics(project: Project, goal: DesignGoal, useGpu: boolean, live?: LiveSolve): Promise<Evaluation> {
  const log = console.log;
  console.log = () => {};
  let solved;
  try {
    solved = await solveProjectText(JSON.stringify(project), project.name, useGpu, false, live);
  } finally {
    console.log = log;
  }
  const metrics = metricsFromSpectrum(solved.spec, goal);
  metrics.z_target_ohm = zAt(solved.spec, goal.target_ghz);
  if (goal.max_axial_ratio_db !== undefined) {
    // Only boresight is needed: theta 0 and 180, four azimuths, instead of the full 5 degree sphere.
    const farField = solvedFarField(solved, { thetaSteps: 2, phiSteps: 4 });
    if (!farField) throw new Error('an axial-ratio goal needs outputs.far_field_ghz at the target');
    const [ff] = farField.results;
    const ar = axialRatio(ff.rEThetaRe[0], ff.rEThetaIm[0], ff.rEPhiRe[0], ff.rEPhiIm[0]);
    metrics.axial_ratio_db = ar.db;
    metrics.polarisation_sense = ar.sense;
  }
  const spectrum = { fGHz: Array.from(solved.spec.fGHz), s11Db: Array.from(solved.spec.s11Db), zRe: Array.from(solved.spec.zRe), zIm: Array.from(solved.spec.zIm) };
  const { nx, ny, nz } = solved.model.grid;
  return { metrics, spectrum, cells: nx * ny * nz, steps: solved.steps, solveMs: solved.solveMs, warnings: solved.warnings.filter((w) => !w.startsWith('solver source')) };
}

export interface Evaluator {
  /**
   * Solve several projects, as parallel as the evaluator allows. A failed solve rejects only its own entry.
   * watch: stream frames of these solves (when the evaluator has live options) and let stopCurrent end them early.
   */
  evaluateAll(projects: Project[], options?: { watch?: boolean }): Promise<Array<PromiseSettledResult<Evaluation>>>;
  /**
   * End the watched solve that is running now at its next frame; it returns the numbers from the signal so far,
   * marked stoppedEarly. False when no watched solve is running or it has no frame yet.
   */
  stopCurrent(reason: string): boolean;
  /** Solves run. */
  readonly solves: number;
  /** Total solver wall time, ms. */
  readonly solveMs: number;
  close(): Promise<void>;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
}

/**
 * Solves on the CPU in worker threads (one solve per core), or on the GPU one
 * at a time in this thread.
 */
export function createEvaluator(goal: DesignGoal, options: { useGpu: boolean; workers?: number; live?: LiveOptions }): Evaluator {
  const stats = { solves: 0, solveMs: 0 };
  const poolSize = options.useGpu ? 0 : Math.max(1, options.workers ?? Math.min(availableParallelism(), 8));
  const slots: WorkerSlot[] = [];
  const waiting: Array<(slot: WorkerSlot) => void> = [];
  let nextJob = 0;
  let gpuQueue: Promise<unknown> = Promise.resolve();

  const newWorker = () => {
    const worker = new Worker(new URL('./solve_worker.mjs', import.meta.url));
    worker.unref();
    return worker;
  };
  const acquire = (): Promise<WorkerSlot> => {
    const free = slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return Promise.resolve(free);
    }
    if (slots.length < poolSize) {
      const slot = { worker: newWorker(), busy: true };
      slots.push(slot);
      return Promise.resolve(slot);
    }
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (slot: WorkerSlot) => {
    const next = waiting.shift();
    if (next) next(slot);
    else slot.busy = false;
  };

  const solveInWorker = async (project: Project): Promise<Evaluation> => {
    const slot = await acquire();
    const id = nextJob++;
    try {
      return await new Promise<Evaluation>((resolve, reject) => {
        const onMessage = (msg: { id: number; result?: Evaluation; error?: string }) => {
          if (msg.id !== id) return;
          slot.worker.off('message', onMessage);
          slot.worker.off('error', onError);
          if (msg.error !== undefined) reject(new Error(msg.error));
          else resolve(msg.result!);
        };
        const onError = (e: Error) => {
          slot.worker.off('message', onMessage);
          // The thread is gone: give the slot a fresh one.
          slot.worker = newWorker();
          reject(e);
        };
        slot.worker.on('message', onMessage);
        slot.worker.once('error', onError);
        slot.worker.postMessage({ id, project, goal });
      });
    } finally {
      release(slot);
    }
  };

  let started = 0;
  /** The watched solve running now: its stop switch and its newest frame. */
  let current: { controller: AbortController; frame: LiveFrame | null; reason: string | null } | null = null;

  const solveWatched = async (project: Project, live: LiveOptions): Promise<Evaluation> => {
    const solve = ++started;
    const me = { controller: new AbortController(), frame: null as LiveFrame | null, reason: null as string | null };
    let lastSpectrum = { fGHz: [] as number[], s11Db: [] as number[] };
    current = me;
    const t0 = performance.now();
    try {
      return await solveForMetrics(project, goal, true, {
        everySteps: live.everySteps,
        signal: me.controller.signal,
        onFrame: ({ stepsDone, energyDecayDb, spec }) => {
          const metrics = metricsFromSpectrum(spec, goal);
          metrics.z_target_ohm = zAt(spec, goal.target_ghz);
          lastSpectrum = { fGHz: Array.from(spec.fGHz), s11Db: Array.from(spec.s11Db) };
          me.frame = { solve, stepsDone, energyDecayDb, metrics, spectrum: roundedSpectrum(lastSpectrum) };
          live.onFrame(me.frame);
        },
      });
    } catch (e) {
      // Only our own abort is a stop; anything else (a lost device, say) stays an error.
      if (me.reason === null || !me.frame || (e as Error).name !== 'AbortError') throw e;
      // Stopped on purpose: the newest frame is the result, and says so.
      const f = me.frame;
      return {
        metrics: f.metrics, spectrum: lastSpectrum, steps: f.stepsDone, solveMs: performance.now() - t0,
        warnings: [`stopped early after ${f.stepsDone} steps (energy down ${f.energyDecayDb.toFixed(0)} dB): ${me.reason}`],
        stoppedEarly: { steps: f.stepsDone, energyDecayDb: f.energyDecayDb, reason: me.reason },
      };
    } finally {
      if (current === me) current = null;
    }
  };

  const solveOnGpu = (project: Project, watch: boolean): Promise<Evaluation> => {
    const live = watch ? options.live : undefined;
    const run = gpuQueue.then(() => (live ? solveWatched(project, live) : solveForMetrics(project, goal, true)));
    gpuQueue = run.catch(() => {});
    return run;
  };

  const evaluate = async (project: Project, watch: boolean): Promise<Evaluation> => {
    const e = await (options.useGpu ? solveOnGpu(project, watch) : solveInWorker(project));
    stats.solves++;
    stats.solveMs += e.solveMs;
    return e;
  };

  return {
    evaluateAll: (projects, opts) => Promise.allSettled(projects.map((p) => evaluate(p, opts?.watch ?? false))),
    stopCurrent: (reason) => {
      if (!current?.frame || current.reason !== null) return false;
      current.reason = reason;
      current.controller.abort();
      return true;
    },
    get solves() {
      return stats.solves;
    },
    get solveMs() {
      return stats.solveMs;
    },
    close: async () => {
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
