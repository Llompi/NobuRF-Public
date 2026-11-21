import { CONFORMAL_COURANT, COVERAGE_SNAP, effectiveFreeArea, type ConformalFaces } from '../engine/conformal';
import { coaxProbe, coaxRefinements, connectorsOverlap, edgeLaunchSma, type CoaxPort } from '../engine/coax_feed';
import { assertStableGrid, DEFAULT_GRID, timestepSec } from '../engine/config';
import { buildCpml, DEFAULT_CPML_GRADING, type PmlFaces } from '../engine/cpml';
import { placeComponents, type ComponentEdge } from '../engine/lumped';
import { fitSurfaceShape, skinDepthM, surfacePoles, type Roughness, type SurfaceShape } from '../engine/surface_impedance';
import { cellWidth, dualWidth, gradedLines, mergeFixedLines, smallestCell, uniformLines, type MeshLines, type Refinement } from '../engine/mesh';
import {
  constantResponse, DispersionBuilder, withoutEdges, mediumRecord, relativeValue, VACUUM_RESPONSE, type MediumResponse, type ModelDispersion,
} from '../engine/dispersion';
import type { GridConfig } from '../engine/types';
import {
  dielectricEdge, edgeLossFactor, idx3, lossTangentSigmaDtOverEps0, materialSignature, portCoefficients, portMeshFactors, sheetFaceLoss, surfaceResistanceOhm, type PortSpec, type VoxelModel,
} from '../engine/voxelize';
import { SHEET_EDGE_OFFSET_RING_CELLS, sheetEdgeOffsetCells } from '../engine/yee_edge';
import { planeCoverage, polygonSegments, type PlaneCoverage } from './coverage';
import { shortestWavelength, type MaterialResponses } from './materials';
import { DEFAULT_COPPER_THICKNESS_MM, resolveProject, type ResolvedShape, type ResolvedVia, type Vec2 } from './resolve';
import { fail, ProjectError, type Face, type Project } from './schema';

/**
 * Layered rasteriser: project file -> the VoxelModel the solvers consume,
 * with the same conventions as voxelize.ts (which it reproduces exactly for
 * the demo patch, see tests/project_regression.test.ts):
 *   - copper layers are zero-thickness sheets: they zero tangential Ex/Ey on
 *     their z plane only; Ez edges always see the dielectric of their cell;
 *   - Ex/Ey on a plane average eps and conductivity of the cells above and
 *     below (interfaces between layers and to the air);
 *   - dielectrics and copper exist only inside the board outline;
 *   - the port column has eDecay 1 and eCurl 0 (the port kernel owns it).
 *
 * Grid layout: along x and y, PML | air margin | board bounding box | air
 * margin | PML; along z, PML | margin below | stackup | margin above | PML.
 * A "pec" face has no PML: the solver's high walls are PEC already, and the
 * low walls are made PEC here by zeroing their tangential E.
 *
 * Mesh: uniform cubic cells of mesh.cell (layers and shapes snap to them), or
 * with mesh.graded a tensor-product mesh (mesh.ts) with lines on the board
 * outline, every copper edge parallel to an axis, every port and every layer
 * interface. Cells are edge_cell at copper, at most thickness / dielectric_cells
 * in a dielectric and grow by max_growth up to mesh.cell. The PML continues
 * the outermost cell width. Copper edges are PEC, with a surface impedance on each face for a
 * finite conductivity (ConductorSheets in voxelize.ts).
 *
 * Copper: by default an edge is copper when its midpoint is (a staircase).
 * With mesh.conformal, each edge and face of a copper plane takes the exact
 * fraction of it the copper covers (coverage.ts, conformal.ts): an edge is PEC
 * only when wholly covered, a partly covered edge keeps lambda = its free
 * fraction of its curl coefficient, and the faces cut by a copper edge are
 * updated over their free area. Copper edges on mesh lines mesh as before, so
 * this changes only slanted and curved edges and edges between mesh lines.
 */

/**
 * Mesh refinements from outside the project file, e.g. a coax feed modelled
 * in the air beside the board (coax_feed.ts). Each puts a fixed line at `at`
 * (mm, board coordinates; z = 0 at the bottom of the stackup) with cells of at
 * most `cellMm` there. Graded meshes only.
 */
export interface RasteriseOptions {
  refinements?: { x?: Refinement[]; y?: Refinement[]; z?: Refinement[] };
}

export interface Rasterised {
  model: VoxelModel;
  /** Things the user should know, e.g. a layer thickness snapped to the grid. */
  warnings: string[];
  /**
   * The coax feeds of the sma_edge and coax_probe ports, in port order. The
   * model carries a lumped stand-in port at each (at the flange of an SMA, at
   * the probe for a coax probe), on the meshed connector lines; solve with
   * solvePorts (coax_feed.ts), which swaps those ports for the feeds.
   */
  coaxPorts: CoaxPort[];
}

/**
 * Target cell across an SMA connector: 10 across the pin, as in the validation
 * runs (docs/validation.md section 3.2). The actual cell is adjusted so the
 * lattice lands on the trace's edges (smaCrossCell).
 */
const SMA_CROSS_CELL_MM = 0.125;
/** The SMA source and probes sit 14, 10 and 6 mm from the flange: the run lattice must divide 2 mm. */
const SMA_PLANE_SPACING_MM = 2;

/**
 * Largest grid rasterise builds. 50M cells is about 1.2 GB of field and
 * coefficient arrays and hours of CPU time; a project file asking for more
 * (say a 1 um cell) is a mistake, and failing here keeps it from hanging the
 * process or the browser tab that opened it.
 */
export const MAX_CELLS = 50_000_000;

/** A smallest cell below wavelength(f_max) / this is almost surely a typo; rasterise warns, since it sets the time step. */
const MAX_WAVELENGTH_OVER_CELL = 2000;

function assertCellCount(nx: number, ny: number, nz: number, path: string): void {
  const cells = nx * ny * nz;
  if (cells > MAX_CELLS) {
    fail(path, `the mesh would have ${nx} x ${ny} x ${nz} = ${(cells / 1e6).toFixed(0)}M cells, more than the ${MAX_CELLS / 1e6}M limit; use larger cells`);
  }
}

/** Sample points within this distance of a polygon edge count as inside (same slack as voxelize's onBoard). */
const EDGE_TOLERANCE_MM = 1e-9;

function distanceToSegment(x: number, y: number, [x0, y0]: Vec2, [x1, y1]: Vec2): number {
  const ux = x1 - x0;
  const uy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * ux + (y - y0) * uy) / (ux * ux + uy * uy)));
  return Math.hypot(x - (x0 + t * ux), y - (y0 + t * uy));
}

type Where = 'inside' | 'edge' | 'outside';

/** Point in polygon (crossing number; any simple polygon), with points within EDGE_TOLERANCE_MM of an edge reported as 'edge'. */
export function locateInPolygon(polygon: Vec2[], x: number, y: number): Where {
  let inside = false;
  for (let n = 0, prev = polygon.length - 1; n < polygon.length; prev = n++) {
    const a = polygon[prev];
    const b = polygon[n];
    if (distanceToSegment(x, y, a, b) <= EDGE_TOLERANCE_MM) return 'edge';
    if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

/**
 * Copper at (x, y) after painting the shapes in order. An add covers its
 * edges. A cut removes what is strictly inside it, and the part of its rim
 * that lies on the rim of an earlier add: a 2 mm slot on 1 mm cells leaves
 * the copper on its rim, while a notch or chamfer drawn from the outline of
 * a patch opens that outline instead of leaving a copper edge across it.
 * (The legacy isTopCopper cuts its edges too; see tests/project_regression.test.ts.)
 */
export function paint(shapes: ResolvedShape[], x: number, y: number): boolean {
  let copper = false;
  let onAddRim = false;
  for (const s of shapes) {
    const where = locateInPolygon(s.polygon, x, y);
    if (s.op === 'add') {
      if (where !== 'outside') copper = true;
      if (where === 'edge') onAddRim = true;
    } else if (where === 'inside' || (where === 'edge' && onAddRim)) {
      copper = false;
    }
  }
  return copper;
}

/** A covered fraction strictly between none and all of an edge (conformal copper). */
const isPartial = (fraction: number) => fraction > COVERAGE_SNAP && fraction < 1 - COVERAGE_SNAP;

/** Coordinate of fractional node index f (i or i + 1/2) on one axis. */
function positionOf(lines: Float64Array, f: number): number {
  const i = Math.floor(f);
  return f === i ? lines[i] : lines[i] + (f - i) * cellWidth(lines, i);
}

/** Index of the mesh line nearest `value` (ties go to the higher index, like Math.round). */
function nearestLine(lines: Float64Array, value: number): number {
  let best = 0;
  for (let i = 1; i < lines.length; i++) if (Math.abs(lines[i] - value) <= Math.abs(lines[best] - value)) best = i;
  return best;
}

/** `cells` cells of `widthMm` below the first line and above the last: the PML slabs. */
function padUniform(lines: Float64Array, low: number, high: number): Float64Array {
  const below = lines[1] - lines[0];
  const above = lines.at(-1)! - lines.at(-2)!;
  return Float64Array.from([
    ...Array.from({ length: low }, (_, n) => lines[0] - (low - n) * below),
    ...lines,
    ...Array.from({ length: high }, (_, n) => lines.at(-1)! + (n + 1) * above),
  ]);
}

/** Mesh lines inside copper edges are not round numbers; warnings show them to the micrometre. */
const roundMicron = (mm: number) => Math.round(mm * 1000) / 1000;

/** Coordinates along `axis` of a polygon's extent and of its edges perpendicular to that axis. */
function edgeCoordinates(polygon: Vec2[], axis: 0 | 1): number[] {
  const values = polygon.map((p) => p[axis]);
  const out = [Math.min(...values), Math.max(...values)];
  for (let n = 0, prev = polygon.length - 1; n < polygon.length; prev = n++) {
    if (Math.abs(values[n] - values[prev]) <= EDGE_TOLERANCE_MM) out.push(values[n]);
  }
  return out;
}

/**
 * Z cells either side of a copper layer, in edge cells, between which the
 * sheet-edge offset is used. The half-plane solve on the mesher's grid is
 * within 0.003 cell of a three times larger one across this range (0.254
 * against 0.257 at 0.25). Below it the layer's z cells are much finer than
 * edge_cell (dielectric_cells on a thin layer); above it they are so tall
 * that the grid is better refined than corrected. Edges left uncorrected are
 * named in a warning.
 */
const EDGE_OFFSET_CELL_RATIO: [min: number, max: number] = [0.25, 2];
/** Points along a copper edge segment probed for which side the copper is on. */
const EDGE_SAMPLES = 9;
/**
 * A corrected edge needs this many edge cells clear of other lines outside
 * the copper, so the cell just outside its line is about edge_cell.
 */
const MOVED_EDGE_CLEARANCE_CELLS = 1.5;
/**
 * The cell just outside a corrected edge's line, in edge cells, that the
 * offset is used with. The offset is solved for that cell (gradedBoardAxis),
 * so the range only keeps out cells far from edge_cell: below it a short gap
 * or narrow strip, above it a cell the grading let grow. The bounds are a
 * judgement, not a derivation: 0.5 is the half edge cell that already counts
 * as crowding inside the copper, and 1.2 keeps the cell under one growth step
 * (max_growth is 1.3 in every graded example) of edge_cell.
 */
const OUTSIDE_CELL_RANGE: [min: number, max: number] = [0.5, 1.2];
/**
 * Cells stay at most edge_cell (uniform) around a corrected copper edge line,
 * along the board and in z at its copper layer, for the layer's distance to
 * the nearest other copper layer (the region where the field is the edge's
 * own), but for no more than SHEET_EDGE_OFFSET_RING_CELLS (20) edge cells.
 * The offset is the one of a uniform lattice: cells that grow from the first
 * one move it, which leaves a first-order Z0 error. scripts/lab/edge_hold_2d.ts
 * shows this on the stripline's discrete cross-section (the FDTD's own static
 * problem), Z0 error against Cohn's exact value at edge cell / 1 to / 16:
 *   growth at the edge     -1.44 -0.98 -0.58 -0.33 -0.19 %
 *   hold b/2 (distance)    -0.26 -0.12 -0.08 -0.07 -0.07 %
 *   min(20 cells, b/2)     -0.26 -0.12 -0.11 -0.11 -0.10 %
 * The 20-cell bound is a cost choice, not physics: it is the radius of the
 * ring the offset is measured on (yee_edge.ts, at z cells of one edge cell or
 * more; less below that), so it adds no length unit of its own, and it keeps
 * a fine edge cell from holding uniform cells across a whole thick board. It
 * costs about 0.03 % of Z0 against the distance alone once the distance
 * passes 20 cells, and leaves a floor near 0.1 % that refining removes only
 * slowly.
 */
function sheetEdgeHoldMm(copperZ: Map<string, number>, layer: string, edgeCellMm: number, stackMm: number): number {
  const z = copperZ.get(layer)!;
  const others = [...copperZ].filter(([name]) => name !== layer).map(([, v]) => Math.abs(v - z));
  const distance = others.length > 0 ? Math.min(...others) : stackMm;
  return Math.min(SHEET_EDGE_OFFSET_RING_CELLS * edgeCellMm, distance);
}
/**
 * How closely, in edge cells, a corrected line is settled on the offset for
 * the cell beside it. Under the offset's own accuracy over most of its range
 * (SHEET_EDGE_OFFSET_ACCURACY_CELLS in yee_edge.ts), so settling adds little
 * to it, and above the small steps (about 2e-4 cell) the offset takes where a
 * node enters or leaves its measuring ring, where a tighter tolerance has no
 * fixed point: the line would flip between two places.
 */
export const EDGE_LINE_SETTLE_CELLS = 1e-3;
/**
 * Passes of gradedBoardAxis that re-solve the offsets for the cells beside
 * the corrected lines before the final per-line settle. They only bring the
 * lines close; the settle decides where each ends (and throws if it cannot),
 * so this bounds the work, not the answer's accuracy. Two or three passes
 * usually suffice.
 */
const LOCAL_CELL_PASSES = 12;

/** One copper edge perpendicular to an axis: its position, its span across, and the side its copper is on. */
interface CopperEdge { at: number; from: number; to: number; inward: -1 | 1 | null; shiftMm: number; layer: string; why: string | null; onRim: boolean }

/**
 * Mesh line positions for the copper edges along one axis of a graded mesh.
 *
 * A zero-thickness sheet's edge acts on the Yee grid some way past its last
 * copper node: 0.3535 cells when the z cells either side are as wide as the
 * cell along it, more for taller cells (sheetEdgeOffsetCells, from a discrete
 * half-plane solve in src/engine/yee_edge.ts). A strip drawn with its edges
 * on mesh lines therefore acts about 0.7 cell wider than drawn, which reads
 * as a first-order low Z0.
 *
 * An edge that can be corrected gets its line that offset inside the copper,
 * computed for the layer's z cells, so the grid's edge acts where the edge is
 * drawn. Two things the offset leaves out, each worth up to about 0.03 cell:
 * it assumes the cell just outside the line is edge_cell (gradedBoardAxis
 * keeps it within OUTSIDE_CELL_RANGE, or the edge keeps its drawn line), and it
 * solves the magnetic problem, which is the electric one only when the z
 * cells either side are equal (substrate below and air above differ). Every other edge keeps its line where it is drawn. An edge is
 * not corrected when:
 *  - it lies on the board outline (a ground plane's rim);
 *  - the copper is on both sides of it, on different sides along it, or under
 *    two edge cells wide behind it;
 *  - its layer's z cells are outside EDGE_OFFSET_CELL_RATIO edge cells;
 *  - another edge, the board outline, a refinement, a component, or a port
 *    not on the edge lies outside the copper within MOVED_EDGE_CLEARANCE_CELLS
 *    edge cells of its position along the axis (a gap, a nearby trace or a
 *    port beside it would put a line inside the cell the offset assumes), or
 *    inside the copper within half an edge cell of the moved line (a sliver);
 *  - another edge at the same position is not corrected, faces the other way,
 *    or is on a layer with different z cells;
 *  - the copper is conformal, which places edges by coverage.
 * `keepDrawn` lists edge positions the caller found the grading cannot
 * serve (gradedBoardAxis). `followers` maps each port drawn on a corrected edge to that edge's line; the
 * port goes on the line (the copper ends there), not on the nearest line.
 */
function copperEdgeLines(
  r: ReturnType<typeof resolveProject>, axis: 0 | 1, edgeCellMm: number, edgeShiftMm: (layer: string, at: number) => number | undefined,
  obstacles: number[], ports: Vec2[], keepDrawn: number[] = [],
): { lines: number[]; followers: Map<number, number>; corrections: Array<{ at: number; line: number; inward: -1 | 1; layer: string }>; uncorrected: Array<{ at: number; why: string }> } {
  const probe = 1e-4 * edgeCellMm;
  const same = (u: number, v: number) => Math.abs(u - v) <= EDGE_TOLERANCE_MM;
  const plainLines: number[] = [];
  const edges: CopperEdge[] = [];
  for (const [layer, shapes] of Object.entries(r.copper)) {
    const copperAt = (along: number, across: number) => (axis === 0 ? paint(shapes, along, across) : paint(shapes, across, along));
    for (const shape of shapes) {
      const poly = shape.polygon;
      plainLines.push(...edgeCoordinates(poly, axis));
      for (let n = 0, prev = poly.length - 1; n < poly.length; prev = n++) {
        const at = poly[n][axis];
        if (!same(at, poly[prev][axis])) continue;
        const [from, to] = [poly[prev][1 - axis], poly[n][1 - axis]].sort((u, v) => u - v);
        // Sample along the segment: part of it may run inside other copper (a feed joining a patch).
        const inwards = new Set<-1 | 1>();
        let wide = true;
        for (let k = 0; k < EDGE_SAMPLES; k++) {
          const across = from + ((k + 0.5) / EDGE_SAMPLES) * (to - from);
          const [low, high] = [copperAt(at - probe, across), copperAt(at + probe, across)];
          if (low === high) continue;
          const inward = low ? -1 : 1;
          inwards.add(inward);
          wide &&= copperAt(at + inward * 2 * edgeCellMm * (1 - 1e-6), across);
        }
        // An edge with copper on both sides all along (a feed's end inside a patch) is not a copper edge.
        if (inwards.size === 0) continue;
        const shiftMm = edgeShiftMm(layer, at);
        const correctable = !r.conformal && shiftMm !== undefined && inwards.size === 1 && wide;
        // The board's own rim (a ground plane to the outline): no field outside it to correct for.
        const middle = (from + to) / 2;
        const beyond = at - [...inwards][0] * probe;
        const onRim = inwards.size === 1 && locateInPolygon(r.boardOutline, axis === 0 ? beyond : middle, axis === 0 ? middle : beyond) === 'outside';
        // Every other edge that keeps its drawn line reads its lines' Z0 low: say why.
        const why = r.conformal || onRim || correctable ? null
          : inwards.size === 2 ? 'the copper changes side along it'
            : !wide ? 'the copper is under two edge cells wide (the offset needs a uniform lattice across it)'
              : `the z cells at layer "${layer}" are outside ${EDGE_OFFSET_CELL_RATIO.join(' to ')} of the cell beside the edge`;
        edges.push({ at, from, to, inward: correctable && !onRim ? [...inwards][0] : null, shiftMm: shiftMm ?? 0, layer, why, onRim });
      }
    }
  }
  const clearance = MOVED_EDGE_CLEARANCE_CELLS * edgeCellMm;
  const onEdge = (port: Vec2, e: CopperEdge) => same(port[axis], e.at) && port[1 - axis] >= e.from - EDGE_TOLERANCE_MM && port[1 - axis] <= e.to + EDGE_TOLERANCE_MM;
  const lines: number[] = [];
  const followers = new Map<number, number>();
  const corrected = new Set<number>();
  const corrections: Array<{ at: number; line: number; inward: -1 | 1; layer: string }> = [];
  const uncorrected: Array<{ at: number; why: string }> = [];
  for (const e of edges) {
    if (e.why) uncorrected.push({ at: e.at, why: e.why });
    if (e.inward === null || [...corrected].some((c) => same(c, e.at))) continue;
    if (keepDrawn.some((c) => same(c, e.at))) {
      uncorrected.push({ at: e.at, why: `the grading cannot keep the cell outside it within ${OUTSIDE_CELL_RANGE.join(' to ')} edge cells` });
      continue;
    }
    const others = [
      ...obstacles, ...plainLines.filter((v) => !same(v, e.at)),
      ...ports.filter((port) => !edges.some((f) => same(f.at, e.at) && onEdge(port, f))).map((port) => port[axis]),
    ];
    const atSamePlace = edges.filter((f) => same(f.at, e.at));
    const copperLine = e.at + e.inward * e.shiftMm;
    // Outside the copper the offset needs a clear cell of about edge_cell; inside, a cell over half
    // of edge_cell moves it by under 0.01 cell (yee_edge.ts), so only a sliver blocks it there.
    const crowds = (v: number) => ((v - e.at) * e.inward! > EDGE_TOLERANCE_MM
      ? Math.abs(v - copperLine) < edgeCellMm / 2
      : Math.abs(v - e.at) < clearance);
    // Edges at one place with copper on the other side, or on layers with different z cells, would want different lines.
    const conflict = atSamePlace.find((f) => f.inward !== e.inward || f.shiftMm !== e.shiftMm);
    if (conflict) {
      uncorrected.push({ at: e.at, why: conflict.inward === null ? `another copper edge at the same place${conflict.layer === e.layer ? '' : ` (layer "${conflict.layer}")`} keeps its drawn line`
        : conflict.layer === e.layer ? 'copper on its other side at the same place needs a line on that side'
          : `copper on layer "${conflict.layer}" at the same place needs a different line` });
      continue;
    }
    const crowding = others.find(crowds);
    if (crowding !== undefined) {
      uncorrected.push({ at: e.at, why: `another line (${roundMicron(crowding)} mm) is within ${MOVED_EDGE_CLEARANCE_CELLS} edge cells outside it or half an edge cell inside` });
      continue;
    }
    corrected.add(e.at);
    lines.push(copperLine);
    corrections.push({ at: e.at, line: copperLine, inward: e.inward, layer: e.layer });
    ports.forEach((port, n) => { if (atSamePlace.some((f) => onEdge(port, f))) followers.set(n, copperLine); });
  }
  const isCorrected = (v: number) => [...corrected].some((c) => same(c, v));
  return { lines: [...lines, ...plainLines.filter((v) => !isCorrected(v))], followers, corrections, uncorrected };
}

interface AxisLayout {
  /** Node coordinates in mm, PML included. */
  lines: Float64Array;
  /** Index of the line at the low end of the board (x, y) or the bottom of the stackup (z). */
  origin: number;
  /** Ports drawn on a corrected copper edge along this axis (graded x and y), by index, to the edge's line: they sit on it, not where drawn. */
  portsOnCorrectedEdges?: Map<number, number>;
}

/**
 * `fixed` (sorted, kept exactly) with the extra refinement lines added. An
 * extra line closer than mergeMm to a line already kept is dropped with a
 * warning, as copper edges are merged, so it cannot make a sliver cell.
 * Extra lines must lie strictly inside the box (outside the PML).
 */
function withExtraLines(fixed: number[], extra: Refinement[], mergeMm: number, name: string, warnings: string[]): number[] {
  const [lo, hi] = [fixed[0], fixed.at(-1)!];
  const lines = [...fixed];
  for (const { at } of [...extra].sort((a, b) => a.at - b.at)) {
    if (!(at > lo && at < hi)) throw new Error(`mesh refinement ${name} = ${at} mm is outside the box (${lo} to ${hi} mm, PML excluded)`);
    // Merge into the project's own lines only: a lattice of extras may be finer than edge_cell / 4.
    const near = fixed.find((v) => Math.abs(v - at) <= mergeMm);
    if (near === undefined) lines.push(at);
    else if (near !== at) warnings.push(`mesh: refinement ${name} = ${at} mm merged into the line at ${roundMicron(near)} mm (closer than edge_cell / 4)`);
  }
  return lines.sort((a, b) => a - b);
}

/**
 * Graded lines in x or y: fixed lines on the board outline, every copper edge
 * along the axis and every port, refined to edgeCell at each and growing to
 * cell across the board and the air margin.
 */
function gradedBoardAxis(
  r: ReturnType<typeof resolveProject>, axis: 0 | 1, marginMm: [low: number, high: number], pml: [number, number], extra: Refinement[],
  layerZCells: Map<string, [below: number, above: number]>, layerHoldMm: Map<string, number>, warnings: string[],
): AxisLayout {
  const g = r.graded!;
  const [lo, hi] = [Math.min(...r.boardOutline.map((p) => p[axis])), Math.max(...r.boardOutline.map((p) => p[axis]))];
  const boardCoords = edgeCoordinates(r.boardOutline, axis);
  const componentPoints: number[] = [];
  for (const { place } of r.components) {
    if (place.kind === 'between') componentPoints.push(axis === 0 ? place.xMm : place.yMm);
    else if (place.axis === axis) componentPoints.push(place.fromMm, place.toMm);
    else componentPoints.push(place.acrossMm, ...(place.widthMm === null ? [] : [place.acrossMm - place.widthMm / 2, place.acrossMm + place.widthMm / 2]));
  }
  for (const via of r.vias) componentPoints.push(...viaLines(via, axis, g.edgeCellMm));
  const ports: Vec2[] = r.ports.map((port) => [port.xMm, port.yMm]);
  const obstacles = [...boardCoords, ...componentPoints, ...extra.map((e) => e.at)];
  const name = 'xy'[axis];
  /**
   * The offset is in cells of the uniform lattice around the edge. The cell
   * beside a corrected line is edge_cell unless the grading made it smaller
   * (a short interval inside the copper cut into whole cells), so each pass
   * solves the offset for the cell the previous pass gave there.
   */
  const shiftFor = (localCell: Map<number, number>) => (layer: string, at: number) => {
    const z = layerZCells.get(layer);
    if (!z) return undefined;
    const cell = localCell.get(at) ?? g.edgeCellMm;
    const [below, above] = [z[0] / cell, z[1] / cell];
    const [min, max] = EDGE_OFFSET_CELL_RATIO;
    return below >= min && below <= max && above >= min && above <= max ? sheetEdgeOffsetCells(below, above) * cell : undefined;
  };
  const layout = (keepDrawn: number[], localCell: Map<number, number>) => {
    const passWarnings: string[] = [];
    const copperLines = copperEdgeLines(r, axis, g.edgeCellMm, shiftFor(localCell), obstacles, ports, keepDrawn);
    // A port drawn on a corrected copper edge goes on that edge's line (rasterise places it there).
    const portLines = ports.filter((_, n) => !copperLines.followers.has(n)).map((port) => port[axis]);
    const candidates = [...boardCoords, ...componentPoints, ...portLines, ...copperLines.lines];
    const inside = candidates.filter((v) => v >= lo - EDGE_TOLERANCE_MM && v <= hi + EDGE_TOLERANCE_MM).map((v) => Math.min(hi, Math.max(lo, v)));
    // The board's ends stay exact and ports stay on their copper; other close lines merge to their middle.
    const portAt = [...portLines, ...copperLines.followers.values()];
    const { lines: fixed, merged } = mergeFixedLines(inside, g.edgeCellMm / 4, { pinned: [lo, hi], preferred: portAt });
    for (const [line, moved] of merged) {
      passWarnings.push(`mesh: ${name} = ${roundMicron(moved)} mm merged into the line at ${roundMicron(line)} mm (closer than edge_cell / 4)`);
    }
    const ends = withExtraLines([lo - marginMm[0], ...fixed, hi + marginMm[1]], extra, g.edgeCellMm / 4, name, passWarnings);
    const intervals = ends.slice(1).map((end, n) => ({ start: ends[n], end, maxCellMm: r.cellMm }));
    const correctionsAt = (at: number) => copperLines.corrections.filter((c) => Math.abs(c.line - at) <= EDGE_TOLERANCE_MM);
    const refinements = [...fixed.map((at) => {
      const here = correctionsAt(at);
      return { at, cellMm: g.edgeCellMm, holdMm: Math.max(0, ...here.map((c) => layerHoldMm.get(c.layer)!)) };
    }), ...extra];
    const lines = gradedLines(intervals, { maxCellMm: r.cellMm, maxGrowth: g.maxGrowth }, refinements);
    // The cell just outside each corrected line. Outside OUTSIDE_CELL_RANGE (a short gap, a
    // narrow strip) the edge keeps its drawn line.
    const outsideCells = new Map<number, number>();
    const unserved = copperLines.corrections.filter(({ at, line, inward }) => {
      const k = lines.findIndex((v) => Math.abs(v - line) <= EDGE_TOLERANCE_MM);
      const outside = lines[k - inward];
      if (k < 0 || outside === undefined) return true;
      const cell = Math.abs(outside - line);
      outsideCells.set(at, cell);
      return cell < OUTSIDE_CELL_RANGE[0] * g.edgeCellMm || cell > OUTSIDE_CELL_RANGE[1] * g.edgeCellMm;
    }).map(({ at }) => at);
    return { lines, followers: copperLines.followers, corrections: copperLines.corrections, unserved, passWarnings, uncorrected: copperLines.uncorrected, outsideCells };
  };
  const keepDrawn: number[] = [];
  let localCell = new Map<number, number>();
  let pass = layout(keepDrawn, localCell);
  // Each pass either drops a correction or updates the cells the offsets are solved for. The cells
  // usually settle in two or three passes, but moving a line can add or drop a whole cell in a
  // neighbouring interval, which flips the cell between two values (0.250 / 0.223 mm at a 2 mm
  // strip); the last step below settles those.
  for (let n = 0; n < LOCAL_CELL_PASSES; n++) {
    if (pass.unserved.length > 0) keepDrawn.push(...pass.unserved);
    else if ([...pass.outsideCells].every(([at, cell]) => Math.abs(cell - (localCell.get(at) ?? g.edgeCellMm)) <= EDGE_LINE_SETTLE_CELLS * g.edgeCellMm)) break;
    else localCell = pass.outsideCells;
    pass = layout(keepDrawn, localCell);
  }
  // Each of these passes drops at least one correction, so this ends.
  while (pass.unserved.length > 0) {
    keepDrawn.push(...pass.unserved);
    pass = layout(keepDrawn, localCell);
  }
  // Settle each corrected line on the cell actually outside it, moving only that line. The offset
  // is about a third of the cell and the cell changes by what the line moves, so each step shrinks
  // the change about threefold, to EDGE_LINE_SETTLE_CELLS in a few steps.
  const lines = pass.lines;
  const followers = new Map(pass.followers);
  const unsettled: number[] = [];
  for (const { at, line, inward, layer } of pass.corrections) {
    const k = lines.findIndex((v) => Math.abs(v - line) <= EDGE_TOLERANCE_MM);
    for (let step = 0; ; step++) {
      if (step === 60) throw new Error(`mesh: the line for the copper edge at ${name} = ${roundMicron(at)} mm does not settle on its cell`);
      const shift = shiftFor(new Map([[at, Math.abs(lines[k - inward] - lines[k])]]))(layer, at);
      if (shift === undefined) { unsettled.push(at); break; }
      const moved = at + inward * shift;
      const done = Math.abs(moved - lines[k]) <= EDGE_LINE_SETTLE_CELLS * g.edgeCellMm;
      lines[k] = moved;
      if (done) break;
    }
    for (const [port, followed] of followers) if (Math.abs(followed - line) <= EDGE_TOLERANCE_MM) followers.set(port, lines[k]);
  }
  warnings.push(...pass.passWarnings);
  // Every copper edge left on its drawn line is named (the board's rim is not a copper edge to correct).
  const named = new Map<number, string>();
  for (const { at, why } of pass.uncorrected) if (!named.has(at)) named.set(at, why);
  for (const at of unsettled) named.set(at, `its line is at the offset for a nearby cell: the z cells are outside ${EDGE_OFFSET_CELL_RATIO.join(' to ')} of the cell beside it`);
  if (named.size > 0) {
    warnings.push(`mesh: ${named.size} copper edge(s) along ${name} keep their drawn line, so the grid acts about 0.35 edge cell wider there and lines through them read Z0 low ` +
      `(a first-order error that refining shrinks only slowly): ${[...named].map(([at, why]) => `${name} = ${roundMicron(at)} mm (${why})`).join('; ')}`);
  }
  return { lines: padUniform(lines, pml[0], pml[1]), origin: pml[0] + nearestLine(lines, lo), portsOnCorrectedEdges: followers };
}

export function rasterise(project: Project, options: RasteriseOptions = {}): Rasterised {
  const r = resolveProject(project);
  const extra = { x: [...options.refinements?.x ?? []], y: [...options.refinements?.y ?? []], z: [...options.refinements?.z ?? []] };
  if (!r.graded && extra.x.length + extra.y.length + extra.z.length > 0) {
    fail('$.mesh', 'mesh refinements need a graded mesh (mesh.graded)');
  }
  const warnings: string[] = [];
  const dx = r.cellMm;
  const pmlCells = (face: Face) => {
    const b = r.boundaries[face];
    return b.type === 'pml' ? b.cells : 0;
  };
  const faces: PmlFaces = {
    xLow: pmlCells('x_min'), xHigh: pmlCells('x_max'),
    yLow: pmlCells('y_min'), yHigh: pmlCells('y_max'),
    zLow: pmlCells('z_min'), zHigh: pmlCells('z_max'),
  };
  const margin = r.airMarginCells;
  const xs = r.boardOutline.map((p) => p[0]);
  const ys = r.boardOutline.map((p) => p[1]);
  const [minX, minY] = [Math.min(...xs), Math.min(...ys)];

  // --- z: interfaces bottom up, z = 0 at the bottom of the stackup. Copper layers sit on the planes between dielectrics.
  const interfaces: number[] = [0];
  const copperZ = new Map<string, number>();
  const dielectrics: Array<{ z0: number; z1: number; epsR: number; tanDelta: number; name: string; responses: MaterialResponses; materialPath: string }> = [];
  for (const layer of r.stackup) {
    const z = interfaces.at(-1)!;
    if (layer.type === 'copper') {
      copperZ.set(layer.name, z);
      continue;
    }
    let thickness = layer.thicknessMm;
    if (!r.graded) {
      // Uniform mesh: whole cells per dielectric layer.
      const cells = Math.round(layer.thicknessMm / dx);
      if (cells < 1) fail(layer.path, `${layer.thicknessMm} mm is less than half a cell (${dx} mm); refine the mesh`);
      if (Math.abs(cells * dx - layer.thicknessMm) > 1e-9) {
        warnings.push(`layer "${layer.name}": ${layer.thicknessMm} mm snapped to ${cells} cells (${cells * dx} mm)`);
      }
      thickness = cells * dx;
    }
    dielectrics.push({ z0: z, z1: z + thickness, epsR: layer.epsR, tanDelta: layer.tanDelta, name: layer.name, responses: layer.responses, materialPath: layer.materialPath });
    interfaces.push(z + thickness);
  }
  const stackTop = interfaces.at(-1)!;
  const connector = coaxConnectors(r, copperZ, dx, faces, extra);
  // Air in mm on each side of the board and stackup. Where the connector's mesh
  // lines reach past the board, that side's air ends where the mesh grading
  // fits a whole number of cells past the outermost line (wholeCellGap), and at
  // least one coarse cell and the margin past it.
  const sideAir = (marginMm: number, lines: Refinement[] | undefined, lo: number, hi: number): [number, number] => {
    const side = (outermost: Refinement, reach: number) =>
      reach <= 0 ? marginMm : reach + wholeCellGap(outermost.cellMm, dx, r.graded!.maxGrowth - 1, Math.max(dx, marginMm - reach));
    if (!lines?.length) return [marginMm, marginMm];
    const first = lines.reduce((a, b) => (b.at < a.at ? b : a));
    const last = lines.reduce((a, b) => (b.at > a.at ? b : a));
    return [side(first, lo - first.at), side(last, last.at - hi)];
  };
  const xyAirMm = margin.xy * dx;
  const xAir = sideAir(xyAirMm, connector.lines[0], minX, Math.max(...xs));
  const yAir = sideAir(xyAirMm, connector.lines[1], minY, Math.max(...ys));
  const [below] = sideAir(margin.below * dx, connector.lines[2], 0, stackTop);
  const [, above] = sideAir(margin.above * dx, connector.lines[2], 0, stackTop);

  let xAxis: AxisLayout;
  let yAxis: AxisLayout;
  let zAxis: AxisLayout;
  if (r.graded) {
    const g = r.graded;
    const ends = withExtraLines([-below, ...interfaces, stackTop + above], extra.z, g.edgeCellMm / 4, 'z', warnings);
    const intervals = ends.slice(1).map((end, n) => {
      // An extra line may split a dielectric layer; each part keeps the layer's cell limit.
      const d = dielectrics.find((layer) => layer.z0 <= ends[n] && end <= layer.z1);
      return { start: ends[n], end, maxCellMm: d ? (d.z1 - d.z0) / g.dielectricCells : dx };
    });
    // Uniform z cells at each copper layer with an edge to correct, for the sheet-edge offset
    // (sheetEdgeHoldMm). A layer whose copper ends only at the board's rim (a ground plane) needs none.
    const ports: Vec2[] = r.ports.map((port) => [port.xMm, port.yMm]);
    const withEdges = new Set(([0, 1] as const).flatMap((axis) =>
      copperEdgeLines(r, axis, g.edgeCellMm, () => 0, edgeCoordinates(r.boardOutline, axis), ports).corrections.map((c) => c.layer)));
    const layerHoldMm = new Map([...copperZ.keys()].map((name) => [name, withEdges.has(name) ? sheetEdgeHoldMm(copperZ, name, g.edgeCellMm, stackTop) : 0]));
    const refinements = [...[...copperZ].map(([name, at]) => ({ at, cellMm: g.edgeCellMm, holdMm: layerHoldMm.get(name)! })), ...extra.z];
    const zLines = gradedLines(intervals, { maxCellMm: dx, maxGrowth: g.maxGrowth }, refinements);
    zAxis = { lines: padUniform(zLines, faces.zLow, faces.zHigh), origin: faces.zLow + nearestLine(zLines, 0) };
    // The z cells either side of each copper layer, for its sheet-edge offset (gradedBoardAxis).
    const layerZCells = new Map<string, [number, number]>();
    for (const [name, z] of copperZ) {
      const k = nearestLine(zLines, z);
      layerZCells.set(name, [zLines[k] - zLines[k - 1], zLines[k + 1] - zLines[k]]);
    }
    xAxis = gradedBoardAxis(r, 0, xAir, [faces.xLow, faces.xHigh], extra.x, layerZCells, layerHoldMm, warnings);
    yAxis = gradedBoardAxis(r, 1, yAir, [faces.yLow, faces.yHigh], extra.y, layerZCells, layerHoldMm, warnings);
  } else {
    // Uniform: the board's bounding box starts on node i0 (j0); the stackup on node groundK.
    const i0 = faces.xLow + margin.xy;
    const j0 = faces.yLow + margin.xy;
    const nx = i0 + Math.ceil((Math.max(...xs) - minX) / dx - 1e-9) + margin.xy + faces.xHigh;
    const ny = j0 + Math.ceil((Math.max(...ys) - minY) / dx - 1e-9) + margin.xy + faces.yHigh;
    const groundK = faces.zLow + margin.below;
    const nz = groundK + Math.round(stackTop / dx) + margin.above + faces.zHigh;
    assertCellCount(nx, ny, nz, '$.mesh.cell');
    xAxis = { lines: uniformLines(nx, minX - i0 * dx, dx), origin: i0 };
    yAxis = { lines: uniformLines(ny, minY - j0 * dx, dx), origin: j0 };
    zAxis = { lines: uniformLines(nz, -groundK * dx, dx), origin: groundK };
  }
  const mesh: MeshLines = { x: xAxis.lines, y: yAxis.lines, z: zAxis.lines };
  const [nx, ny, nz] = [mesh.x.length, mesh.y.length, mesh.z.length];
  assertCellCount(nx, ny, nz, r.graded ? '$.mesh.graded' : '$.mesh.cell');
  const zIndex = (z: number) => nearestLine(mesh.z, z);
  const copperK = new Map([...copperZ].map(([name, z]) => [name, zIndex(z)]));
  const groundK = zAxis.origin;
  const xOf = (fi: number) => positionOf(mesh.x, fi);
  const yOf = (fj: number) => positionOf(mesh.y, fj);

  // --- 2D masks at the Yee positions of one z plane: Ex (i+1/2, j), Ey (i, j+1/2), Ez (i, j), cell centres.
  const sample = (fi: number, fj: number, inside: (x: number, y: number) => boolean) => {
    const mask = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) mask[i + nx * j] = inside(xOf(i + fi), yOf(j + fj)) ? 1 : 0;
    return mask;
  };
  const onBoard = (x: number, y: number) => locateInPolygon(r.boardOutline, x, y) !== 'outside';
  const boardEx = sample(0.5, 0, onBoard);
  const boardEy = sample(0, 0.5, onBoard);
  const boardEz = sample(0, 0, onBoard);
  type EdgeMasks = { ex: Uint8Array; ey: Uint8Array };
  const copperPlanes = new Map<number, EdgeMasks & { name: string; whole: EdgeMasks; touched: EdgeMasks; conductivity: number | null; roughness: Roughness | null; thicknessMm: number; cover: PlaneCoverage | null }>();
  for (const [name, planeK] of copperK) {
    const shapes = r.copper[name];
    const ex = sample(0.5, 0, (x, y) => paint(shapes, x, y));
    const ey = sample(0, 0.5, (x, y) => paint(shapes, x, y));
    // Conformal: the covered fraction of each edge and face sets the materials; the midpoint masks still serve the port checks and warnings.
    const cover = r.conformal
      ? planeCoverage(mesh.x, mesh.y, [r.boardOutline, ...shapes.map((s) => s.polygon)].flatMap(polygonSegments), (x, y) => onBoard(x, y) && paint(shapes, x, y))
      : null;
    // Copper exists only on the board, as in voxelize.
    let clipped = 0;
    for (let c = 0; c < nx * ny; c++) {
      clipped += (ex[c] & ~boardEx[c]) + (ey[c] & ~boardEy[c]);
      ex[c] &= boardEx[c];
      ey[c] &= boardEy[c];
    }
    if (clipped > 0) warnings.push(`layer "${name}": copper outside the board outline is ignored (${clipped} edges)`);
    const layer = r.stackup.find((l) => l.name === name);
    // Edges that are copper for the checks of ports and components: `whole` wholly covered (PEC), `touched` with any copper on them.
    // The same thresholds as the edge materials (tangential): PEC from 1 - SNAP up, partly covered above SNAP.
    const mask = (fraction: Float64Array, test: (f: number) => boolean) => Uint8Array.from(fraction, (f) => (test(f) ? 1 : 0));
    const isWhole = (f: number) => f >= 1 - COVERAGE_SNAP;
    const isTouched = (f: number) => f > COVERAGE_SNAP;
    const whole = cover ? { ex: mask(cover.ex, isWhole), ey: mask(cover.ey, isWhole) } : { ex, ey };
    const touched = cover ? { ex: mask(cover.ex, isTouched), ey: mask(cover.ey, isTouched) } : { ex, ey };
    copperPlanes.set(planeK, { name, ex, ey, whole, touched, conductivity: layer?.type === 'copper' ? layer.conductivitySPerM : null, roughness: layer?.type === 'copper' ? layer.roughness : null, thicknessMm: layer?.type === 'copper' ? layer.thicknessMm : DEFAULT_COPPER_THICKNESS_MM, cover });
  }

  const partlyCovered = [...copperPlanes.values()].some(({ cover }) => cover?.ex.some(isPartial) || cover?.ey.some(isPartial));
  const grid: GridConfig = {
    nx, ny, nz,
    // The time step and the normalised units follow the smallest cell (mesh.ts).
    dxMm: r.graded ? smallestCell(mesh) : dx,
    // Copper that partly covers cells runs below the 3D limit, leaving stability slack for its cut faces (conformal.ts).
    courant: partlyCovered ? CONFORMAL_COURANT : DEFAULT_GRID.courant,
    // Thickest PML face: sizes the GPU psi buffers. The per-face thickness is model.cpml.faces.
    pmlCells: Math.max(...Object.values(faces)),
    groundK,
    stepsPerRun: project.analysis.stop.max_steps,
  };
  assertStableGrid(grid, faces);
  if (r.graded && grid.dxMm < 0.8 * r.graded.edgeCellMm) {
    // The time step follows the smallest cell, so one close pair of lines slows the whole run.
    warnings.push(`mesh: smallest cell ${grid.dxMm.toPrecision(3)} mm is below edge_cell (${r.graded.edgeCellMm} mm) and sets the time step; ` +
      'look for copper edges, the port or layer interfaces closer together than edge_cell. Copper edge lines sit about a third of edge_cell inside ' +
      'the drawn edge, so gaps between lines are rarely whole cells and the grading may shrink cells near them');
  }
  // A cell this small next to the wavelength is almost always a typo (0.0001 mm for 0.1 mm), and it sets the time step for the whole run.
  const wavelengthMm = 299_792_458e3 / (project.analysis.f_max_ghz * 1e9);
  if (grid.dxMm < wavelengthMm / MAX_WAVELENGTH_OVER_CELL) {
    const stepsPerPeriod = 1 / (timestepSec(grid) * project.analysis.f_min_ghz * 1e9);
    warnings.push(`mesh: smallest cell ${grid.dxMm.toPrecision(3)} mm is under 1/${MAX_WAVELENGTH_OVER_CELL} of the wavelength at f_max ` +
      `(${wavelengthMm.toPrecision(3)} mm); one period at f_min takes ${stepsPerPeriod.toPrecision(3)} steps. Check the cell sizes for a typo`);
  }
  const Sc = grid.courant;
  const N = nx * ny * nz;
  const cpml = buildCpml(grid, faces, DEFAULT_CPML_GRADING, mesh);

  // --- Materials per cell slab k (between planes k and k+1) on the board; air elsewhere.
  const dtSec = timestepSec(grid);
  const slabEps = new Float64Array(nz).fill(1);
  const slabSigma = new Float64Array(nz);
  // Frequency-dependent and magnetic slabs (dispersion.ts): their response per slab, null for the plain cases.
  const slabEpsResponse: Array<MediumResponse | null> = new Array(nz).fill(null);
  const slabMuResponse: Array<MediumResponse | null> = new Array(nz).fill(null);
  for (const d of dielectrics) {
    const fRef = project.analysis.loss_reference_ghz * 1e9;
    let eps = d.epsR;
    let sigma = lossTangentSigmaDtOverEps0(d.epsR, d.tanDelta, fRef, dtSec);
    if (d.responses.permittivity) {
      // The single-frequency stand-in in eDecay/eCurl: the material at the loss reference.
      const [re, im] = relativeValue(d.responses.permittivity, fRef);
      // The stand-in feeds the port and the coax mix as a plain dielectric, which needs eps' >= 1.
      if (!(re >= 1)) {
        fail(d.materialPath, `εr′ is ${re.toPrecision(4)} at loss_reference_ghz (${project.analysis.loss_reference_ghz} GHz), just above a resonance; ` +
          'move loss_reference_ghz to where the material is an ordinary dielectric');
      }
      eps = re;
      sigma = -im * 2 * Math.PI * fRef * dtSec;
    }
    for (let kk = zIndex(d.z0); kk < zIndex(d.z1); kk++) {
      slabEps[kk] = eps;
      slabSigma[kk] = sigma;
      slabEpsResponse[kk] = d.responses.permittivity;
      slabMuResponse[kk] = d.responses.permeability;
    }
  }
  const air = dielectricEdge(Sc, 1, 0);
  const pec = { decay: 1, curl: 0 };
  // Ex/Ey on plane k: average of the half cells above and below, weighted by
  // their heights (slab k-1 below, slab k above; air outside the box).
  const planeAverage = (values: Float64Array, outside: number, kk: number) => {
    const below = kk > 0 ? values[kk - 1] : outside;
    const [wBelow, wAbove] = [cellWidth(mesh.z, Math.max(0, kk - 1)), cellWidth(mesh.z, kk)];
    // Equal heights keep the plain mean, so uniform meshes match voxelize.ts bit for bit.
    return Math.abs(wBelow - wAbove) <= 1e-9 * wAbove ? (below + values[kk]) / 2 : (below * wBelow + values[kk] * wAbove) / (wBelow + wAbove);
  };
  const boardTangential = Array.from({ length: nz }, (_, kk) =>
    dielectricEdge(Sc, planeAverage(slabEps, 1, kk), planeAverage(slabSigma, 0, kk)));
  // Copper edges are PEC; a finite conductivity adds a surface impedance on each face (ConductorSheets).
  const fRefHz = project.analysis.loss_reference_ghz * 1e9;
  const planeRsOhm = new Map([...copperPlanes].map(([kk, plane]) => [kk, plane.conductivity === null ? null : surfaceResistanceOhm(plane.conductivity, fRefHz)]));
  // The skin effect and roughness across the band (surface_impedance.ts): one fitted shape per conductor,
  // on corners shared by all of them. Rs above is smooth copper at the loss reference; the shape scales it.
  const fMinHz = project.analysis.f_min_ghz * 1e9;
  const fMaxHz = project.analysis.f_max_ghz * 1e9;
  const surfaceCorners = surfacePoles(fMinHz, fMaxHz);
  const surfaceShapes: SurfaceShape[] = [];
  const shapeKeys = new Map<string, number>();
  const planeShape = new Map<number, number>();
  for (const [kk, plane] of copperPlanes) {
    if (plane.conductivity === null) continue;
    // Rs assumes copper several skin depths thick; thinner copper loses more than the model says.
    const skinDepthMm = skinDepthM(plane.conductivity, fMinHz) * 1e3;
    if (plane.thicknessMm < 3 * skinDepthMm) warnings.push(`layer "${plane.name}": ${plane.thicknessMm} mm is under 3 skin depths (${skinDepthMm.toPrecision(2)} mm at ${project.analysis.f_min_ghz} GHz); its loss reads low`);
    const key = JSON.stringify([plane.conductivity, plane.roughness]);
    let shape = shapeKeys.get(key);
    if (shape === undefined) {
      const fit = fitSurfaceShape(plane.conductivity, plane.roughness, fMinHz, fMaxHz, fRefHz, surfaceCorners);
      if (fit.resistanceError > SURFACE_FIT_WARNING) {
        warnings.push(`layer "${plane.name}": its surface resistance across the band is fitted to ${(fit.resistanceError * 100).toPrecision(2)} %`);
      }
      shape = surfaceShapes.push(fit.shape) - 1;
      shapeKeys.set(key, shape);
    }
    planeShape.set(kk, shape);
  }
  const sheetEdges: number[] = [];
  const sheetRs: number[] = [];
  const sheetShape: number[] = [];
  /**
   * Rs of each sheet edge, times edgeLossFactor on the outermost edges along a
   * copper boundary: an Ex edge with no copper Ex next to it in y, an Ey edge
   * with none next to it in x (the current runs along the boundary there).
   * d is the mean of the two cells either side of the edge node. Coax feeds
   * cut their anti-pads after this (coax_feed.ts): sheetFaceLoss drops the
   * cut edges, and the anti-pad rim keeps the plain Rs.
   */
  const withEdgeLoss = (edges: number[], rs: number[]) => {
    const copper = new Set(edges);
    return edges.map((e, s) => {
      const along = e < N ? 0 : 1;
      const c = e - along * N;
      const [i, j, kk] = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
      const [node, count, stride, lines] = along === 0 ? [j, ny, nx, mesh.y] : [i, nx, 1, mesh.x];
      const openSides = [-1, 1].filter((d) => node + d < 0 || node + d >= count || !copper.has(e + d * stride)).length;
      if (openSides === 0) return rs[s];
      const factor = edgeLossFactor(dualWidth(lines, node), copperPlanes.get(kk)!.thicknessMm);
      return rs[s] * (1 + openSides * (factor - 1));
    });
  };
  const copperEdge = (kk: number, index: number) => {
    const rs = planeRsOhm.get(kk)!;
    if (rs !== null) {
      sheetEdges.push(index);
      sheetRs.push(rs);
      sheetShape.push(planeShape.get(kk)!);
    }
    return pec;
  };
  const boardNormal = Array.from({ length: nz }, (_, kk) => dielectricEdge(Sc, slabEps[kk], slabSigma[kk]));

  const eDecay = new Float32Array(3 * N);
  const eCurl = new Float32Array(3 * N);
  const setEdge = (index: number, edge: { decay: number; curl: number }) => {
    eDecay[index] = edge.decay;
    eCurl[index] = edge.curl;
  };
  const partialEdges: number[] = [];
  /** An Ex or Ey edge on plane kk: copper by the midpoint `mask`, or with `covered` (conformal) by its covered fraction. */
  const tangential = (kk: number, index: number, col: number, dielectric: { decay: number; curl: number }, mask?: Uint8Array, covered?: Float64Array) => {
    if (!covered) {
      setEdge(index, mask?.[col] ? copperEdge(kk, index) : dielectric);
      return;
    }
    const fraction = covered[col];
    if (fraction >= 1 - COVERAGE_SNAP) setEdge(index, copperEdge(kk, index));
    else if (fraction <= COVERAGE_SNAP) setEdge(index, dielectric);
    else {
      setEdge(index, { decay: dielectric.decay, curl: dielectric.curl * (1 - fraction) });
      partialEdges.push(index);
    }
  };
  const [pecXLow, pecYLow, pecZLow] = (['x_min', 'y_min', 'z_min'] as const).map((f) => r.boundaries[f].type === 'pec');
  for (let kk = 0; kk < nz; kk++) {
    const copper = copperPlanes.get(kk);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = idx3(grid, i, j, kk);
        const col = i + nx * j;
        tangential(kk, c, col, boardEx[col] ? boardTangential[kk] : air, copper?.ex, copper?.cover?.ex);
        tangential(kk, N + c, col, boardEy[col] ? boardTangential[kk] : air, copper?.ey, copper?.cover?.ey);
        setEdge(2 * N + c, boardEz[col] ? boardNormal[kk] : air);
        // A "pec" low face: zero the E tangential to it on node layer 0.
        if (i === 0 && pecXLow) eCurl[N + c] = eCurl[2 * N + c] = 0;
        if (j === 0 && pecYLow) eCurl[c] = eCurl[2 * N + c] = 0;
        if (kk === 0 && pecZLow) eCurl[c] = eCurl[N + c] = 0;
      }
    }
  }

  const conformal = conformalFaces(grid, cpml, copperPlanes, eCurl, partialEdges);
  // Copper edges of a plane (`whole` or `touched` of copperPlanes) at node column `col`: spanning it (an edge on each side in x or in y), or touching it.
  const copperSpansNode = ({ ex, ey }: EdgeMasks, col: number) => (ex[col - 1] && ex[col]) || (ey[col - nx] && ey[col]);
  const copperTouchesNode = ({ ex, ey }: EdgeMasks, col: number) => ex[col - 1] || ex[col] || ey[col - nx] || ey[col];
  /** Marks every node joined to one of `starts` through the given copper edges. */
  const copperReach = ({ ex, ey }: EdgeMasks, starts: number[]) => {
    const reached = new Uint8Array(nx * ny);
    const stack = [...starts];
    for (const col of starts) reached[col] = 1;
    while (stack.length > 0) {
      const col = stack.pop()!;
      const i = col % nx;
      const neighbours = [
        i + 1 < nx && ex[col] ? col + 1 : -1,
        i > 0 && ex[col - 1] ? col - 1 : -1,
        col + nx < nx * ny && ey[col] ? col + nx : -1,
        col >= nx && ey[col - nx] ? col - nx : -1,
      ];
      for (const next of neighbours) if (next >= 0 && !reached[next]) { reached[next] = 1; stack.push(next); }
    }
    return reached;
  };
  // Pole limits that depend on the time step (a Lorentz pole too fast for it), checked per material so the error has a path.
  for (const d of dielectrics) {
    for (const response of [d.responses.permittivity, d.responses.permeability]) {
      if (!response) continue;
      try {
        mediumRecord(response, dtSec);
      } catch (e) {
        fail(d.materialPath, `${(e as Error).message} (time step ${(dtSec * 1e12).toPrecision(3)} ps)`);
      }
    }
  }
  const boardDispersion = dispersiveEdges({
    grid, mesh, slabEps, slabSigma, slabEpsResponse, slabMuResponse, copperPlanes, boardEx, boardEy, boardEz,
    boardCentre: () => sample(0.5, 0.5, onBoard), fRefHz, dtSec,
  });
  warnings.push(...materialWarnings({
    dielectrics, mesh, zIndex, slabMuResponse,
    board: { xMin: minX, xMax: Math.max(...xs), yMin: minY, yMax: Math.max(...ys) },
    fMinHz: project.analysis.f_min_ghz * 1e9,
    fMaxHz: project.analysis.f_max_ghz * 1e9,
    energyStop: project.analysis.stop.energy_decay_db,
    // A coax probe's bore (PTFE) runs below its ground plane; inside the board only the pin is the connector's.
    coaxProbeGroundZ: r.ports.flatMap((p) => (p.kind === 'coax_probe' ? [copperZ.get(p.between[1])!] : [])),
  }));

  // --- Ports: each a vertical Ez column at the grid node nearest (x, y), between its two copper layers.
  const portNodes = new Map<number, string>();
  const ports = r.ports.map((port, n): PortSpec => {
    const path = `$.ports[${n}]`;
    // A port on a corrected copper edge sits on the edge's line by design (copperEdgeLines).
    const pi = nearestLine(mesh.x, xAxis.portsOnCorrectedEdges?.get(n) ?? port.xMm);
    const pj = nearestLine(mesh.y, yAxis.portsOnCorrectedEdges?.get(n) ?? port.yMm);
    if (pi < 1 || pi >= nx || pj < 1 || pj >= ny) fail(path, `port "${port.id}" lies outside the simulation box`);
    const snapped = (axis: AxisLayout, at: number, drawn: number) => !axis.portsOnCorrectedEdges?.has(n) && Math.abs(at - drawn) > 1e-9;
    if (snapped(xAxis, xOf(pi), port.xMm) || snapped(yAxis, yOf(pj), port.yMm)) {
      const mm = (v: number) => +v.toFixed(4); // a grid node at 1e-15 mm is at 0 mm
      warnings.push(`port "${port.id}" snapped from (${mm(port.xMm)}, ${mm(port.yMm)}) mm to the grid node at (${mm(xOf(pi))}, ${mm(yOf(pj))}) mm`);
    }
    const col = pi + nx * pj;
    // Two columns on one node would share or stack Ez cells; one port owns a node.
    const other = portNodes.get(col);
    if (other !== undefined) fail(path, `port "${port.id}" is on the same grid node (${pi},${pj}) as port "${other}"`);
    portNodes.set(col, port.id);
    const [k0, k1] = port.between.map((name) => copperK.get(name)!).sort((a, b) => a - b);
    for (const [planeK, plane] of copperPlanes) {
      const { name } = plane;
      if (planeK === k0 || planeK === k1) {
        // Copper must span the node by at least one cell in x or y. A trace narrower
        // than a cell voxelises to a zero-width wire whose impedance means nothing.
        // Only wholly covered edges count: a partly covered (conformal) edge is not PEC.
        if (!copperSpansNode(plane.whole, col)) {
          const along = port.edge?.[0] === 'x' ? `y = ${+port.yMm.toFixed(4)}` : `x = ${+port.xMm.toFixed(4)}`;
          fail(path, port.kind === 'sma_edge'
            ? `port "${port.id}" needs copper of layer "${name}" reaching the board edge at ${along} mm, at least one cell wide`
            : `port "${port.id}" node (${pi},${pj}) is not on copper of layer "${name}"; the copper there must be at least one cell wide`);
        }
      } else if (planeK > k0 && planeK < k1 && copperTouchesNode(plane.touched, col)) {
        // Copper touching the column on a layer in between would short the source.
        fail(path, `port "${port.id}" column at node (${pi},${pj}) passes through copper on layer "${name}"; ` +
          'cut an anti-pad around the port there');
      }
    }
    const cells = k1 - k0;
    const ezIndex = new Uint32Array(cells);
    const portEps = new Set<number>();
    for (let n = 0; n < cells; n++) {
      ezIndex[n] = 2 * N + idx3(grid, pi, pj, k0 + n);
      portEps.add(boardEz[col] ? slabEps[k0 + n] : 1);
      eDecay[ezIndex[n]] = 1;
      eCurl[ezIndex[n]] = 0;
    }
    if (portEps.size !== 1) fail(path, `port "${port.id}" spans dielectrics with different eps_r (${[...portEps].join(', ')}); not supported`);
    const portMesh = portMeshFactors(mesh, pi, pj, k0, k1, grid.dxMm);
    const coef = portCoefficients(Sc, [...portEps][0], port.z0, portMesh.seriesLength, 1, portMesh.loopLengthX * portMesh.loopLengthY);
    return { i: pi, j: pj, k0, k1, ezIndex, columns: 1, seriesCells: cells, cells, mesh: portMesh, ...coef };
  });

  const portCells = new Set(ports.flatMap((port) => Array.from(port.ezIndex)));
  const componentEdges = new Map<number, string>();
  const lumped = r.components.length === 0 ? undefined : placeComponents(eDecay, eCurl, Sc, dtSec, r.components.map((component, n) => {
    const path = `$.components[${n}]`;
    const snapTo = (axisLines: Float64Array, mm: number, axisName: string) => {
      const node = nearestLine(axisLines, mm);
      if (Math.abs(axisLines[node] - mm) > 1e-9) warnings.push(`component "${component.id}": ${axisName} = ${+mm.toFixed(4)} mm snapped to the grid line at ${+axisLines[node].toFixed(4)} mm`);
      return node;
    };
    const dualArea = (axisA: 0 | 1 | 2, nodeA: number, axisB: 0 | 1 | 2, nodeB: number) =>
      (dualWidth(lineSets[axisA], nodeA) * dualWidth(lineSets[axisB], nodeB)) / grid.dxMm ** 2;
    const lineSets = [mesh.x, mesh.y, mesh.z] as const;
    const { place } = component;
    let columns: ComponentEdge[][];
    if (place.kind === 'between') {
      const ci = snapTo(mesh.x, place.xMm, 'x');
      const cj = snapTo(mesh.y, place.yMm, 'y');
      if (ci < 1 || ci >= nx || cj < 1 || cj >= ny) fail(path, `component "${component.id}" lies outside the simulation box`);
      const col = ci + nx * cj;
      const [k0, k1] = place.between.map((name) => copperK.get(name)!).sort((a, b) => a - b);
      for (const [planeK, plane] of copperPlanes) {
        if ((planeK === k0 || planeK === k1) && !copperTouchesNode(plane.whole, col)) {
          fail(path, `component "${component.id}" at node (${ci},${cj}) does not touch copper of layer "${plane.name}"; put a pad there`);
        }
        if (planeK > k0 && planeK < k1 && copperTouchesNode(plane.touched, col)) {
          fail(path, `component "${component.id}" at node (${ci},${cj}) passes through copper on layer "${plane.name}"; cut an anti-pad around it there`);
        }
      }
      columns = [Array.from({ length: k1 - k0 }, (_, m) => ({
        eIndex: 2 * N + idx3(grid, ci, cj, k0 + m),
        edgeLength: cellWidth(mesh.z, k0 + m) / grid.dxMm,
        crossSection: dualArea(0, ci, 1, cj),
      }))];
    } else {
      const a = place.axis;
      const b = (1 - a) as 0 | 1;
      const along = lineSets[a];
      const [n0, n1] = [snapTo(along, place.fromMm, 'xy'[a]), snapTo(along, place.toMm, 'xy'[a])];
      if (n1 <= n0) fail(path, `component "${component.id}" is shorter than one cell once its ends snap to the grid; place its pads further apart or refine the mesh`);
      const across = lineSets[b];
      const nodes = place.widthMm === null
        ? [snapTo(across, place.acrossMm, 'xy'[b])]
        : Array.from(across.keys()).filter((m) => Math.abs(across[m] - place.acrossMm) <= place.widthMm! / 2 + 1e-9);
      if (nodes.length === 0) fail(`${path}.width`, `component "${component.id}" is narrower than the grid spacing there: no grid line falls within its width`);
      const kk = copperK.get(place.layer)!;
      const plane = copperPlanes.get(kk)!;
      // Pads must be PEC (wholly covered); copper partly over a gap edge counts as under the part.
      const [alongEdges, acrossEdges] = a === 0 ? [plane.whole.ex, plane.whole.ey] : [plane.whole.ey, plane.whole.ex];
      const alongTouched = a === 0 ? plane.touched.ex : plane.touched.ey;
      // Column index on the plane of node `u` along the part and node `v` across it.
      const colOf = (u: number, v: number) => (a === 0 ? u + nx * v : v + nx * u);
      const acrossStride = a === 0 ? nx : 1;
      const padAt = (u: number, v: number, outward: number) =>
        alongEdges[colOf(outward, v)] || acrossEdges[colOf(u, v)] || acrossEdges[colOf(u, v) - acrossStride];
      columns = nodes.map((v) => {
        if (!padAt(n0, v, n0 - 1) || !padAt(n1, v, n1)) {
          fail(path, `component "${component.id}" needs copper of layer "${place.layer}" at both ends, across its whole width; ` +
            `its line at ${'xy'[b]} = ${+across[v].toFixed(4)} mm has none at one end`);
        }
        return Array.from({ length: n1 - n0 }, (_, m) => {
          const u = n0 + m;
          if (alongTouched[colOf(u, v)]) {
            fail(path, `component "${component.id}" has copper of layer "${place.layer}" under it at ${'xy'[a]} = ${+along[u].toFixed(4)} mm; ` +
              `from and to are the two edges of the gap it bridges, not the centres of its pads`);
          }
          const at = a === 0 ? idx3(grid, u, v, kk) : idx3(grid, v, u, kk);
          return { eIndex: a * N + at, edgeLength: cellWidth(along, u) / grid.dxMm, crossSection: dualArea(b, v, 2, kk) };
        });
      });
      // Copper on the layer that joins the two ends (under the part or around it) would short it.
      const reached = copperReach(plane.touched, nodes.map((v) => colOf(n0, v)));
      if (nodes.some((v) => reached[colOf(n1, v)])) {
        fail(path, `component "${component.id}" is shorted by copper of layer "${place.layer}" that joins its two ends; cut the gap it bridges all the way across`);
      }
    }
    for (const edge of columns.flat()) {
      if (portCells.has(edge.eIndex)) fail(path, `component "${component.id}" sits on the cells of a port; move one of them`);
      const other = componentEdges.get(edge.eIndex);
      if (other !== undefined) fail(path, `component "${component.id}" overlaps component "${other}" on the grid`);
      componentEdges.set(edge.eIndex, component.id);
    }
    return { columns, values: component.values };
  }));

  const viaEdges = placeVias({ r, grid, mesh, copperK, copperPlanes, boardEz, eDecay, eCurl, taken: [portCells, new Set(componentEdges.keys())], warnings });
  if (conformal && viaEdges.length > 0) {
    // Edges a via made metal are no longer partly covered.
    const metal = new Set(viaEdges);
    conformal.partialEdges = conformal.partialEdges.filter((e) => !metal.has(e));
  }

  // A component edge keeps the single-frequency stand-in of its dielectric (eps_r and loss at
  // loss_reference_ghz, which placeComponents folded into its coefficients): the component pass owns it.
  // A via edge is metal.
  const notDispersive = new Set([...componentEdges.keys(), ...viaEdges]);
  const dispersion = boardDispersion?.e && notDispersive.size > 0
    ? { ...boardDispersion, e: withoutEdges(boardDispersion.e, notDispersive) }
    : boardDispersion;

  // --- Viewer: the top copper layer, sampled at cell centres.
  const topName = r.stackup.filter((l) => l.type === 'copper').at(-1)!.name;
  const topCopper = sample(0.5, 0.5, (x, y) => paint(r.copper[topName], x, y));
  const sheets = sheetEdges.length === 0 ? undefined
    : {
      eIndex: Uint32Array.from(sheetEdges),
      normalAxis: new Uint8Array(sheetEdges.length).fill(2),
      rsOhm: Float32Array.from(withEdgeLoss(sheetEdges, sheetRs)),
      surface: { cornerHz: surfaceCorners.cornerHz, shapes: surfaceShapes, shapeIndex: Uint8Array.from(sheetShape) },
    };

  if (sheets) {
    // Fail here, with a path, rather than when a solver starts: sheetFaceLoss refuses a face update that would overshoot.
    try {
      sheetFaceLoss({ grid, eCurl, cpml, sheets } as VoxelModel);
    } catch (e) {
      fail('$.stackup', (e as Error).message);
    }
  }

  return {
    model: {
      grid,
      eDecay,
      eCurl,
      cpml,
      mesh,
      ports,
      patchK: copperK.get(topName)!,
      topCopper,
      sheets,
      lumped,
      ...(dispersion ? { dispersion } : {}),
      ...(conformal ? { conformal } : {}),
      signature: materialSignature(eDecay, eCurl, { sheets, dispersion, lumped, conformal: conformal ?? undefined }),
    },
    warnings,
    coaxPorts: connector.ports,
  };
}

/** FDTD needs about 10 cells per wavelength in the material (Taflove and Hagness, ch. 4); fewer and the wave runs slow. */
const MIN_CELLS_PER_MATERIAL_WAVELENGTH = 10;
/** A surface-impedance fit worse than this in the band is worth a warning (it is 1e-3 or better for the models here). */
const SURFACE_FIT_WARNING = 0.01;

interface MaterialWarningInput {
  dielectrics: Array<{ z0: number; z1: number; epsR: number; name: string; responses: MaterialResponses }>;
  mesh: MeshLines;
  zIndex: (z: number) => number;
  slabMuResponse: Array<MediumResponse | null>;
  board: { xMin: number; xMax: number; yMin: number; yMax: number };
  fMinHz: number;
  fMaxHz: number;
  energyStop: number;
  coaxProbeGroundZ: number[];
}

/** Largest cell between the lines nearest lo and hi (the one cell at lo if they are the same line). */
function largestCell(lines: Float64Array, lo: number, hi: number): number {
  const [a, b] = [nearestLine(lines, lo), nearestLine(lines, hi)];
  let largest = cellWidth(lines, a);
  for (let i = a + 1; i < b; i++) largest = Math.max(largest, cellWidth(lines, i));
  return largest;
}

/**
 * Mesh and approximation warnings for dielectric layers: a layer meshed too
 * coarsely for the shortest wavelength inside it over the band (shortestWavelength,
 * not the vacuum wavelength), and the approximations magnetic layers run under.
 */
function materialWarnings(input: MaterialWarningInput): string[] {
  const { dielectrics, mesh, zIndex, slabMuResponse, board, fMinHz, fMaxHz } = input;
  const out: string[] = [];
  // Notes from a material's fit, once per material (its layers share one response object).
  for (const responses of new Set(dielectrics.map((d) => d.responses))) {
    const names = dielectrics.filter((d) => d.responses === responses).map((d) => `"${d.name}"`).join(', ');
    for (const note of responses.notes ?? []) out.push(`layer ${names}: ${note}`);
  }
  const inPlane = Math.max(largestCell(mesh.x, board.xMin, board.xMax), largestCell(mesh.y, board.yMin, board.yMax));
  for (const d of dielectrics) {
    const { wavelengthMm, index, atHz } = shortestWavelength(d.epsR, d.responses, fMinHz, fMaxHz);
    const cell = Math.max(inPlane, largestCell(mesh.z, d.z0, d.z1));
    const cells = wavelengthMm / cell;
    if (cells < MIN_CELLS_PER_MATERIAL_WAVELENGTH) {
      out.push(`layer "${d.name}": ${cells.toPrecision(2)} cells per wavelength inside the material at ${(atHz / 1e9).toPrecision(3)} GHz ` +
        `(${wavelengthMm.toPrecision(3)} mm at refractive index ${index.toPrecision(3)}, largest cell ${cell.toPrecision(3)} mm). ` +
        `Below about ${MIN_CELLS_PER_MATERIAL_WAVELENGTH} the wave travels too slowly on the grid and resonances read low; refine the mesh`);
    }
  }
  const magnetic = dielectrics.filter((d) => d.responses.permeability);
  if (magnetic.length === 0) return out;
  const names = magnetic.map((d) => `"${d.name}"`).join(', ');
  out.push(`magnetic layer ${names}: the energy stop (${input.energyStop} dB) counts magnetic energy as if μr were 1 and leaves out ` +
    'the energy held in material poles, so the run can end early. Check the result against a run with a deeper energy_decay_db');
  for (const d of magnetic) {
    // A constant μr (lossy or not) is exact in the series mean at the loss reference; only its loss drifts elsewhere, slightly.
    if (d.responses.permeability!.poles.length === 0) continue;
    const [bottom, top] = [zIndex(d.z0), zIndex(d.z1)];
    const differs = (kk: number) => kk < 0 || kk >= slabMuResponse.length || slabMuResponse[kk] !== d.responses.permeability;
    if (differs(bottom - 1) || differs(top)) {
      out.push(`layer "${d.name}": Hz on a face where it meets another material takes the series mean of μ at loss_reference_ghz, ` +
        `with no frequency dependence. The layer is ${top - bottom} cell${top - bottom === 1 ? '' : 's'} thick; the thinner it is, the more this matters`);
    }
  }
  // Only a magnetic layer below a probe's ground lies in its PTFE bore; above the ground the pin in a magnetic board is physical.
  const inBore = magnetic.filter((d) => input.coaxProbeGroundZ.some((z) => d.z1 <= z + 1e-9));
  if (inBore.length > 0) {
    out.push(`coax probe through magnetic layer ${inBore.map((d) => `"${d.name}"`).join(', ')} below its ground: the coax bore there keeps the layer's μr, ` +
      'so that section of coax has √μr times the impedance and a slower wave than PTFE alone');
  }
  return out;
}

interface DispersiveEdgeInput {
  grid: GridConfig;
  mesh: MeshLines;
  slabEps: Float64Array;
  slabSigma: Float64Array;
  slabEpsResponse: Array<MediumResponse | null>;
  slabMuResponse: Array<MediumResponse | null>;
  copperPlanes: Map<number, { ex: Uint8Array; ey: Uint8Array; cover: PlaneCoverage | null }>;
  boardEx: Uint8Array;
  boardEy: Uint8Array;
  boardEz: Uint8Array;
  boardCentre: () => Uint8Array;
  fRefHz: number;
  dtSec: number;
}

/**
 * The edges that need the dispersion pass, with the same placement rules as
 * the eDecay/eCurl loop:
 *   E: Ex/Ey on plane k mix the slabs below and above by height (eps mixes
 *      linearly, so this is exact for every pole); Ez in slab k takes it.
 *   H: Hx/Hy at k + 1/2 sit inside slab k and take its mu. Hz on plane k is
 *      normal to the layers, so B is continuous through its dual cell and
 *      the two halves add in series: mu = 1 / (w1 / mu1 + w2 / mu2). That
 *      mean is not a sum of poles, so on an interface between different
 *      materials Hz takes it at the loss reference as a constant; inside one
 *      material (a layer split into several cells) Hz keeps the full model.
 * Copper edges are left out; port cells are listed (eCurl 0 makes the pass
 * skip them until withoutPorts gives them back their dielectric).
 */
/** A response times k: every term of eps(omega), so eps(omega) * k at every frequency. */
const scaledResponse = (r: MediumResponse, k: number): MediumResponse =>
  ({ inf: r.inf * k, lossRate: r.lossRate * k, poles: r.poles.map((pole) => ({ ...pole, delta: pole.delta * k })) });

function dispersiveEdges(input: DispersiveEdgeInput): ModelDispersion | undefined {
  const { grid, mesh, slabEps, slabSigma, slabEpsResponse, slabMuResponse, copperPlanes, boardEx, boardEy, boardEz, fRefHz, dtSec } = input;
  const anyE = slabEpsResponse.some((r) => r);
  const anyH = slabMuResponse.some((r) => r);
  if (!anyE && !anyH) return undefined;
  const { nx, ny, nz } = grid;
  const N = nx * ny * nz;
  // A constant slab as a response, for mixing with a dispersive neighbour: the same eps and conductivity as its edges.
  const epsOf = (kk: number): MediumResponse => slabEpsResponse[kk] ?? constantResponse(slabEps[kk], slabSigma[kk] / dtSec);
  const muOf = (kk: number): MediumResponse => slabMuResponse[kk] ?? VACUUM_RESPONSE;
  // Plane kk sits between slab kk - 1 (below; air outside the box) and slab kk.
  const sides = (kk: number) => ({ below: kk - 1, wBelow: cellWidth(mesh.z, Math.max(0, kk - 1)), wAbove: cellWidth(mesh.z, kk) });

  const e = new DispersionBuilder(dtSec);
  // One scaled response per (response, factor), so edges with the same free fraction share a medium record.
  const scaledCache = new Map<MediumResponse, Map<number, MediumResponse>>();
  const scaled = (r: MediumResponse, k: number) => {
    const byFactor = scaledCache.get(r) ?? scaledCache.set(r, new Map()).get(r)!;
    return byFactor.get(k) ?? byFactor.set(k, scaledResponse(r, k)).get(k)!;
  };
  if (anyE) {
    for (let kk = 0; kk < nz; kk++) {
      const { below, wBelow, wAbove } = sides(kk);
      const planeDispersive = (below >= 0 && slabEpsResponse[below] !== null) || slabEpsResponse[kk] !== null;
      const plane = planeDispersive
        ? [{ response: below >= 0 ? epsOf(below) : VACUUM_RESPONSE, weight: wBelow }, { response: epsOf(kk), weight: wAbove }]
        : null;
      const copper = copperPlanes.get(kk);
      /**
       * An edge copper covers by `fraction`: none, the plane's mixture; wholly, PEC and not listed. Partly (conformal), its
       * main update reads eps / lambda (eCurl times the free fraction lambda), and the dispersion pass recovers the full
       * curl from that eCurl, so its medium is the mixture over lambda: eps(omega) e = lambda * curl h, as in the main update.
       */
      const addTangential = (index: number, fraction: number) => {
        if (fraction >= 1 - COVERAGE_SNAP) return;
        if (fraction <= COVERAGE_SNAP) return e.add(index, plane!);
        const k = 1 / (1 - fraction);
        e.add(index, plane!.map(({ response, weight }) => ({ response: scaled(response, k), weight })));
      };
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = idx3(grid, i, j, kk);
        const col = i + nx * j;
        if (plane) {
          if (boardEx[col]) addTangential(c, copper?.cover ? copper.cover.ex[col] : copper?.ex[col] ?? 0);
          if (boardEy[col]) addTangential(N + c, copper?.cover ? copper.cover.ey[col] : copper?.ey[col] ?? 0);
        }
        if (slabEpsResponse[kk] && boardEz[col]) e.add(2 * N + c, [{ response: epsOf(kk), weight: 1 }]);
      }
    }
  }

  const h = new DispersionBuilder(dtSec);
  if (anyH) {
    const boardHz = input.boardCentre();
    const muAt = (r: MediumResponse) => relativeValue(r, fRefHz);
    for (let kk = 0; kk < nz; kk++) {
      const { below, wBelow, wAbove } = sides(kk);
      const muBelow = below >= 0 ? muOf(below) : VACUUM_RESPONSE;
      const muAbove = muOf(kk);
      let hz: MediumResponse | null = null;
      if (muBelow !== VACUUM_RESPONSE || muAbove !== VACUUM_RESPONSE) {
        if (muBelow === muAbove) hz = muAbove;
        else {
          const series = (w: number, [re, im]: [number, number]): [number, number] => { const q = re * re + im * im; return [(w * re) / q, (-w * im) / q]; };
          const total = wBelow + wAbove;
          const a = series(wBelow / total, muAt(muBelow));
          const b = series(wAbove / total, muAt(muAbove));
          const [ir, ii] = [a[0] + b[0], a[1] + b[1]];
          const q = ir * ir + ii * ii;
          hz = constantResponse(Math.max(1, ir / q), Math.max(0, (ii / q) * 2 * Math.PI * fRefHz));
        }
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const c = idx3(grid, i, j, kk);
        const col = i + nx * j;
        if (slabMuResponse[kk]) {
          // Hx at (i, j + 1/2) has Ey's footprint, Hy at (i + 1/2, j) Ex's.
          if (boardEy[col]) h.add(c, [{ response: muAbove, weight: 1 }]);
          if (boardEx[col]) h.add(N + c, [{ response: muAbove, weight: 1 }]);
        }
        if (hz && boardHz[col]) h.add(2 * N + c, [{ response: hz, weight: 1 }]);
      }
    }
  }
  return { e: e.build(), h: h.build() };
}

/**
 * The z faces of the conformal copper planes that the copper partly covers,
 * with their correction (conformal.ts). Built from the final eCurl, so an
 * edge made PEC by a "pec" box face counts as covered. A face's H update is
 *   h -= Sc * ((ey(i+1) - ey(i)) kx - (ex(j+1) - ex(j)) ky),
 * and dividing it by a_eff adds (1/a_eff - 1) times the same again.
 */
function conformalFaces(
  grid: GridConfig, cpml: ReturnType<typeof buildCpml>, planes: Map<number, { cover: PlaneCoverage | null }>, eCurl: Float32Array, partialEdges: number[],
): ConformalFaces | null {
  const { nx, ny, nz, courant: Sc } = grid;
  const N = nx * ny * nz;
  const hIndex: number[] = [];
  const eIndex: number[] = [];
  const coef: number[] = [];
  const free = (fraction: number, index: number) => (eCurl[index] === 0 || fraction >= 1 - COVERAGE_SNAP ? 0 : fraction <= COVERAGE_SNAP ? 1 : 1 - fraction);
  for (const [kk, { cover }] of planes) {
    if (!cover) continue;
    for (let j = 0; j + 1 < ny; j++) {
      for (let i = 0; i + 1 < nx; i++) {
        const col = i + nx * j;
        const a = 1 - cover.face[col];
        if (a >= 1 - COVERAGE_SNAP) continue;
        const c = idx3(grid, i, j, kk);
        const edges = [N + c + 1, N + c, c + nx, c];
        const lambdas = [free(cover.ey[col + 1], edges[0]), free(cover.ey[col], edges[1]), free(cover.ex[col + nx], edges[2]), free(cover.ex[col], edges[3])];
        const [kx, ky] = [cpml.x.hDiffScale[i], cpml.y.hDiffScale[j]];
        // Squared normalised curl entry of each edge with this face: H-side scale x E-side scale x the edge's uncut eCurl / Sc.
        const eSide = [cpml.x.eDiffScale[i + 1], cpml.x.eDiffScale[i], cpml.y.eDiffScale[j + 1], cpml.y.eDiffScale[j]];
        const entries = edges.map((index, n) => (lambdas[n] > 0 ? ((n < 2 ? kx : ky) * eSide[n] * eCurl[index]) / (lambdas[n] * Sc) : 0));
        const aEff = effectiveFreeArea(Math.max(0, a), lambdas, entries, Sc);
        if (aEff >= 1) continue;
        const w = Sc * (1 / aEff - 1);
        hIndex.push(2 * N + c);
        eIndex.push(...edges);
        coef.push(-w * kx, w * kx, w * ky, -w * ky);
      }
    }
  }
  if (partialEdges.length === 0) return null;
  const e = Uint32Array.from(eIndex);
  return {
    hIndex: Uint32Array.from(hIndex), eIndex: e, coef: Float32Array.from(coef), eCurl: Float32Array.from(e, (index) => eCurl[index]),
    partialEdges: Uint32Array.from(partialEdges).sort(),
  };
}

/**
 * Gap of at least `minGapMm` past a mesh line of cell `lineCellMm` to the box
 * face, in which the grading fits a whole number of cells. gradedLines sizes
 * cells by s(d) = min(maxCellMm, lineCellMm + slope * d) and cuts the gap into
 * ceil(integral of 1/s) cells, so a gap whose integral is not whole gets cells
 * smaller than s, from lineCellMm down; and the next pass grades the
 * neighbours from those, until slivers. The integral is
 *   ln(1 + slope d / c) / slope   up to d* = (maxCell - c) / slope, then + (d - d*) / maxCell,
 * solved for the next whole number, a hair under it so the count rounds down.
 */
function wholeCellGap(lineCellMm: number, maxCellMm: number, slope: number, minGapMm: number): number {
  const c = lineCellMm;
  const rampEnd = Math.max(0, (maxCellMm - c) / slope);
  const rampIntegral = Math.log(1 + (slope * rampEnd) / c) / slope;
  const integral = (d: number) => (d <= rampEnd ? Math.log(1 + (slope * d) / c) / slope : rampIntegral + (d - rampEnd) / maxCellMm);
  const cells = Math.ceil(integral(minGapMm) - 1e-9) - 1e-6;
  return cells <= rampIntegral ? (c * (Math.exp(slope * cells) - 1)) / slope : rampEnd + (cells - rampIntegral) * maxCellMm;
}

/**
 * The coax feeds of the project's sma_edge and coax_probe ports, and their
 * mesh lines per axis, also added to `extra`. rasterise widens the air
 * wherever these reach past the board. An SMA's pin rests on the top copper
 * layer, so its signal layer must be the top one; a probe's coax runs below
 * its ground layer, which must be the bottom one.
 */
function coaxConnectors(
  r: ReturnType<typeof resolveProject>, copperZ: Map<string, number>, cellMm: number, faces: PmlFaces,
  extra: { x: Refinement[]; y: Refinement[]; z: Refinement[] },
): { ports: CoaxPort[]; lines: [Refinement[], Refinement[], Refinement[]] } {
  const ports: CoaxPort[] = [];
  const lines: [Refinement[], Refinement[], Refinement[]] = [[], [], []];
  const facePml: Record<string, number> = { x_min: faces.xLow, x_max: faces.xHigh, y_min: faces.yLow, y_max: faces.yHigh, z_min: faces.zLow };
  const runCellMm = SMA_PLANE_SPACING_MM / Math.ceil(SMA_PLANE_SPACING_MM / cellMm);
  r.ports.forEach((port, n) => {
    if (port.kind === 'lumped') return;
    const path = `$.ports[${n}]`;
    if (!r.graded) fail('$.mesh', `the ${port.kind} port "${port.id}" needs a graded mesh (mesh.graded): the connector is meshed with refinements`);
    const face = port.kind === 'sma_edge' ? port.edge! : 'z_min';
    if (facePml[face] === 0) fail(`$.boundaries.${face}`, `must be a PML for the ${port.kind} port "${port.id}": its coax runs out through it`);
    const [signalZ, groundZ] = port.between.map((name) => copperZ.get(name)!);
    if (port.kind === 'sma_edge' && (signalZ !== Math.max(...copperZ.values()) || !(signalZ > groundZ))) {
      fail(`${path}.between`, 'must be [top copper layer, a ground layer below it]; the connector pin rests on the top layer');
    }
    if (port.kind === 'coax_probe' && (groundZ !== Math.min(...copperZ.values()) || !(signalZ > groundZ))) {
      fail(`${path}.between`, 'must be [a copper layer above, the bottom copper layer]; the probe\'s coax runs below the bottom layer');
    }
    try {
      const spec = port.kind === 'sma_edge'
        ? edgeLaunchSma({
          edge: port.edge!, alongMm: port.edge![0] === 'y' ? port.xMm : port.yMm, topCopperZMm: signalZ, groundZMm: groundZ,
          boardEdgeMm: port.edge![0] === 'y' ? port.yMm : port.xMm,
        })
        : coaxProbe({ xMm: port.xMm, yMm: port.yMm, groundZMm: groundZ, signalZMm: signalZ });
      const boardCell = (axis: 0 | 1, m: number) => smaCrossCell(r.copper[port.between[0]].flatMap((shape) => edgeCoordinates(shape.polygon, axis)), spec.axisMm[m], spec.bodyHalfWidthMm);
      // An edge launch's z lattice takes the cell of the axis along the edge, so both cross axes share one cell.
      const alongEdge = spec.runAxis === 2 ? 0 : boardCell(spec.runAxis === 0 ? 1 : 0, 0);
      const crossCellMm: [number, number] = spec.runAxis === 2 ? [boardCell(0, 0), boardCell(1, 1)] : [alongEdge, alongEdge];
      const own = coaxRefinements(spec, { crossCellMm, runCellMm, copperZMm: [groundZ, signalZ] });
      for (const other of ports) {
        if (connectorsOverlap(other.spec, spec)) {
          fail(path, `the connector of port "${port.id}" overlaps the one of port "${r.ports[other.port].id}"`);
        }
      }
      ports.push({ port: n, spec });
      // Connectors in line (two SMAs facing across the board) share lattice lines: keep one of each, at the finer cell.
      own.forEach((list, axis) => {
        for (const line of list) {
          const same = lines[axis].find((l) => Math.abs(l.at - line.at) < EDGE_TOLERANCE_MM);
          if (!same) lines[axis].push(line);
          else same.cellMm = Math.min(same.cellMm, line.cellMm);
        }
      });
    } catch (e) {
      if (e instanceof ProjectError) throw e;
      fail(path, (e as Error).message);
    }
  });
  extra.x.push(...lines[0]);
  extra.y.push(...lines[1]);
  extra.z.push(...lines[2]);
  return { ports, lines };
}

/**
 * The cross-section cell for the connector lattice, which is centred on the
 * pin axis x0: near SMA_CROSS_CELL_MM, and dividing the distance from x0 to the
 * nearer of the trace's two edges, so the lattice lands on that edge (on both
 * for a trace centred on the pin). A lattice line a fraction of a cell from a
 * copper edge would leave a sliver cell there, and the mesh grading shrinks
 * the cells around a sliver until the time step collapses (a 2.01 mm trace
 * gave 0.006 mm cells).
 */
function smaCrossCell(copperEdges: number[], x0: number, spanMm: number): number {
  const distances = copperEdges.map((x) => Math.abs(x - x0)).filter((d) => d > EDGE_TOLERANCE_MM && d <= spanMm);
  if (distances.length === 0) return SMA_CROSS_CELL_MM;
  const nearest = Math.min(...distances);
  return nearest / Math.max(1, Math.round(nearest / SMA_CROSS_CELL_MM));
}

/**
 * Graded mesh lines a via asks for along one axis: its centre, and its rim
 * when the drill is wide enough that the rim lines stay half an edge cell
 * from the centre (closer ones would merge into it).
 */
function viaLines(via: ResolvedVia, axis: 0 | 1, edgeCellMm: number): number[] {
  const centre = axis === 0 ? via.xMm : via.yMm;
  // A fence's vias take their centres only: rim lines on every via of a long row would grade the whole board down.
  const rim = !via.inFence && via.radiusMm >= edgeCellMm / 2 ? [centre - via.radiusMm, centre + via.radiusMm] : [];
  const clearance = via.antipadRadiusMm !== null && !via.inFence ? [centre - via.antipadRadiusMm, centre + via.antipadRadiusMm] : [];
  return [centre, ...rim, ...clearance];
}

interface ViaInput {
  r: ReturnType<typeof resolveProject>;
  grid: GridConfig;
  mesh: MeshLines;
  copperK: Map<string, number>;
  copperPlanes: Map<number, { name: string; whole: { ex: Uint8Array; ey: Uint8Array }; touched: { ex: Uint8Array; ey: Uint8Array } }>;
  boardEz: Uint8Array;
  eDecay: Float32Array;
  eCurl: Float32Array;
  /** E edges owned by ports and components: a via may not take them. */
  taken: Array<Set<number>>;
  warnings: string[];
}

/**
 * Plated vias as PEC: every grid node within the drill (rim included) is a
 * column of PEC Ez edges between the via's two copper layers, and the x and y
 * edges joining two of those nodes are PEC on every plane between, so the
 * barrel is solid metal. A drill that holds no node becomes the column at
 * the nearest node. Returns the E indices made PEC.
 */
function placeVias({ r, grid, mesh, copperK, copperPlanes, boardEz, eDecay, eCurl, taken, warnings }: ViaInput): number[] {
  const { nx, ny } = grid;
  const N = nx * ny * grid.nz;
  const owner = new Map<number, string>();
  const thin = new Map<string, number>();
  for (const via of r.vias) {
    const at = `via "${via.id}"`;
    const [ci, cj] = [nearestLine(mesh.x, via.xMm), nearestLine(mesh.y, via.yMm)];
    if (ci < 1 || ci >= nx - 1 || cj < 1 || cj >= ny - 1) fail(via.path, `${at} lies outside the simulation box`);
    const inside = (i: number, j: number) => Math.hypot(mesh.x[i] - via.xMm, mesh.y[j] - via.yMm) <= via.radiusMm + EDGE_TOLERANCE_MM;
    const span = (lines: Float64Array, centre: number, node: number) => {
      let [lo, hi] = [node, node];
      while (lo > 1 && lines[lo - 1] >= centre - via.radiusMm - EDGE_TOLERANCE_MM) lo--;
      while (hi < lines.length - 2 && lines[hi + 1] <= centre + via.radiusMm + EDGE_TOLERANCE_MM) hi++;
      return [lo, hi];
    };
    const [i0, i1] = span(mesh.x, via.xMm, ci);
    const [j0, j1] = span(mesh.y, via.yMm, cj);
    const nodes: Array<[number, number]> = [];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inside(i, j)) nodes.push([i, j]);
    const fallback = nodes.length === 0;
    if (fallback) nodes.push([ci, cj]);
    if (nodes.length === 1) {
      // One column reads as a post of a fixed fraction of the cells around it, whatever the drill.
      const [i, j] = nodes[0];
      const cell = Math.min(cellWidth(mesh.x, i - 1), cellWidth(mesh.x, i), cellWidth(mesh.y, j - 1), cellWidth(mesh.y, j));
      thin.set(via.path, Math.max(thin.get(via.path) ?? 0, cell));
    }
    for (const [i, j] of nodes) {
      if (!boardEz[i + nx * j]) fail(via.path, `${at} at (${+via.xMm.toFixed(4)}, ${+via.yMm.toFixed(4)}) mm reaches off the board`);
    }
    const isVia = new Set(nodes.map(([i, j]) => i + nx * j));
    const [k0, k1] = via.between.map((name) => copperK.get(name)!);
    const touchesCopper = (planeK: number, which: 'whole' | 'touched') => {
      const { ex, ey } = copperPlanes.get(planeK)![which];
      return nodes.some(([i, j]) => {
        const col = i + nx * j;
        return ex[col - 1] || ex[col] || ey[col - nx] || ey[col];
      });
    };
    for (const name of via.between) {
      if (!touchesCopper(copperK.get(name)!, 'touched')) fail(via.path, `${at} does not touch copper of layer "${name}"; put a pad there`);
    }
    if (via.antipadRadiusMm !== null) {
      // The antipad must clear the grid too: a metal edge leaving the barrel would join the via to the plane.
      // (A partly covered conformal edge is a capacitance, not a short.)
      for (const [planeK, plane] of copperPlanes) {
        if (planeK > k0 && planeK < k1 && touchesCopper(planeK, 'whole')) {
          fail(via.path, `${at}: its antipad does not clear the grid on layer "${plane.name}", so the via would still join that copper; ` +
            'widen the antipad or refine the mesh (on a graded mesh, lines go on the antipad\'s rim)');
        }
      }
    }
    const edges: number[] = [];
    for (const [i, j] of nodes) {
      for (let k = k0; k < k1; k++) edges.push(2 * N + idx3(grid, i, j, k));
      for (let k = k0; k <= k1; k++) {
        if (isVia.has(i + 1 + nx * j)) edges.push(idx3(grid, i, j, k));
        if (isVia.has(i + nx * (j + 1))) edges.push(N + idx3(grid, i, j, k));
      }
    }
    for (const e of edges) {
      if (taken.some((set) => set.has(e))) fail(via.path, `${at} sits on the cells of a port or a component; move one of them`);
      const other = owner.get(e);
      if (other !== undefined && other !== via.id) fail(via.path, `${at} and via "${other}" share grid edges; space them further apart or refine the mesh`);
      owner.set(e, via.id);
      eDecay[e] = 1;
      eCurl[e] = 0;
    }
  }
  for (const [path, cell] of thin) {
    warnings.push(`${path}: the drill holds at most one grid node, so each via is the one grid column nearest its center; ` +
      `its inductance follows the cells there (${+cell.toPrecision(3)} mm), not the drill. Refine the mesh (graded mesh lines go on the via) to resolve it`);
  }
  return [...owner.keys()];
}
