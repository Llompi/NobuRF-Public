import { describe, expect, it } from 'vitest';
import {
  addCoaxFeed, coaxCalibrationModel, coaxImpedanceOhm, coaxReflection, crossAxes, edgeLaunchSma, runCoaxFeed, SMA_LINE, temPlane, type Axis3, type CoaxFeedSpec,
} from '../src/engine/coax_feed';
import { buildCpml, DEFAULT_CPML_GRADING } from '../src/engine/cpml';
import { DEFAULT_GRID } from '../src/engine/config';
import { uniformLines } from '../src/engine/mesh';
import type { ExcitationConfig, GridConfig, RunControl } from '../src/engine/types';
import { idx3, materialSignature, type VoxelModel } from '../src/engine/voxelize';

const slow = process.env.SKIP_SLOW ? it.skip : it;

const CELL = 0.25;
const EXC: ExcitationConfig = { fMinGHz: 4, fMaxGHz: 8, nFreq: 41, z0: 50 };
const RUN: RunControl = { maxSteps: 30_000, stopAtEnergyDecayDb: 50, energyCheckEverySteps: 100 };

/** Which way the coax runs: along `runAxis`, lying on the `outward` side of its flange. */
interface Orientation { runAxis: Axis3; outward: -1 | 1 }
const ALONG_Y: Orientation = { runAxis: 1, outward: -1 };
const ORIENTATIONS: Array<[string, Orientation]> = [['y_min', ALONG_Y], ['x_max', { runAxis: 0, outward: 1 }], ['z_min', { runAxis: 2, outward: -1 }]];

/**
 * An empty uniform 0.25 mm box around a coax along the run axis: the cross
 * axes centred on the coax axis, the run axis from 0 to lengthMm, PML on the
 * two run faces only (the body's metal encloses the line, so the other walls
 * never see a field).
 */
function emptyBox(lengthMm: number, { runAxis }: Orientation = ALONG_Y): VoxelModel {
  const half = 14; // cells each side of the axis: 3.5 mm, past the 3.175 mm body
  const pml = 8;
  const along = Math.round(lengthMm / CELL) + 1;
  const dims = [2 * half + 1, 2 * half + 1, 2 * half + 1];
  dims[runAxis] = along;
  const grid: GridConfig = { ...DEFAULT_GRID, nx: dims[0], ny: dims[1], nz: dims[2], dxMm: CELL, pmlCells: pml, groundK: 0 };
  const lines = dims.map((n, a) => uniformLines(n, a === runAxis ? 0 : -half * CELL, CELL));
  const mesh = { x: lines[0], y: lines[1], z: lines[2] };
  const N = grid.nx * grid.ny * grid.nz;
  const eDecay = new Float32Array(3 * N).fill(1);
  const eCurl = new Float32Array(3 * N).fill(grid.courant);
  const low = [0, 0, 0];
  low[runAxis] = pml;
  const faces = { xLow: low[0], xHigh: low[0], yLow: low[1], yHigh: low[1], zLow: low[2], zHigh: low[2] };
  return {
    grid, eDecay, eCurl, mesh, cpml: buildCpml(grid, faces, DEFAULT_CPML_GRADING, mesh), ports: [], patchK: 0,
    topCopper: new Uint8Array(grid.nx * grid.ny), signature: materialSignature(eDecay, eCurl),
  };
}

function spec(flangeMm: number, overrides: Partial<CoaxFeedSpec> = {}, orientation: Orientation = ALONG_Y): CoaxFeedSpec {
  return {
    ...SMA_LINE, ...orientation, axisMm: [0, 0], flangeMm, bodyHalfWidthMm: 3.175, pinOverhangMm: 0,
    sourceDistanceMm: 12, probeDistancesMm: [8, 5], antiPad: false, ...overrides,
  };
}

/** Feed run plus calibration run, reflection at the flange. */
function reflect(board: VoxelModel, s: CoaxFeedSpec) {
  const { model, feed } = addCoaxFeed(board, s);
  const feedRun = runCoaxFeed(model, feed, EXC, RUN);
  const cal = coaxCalibrationModel(model, feed);
  const calRun = runCoaxFeed(cal.model, cal.feed, EXC, { ...RUN, maxSteps: feedRun.steps, stopAtEnergyDecayDb: null });
  return coaxReflection(feedRun, calRun, feed, EXC);
}

const magnitude = (r: { gammaRe: Float64Array; gammaIm: Float64Array }, m: number) => Math.hypot(r.gammaRe[m], r.gammaIm[m]);

describe('coax feed', () => {
  it.each(ORIENTATIONS)('finds the TEM mode of the staircased SMA line and its impedance near the round-coax formula (coax toward %s)', (_, o) => {
    const { model, feed } = addCoaxFeed(emptyBox(30, o), spec(o.outward < 0 ? 25 : 5, {}, o));
    const plane = feed.probes[1];
    const analytic = coaxImpedanceOhm(SMA_LINE.pinRadiusMm, SMA_LINE.boreRadiusMm, SMA_LINE.dielectricEpsR);
    expect(analytic).toBeCloseTo(48.8, 1);
    // A 2.5-cell pin radius staircase is coarse; within 6 % of the round line.
    expect(Math.abs(plane.impedanceOhm - analytic) / analytic).toBeLessThan(0.06);
    // Projection of the mode on itself is 1 V.
    let v = 0;
    for (let m = 0; m < plane.edges.length; m++) v += plane.weights[m] * plane.mode[m];
    expect(v).toBeCloseTo(1, 6);
    // The same plane solved again on the calibration model gives the same mode.
    const cal = coaxCalibrationModel(model, feed);
    expect(cal.feed.probes[1].impedanceOhm).toBeCloseTo(plane.impedanceOhm, 6);
    // Every orientation sees the same staircase: one impedance whichever way the coax runs.
    expect(plane.impedanceOhm).toBeCloseTo(addCoaxFeed(emptyBox(30), spec(25)).feed.probes[1].impedanceOhm, 9);
    expect(crossAxes(o.runAxis)).not.toContain(o.runAxis);
  });

  it('refuses a pin that touches the outer conductor', () => {
    expect(() => addCoaxFeed(emptyBox(30), spec(25, { pinRadiusMm: 2.0, boreRadiusMm: 2.1 }))).toThrow(/touches the outer conductor|not connected/);
  });

  it('refuses a board too thick for the body to reach ground, and a model with two ports', () => {
    expect(() => edgeLaunchSma({ edge: 'y_min', alongMm: 0, topCopperZMm: 3.2, groundZMm: 0, boardEdgeMm: -12 })).toThrow(/would not reach the ground plane/);
    expect(edgeLaunchSma({ edge: 'y_min', alongMm: 0, topCopperZMm: 1.5, groundZMm: 0, boardEdgeMm: -12 }).axisMm[1]).toBeCloseTo(2.135, 12);
    const board = emptyBox(30);
    const port = { i: 0, j: 0, k0: 0, k1: 0, ezIndex: new Uint32Array(0), ca: 1, cb: 0, cs: 0, columns: 0, seriesCells: 0, cells: 0 } as unknown as VoxelModel['ports'][number];
    expect(() => addCoaxFeed({ ...board, ports: [port, port] }, spec(25))).toThrow(/one lumped port/);
  });

  it('refuses a source plane inside the PML', () => {
    expect(() => addCoaxFeed(emptyBox(30), spec(25, { sourceDistanceMm: 24 }))).toThrow(/inside the y_min PML/);
  });

  slow.each([ORIENTATIONS[0], ORIENTATIONS[1]])('reads a matched line as no reflection (coax toward %s)', (_, o) => {
    // Flange at the far end of the box: the coax runs through the other PML too.
    const board = emptyBox(30, o);
    const r = reflect(board, spec(o.outward < 0 ? 30 : 0, {}, o));
    for (let m = 0; m < r.fGHz.length; m++) expect(20 * Math.log10(magnitude(r, m))).toBeLessThan(-35);
  }, 120_000);

  slow.each(ORIENTATIONS)('reads a short at the flange as Gamma = -1 after de-embedding (coax toward %s)', (_, o) => {
    const board = emptyBox(30, o);
    const { grid } = board;
    const N = grid.nx * grid.ny * grid.nz;
    // Metal everywhere from the flange plane on, into the board.
    const flangeMm = o.outward < 0 ? 20 : 10;
    const flange = Math.round(flangeMm / CELL);
    for (let k = 0; k < grid.nz; k++) for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      if (-o.outward * ([i, j, k][o.runAxis] - flange) < 0) continue;
      for (let comp = 0; comp < 3; comp++) board.eCurl[comp * N + idx3(grid, i, j, k)] = 0;
    }
    const r = reflect(board, spec(flangeMm, {}, o));
    for (let m = 0; m < r.fGHz.length; m++) {
      expect(magnitude(r, m)).toBeGreaterThan(0.98);
      expect(magnitude(r, m)).toBeLessThan(1.02);
      // Phase of -1 within 3 degrees.
      expect(Math.abs(Math.atan2(r.gammaIm[m], -r.gammaRe[m]))).toBeLessThan((3 * Math.PI) / 180);
    }
  }, 120_000);

  slow('reads a step to a thinner pin as the impedance ratio of the two lines', () => {
    // A 0.4 mm pin line through the whole box, then the SMA line up to the flange.
    const board = emptyBox(30);
    const thin = spec(30, { pinRadiusMm: 0.4 });
    const thinModel = addCoaxFeed(board, thin).model;
    const z2 = temPlane(thinModel, thin, Math.round(25 / CELL)).impedanceOhm;
    const r = reflect(thinModel, spec(20));
    const z1 = r.lineImpedanceOhm;
    const expected = (z2 - z1) / (z2 + z1);
    expect(expected).toBeGreaterThan(0.04); // 49 ohm into 53 ohm on this staircase
    // Lowest frequency: the step's fringing capacitance is smallest there.
    expect(r.gammaRe[0]).toBeCloseTo(expected, 3);
    expect(Math.abs(r.gammaIm[0])).toBeLessThan(0.005);
  }, 120_000);
});
