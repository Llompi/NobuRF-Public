import { evaluateLength, ExpressionError } from '../project/expression';
import type { Vec2 } from '../project/resolve';
import {
  arcPathPoints, chainIntoClosedLoops, counterClockwiseSweep, failImport, ImportError,
  roundToNanometre, shapesFromNestedContours, signedPolygonArea, type ImportedShape,
} from './geometry';
import { parseStepFile, StepEnum, StepRef, StepTyped, type StepInstance, type StepRecord, type StepValue } from './step_file';

/**
 * STEP (AP203 / AP214 / AP242 B-rep) reader for flat copper and board
 * outlines. A board is in the xy plane with z up, as KiCad, Altium and most
 * ECAD tools export it; --step-up turns models drawn with another axis up.
 *
 * Bodies are found through the assembly: every MANIFOLD_SOLID_BREP,
 * BREP_WITH_VOIDS, FACETED_BREP and SHELL_BASED_SURFACE_MODEL, placed by
 * the chain of transformations above it (REPRESENTATION_RELATIONSHIP with
 * a transformation, and MAPPED_ITEM), so a part used twice is two bodies.
 * A body is named after its product ("UWB_Antenna_Circular_track_1"), with
 * its own name after a slash when it has one ("patch_antenna/Cut-Extrude1").
 *
 * A selected body must be flat in z, one of:
 *   - a sheet: every face a plane facing up or down, all at one height;
 *   - a solid extruded along z: faces are horizontal planes, vertical
 *     planes and vertical cylinders, and every upward face is at the top.
 * Its copper is its top face (a sheet's faces): outer loops add copper and
 * inner loops (drill holes, slots) cut it. Face edges may be lines and
 * circular arcs (chorded like the other importers); anything else, and any
 * body that is not flat, is an error naming the body and the line.
 */

type Vec3 = [number, number, number];

/** Rigid transform: rows of the rotation and the translation (mm). */
interface Transform {
  rotation: [Vec3, Vec3, Vec3];
  translation: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalise = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));

const rotate = (t: Transform, v: Vec3): Vec3 => [dot(t.rotation[0], v), dot(t.rotation[1], v), dot(t.rotation[2], v)];
const apply = (t: Transform, p: Vec3): Vec3 => {
  const r = rotate(t, p);
  return [r[0] + t.translation[0], r[1] + t.translation[1], r[2] + t.translation[2]];
};
/** a after b: apply b first. */
const compose = (a: Transform, b: Transform): Transform => {
  const columns = [0, 1, 2].map((c) => rotate(a, [b.rotation[0][c], b.rotation[1][c], b.rotation[2][c]]));
  return {
    rotation: [0, 1, 2].map((r) => [columns[0][r], columns[1][r], columns[2][r]]) as Transform['rotation'],
    translation: apply(a, b.translation),
  };
};
const invert = (t: Transform): Transform => {
  const transposed = [0, 1, 2].map((c) => [t.rotation[0][c], t.rotation[1][c], t.rotation[2][c]]) as Transform['rotation'];
  const inverse = { rotation: transposed, translation: [0, 0, 0] as Vec3 };
  return { rotation: transposed, translation: scale(rotate(inverse, t.translation), -1) };
};

/**
 * Which model axis points away from the board's top face. KiCad and most
 * ECAD tools export z up; SolidWorks and some MCAD tools model with y up.
 * Each is a proper rotation onto z up (never a mirror), so the layout reads
 * as seen from above the board.
 */
/** Placements of all groups together, bodies and sub-assemblies: far more than any board needs. */
const MAX_PLACEMENTS = 100_000;

export const UP_AXES = ['z', 'y', 'x', '-z', '-y', '-x'] as const;
export type UpAxis = (typeof UP_AXES)[number];

const UP_ROTATIONS: Readonly<Record<UpAxis, Transform['rotation']>> = {
  z: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  y: [[1, 0, 0], [0, 0, -1], [0, 1, 0]], // (x, y, z) -> (x, -z, y)
  x: [[0, 0, -1], [0, 1, 0], [1, 0, 0]], // (x, y, z) -> (-z, y, x)
  '-z': [[1, 0, 0], [0, -1, 0], [0, 0, -1]], // (x, y, z) -> (x, -y, -z)
  '-y': [[1, 0, 0], [0, 0, 1], [0, -1, 0]], // (x, y, z) -> (x, z, -y)
  '-x': [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], // (x, y, z) -> (z, y, -x)
};

const IDENTITY: Transform = { rotation: UP_ROTATIONS.z, translation: [0, 0, 0] };

/** Directions closer than this (as 1 - |cos|, or |cos| for perpendicular) count as parallel. */
const DIRECTION_TOLERANCE = 1e-6;
/** Heights closer than this (mm) are the same height. */
const HEIGHT_TOLERANCE_MM = 1e-4;
/** How far (mm) a face's vertex may sit off the face's plane. */
const VERTEX_OFF_PLANE_TOLERANCE_MM = 1e-3;

const BODY_TYPES = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL']);
const SI_PREFIX_MM: Readonly<Record<string, number>> = { '': 1000, KILO: 1e6, DECI: 100, CENTI: 10, MILLI: 1, MICRO: 1e-3, NANO: 1e-6 };

/** A placed body. */
export interface StepBody {
  name: string;
  /** The B-rep instance (#id) and its line in the file. */
  instance: StepInstance;
  /** Body coordinates (mm) to board coordinates (mm, z up). */
  transform: Transform;
}

export interface StepModel {
  sourceName: string;
  up: UpAxis;
  bodies: StepBody[];
  /** @internal */
  reader: StepReader;
}

/** The flat copper of one body, in board mm. */
export interface FlatBody {
  name: string;
  /** Bottom and top of the body (mm); equal for a sheet. */
  zMin: number;
  zMax: number;
  shapes: ImportedShape[];
}

/** Typed access to instances, with errors naming the instance and line. */
class StepReader {
  constructor(readonly sourceName: string, readonly instances: Map<number, StepInstance>, readonly unitMm: number) {}

  fail(at: StepInstance | undefined, message: string): never {
    return failImport(this.sourceName, at?.line, at ? `#${at.id}: ${message}` : message);
  }

  instance(ref: StepValue, from?: StepInstance): StepInstance {
    if (!(ref instanceof StepRef)) return this.fail(from, 'expected a reference to another instance');
    return this.instances.get(ref.id) ?? this.fail(from, `refers to #${ref.id}, which is not in the file`);
  }

  /** The record of one of `types` in the instance at `ref`, or an error naming what was found. */
  record(ref: StepValue, types: readonly string[], from?: StepInstance): { at: StepInstance; record: StepRecord } {
    const at = this.instance(ref, from);
    const record = at.records.find((r) => types.includes(r.type));
    if (!record) return this.fail(at, `is ${at.records.map((r) => r.type).join(' + ')}, expected ${types.join(' or ')}`);
    return { at, record };
  }

  find(at: StepInstance, type: string): StepRecord | undefined {
    return at.records.find((r) => r.type === type);
  }

  number(value: StepValue, at: StepInstance): number {
    return typeof value === 'number' ? value : this.fail(at, `expected a number, found ${JSON.stringify(value)}`);
  }

  list(value: StepValue, at: StepInstance): StepValue[] {
    return Array.isArray(value) ? value : this.fail(at, 'expected a list');
  }

  bool(value: StepValue, at: StepInstance): boolean {
    if (value instanceof StepEnum && (value.name === 'T' || value.name === 'F')) return value.name === 'T';
    return this.fail(at, 'expected .T. or .F.');
  }

  private triple(ref: StepValue, type: string, from: StepInstance, factor: number): Vec3 {
    const { at, record } = this.record(ref, [type], from);
    const xyz = this.list(record.args[1], at).map((v) => this.number(v, at) * factor);
    return [xyz[0], xyz[1], xyz[2] ?? 0];
  }

  /** A CARTESIAN_POINT in mm, through `transform`. */
  point(ref: StepValue, from: StepInstance, transform = IDENTITY): Vec3 {
    return apply(transform, this.triple(ref, 'CARTESIAN_POINT', from, this.unitMm));
  }

  direction(ref: StepValue, from: StepInstance): Vec3 {
    const d = this.triple(ref, 'DIRECTION', from, 1);
    if (Math.hypot(...d) === 0) this.fail(this.instance(ref, from), 'is a zero-length direction');
    return normalise(d);
  }

  /** An AXIS2_PLACEMENT_3D as the transform from its local frame. */
  placement(ref: StepValue, from: StepInstance): Transform {
    const { at, record } = this.record(ref, ['AXIS2_PLACEMENT_3D'], from);
    const z = record.args[2] === null ? ([0, 0, 1] as Vec3) : this.direction(record.args[2], at);
    const reference = record.args[3] === null ? ([1, 0, 0] as Vec3) : this.direction(record.args[3], at);
    const across = subtract(reference, scale(z, dot(reference, z)));
    if (Math.hypot(...across) < DIRECTION_TOLERANCE) this.fail(at, 'its reference direction is parallel to its axis');
    const x = normalise(across);
    const y = cross(z, x);
    return { rotation: [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]], translation: this.point(record.args[1], at) };
  }

  /** Origin and z axis of an AXIS2_PLACEMENT_3D, through `transform`. */
  axis(ref: StepValue, from: StepInstance, transform: Transform): { origin: Vec3; z: Vec3 } {
    const local = this.placement(ref, from);
    return { origin: apply(transform, local.translation), z: rotate(transform, [local.rotation[0][2], local.rotation[1][2], local.rotation[2][2]]) };
  }

  /** Millimetres per unit of a LENGTH_UNIT instance. */
  lengthUnitMm(ref: StepValue, from: StepInstance): number {
    const at = this.instance(ref, from);
    const si = this.find(at, 'SI_UNIT');
    if (si) {
      const prefix = si.args[0] instanceof StepEnum ? si.args[0].name : '';
      const name = si.args[1] instanceof StepEnum ? si.args[1].name : '';
      if (name !== 'METRE' || !(prefix in SI_PREFIX_MM)) this.fail(at, `length unit ${prefix}${name} is not supported`);
      return SI_PREFIX_MM[prefix];
    }
    const converted = this.find(at, 'CONVERSION_BASED_UNIT');
    if (converted) {
      const measure = this.instance(converted.args[1], at);
      const record = measure.records.find((r) => r.type.endsWith('MEASURE_WITH_UNIT'));
      const value = record?.args[0] instanceof StepTyped ? record.args[0].args[0] : record?.args[0];
      if (!record || typeof value !== 'number') this.fail(measure, 'expected a LENGTH_MEASURE_WITH_UNIT');
      return value * this.lengthUnitMm(record.args[1], measure);
    }
    return this.fail(at, 'is not an SI or conversion-based length unit');
  }
}

/** The one length unit used by every representation context in the file. */
function fileLengthUnitMm(sourceName: string, instances: Map<number, StepInstance>): number {
  const reader = new StepReader(sourceName, instances, Number.NaN);
  const units = new Set<number>();
  for (const at of instances.values()) {
    const context = reader.find(at, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    if (!context) continue;
    for (const ref of reader.list(context.args[0], at)) {
      if (reader.find(reader.instance(ref, at), 'LENGTH_UNIT')) units.add(reader.lengthUnitMm(ref, at));
    }
  }
  if (units.size === 0) return failImport(sourceName, undefined, 'no length unit is declared (GLOBAL_UNIT_ASSIGNED_CONTEXT with a LENGTH_UNIT)');
  if (units.size > 1) {
    return failImport(sourceName, undefined, `the file mixes length units (${[...units].map((mm) => `${mm} mm`).join(', ')}); export it with one unit`);
  }
  return [...units][0];
}

/** Representation records: (name, items, context). Presentation (styling) representations are not geometry. */
function isShapeRepresentation(record: StepRecord): boolean {
  return record.type.endsWith('REPRESENTATION') && !record.type.endsWith('PRESENTATION_REPRESENTATION') && Array.isArray(record.args[1]);
}

export function parseStep(text: string, sourceName: string, up: UpAxis = 'z'): StepModel {
  const instances = parseStepFile(text, sourceName);
  const reader = new StepReader(sourceName, instances, fileLengthUnitMm(sourceName, instances));

  // Representations joined without a transformation share coordinates: union-find groups them.
  const parentOf = new Map<number, number>();
  const groupOf = (id: number): number => {
    const parent = parentOf.get(id);
    if (parent === undefined || parent === id) return id;
    const root = groupOf(parent);
    parentOf.set(id, root);
    return root;
  };
  const representationOf = new Map<number, number>(); // body id -> representation id
  const placements: Array<{ child: number; parent: number; transform: Transform }> = [];
  /** Maps placement `from` onto placement `to`, both in the parent's coordinates. */
  const displacement = (from: StepValue, to: StepValue, at: StepInstance) => compose(reader.placement(to, at), invert(reader.placement(from, at)));

  for (const at of instances.values()) {
    for (const record of at.records) {
      if (!isShapeRepresentation(record)) continue;
      for (const item of record.args[1] as StepValue[]) {
        if (!(item instanceof StepRef)) continue;
        representationOf.set(item.id, at.id);
        const mapped = instances.get(item.id);
        const mappedItem = mapped && reader.find(mapped, 'MAPPED_ITEM');
        if (mapped && mappedItem) {
          // MAPPED_ITEM(name, REPRESENTATION_MAP(origin, representation), target): an instance of that representation.
          const { at: map, record: representationMap } = reader.record(mappedItem.args[1], ['REPRESENTATION_MAP'], mapped);
          const child = reader.instance(representationMap.args[1], map).id;
          placements.push({ child, parent: at.id, transform: displacement(representationMap.args[0], mappedItem.args[2], mapped) });
        }
      }
    }
  }
  const productName = new Map<number, string>(); // representation id -> product name
  for (const at of instances.values()) {
    const relationship = reader.find(at, 'REPRESENTATION_RELATIONSHIP') ?? reader.find(at, 'SHAPE_REPRESENTATION_RELATIONSHIP');
    if (relationship) {
      if (relationship.args.length !== 4) reader.fail(at, `${relationship.type} needs 4 parameters (name, description, rep_1, rep_2)`);
      // rep_1 is the child (the component), rep_2 the parent, as OCCT, KiCad and the CAx-IF practices write it.
      const child = reader.instance(relationship.args[2], at).id;
      const parent = reader.instance(relationship.args[3], at).id;
      const withTransformation = reader.find(at, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
      if (withTransformation) {
        const { at: idt, record } = reader.record(withTransformation.args[0], ['ITEM_DEFINED_TRANSFORMATION'], at);
        placements.push({ child, parent, transform: displacement(record.args[2], record.args[3], idt) });
      } else {
        parentOf.set(groupOf(child), groupOf(parent));
      }
    }
    const definition = reader.find(at, 'SHAPE_DEFINITION_REPRESENTATION');
    if (definition) {
      const name = productNameOf(reader, definition.args[0], at);
      if (name !== undefined) productName.set(reader.instance(definition.args[1], at).id, name);
    }
  }

  const parentsOf = new Map<number, Array<{ parent: number; transform: Transform }>>();
  for (const { child, parent, transform } of placements) {
    const list = parentsOf.get(groupOf(child)) ?? [];
    list.push({ parent: groupOf(parent), transform });
    parentsOf.set(groupOf(child), list);
  }
  const nameOfGroup = new Map<number, string>();
  for (const [representation, name] of productName) if (!nameOfGroup.has(groupOf(representation))) nameOfGroup.set(groupOf(representation), name);

  // Every placement of a group in the world, memoised per group: shared
  // sub-assemblies are walked once, a group met again while its own
  // placements are being worked out is a cycle, and the total is capped.
  const placementsOfGroup = new Map<number, Transform[]>();
  const walking = new Set<number>();
  let placementCount = 0;
  const worldTransforms = (group: number): Transform[] => {
    const known = placementsOfGroup.get(group);
    if (known) return known;
    if (walking.has(group)) failImport(sourceName, undefined, 'the assembly contains itself (a cycle in NEXT_ASSEMBLY_USAGE_OCCURRENCE)');
    walking.add(group);
    const parents = parentsOf.get(group);
    const out: Transform[] = [];
    for (const { parent, transform } of parents ?? []) {
      for (const w of worldTransforms(parent)) {
        out.push(compose(w, transform));
        if (++placementCount > MAX_PLACEMENTS) {
          failImport(sourceName, undefined, `the assembly places parts more than ${MAX_PLACEMENTS} times; export only the board`);
        }
      }
    }
    walking.delete(group);
    const result = parents ? out : [IDENTITY];
    placementsOfGroup.set(group, result);
    return result;
  };

  const toBoard: Transform = { rotation: UP_ROTATIONS[up], translation: [0, 0, 0] };
  const bodies: StepBody[] = [];
  for (const at of instances.values()) {
    const record = at.records.find((r) => BODY_TYPES.has(r.type));
    if (!record) continue;
    const representation = representationOf.get(at.id);
    if (representation === undefined) continue; // not used by any shape
    const group = groupOf(representation);
    const ownName = typeof record.args[0] === 'string' ? record.args[0].trim() : '';
    const product = nameOfGroup.get(group);
    const name = product && ownName && ownName !== product ? `${product}/${ownName}` : product || ownName || `#${at.id}`;
    for (const transform of worldTransforms(group)) bodies.push({ name, instance: at, transform: compose(toBoard, transform) });
  }
  if (bodies.length === 0) failImport(sourceName, undefined, 'no solid or surface bodies (MANIFOLD_SOLID_BREP, SHELL_BASED_SURFACE_MODEL, ...) in the file');
  return { sourceName, up, bodies, reader };
}

/** PRODUCT_DEFINITION_SHAPE -> PRODUCT_DEFINITION -> formation -> PRODUCT name; undefined for shapes of assembly links. */
function productNameOf(reader: StepReader, shapeRef: StepValue, from: StepInstance): string | undefined {
  const { at, record } = reader.record(shapeRef, ['PRODUCT_DEFINITION_SHAPE'], from);
  const definition = reader.instance(record.args[2], at);
  const productDefinition = definition.records.find((r) => r.type.startsWith('PRODUCT_DEFINITION') && !r.type.includes('SHAPE'));
  if (!productDefinition) return undefined;
  const formation = reader.instance(productDefinition.args[2], definition);
  const formationRecord = formation.records.find((r) => r.type.startsWith('PRODUCT_DEFINITION_FORMATION'));
  if (!formationRecord) return undefined;
  const { record: product } = reader.record(formationRecord.args[2], ['PRODUCT'], formation);
  const name = typeof product.args[1] === 'string' && product.args[1] ? product.args[1] : product.args[0];
  return typeof name === 'string' ? name : undefined;
}

/** Glob with * and ?, whole name, case-insensitive. */
function globMatcher(pattern: string): (name: string) => boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return (name) => regex.test(name);
}

/** Which parameters of each topology record lead down to vertices (curves and surfaces are not followed). */
const TOPOLOGY_DOWN: Readonly<Record<string, number[]>> = {
  MANIFOLD_SOLID_BREP: [1], BREP_WITH_VOIDS: [1, 2], FACETED_BREP: [1], SHELL_BASED_SURFACE_MODEL: [1],
  CLOSED_SHELL: [1], OPEN_SHELL: [1], ORIENTED_CLOSED_SHELL: [2],
  ADVANCED_FACE: [1], FACE_SURFACE: [1], FACE: [1], FACE_OUTER_BOUND: [1], FACE_BOUND: [1],
  EDGE_LOOP: [1], POLY_LOOP: [1], VERTEX_LOOP: [1], ORIENTED_EDGE: [3], EDGE_CURVE: [1, 2], VERTEX_POINT: [1],
};

/**
 * Lowest and highest vertex of a body (mm, board z). For choosing bodies
 * only: it reads vertices, so it works for any body, flat or not.
 */
function bodyHeightRange(model: StepModel, body: StepBody): [number, number] {
  const { reader } = model;
  let low = Infinity;
  let high = -Infinity;
  const seen = new Set<number>();
  const visit = (value: StepValue, from: StepInstance): void => {
    if (Array.isArray(value)) return value.forEach((v) => visit(v, from));
    if (!(value instanceof StepRef) || seen.has(value.id)) return;
    seen.add(value.id);
    const at = reader.instance(value, from);
    if (reader.find(at, 'CARTESIAN_POINT')) {
      const z = reader.point(value, from, body.transform)[2];
      low = Math.min(low, z);
      high = Math.max(high, z);
      return;
    }
    for (const record of at.records) for (const n of TOPOLOGY_DOWN[record.type] ?? []) visit(record.args[n], at);
  };
  visit(new StepRef(body.instance.id), body.instance);
  if (low > high) reader.fail(body.instance, `body "${body.name}" has no vertices`);
  return [low, high];
}

const insideBand = ([low, high]: [number, number], band: [number, number]) =>
  low >= band[0] - HEIGHT_TOLERANCE_MM && high <= band[1] + HEIGHT_TOLERANCE_MM;

/**
 * The bodies a selector picks: `<name globs>[@<z from>..<z to>]`.
 * Globs are comma-separated, with * and ?, matched against whole names
 * without regard to case; no globs means every body. The height band, in
 * lengths with units ("@0.5mm..0.535mm"), keeps only bodies lying inside
 * it, which is how KiCad copper is chosen by layer (its names say "track"
 * and "pad", not which side). An empty choice is an error listing the
 * bodies by height.
 */
export function selectStepBodies(model: StepModel, selector: string): StepBody[] {
  const at = selector.lastIndexOf('@');
  const namePart = at < 0 ? selector : selector.slice(0, at);
  const matchers = namePart.split(',').map((p) => p.trim()).filter(Boolean).map(globMatcher);
  let band: [number, number] | undefined;
  if (at >= 0) {
    const m = /^(.+?)\.\.(.+)$/.exec(selector.slice(at + 1));
    if (!m) throw new ImportError(`${model.sourceName}:${selector}: expected a height band such as @0.5mm..0.535mm after the @`);
    const length = (text: string) => {
      try {
        return evaluateLength(text.trim(), (name) => {
          throw new ExpressionError(`"${name}" is not a unit`);
        });
      } catch (e) {
        if (e instanceof ExpressionError) throw new ImportError(`${model.sourceName}:${selector}: height ${e.message}`);
        throw e;
      }
    };
    band = [length(m[1]), length(m[2])];
  }
  const byName = matchers.length === 0 ? model.bodies : model.bodies.filter((b) => matchers.some((m) => m(b.name)));
  const chosen = band ? byName.filter((b) => insideBand(bodyHeightRange(model, b), band)) : byName;
  if (chosen.length === 0) throw new ImportError(`${model.sourceName}: no body matches "${selector}". ${describeBodies(model)}`);
  return chosen;
}

/** Bodies grouped by height range, for error messages and the import dialog. */
export function describeBodies(model: StepModel): string {
  const heights = model.bodies.map((b) => bodyHeightRange(model, b));
  const groups = new Map<string, { band: [number, number]; names: string[] }>();
  model.bodies.forEach((body, n) => {
    const band: [number, number] = [roundToNanometre(heights[n][0]), roundToNanometre(heights[n][1])];
    const key = band.join();
    const group = groups.get(key) ?? { band, names: [] };
    group.names.push(body.name);
    groups.set(key, group);
  });
  const lines = [...groups.values()]
    .sort((a, b) => b.band[1] - a.band[1] || b.band[0] - a.band[0])
    .map(({ band, names }) => {
      const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
      // Offer the band as a selector only when it picks exactly this group.
      const exact = heights.filter((range) => insideBand(range, band)).length === names.length;
      const selector = exact ? `: select with @${band[0]}mm..${band[1]}mm` : '';
      return `  z ${band[0]} to ${band[1]} mm, ${names.length} ${names.length === 1 ? 'body' : 'bodies'} (${shown})${selector}`;
    });
  return `Bodies in the file (z up is model ${model.up}):\n${lines.join('\n')}`;
}

interface HorizontalFace {
  at: StepInstance;
  bounds: StepValue[];
  z: number;
  facesUp: boolean;
}

/** The flat copper of one body: its top face, or a sheet's faces. */
export function flatBody(model: StepModel, body: StepBody): FlatBody {
  const { reader } = model;
  const t = body.transform;
  const label = `body "${body.name}" (#${body.instance.id})`;
  const failBody = (at: StepInstance, why: string): never => reader.fail(at, `${label} ${why}`);
  const upHint = ` (board up is model ${model.up}; if the board lies in another plane, give --step-up ${UP_AXES.join(', ')})`;
  const point = (ref: StepValue, from: StepInstance) => reader.point(ref, from, t);

  const record = body.instance.records.find((r) => BODY_TYPES.has(r.type))!;
  const shellRefs = record.type === 'SHELL_BASED_SURFACE_MODEL' ? reader.list(record.args[1], body.instance) : [record.args[1]];
  const faceRefs = shellRefs.flatMap((ref) => {
    const { at, record: shell } = reader.record(ref, ['CLOSED_SHELL', 'OPEN_SHELL'], body.instance);
    return reader.list(shell.args[1], at);
  });

  const horizontal: HorizontalFace[] = [];
  let hasSides = false;
  const classify = (at: StepInstance, bounds: StepValue[], normal: Vec3, z: () => number, what: string) => {
    if (Math.abs(normal[2]) > 1 - DIRECTION_TOLERANCE) horizontal.push({ at, bounds, z: z(), facesUp: normal[2] > 0 });
    else if (Math.abs(normal[2]) < DIRECTION_TOLERANCE) hasSides = true;
    else failBody(at, `is not flat: it has a slanted ${what}${upHint}`);
  };
  for (const ref of faceRefs) {
    const { at, record: face } = reader.record(ref, ['ADVANCED_FACE', 'FACE_SURFACE', 'FACE'], body.instance);
    const bounds = reader.list(face.args[1], at);
    if (face.type === 'FACE') {
      // A FACE of POLY_LOOPs carries no surface; its outer loop gives the normal.
      const outer = polyLoopNormalAndHeight(reader, bounds, at, point);
      classify(at, bounds, outer.normal, () => outer.z, 'face');
      continue;
    }
    const surface = reader.instance(face.args[2], at);
    const sameSense = reader.bool(face.args[3], at);
    const plane = reader.find(surface, 'PLANE');
    const cylinder = reader.find(surface, 'CYLINDRICAL_SURFACE');
    if (plane) {
      const { origin, z } = reader.axis(plane.args[1], surface, t);
      classify(at, bounds, sameSense ? z : scale(z, -1), () => origin[2], 'plane face');
    } else if (cylinder && Math.abs(reader.axis(cylinder.args[1], surface, t).z[2]) > 1 - DIRECTION_TOLERANCE) {
      hasSides = true;
    } else {
      failBody(at, `is not a flat body extruded along z: face #${at.id} is a ${surface.records.map((r) => r.type).join(' + ')}${cylinder ? ' not parallel to z' : ''}${upHint}`);
    }
  }
  if (horizontal.length === 0) failBody(body.instance, `has no face parallel to the board (xy plane)${upHint}`);

  let zMin = Infinity;
  let zMax = -Infinity;
  for (const face of horizontal) {
    zMin = Math.min(zMin, face.z);
    zMax = Math.max(zMax, face.z);
  }
  const isSheet = !hasSides && zMax - zMin <= HEIGHT_TOLERANCE_MM;
  const copperFaces = isSheet ? horizontal : horizontal.filter((f) => f.facesUp);
  if (copperFaces.length === 0) failBody(body.instance, 'has no face facing up (+z); its faces may be oriented inside out');
  if (!isSheet) {
    const lower = copperFaces.find((f) => f.z < zMax - HEIGHT_TOLERANCE_MM);
    if (lower) failBody(lower.at, `is not a flat body: it has upward faces at z = ${roundToNanometre(lower.z)} mm and ${roundToNanometre(zMax)} mm (a step or pocket)`);
  }

  const shapes = copperFaces.flatMap((face) => {
    const onPlane = (path: Vec3[]): Vec2[] => path.map(([x, y, z]): Vec2 => {
      if (Math.abs(z - face.z) > VERTEX_OFF_PLANE_TOLERANCE_MM) {
        failBody(face.at, `face #${face.at.id} has a vertex off its plane (z = ${roundToNanometre(z)} mm, plane at ${roundToNanometre(face.z)} mm)`);
      }
      return [x, y];
    });
    const loops = face.bounds.map((boundRef) => {
      const { at, record: bound } = reader.record(boundRef, ['FACE_OUTER_BOUND', 'FACE_BOUND'], face.at);
      const loop = reader.instance(bound.args[1], at);
      const polyLoop = reader.find(loop, 'POLY_LOOP');
      if (polyLoop) return onPlane(reader.list(polyLoop.args[1], loop).map((ref) => point(ref, loop)));
      const edgeLoop = reader.find(loop, 'EDGE_LOOP') ?? failBody(loop, `face #${face.at.id} has a ${loop.records[0].type}; expected EDGE_LOOP or POLY_LOOP`);
      const paths = reader.list(edgeLoop.args[1], loop).map((ref) => onPlane(edgePath(reader, ref, loop, t, (why) => failBody(loop, why))));
      const chained = chainIntoClosedLoops(paths, model.sourceName, `${label}, face #${face.at.id}`);
      if (chained.length !== 1) failBody(loop, `face #${face.at.id}: an edge loop is ${chained.length} separate loops`);
      return chained[0];
    });
    return shapesFromNestedContours(loops);
  });
  return { name: body.name, zMin, zMax, shapes };
}

/**
 * Normal (Newell) and height of a POLY_LOOP face's outer bound, turned by
 * the bound's orientation flag. The outer bound is FACE_OUTER_BOUND, or the
 * loop enclosing the largest area when none is marked.
 */
function polyLoopNormalAndHeight(
  reader: StepReader,
  bounds: StepValue[],
  from: StepInstance,
  point: (ref: StepValue, from: StepInstance) => Vec3,
): { normal: Vec3; z: number } {
  const loops = bounds.map((boundRef) => {
    const { at, record: bound } = reader.record(boundRef, ['FACE_OUTER_BOUND', 'FACE_BOUND'], from);
    const { at: loopAt, record: loop } = reader.record(bound.args[1], ['POLY_LOOP'], at);
    const points = reader.list(loop.args[1], loopAt).map((ref) => point(ref, loopAt));
    const n: Vec3 = [0, 0, 0];
    points.forEach((p, i) => {
      const q = points[(i + 1) % points.length];
      n[0] += (p[1] - q[1]) * (p[2] + q[2]);
      n[1] += (p[2] - q[2]) * (p[0] + q[0]);
      n[2] += (p[0] - q[0]) * (p[1] + q[1]);
    });
    return { isOuter: bound.type === 'FACE_OUTER_BOUND', normal: reader.bool(bound.args[2], at) ? n : scale(n, -1), z: points[0][2] };
  });
  const marked = loops.find((l) => l.isOuter);
  const outer = marked ?? loops.reduce((a, b) => (Math.hypot(...b.normal) > Math.hypot(...a.normal) ? b : a));
  if (Math.hypot(...outer.normal) === 0) reader.fail(from, 'a POLY_LOOP face has no area');
  return { normal: normalise(outer.normal), z: outer.z };
}

/** Points of one edge from its first to its second vertex (board mm, z kept for the plane check). */
function edgePath(reader: StepReader, orientedRef: StepValue, from: StepInstance, t: Transform, fail: (why: string) => never): Vec3[] {
  const { at: oriented, record: orientedEdge } = reader.record(orientedRef, ['ORIENTED_EDGE'], from);
  const { at: edgeAt, record: edge } = reader.record(orientedEdge.args[3], ['EDGE_CURVE'], oriented);
  const vertex = (ref: StepValue) => {
    const { at, record } = reader.record(ref, ['VERTEX_POINT'], edgeAt);
    return reader.point(record.args[1], at, t);
  };
  const start = vertex(edge.args[1]);
  const end = vertex(edge.args[2]);
  const sameSense = reader.bool(edge.args[4], edgeAt);

  let curveAt = reader.instance(edge.args[3], edgeAt);
  const wrapper = curveAt.records.find((r) => r.type === 'SURFACE_CURVE' || r.type === 'SEAM_CURVE');
  if (wrapper) curveAt = reader.instance(wrapper.args[1], curveAt);
  if (reader.find(curveAt, 'LINE')) return [start, end];
  const circle = reader.find(curveAt, 'CIRCLE');
  if (!circle) return fail(`edge #${edgeAt.id} is a ${curveAt.records.map((r) => r.type).join(' + ')}; flat faces may use lines and circular arcs only`);

  const { origin: center, z } = reader.axis(circle.args[1], curveAt, t);
  if (Math.abs(z[2]) < 1 - DIRECTION_TOLERANCE) return fail(`edge #${edgeAt.id} is a circle that does not lie in the xy plane`);
  // The curve's positive sense is counter-clockwise seen from +z when its axis points up.
  const counterClockwise = (z[2] > 0) === sameSense;
  const angle = (p: Vec3) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const sweep = counterClockwise ? counterClockwiseSweep(angle(start), angle(end)) : -counterClockwiseSweep(angle(end), angle(start));
  const arc = arcPathPoints([start[0], start[1]], [end[0], end[1]], [center[0], center[1]], sweep);
  // Arcs lie in the face plane; z of every point is the vertices' height.
  return [start, ...arc.map(([x, y]): Vec3 => [x, y, start[2]])];
}

/**
 * Copper of the chosen bodies, for one copper layer. Painting is in order,
 * so to get the union of the bodies, bodies with holes go first (largest
 * first: a ground pour before the pads in its clearances), then the rest.
 * A smaller body's hole still cuts copper of larger bodies painted before
 * it: right for a drill, wrong for a clearance in a small body that lies
 * over a bigger one (rare on real boards).
 */
export function stepCopper(model: StepModel, selector: string): { shapes: ImportedShape[]; bodies: FlatBody[] } {
  const bodies = selectStepBodies(model, selector).map((b) => flatBody(model, b));
  const outerArea = (b: FlatBody) => b.shapes.filter((s) => s.op === 'add').reduce((sum, s) => sum + Math.abs(signedPolygonArea(s.polygon)), 0);
  const hasHoles = (b: FlatBody) => b.shapes.some((s) => s.op === 'cut');
  const withHoles = bodies.filter(hasHoles).sort((a, b) => outerArea(b) - outerArea(a));
  const withoutHoles = bodies.filter((b) => !hasHoles(b));
  return { shapes: [...withHoles, ...withoutHoles].flatMap((b) => b.shapes), bodies };
}

/**
 * The board outline: the outer loop of exactly one chosen body's top face.
 * The project outline has no cut-outs, so holes in the board (mounting and
 * drill holes) are left out and counted for the caller to report.
 */
export function stepOutline(model: StepModel, selector: string): { outline: Vec2[]; holesLeftOut: number; body: FlatBody } {
  const chosen = selectStepBodies(model, selector);
  if (chosen.length !== 1) {
    throw new ImportError(`${model.sourceName}:${selector}: the outline must be one body, but ${chosen.length} match (${[...new Set(chosen.map((b) => b.name))].slice(0, 5).join(', ')})`);
  }
  const body = flatBody(model, chosen[0]);
  const outer = body.shapes.filter((s) => s.op === 'add');
  if (outer.length !== 1) throw new ImportError(`${model.sourceName}: body "${body.name}" has ${outer.length} separate pieces; the outline must be one piece`);
  return { outline: outer[0].polygon, holesLeftOut: body.shapes.length - 1, body };
}
