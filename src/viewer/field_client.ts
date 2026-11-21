import type { FieldRecording } from '../engine/fdtd3d';
import type { FieldSolution } from '../engine/field_solution';
import type { FieldRequest, FieldResponse } from '../engine/field_worker_protocol';
import type { GridConfig } from '../engine/types';

const worker = new Worker(new URL('../engine/field_worker.ts', import.meta.url), { type: 'module' });
const waiting = new Map<number, { resolve: (f: FieldSolution) => void; reject: (e: Error) => void }>();
let nextRequestId = 1;

worker.onmessage = (event: MessageEvent<FieldResponse>) => {
  const reply = event.data;
  const caller = waiting.get(reply.requestId);
  if (!caller) throw new Error(`field worker answered unknown request ${reply.requestId}`);
  waiting.delete(reply.requestId);
  if ('error' in reply) caller.reject(new Error(reply.error));
  else caller.resolve(reply.fields);
};
worker.onerror = (event) => {
  const error = new Error(`field worker crashed: ${event.message}`);
  for (const caller of waiting.values()) caller.reject(error);
  waiting.clear();
};

/** Field plot and far field for one solve, computed in a worker. */
export function computeFields(recording: FieldRecording, grid: GridConfig, frequencyGHz: number): Promise<FieldSolution> {
  const requestId = nextRequestId++;
  return new Promise((resolve, reject) => {
    waiting.set(requestId, { resolve, reject });
    worker.postMessage({ requestId, recording, grid, frequencyGHz } satisfies FieldRequest);
  });
}
