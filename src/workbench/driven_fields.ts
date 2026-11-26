/**
 * The field views of an array with every port driven at once
 * (outputs.array_excitation). Each run records the fields with one port
 * driven and the others loaded; the driven array's fields are the runs'
 * fields summed with the drives as weights, as the far field is
 * (engine/array_far_field.ts). A new drive only changes the weights, so the
 * views follow the steering controls without a solve.
 */
import { drivePhasor, isZero, type PortDrive } from '../engine/array_far_field';
import { SCAN_COMPONENTS, type ScanPlane } from '../engine/near_field';
import { multiply, type Complex } from '../engine/port_dft';
import { withMinus } from '../ui/format';
import type { ComplexPlane, FieldPlanes } from './plane_dft';
import type { FieldMaps, NearFieldScan } from './solve';

/** One run's field views, kept so they can be summed again for other drives. */
export interface FieldRun {
  /** Project index of the port this run drove. */
  port: number;
  /**
   * Per field frequency, the first run's source DFT over this run's. The
   * plane and volume DFTs are raw sums, which scale with each run's own
   * source; this puts every run on the first run's scale.
   */
  firstSourceOverOwn: Complex[];
  /** The run's own field planes, one per field frequency. */
  planes: FieldPlanes[];
  /** The run's near-field scans, already per volt of its own source. Null with no scan. */
  nearField: NearFieldScan[] | null;
}

/** The driven ports as the field legend and the far-field facts list them: "left 1 at 0°, right 1 at 90°". */
export function portDrivesText(drives: Array<{ portId: string } & PortDrive>): string {
  return drives.map((drive) => `${drive.portId} ${drive.amplitude} at ${withMinus(String(drive.phaseDeg))}°`).join(', ');
}

/** Sum of complex planes with complex weights. */
function weightedSum(planes: ComplexPlane[], weights: Complex[]): ComplexPlane {
  const length = planes[0].re.length;
  const sum: ComplexPlane = { re: new Float32Array(length), im: new Float32Array(length) };
  planes.forEach((plane, m) => {
    if (isZero(weights[m])) return;
    const [weightRe, weightIm] = weights[m];
    for (let n = 0; n < length; n++) {
      sum.re[n] += weightRe * plane.re[n] - weightIm * plane.im[n];
      sum.im[n] += weightRe * plane.im[n] + weightIm * plane.re[n];
    }
  });
  return sum;
}

/**
 * The field maps and near-field scans with the ports driven by `drives`
 * (project port order; null: off, a load). `fields` gives the layout
 * (coordinates, volume) and the runs' first scans give the scan heights;
 * the field values are the weighted sums of the runs'.
 */
export function drivenFieldViews(
  fields: FieldMaps, runs: FieldRun[], drives: Array<PortDrive | null>, portIds: string[],
): { fields: FieldMaps; nearField: NearFieldScan[] | null } {
  if (drives.length !== portIds.length) throw new Error(`drivenFieldViews: ${drives.length} drives for ${portIds.length} ports`);
  drives.forEach((drive, port) => {
    if (drive && !runs.some((run) => run.port === port)) throw new Error(`drivenFieldViews: port ${portIds[port]} has a drive but no run recorded its fields`);
  });
  const runDrives = runs.map((run) => drivePhasor(drives[run.port]));
  if (runDrives.every(isZero)) throw new Error('drivenFieldViews: every port is off; drive at least one');
  if (fields.volume && fields.volume.accumulatorsPerRun.length !== runs.length) {
    throw new Error(`drivenFieldViews: the volume has ${fields.volume.accumulatorsPerRun.length} runs, the field runs ${runs.length}`);
  }
  const scanLayout = runs[0].nearField;
  if (runs.some((run) => (run.nearField === null) !== (scanLayout === null))) throw new Error('drivenFieldViews: some runs have near-field scans and some do not');
  // Raw DFTs: per field frequency, per run, the drive times the source ratio. Scans are per volt already: the drive alone.
  const rawWeights = fields.planes.map((_, frequency) => runs.map((run, m) => multiply(runDrives[m], run.firstSourceOverOwn[frequency])));

  const planes = fields.planes.map((plane, frequency): FieldPlanes => {
    const sumOf = (pick: (p: FieldPlanes) => ComplexPlane) => weightedSum(runs.map((run) => pick(run.planes[frequency])), rawWeights[frequency]);
    return { frequencyGHz: plane.frequencyGHz, ez: sumOf((p) => p.ez), jx: sumOf((p) => p.jx), jy: sumOf((p) => p.jy) };
  });
  const volume = fields.volume && {
    ...fields.volume,
    weightsPerRun: runs.map((_, m) => rawWeights.slice(0, fields.volume!.frequencies).map((weights) => weights[m])),
  };
  const nearField = scanLayout?.map((scan, s): NearFieldScan => ({
    ...scan,
    planes: scan.planes.map((_, frequency) => Object.fromEntries(SCAN_COMPONENTS.map((component) =>
      [component, weightedSum(runs.map((run) => run.nearField![s].planes[frequency][component]), runDrives)])) as ScanPlane),
  })) ?? null;
  const driven = drives.flatMap((drive, port) => (drive ? [{ portId: portIds[port], ...drive }] : []));
  return { fields: { ...fields, planes, volume, shownDrive: `ports driven ${portDrivesText(driven)}` }, nearField };
}
