import { timestepSec } from './config';
import { apertureFarField, type FarFieldPattern } from './far_field';
import type { FieldRecording } from './fdtd3d';
import { planePhasor, type PlanePhasor } from './field_phasor';
import type { GridConfig } from './types';

/** Fields at one frequency, ready for the viewer. */
export interface FieldSolution {
  frequencyGHz: number;
  /** Ez in the middle of the substrate (the cavity field under the patch). */
  substrateEz: PlanePhasor;
  farField: FarFieldPattern;
}

export function fieldSolution(recording: FieldRecording, grid: GridConfig, frequencyGHz: number): FieldSolution {
  const dt = timestepSec(grid);
  const times = recording.substrateEz.map((_, n) => (recording.firstStep + (n + 1) * recording.stepsBetweenFrames) * dt);
  const hz = frequencyGHz * 1e9;
  const apertureEx = planePhasor(recording.apertureEx, times, hz);
  const apertureEy = planePhasor(recording.apertureEy, times, hz);
  return {
    frequencyGHz,
    substrateEz: planePhasor(recording.substrateEz, times, hz),
    farField: apertureFarField(
      apertureEx, apertureEy,
      { nx: grid.nx, ny: grid.ny, dxMm: grid.dxMm, borderCells: grid.pmlCells },
      hz,
    ),
  };
}
