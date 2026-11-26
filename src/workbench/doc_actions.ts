/**
 * Structural edits the inspector and tree offer: add, remove, rename and
 * reorder. Each takes the document and returns a new one; ProjectStore
 * validates the result, so an edit that breaks the project shows its error
 * and can be undone. Renames update every reference, so they never break one.
 */
import {
  BOARD_EDGES, BUILTIN_MATERIALS, COMPONENT_VALUE_KEYS, parseProject, type ArrayPortDrive, type ComponentValue, type CopperShape, type LumpedComponent, type LumpedPort, type Point, type Project,
  type SmaEdgePort, type StackupLayer,
} from '../project/schema';
import { evaluateLength, NAME_PATTERN } from '../project/expression';
import { arrayDrivesByPortId, excitedPortIds, keptArrayExcitation, resolveProject } from '../project/resolve';
import { libraryMaterial, projectMaterial } from './material_library';

type Doc = Project;

/** A name like `base` that is not in `taken`: base, base_2, base_3, ... */
/** Ids of ports, components and vias, which share one namespace. */
const ids = (doc: Doc) => [...doc.ports.map((p) => p.id), ...(doc.components ?? []).map((c) => c.id), ...(doc.vias ?? []).map((v) => v.id)];

export function freeName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

const copy = (doc: Doc): Doc => structuredClone(doc);
const allShapeIds = (doc: Doc) => Object.values(doc.geometry ?? {}).flat().map((s) => s.id);

/** Replaces variable `from` with `to` as a whole word in every expression of the document (and nowhere else: not in ids or layer names). */
function renameInExpressions(doc: Doc, from: string, to: string): void {
  const word = new RegExp(`(?<![A-Za-z0-9_])${from}(?![A-Za-z0-9_])`, 'g');
  const sub = (expr: string) => expr.replace(word, to);
  const points = (polygon: [string, string][]) => polygon.map(([x, y]) => [sub(x), sub(y)] as [string, string]);
  for (const v of Object.values(doc.variables)) {
    v.value = sub(v.value);
    if (v.min !== undefined) v.min = sub(v.min);
    if (v.max !== undefined) v.max = sub(v.max);
  }
  doc.stackup = doc.stackup.map((l) => (l.thickness === undefined ? l : { ...l, thickness: sub(l.thickness) }));
  doc.board.outline = points(doc.board.outline);
  for (const shapes of Object.values(doc.geometry)) for (const shape of shapes) shape.polygon = points(shape.polygon);
  doc.ports = doc.ports.map((p) => ({ ...p, ...(p.x === undefined ? {} : { x: sub(p.x) }), ...(p.y === undefined ? {} : { y: sub(p.y) }) }));
  doc.components = doc.components?.map((c) => ('between' in c
    ? { ...c, x: sub(c.x), y: sub(c.y) }
    : { ...c, from: [sub(c.from[0]), sub(c.from[1])], to: [sub(c.to[0]), sub(c.to[1])], ...(c.width === undefined ? {} : { width: sub(c.width) }) }));
  doc.vias = doc.vias?.map((v) => ({
    ...v, x: sub(v.x), y: sub(v.y), drill: sub(v.drill),
    ...(v.antipad === undefined ? {} : { antipad: sub(v.antipad) }),
    ...(v.to === undefined ? {} : { to: [sub(v.to[0]), sub(v.to[1])] as [string, string], pitch: sub(v.pitch!) }),
  }));
  doc.mesh.cell = sub(doc.mesh.cell);
  if (doc.mesh.graded) doc.mesh.graded.edge_cell = sub(doc.mesh.graded.edge_cell);
}

/** A rename onto a name already in use would merge two entries; refuse it. */
function assertFree(what: string, to: string, taken: string[]): void {
  if (taken.includes(to)) throw new Error(`There is already a ${what} called "${to}".`);
}

export function addVariable(doc: Doc): { doc: Doc; name: string } {
  const name = freeName('var', Object.keys(doc.variables ?? {}));
  const next = copy(doc);
  next.variables = { ...next.variables, [name]: { value: '1 mm' } };
  return { doc: next, name };
}

/** Renames a variable and every expression that uses it; keeps its place in the list. */
export function renameVariable(doc: Doc, from: string, to: string): Doc {
  if (from === to) return doc;
  assertFree('variable', to, Object.keys(doc.variables ?? {}));
  const next = copy(doc);
  next.variables = Object.fromEntries(Object.entries(next.variables).map(([k, v]) => [k === from ? to : k, v]));
  renameInExpressions(next, from, to);
  return next;
}

export function removeVariable(doc: Doc, name: string): Doc {
  const next = copy(doc);
  delete next.variables[name];
  return next;
}

/** A custom material with placeholder values, to be edited. */
export function addMaterial(doc: Doc, kind: 'dielectric' | 'conductor'): { doc: Doc; name: string } {
  const name = freeName(kind === 'dielectric' ? 'substrate' : 'metal', [...Object.keys(doc.materials ?? {}), ...Object.keys(BUILTIN_MATERIALS)]);
  const next = copy(doc);
  next.materials = { ...next.materials, [name]: kind === 'dielectric' ? { eps_r: 3, tan_delta: 0.002 } : { conductivity_s_per_m: 5.8e7 } };
  return { doc: next, name };
}

export function renameMaterial(doc: Doc, from: string, to: string): Doc {
  if (from === to) return doc;
  assertFree('material', to, [...Object.keys(doc.materials ?? {}), ...Object.keys(BUILTIN_MATERIALS)]);
  const next = copy(doc);
  next.materials = Object.fromEntries(Object.entries(next.materials).map(([k, v]) => [k === from ? to : k, v]));
  next.stackup = next.stackup.map((l) => (l.material === from ? { ...l, material: to } : l));
  return next;
}

/** Copies a library material into the project under its library name, unless the project already has one by that name. */
export function useLibraryMaterial(doc: Doc, name: string): Doc {
  if (Object.hasOwn(doc.materials ?? {}, name) || Object.hasOwn(BUILTIN_MATERIALS, name)) return doc;
  const entry = libraryMaterial(name);
  if (!entry) throw new Error(`"${name}" is not in the material library`);
  const next = copy(doc);
  next.materials = { ...next.materials, [name]: projectMaterial(entry) };
  return next;
}

export function removeMaterial(doc: Doc, name: string): Doc {
  const next = copy(doc);
  delete next.materials[name];
  return next;
}

/** A dielectric and a copper layer on top of the stackup, the copper layer empty. */
export function addLayerPair(doc: Doc): { doc: Doc; index: number } {
  const names = doc.stackup.map((l) => l.name);
  const dielectric = freeName('prepreg', names);
  const copper = freeName('l' + (doc.stackup.filter((l) => l.type === 'copper').length + 1), names);
  const next = copy(doc);
  next.stackup.push({ type: 'dielectric', name: dielectric, material: 'FR-4', thickness: '0.2 mm' }, { type: 'copper', name: copper, material: 'copper' });
  next.geometry = { ...next.geometry, [copper]: [] };
  return { doc: next, index: next.stackup.length - 1 };
}

/** Renames a layer and its geometry entry and port references. */
export function renameLayer(doc: Doc, index: number, to: string): Doc {
  const from = doc.stackup[index].name;
  if (from === to) return doc;
  assertFree('layer', to, doc.stackup.map((l) => l.name));
  const next = copy(doc);
  next.stackup[index] = { ...next.stackup[index], name: to };
  if (next.stackup[index].type === 'copper') {
    next.geometry = Object.fromEntries(Object.entries(next.geometry).map(([k, v]) => [k === from ? to : k, v]));
    next.ports = next.ports.map((p) => ({ ...p, between: p.between.map((b) => (b === from ? to : b)) as [string, string] }));
    next.components = next.components?.map((c) => ('between' in c
      ? { ...c, between: c.between.map((b) => (b === from ? to : b)) as [string, string] }
      : { ...c, layer: c.layer === from ? to : c.layer }));
    next.vias = next.vias?.map((v) => ({ ...v, between: v.between.map((b) => (b === from ? to : b)) as [string, string] }));
  }
  return next;
}

/** Removes a layer, and with a copper layer its shapes. Ports and components on it are left for the schema to flag. */
export function removeLayer(doc: Doc, index: number): Doc {
  const next = copy(doc);
  const [layer] = next.stackup.splice(index, 1);
  if (layer.type === 'copper') delete next.geometry[layer.name];
  return next;
}

export function moveLayer(doc: Doc, index: number, by: -1 | 1): Doc {
  const to = index + by;
  if (to < 0 || to >= doc.stackup.length) return doc;
  const next = copy(doc);
  [next.stackup[index], next.stackup[to]] = [next.stackup[to], next.stackup[index]];
  return next;
}

/** A 2 mm square at the board origin, painted on top of the layer. */
export function addRectangle(doc: Doc, layer: string): { doc: Doc; index: number } {
  const id = freeName(`${layer}_rect`, allShapeIds(doc));
  const shape: CopperShape = {
    id, op: 'add',
    polygon: [['-1 mm', '-1 mm'], ['1 mm', '-1 mm'], ['1 mm', '1 mm'], ['-1 mm', '1 mm']],
  };
  const next = copy(doc);
  next.geometry = { ...next.geometry, [layer]: [...(next.geometry[layer] ?? []), shape] };
  return { doc: next, index: next.geometry[layer].length - 1 };
}

const mmText = (v: number) => `${Number(v.toFixed(4))} mm`;

/** True when two edges that are not neighbours touch, or the outline encloses no area. */
function crossesItself(points: Array<[number, number]>): boolean {
  const n = points.length;
  let twiceArea = 0;
  for (let i = 0; i < n; i++) {
    const [a, b] = [points[i], points[(i + 1) % n]];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  if (Math.abs(twiceArea) < 1e-9) return true;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsTouch(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

type P = [number, number];
const side = (p: P, q: P, r: P) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
/** r lies on segment pq, given that the three are collinear. */
const within = (p: P, q: P, r: P) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);

function segmentsTouch(a: P, b: P, c: P, d: P): boolean {
  const [d1, d2, d3, d4] = [side(a, b, c), side(a, b, d), side(c, d, a), side(c, d, b)];
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  // An end point lying on the other segment: a T, or collinear edges that overlap.
  return (d1 === 0 && within(a, b, c)) || (d2 === 0 && within(a, b, d)) || (d3 === 0 && within(c, d, a)) || (d4 === 0 && within(c, d, b));
}

/** A copper shape drawn with the mouse: its corners in mm, as plain lengths. */
export function addDrawnShape(doc: Doc, layer: string, points: Array<[number, number]>): { doc: Doc; index: number } {
  if (points.length < 3) throw new Error('a shape needs at least three corners');
  if (crossesItself(points)) throw new Error('the outline crosses itself or has no area');
  const shape: CopperShape = { id: freeName(`${layer}_shape`, allShapeIds(doc)), op: 'add', polygon: points.map(([x, y]): Point => [mmText(x), mmText(y)]) };
  const next = copy(doc);
  next.geometry = { ...next.geometry, [layer]: [...(next.geometry[layer] ?? []), shape] };
  return { doc: next, index: next.geometry[layer].length - 1 };
}

/**
 * A lumped port placed with the mouse on a copper layer: from the nearest
 * copper layer below it up to that layer, or from the layer up to the next
 * one when it is the bottom layer.
 */
export function addPortAt(doc: Doc, layer: string, at: [number, number]): { doc: Doc; index: number } {
  const copper = doc.stackup.filter((l) => l.type === 'copper').map((l) => l.name);
  const n = copper.indexOf(layer);
  if (n < 0 || copper.length < 2) throw new Error('a port needs two copper layers');
  const between: [string, string] = n > 0 ? [copper[n - 1], layer] : [layer, copper[1]];
  const { doc: withPort, index } = addPort(doc);
  withPort.ports[index] = { ...(withPort.ports[index] as LumpedPort), x: mmText(at[0]), y: mmText(at[1]), between };
  return { doc: withPort, index };
}

/** The corners of a shape when every coordinate is a plain length ("12.4 mm"), else null: the shape is already driven by variables. */
function plainCorners(shape: CopperShape): Array<[number, number]> | null {
  const noVariables = (name: string): never => { throw new Error(`uses variable ${name}`); };
  try {
    return shape.polygon.map(([x, y]): [number, number] => [evaluateLength(x, noVariables), evaluateLength(y, noVariables)]);
  } catch {
    return null;
  }
}

/** Rounded to the 1 nm the importers write, so a corner read through a unit conversion still matches its neighbour. */
const toNm = (v: number) => Math.round(v * 1e6) / 1e6;

/** The extent of a plain rectangle with edges along x and y (a repeated closing corner allowed), else null. */
function plainRectangle(shape: CopperShape): { corners: Array<[number, number]>; x0: number; x1: number; y0: number; y1: number } | null {
  let corners = plainCorners(shape)?.map(([x, y]): [number, number] => [toNm(x), toNm(y)]);
  if (corners && corners.length === 5 && corners[0][0] === corners[4][0] && corners[0][1] === corners[4][1]) corners = corners.slice(0, 4);
  if (!corners || corners.length !== 4) return null;
  const xs = [...new Set(corners.map((c) => c[0]))];
  const ys = [...new Set(corners.map((c) => c[1]))];
  const alongAxes = corners.every((c, n) => { const d = corners[(n + 1) % 4]; return c[0] === d[0] || c[1] === d[1]; });
  if (xs.length !== 2 || ys.length !== 2 || !alongAxes) return null;
  return { corners, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Whether makeRectangleEditable applies: a rectangle along x and y whose corners are plain lengths. */
export function canMakeEditable(shape: CopperShape): boolean {
  return plainRectangle(shape) !== null;
}

/** Which part of a rectangle stays put along one axis when it is resized: its low edge, its middle or its high edge. */
export type Anchor = 'min' | 'mid' | 'max';
/** Per axis: a fixed anchor, or `auto`: the edges touching other copper or a port. */
export type AnchorChoice = Anchor | 'auto';
/** A line for the message log about what Make editable did. */
export interface EditableNote { kind: 'info' | 'warning'; text: string }

/**
 * What touches an edge of the rectangle: the expression placing the other
 * copper's edge or the port there, whether it uses variables (so it can move),
 * and what it is. `near` marks a port inside the rectangle near this edge
 * rather than on it.
 */
interface Touch { expr: string; parametric: boolean; what: string; near?: boolean }
type Edge = 'x0' | 'x1' | 'y0' | 'y1';

const isPlain = (expr: string) => { try { evaluateLength(expr, (n) => { throw new Error(n); }); return true; } catch { return false; } };

/**
 * For each of the rectangle's four edges, what touches it on the same layer:
 * an edge of another `add` shape lying on the same line and overlapping it, or
 * a port standing on it (or inside the rectangle, for its nearer edge). A
 * touch placed by variables wins over a plain one. Ports count only on the
 * upper of their two layers, the signal side: the ground plane under a port
 * must not follow it. Null when the project does not resolve.
 */
function touches(doc: Doc, layer: string, index: number, r: { x0: number; x1: number; y0: number; y1: number }): Record<Edge, Touch | null> | null {
  let resolved;
  try {
    resolved = resolveProject(parseProject(doc));
  } catch {
    return null;
  }
  const found: Record<Edge, Touch | null> = { x0: null, x1: null, y0: null, y1: null };
  const offer = (key: Edge, t: Touch) => {
    const had = found[key];
    if (!had || (had.near && !t.near) || (t.parametric && !had.parametric && !!had.near === !!t.near)) found[key] = t;
  };
  const overlaps = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 1e-9;
  const own = resolved.copper[layer][index].polygon.map(([x, y]) => `${toNm(x)},${toNm(y)}`).sort().join(' ');
  doc.geometry[layer].forEach((other, n) => {
    if (n === index || other.op !== 'add') return;
    const points = resolved.copper[layer][n].polygon.map(([x, y]): [number, number] => [toNm(x), toNm(y)]);
    if (points.map(([x, y]) => `${x},${y}`).sort().join(' ') === own) return; // a duplicate lying on top
    points.forEach((p, m) => {
      const q = points[(m + 1) % points.length];
      const [ep, eq] = [other.polygon[m], other.polygon[(m + 1) % points.length]];
      // The edge's coordinate as written: the end that uses variables, if either does.
      const exprOf = (k: 0 | 1) => (isPlain(ep[k]) ? eq[k] : ep[k]);
      if (p[0] === q[0] && overlaps(r.y0, r.y1, Math.min(p[1], q[1]), Math.max(p[1], q[1]))) {
        for (const key of ['x0', 'x1'] as const) if (p[0] === r[key]) offer(key, { expr: exprOf(0), parametric: !isPlain(exprOf(0)), what: `shape "${other.id}"` });
      }
      if (p[1] === q[1] && overlaps(r.x0, r.x1, Math.min(p[0], q[0]), Math.max(p[0], q[0]))) {
        for (const key of ['y0', 'y1'] as const) if (p[1] === r[key]) offer(key, { expr: exprOf(1), parametric: !isPlain(exprOf(1)), what: `shape "${other.id}"` });
      }
    });
  });
  const copperZ = doc.stackup.filter((l) => l.type === 'copper').map((l) => l.name);
  doc.ports.forEach((port, n) => {
    if (port.kind === 'sma_edge' || !port.between.includes(layer)) return;
    const upper = copperZ.indexOf(port.between[0]) > copperZ.indexOf(port.between[1]) ? port.between[0] : port.between[1];
    if (upper !== layer) return;
    const at = resolved.ports[n];
    const [px, py] = [toNm(at.xMm), toNm(at.yMm)];
    if (px < r.x0 || px > r.x1 || py < r.y0 || py > r.y1) return;
    const what = `port "${port.id}"`;
    for (const [lo, hi, v, expr] of [['x0', 'x1', px, port.x], ['y0', 'y1', py, port.y]] as const) {
      if (v === r[lo] || v === r[hi]) offer(v === r[lo] ? lo : hi, { expr, parametric: !isPlain(expr), what });
      else offer(v - r[lo] <= r[hi] - v ? lo : hi, { expr, parametric: false, what, near: true });
    }
  });
  return found;
}

/**
 * Turns a plain axis-aligned rectangle (drawn, or imported from Gerber, DXF
 * or STEP) into one driven by variables. Along each axis:
 *
 * - With an anchor (low edge, middle, high edge), that part stays put, held by
 *   a new locked variable (`_x`, `_y`), and the size (`_dx`, `_dy`) is free.
 * - With `auto`, the edges touching other copper or a port decide. Both edges
 *   touching (a feed from its port to its patch): each is written as what it
 *   touches, and there is no size to tune, so the length follows both. One
 *   edge touching: that edge stays put, written as the other copper's or the
 *   port's expression when that uses variables (so it follows them), else
 *   held by a locked variable. A port inside the rectangle keeps the nearer
 *   edge. Nothing touching: the low edge, and the log says so.
 *
 * Sizes get no min or max: the user sets the range the tuner may use, and
 * until then the workbench flags them and `design new --from` refuses the
 * project. Plain corners stay where they were (to 1 nm; a middle anchor to
 * 0.1 nm). Copper made editable earlier that touches this rectangle does not
 * follow it: this is attachment, not a constraint solver.
 */
export function makeRectangleEditable(doc: Doc, layer: string, index: number, anchor: { x: AnchorChoice; y: AnchorChoice } = { x: 'auto', y: 'auto' }):
  { doc: Doc; variables: string[]; notes: EditableNote[] } {
  const shape = doc.geometry[layer]?.[index];
  if (!shape) throw new Error(`no shape ${index + 1} on layer "${layer}"`);
  const rect = plainRectangle(shape);
  if (!rect) throw new Error(`"${shape.id}" is not a plain rectangle with edges along x and y, or is already sized by variables.`);
  const { corners } = rect;
  const cleaned = shape.id.replace(/[^A-Za-z0-9_]/g, '_'); // imported shapes are named top-1, top-2, ...
  const base = NAME_PATTERN.test(cleaned) ? cleaned : `shape_${cleaned}`;
  const taken = Object.keys(doc.variables ?? {});
  const name = (suffix: string) => { const n = freeName(`${base}_${suffix}`, taken); taken.push(n); return n; };
  const auto = anchor.x === 'auto' || anchor.y === 'auto';
  const touching = auto ? touches(doc, layer, index, rect) : null;
  const notes: EditableNote[] = [];
  if (auto && !touching) notes.push({ kind: 'warning', text: 'the project has errors, so touching copper could not be traced; kept the left and bottom edges' });
  const next = copy(doc);
  const variables: string[] = [];
  const edgeName = (ax: 'x' | 'y', side: 'min' | 'max') => (ax === 'x' ? (side === 'min' ? 'left' : 'right') : side === 'min' ? 'bottom' : 'top');
  /** The expressions for the low and high coordinate along one axis. */
  const axis = (ax: 'x' | 'y'): [lo: string, hi: string] => {
    const [lo, hi] = ax === 'x' ? [rect.x0, rect.x1] : [rect.y0, rect.y1];
    const fixedAt = (choice: Anchor): string => {
      const fixed = name(ax);
      const value = choice === 'min' ? lo : choice === 'max' ? hi : Math.round(((lo + hi) / 2) * 1e7) / 1e7;
      next.variables[fixed] = { value: `${value} mm`, locked: true };
      variables.push(fixed);
      return fixed;
    };
    const sized = (at: string, choice: Anchor): [string, string] => {
      const size = name(`d${ax}`);
      next.variables[size] = { value: `${toNm(hi - lo)} mm` };
      variables.push(size);
      if (choice === 'min') return [at, `${at} + ${size}`];
      if (choice === 'max') return [`${at} - ${size}`, at];
      return [`${at} - ${size} / 2`, `${at} + ${size} / 2`];
    };
    const choice = anchor[ax];
    if (choice !== 'auto') return sized(fixedAt(choice), choice);
    const tLo = touching?.[`${ax}0`] ?? null;
    const tHi = touching?.[`${ax}1`] ?? null;
    if (tLo && tHi && !tLo.near && !tHi.near) {
      // Both ends are connected: the length is set by what they touch, not tuned.
      const end = (t: Touch, v: number) => (t.parametric ? `(${t.expr})` : `${toNm(v)} mm`);
      const follows = [tLo, tHi].filter((t) => t.parametric).map((t) => t.what);
      notes.push({ kind: 'info', text: `its ${edgeName(ax, 'min')} and ${edgeName(ax, 'max')} edges touch ${tLo.what} and ${tHi.what}, so its size along ${ax} is not tuned` +
        (follows.length ? `; it follows ${follows.join(' and ')}` : '') });
      return [end(tLo, lo), end(tHi, hi)];
    }
    // One side: an edge on something beats a port inside; variables beat plain; else the low edge.
    const real = [tLo && !tLo.near ? 'min' : null, tHi && !tHi.near ? 'max' : null].filter(Boolean) as Array<'min' | 'max'>;
    const side: 'min' | 'max' = real.length ? real[0] : tLo ? 'min' : tHi ? 'max' : 'min';
    const t = side === 'min' ? tLo : tHi;
    if (!t) {
      if (touching) notes.push({ kind: 'info', text: `nothing touches it along ${ax}; kept its ${edgeName(ax, 'min')} edge` });
      return sized(fixedAt('min'), 'min');
    }
    if (t.parametric) {
      notes.push({ kind: 'info', text: `attached its ${edgeName(ax, side)} edge to ${t.what}, so it follows it` });
      return sized(`(${t.expr})`, side);
    }
    notes.push({ kind: 'info', text: t.near ? `kept its ${edgeName(ax, side)} edge, the one nearer ${t.what}; a large change can leave the port off the copper` : `kept its ${edgeName(ax, side)} edge, which touches ${t.what}` });
    return sized(fixedAt(side), side);
  };
  const [xLo, xHi] = axis('x');
  const [yLo, yHi] = axis('y');
  next.geometry[layer][index].polygon = corners.map(([cx, cy]): Point => [cx === rect.x0 ? xLo : xHi, cy === rect.y0 ? yLo : yHi]);
  return { doc: next, variables, notes };
}

export function duplicateShape(doc: Doc, layer: string, index: number): { doc: Doc; index: number } {
  const next = copy(doc);
  const source = next.geometry[layer][index];
  next.geometry[layer].splice(index + 1, 0, { ...structuredClone(source), id: freeName(source.id, allShapeIds(doc)) });
  return { doc: next, index: index + 1 };
}

export function removeShape(doc: Doc, layer: string, index: number): Doc {
  const next = copy(doc);
  next.geometry[layer].splice(index, 1);
  return next;
}

/** Where a polygon lives: a copper shape, or the board outline. */
export type PolygonOwner = { layer: string; shape: number } | 'board';

const polygonOf = (doc: Doc, owner: PolygonOwner): Point[] => (owner === 'board' ? doc.board.outline : doc.geometry[owner.layer][owner.shape].polygon);

/** Inserts a copy of point `after` right after it, ready to be moved. */
export function addPoint(doc: Doc, owner: PolygonOwner, after: number): Doc {
  const next = copy(doc);
  const polygon = polygonOf(next, owner);
  polygon.splice(after + 1, 0, [...polygon[after]] as Point);
  return next;
}

export function removePoint(doc: Doc, owner: PolygonOwner, point: number): Doc {
  const next = copy(doc);
  polygonOf(next, owner).splice(point, 1);
  return next;
}

/** A port at the origin between the two lowest copper layers. */
export function addPort(doc: Doc): { doc: Doc; index: number } {
  const copperLayers = doc.stackup.filter((l): l is Extract<StackupLayer, { type: 'copper' }> => l.type === 'copper').map((l) => l.name);
  const port: LumpedPort = {
    id: freeName('port', ids(doc)),
    x: '0 mm', y: '0 mm',
    between: [copperLayers[0] ?? 'gnd', copperLayers[1] ?? 'top'],
    reference_impedance_ohm: doc.ports[0]?.reference_impedance_ohm ?? 50,
  };
  const next = copy(doc);
  next.ports.push(port);
  return { doc: next, index: next.ports.length - 1 };
}

/**
 * Switches a port between a lumped port and an SMA edge connector. The
 * connector sits on the board's lower y edge, so it has no y; its layers are
 * [top copper, a ground layer below it]. It must be the project's only port,
 * and needs a graded mesh, a PML on y min and room for its body in the air
 * around the board: those are set here, the air from what rasterise asks for.
 */
/** A graded mesh, which coax ports need, unless the project has one. */
const DEFAULT_GRADED = { edge_cell: '0.25 mm', dielectric_cells: 6, max_growth: 1.3 };

/** [top copper, bottom copper] names, or an error naming what the port needs. */
function outerCopper(doc: Doc, what: string): [string, string, string[]] {
  const copper = doc.stackup.filter((l) => l.type === 'copper').map((l) => l.name);
  if (copper.length < 2) throw new Error(`${what} needs two copper layers.`);
  return [copper.at(-1)!, copper[0], copper];
}

/** Where a port sits, in mm, and the board's bounds; null while the project doesn't resolve. */
function portPlacement(doc: Doc, index: number): { xMm: number; yMm: number; bounds: Record<SmaEdgePort['edge'], number> } | null {
  try {
    const r = resolveProject(parseProject(doc));
    const xs = r.boardOutline.map((q) => q[0]);
    const ys = r.boardOutline.map((q) => q[1]);
    const { xMm, yMm } = r.ports[index];
    return { xMm, yMm, bounds: { x_min: Math.min(...xs), x_max: Math.max(...xs), y_min: Math.min(...ys), y_max: Math.max(...ys) } };
  } catch {
    return null;
  }
}

/**
 * Changes a port's kind, keeping its name, reference impedance and as much of
 * its position as the new kind has. A coax port gets the PML and graded mesh
 * it needs; the air it needs is added when the project is meshed.
 */
export function setPortKind(doc: Doc, index: number, kind: string): Doc {
  const port = doc.ports[index];
  if ((port.kind ?? 'lumped') === kind) return doc;
  const next = copy(doc);
  const { id, reference_impedance_ohm } = port;
  const placed = portPlacement(doc, index);
  // An SMA has only its offset along the edge; the other coordinate is the edge itself.
  const x = port.x ?? (placed ? mmText(placed.xMm) : '0 mm');
  const y = port.y ?? (placed ? mmText(placed.yMm) : '0 mm');
  if (kind === 'sma_edge') {
    const [top, , copper] = outerCopper(next, 'An SMA connector');
    // The pin rests on the top copper; the body bonds to the port's other layer, or the copper layer under the top one.
    const ground = port.between.find((name) => name !== top && copper.includes(name)) ?? copper.at(-2)!;
    // The board edge nearest the port, so the ports at both ends of a line land on opposite edges.
    const edge = placed
      ? BOARD_EDGES.reduce((best, e) => (Math.abs((e[0] === 'x' ? placed.xMm : placed.yMm) - placed.bounds[e]) < Math.abs((best[0] === 'x' ? placed.xMm : placed.yMm) - placed.bounds[best]) ? e : best))
      : 'y_min';
    next.ports[index] = { kind: 'sma_edge', id, edge, ...(edge[0] === 'y' ? { x } : { y }), between: [top, ground], reference_impedance_ohm };
    if (next.boundaries[edge]?.type !== 'pml') next.boundaries[edge] = { type: 'pml', cells: 8 };
    next.mesh.graded ??= { ...DEFAULT_GRADED };
  } else if (kind === 'coax_probe') {
    const [top, bottom, copper] = outerCopper(next, 'A coax probe');
    // The shield is the bottom copper; the pin ends on the port's other layer, or the top.
    const signal = port.between.find((name) => name !== bottom && copper.includes(name)) ?? top;
    next.ports[index] = { kind: 'coax_probe', id, x, y, between: [signal, bottom], reference_impedance_ohm };
    if (next.boundaries.z_min?.type !== 'pml') next.boundaries.z_min = { type: 'pml', cells: 8 };
    next.mesh.graded ??= { ...DEFAULT_GRADED };
  } else if (kind === 'lumped') {
    // Coax ports list [signal, ground]; a lumped port runs from the lower layer to the upper one.
    next.ports[index] = { id, x, y, between: [port.between[1], port.between[0]], reference_impedance_ohm };
  } else {
    throw new Error(`unknown port kind "${kind}"`);
  }
  return next;
}

/** Moves an SMA connector to another board edge: it keeps its offset along the edge, and that face becomes a PML. */
export function setSmaEdge(doc: Doc, index: number, edge: SmaEdgePort['edge']): Doc {
  const port = doc.ports[index];
  if (port.kind !== 'sma_edge' || port.edge === edge) return doc;
  const next = copy(doc);
  const along = port.x ?? port.y ?? '0 mm';
  const { x: _x, y: _y, ...rest } = port;
  next.ports[index] = { ...rest, edge, ...(edge[0] === 'y' ? { x: along } : { y: along }) };
  if (next.boundaries[edge]?.type !== 'pml') next.boundaries[edge] = { type: 'pml', cells: 8 };
  return next;
}

export function renamePort(doc: Doc, index: number, to: string): Doc {
  const from = doc.ports[index].id;
  if (from === to) return doc;
  assertFree('port, component or via', to, ids(doc));
  const next = copy(doc);
  next.ports[index] = { ...next.ports[index], id: to };
  if (next.analysis.excite) next.analysis.excite = next.analysis.excite.map((id) => (id === from ? to : id));
  if (next.outputs.differential_pairs) {
    const renamed = (id: string) => (id === from ? to : id);
    next.outputs.differential_pairs = next.outputs.differential_pairs.map((p) => ({ ...p, positive: renamed(p.positive), negative: renamed(p.negative) }));
  }
  const drives = next.outputs.array_excitation;
  if (drives && from in drives) {
    next.outputs.array_excitation = Object.fromEntries(Object.entries(drives).map(([id, drive]) => [id === from ? to : id, drive]));
  }
  return next;
}

export function removePort(doc: Doc, index: number): Doc {
  const next = copy(doc);
  const [port] = next.ports.splice(index, 1);
  if (next.analysis.excite) {
    next.analysis.excite = next.analysis.excite.filter((id) => id !== port.id);
    if (next.analysis.excite.length === 0) delete next.analysis.excite;
  }
  // A pair with one line gone is no pair: drop it, and the list when it empties.
  if (next.outputs.differential_pairs) {
    next.outputs.differential_pairs = next.outputs.differential_pairs.filter((p) => p.positive !== port.id && p.negative !== port.id);
    if (next.outputs.differential_pairs.length === 0) delete next.outputs.differential_pairs;
  }
  return keepArrayDrivesOf(next, (id) => id !== port.id);
}

/**
 * Sets the excited ports (undefined: every port). A port that is no longer
 * excited loses its far-field drive, since only an excited port can be driven;
 * a port excited again is driven again at amplitude 1, phase 0, as it would be
 * without a drive map.
 */
export function setExcitedPorts(doc: Doc, portIdsToExcite: string[] | undefined): Doc {
  const next = copy(doc);
  const excitedBefore = excitedPortIds(doc);
  if (portIdsToExcite) next.analysis.excite = portIdsToExcite;
  else delete next.analysis.excite;
  const excitedAfter = excitedPortIds(next);
  const drives = next.outputs.array_excitation;
  if (drives) {
    for (const portId of excitedAfter) if (!excitedBefore.includes(portId) && !drives[portId]) drives[portId] = { amplitude: 1, phase_deg: 0 };
  }
  return keepArrayDrivesOf(next, (portId) => excitedAfter.includes(portId));
}

/** No far field, and so no port drives either: they weight the far field only. */
export function clearFarField(doc: Doc): Doc {
  const next = copy(doc);
  delete next.outputs.far_field_ghz;
  delete next.outputs.array_excitation;
  return next;
}

/**
 * Sets one port's far-field drive, its amplitude or its phase in degrees.
 * Without outputs.array_excitation every excited port is driven at amplitude
 * 1, phase 0, so those drives are written first and the other ports keep
 * theirs. A port the map leaves out is off; setting its phase alone keeps it
 * off. The value goes in as given: the schema reports one that is not a number.
 */
export function setPortDrive(doc: Doc, portId: string, part: 'amplitude' | 'phase_deg', value: unknown): Doc {
  const next = copy(doc);
  const drives = arrayDrivesByPortId(next);
  const current: ArrayPortDrive | undefined = drives[portId];
  drives[portId] = { ...(current ?? { amplitude: 0 }), [part]: value } as ArrayPortDrive;
  next.outputs.array_excitation = drives;
  return next;
}

/** Keeps the far-field drives of the ports that pass (resolve.ts keptArrayExcitation). */
function keepArrayDrivesOf(next: Doc, keepPort: (portId: string) => boolean): Doc {
  const drives = next.outputs.array_excitation;
  if (!drives) return next;
  const kept = keptArrayExcitation(drives, keepPort, next.ports.length);
  if (kept) next.outputs.array_excitation = kept;
  else delete next.outputs.array_excitation;
  return next;
}

/* ------------------------------------------------------------------------ */
/* Lumped components                                                         */
/* ------------------------------------------------------------------------ */

const copperNames = (doc: Doc) => doc.stackup.filter((l) => l.type === 'copper').map((l) => l.name);

/** The value part of a component (r_ohm, l_nh, c_pf, connection), without its placement. */
function componentValue(c: LumpedComponent): ComponentValue {
  const value: ComponentValue = {};
  for (const key of COMPONENT_VALUE_KEYS) if (c[key] !== undefined) value[key] = c[key];
  if (c.connection !== undefined) value.connection = c.connection;
  return value;
}

/** A 50 ohm resistor at the origin from the lowest copper layer to the next one up, like a new port. */
export function addComponent(doc: Doc): { doc: Doc; index: number } {
  const copper = copperNames(doc);
  if (copper.length < 2) throw new Error('A component between layers needs two copper layers.');
  const next = copy(doc);
  next.components = [...(next.components ?? []), { id: freeName('R1', ids(doc)), x: '0 mm', y: '0 mm', between: [copper[0], copper[1]], r_ohm: 50 }];
  return { doc: next, index: next.components.length - 1 };
}

export function removeComponent(doc: Doc, index: number): Doc {
  const next = copy(doc);
  next.components!.splice(index, 1);
  // No components: no key, as in a file written by hand.
  if (next.components!.length === 0) delete next.components;
  return next;
}

export function renameComponent(doc: Doc, index: number, to: string): Doc {
  const from = doc.components![index].id;
  if (from === to) return doc;
  assertFree('port, component or via', to, ids(doc));
  const next = copy(doc);
  next.components![index] = { ...next.components![index], id: to };
  return next;
}

/* ------------------------------------------------------------------------ */
/* Vias                                                                      */
/* ------------------------------------------------------------------------ */

/** A 0.3 mm via at the origin from the top copper layer to the bottom one: the commonest stitching via. */
export function addVia(doc: Doc): { doc: Doc; index: number } {
  const copper = copperNames(doc);
  if (copper.length < 2) throw new Error('A via needs two copper layers.');
  const next = copy(doc);
  next.vias = [...(next.vias ?? []), { id: freeName('V1', ids(doc)), x: '0 mm', y: '0 mm', drill: '0.3 mm', between: [copper.at(-1)!, copper[0]] }];
  return { doc: next, index: next.vias.length - 1 };
}

export function removeVia(doc: Doc, index: number): Doc {
  const next = copy(doc);
  next.vias!.splice(index, 1);
  if (next.vias!.length === 0) delete next.vias;
  return next;
}

export function renameVia(doc: Doc, index: number, to: string): Doc {
  if (doc.vias![index].id === to) return doc;
  assertFree('port, component or via', to, ids(doc));
  const next = copy(doc);
  next.vias![index] = { ...next.vias![index], id: to };
  return next;
}

/** One via, or a fence of them from (x, y) to a point 10 mm along x, 1 mm apart. */
export function setViaFence(doc: Doc, index: number, kind: string): Doc {
  const v = doc.vias![index];
  if ((v.to === undefined ? 'single' : 'fence') === kind) return doc;
  const next = copy(doc);
  const { to: _to, pitch: _pitch, ...single } = v;
  if (kind === 'single') next.vias![index] = single;
  else if (kind === 'fence') next.vias![index] = { ...single, to: [`${v.x} + 10 mm`, v.y], pitch: '1 mm' };
  else throw new Error(`unknown via kind "${kind}"`);
  return next;
}

/**
 * Moves a component between "between two copper layers" (at x, y) and "on a
 * copper layer" (from a point to another 1 mm along y), keeping its name, its
 * value and its first point.
 */
export function setComponentPlacement(doc: Doc, index: number, placement: string): Doc {
  const c = doc.components![index];
  if ((('between' in c) ? 'between' : 'layer') === placement) return doc;
  const next = copy(doc);
  const head = { id: c.id, ...componentValue(c) };
  if (placement === 'layer' && 'between' in c) {
    const top = copperNames(doc).at(-1) ?? c.between[1];
    next.components![index] = { id: c.id, layer: top, from: [c.x, c.y], to: [c.x, `${c.y} + 1 mm`], ...componentValue(c) };
  } else if (placement === 'between' && 'layer' in c) {
    const copper = copperNames(doc);
    next.components![index] = { ...head, x: c.from[0], y: c.from[1], between: [copper[0], c.layer === copper[0] ? copper[1] : c.layer] };
    // Key order as in a hand-written file: id, place, value.
    const { id, x, y, between, ...value } = next.components![index] as Extract<LumpedComponent, { between: unknown }>;
    next.components![index] = { id, x, y, between, ...value };
  } else {
    throw new Error(`unknown component placement "${placement}"`);
  }
  return next;
}
