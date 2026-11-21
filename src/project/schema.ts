import { HUYGENS_MIN_AIR_MARGIN_CELLS } from '../engine/huygens_box';
import { LENGTH_UNITS, NAME_PATTERN } from './expression';
import { resolveProject } from './resolve';

/**
 * The NobuRF project file: one versioned JSON document that fully describes a
 * planar antenna simulation. Plain TS, no dependencies: imported from Node and
 * the browser.
 *
 * Conventions:
 *   - Every length is a string expression with a unit: "1.5 mm", "patch_l / 2",
 *     "-(patch_l / 2 + feed_len)". Bare JSON numbers are rejected for lengths.
 *     Frequencies (GHz), counts and material constants are plain numbers whose
 *     unit is in the key name.
 *   - x, y are board coordinates; z is the stackup, listed bottom to top.
 *     Copper layers are zero-thickness sheets between dielectric layers.
 *   - Unknown keys are errors, so a typo never silently does nothing.
 */

export type Length = string;
export type Point = [x: Length, y: Length];

export interface VariableDef {
  /** Expression; may use other variables. */
  value: string;
  /** Optional inclusive range, same dimension as value. */
  min?: string;
  max?: string;
  /** A locked variable cannot be changed by an edit. Absent = unlocked. */
  locked?: boolean;
}

/**
 * A dielectric, optionally magnetic and frequency-dependent. Without a model,
 * a lossy dielectric is Djordjevic-Sarkar with eps_r and tan_delta at
 * analysis.loss_reference_ghz, and a lossless one is a constant eps_r.
 * model "conductivity" keeps eps_r constant and makes the loss a
 * conductivity exact at the loss reference. With another model, eps_r and
 * tan_delta are its values at the model's at_ghz. mu_r and mu_tan_delta are
 * constant unless mu_dispersion is given, the magnetic loss a conductivity
 * exact at the loss reference. See docs/project-file.md, "Materials".
 */
export interface DielectricMaterial {
  eps_r: number;
  tan_delta: number;
  /** Frequency model of the permittivity. Absent: Djordjevic-Sarkar at the loss reference if lossy, else constant. */
  dispersion?: PermittivityModel;
  /** Relative permeability; absent: 1. */
  mu_r?: number;
  /** Magnetic loss tangent mu'' / mu'; absent: 0. */
  mu_tan_delta?: number;
  /** Frequency model of the permeability. Absent: constant. */
  mu_dispersion?: PoleModel;
}

/** Djordjevic-Sarkar wideband model (FR-4 and other glass-epoxy laminates), through eps_r and tan_delta at at_ghz. */
export interface DjordjevicSarkarModel {
  model: 'djordjevic_sarkar';
  at_ghz: number;
  /** Corner frequencies of the model's flat-loss region; absent: 1 kHz and 1 THz. */
  f_low_hz?: number;
  f_high_hz?: number;
}

/**
 * eps_r constant at every frequency and the loss a conductivity exact at
 * analysis.loss_reference_ghz: what a constant loss tangent must become in a
 * time-domain solver. It still conducts at DC, so TDR levels and step
 * responses read it as a leak; the opt-in for comparing with a tool that uses
 * this model.
 */
export interface ConductivityModel {
  model: 'conductivity';
}

/** Debye relaxation: delta / (1 + j f / f_relax). */
export interface DebyePoleDef { type: 'debye'; delta: number; f_relax_ghz: number }
/** Lorentz resonance: delta f_res^2 / (f_res^2 - f^2 + j f damping). */
export interface LorentzPoleDef { type: 'lorentz'; delta: number; f_res_ghz: number; damping_ghz: number }
export type PoleDef = DebyePoleDef | LorentzPoleDef;

/**
 * Debye and Lorentz poles anchored at at_ghz: the high-frequency value and a
 * conductivity are set so the material has its eps_r and tan_delta (mu_r and
 * mu_tan_delta) there.
 */
export interface PoleModel {
  model: 'poles';
  at_ghz: number;
  poles: PoleDef[];
}

/**
 * A measured table (a laminate datasheet's Dk and Df against frequency),
 * fitted to Debye poles (tableResponse in dispersion.ts). The material's
 * eps_r and tan_delta may be left out: they are then the row nearest the
 * middle of the table (in log frequency), the value lists and exports show.
 */
export interface TableModel {
  model: 'table';
  points: Array<{ f_ghz: number; eps_r: number; tan_delta: number }>;
}

export type PermittivityModel = DjordjevicSarkarModel | ConductivityModel | PoleModel | TableModel;

/** A metal for copper layers. Its sheets get the skin-effect impedance of this conductivity (see rasterise.ts). */
export interface ConductorMaterial {
  conductivity_s_per_m: number;
  /** Surface roughness of the foil (surface_impedance.ts). Absent: smooth. */
  roughness?: RoughnessDef;
}

export type RoughnessDef =
  | { model: 'hammerstad'; rms_um: number }
  | { model: 'groisse'; rms_um: number }
  | { model: 'huray'; radius_um: number; surface_ratio: number };

export interface CopperLayer {
  type: 'copper';
  name: string;
  /** Must name a conductor: "pec", "copper" or a project material with conductivity_s_per_m. */
  material: string;
  /**
   * Copper thickness. The layer is still a zero-thickness sheet; the thickness
   * only sets the extra conductor loss at copper edges (edgeLossFactor).
   */
  thickness?: Length;
}

export interface DielectricLayer {
  type: 'dielectric';
  name: string;
  material: string;
  thickness: Length;
}

export type StackupLayer = CopperLayer | DielectricLayer;

/**
 * One polygon painted onto a copper layer. Shapes are painted in list order:
 * "add" makes copper inside the polygon, "cut" removes it (slots, notches).
 * A sample point on a polygon edge counts as inside.
 */
export interface CopperShape {
  id: string;
  op: 'add' | 'cut';
  polygon: Point[];
}

/** Lumped port: a vertical source column at (x, y) between two copper layers. */
export interface LumpedPort {
  /** Absent or "lumped": a resistive source in the grid between two copper layers at (x, y). */
  kind?: 'lumped';
  id: string;
  x: Length;
  y: Length;
  /** The two copper layers the port spans, in either order. */
  between: [string, string];
  reference_impedance_ohm: number;
  /**
   * Remove the port and this much of the straight feed line it drives from
   * the results, which then refer to a plane `length` along the line
   * (src/project/deembed_kit.ts). Absent: results at the port.
   */
  deembed?: { length: Length };
}

/**
 * An edge-launch SMA connector modelled in the grid (src/engine/coax_feed.ts):
 * its pin lands on the trace on the board edge `edge`, at x on a y edge or at
 * y on an x edge, and waves are read at the flange, as a VNA calibrated at
 * the connector would. Graded mesh only.
 */
export interface SmaEdgePort {
  kind: 'sma_edge';
  id: string;
  /** The board edge the connector sits on; the coax runs out through the air into that face's PML. */
  edge: 'x_min' | 'x_max' | 'y_min' | 'y_max';
  /** Position along a y_min or y_max edge. */
  x?: Length;
  /** Position along an x_min or x_max edge. */
  y?: Length;
  /** [signal layer, ground layer]: the pin rests on the first, the body bonds to the second. */
  between: [string, string];
  reference_impedance_ohm: number;
}

/**
 * A coax probe through the ground plane (src/engine/coax_feed.ts): an SMA line
 * runs down below the ground plane at (x, y) into the z_min PML, and its pin
 * rises through the board to the signal layer, as in a probe-fed patch. The
 * ground copper inside the bore is cut away. Graded mesh only.
 */
export interface CoaxProbePort {
  kind: 'coax_probe';
  id: string;
  x: Length;
  y: Length;
  /** [signal layer, ground layer]: the pin ends on the first; the second, the bottom copper layer, is the coax's shield. */
  between: [string, string];
  reference_impedance_ohm: number;
}

export type Port = LumpedPort | SmaEdgePort | CoaxProbePort;

/**
 * A lumped R, L, C component's value: any of the three parts, joined in
 * series or in parallel (src/engine/lumped.ts). `connection` is needed once
 * there are two parts or more.
 */
export interface ComponentValue {
  r_ohm?: number;
  l_nh?: number;
  c_pf?: number;
  connection?: 'series' | 'parallel';
}

/** A component standing between two copper layers at (x, y), such as a shunt part from a pad to ground. */
export interface ComponentBetweenLayers extends ComponentValue {
  id: string;
  x: Length;
  y: Length;
  between: [string, string];
}

/**
 * A component on one copper layer bridging a gap in the copper, from one pad
 * edge to the other along x or along y, such as a chip resistor in series with
 * a trace. `width` spreads it across that many grid lines (the part's body);
 * absent, it is one line of zero width.
 */
export interface ComponentOnLayer extends ComponentValue {
  id: string;
  layer: string;
  from: Point;
  to: Point;
  width?: Length;
}

export type LumpedComponent = ComponentBetweenLayers | ComponentOnLayer;

/**
 * A plated via: a metal barrel of diameter `drill` from one copper layer to
 * another, joined to the copper it touches on the way. `antipad` cuts a
 * clearance of that diameter in every copper layer in between, so the via
 * passes through them unconnected. With `to` and `pitch` it is a row of vias
 * (a fence) from (x, y) towards `to`, `pitch` apart, the first at (x, y).
 */
export interface Via {
  id: string;
  x: Length;
  y: Length;
  drill: Length;
  between: [string, string];
  antipad?: Length;
  to?: Point;
  pitch?: Length;
}

export const COMPONENT_VALUE_KEYS = ['r_ohm', 'l_nh', 'c_pf'] as const;

export const BOARD_EDGES = ['x_min', 'x_max', 'y_min', 'y_max'] as const;

export type Boundary = { type: 'pml'; cells: number } | { type: 'pec' };
export const FACES = ['x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max'] as const;
export type Face = (typeof FACES)[number];

/**
 * Graded mesh: mesh lines on every copper edge parallel to an axis, on the
 * board outline, the port and every layer interface, so nothing snaps; cells
 * grow away from them by at most `max_growth` up to mesh.cell.
 */
export interface GradedMesh {
  /** Cell size at copper edges and copper layers. Edges closer than a quarter of this merge (with a warning). */
  edge_cell: Length;
  /** Cells across each dielectric layer, at least. */
  dielectric_cells: number;
  /** Largest ratio between neighbouring cells, e.g. 1.3. */
  max_growth: number;
}

export interface Project {
  noburf_project: 1;
  name: string;
  variables: Record<string, VariableDef>;
  /** Project materials, in addition to BUILTIN_MATERIALS. */
  materials: Record<string, DielectricMaterial | ConductorMaterial>;
  stackup: StackupLayer[];
  /** Board outline; dielectric layers exist only inside it. */
  board: { outline: Point[] };
  /** Shapes per copper layer name. Every copper layer has an entry. */
  geometry: Record<string, CopperShape[]>;
  /** One or more ports with unique ids. Every port is a matched load when it is not the excited one. */
  ports: Port[];
  /** Lumped R, L, C components, ids unique among ports and components. Absent: none. */
  components?: LumpedComponent[];
  /** Plated vias and via fences; ids unique among ports, components and vias. Absent: none. */
  vias?: Via[];
  boundaries: Record<Face, Boundary>;
  mesh: {
    /** Uniform cubic cell size; with `graded`, the largest cell anywhere. */
    cell: Length;
    /** Air between the board and the boundary layers, in multiples of `cell`. */
    air_margin_cells: { xy: number; below: number; above: number };
    /** Present: a graded mesh (see rasterise.ts). Absent: uniform cubic cells of `cell`. */
    graded?: GradedMesh;
    /**
     * true: slanted and curved copper edges are modelled by the fraction of
     * each cell they cover (conformal.ts) instead of a staircase. Absent: false.
     */
    conformal?: boolean;
  };
  analysis: {
    f_min_ghz: number;
    f_max_ghz: number;
    n_freq: number;
    /** Loss tangents become a conductivity that is exact at this frequency (see voxelize.ts). */
    loss_reference_ghz: number;
    /** Stop when field energy is this far below its peak, or at max_steps. */
    stop: { energy_decay_db: number; max_steps: number };
    /** Ids of the ports to excite, one solver run each. Absent: every port. */
    excite?: string[];
  };
  outputs: {
    /** Frequencies at which result.json reports Z_in. */
    zin_at_ghz: number[];
    /**
     * Frequencies at which to compute the far field (far_field.json), by a
     * near-to-far-field transform over a closed box in the air around the
     * board. Needs a PML on every face and at least
     * HUYGENS_MIN_AIR_MARGIN_CELLS of air margin on every side. Absent = no far field.
     */
    far_field_ghz?: number[];
    /**
     * Heights (mm) above the top copper layer at which to scan the near field,
     * like an EMC probe over the board: E and H on a plane of the solver's
     * nodes, at the field-plot frequencies. Each must land in the air between
     * the board and the PML. Absent = no scan.
     */
    near_field_mm?: number[];
    /**
     * Ports read as differential pairs: each entry is one end of a pair, its
     * positive and negative line. Results then include mixed-mode S, the
     * differential TDR and the skew (engine/differential.ts). Mode reference
     * impedances default to twice and half the ports' own. Post-processing
     * only: changing it never changes a solve.
     */
    differential_pairs?: DifferentialPairDef[];
  };
}

export interface DifferentialPairDef {
  id: string;
  positive: string;
  negative: string;
  differential_ohm?: number;
  common_ohm?: number;
}

export type BuiltinMaterial =
  | ({ kind: 'dielectric' } & DielectricMaterial)
  | ({ kind: 'conductor' } & ConductorMaterial)
  | { kind: 'pec' };

export const BUILTIN_MATERIALS: Readonly<Record<string, BuiltinMaterial>> = {
  'FR-4': { kind: 'dielectric', eps_r: 4.4, tan_delta: 0.02 },
  RO4003C: { kind: 'dielectric', eps_r: 3.55, tan_delta: 0.0027 },
  air: { kind: 'dielectric', eps_r: 1, tan_delta: 0 },
  pec: { kind: 'pec' },
  copper: { kind: 'conductor', conductivity_s_per_m: 5.8e7 },
};

export const PROJECT_SCHEMA_VERSION = 1;

export class ProjectError extends Error {}

export function fail(path: string, message: string): never {
  throw new ProjectError(`${path}: ${message}`);
}

/* ------------------------------------------------------------------------ */
/* Structural readers. Each takes the JSON path for its error messages.       */
/* ------------------------------------------------------------------------ */

const show = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

/**
 * A JSON object used as a map from names to values. JSON.parse makes
 * "__proto__" an ordinary key, but assigning it into a map would set the
 * prototype and drop the entry, so it is refused as a name.
 */
function readMap(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, `must be an object, got ${show(v)}`);
  if (Object.hasOwn(v, '__proto__')) fail(`${path}.__proto__`, '"__proto__" is a reserved name');
  return v as Record<string, unknown>;
}

export function readObject(v: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const o = readMap(v, path);
  for (const key of Object.keys(o)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(`${path}.${key}`, `unknown key (allowed: ${[...required, ...optional].join(', ')})`);
    }
  }
  for (const key of required) if (!Object.hasOwn(o, key)) fail(`${path}.${key}`, 'is required');
  return o;
}

function readArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, `must be an array, got ${show(v)}`);
  return v;
}

export function readString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.trim() === '') fail(path, `must be a non-empty string, got ${show(v)}`);
  return v;
}

export function readId(v: unknown, path: string): string {
  const s = readString(v, path);
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(s)) fail(path, `${show(s)} must be 1-32 letters, digits, "_" or "-"`);
  return s;
}

function readNumber(v: unknown, path: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `must be a finite number, got ${show(v)}`);
  if (v < lo || v > hi) fail(path, `${v} is out of range [${lo}, ${hi}]`);
  return v;
}

function readInteger(v: unknown, path: string, lo: number, hi: number): number {
  const n = readNumber(v, path, lo, hi);
  if (!Number.isInteger(n)) fail(path, `must be an integer, got ${n}`);
  return n;
}

/** Lengths are strings; a bare number is the most likely mistake, so name it. */
function readGradedMesh(v: unknown, path: string): GradedMesh {
  const o = readObject(v, path, ['edge_cell', 'dielectric_cells', 'max_growth']);
  return {
    edge_cell: readLength(o.edge_cell, `${path}.edge_cell`),
    dielectric_cells: readInteger(o.dielectric_cells, `${path}.dielectric_cells`, 1, 100),
    max_growth: readNumber(o.max_growth, `${path}.max_growth`, 1.01, 3),
  };
}

export function readLength(v: unknown, path: string): Length {
  if (typeof v === 'number') fail(path, `bare number ${v} is not a length; write it with a unit, e.g. "${v} mm"`);
  return readString(v, path);
}

function readPolygon(v: unknown, path: string): Point[] {
  const points = readArray(v, path);
  if (points.length < 3) fail(path, `a polygon needs at least 3 points, got ${points.length}`);
  return points.map((p, n) => {
    const xy = readArray(p, `${path}[${n}]`);
    if (xy.length !== 2) fail(`${path}[${n}]`, `a point is [x, y], got ${xy.length} values`);
    return [readLength(xy[0], `${path}[${n}][0]`), readLength(xy[1], `${path}[${n}][1]`)];
  });
}

export function readShape(v: unknown, path: string): CopperShape {
  const o = readObject(v, path, ['id', 'op', 'polygon']);
  if (o.op !== 'add' && o.op !== 'cut') fail(`${path}.op`, `must be "add" or "cut", got ${show(o.op)}`);
  return { id: readId(o.id, `${path}.id`), op: o.op, polygon: readPolygon(o.polygon, `${path}.polygon`) };
}

/** The project name ends up in file headers (Touchstone comments), so it is one printable line. */
function readName(v: unknown): string {
  const name = readString(v, '$.name');
  if (/[\u0000-\u001f\u007f]/.test(name)) fail('$.name', 'must not contain control characters or line breaks');
  return name;
}

function readVariable(v: unknown, path: string): VariableDef {
  const o = readObject(v, path, ['value'], ['min', 'max', 'locked']);
  const def: VariableDef = { value: readString(o.value, `${path}.value`) };
  if (o.min !== undefined) def.min = readString(o.min, `${path}.min`);
  if (o.max !== undefined) def.max = readString(o.max, `${path}.max`);
  if (o.locked !== undefined) {
    if (typeof o.locked !== 'boolean') fail(`${path}.locked`, `must be true or false, got ${show(o.locked)}`);
    def.locked = o.locked;
  }
  return def;
}

const MAX_POLES = 8;

function readPoleModel(v: unknown, path: string): PoleModel {
  const o = readObject(v, path, ['model', 'at_ghz', 'poles']);
  if (o.model !== 'poles') fail(`${path}.model`, `must be "poles" here, got ${show(o.model)}`);
  const poles = readArray(o.poles, `${path}.poles`).map((p, n): PoleDef => {
    const at = `${path}.poles[${n}]`;
    const type = readMap(p, at).type;
    if (type === 'debye') {
      const q = readObject(p, at, ['type', 'delta', 'f_relax_ghz']);
      return { type, delta: readNumber(q.delta, `${at}.delta`, 0, 1e5), f_relax_ghz: readNumber(q.f_relax_ghz, `${at}.f_relax_ghz`, 1e-9, 1e4) };
    }
    if (type === 'lorentz') {
      const q = readObject(p, at, ['type', 'delta', 'f_res_ghz', 'damping_ghz']);
      return {
        type, delta: readNumber(q.delta, `${at}.delta`, 0, 1e5),
        f_res_ghz: readNumber(q.f_res_ghz, `${at}.f_res_ghz`, 1e-9, 1e4), damping_ghz: readNumber(q.damping_ghz, `${at}.damping_ghz`, 0, 1e4),
      };
    }
    fail(`${at}.type`, `must be "debye" or "lorentz", got ${show(type)}`);
  });
  if (poles.length === 0 || poles.length > MAX_POLES) fail(`${path}.poles`, `needs 1 to ${MAX_POLES} poles, got ${poles.length}`);
  return { model: 'poles', at_ghz: readNumber(o.at_ghz, `${path}.at_ghz`, 1e-6, 1000), poles };
}

function readRoughness(v: unknown, path: string): RoughnessDef {
  const model = readMap(v, path).model;
  // Rms heights and sphere radii of copper foils run from about 0.1 um (very low profile) to 10 um.
  if (model === 'hammerstad' || model === 'groisse') {
    const o = readObject(v, path, ['model', 'rms_um']);
    return { model, rms_um: readNumber(o.rms_um, `${path}.rms_um`, 0.01, 50) };
  }
  if (model === 'huray') {
    const o = readObject(v, path, ['model', 'radius_um', 'surface_ratio']);
    return { model, radius_um: readNumber(o.radius_um, `${path}.radius_um`, 0.01, 50), surface_ratio: readNumber(o.surface_ratio, `${path}.surface_ratio`, 0, 50) };
  }
  fail(`${path}.model`, `must be "hammerstad", "groisse" or "huray", got ${show(model)}`);
}

const MAX_TABLE_ROWS = 200;

function readTable(v: unknown, path: string): TableModel {
  const o = readObject(v, path, ['model', 'points']);
  const points = readArray(o.points, `${path}.points`).map((p, n) => {
    const at = `${path}.points[${n}]`;
    const q = readObject(p, at, ['f_ghz', 'eps_r', 'tan_delta']);
    return { f_ghz: readNumber(q.f_ghz, `${at}.f_ghz`, 1e-6, 1000), eps_r: readNumber(q.eps_r, `${at}.eps_r`, 1, 100), tan_delta: readNumber(q.tan_delta, `${at}.tan_delta`, 0, 1) };
  });
  if (points.length < 2 || points.length > MAX_TABLE_ROWS) fail(`${path}.points`, `needs 2 to ${MAX_TABLE_ROWS} rows, got ${points.length}`);
  points.forEach((p, n) => {
    if (n > 0 && !(p.f_ghz > points[n - 1].f_ghz)) fail(`${path}.points[${n}].f_ghz`, `rows must be in increasing frequency; ${p.f_ghz} GHz follows ${points[n - 1].f_ghz} GHz`);
  });
  return { model: 'table', points };
}

function readDielectric(v: unknown, path: string): DielectricMaterial {
  const raw = readMap(v, path);
  const isTable = typeof raw.dispersion === 'object' && raw.dispersion !== null && (raw.dispersion as Record<string, unknown>).model === 'table';
  const values = ['eps_r', 'tan_delta'];
  const o = readObject(v, path, isTable ? [] : values, [...(isTable ? values : []), 'dispersion', 'mu_r', 'mu_tan_delta', 'mu_dispersion']);
  const table = isTable ? readTable(o.dispersion, `${path}.dispersion`) : undefined;
  // A table's middle row stands in for eps_r and tan_delta it leaves out.
  const middle = table?.points.reduce((best, p) => {
    const centre = Math.sqrt(table.points[0].f_ghz * table.points[table.points.length - 1].f_ghz);
    return Math.abs(Math.log(p.f_ghz / centre)) < Math.abs(Math.log(best.f_ghz / centre)) ? p : best;
  });
  const m: DielectricMaterial = {
    eps_r: middle && o.eps_r === undefined ? middle.eps_r : readNumber(o.eps_r, `${path}.eps_r`, 1, 100),
    tan_delta: middle && o.tan_delta === undefined ? middle.tan_delta : readNumber(o.tan_delta, `${path}.tan_delta`, 0, 1),
  };
  if (table) {
    m.dispersion = table;
  } else if (o.dispersion !== undefined) {
    const at = `${path}.dispersion`;
    const model = readMap(o.dispersion, at).model;
    if (model === 'djordjevic_sarkar') {
      const d = readObject(o.dispersion, at, ['model', 'at_ghz'], ['f_low_hz', 'f_high_hz']);
      m.dispersion = { model, at_ghz: readNumber(d.at_ghz, `${at}.at_ghz`, 1e-6, 1000) };
      if (d.f_low_hz !== undefined) m.dispersion.f_low_hz = readNumber(d.f_low_hz, `${at}.f_low_hz`, 1e-3, 1e15);
      if (d.f_high_hz !== undefined) m.dispersion.f_high_hz = readNumber(d.f_high_hz, `${at}.f_high_hz`, 1e-3, 1e15);
    } else if (model === 'conductivity') {
      readObject(o.dispersion, at, ['model'], []);
      m.dispersion = { model };
    } else if (model === 'poles') {
      m.dispersion = readPoleModel(o.dispersion, at);
    } else {
      fail(`${at}.model`, `must be "djordjevic_sarkar", "conductivity", "poles" or "table", got ${show(model)}`);
    }
  }
  if (o.mu_r !== undefined) m.mu_r = readNumber(o.mu_r, `${path}.mu_r`, 1, 1e5);
  if (o.mu_tan_delta !== undefined) m.mu_tan_delta = readNumber(o.mu_tan_delta, `${path}.mu_tan_delta`, 0, 10);
  if (o.mu_dispersion !== undefined) {
    if (m.mu_r === undefined) fail(`${path}.mu_dispersion`, 'needs mu_r, the permeability at its at_ghz');
    m.mu_dispersion = readPoleModel(o.mu_dispersion, `${path}.mu_dispersion`);
  }
  return m;
}

function readStackupLayer(v: unknown, path: string): StackupLayer {
  const type = readObject(v, path, ['type'], ['name', 'material', 'thickness']).type;
  if (type === 'copper') {
    const o = readObject(v, path, ['type', 'name', 'material'], ['thickness']);
    const layer: StackupLayer = { type, name: readId(o.name, `${path}.name`), material: readString(o.material, `${path}.material`) };
    return o.thickness === undefined ? layer : { ...layer, thickness: readLength(o.thickness, `${path}.thickness`) };
  }
  if (type === 'dielectric') {
    const o = readObject(v, path, ['type', 'name', 'material', 'thickness']);
    return {
      type,
      name: readId(o.name, `${path}.name`),
      material: readString(o.material, `${path}.material`),
      thickness: readLength(o.thickness, `${path}.thickness`),
    };
  }
  fail(`${path}.type`, `must be "copper" or "dielectric", got ${show(type)}`);
}

function readPort(v: unknown, path: string): Port {
  const kind = readObject(v, path, ['id', 'between', 'reference_impedance_ohm'], ['kind', 'x', 'y', 'edge', 'deembed']).kind;
  const common = (o: Record<string, unknown>) => {
    const between = readArray(o.between, `${path}.between`);
    if (between.length !== 2) fail(`${path}.between`, `must name exactly two copper layers, got ${between.length}`);
    return {
      id: readId(o.id, `${path}.id`),
      between: [readString(between[0], `${path}.between[0]`), readString(between[1], `${path}.between[1]`)] as [string, string],
      reference_impedance_ohm: readNumber(o.reference_impedance_ohm, `${path}.reference_impedance_ohm`, 1, 1e4),
    };
  };
  const point = (o: Record<string, unknown>) => ({ x: readLength(o.x, `${path}.x`), y: readLength(o.y, `${path}.y`) });
  if (kind === undefined || kind === 'lumped') {
    const o = readObject(v, path, ['id', 'x', 'y', 'between', 'reference_impedance_ohm'], ['kind', 'deembed']);
    const deembed = o.deembed === undefined ? {} : { deembed: { length: readLength(readObject(o.deembed, `${path}.deembed`, ['length']).length, `${path}.deembed.length`) } };
    return { ...(kind === undefined ? {} : { kind }), ...common(o), ...point(o), ...deembed };
  }
  if (kind === 'sma_edge') {
    const edge = readObject(v, path, ['kind', 'id', 'edge', 'between', 'reference_impedance_ohm'], ['x', 'y']).edge;
    if (!BOARD_EDGES.includes(edge as SmaEdgePort['edge'])) fail(`${path}.edge`, `must be one of ${BOARD_EDGES.map((e) => `"${e}"`).join(', ')}, got ${show(edge)}`);
    const along = (edge as string)[0] === 'y' ? 'x' : 'y';
    const o = readObject(v, path, ['kind', 'id', 'edge', along, 'between', 'reference_impedance_ohm']);
    return { kind, ...common(o), edge: edge as SmaEdgePort['edge'], [along]: readLength(o[along], `${path}.${along}`) };
  }
  if (kind === 'coax_probe') {
    const o = readObject(v, path, ['kind', 'id', 'x', 'y', 'between', 'reference_impedance_ohm']);
    return { kind, ...common(o), ...point(o) };
  }
  fail(`${path}.kind`, `must be "lumped", "sma_edge" or "coax_probe", got ${show(kind)}`);
}

function readComponentValue(o: Record<string, unknown>, path: string): ComponentValue {
  const value: ComponentValue = {};
  // From 1 mohm, 1 fH and 1 aF: smaller is a typo for a short (use copper) or nothing.
  const ranges = { r_ohm: [1e-3, 1e9], l_nh: [1e-6, 1e6], c_pf: [1e-6, 1e6] } as const;
  for (const key of COMPONENT_VALUE_KEYS) {
    if (o[key] !== undefined) value[key] = readNumber(o[key], `${path}.${key}`, ranges[key][0], ranges[key][1]);
  }
  const parts = COMPONENT_VALUE_KEYS.filter((key) => value[key] !== undefined).length;
  if (parts === 0) fail(path, 'a component needs at least one of r_ohm, l_nh, c_pf');
  if (o.connection !== undefined) {
    if (o.connection !== 'series' && o.connection !== 'parallel') fail(`${path}.connection`, `must be "series" or "parallel", got ${show(o.connection)}`);
    value.connection = o.connection;
  } else if (parts > 1) {
    fail(`${path}.connection`, 'is needed with more than one of r_ohm, l_nh, c_pf: "series" or "parallel"');
  }
  return value;
}

function readComponent(v: unknown, path: string): LumpedComponent {
  const valueKeys = [...COMPONENT_VALUE_KEYS, 'connection'];
  const o = readMap(v, path);
  if (Object.hasOwn(o, 'between')) {
    const c = readObject(v, path, ['id', 'x', 'y', 'between'], valueKeys);
    const between = readArray(c.between, `${path}.between`);
    if (between.length !== 2) fail(`${path}.between`, `must name exactly two copper layers, got ${between.length}`);
    return {
      id: readId(c.id, `${path}.id`),
      x: readLength(c.x, `${path}.x`),
      y: readLength(c.y, `${path}.y`),
      between: [readString(between[0], `${path}.between[0]`), readString(between[1], `${path}.between[1]`)],
      ...readComponentValue(c, path),
    };
  }
  if (Object.hasOwn(o, 'layer')) {
    const c = readObject(v, path, ['id', 'layer', 'from', 'to'], ['width', ...valueKeys]);
    const point = (key: 'from' | 'to'): Point => {
      const xy = readArray(c[key], `${path}.${key}`);
      if (xy.length !== 2) fail(`${path}.${key}`, `a point is [x, y], got ${xy.length} values`);
      return [readLength(xy[0], `${path}.${key}[0]`), readLength(xy[1], `${path}.${key}[1]`)];
    };
    return {
      id: readId(c.id, `${path}.id`),
      layer: readString(c.layer, `${path}.layer`),
      from: point('from'),
      to: point('to'),
      ...(c.width === undefined ? {} : { width: readLength(c.width, `${path}.width`) }),
      ...readComponentValue(c, path),
    };
  }
  fail(path, 'a component has either "between" (two copper layers, at x and y) or "layer" (one copper layer, from and to)');
}

function readVia(v: unknown, path: string): Via {
  const o = readObject(v, path, ['id', 'x', 'y', 'drill', 'between'], ['antipad', 'to', 'pitch']);
  const between = readArray(o.between, `${path}.between`);
  if (between.length !== 2) fail(`${path}.between`, `must name exactly two copper layers, got ${between.length}`);
  if ((o.to === undefined) !== (o.pitch === undefined)) fail(path, 'a via fence needs both "to" and "pitch"; a single via has neither');
  let to: Point | undefined;
  if (o.to !== undefined) {
    const xy = readArray(o.to, `${path}.to`);
    if (xy.length !== 2) fail(`${path}.to`, `a point is [x, y], got ${xy.length} values`);
    to = [readLength(xy[0], `${path}.to[0]`), readLength(xy[1], `${path}.to[1]`)];
  }
  return {
    id: readId(o.id, `${path}.id`),
    x: readLength(o.x, `${path}.x`),
    y: readLength(o.y, `${path}.y`),
    drill: readLength(o.drill, `${path}.drill`),
    between: [readString(between[0], `${path}.between[0]`), readString(between[1], `${path}.between[1]`)],
    ...(o.antipad === undefined ? {} : { antipad: readLength(o.antipad, `${path}.antipad`) }),
    ...(to === undefined ? {} : { to, pitch: readLength(o.pitch, `${path}.pitch`) }),
  };
}

function readBoundary(v: unknown, path: string): Boundary {
  const type = readObject(v, path, ['type'], ['cells']).type;
  if (type === 'pec') {
    readObject(v, path, ['type']);
    return { type };
  }
  if (type === 'pml') {
    const o = readObject(v, path, ['type', 'cells']);
    return { type, cells: readInteger(o.cells, `${path}.cells`, 1, 64) };
  }
  fail(`${path}.type`, `must be "pml" or "pec", got ${show(type)}`);
}

/** Most far-field frequencies per run: each adds a DFT over the whole box every step. */
export const MAX_FAR_FIELD_FREQUENCIES = 16;

function readFarFieldFrequencies(v: unknown, fMin: number, fMax: number, boundaries: Record<Face, Boundary>, margin: Project['mesh']['air_margin_cells']): number[] {
  const path = '$.outputs.far_field_ghz';
  const list = readArray(v, path);
  if (list.length === 0 || list.length > MAX_FAR_FIELD_FREQUENCIES) {
    fail(path, `needs 1 to ${MAX_FAR_FIELD_FREQUENCIES} frequencies, got ${list.length}; omit the key for no far field`);
  }
  const frequencies = list.map((f, n) => readNumber(f, `${path}[${n}]`, fMin, fMax));
  for (const face of FACES) {
    if (boundaries[face].type !== 'pml') fail(`$.boundaries.${face}`, 'the far field needs a PML on every face (it assumes open space around the box)');
  }
  for (const side of ['xy', 'below', 'above'] as const) {
    if (margin[side] < HUYGENS_MIN_AIR_MARGIN_CELLS) {
      fail(`$.mesh.air_margin_cells.${side}`, `the far field needs at least ${HUYGENS_MIN_AIR_MARGIN_CELLS} cells of air to fit its box between the board and the PML, got ${margin[side]}`);
    }
  }
  return frequencies;
}

/** Most near-field scan heights per run: each records two more planes every step. */
export const MAX_NEAR_FIELD_HEIGHTS = 4;

function readNearFieldHeights(v: unknown): number[] {
  const path = '$.outputs.near_field_mm';
  const list = readArray(v, path);
  if (list.length === 0 || list.length > MAX_NEAR_FIELD_HEIGHTS) {
    fail(path, `needs 1 to ${MAX_NEAR_FIELD_HEIGHTS} heights, got ${list.length}; omit the key for no near-field scan`);
  }
  const heights = list.map((h, n) => readNumber(h, `${path}[${n}]`, 0.001, 10_000));
  if (new Set(heights).size !== heights.length) fail(path, `heights repeat in [${heights.join(', ')}]`);
  return heights;
}

function readDifferentialPairs(v: unknown, portIds: string[]): DifferentialPairDef[] {
  const path = '$.outputs.differential_pairs';
  const list = readArray(v, path);
  if (list.length === 0) fail(path, 'names no pair; leave it out for none');
  const seenPorts = new Map<string, string>();
  const pairs = list.map((entry, n): DifferentialPairDef => {
    const at = `${path}[${n}]`;
    const o = readObject(entry, at, ['id', 'positive', 'negative'], ['differential_ohm', 'common_ohm']);
    const pair: DifferentialPairDef = { id: readId(o.id, `${at}.id`), positive: readId(o.positive, `${at}.positive`), negative: readId(o.negative, `${at}.negative`) };
    for (const side of ['positive', 'negative'] as const) {
      const id = pair[side];
      if (!portIds.includes(id)) fail(`${at}.${side}`, `"${id}" is not a port id (ports: ${portIds.join(', ')})`);
      if (seenPorts.has(id)) fail(`${at}.${side}`, `port "${id}" is already in pair "${seenPorts.get(id)}"`);
      seenPorts.set(id, pair.id);
    }
    if (o.differential_ohm !== undefined) pair.differential_ohm = readNumber(o.differential_ohm, `${at}.differential_ohm`, 1, 10_000);
    if (o.common_ohm !== undefined) pair.common_ohm = readNumber(o.common_ohm, `${at}.common_ohm`, 1, 10_000);
    return pair;
  });
  const ids = pairs.map((p) => p.id);
  ids.forEach((id, n) => {
    if (ids.indexOf(id) !== n) fail(`${path}[${n}].id`, `pair id "${id}" is used twice`);
  });
  return pairs;
}

/**
 * Validate a parsed JSON value as a project. Checks structure, then resolves
 * every expression and cross-reference (see resolve.ts), so a project that
 * parses is one the rasteriser can read. Throws ProjectError with the JSON path.
 */
export function parseProject(json: unknown): Project {
  const $ = readObject(json, '$', [
    'noburf_project', 'name', 'variables', 'materials', 'stackup', 'board',
    'geometry', 'ports', 'boundaries', 'mesh', 'analysis', 'outputs',
  ], ['components', 'vias']);
  if ($.noburf_project !== PROJECT_SCHEMA_VERSION) {
    fail('$.noburf_project', `unsupported schema version ${show($.noburf_project)}; this build reads version ${PROJECT_SCHEMA_VERSION}`);
  }

  const variables: Record<string, VariableDef> = {};
  for (const [name, def] of Object.entries(readMap($.variables, '$.variables'))) {
    const path = `$.variables.${name}`;
    if (!NAME_PATTERN.test(name)) fail(path, 'variable names are letters, digits and "_", not starting with a digit');
    if (Object.hasOwn(LENGTH_UNITS, name)) fail(path, `"${name}" is a unit and cannot be a variable name`);
    variables[name] = readVariable(def, path);
  }

  const materials: Record<string, DielectricMaterial | ConductorMaterial> = {};
  for (const [name, def] of Object.entries(readMap($.materials, '$.materials'))) {
    const path = `$.materials.${name}`;
    if (Object.hasOwn(BUILTIN_MATERIALS, name)) fail(path, `"${name}" is a built-in material and cannot be redefined`);
    if (Object.hasOwn(readMap(def, path), 'conductivity_s_per_m')) {
      const o = readObject(def, path, ['conductivity_s_per_m'], ['roughness']);
      const m: ConductorMaterial = { conductivity_s_per_m: readNumber(o.conductivity_s_per_m, `${path}.conductivity_s_per_m`, 1e3, 1e9) };
      if (o.roughness !== undefined) m.roughness = readRoughness(o.roughness, `${path}.roughness`);
      materials[name] = m;
      continue;
    }
    materials[name] = readDielectric(def, path);
  }

  const geometry: Record<string, CopperShape[]> = {};
  for (const [layer, shapes] of Object.entries(readMap($.geometry, '$.geometry'))) {
    geometry[layer] = readArray(shapes, `$.geometry.${layer}`).map((s, n) => readShape(s, `$.geometry.${layer}[${n}]`));
  }

  const b = readObject($.boundaries, '$.boundaries', FACES);
  const boundaries = Object.fromEntries(FACES.map((f) => [f, readBoundary(b[f], `$.boundaries.${f}`)])) as Record<Face, Boundary>;

  const mesh = readObject($.mesh, '$.mesh', ['cell', 'air_margin_cells'], ['graded', 'conformal']);
  if (mesh.conformal !== undefined && typeof mesh.conformal !== 'boolean') fail('$.mesh.conformal', `must be true or false, got ${show(mesh.conformal)}`);
  const margin = readObject(mesh.air_margin_cells, '$.mesh.air_margin_cells', ['xy', 'below', 'above']);
  // At least one cell of air keeps copper and the board off the box faces and the PML.
  const marginCells = (k: 'xy' | 'below' | 'above') => {
    const path = `$.mesh.air_margin_cells.${k}`;
    if (margin[k] === 0) fail(path, 'needs at least 1 cell of air between the board and the boundary');
    return readInteger(margin[k], path, 1, 1000);
  };

  const a = readObject($.analysis, '$.analysis', ['f_min_ghz', 'f_max_ghz', 'n_freq', 'loss_reference_ghz', 'stop'], ['excite']);
  const stop = readObject(a.stop, '$.analysis.stop', ['energy_decay_db', 'max_steps']);
  const fMin = readNumber(a.f_min_ghz, '$.analysis.f_min_ghz', 0.01, 1000);
  const fMax = readNumber(a.f_max_ghz, '$.analysis.f_max_ghz', 0.01, 1000);
  if (fMax <= fMin) fail('$.analysis.f_max_ghz', `${fMax} must be above f_min_ghz ${fMin}`);

  const outputs = readObject($.outputs, '$.outputs', ['zin_at_ghz'], ['far_field_ghz', 'near_field_mm', 'differential_pairs']);
  const zinAt = readArray(outputs.zin_at_ghz, '$.outputs.zin_at_ghz').map((f, n) => readNumber(f, `$.outputs.zin_at_ghz[${n}]`, fMin, fMax));

  const ports = readArray($.ports, '$.ports').map((p, n) => readPort(p, `$.ports[${n}]`));
  const boardObject = readObject($.board, '$.board', ['outline']);
  const airMargin = { xy: marginCells('xy'), below: marginCells('below'), above: marginCells('above') };
  const project: Project = {
    noburf_project: PROJECT_SCHEMA_VERSION,
    name: readName($.name),
    variables,
    materials,
    stackup: readArray($.stackup, '$.stackup').map((l, n) => readStackupLayer(l, `$.stackup[${n}]`)),
    board: { outline: readPolygon(boardObject.outline, '$.board.outline') },
    geometry,
    ports,
    ...($.components === undefined ? {} : { components: readArray($.components, '$.components').map((c, n) => readComponent(c, `$.components[${n}]`)) }),
    ...($.vias === undefined ? {} : { vias: readArray($.vias, '$.vias').map((v, n) => readVia(v, `$.vias[${n}]`)) }),
    boundaries,
    mesh: {
      cell: readLength(mesh.cell, '$.mesh.cell'),
      air_margin_cells: airMargin,
      ...(mesh.graded === undefined ? {} : { graded: readGradedMesh(mesh.graded, '$.mesh.graded') }),
      ...(mesh.conformal === undefined ? {} : { conformal: mesh.conformal as boolean }),
    },
    analysis: {
      f_min_ghz: fMin,
      f_max_ghz: fMax,
      n_freq: readInteger(a.n_freq, '$.analysis.n_freq', 2, 10_000),
      loss_reference_ghz: readNumber(a.loss_reference_ghz, '$.analysis.loss_reference_ghz', 0.01, 1000),
      stop: {
        energy_decay_db: readNumber(stop.energy_decay_db, '$.analysis.stop.energy_decay_db', 1, 200),
        max_steps: readInteger(stop.max_steps, '$.analysis.stop.max_steps', 1, 10_000_000),
      },
      ...(a.excite === undefined ? {} : { excite: readArray(a.excite, '$.analysis.excite').map((id, n) => readId(id, `$.analysis.excite[${n}]`)) }),
    },
    outputs: {
      zin_at_ghz: zinAt,
      ...(outputs.far_field_ghz === undefined ? {} : { far_field_ghz: readFarFieldFrequencies(outputs.far_field_ghz, fMin, fMax, boundaries, airMargin) }),
      ...(outputs.near_field_mm === undefined ? {} : { near_field_mm: readNearFieldHeights(outputs.near_field_mm) }),
      ...(outputs.differential_pairs === undefined ? {} : { differential_pairs: readDifferentialPairs(outputs.differential_pairs, ports.map((p) => p.id)) }),
    },
  };
  resolveProject(project);
  return project;
}
