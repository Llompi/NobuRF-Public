/**
 * Boards as plain numbers, so the suite can mirror, rotate, translate and
 * scale them exactly, then write them as project files the solver reads the
 * way a user's would (parseProject, rasterise).
 */
import { parseProject, type Project } from '../../src/project/schema';

export type Vec2 = [number, number];

export interface LayerSpec {
  type: 'copper' | 'dielectric';
  name: string;
  /** Dielectric only. */
  thicknessMm?: number;
  epsR?: number;
  tanDelta?: number;
}

export interface PortSpec { id: string; at: Vec2; between: [string, string] }

export interface BoardSpec {
  name: string;
  /** Board outline polygon (mm). */
  outline: Vec2[];
  /** Bottom up. */
  stackup: LayerSpec[];
  /** Polygons per copper layer (all "add"). */
  copper: Record<string, Vec2[][]>;
  ports: PortSpec[];
  boundary: { xy: 'pec' | 'pml'; z: 'pec' | 'pml'; y?: 'pec' | 'pml' };
  mesh: { cellMm: number; edgeCellMm: number; dielectricCells: number; maxGrowth: number; margin: { xy: number; below: number; above: number } };
  band: { fMinGHz: number; fMaxGHz: number; nFreq: number };
  stop: { decayDb: number; maxSteps: number };
}

const mm = (v: number) => `${v} mm`;

export function toProject(spec: BoardSpec): Project {
  const materials: Record<string, { eps_r: number; tan_delta: number }> = {};
  const stackup = spec.stackup.map((layer) => {
    if (layer.type === 'copper') return { type: 'copper', name: layer.name, material: 'pec' };
    materials[`m_${layer.name}`] = { eps_r: layer.epsR!, tan_delta: layer.tanDelta ?? 0 };
    return { type: 'dielectric', name: layer.name, material: `m_${layer.name}`, thickness: mm(layer.thicknessMm!) };
  });
  const polygon = (points: Vec2[]) => points.map(([x, y]) => [mm(x), mm(y)]);
  const geometry = Object.fromEntries(Object.entries(spec.copper).map(([layer, shapes]) => [
    layer, shapes.map((points, n) => ({ id: `${layer}_${n}`, op: 'add', polygon: polygon(points) })),
  ]));
  const face = (kind: 'pec' | 'pml') => (kind === 'pec' ? { type: 'pec' } : { type: 'pml', cells: 8 });
  const yKind = spec.boundary.y ?? spec.boundary.xy;
  const json = {
    noburf_project: 1,
    name: spec.name,
    variables: {},
    materials,
    stackup,
    board: { outline: polygon(spec.outline) },
    geometry,
    ports: spec.ports.map((p) => ({ id: p.id, x: mm(p.at[0]), y: mm(p.at[1]), between: p.between, reference_impedance_ohm: 50 })),
    boundaries: {
      x_min: face(spec.boundary.xy), x_max: face(spec.boundary.xy),
      y_min: face(yKind), y_max: face(yKind),
      z_min: face(spec.boundary.z), z_max: face(spec.boundary.z),
    },
    mesh: {
      cell: mm(spec.mesh.cellMm),
      air_margin_cells: spec.mesh.margin,
      graded: { edge_cell: mm(spec.mesh.edgeCellMm), dielectric_cells: spec.mesh.dielectricCells, max_growth: spec.mesh.maxGrowth },
    },
    analysis: {
      f_min_ghz: spec.band.fMinGHz,
      f_max_ghz: spec.band.fMaxGHz,
      n_freq: spec.band.nFreq,
      loss_reference_ghz: (spec.band.fMinGHz + spec.band.fMaxGHz) / 2,
      stop: { energy_decay_db: spec.stop.decayDb, max_steps: spec.stop.maxSteps },
    },
    outputs: { zin_at_ghz: [] },
  };
  return parseProject(json);
}

/* -------------------------------------------------------------- transforms */

/** Apply a map to every point of the board (outline, copper, ports). */
function mapPoints(spec: BoardSpec, name: string, f: (p: Vec2) => Vec2): BoardSpec {
  return {
    ...spec,
    name,
    outline: spec.outline.map(f),
    copper: Object.fromEntries(Object.entries(spec.copper).map(([layer, shapes]) => [layer, shapes.map((s) => s.map(f))])),
    ports: spec.ports.map((p) => ({ ...p, at: f(p.at) })),
  };
}

export function bounds(spec: BoardSpec): { lo: Vec2; hi: Vec2 } {
  const xs = spec.outline.map((p) => p[0]);
  const ys = spec.outline.map((p) => p[1]);
  return { lo: [Math.min(...xs), Math.min(...ys)], hi: [Math.max(...xs), Math.max(...ys)] };
}

/** Mirror x about the board's centre line. */
export function mirrorX(spec: BoardSpec): BoardSpec {
  const { lo, hi } = bounds(spec);
  return mapPoints(spec, `${spec.name}-mirror-x`, ([x, y]) => [lo[0] + hi[0] - x, y]);
}

/** Rotate by +90 degrees about z: (x, y) -> (-y, x). x and y boundaries swap (they must be of one kind). */
export function rotate90(spec: BoardSpec): BoardSpec {
  if ((spec.boundary.y ?? spec.boundary.xy) !== spec.boundary.xy) throw new Error('rotate90 needs the same boundary on x and y');
  return mapPoints(spec, `${spec.name}-rot90`, ([x, y]) => [-y, x]);
}

export function translate(spec: BoardSpec, [dx, dy]: Vec2): BoardSpec {
  return mapPoints(spec, `${spec.name}-shift`, ([x, y]) => [x + dx, y + dy]);
}

/** Every length times s, frequencies over s; with `withMesh` the mesh lengths scale too (the same discrete problem). */
export function scale(spec: BoardSpec, s: number, withMesh: boolean): BoardSpec {
  const scaled = mapPoints(spec, `${spec.name}-scale${withMesh ? '-mesh' : ''}`, ([x, y]) => [x * s, y * s]);
  return {
    ...scaled,
    stackup: spec.stackup.map((l) => (l.thicknessMm === undefined ? l : { ...l, thicknessMm: l.thicknessMm * s })),
    mesh: withMesh ? { ...spec.mesh, cellMm: spec.mesh.cellMm * s, edgeCellMm: spec.mesh.edgeCellMm * s } : spec.mesh,
    band: { ...spec.band, fMinGHz: spec.band.fMinGHz / s, fMaxGHz: spec.band.fMaxGHz / s },
  };
}

/** Reverse the port list (port 1 becomes the last). */
export function reversePorts(spec: BoardSpec): BoardSpec {
  return { ...spec, name: `${spec.name}-ports-reversed`, ports: [...spec.ports].reverse() };
}

/** Refinement level m: cells m times smaller, m times more cells across each dielectric (m * dielectricCells must be whole). */
export function refine(spec: BoardSpec, m: number): BoardSpec {
  const cells = spec.mesh.dielectricCells * m;
  if (Math.abs(cells - Math.round(cells)) > 1e-9) throw new Error(`refinement ${m} of ${spec.mesh.dielectricCells} dielectric cells is not whole`);
  return {
    ...spec,
    name: `${spec.name}-m${m}`,
    mesh: { ...spec.mesh, cellMm: spec.mesh.cellMm / m, edgeCellMm: spec.mesh.edgeCellMm / m, dielectricCells: Math.round(cells) },
  };
}

/**
 * Whether mesh line list `b` is `a` under x -> sign * x * s + shift (all
 * lines, either order), within 1e-9 of the cell: if so, the two discrete
 * problems are the same up to relabelling, and only roundoff may differ.
 */
export function linesMap(a: Float64Array, b: Float64Array, s: number, shift: number, sign: 1 | -1): boolean {
  if (a.length !== b.length) return false;
  const mapped = Array.from(a, (v) => sign * v * s + shift).sort((u, v) => u - v);
  const smallest = Math.min(...Array.from(b.subarray(1), (v, n) => v - b[n]));
  return mapped.every((v, n) => Math.abs(v - b[n]) <= 1e-9 * Math.max(1, smallest));
}
