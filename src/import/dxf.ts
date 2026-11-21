import { LENGTH_UNITS } from '../project/expression';
import type { Vec2 } from '../project/resolve';
import {
  arcPathPoints, chainIntoClosedLoops, circlePolygon, counterClockwiseSweep, failImport,
  shapesFromNestedContours, type ImportedShape,
} from './geometry';

/**
 * ASCII DXF reader for planar copper and outlines, per layer name.
 *
 * Supported entities: LWPOLYLINE and POLYLINE (2D, with bulge arcs; closed,
 * or open and chained with others), CIRCLE, and LINE / ARC chains that
 * close. Units come from the header's $INSUNITS (inch, mm, cm, m, mil,
 * micron), or from the caller when the file has none.
 *
 * Refused with an error naming the line, on the requested layer only: any
 * other entity (TEXT, SPLINE, ELLIPSE, HATCH, INSERT, ...), polylines with a
 * width, 3D polylines and meshes, and entities in an object coordinate
 * system (extrusion other than +Z, as mirrored CAD exports write). Entities
 * on other layers are not read, so a drawing may carry text and dimensions
 * on layers that are not imported. Binary DXF is refused.
 *
 * A layer becomes closed contours; nested contours alternate copper and hole
 * (even-odd), see shapesFromNestedContours.
 */

interface DxfPair {
  code: number;
  value: string;
  line: number;
}

interface DxfEntity {
  type: string;
  layer: string;
  line: number;
  pairs: DxfPair[];
  /** POLYLINE only: its VERTEX entities. */
  vertices: DxfEntity[];
}

export interface DxfDrawing {
  sourceName: string;
  /** Millimetres per drawing unit. */
  unitMm: number;
  entities: DxfEntity[];
}

/** $INSUNITS codes NobuRF reads, to the LENGTH_UNITS name. */
const INSUNITS: Readonly<Record<number, string>> = { 1: 'in', 4: 'mm', 5: 'cm', 6: 'm', 9: 'mil', 13: 'um' };

function readPairs(text: string, sourceName: string): DxfPair[] {
  if (text.startsWith('AutoCAD Binary DXF')) failImport(sourceName, undefined, 'binary DXF is not supported; save as ASCII DXF');
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length % 2 !== 0) failImport(sourceName, lines.length, 'odd number of lines; a DXF file is group code / value pairs');
  const pairs: DxfPair[] = [];
  for (let n = 0; n < lines.length; n += 2) {
    const code = lines[n].trim();
    if (!/^-?\d+$/.test(code)) failImport(sourceName, n + 1, `expected a group code, got "${code}"`);
    pairs.push({ code: Number(code), value: lines[n + 1].trim(), line: n + 1 });
  }
  return pairs;
}

/**
 * Parse a DXF file. `unitOverride` (a LENGTH_UNITS name) supplies the unit
 * when the file has no $INSUNITS; if both are present they must agree.
 */
export function parseDxf(text: string, sourceName: string, unitOverride?: string): DxfDrawing {
  const pairs = readPairs(text, sourceName);
  let fileUnit: string | undefined;
  const entities: DxfEntity[] = [];
  let section: string | undefined;
  let n = 0;
  while (n < pairs.length) {
    const pair = pairs[n];
    if (pair.code !== 0) {
      // Header variables: 9 $NAME followed by its value pairs.
      if (section === 'HEADER' && pair.code === 9 && pair.value === '$INSUNITS') {
        const value = pairs[n + 1];
        if (value?.code !== 70) failImport(sourceName, pair.line, '$INSUNITS has no value');
        const code = Number(value.value);
        if (code !== 0) {
          fileUnit = INSUNITS[code] ?? failImport(sourceName, value.line, `$INSUNITS ${code} is not a supported unit (supported: ${Object.entries(INSUNITS).map(([c, u]) => `${c} = ${u}`).join(', ')})`);
        }
      }
      if (pair.code === 2 && pairs[n - 1]?.code === 0 && pairs[n - 1].value === 'SECTION') section = pair.value;
      n++;
      continue;
    }
    if (pair.value === 'ENDSEC') section = undefined;
    if (section !== 'ENTITIES' || pair.value === 'SECTION' || pair.value === 'ENDSEC') {
      n++;
      continue;
    }
    // An entity runs to the next code-0 pair.
    let end = n + 1;
    while (end < pairs.length && pairs[end].code !== 0) end++;
    const body = pairs.slice(n + 1, end);
    const entity: DxfEntity = { type: pair.value, layer: body.find((p) => p.code === 8)?.value ?? '0', line: pair.line, pairs: body, vertices: [] };
    if (pair.value === 'VERTEX' || pair.value === 'SEQEND') {
      const owner = entities[entities.length - 1];
      if (owner?.type !== 'POLYLINE') failImport(sourceName, pair.line, `${pair.value} outside a POLYLINE`);
      if (pair.value === 'VERTEX') owner.vertices.push(entity);
    } else {
      entities.push(entity);
    }
    n = end;
  }
  if (fileUnit && unitOverride && fileUnit !== unitOverride) {
    failImport(sourceName, undefined, `the file's $INSUNITS says "${fileUnit}" but "${unitOverride}" was given; drop the override or fix the file`);
  }
  const unit = fileUnit ?? unitOverride;
  if (!unit) failImport(sourceName, undefined, 'the file has no $INSUNITS; give its unit (--units mm, in, mil, um, cm or m)');
  if (!Object.hasOwn(LENGTH_UNITS, unit)) failImport(sourceName, undefined, `unknown unit "${unit}" (units: ${Object.keys(LENGTH_UNITS).join(', ')})`);
  return { sourceName, unitMm: LENGTH_UNITS[unit], entities };
}

/** Read one entity's group codes as numbers. */
function entityReader(entity: DxfEntity, sourceName: string) {
  const fail = (message: string): never => failImport(sourceName, entity.line, `${entity.type} on layer "${entity.layer}": ${message}`);
  const number = (pair: DxfPair) => {
    const value = Number(pair.value);
    if (pair.value === '' || !Number.isFinite(value)) failImport(sourceName, pair.line + 1, `"${pair.value}" is not a number`);
    return value;
  };
  const optional = (code: number, fallback: number) => {
    const pair = entity.pairs.find((p) => p.code === code);
    return pair ? number(pair) : fallback;
  };
  const required = (code: number) => {
    const pair = entity.pairs.find((p) => p.code === code);
    return pair ? number(pair) : fail(`group code ${code} is missing`);
  };
  if (optional(210, 0) !== 0 || optional(220, 0) !== 0 || optional(230, 1) !== 1) {
    fail('uses an object coordinate system (extrusion direction is not +Z), e.g. a mirrored export; flatten it in the CAD tool');
  }
  return { fail, number, optional, required };
}

interface BulgedVertex {
  point: Vec2;
  /** tan(included angle / 4) of the arc to the next vertex; positive is counter-clockwise. 0 = straight. */
  bulge: number;
}

/** A polyline with bulges as points, closing back to the first vertex if `closed`. */
function bulgedPolylinePoints(vertices: BulgedVertex[], closed: boolean): Vec2[] {
  const points: Vec2[] = [vertices[0].point];
  const segments = closed ? vertices.length : vertices.length - 1;
  for (let k = 0; k < segments; k++) {
    const { point: from, bulge } = vertices[k];
    const to = vertices[(k + 1) % vertices.length].point;
    if (bulge === 0) {
      points.push(to);
      continue;
    }
    // The centre sits off the chord midpoint, to the left for a positive bulge, by (chord / 2) * (1 - b^2) / (2b).
    const [cx, cy] = [to[0] - from[0], to[1] - from[1]];
    const offset = (1 - bulge * bulge) / (4 * bulge);
    const center: Vec2 = [from[0] + cx / 2 - cy * offset, from[1] + cy / 2 + cx * offset];
    points.push(...arcPathPoints(from, to, center, 4 * Math.atan(bulge)));
  }
  return points;
}

type LayerPiece = { closed: true; polygon: Vec2[] } | { closed: false; path: Vec2[] };

function entityPiece(entity: DxfEntity, drawing: DxfDrawing): LayerPiece {
  const { fail, number, optional, required } = entityReader(entity, drawing.sourceName);
  const mm = (v: number) => v * drawing.unitMm;
  switch (entity.type) {
    case 'LINE':
      return { closed: false, path: [[mm(required(10)), mm(required(20))], [mm(required(11)), mm(required(21))]] };
    case 'CIRCLE':
      return { closed: true, polygon: circlePolygon([mm(required(10)), mm(required(20))], mm(required(40))) };
    case 'ARC': {
      // Counter-clockwise from the start angle to the end angle, in degrees.
      const center: Vec2 = [mm(required(10)), mm(required(20))];
      const radius = mm(required(40));
      const [a0, a1] = [required(50), required(51)].map((deg) => (deg * Math.PI) / 180);
      const at = (a: number): Vec2 => [center[0] + radius * Math.cos(a), center[1] + radius * Math.sin(a)];
      const start = at(a0);
      return { closed: false, path: [start, ...arcPathPoints(start, at(a1), center, counterClockwiseSweep(a0, a1))] };
    }
    case 'LWPOLYLINE': {
      if (optional(43, 0) !== 0) fail('has a width; only zero-width outlines are supported');
      const vertices: BulgedVertex[] = [];
      for (const pair of entity.pairs) {
        if ((pair.code === 20 || pair.code === 42) && vertices.length === 0) fail(`group code ${pair.code} before the first vertex`);
        if (pair.code === 10) vertices.push({ point: [mm(number(pair)), NaN], bulge: 0 });
        else if (pair.code === 20) vertices[vertices.length - 1].point[1] = mm(number(pair));
        else if (pair.code === 42) vertices[vertices.length - 1].bulge = number(pair);
        else if ((pair.code === 40 || pair.code === 41) && number(pair) !== 0) fail('has a vertex width; only zero-width outlines are supported');
      }
      return polylinePiece(vertices, (optional(70, 0) & 1) === 1, fail);
    }
    case 'POLYLINE': {
      const flags = optional(70, 0);
      if (flags & (8 | 16 | 64)) fail('is a 3D polyline or mesh; only 2D polylines are supported');
      if (optional(40, 0) !== 0 || optional(41, 0) !== 0) fail('has a width; only zero-width outlines are supported');
      const vertices = entity.vertices.map((v): BulgedVertex => {
        const reader = entityReader(v, drawing.sourceName);
        if (reader.optional(40, 0) !== 0 || reader.optional(41, 0) !== 0) reader.fail('has a width; only zero-width outlines are supported');
        return { point: [mm(reader.required(10)), mm(reader.required(20))], bulge: reader.optional(42, 0) };
      });
      return polylinePiece(vertices, (flags & 1) === 1, fail);
    }
    default:
      return fail('is not supported (supported: LWPOLYLINE, POLYLINE, CIRCLE, LINE, ARC)');
  }
}

function polylinePiece(vertices: BulgedVertex[], closed: boolean, fail: (message: string) => never): LayerPiece {
  if (vertices.length < 2 || vertices.some((v) => Number.isNaN(v.point[1]))) fail('needs at least two complete vertices');
  const points = bulgedPolylinePoints(vertices, closed);
  if (!closed) return { closed: false, path: points };
  points.pop(); // the closing point repeats the first
  return { closed: true, polygon: points };
}

/** Every closed contour on `layer`: closed entities, plus open ones chained end to end. */
export function dxfLayerContours(drawing: DxfDrawing, layer: string): Vec2[][] {
  const entities = drawing.entities.filter((e) => e.layer === layer);
  if (entities.length === 0) {
    const layers = [...new Set(drawing.entities.map((e) => e.layer))].sort();
    failImport(drawing.sourceName, undefined, `no entities on layer "${layer}" (layers with entities: ${layers.join(', ') || 'none'})`);
  }
  const pieces = entities.map((e) => entityPiece(e, drawing));
  const closed = pieces.flatMap((p) => (p.closed ? [p.polygon] : []));
  const open = pieces.flatMap((p) => (p.closed ? [] : [p.path]));
  return [...closed, ...chainIntoClosedLoops(open, drawing.sourceName, `layer "${layer}"`)];
}

/** Copper shapes from a DXF layer (nested contours become holes). */
export function dxfLayerShapes(drawing: DxfDrawing, layer: string): ImportedShape[] {
  return shapesFromNestedContours(dxfLayerContours(drawing, layer));
}

/** The board outline from a DXF layer: exactly one closed contour. */
export function dxfLayerOutline(drawing: DxfDrawing, layer: string): Vec2[] {
  const contours = dxfLayerContours(drawing, layer);
  if (contours.length !== 1) {
    failImport(drawing.sourceName, undefined, `layer "${layer}" has ${contours.length} closed contours; a NobuRF board outline is one polygon (cut-outs inside the board are not supported)`);
  }
  return contours[0];
}
