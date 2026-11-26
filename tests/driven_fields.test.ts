import { describe, expect, it } from 'vitest';
import { SCAN_COMPONENTS, type ScanPlane } from '../src/engine/near_field';
import type { Complex } from '../src/engine/port_dft';
import { drivenFieldViews, portDrivesText, type FieldRun } from '../src/workbench/driven_fields';
import type { ComplexPlane, FieldPlanes } from '../src/workbench/plane_dft';
import type { FieldMaps, NearFieldScan } from '../src/workbench/solve';

/** A plane of `length` nodes holding one complex value everywhere. */
const filled = (length: number, [re, im]: Complex): ComplexPlane => ({ re: new Float32Array(length).fill(re), im: new Float32Array(length).fill(im) });
const fieldPlanes = (value: Complex): FieldPlanes => ({ frequencyGHz: 5, ez: filled(4, value), jx: filled(4, value), jy: filled(4, value) });
const scanPlane = (value: Complex): ScanPlane => Object.fromEntries(SCAN_COMPONENTS.map((c) => [c, filled(4, value)])) as ScanPlane;
const scan = (value: Complex): NearFieldScan[] => [{ heightMm: 2, meshHeightMm: 2, planes: [scanPlane(value)] }];

/** Two runs at one field frequency: port 0 records 1, port 1 records j; run 1's source is half run 0's. */
function twoRuns(): { fields: FieldMaps; runs: FieldRun[] } {
  const runs: FieldRun[] = [
    { port: 0, firstSourceOverOwn: [[1, 0]], planes: [fieldPlanes([1, 0])], nearField: scan([1, 0]) },
    { port: 1, firstSourceOverOwn: [[2, 0]], planes: [fieldPlanes([0, 1])], nearField: scan([0, 1]) },
  ];
  const fields = {
    planes: runs[0].planes,
    volume: { zMm: new Float64Array(2), pmlZ: { low: 0, high: 0 }, frequencies: 1, accumulatorsPerRun: [new Float32Array(2), new Float32Array(2)], weightsPerRun: [[[1, 0]], [[0, 0]]] },
    shownDrive: 'port a driven, the others loaded',
  } as unknown as FieldMaps;
  return { fields, runs };
}

describe('the field views of a driven array', () => {
  it('sums the runs with the drives, scaling the raw DFTs to the first run\'s source, and labels the drives', () => {
    const { fields, runs } = twoRuns();
    // Port b at 90°: its weight is j. Raw: 1 + j * 2 * j = -1. Scans, per volt already: 1 + j * j = 0.
    const views = drivenFieldViews(fields, runs, [{ amplitude: 1, phaseDeg: 0 }, { amplitude: 1, phaseDeg: 90 }], ['a', 'b']);
    expect(views.fields.planes[0].ez.re[3]).toBeCloseTo(-1, 6);
    expect(views.fields.planes[0].ez.im[3]).toBeCloseTo(0, 6);
    expect(views.fields.planes[0].jy.re[0]).toBeCloseTo(-1, 6);
    expect(views.nearField![0].planes[0].hz.re[1]).toBeCloseTo(0, 6);
    expect(views.nearField![0].heightMm).toBe(2);
    const [first, second] = views.fields.volume!.weightsPerRun;
    expect(first[0]).toEqual([1, 0]);
    expect(second[0][0]).toBeCloseTo(0, 12);
    expect(second[0][1]).toBeCloseTo(2, 12);
    expect(views.fields.shownDrive).toBe('ports driven a 1 at 0°, b 1 at 90°');
    // The inputs stay as they were: a later steer sums the same runs again.
    expect(fields.planes[0].ez.re[0]).toBe(1);
  });

  it('shows one port alone when the others are off, and refuses drives it has no runs for', () => {
    const { fields, runs } = twoRuns();
    const alone = drivenFieldViews(fields, runs, [{ amplitude: 2, phaseDeg: 0 }, null], ['a', 'b']);
    expect(alone.fields.planes[0].ez.re[0]).toBeCloseTo(2, 6);
    expect(alone.fields.shownDrive).toBe('ports driven a 2 at 0°');
    expect(() => drivenFieldViews(fields, runs, [null, null], ['a', 'b'])).toThrow(/every port is off/);
    expect(() => drivenFieldViews(fields, runs.slice(0, 1), [null, { amplitude: 1, phaseDeg: 0 }], ['a', 'b'])).toThrow(/port b has a drive but no run/);
    expect(() => drivenFieldViews(fields, runs, [null], ['a', 'b'])).toThrow(/1 drives for 2 ports/);
  });

  it('writes negative phases with a true minus sign', () => {
    expect(portDrivesText([{ portId: 'left', amplitude: 1, phaseDeg: -90 }])).toBe('left 1 at −90°');
  });
});
