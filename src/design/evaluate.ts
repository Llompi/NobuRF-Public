import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import { nearToFarField } from '../engine/near_to_far';
import type { Project } from '../project/schema';
import { solveProjectText } from '../../scripts/noburf';
import { axialRatio, metricsFromSpectrum, type DesignGoal, type DesignMetrics } from './goal';

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
}

/**
 * Solve one project exactly as `noburf solve` does, and measure it against the
 * goal. The CLI's one progress line per solve is kept out of the output.
 */
export async function solveForMetrics(project: Project, goal: DesignGoal, useGpu: boolean): Promise<Evaluation> {
  const log = console.log;
  console.log = () => {};
  let solved;
  try {
    solved = await solveProjectText(JSON.stringify(project), project.name, useGpu);
  } finally {
    console.log = log;
  }
  const metrics = metricsFromSpectrum(solved.spec, goal);
  if (goal.max_axial_ratio_db !== undefined) {
    if (!solved.farField || !solved.huygensAccumulators || !solved.samples) throw new Error('an axial-ratio goal needs outputs.far_field_ghz at the target');
    // Only boresight is needed: theta 0 and 180, four azimuths, instead of the full 5 degree sphere.
    const [ff] = nearToFarField({ ...solved.farField, accumulators: solved.huygensAccumulators, samples: solved.samples, exc: solved.exc, angles: { thetaSteps: 2, phiSteps: 4 } });
    const ar = axialRatio(ff.rEThetaRe[0], ff.rEThetaIm[0], ff.rEPhiRe[0], ff.rEPhiIm[0]);
    metrics.axial_ratio_db = ar.db;
    metrics.polarisation_sense = ar.sense;
  }
  const spectrum = { fGHz: Array.from(solved.spec.fGHz), s11Db: Array.from(solved.spec.s11Db), zRe: Array.from(solved.spec.zRe), zIm: Array.from(solved.spec.zIm) };
  const { nx, ny, nz } = solved.model.grid;
  return { metrics, spectrum, cells: nx * ny * nz, steps: solved.steps, solveMs: solved.solveMs, warnings: solved.warnings.filter((w) => !w.startsWith('solver source')) };
}

export interface Evaluator {
  /** Solve several projects, as parallel as the evaluator allows. A failed solve rejects only its own entry. */
  evaluateAll(projects: Project[]): Promise<Array<PromiseSettledResult<Evaluation>>>;
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
export function createEvaluator(goal: DesignGoal, options: { useGpu: boolean; workers?: number }): Evaluator {
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

  const solveOnGpu = (project: Project): Promise<Evaluation> => {
    const run = gpuQueue.then(() => solveForMetrics(project, goal, true));
    gpuQueue = run.catch(() => {});
    return run;
  };

  const evaluate = async (project: Project): Promise<Evaluation> => {
    const e = await (options.useGpu ? solveOnGpu(project) : solveInWorker(project));
    stats.solves++;
    stats.solveMs += e.solveMs;
    return e;
  };

  return {
    evaluateAll: (projects) => Promise.allSettled(projects.map(evaluate)),
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
