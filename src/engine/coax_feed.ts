import { C0, EPS0, timestepSec } from './config';
import { withoutEdges } from './dispersion';
import { buildCpml, DEFAULT_CPML_GRADING, type PmlFaces } from './cpml';
import { EnergyStop } from './energy_stop';
import { sourceEndStep, sourceParams } from './source';
import { CpuFdtd, type StepRecorder } from './fdtd_cpu';
import { cellWidth, dualWidth, smallestCell, type MeshLines, type Refinement } from './mesh';
import {
  bandFrequencyHz, bandPoints, divide, lumpedPortWaves, multiply, renormaliseScattering, s11FromZ, scatteringFromWaves, tukeyTaper,
  type Complex, type ScatteringResult,
} from './port_dft';
import type { CoaxRunPlanes, CoaxRunSamples, ExcitationConfig, GridConfig, RunControl } from './types';
import { dielectricEdge, idx3, materialSignature, type VoxelModel } from './voxelize';

/**
 * A coaxial feed modelled as metal and PTFE in the grid, in place of a lumped
 * port. The coax runs along one axis from its flange, away from the board,
 * into the PML of that face, which is its matched far end; the centre pin
 * reaches past the flange into the board. Two kinds use it:
 *   - an edge-launch SMA (edgeLaunchSma): the coax runs out of a board edge
 *     along x or y, and the pin lies on the feed trace;
 *   - a probe through the ground plane (coaxProbe): the coax runs down along
 *     -z below the ground plane, and the pin rises through the substrate to
 *     the copper above (a probe-fed patch). The ground copper inside the bore
 *     is cut away (antiPad).
 *
 * Excitation and measurement work like a coax wave port (openEMS
 * CoaxialPort, a commercial solver's wave port): the transverse E field of the line's TEM mode
 * is added on one cross-section (a soft source, transparent to the reflected
 * wave), and the mode voltage is read on two cross-sections between it and
 * the flange. The TEM mode is the discrete one of the staircased cross-section,
 * from a 2D Laplace solve on the same Yee edges, so the source launches no
 * higher-order modes and the probe reads exactly the line voltage.
 *
 * S11 comes from incident-wave subtraction: a second run on a short piece of
 * the same coax that never ends (coaxCalibrationModel) gives the incident wave
 * at each probe; the reflected wave is the difference. The phase constant
 * measured between the two probes moves the reference plane from the near
 * probe to the flange (de-embedding), so the result is what a VNA calibrated
 * at the connector reads, with the connector-to-board transition included.
 *
 * Coordinates are board coordinates in mm (z = 0 at the bottom of the stackup).
 */
export type Axis3 = 0 | 1 | 2;
const AXIS_NAMES = ['x', 'y', 'z'] as const;

export interface CoaxFeedSpec {
  /** The axis the coax runs along. */
  runAxis: Axis3;
  /** The side of the flange the coax lies on: -1 toward lower coordinates. */
  outward: -1 | 1;
  /** Coax axis position on the two other axes, lower axis first (x then z for a coax along y). */
  axisMm: [number, number];
  /** Flange plane, on the run axis. The coax occupies outward * (u - flangeMm) > 0. */
  flangeMm: number;
  /** Centre pin radius. */
  pinRadiusMm: number;
  /** Inner radius of the outer conductor (the PTFE bore). */
  boreRadiusMm: number;
  /** The connector body is a metal block of side 2 * bodyHalfWidthMm around the axis, bored for the line. */
  bodyHalfWidthMm: number;
  dielectricEpsR: number;
  /** How far the pin reaches past the flange into the board. */
  pinOverhangMm: number;
  /** Distance from the flange, along the coax, of the source plane. */
  sourceDistanceMm: number;
  /** Distances from the flange of the two probe planes, far one first. */
  probeDistancesMm: [far: number, near: number];
  /** Cut the copper on the flange plane inside the bore: the anti-pad of a probe through a ground plane. */
  antiPad: boolean;
}

/** The two axes across the coax, in increasing order. */
export function crossAxes(runAxis: Axis3): [Axis3, Axis3] {
  return runAxis === 0 ? [1, 2] : runAxis === 1 ? [0, 2] : [0, 1];
}

/** Where the coax runs out of the box, e.g. "y_min". */
export function coaxFace(spec: Pick<CoaxFeedSpec, 'runAxis' | 'outward'>): string {
  return `${AXIS_NAMES[spec.runAxis]}_${spec.outward < 0 ? 'min' : 'max'}`;
}

const meshAxis = (mesh: MeshLines, axis: Axis3) => [mesh.x, mesh.y, mesh.z][axis];

/**
 * Standard SMA line: 1.27 mm (0.050 in) pin in a 4.10 mm (0.161 in) PTFE bore,
 * 49 ohm for eps_r 2.08. Body and pin overhang are typical of edge-launch
 * jacks, not one manufacturer's part.
 */
export const SMA_LINE = { pinRadiusMm: 0.635, boreRadiusMm: 2.05, dielectricEpsR: 2.08 } as const;

const SMA_BODY_HALF_WIDTH_MM = 3.175;
const SMA_RUN = { sourceDistanceMm: 14, probeDistancesMm: [10, 6] as [number, number] };

export type BoardEdge = 'x_min' | 'x_max' | 'y_min' | 'y_max';

/**
 * An edge-launch SMA on a microstrip: the pin rests on the trace (axis one pin
 * radius above the top copper), centred on the trace at `alongMm` on the
 * edge (x on a y edge, y on an x edge), flange at the board edge and bonded
 * to the ground plane below.
 */
export function edgeLaunchSma(trace: { edge: BoardEdge; alongMm: number; topCopperZMm: number; groundZMm: number; boardEdgeMm: number }): CoaxFeedSpec {
  const axisZMm = trace.topCopperZMm + SMA_LINE.pinRadiusMm;
  // The flange must reach below the ground plane to bond to it, or the shield floats.
  if (axisZMm - SMA_BODY_HALF_WIDTH_MM >= trace.groundZMm) {
    throw new Error(`board ${trace.topCopperZMm - trace.groundZMm} mm thick: the connector body would not reach the ground plane (boards up to ${(SMA_BODY_HALF_WIDTH_MM - SMA_LINE.pinRadiusMm).toFixed(2)} mm)`);
  }
  return {
    ...SMA_LINE,
    ...SMA_RUN,
    runAxis: trace.edge[0] === 'x' ? 0 : 1,
    outward: trace.edge.endsWith('min') ? -1 : 1,
    axisMm: [trace.alongMm, axisZMm],
    flangeMm: trace.boardEdgeMm,
    bodyHalfWidthMm: SMA_BODY_HALF_WIDTH_MM,
    pinOverhangMm: 1.5,
    antiPad: false,
  };
}

/**
 * A coax probe through the ground plane at (x, y): the SMA line runs down
 * along -z below the ground plane, its pin rises through the substrate to the
 * signal copper above, and the ground inside the bore is cut away. The
 * connector body is the same square block as the edge-launch one, bonded to
 * the underside of the ground plane.
 */
export function coaxProbe(probe: { xMm: number; yMm: number; groundZMm: number; signalZMm: number }): CoaxFeedSpec {
  if (!(probe.signalZMm > probe.groundZMm)) throw new Error('the probe pin must rise from the ground plane to a copper layer above it');
  return {
    ...SMA_LINE,
    ...SMA_RUN,
    runAxis: 2,
    outward: -1,
    axisMm: [probe.xMm, probe.yMm],
    flangeMm: probe.groundZMm,
    bodyHalfWidthMm: SMA_BODY_HALF_WIDTH_MM,
    pinOverhangMm: probe.signalZMm - probe.groundZMm,
    antiPad: true,
  };
}

/** Analytic impedance of a round coax: 60 / sqrt(eps_r) * ln(b / a). */
export function coaxImpedanceOhm(pinRadiusMm: number, boreRadiusMm: number, epsR: number): number {
  return (60 / Math.sqrt(epsR)) * Math.log(boreRadiusMm / pinRadiusMm);
}

export interface CoaxMeshOptions {
  /** Cell size across the coax on each cross axis (crossAxes order), and around the flange. */
  crossCellMm: [number, number];
  /** Cell size along the coax run, where the source and probes sit. */
  runCellMm: number;
  /** z of the copper planes a z lattice across the coax must land on (ground and top copper). */
  copperZMm: number[];
}

/**
 * Mesh refinements for rasterise(), per axis (x, y, z): a uniform lattice
 * over the body's cross-section on both cross axes (centred on the coax axis,
 * except in z, where it lands on the copper planes so the trace and ground
 * stay exact), a uniform lattice along the run from 3 mm outside the flange
 * to past the source, and fine lines at the flange and the pin's end. The
 * source and probe planes are lattice lines.
 */
export function coaxRefinements(spec: CoaxFeedSpec, options: CoaxMeshOptions): [Refinement[], Refinement[], Refinement[]] {
  const out: [Refinement[], Refinement[], Refinement[]] = [[], [], []];
  crossAxes(spec.runAxis).forEach((axis, n) => {
    const c = options.crossCellMm[n];
    const centre = spec.axisMm[n];
    const span = spec.bodyHalfWidthMm + c;
    if (axis !== 2) {
      for (let k = -Math.ceil(span / c); k <= Math.ceil(span / c); k++) out[axis].push({ at: centre + k * c, cellMm: c });
      return;
    }
    // z: a lattice anchored on the lowest copper plane, with the cell adjusted so it also lands on the others.
    const [zLow, ...zOthers] = [...options.copperZMm].sort((a, b) => a - b);
    const zSpan = Math.max(...zOthers, zLow) - zLow;
    const cz = zSpan > 0 ? zSpan / Math.max(1, Math.round(zSpan / c)) : c;
    for (const z of zOthers) {
      const k = (z - zLow) / cz;
      if (Math.abs(k - Math.round(k)) > 1e-6) throw new Error(`copper plane z = ${z} mm is not on a common lattice with z = ${zLow} mm; pass one spacing`);
    }
    for (let k = Math.floor((centre - span - zLow) / cz); zLow + k * cz <= centre + span; k++) out[2].push({ at: zLow + k * cz, cellMm: cz });
  });

  const run = options.runCellMm;
  for (const d of [spec.sourceDistanceMm, ...spec.probeDistancesMm]) {
    if (Math.abs(d / run - Math.round(d / run)) > 1e-9) throw new Error(`source and probe distances must be multiples of runCellMm (${run} mm), got ${d} mm`);
  }
  const fine = Math.min(...options.crossCellMm);
  const along = out[spec.runAxis];
  along.push({ at: spec.flangeMm, cellMm: fine }, { at: spec.flangeMm - spec.outward * spec.pinOverhangMm, cellMm: fine });
  const runEnd = Math.round((spec.sourceDistanceMm + 2) / run);
  for (let k = Math.round(3 / run); k <= runEnd; k++) along.push({ at: spec.flangeMm + spec.outward * k * run, cellMm: run });
  return out;
}

type Box = Array<[number, number]>;

/**
 * The space a connector fills, as two boxes in x, y, z (mm): the body, from
 * the flange out to infinity along the run axis, and the pin from the flange
 * to its tip inside the board.
 */
function connectorBoxes(spec: CoaxFeedSpec): [Box, Box] {
  const box = (halfWidth: number, run: [number, number]): Box => {
    const out: Box = [[0, 0], [0, 0], [0, 0]];
    crossAxes(spec.runAxis).forEach((axis, n) => { out[axis] = [spec.axisMm[n] - halfWidth, spec.axisMm[n] + halfWidth]; });
    out[spec.runAxis] = run;
    return out;
  };
  const flange = spec.flangeMm;
  const tip = flange - spec.outward * spec.pinOverhangMm;
  const body: [number, number] = spec.outward > 0 ? [flange, Infinity] : [-Infinity, flange];
  return [box(spec.bodyHalfWidthMm, body), box(spec.pinRadiusMm, [Math.min(flange, tip), Math.max(flange, tip)])];
}

/** True when two connectors share space: a body or pin of one inside a body or pin of the other. */
export function connectorsOverlap(a: CoaxFeedSpec, b: CoaxFeedSpec): boolean {
  const inside = (p: Box, q: Box) => p.every(([lo, hi], axis) => lo < q[axis][1] && q[axis][0] < hi);
  return connectorBoxes(a).some((p) => connectorBoxes(b).some((q) => inside(p, q)));
}

/* ------------------------------------------------------------------------ */
/* Geometry: the connector painted onto the E edges.                          */
/* ------------------------------------------------------------------------ */

function nodeIndex(lines: Float64Array, value: number, what: string): number {
  let best = 0;
  for (let i = 1; i < lines.length; i++) if (Math.abs(lines[i] - value) < Math.abs(lines[best] - value)) best = i;
  if (Math.abs(lines[best] - value) > 1e-6) throw new Error(`${what} (${value} mm) is not on a mesh line (nearest ${lines[best]} mm, neighbours ${lines[best - 1]} and ${lines[best + 1]}); mesh with coaxRefinements()`);
  return best;
}

/** eps_r and sigma*dt/eps0 of a dielectric edge, inverted from dielectricEdge's coefficients. */
function edgeDielectric(courant: number, decay: number, curl: number): { epsR: number; sigma: number } {
  const half = (1 - decay) / (1 + decay);
  const epsR = courant / (curl * (1 + half));
  return { epsR, sigma: 2 * epsR * half };
}

/**
 * The model without the lumped ports in `replaced` (the stand-ins rasterise
 * puts where a coax feed goes); the other ports keep their order. A port
 * column's Ez edges belong to the port kernel (curl 0); without the port they
 * would be a wire shorting the board, so each gets back the material of the
 * Ez edge `neighbourOffset` away in the E buffer, a node inside the board.
 */
export function withoutPorts(model: VoxelModel, replaced: ReadonlyArray<{ port: number; neighbourOffset: number }>): VoxelModel {
  for (const { port: n } of replaced) if (!(n >= 0 && n < model.ports.length)) throw new Error(`port ${n} does not exist; the model has ${model.ports.length}`);
  const eDecay = model.eDecay.slice();
  const eCurl = model.eCurl.slice();
  const portCells = new Set(replaced.flatMap(({ port }) => Array.from(model.ports[port].ezIndex)));
  const componentEdges = new Set(model.lumped?.eIndex ?? []);
  for (const { port, neighbourOffset } of replaced) {
    for (const index of model.ports[port].ezIndex) {
      const neighbour = index + neighbourOffset;
      if (portCells.has(neighbour) || eCurl[neighbour] === 0 || componentEdges.has(neighbour)) {
        throw new Error(`cannot restore port cell ${index}: the board node next to it is a port cell, metal or a lumped component`);
      }
      eDecay[index] = eDecay[neighbour];
      eCurl[index] = eCurl[neighbour];
    }
  }
  const ports = model.ports.filter((_, n) => !replaced.some((r) => r.port === n));
  return { ...model, eDecay, eCurl, ports, signature: materialSignature(eDecay, eCurl, model) };
}

/**
 * E-buffer offset from a feed's stand-in port to the board node it takes its
 * material from: the next node along the board edge for an edge launch (+y on
 * an x edge, +x on a y edge; the node outward is the air past the edge), and
 * +x for a probe, whose run axis is the port column itself.
 */
function standInNeighbourOffset(grid: GridConfig, spec: CoaxFeedSpec): number {
  return spec.runAxis === 0 ? grid.nx : 1;
}

const OTHER = 0;
const METAL = 1;
const PTFE = 2;

const centre = (lines: Float64Array, i: number) => lines[i] + cellWidth(lines, i) / 2;

/**
 * What fills cell (i, j, k): the connector body and pin are metal, the bore is
 * PTFE, everything else keeps what the board model gave it (OTHER). The body
 * and bore run from the flange to the end of the box, through the PML; inside
 * the board only the pin's overhang is the connector's.
 */
function connectorCell(mesh: MeshLines, spec: CoaxFeedSpec, cell: [number, number, number]): number {
  const [a0, a1] = crossAxes(spec.runAxis);
  const d0 = centre(meshAxis(mesh, a0), cell[a0]) - spec.axisMm[0];
  const d1 = centre(meshAxis(mesh, a1), cell[a1]) - spec.axisMm[1];
  const outside = spec.outward * (centre(meshAxis(mesh, spec.runAxis), cell[spec.runAxis]) - spec.flangeMm);
  const r = Math.hypot(d0, d1);
  if (outside > 0) {
    if (Math.abs(d0) > spec.bodyHalfWidthMm || Math.abs(d1) > spec.bodyHalfWidthMm) return OTHER;
    if (r < spec.pinRadiusMm) return METAL;
    return r < spec.boreRadiusMm ? PTFE : METAL;
  }
  if (outside > -spec.pinOverhangMm && r < spec.pinRadiusMm) return METAL;
  return OTHER;
}

/** Cells a..b along one axis that overlap [lo, hi]. */
function cellRange(lines: Float64Array, lo: number, hi: number): [number, number] {
  let a = 0;
  while (a < lines.length - 2 && lines[a + 1] <= lo) a++;
  let b = lines.length - 2;
  while (b > 0 && lines[b] >= hi) b--;
  return [a, b];
}

/**
 * Writes the connector into the material arrays (in place). Cells are filled
 * by their centres: metal (body and pin), PTFE (bore) or the board model. An E
 * edge touching a metal cell is metal (zero curl), so every conductor is one
 * connected piece in all three directions and the line carries a single TEM
 * mode; edge-midpoint filling left floating wires along the line and missed the
 * impedance-step check in tests/coax_feed.test.ts by 3 %. The price is that
 * each conductor grows by up to half a cell: at 0.125 mm cells the SMA line
 * reads 46 ohm against 48.8 ohm for the round line. That line impedance is
 * de-embedded; what remains is a pin about 0.06 mm fatter at the transition.
 * An edge between PTFE cells is PTFE. An edge with PTFE on one side and the
 * board model on the other (only on the flange plane, in the bore's mouth)
 * gets the area-weighted mean of PTFE and the dielectric the board model had
 * put there. Board copper there stays copper, except with spec.antiPad: then
 * it is cut, and filled with the dielectric of the same edge one node further
 * into the board.
 */
function paintConnector(model: VoxelModel, spec: CoaxFeedSpec): Set<number> {
  const painted = new Set<number>();
  const { grid, mesh, eDecay, eCurl } = model;
  const { nx, ny, nz, courant: Sc } = grid;
  const N = nx * ny * nz;
  const dims = [nx, ny, nz];
  const strides = [1, nx, nx * ny];
  const lines = [mesh.x, mesh.y, mesh.z];
  const run = spec.runAxis;
  const [a0, a1] = crossAxes(run);
  // Cell box that can hold connector cells.
  const box: Array<[number, number]> = [];
  box[a0] = cellRange(lines[a0], spec.axisMm[0] - spec.bodyHalfWidthMm, spec.axisMm[0] + spec.bodyHalfWidthMm);
  box[a1] = cellRange(lines[a1], spec.axisMm[1] - spec.bodyHalfWidthMm, spec.axisMm[1] + spec.bodyHalfWidthMm);
  const pinEnd = spec.flangeMm - spec.outward * spec.pinOverhangMm;
  const runLines = lines[run];
  box[run] = spec.outward < 0
    ? [0, cellRange(runLines, runLines[0], pinEnd)[1]]
    : [cellRange(runLines, pinEnd, runLines[runLines.length - 1])[0], dims[run] - 2];
  const size = box.map(([lo, hi]) => hi - lo + 1);
  const kind = new Uint8Array(size[0] * size[1] * size[2]);
  const at = (c: number[]) => c[0] - box[0][0] + size[0] * (c[1] - box[1][0] + size[1] * (c[2] - box[2][0]));
  for (let k = box[2][0]; k <= box[2][1]; k++) for (let j = box[1][0]; j <= box[1][1]; j++) for (let i = box[0][0]; i <= box[0][1]; i++) {
    kind[at([i, j, k])] = connectorCell(mesh, spec, [i, j, k]);
  }
  const cellKind = (c: number[]) => (c.some((v, a) => v < box[a][0] || v > box[a][1]) ? OTHER : kind[at(c)]);
  const isCopper = (index: number) => eCurl[index] === 0;
  // A partly covered conformal edge has a scaled eCurl that does not read as a dielectric; the connector must not mix it.
  const partial = new Set(model.conformal?.partialEdges ?? []);
  const assertWhole = (index: number, node: number[]) => {
    if (partial.has(index)) {
      throw new Error(`the connector at node (${node.join(',')}) reaches copper that only partly covers a cell (mesh.conformal); ` +
        'keep the copper under the connector on mesh lines, or turn mesh.conformal off');
    }
  };

  const ptfe = dielectricEdge(Sc, spec.dielectricEpsR, 0);
  // [component, the two axes the four neighbouring cells step along]
  const components = [[0, 1, 2], [1, 0, 2], [2, 0, 1]] as const;
  const nodes = box.map(([lo, hi], a) => [lo, Math.min(dims[a] - 1, hi + 1)]);
  for (const [comp, a, b] of components) {
    for (let k = nodes[2][0]; k <= nodes[2][1]; k++) for (let j = nodes[1][0]; j <= nodes[1][1]; j++) for (let i = nodes[0][0]; i <= nodes[0][1]; i++) {
      let metal = false;
      let ptfeWeight = 0;
      let otherWeight = 0;
      for (const da of [-1, 0]) for (const db of [-1, 0]) {
        const cell = [i, j, k];
        cell[a] += da;
        cell[b] += db;
        if (cell[a] < 0 || cell[b] < 0 || cell[a] > dims[a] - 2 || cell[b] > dims[b] - 2) continue;
        const w = cellWidth(lines[a], cell[a]) * cellWidth(lines[b], cell[b]);
        const c = cellKind(cell);
        if (c === METAL) metal = true;
        else if (c === PTFE) ptfeWeight += w;
        else otherWeight += w;
      }
      if (!metal && ptfeWeight === 0) continue;
      const index = comp * N + idx3(grid, i, j, k);
      assertWhole(index, [i, j, k]);
      let board = index;
      if (spec.antiPad && !metal && otherWeight > 0 && isCopper(index)) {
        board = index - spec.outward * strides[run];
        assertWhole(board, [i, j, k]);
        if (isCopper(board)) throw new Error(`coax anti-pad at node (${i},${j},${k}): the board next to the flange is copper too; the dielectric there must be at least two cells thick`);
      }
      painted.add(index);
      if (metal) {
        eDecay[index] = 1;
        eCurl[index] = 0;
      } else if (otherWeight === 0) {
        eDecay[index] = ptfe.decay;
        eCurl[index] = ptfe.curl;
      } else if (!isCopper(board)) {
        const other = edgeDielectric(Sc, eDecay[board], eCurl[board]);
        const total = ptfeWeight + otherWeight;
        const mixed = dielectricEdge(Sc, (spec.dielectricEpsR * ptfeWeight + other.epsR * otherWeight) / total, (other.sigma * otherWeight) / total);
        eDecay[index] = mixed.decay;
        eCurl[index] = mixed.curl;
      }
    }
  }
  return painted;
}

/* ------------------------------------------------------------------------ */
/* The discrete TEM mode on one cross-section.                                */
/* ------------------------------------------------------------------------ */

/** A cross-section of the coax, normal to its run axis, with its TEM mode. */
export interface TemPlane {
  /** Node index of the plane on the run axis, and its coordinate. */
  index: number;
  positionMm: number;
  /** E-buffer indices of the transverse edges in the bore. */
  edges: Uint32Array;
  /** Normalised field e = E * dRef of the mode at 1 V, per edge: the soft source adds s(t) * mode. */
  mode: Float32Array;
  /** V = sum of weights * e over the edges: the projection on the mode, in volts. */
  weights: Float64Array;
  /** Line impedance from the mode's capacitance per length: sqrt(eps_r) / (c0 C'). */
  impedanceOhm: number;
}

/**
 * Node range of the cross-section domain on one cross axis: from the middle
 * of the body wall on one side to the other, so it is enclosed by metal
 * whatever the box around it.
 */
function crossSectionNodes(lines: Float64Array, axisMm: number, spec: CoaxFeedSpec): [number, number] {
  const wallMiddle = (spec.boreRadiusMm + spec.bodyHalfWidthMm) / 2;
  const nearest = (v: number) => {
    let best = 0;
    for (let i = 1; i < lines.length; i++) if (Math.abs(lines[i] - v) < Math.abs(lines[best] - v)) best = i;
    return best;
  };
  return [nearest(axisMm - wallMiddle), nearest(axisMm + wallMiddle)];
}

/**
 * Laplace solve for the potential on the nodes of the plane at node `w` of
 * the run axis, inner conductor at 1 V and outer at 0, on the edges the model
 * has there: a metal (zero-curl) edge ties its two nodes to one conductor, a
 * dielectric edge is a conductance eps * dual width / length. E on each edge
 * is minus the potential difference over its length, which is the discrete
 * TEM mode of the staircased line.
 */
export function temPlane(model: VoxelModel, spec: CoaxFeedSpec, w: number): TemPlane {
  const { grid, mesh, eDecay, eCurl } = model;
  const N = grid.nx * grid.ny * grid.nz;
  const Sc = grid.courant;
  const [a0, a1] = crossAxes(spec.runAxis);
  const [lines0, lines1] = [meshAxis(mesh, a0), meshAxis(mesh, a1)];
  const [ua, ub] = crossSectionNodes(lines0, spec.axisMm[0], spec);
  const [va, vb] = crossSectionNodes(lines1, spec.axisMm[1], spec);
  const [nu, nv] = [ub - ua + 1, vb - va + 1];
  const node = (u: number, v: number) => u - ua + nu * (v - va);
  const cellIndex = (u: number, v: number) => {
    const c = [0, 0, 0];
    c[a0] = u;
    c[a1] = v;
    c[spec.runAxis] = w;
    return idx3(grid, c[0], c[1], c[2]);
  };
  const where = `coax plane ${AXIS_NAMES[spec.runAxis]} = ${meshAxis(mesh, spec.runAxis)[w]} mm`;

  // Each edge: its two nodes, E-buffer index, length and dual width (mm).
  interface Edge { a: number; b: number; index: number; length: number; dual: number }
  const edges: Edge[] = [];
  for (let v = va; v <= vb; v++) for (let u = ua; u <= ub; u++) {
    if (u < ub) edges.push({ a: node(u, v), b: node(u + 1, v), index: a0 * N + cellIndex(u, v), length: cellWidth(lines0, u), dual: dualWidth(lines1, v) });
    if (v < vb) edges.push({ a: node(u, v), b: node(u, v + 1), index: a1 * N + cellIndex(u, v), length: cellWidth(lines1, v), dual: dualWidth(lines0, u) });
  }

  // Conductors: nodes joined by metal edges (union-find).
  const parent = Int32Array.from({ length: nu * nv }, (_, n) => n);
  const find = (n: number): number => (parent[n] === n ? n : (parent[n] = find(parent[n])));
  for (const e of edges) if (eCurl[e.index] === 0) parent[find(e.a)] = find(e.b);
  let axisNode = 0;
  let axisDistance = Infinity;
  for (let v = va; v <= vb; v++) for (let u = ua; u <= ub; u++) {
    const d = Math.hypot(lines0[u] - spec.axisMm[0], lines1[v] - spec.axisMm[1]);
    if (d < axisDistance) [axisNode, axisDistance] = [node(u, v), d];
  }
  const inner = find(axisNode);
  const outer = find(node(ua, va));
  if (inner === outer) throw new Error(`${where}: the pin touches the outer conductor`);

  const dielectric = edges.filter((e) => eCurl[e.index] !== 0);
  for (const e of dielectric) {
    if (eDecay[e.index] !== 1) throw new Error(`${where}: lossy edge in the bore; the coax dielectric must be lossless`);
  }
  const conductance = dielectric.map((e) => (Sc / eCurl[e.index]) * (e.dual / e.length));
  const fixed = new Int8Array(nu * nv).fill(-1);
  const phi = new Float64Array(nu * nv);
  for (let n = 0; n < nu * nv; n++) {
    const root = find(n);
    if (root === inner) { fixed[n] = 1; phi[n] = 1; }
    else if (root === outer) fixed[n] = 0;
    else if (root !== n) throw new Error(`${where}: metal not connected to the pin or the outer conductor`);
  }
  // Neighbour lists of the free nodes.
  const neighbours: Array<Array<[number, number]>> = Array.from({ length: nu * nv }, () => []);
  dielectric.forEach((e, n) => {
    neighbours[e.a].push([e.b, conductance[n]]);
    neighbours[e.b].push([e.a, conductance[n]]);
  });
  const free = Array.from({ length: nu * nv }, (_, n) => n).filter((n) => fixed[n] < 0 && neighbours[n].length > 0);
  const OMEGA = 1.9;
  let converged = false;
  for (let sweep = 0; sweep < 50_000 && !converged; sweep++) {
    let change = 0;
    for (const n of free) {
      let sum = 0;
      let weight = 0;
      for (const [m, g] of neighbours[n]) { sum += g * phi[m]; weight += g; }
      const next = phi[n] + OMEGA * (sum / weight - phi[n]);
      change = Math.max(change, Math.abs(next - phi[n]));
      phi[n] = next;
    }
    converged = change < 1e-12;
  }
  if (!converged) throw new Error(`${where}: Laplace solve did not converge`);

  const dRef = grid.dxMm;
  const modeValues: number[] = [];
  const areas: number[] = [];
  // C' = eps0 * sum of eps_r E^2 dA at 1 V. E in V/mm times dA in mm^2 is the same number as in V/m and m^2.
  let capacitanceSum = 0;
  for (const e of dielectric) {
    const eField = -(phi[e.b] - phi[e.a]) / e.length;
    modeValues.push(eField * dRef);
    areas.push(e.length * e.dual);
    capacitanceSum += (Sc / eCurl[e.index]) * eField * eField * e.length * e.dual;
  }
  const capacitancePerM = EPS0 * capacitanceSum;
  const norm = modeValues.reduce((sum, m, n) => sum + m * m * areas[n], 0);
  return {
    index: w,
    positionMm: meshAxis(mesh, spec.runAxis)[w],
    edges: Uint32Array.from(dielectric.map((e) => e.index)),
    mode: Float32Array.from(modeValues),
    weights: Float64Array.from(modeValues.map((m, n) => (m * areas[n]) / norm)),
    impedanceOhm: Math.sqrt(spec.dielectricEpsR) / (C0 * capacitancePerM),
  };
}

/* ------------------------------------------------------------------------ */
/* Models and runs.                                                           */
/* ------------------------------------------------------------------------ */

export interface CoaxFeed {
  spec: CoaxFeedSpec;
  source: TemPlane;
  /** Far probe, then near probe. */
  probes: [TemPlane, TemPlane];
}

function feedPlanes(model: VoxelModel, spec: CoaxFeedSpec): CoaxFeed {
  const lines = meshAxis(model.mesh, spec.runAxis);
  const plane = (distance: number, what: string) => temPlane(model, spec, nodeIndex(lines, spec.flangeMm + spec.outward * distance, what));
  const [far, near] = spec.probeDistancesMm;
  if (!(spec.sourceDistanceMm > far && far > near && near > 0)) throw new Error('coax feed needs source distance > far probe > near probe > 0');
  const source = plane(spec.sourceDistanceMm, 'coax source plane');
  const pml = [model.cpml.x, model.cpml.y, model.cpml.z][spec.runAxis];
  const inPml = spec.outward < 0 ? source.index <= pml.low : source.index >= lines.length - 1 - pml.high;
  if (inPml) throw new Error(`coax source plane (${AXIS_NAMES[spec.runAxis]} = ${source.positionMm} mm) is inside the ${coaxFace(spec)} PML; lengthen the air margin or move it`);
  return {
    spec,
    source,
    probes: [plane(far, 'coax far probe'), plane(near, 'coax near probe')],
  };
}

/** The board model with the lumped stand-ins at `replacedPorts` removed and the coax feeds painted in. */
export function addCoaxFeeds(boardModel: VoxelModel, specs: readonly CoaxFeedSpec[], replacedPorts: readonly number[]): { model: VoxelModel; feeds: CoaxFeed[] } {
  if (replacedPorts.length > 0 && replacedPorts.length !== specs.length) throw new Error(`${specs.length} coax feeds replace ${replacedPorts.length} ports; give one stand-in per feed, or none`);
  const model = withoutPorts(boardModel, replacedPorts.map((port, n) => ({ port, neighbourOffset: standInNeighbourOffset(boardModel.grid, specs[n]) })));
  const painted = new Set<number>();
  for (const spec of specs) for (const index of paintConnector(model, spec)) painted.add(index);
  // A component's edges hold its own coefficients; a connector painted over them would leave its state update behind.
  if (model.lumped?.eIndex.some((index) => painted.has(index))) throw new Error('a coax connector overlaps a lumped component; move the component away from the connector');
  // A painted edge is PTFE, metal or a PTFE mix now, at the single-frequency stand-in of what was there: no longer a dispersive edge.
  if (model.dispersion?.e) model.dispersion = { ...model.dispersion, e: withoutEdges(model.dispersion.e, painted) };
  model.signature = materialSignature(model.eDecay, model.eCurl, model);
  return { model, feeds: specs.map((spec) => feedPlanes(model, spec)) };
}

/** One coax feed in place of the board's one lumped port (or on a model without ports). */
export function addCoaxFeed(boardModel: VoxelModel, spec: CoaxFeedSpec): { model: VoxelModel; feed: CoaxFeed } {
  if (boardModel.ports.length > 1) throw new Error(`the coax feed replaces the board's one lumped port; this model has ${boardModel.ports.length}`);
  const { model, feeds } = addCoaxFeeds(boardModel, [spec], boardModel.ports.map((_, n) => n));
  return { model, feed: feeds[0] };
}

/**
 * A short, endless piece of the same coax for the incident wave: the
 * cross-section domain of the feed model's coax, the same run-axis lines from
 * the coax's PML up to just past the near probe, then the same cell continued
 * uniformly into a PML. Up to there it is the feed model cell for cell, so the
 * wave the source launches toward the probes is identical; past it nothing
 * reflects. One extra node inside the metal body, one smallest cell below the
 * first on the first cross axis, keeps the time step equal to the feed
 * model's.
 */
export function coaxCalibrationModel(feedModel: VoxelModel, feed: CoaxFeed): { model: VoxelModel; feed: CoaxFeed } {
  const { grid, mesh, eDecay, eCurl, cpml } = feedModel;
  const spec = feed.spec;
  const run = spec.runAxis;
  const [a0, a1] = crossAxes(run);
  const lines = [mesh.x, mesh.y, mesh.z];
  const runLines = lines[run];
  const [ua, ub] = crossSectionNodes(lines[a0], spec.axisMm[0], spec);
  const [va, vb] = crossSectionNodes(lines[a1], spec.axisMm[1], spec);
  // Two nodes past the near probe, toward the flange.
  const cut = feed.probes[1].index - 2 * spec.outward;
  if (!(spec.outward * (runLines[cut] - spec.flangeMm) > 0)) throw new Error('coax near probe is too close to the flange for the calibration model');
  const CONTINUE_CELLS = 16;
  const PML_CELLS = 8;
  const EXTRA = CONTINUE_CELLS + PML_CELLS;
  const runCell = Math.abs(runLines[cut] - runLines[cut + spec.outward]);
  const dRef = grid.dxMm;
  const calLines: Float64Array[] = [];
  /** Per axis: calibration node index -> feed model node index. */
  const from: Array<(n: number) => number> = [];
  calLines[a0] = Float64Array.from([lines[a0][ua] - dRef, ...lines[a0].subarray(ua, ub + 1)]);
  from[a0] = (n) => ua + Math.max(0, n - 1);
  calLines[a1] = Float64Array.from(lines[a1].subarray(va, vb + 1));
  from[a1] = (n) => va + n;
  const extension = Array.from({ length: EXTRA }, (_, n) => runLines[cut] - spec.outward * (n + 1) * runCell);
  if (spec.outward < 0) {
    calLines[run] = Float64Array.from([...runLines.subarray(0, cut + 1), ...extension]);
    from[run] = (n) => Math.min(n, cut);
  } else {
    calLines[run] = Float64Array.from([...extension.reverse(), ...runLines.subarray(cut)]);
    from[run] = (n) => (n < EXTRA ? cut : cut + n - EXTRA);
  }
  const calMesh: MeshLines = { x: calLines[0], y: calLines[1], z: calLines[2] };
  const [nx, ny, nz] = [calMesh.x.length, calMesh.y.length, calMesh.z.length];
  const smallest = smallestCell(calMesh);
  if (Math.abs(smallest - dRef) > 1e-9 * dRef) throw new Error(`calibration mesh smallest cell ${smallest} mm differs from the feed model's ${dRef} mm`);
  const coaxPml = [cpml.faces.xLow, cpml.faces.yLow, cpml.faces.zLow, cpml.faces.xHigh, cpml.faces.yHigh, cpml.faces.zHigh][run + (spec.outward < 0 ? 0 : 3)];
  const low = [0, 0, 0];
  const high = [0, 0, 0];
  low[run] = spec.outward < 0 ? coaxPml : PML_CELLS;
  high[run] = spec.outward < 0 ? PML_CELLS : coaxPml;
  const faces: PmlFaces = { xLow: low[0], xHigh: high[0], yLow: low[1], yHigh: high[1], zLow: low[2], zHigh: high[2] };
  // grid.dxMm, not `smallest`: the extra cell can come out one ulp short, which would change dt.
  const calGrid: GridConfig = { ...grid, nx, ny, nz, dxMm: grid.dxMm, pmlCells: Math.max(coaxPml, PML_CELLS), groundK: 0 };
  const N = nx * ny * nz;
  const N0 = grid.nx * grid.ny * grid.nz;
  const calDecay = new Float32Array(3 * N);
  const calCurl = new Float32Array(3 * N);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const source = idx3(grid, from[0](i), from[1](j), from[2](k));
    const to = idx3(calGrid, i, j, k);
    for (let comp = 0; comp < 3; comp++) {
      calDecay[comp * N + to] = eDecay[comp * N0 + source];
      calCurl[comp * N + to] = eCurl[comp * N0 + source];
    }
  }
  const model: VoxelModel = {
    grid: calGrid,
    eDecay: calDecay,
    eCurl: calCurl,
    mesh: calMesh,
    cpml: buildCpml(calGrid, faces, DEFAULT_CPML_GRADING, calMesh),
    ports: [],
    patchK: 0,
    topCopper: new Uint8Array(nx * ny),
    signature: materialSignature(calDecay, calCurl),
  };
  return { model, feed: feedPlanes(model, spec) };
}

export interface CoaxRun {
  /** Mode voltage at the far and near probes, sampled after each E update. */
  probeVolts: [Float64Array, Float64Array];
  dtSec: number;
  steps: number;
  energyDecayDb: number;
}

/** The run planes of one coax feed driving the source and read at its two probes. */
const ownPlanes = (feed: CoaxFeed): CoaxRunPlanes => ({ source: feed.source, probes: feed.probes });

/**
 * Time-steps the model with the feed's TEM soft source on. With an energy stop
 * the run ends once the field energy has decayed (as CpuFdtd.run); without one
 * it runs exactly maxSteps, which is how the calibration run matches the feed
 * run's length. `recorder` reads the fields after every step, as in CpuFdtd.run.
 */
export function runCoaxFeed(model: VoxelModel, feed: CoaxFeed, exc: ExcitationConfig, control: RunControl, recorder?: StepRecorder): CoaxRun {
  const r = new CpuFdtd(model).runWithCoax(exc, control, recorder, null, ownPlanes(feed));
  return { probeVolts: [r.coaxProbeVolts[0], r.coaxProbeVolts[1]], dtSec: r.dtSec, steps: r.steps, energyDecayDb: r.energyDecayDb };
}

/* ------------------------------------------------------------------------ */
/* Reflection at the flange.                                                  */
/* ------------------------------------------------------------------------ */

export interface CoaxReflection {
  fGHz: Float64Array;
  /** Reflection coefficient at the flange, normalised to the coax impedance. */
  gammaRe: Float64Array;
  gammaIm: Float64Array;
  /** Input impedance at the flange, looking into the board. */
  zRe: Float64Array;
  zIm: Float64Array;
  /** S11 in dB referred to z0 (50 ohm), from Z: what a VNA calibrated at the connector reads. */
  s11Db: Float64Array;
  /** Phase constant of the discrete line, rad/mm, measured between the probes. */
  betaPerMm: Float64Array;
  /** Coax impedance used for Z (from the TEM mode of the near probe plane). */
  lineImpedanceOhm: number;
}

/** DTFT at f of x sampled at (n+1) dt, with the same Tukey taper on the last 20 % as port_dft. */
function dtft(x: Float64Array, fHz: number, dtSec: number): Complex {
  const taper = tukeyTaper(x.length);
  let re = 0;
  let im = 0;
  const w = 2 * Math.PI * fHz * dtSec;
  for (let k = 0; k < x.length; k++) {
    re += x[k] * taper[k] * Math.cos(w * (k + 1));
    im -= x[k] * taper[k] * Math.sin(w * (k + 1));
  }
  return [re, im];
}

/**
 * Phase constant of the discrete line at f from the calibration run: the
 * incident wave at the near probe over the one at the far probe is
 * exp(-j beta spacing). The phase is known modulo 2 pi; take the branch
 * nearest the continuum line's beta, so wide probe spacings work too.
 */
function lineBeta(cal: CoaxRun, feed: CoaxFeed, fHz: number): number {
  const [aF, aN] = [dtft(cal.probeVolts[0], fHz, cal.dtSec), dtft(cal.probeVolts[1], fHz, cal.dtSec)];
  const ratio = divide(aN, aF);
  const ratioPhase = Math.atan2(ratio[1], ratio[0]);
  const spacing = feed.spec.outward * (feed.probes[1].positionMm - feed.probes[0].positionMm) * -1;
  const betaContinuum = (2 * Math.PI * fHz * Math.sqrt(feed.spec.dielectricEpsR)) / (C0 * 1e3);
  const turns = Math.round((betaContinuum * spacing + ratioPhase) / (2 * Math.PI));
  return (2 * Math.PI * turns - ratioPhase) / spacing;
}

/** Distance from the near probe to the flange, along the coax. */
const nearToFlangeMm = (feed: CoaxFeed) => feed.spec.outward * (feed.probes[1].positionMm - feed.spec.flangeMm);

/**
 * Voltage waves at the flange of the feed that carried the source, in volts
 * on the coax line: the incident wave a (toward the board) and the outgoing
 * wave b. `incidentNear` is the calibration run's near-probe voltage, the wave
 * the source launched; the rest of the near-probe voltage is outgoing. Both
 * move from the near probe to the flange along the line:
 * a_f = a_p exp(-j beta d), b_f = b_p exp(+j beta d).
 */
function flangeWaves(nearVolts: Float64Array, incidentNear: Float64Array, beta: number, feed: CoaxFeed, fHz: number, dtSec: number): { a: Complex; b: Complex } {
  const steps = nearVolts.length;
  const incident = incidentNear.subarray(0, steps);
  if (incident.length !== steps) throw new Error(`calibration run has ${incident.length} steps, the feed run ${steps}; run the calibration for at least as long`);
  const outgoing = nearVolts.map((v, n) => v - incident[n]);
  const phase = beta * nearToFlangeMm(feed);
  const a = multiply(dtft(incident, fHz, dtSec), [Math.cos(phase), -Math.sin(phase)]);
  const b = multiply(dtft(outgoing, fHz, dtSec), [Math.cos(phase), Math.sin(phase)]);
  return { a, b };
}

/**
 * |sin(beta * probe spacing)| below which a passive feed's waves are not split:
 * the split divides by 2 sin, so errors in the probe voltages and in beta grow
 * by up to 1 / (2 * 0.1) = 5x at the threshold and without bound past it. With
 * SMA_RUN's probes 4 mm apart in PTFE that is below about 0.8 GHz and from
 * about 25 GHz up.
 */
const MIN_SPLIT_SINE = 0.1;

/**
 * flangeWaves for a passive feed: the wave its PML end sends back in is not
 * known, so both waves come from the two probes. With u the distance out
 * from the flange, V(u) = a exp(+j beta u) + b exp(-j beta u); the far and
 * near probes give two such equations. They lose rank where beta times the
 * probe spacing nears a whole number of pi: at low frequency, and where the
 * spacing is half a wavelength. There (split false) a is taken as zero, the
 * PML end's reflection being small, and the whole near-probe voltage as b.
 */
function passiveFlangeWaves(farVolts: Float64Array, nearVolts: Float64Array, beta: number, feed: CoaxFeed, fHz: number, dtSec: number): { a: Complex; b: Complex; split: boolean } {
  const uFar = feed.spec.outward * (feed.probes[0].positionMm - feed.spec.flangeMm);
  const uNear = nearToFlangeMm(feed);
  const sine = Math.sin(beta * (uFar - uNear));
  const turn = (phase: number): Complex => [Math.cos(phase), Math.sin(phase)];
  const vNear = dtft(nearVolts, fHz, dtSec);
  if (Math.abs(sine) < MIN_SPLIT_SINE) return { a: [0, 0], b: multiply(vNear, turn(beta * uNear)), split: false };
  const vFar = dtft(farVolts, fHz, dtSec);
  const det: Complex = [0, 2 * sine];
  const minus = (x: Complex, y: Complex): Complex => [x[0] - y[0], x[1] - y[1]];
  const a = divide(minus(multiply(vFar, turn(-beta * uNear)), multiply(vNear, turn(-beta * uFar))), det);
  const b = divide(minus(multiply(vNear, turn(beta * uFar)), multiply(vFar, turn(beta * uNear))), det);
  return { a, b, split: true };
}

export function coaxReflection(feedRun: CoaxRun, calRun: CoaxRun, feed: CoaxFeed, exc: ExcitationConfig): CoaxReflection {
  if (feedRun.steps !== calRun.steps || feedRun.dtSec !== calRun.dtSec) {
    throw new Error(`feed and calibration runs differ (${feedRun.steps} vs ${calRun.steps} steps); run the calibration for the feed run's steps`);
  }
  const nf = bandPoints(exc);
  const out: CoaxReflection = {
    fGHz: new Float64Array(nf), gammaRe: new Float64Array(nf), gammaIm: new Float64Array(nf), zRe: new Float64Array(nf), zIm: new Float64Array(nf),
    s11Db: new Float64Array(nf), betaPerMm: new Float64Array(nf), lineImpedanceOhm: feed.probes[1].impedanceOhm,
  };
  const zc = out.lineImpedanceOhm;
  for (let m = 0; m < nf; m++) {
    const f = bandFrequencyHz(exc, m);
    const beta = lineBeta(calRun, feed, f);
    const { a, b } = flangeWaves(feedRun.probeVolts[1], calRun.probeVolts[1], beta, feed, f, feedRun.dtSec);
    const [fr, fi] = divide(b, a);
    // Z = zc (1 + Gamma) / (1 - Gamma)
    const [zr, zi] = divide([zc * (1 + fr), zc * fi], [1 - fr, -fi]);
    out.fGHz[m] = f / 1e9;
    out.gammaRe[m] = fr;
    out.gammaIm[m] = fi;
    out.zRe[m] = zr;
    out.zIm[m] = zi;
    out.s11Db[m] = s11FromZ(zr, zi, exc.z0);
    out.betaPerMm[m] = beta;
  }
  return out;
}

export interface CoaxFeedSolve {
  reflection: CoaxReflection;
  /** The feed run: steps and energy decay; the calibration run matches its length. */
  feedRun: CoaxRun;
  /** Coax impedance on this mesh, as the near probe reads it. */
  lineImpedanceOhm: number;
}

/**
 * One coax feed on a board with one lumped stand-in port: swap the port for
 * the feed, run it to the energy stop, run the calibration coax for the same
 * number of steps, and de-embed S11 to the flange. CPU only.
 */
export function solveCoaxFeed(boardModel: VoxelModel, spec: CoaxFeedSpec, exc: ExcitationConfig, control: RunControl, recorder?: StepRecorder): CoaxFeedSolve {
  const { model, feed } = addCoaxFeed(boardModel, spec);
  const feedRun = runCoaxFeed(model, feed, exc, control, recorder);
  const cal = coaxCalibrationModel(model, feed);
  const calRun = runCoaxFeed(cal.model, cal.feed, exc, { ...control, maxSteps: feedRun.steps, stopAtEnergyDecayDb: null });
  const reflection = coaxReflection(feedRun, calRun, feed, exc);
  return { reflection, feedRun, lineImpedanceOhm: reflection.lineImpedanceOhm };
}

/* ------------------------------------------------------------------------ */
/* Several ports: coax feeds and lumped ports together.                       */
/* ------------------------------------------------------------------------ */

/** A coax feed in place of the lumped stand-in port `port` (an index into VoxelModel.ports). */
export interface CoaxPort {
  port: number;
  spec: CoaxFeedSpec;
}

/** Called after every energy check (every control.energyCheckEverySteps steps) with the steps done and the energy fall from its peak. */
export type RunProgress = (stepsDone: number, energyDecayDb: number) => void;

/**
 * One solver loaded with one model: runs it with coax planes, as
 * CpuFdtd.runWithCoax does, one run after another. solvePorts takes a factory
 * of these so the same port solve runs on the CPU or on the GPU (fdtd3d.ts).
 * `recorder` reads the fields after every step, which only the CPU engine can.
 */
export interface CoaxEngine {
  run(control: RunControl, activePort: number | null, planes: CoaxRunPlanes, extras: { onProgress?: RunProgress; recorder?: StepRecorder }): Promise<CoaxRunSamples>;
  destroy(): void;
}

/** Makes an engine for `model`, sized for runs of up to `maxSteps`. */
export type CoaxEngineFactory = (model: VoxelModel, exc: ExcitationConfig, maxSteps: number) => Promise<CoaxEngine>;

/** The CPU reference engine. */
export const cpuCoaxEngine: CoaxEngineFactory = async (model, exc) => {
  const sim = new CpuFdtd(model);
  return {
    run: async (control, activePort, planes, { onProgress, recorder }) => {
      // The decay as the GPU engine reports it: EnergyStop over every check.
      const decay = new EnergyStop({ ...control, stopAtEnergyDecayDb: null }, sourceEndStep(sourceParams(exc), timestepSec(model.grid)));
      const progress: StepRecorder | null = onProgress ? {
        afterStep(n, at) {
          if ((n + 1) % control.energyCheckEverySteps !== 0) return;
          decay.check(n + 1, at.energy());
          onProgress(n + 1, decay.decayDb);
        },
      } : null;
      const both: StepRecorder | undefined = progress && recorder
        ? { afterStep: (n, at) => { recorder.afterStep(n, at); progress.afterStep(n, at); } }
        : (progress ?? recorder);
      return sim.runWithCoax(exc, control, both, activePort, planes);
    },
    destroy: () => {},
  };
};

export interface PortSolveOptions {
  /** Runs the solves; default the CPU reference. */
  engine?: CoaxEngineFactory;
  /** Reads the fields after every step of the first run; CPU engine only. */
  recorder?: StepRecorder;
  /** After every energy check of every run: run n (0-based) of `runs`, the calibration runs last. */
  onProgress?: (run: number, runs: number, stepsDone: number, energyDecayDb: number) => void;
}

export interface PortRunSummary {
  /** Index into the board model's ports of the port that carried the source. */
  activePort: number;
  steps: number;
  energyDecayDb: number;
  stoppedOnEnergy: boolean;
}

export interface PortSolve {
  /** S over the band in board-port order, referred to `referenceOhm` at every port. */
  scattering: ScatteringResult;
  runs: PortRunSummary[];
  /** Coax line impedance on this mesh per board port, null for a lumped port. */
  lineImpedanceOhm: Array<number | null>;
  /**
   * Per board port, the band frequencies (GHz) where this coax port, passive in
   * another port's run, took the wave from its PML end as zero because its
   * probes were too close in wavelengths to split the waves (passiveFlangeWaves).
   */
  unsplitGHz: number[][];
}

/**
 * The S-matrix of a board whose ports are coax feeds, lumped ports, or both:
 * one run per excited port with every other port present and passive (a
 * coax feed ends in its PML, a lumped port in its resistor), then one
 * calibration run per coax feed. Coax waves are read at the flange in volts
 * on the coax line (flangeWaves) and become power waves on its impedance;
 * lumped waves come from V and I (lumpedPortWaves). S is formed on those
 * references and renormalised to `referenceOhm`, which needs every port
 * excited unless there is only one.
 */
export async function solvePorts(
  boardModel: VoxelModel, coaxPorts: readonly CoaxPort[], referenceOhm: readonly number[], excited: readonly number[],
  exc: ExcitationConfig, control: RunControl, { engine = cpuCoaxEngine, recorder, onProgress }: PortSolveOptions = {},
): Promise<PortSolve> {
  const portCount = boardModel.ports.length;
  if (referenceOhm.length !== portCount) throw new Error(`${referenceOhm.length} reference impedances for ${portCount} ports`);
  if (coaxPorts.length > 0 && portCount > 1 && excited.length !== portCount) {
    throw new Error('with a coax feed and more than one port, every port must be excited: S is renormalised from the coax line to the reference impedance');
  }
  const replaced = coaxPorts.map((c) => c.port);
  const { model, feeds } = addCoaxFeeds(boardModel, coaxPorts.map((c) => c.spec), replaced);
  // Board port -> its coax feed, or its index among the remaining lumped ports.
  const feedOf = (port: number) => replaced.indexOf(port);
  const lumpedIndex = (port: number) => port - replaced.filter((r) => r < port).length;
  const probes = feeds.flatMap((feed) => feed.probes);
  const runCount = excited.length + feeds.length;
  const progressOf = (n: number): RunProgress | undefined => onProgress && ((steps, decayDb) => onProgress(n, runCount, steps, decayDb));
  const runs: CoaxRunSamples[] = [];
  const board = await engine(model, exc, control.maxSteps);
  try {
    for (const [n, port] of excited.entries()) {
      const feed = feedOf(port);
      const planes: CoaxRunPlanes = { source: feed >= 0 ? feeds[feed].source : null, probes };
      runs.push(await board.run(control, feed >= 0 ? null : lumpedIndex(port), planes, { onProgress: progressOf(n), recorder: n === 0 ? recorder : undefined }));
    }
  } finally {
    board.destroy();
  }
  const longest = Math.max(...runs.map((r) => r.steps));
  const calRuns: CoaxRun[] = [];
  for (const [q, feed] of feeds.entries()) {
    const cal = coaxCalibrationModel(model, feed);
    const calEngine = await engine(cal.model, exc, longest);
    try {
      const r = await calEngine.run({ ...control, maxSteps: longest, stopAtEnergyDecayDb: null }, null, ownPlanes(cal.feed), { onProgress: progressOf(excited.length + q) });
      calRuns.push({ probeVolts: [r.coaxProbeVolts[0], r.coaxProbeVolts[1]], dtSec: r.dtSec, steps: r.steps, energyDecayDb: r.energyDecayDb });
    } finally {
      calEngine.destroy();
    }
  }

  const lineOhm = Array.from({ length: portCount }, (_, port) => (feedOf(port) >= 0 ? feeds[feedOf(port)].probes[1].impedanceOhm : null));
  const measuredOhm = lineOhm.map((z, port) => z ?? referenceOhm[port]);
  const tapers = runs.map((r) => tukeyTaper(r.steps));
  let betaAt = { fHz: NaN, beta: [] as number[] };
  const unsplit: number[][] = Array.from({ length: portCount }, () => []);
  const raw = scatteringFromWaves([...excited], portCount, exc, (n, port, fHz) => {
    const run = runs[n];
    const feed = feedOf(port);
    if (feed < 0) return lumpedPortWaves({ ...run.ports[lumpedIndex(port)], dtSec: run.dtSec }, tapers[n], fHz, referenceOhm[port]);
    if (betaAt.fHz !== fHz) betaAt = { fHz, beta: feeds.map((f, q) => lineBeta(calRuns[q], f, fHz)) };
    const [far, near] = [run.coaxProbeVolts[2 * feed], run.coaxProbeVolts[2 * feed + 1]];
    let waves: { a: Complex; b: Complex };
    if (excited[n] === port) waves = flangeWaves(near, calRuns[feed].probeVolts[1], betaAt.beta[feed], feeds[feed], fHz, run.dtSec);
    else {
      const passive = passiveFlangeWaves(far, near, betaAt.beta[feed], feeds[feed], fHz, run.dtSec);
      if (!passive.split && !unsplit[port].includes(fHz / 1e9)) unsplit[port].push(fHz / 1e9);
      waves = passive;
    }
    const { a, b } = waves;
    const scale = 1 / Math.sqrt(measuredOhm[port]);
    return { a: [a[0] * scale, a[1] * scale], b: [b[0] * scale, b[1] * scale] };
  });
  const scattering = raw.method === 'full' ? renormaliseScattering(raw, measuredOhm, [...referenceOhm]) : raw;
  return {
    scattering,
    runs: runs.map((r, n) => ({ activePort: excited[n], steps: r.steps, energyDecayDb: r.energyDecayDb, stoppedOnEnergy: r.stoppedOnEnergy })),
    lineImpedanceOhm: lineOhm,
    unsplitGHz: unsplit,
  };
}
