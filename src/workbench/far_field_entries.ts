/**
 * The far-field figures the result views show, from a pattern and the box
 * currents behind it, and an array's far field re-driven without a solve.
 * Kept out of solve.ts so the page can steer without loading the solver.
 */
import { arrayFarFieldAt, type ArrayFarFieldResult, type PortDrive, type PreparedArray } from '../engine/array_far_field';
import { boresightPolarisation, patternFigures } from '../engine/far_field_pattern';
import { fieldStrengthAt, type BoxSources } from '../engine/near_field';
import type { FarFieldResult } from '../engine/near_to_far';
import { arrayPortDrives, drivenPorts } from '../project/resolve';
import type { Project } from '../project/schema';
import type { FarFieldSummary, WorkbenchFarField } from './solve';

/** The figures the views show for one frequency's pattern, with |E| at 3 m and 10 m from the box currents behind it. */
export function farFieldEntry(result: FarFieldResult | ArrayFarFieldResult, sources: BoxSources): FarFieldSummary {
  const polarisation = boresightPolarisation(result);
  const figures = patternFigures(result, polarisation);
  const fieldAt = (distanceM: number) => fieldStrengthAt(sources, distanceM, result.peakThetaDeg, result.peakPhiDeg);
  return {
    result, polarisation,
    beamwidthEPlaneDeg: figures.beamwidthEPlaneDeg, beamwidthHPlaneDeg: figures.beamwidthHPlaneDeg,
    frontToBackDb: figures.frontToBackDb, crossPolarDb: figures.boresightCrossPolarDb,
    fieldAt3mVPerM: fieldAt(3), fieldAt10mVPerM: fieldAt(10),
  };
}

/** An array's far-field figures at every far-field frequency with these drives (project port order; null: off). */
export function arrayFarFieldEntries(array: PreparedArray, drives: Array<PortDrive | null>): FarFieldSummary[] {
  return array.frequenciesHz.map((_, n) => {
    const { result, sources } = arrayFarFieldAt(array, drives, n);
    return farFieldEntry(result, sources);
  });
}

/**
 * The solved array's far field with the drives `project` sets now: the runs
 * re-summed, with no new solve, since outputs.array_excitation weights the
 * runs and changes nothing they recorded. `farField` itself when the drives
 * are the ones it already shows. `project` must have the solve's ports and
 * excited ports; the caller checks that the results are current.
 */
export function steeredFarField(farField: WorkbenchFarField, project: Project): WorkbenchFarField {
  const { array } = farField;
  if (!array) throw new Error('internal: only an array far field can be steered');
  const drives = arrayPortDrives(project);
  const arrayDrives = drivenPorts(project, drives);
  if (JSON.stringify(arrayDrives) === JSON.stringify(farField.arrayDrives)) return farField;
  return { ...farField, entries: arrayFarFieldEntries(array, drives), arrayDrives };
}
