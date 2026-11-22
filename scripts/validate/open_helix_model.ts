/**
 * A center-fed open-helix element (two dipoles wrapped on a cylinder, fed by
 * a parallel-strip line across a center PCB disk), built directly as a
 * VoxelModel. The project file describes planar boards only, so this
 * benchmark goes below it to the engine (docs/benchmarks/gonzaga.md).
 *
 * Coordinates in mm, the helix axis along z, the disk centred on z = 0.
 *
 *  - Center disk: a dielectric disk of radius `radiusMm` and thickness
 *    `diskThicknessMm`. A copper trace `diskTraceWidthMm` wide runs along x
 *    across the whole diameter on its top face, and the same trace on its
 *    bottom face. The lumped port joins the two traces at the centre, the way
 *    the coax inner and shield join them on the prototype.
 *  - Arms: copper strips on the cylinder surface r = radiusMm. Upper arm of
 *    dipole A starts on the top trace's end at phi = 0 and climbs at the pitch
 *    angle `pitchDeg` while wrapping `armWrapDeg` round the axis. Its width,
 *    measured across the strip, is `armWidthMm`; its ends are cut along the
 *    axis. The lower arm is the upper arm turned 180 degrees about the x axis
 *    ((x, y, z) -> (x, -y, -z)), which keeps the helix sense; dipole B is
 *    dipole A turned 180 degrees about z. The structure keeps both symmetries.
 *
 * Staircasing: copper is painted on whole cell faces. A cylinder face is the
 * vertical face between a cell whose centre is inside r < R and its outside
 * neighbour, so the sheet is closed with no holes; a face is copper when its
 * centre lies on an arm. The traces are the z faces of the inside cells on the
 * trace planes. Edges shared by a copper face are copper, so copper grows by up
 * to half a cell at its outline, as on every staircased FDTD model.
 */
import { assertStableGrid, DEFAULT_GRID } from '../../src/engine/config';
import { buildCpml, uniformFaces } from '../../src/engine/cpml';
import { gradedLines, smallestCell, type FixedInterval, type MeshLines } from '../../src/engine/mesh';
import type { GridConfig } from '../../src/engine/types';
import {
  dielectricEdge, lossTangentSigmaDtOverEps0, materialSignature, portCoefficients, portMeshFactors, surfaceResistanceOhm, type VoxelModel,
} from '../../src/engine/voxelize';
import { timestepSec } from '../../src/engine/config';
import { addConformalSheets } from '../../src/project/conformal_sheets';
import type { TriangleMesh } from '../../src/project/conformal_solids';

export interface OpenHelixGeometry {
  radiusMm: number;
  pitchDeg: number;
  armWidthMm: number;
  armWrapDeg: number;
  diskTraceWidthMm: number;
  diskThicknessMm: number;
  diskEpsR: number;
  diskTanDelta: number;
  /** Copper conductivity for the sheet loss, or null for PEC. */
  copperConductivitySPerM: number | null;
}

export interface OpenHelixMeshOptions {
  /** Cell size over the antenna. */
  cellMm: number;
  /** Largest cell, reached in the air towards the PML. */
  coarseCellMm: number;
  /** Air from the antenna's outline to the outer wall, PML included. */
  paddingMm: number;
  pmlCells: number;
  maxGrowth: number;
  /**
   * How the arms reach the grid: 'staircase' paints whole cell faces (below);
   * 'sheet' passes them as thin conformal sheets (conformal_sheets.ts) that
   * follow the cylinder. Default 'staircase'.
   */
  arms?: 'staircase' | 'sheet';
  /** Courant number; sheets need CONFORMAL_SOLID_COURANT or less. Default DEFAULT_GRID.courant. */
  courant?: number;
}

export interface OpenHelixModel {
  model: VoxelModel;
  /** Antenna height from the lowest to the highest copper (mm). */
  heightMm: number;
  /** Length of one arm along its centre line (mm). */
  armLengthMm: number;
  copperFaces: number;
}

const DEG = Math.PI / 180;

/** Top-arm extent: the vertical span of a strip of perpendicular width W at pitch alpha is W / cos(alpha). */
export function upperArmTopMm(g: OpenHelixGeometry): number {
  const wrap = g.armWrapDeg * DEG;
  return g.diskThicknessMm / 2 + g.radiusMm * wrap * Math.tan(g.pitchDeg * DEG) + g.armWidthMm / Math.cos(g.pitchDeg * DEG);
}

export function assertGeometry(g: OpenHelixGeometry): void {
  const positive: Array<keyof OpenHelixGeometry> = ['radiusMm', 'pitchDeg', 'armWidthMm', 'armWrapDeg', 'diskTraceWidthMm', 'diskThicknessMm', 'diskEpsR'];
  for (const key of positive) if (!(Number(g[key]) > 0)) throw new Error(`${key} must be positive, got ${g[key]}`);
  // Arm A's upper arm spans phi in [start, start + wrap]; dipole B's starts at 180 degrees. Wrapping 180 or more shorts them.
  const startDeg = (g.diskTraceWidthMm / 2 / g.radiusMm) / DEG;
  if (g.armWrapDeg >= 180) throw new Error(`armWrapDeg ${g.armWrapDeg} must stay below 180: the two upper arms would overlap`);
  if (g.diskTraceWidthMm >= g.radiusMm) throw new Error('the disk trace must be narrower than the disk radius');
  if (startDeg >= g.armWrapDeg) throw new Error('the arm is shorter than the trace it starts on');
}

/**
 * True when (x, y, z) on the cylinder lies on the upper arm of dipole A. The
 * arm starts half a trace width before phi = 0, so its start covers the
 * trace's end, and its lower edge sits on the top trace plane there.
 */
function onUpperArmA(g: OpenHelixGeometry, x: number, y: number, z: number): boolean {
  const start = -(g.diskTraceWidthMm / 2) / g.radiusMm;
  let phi = Math.atan2(y, x) - start;
  if (phi < 0) phi += 2 * Math.PI;
  if (phi > g.armWrapDeg * DEG) return false;
  // Over the trace's end the lower edge stays on the disk, so the whole trace end is soldered to the arm.
  const onTraceEnd = phi <= (2 * -start);
  const lower = g.diskThicknessMm / 2 + (onTraceEnd ? 0 : g.radiusMm * phi * Math.tan(g.pitchDeg * DEG));
  return z >= lower && z <= lower + g.armWidthMm / Math.cos(g.pitchDeg * DEG);
}

/** The four 180-degree turns that make the four arms from the upper arm of dipole A. */
const ARM_TURNS: Array<[number, number, number]> = [[1, 1, 1], [1, -1, -1], [-1, -1, 1], [-1, 1, -1]];

/**
 * The four arms as thin sheets: the same outline as onUpperArmA, sampled
 * every `stepMm` or less along the cylinder. Over the trace's end the arm's
 * foot reaches `footMm` below the disk face, so the sheet crosses the trace
 * plane there and meets the trace's copper edges (a sheet that stops on the
 * plane would float 1e-7 mm above it, see SheetMeshOptions).
 */
export function armSheets(g: OpenHelixGeometry, stepMm: number, footMm: number): TriangleMesh[] {
  const start = -(g.diskTraceWidthMm / 2) / g.radiusMm;
  const wrap = g.armWrapDeg * DEG;
  const tanP = Math.tan(g.pitchDeg * DEG);
  const span = g.armWidthMm / Math.cos(g.pitchDeg * DEG);
  const flat = 2 * -start;
  const halfT = g.diskThicknessMm / 2;
  // Samples of phi (from the arm's start): the flat part, a step at its end (the outline jumps there), then the climb.
  const count = (from: number, to: number) => Math.max(1, Math.ceil(((to - from) * g.radiusMm) / stepMm));
  const phis: Array<[phi: number, lower: number]> = [];
  for (let n = 0, m = count(0, flat); n <= m; n++) phis.push([(flat * n) / m, halfT - footMm]);
  const jump = 1e-4;
  for (let n = 0, m = count(flat + jump, wrap); n <= m; n++) {
    const phi = flat + jump + ((wrap - flat - jump) * n) / m;
    phis.push([phi, halfT + g.radiusMm * phi * tanP]);
  }
  return ARM_TURNS.map(([sx, sy, sz]) => {
    const points: number[] = [];
    for (const [phi, lower] of phis) {
      const [x, y] = [g.radiusMm * Math.cos(phi + start), g.radiusMm * Math.sin(phi + start)];
      for (const z of [lower, (phi <= flat ? halfT : lower) + span]) points.push(sx * x, sy * y, sz * z);
    }
    const triangles: number[] = [];
    for (let n = 0; n + 1 < phis.length; n++) triangles.push(2 * n, 2 * n + 2, 2 * n + 3, 2 * n, 2 * n + 3, 2 * n + 1);
    return { positions: Float64Array.from(points), triangles: Uint32Array.from(triangles) };
  });
}

/** Any of the four arms, by the two 180 degree turns. */
export function onArm(g: OpenHelixGeometry, x: number, y: number, z: number): boolean {
  return onUpperArmA(g, x, y, z) || onUpperArmA(g, x, -y, -z) || onUpperArmA(g, -x, -y, z) || onUpperArmA(g, -x, y, -z);
}

/** Mesh lines along one axis: fine over [-inner, inner], fixed lines at `fixed`, graded out to +-outer. */
function axisLines(innerMm: number, outerMm: number, fixed: number[], o: OpenHelixMeshOptions): Float64Array {
  const cuts = [...new Set([-outerMm, -innerMm, ...fixed, innerMm, outerMm])].sort((a, b) => a - b);
  const intervals: FixedInterval[] = [];
  for (let n = 0; n + 1 < cuts.length; n++) {
    const inside = cuts[n] >= -innerMm - 1e-9 && cuts[n + 1] <= innerMm + 1e-9;
    intervals.push({ start: cuts[n], end: cuts[n + 1], maxCellMm: inside ? o.cellMm : o.coarseCellMm });
  }
  return gradedLines(intervals, { maxCellMm: o.coarseCellMm, maxGrowth: o.maxGrowth });
}

export function buildOpenHelix(g: OpenHelixGeometry, o: OpenHelixMeshOptions, z0 = 50, referenceGhz = 0.915): OpenHelixModel {
  assertGeometry(g);
  const halfT = g.diskThicknessMm / 2;
  const top = upperArmTopMm(g);
  // One fine cell of air outside the cylinder before the grading starts.
  const innerXY = g.radiusMm + 2 * o.cellMm;
  const innerZ = top + 2 * o.cellMm;
  const halfW = g.diskTraceWidthMm / 2;
  // Sheet arms keep their free ends exactly where mesh lines run through them. Sub-cell rims
  // (conformal_sheets.ts) would place them between lines too; the lines keep rims: 'snap' runs exact there.
  const sheetArms = o.arms === 'sheet';
  if (sheetArms && g.copperConductivitySPerM !== null) throw new Error('sheet arms are PEC: thin sheets carry no copper loss yet, so pass copperConductivitySPerM null (--copper 0)');
  const endPhi = g.armWrapDeg * DEG - (g.diskTraceWidthMm / 2) / g.radiusMm;
  const [endX, endY] = [Math.abs(g.radiusMm * Math.cos(endPhi)), Math.abs(g.radiusMm * Math.sin(endPhi))];
  const mesh: MeshLines = {
    x: axisLines(innerXY, innerXY + o.paddingMm, sheetArms ? [-endX, 0, endX] : [0], o),
    y: axisLines(innerXY, innerXY + o.paddingMm, sheetArms ? [-endY, -halfW, 0, halfW, endY] : [-halfW, 0, halfW], o),
    // The disk is one interval of cells no larger than its half thickness: two cells across at most.
    z: axisLines(innerZ, innerZ + o.paddingMm, [-halfT, 0, halfT], { ...o, cellMm: o.cellMm }),
  };
  const [nx, ny, nz] = [mesh.x.length, mesh.y.length, mesh.z.length];
  const grid: GridConfig = { ...DEFAULT_GRID, nx, ny, nz, dxMm: smallestCell(mesh), pmlCells: o.pmlCells, groundK: 0, courant: o.courant ?? DEFAULT_GRID.courant };
  const faces = uniformFaces(o.pmlCells);
  assertStableGrid(grid, faces);
  const N = nx * ny * nz;
  const index = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const nodeAt = (lines: Float64Array, v: number) => {
    const n = lines.findIndex((u) => Math.abs(u - v) < 1e-9);
    if (n < 0) throw new Error(`no mesh line at ${v} mm`);
    return n;
  };
  const centre = (lines: Float64Array, n: number) => (lines[n] + lines[n + 1]) / 2;
  const kBottom = nodeAt(mesh.z, -halfT);
  const kTop = nodeAt(mesh.z, halfT);
  const iAxis = nodeAt(mesh.x, 0);
  const jAxis = nodeAt(mesh.y, 0);

  // Cells whose centre is inside the cylinder: the disk's footprint and the staircase of the arms.
  const inside = new Uint8Array(nx * ny);
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    inside[i + nx * j] = Math.hypot(centre(mesh.x, i), centre(mesh.y, j)) < g.radiusMm ? 1 : 0;
  }
  const insideAt = (i: number, j: number) => (i >= 0 && j >= 0 && i < nx - 1 && j < ny - 1 ? inside[i + nx * j] : 0);

  // Dielectric: the disk cells, Ez inside, Ex/Ey on its faces averaged with the air.
  const dt = timestepSec(grid);
  const sigma = lossTangentSigmaDtOverEps0(g.diskEpsR, g.diskTanDelta, referenceGhz * 1e9, dt);
  const eDecay = new Float32Array(3 * N).fill(1);
  const eCurl = new Float32Array(3 * N).fill(grid.courant);
  const setEdge = (e: number, fill: number) => {
    // fill: fraction of the edge's surroundings that is disk.
    const edge = dielectricEdge(grid.courant, 1 + (g.diskEpsR - 1) * fill, sigma * fill);
    eDecay[e] = edge.decay;
    eCurl[e] = edge.curl;
  };
  for (let k = kBottom; k <= kTop; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const zFill = k === kBottom || k === kTop ? 0.5 : 1;
    // Ex at (i+1/2, j): the cells on either side along y.
    const exFill = (insideAt(i, j - 1) + insideAt(i, j)) / 2;
    const eyFill = (insideAt(i - 1, j) + insideAt(i, j)) / 2;
    if (exFill > 0) setEdge(index(i, j, k), exFill * zFill);
    if (eyFill > 0) setEdge(N + index(i, j, k), eyFill * zFill);
    if (k < kTop) {
      const ezFill = (insideAt(i - 1, j - 1) + insideAt(i, j - 1) + insideAt(i - 1, j) + insideAt(i, j)) / 4;
      if (ezFill > 0) setEdge(2 * N + index(i, j, k), ezFill);
    }
  }

  // Copper: each face as its edges, with the face's normal for the sheet loss.
  const copper = new Map<number, number>();
  const paint = (edges: number[], normalAxis: number) => { for (const e of edges) if (!copper.has(e)) copper.set(e, normalAxis); };
  let copperFaces = 0;
  // Traces: z faces of inside cells with their centre on the trace, on both disk faces. With sheet arms,
  // every cell the cylinder cuts too, so the trace reaches past the arm's foot (by under a cell) and meets it.
  const reachesInside = (i: number, j: number) => Math.min(...[mesh.x[i], mesh.x[i + 1]].flatMap((x) => [mesh.y[j], mesh.y[j + 1]].map((y) => Math.hypot(x, y)))) < g.radiusMm;
  for (const k of [kBottom, kTop]) for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    if (!(sheetArms ? reachesInside(i, j) : insideAt(i, j)) || Math.abs(centre(mesh.y, j)) > halfW) continue;
    paint([index(i, j, k), index(i, j + 1, k), N + index(i, j, k), N + index(i + 1, j, k)], 2);
    copperFaces++;
  }
  // Cylinder: x faces at node i between cells i-1 and i, y faces at node j between cells j-1 and j.
  for (let k = 0; k + 1 < nz && !sheetArms; k++) {
    const zc = centre(mesh.z, k);
    if (Math.abs(zc) < halfT) continue;
    for (let j = 0; j + 1 < ny; j++) for (let i = 1; i + 1 < nx; i++) {
      if (insideAt(i - 1, j) === insideAt(i, j) || !onArm(g, mesh.x[i], centre(mesh.y, j), zc)) continue;
      paint([N + index(i, j, k), N + index(i, j, k + 1), 2 * N + index(i, j, k), 2 * N + index(i, j + 1, k)], 0);
      copperFaces++;
    }
    for (let j = 1; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
      if (insideAt(i, j - 1) === insideAt(i, j) || !onArm(g, centre(mesh.x, i), mesh.y[j], zc)) continue;
      paint([index(i, j, k), index(i, j, k + 1), 2 * N + index(i, j, k), 2 * N + index(i + 1, j, k)], 1);
      copperFaces++;
    }
  }
  for (const e of copper.keys()) eCurl[e] = 0;
  const eIndex = Uint32Array.from(copper.keys());
  const sheets = g.copperConductivitySPerM === null ? undefined : {
    eIndex,
    normalAxis: Uint8Array.from(copper.values()),
    rsOhm: new Float32Array(eIndex.length).fill(surfaceResistanceOhm(g.copperConductivitySPerM, referenceGhz * 1e9)),
  };

  // Port: the Ez column on the axis from the bottom trace to the top trace.
  const ezIndex = Uint32Array.from({ length: kTop - kBottom }, (_, n) => 2 * N + index(iAxis, jAxis, kBottom + n));
  for (const e of ezIndex) { eDecay[e] = 1; eCurl[e] = 0; }
  if (!(copper.has(index(iAxis, jAxis, kTop)) && copper.has(index(iAxis - 1, jAxis, kTop)))) {
    throw new Error('the port node is not on the top trace');
  }
  const portMesh = portMeshFactors(mesh, iAxis, jAxis, kBottom, kTop, grid.dxMm);
  const coefficients = portCoefficients(grid.courant, g.diskEpsR, z0, portMesh.seriesLength, 1, portMesh.loopLengthX * portMesh.loopLengthY);

  const model: VoxelModel = {
    grid, eDecay, eCurl, mesh,
    cpml: buildCpml(grid, faces, undefined, mesh),
    ports: [{ i: iAxis, j: jAxis, k0: kBottom, k1: kTop, ezIndex, columns: 1, seriesCells: ezIndex.length, cells: ezIndex.length, mesh: portMesh, ...coefficients }],
    patchK: kTop,
    topCopper: new Uint8Array(nx * ny),
    sheets,
    signature: materialSignature(eDecay, eCurl, { sheets }),
  };
  // Half a disk cell of foot: it crosses the trace plane and no other.
  if (sheetArms) addConformalSheets(model, armSheets(g, o.cellMm / 4, (mesh.z[kTop] - mesh.z[kTop - 1]) / 2));
  return {
    model,
    heightMm: 2 * top,
    armLengthMm: (g.radiusMm * g.armWrapDeg * DEG) / Math.cos(g.pitchDeg * DEG),
    copperFaces,
  };
}

export type Complex = [re: number, im: number];

/**
 * Circular components of a far-field direction from r E_theta and r E_phi
 * (phasors for exp(+j w t)). With r = theta x phi, the IEEE right-hand unit
 * vector is (theta - j phi) / sqrt 2, so E_R = (E_theta + j E_phi) / sqrt 2
 * and E_L = (E_theta - j E_phi) / sqrt 2.
 */
export function circularComponents(eTheta: Complex, ePhi: Complex): { right: number; left: number; axialRatioDb: number } {
  const right = Math.hypot(eTheta[0] - ePhi[1], eTheta[1] + ePhi[0]) / Math.SQRT2;
  const left = Math.hypot(eTheta[0] + ePhi[1], eTheta[1] - ePhi[0]) / Math.SQRT2;
  const major = right + left;
  const minor = Math.abs(right - left);
  return { right, left, axialRatioDb: minor === 0 ? Infinity : 20 * Math.log10(major / minor) };
}
