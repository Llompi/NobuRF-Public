/// <reference lib="webworker" />
/**
 * Runs one solve per message, off the page's thread. Cancel by terminating
 * the worker (solve_client.ts): the CPU solver never yields, so a message
 * could not reach it mid-run.
 */
import { SCAN_COMPONENTS } from '../engine/near_field';
import type { ComplexPlane, FieldPlanes } from './plane_dft';
import { solveWorkbenchProject, type NearFieldScan, type SolverChoice } from './solve';
import type { AccuracyMode } from '../verify/accuracy';
import type { WorkerReply } from './solve_client';

const post = (reply: WorkerReply, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(reply, transfer);

self.onmessage = async (event: MessageEvent<{ projectText: string; choice: SolverChoice; accuracy: AccuracyMode; fieldVolume: boolean }>) => {
  try {
    const result = await solveWorkbenchProject(event.data.projectText, event.data.choice, {
      onStart: (start) => post({ type: 'start', start }),
      onProgress: (progress) => post({ type: 'progress', progress }),
    }, event.data.accuracy, event.data.fieldVolume);
    // The field volumes, an array's per-run field views and its box DFTs can be tens of MiB: hand their buffers over instead of copying them.
    const largeBuffers = new Set<ArrayBuffer>();
    const addPlane = (plane: ComplexPlane) => [plane.re, plane.im].forEach((part) => largeBuffers.add(part.buffer as ArrayBuffer));
    const addViews = (planes: FieldPlanes[], nearField: NearFieldScan[] | null) => {
      planes.forEach((plane) => [plane.ez, plane.jx, plane.jy].forEach(addPlane));
      nearField?.forEach((scan) => scan.planes.forEach((scanPlane) => SCAN_COMPONENTS.forEach((component) => addPlane(scanPlane[component]))));
    };
    for (const volume of result.fields?.volume?.accumulatorsPerRun ?? []) largeBuffers.add(volume.buffer as ArrayBuffer);
    addViews(result.fields?.planes ?? [], result.nearField);
    for (const run of result.fieldRuns ?? []) addViews(run.planes, run.nearField);
    for (const run of result.farField?.array?.runs ?? []) {
      if (ArrayBuffer.isView(run.accumulators)) largeBuffers.add(run.accumulators.buffer as ArrayBuffer);
    }
    post({ type: 'done', result }, [...largeBuffers]);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
