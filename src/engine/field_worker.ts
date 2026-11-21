/// <reference lib="webworker" />
/**
 * Field post-processing off the main thread. The page's main thread drives the
 * GPU solver; running the DFT and far field here keeps the next solve (and the
 * next race lane) from waiting on it.
 */
import { fieldSolution } from './field_solution';
import type { FieldRequest, FieldResponse } from './field_worker_protocol';

self.onmessage = (event: MessageEvent<FieldRequest>) => {
  const { requestId, recording, grid, frequencyGHz } = event.data;
  let response: FieldResponse;
  try {
    response = { requestId, fields: fieldSolution(recording, grid, frequencyGHz) };
  } catch (error) {
    response = { requestId, error: String((error as Error).message ?? error) };
  }
  self.postMessage(response);
};
