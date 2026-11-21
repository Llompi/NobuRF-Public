import type { AccuracyMode } from '../verify/accuracy';
import type { SolveProgress, SolverChoice, SolveStart, WorkbenchResult } from './solve';

export type WorkerReply =
  | { type: 'start'; start: SolveStart }
  | { type: 'progress'; progress: SolveProgress }
  | { type: 'done'; result: WorkbenchResult }
  | { type: 'error'; message: string };

export interface SolveCallbacks {
  onStart(start: SolveStart): void;
  onProgress(progress: SolveProgress): void;
}

export class SolveCancelled extends Error {
  constructor() {
    super('Solve stopped');
  }
}

/**
 * One solve in a fresh worker. `cancel` ends it at once and rejects the promise with SolveCancelled.
 * `fieldVolume` keeps E and H at every node for cuts (FieldMaps.volume), which costs memory and solve time.
 */
export function startSolve(projectText: string, choice: SolverChoice, accuracy: AccuracyMode, fieldVolume: boolean, callbacks: SolveCallbacks): { done: Promise<WorkbenchResult>; cancel(): void } {
  const worker = new Worker(new URL('./solve_worker.ts', import.meta.url), { type: 'module' });
  let rejectRun: (error: Error) => void = () => undefined;
  const done = new Promise<WorkbenchResult>((resolve, reject) => {
    rejectRun = reject;
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.type === 'start') callbacks.onStart(reply.start);
      else if (reply.type === 'progress') callbacks.onProgress(reply.progress);
      else {
        worker.terminate();
        if (reply.type === 'done') resolve(reply.result);
        else reject(new Error(reply.message));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The solver stopped unexpectedly'));
    };
  });
  worker.postMessage({ projectText, choice, accuracy, fieldVolume });
  return {
    done,
    cancel() {
      worker.terminate();
      rejectRun(new SolveCancelled());
    },
  };
}
