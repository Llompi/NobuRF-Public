import type { FieldRecording } from './fdtd3d';
import type { FieldSolution } from './field_solution';
import type { GridConfig } from './types';

export interface FieldRequest {
  requestId: number;
  recording: FieldRecording;
  grid: GridConfig;
  frequencyGHz: number;
}

export type FieldResponse = { requestId: number; fields: FieldSolution } | { requestId: number; error: string };
