/// <reference lib="webworker" />
/**
 * Runs one solve per message, off the page's thread. Cancel by terminating
 * the worker (solve_client.ts): the CPU solver never yields, so a message
 * could not reach it mid-run.
 */
import { solveWorkbenchProject, type SolverChoice } from './solve';
import type { AccuracyMode } from '../verify/accuracy';
import type { WorkerReply } from './solve_client';

const post = (reply: WorkerReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(reply, transfer);

self.onmessage = async (event: MessageEvent<{ projectText: string; choice: SolverChoice; accuracy: AccuracyMode; fieldVolume: boolean }>) => {
  try {
    const result = await solveWorkbenchProject(event.data.projectText, event.data.choice, {
      onStart: (start) => post({ type: 'start', start }),
      onProgress: (progress) => post({ type: 'progress', progress }),
    }, event.data.accuracy, event.data.fieldVolume);
    // The field volume can be tens of MiB: hand its buffer over instead of copying it.
    const volume = result.fields?.volume?.accumulators.buffer;
    post({ type: 'done', result }, volume ? [volume as ArrayBuffer] : []);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
