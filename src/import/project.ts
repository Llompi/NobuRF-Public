import type { Vec2 } from '../project/resolve';
import { parseProject, type CopperShape, type Point, type Project } from '../project/schema';
import { ImportError, roundToNanometre, signedPolygonArea, type ImportedShape } from './geometry';

/**
 * Build a NobuRF project from a template plus imported geometry. The
 * template supplies everything else (stackup, materials, port, boundaries,
 * mesh, analysis, outputs); the import replaces `board.outline` (when an
 * outline is given) and `geometry` of each imported copper layer. Copper
 * layers that are not imported keep the template's shapes.
 *
 * Coordinates are rounded to 1 nm (1e-6 mm) and written as "<mm> mm"
 * strings. A polygon with no area after rounding paints nothing and is left
 * out. The result is validated with parseProject, so it is a project the
 * rasteriser can read.
 */

export interface ImportedCopperLayer {
  /** Copper layer name in the template's stackup. */
  layerName: string;
  /** Where the shapes came from, for error messages. */
  sourceName: string;
  shapes: ImportedShape[];
}

const lengthString = (mm: number) => `${roundToNanometre(mm)} mm`;

/** Round to 1 nm and drop repeated consecutive points (including a repeated closing point). */
function roundedPolygon(polygon: Vec2[]): Vec2[] {
  const rounded = polygon.map(([x, y]): Vec2 => [roundToNanometre(x), roundToNanometre(y)]);
  return rounded.filter(([x, y], n) => {
    const [px, py] = rounded[(n + rounded.length - 1) % rounded.length];
    return rounded.length === 1 || x !== px || y !== py;
  });
}

const toPoints = (polygon: Vec2[]): Point[] => polygon.map(([x, y]) => [lengthString(x), lengthString(y)]);

export function buildImportedProject(template: unknown, layers: ImportedCopperLayer[], outline: Vec2[] | undefined): Project {
  return parseProject(mergeImported(template, layers, outline));
}

/**
 * The template with the imported copper and outline written in, not yet
 * validated: for a project still being built, such as a new blank board with
 * no port.
 */
export function mergeImported(template: unknown, layers: ImportedCopperLayer[], outline: Vec2[] | undefined): Record<string, unknown> {
  if (typeof template !== 'object' || template === null || Array.isArray(template)) throw new ImportError('the template must be a JSON object');
  const geometry: Record<string, unknown> = { ...((template as { geometry?: Record<string, unknown> }).geometry ?? {}) };
  const imported = new Set<string>();
  for (const { layerName, sourceName, shapes } of layers) {
    if (imported.has(layerName)) throw new ImportError(`copper layer "${layerName}" is imported twice`);
    imported.add(layerName);
    const copper: CopperShape[] = [];
    for (const shape of shapes) {
      const polygon = roundedPolygon(shape.polygon);
      if (polygon.length < 3 || Math.abs(signedPolygonArea(polygon)) < 1e-12) continue;
      const id = `${layerName}-${copper.length + 1}`;
      if (id.length > 32) throw new ImportError(`layer name "${layerName}" is too long to number its shapes (shape ids are at most 32 characters)`);
      copper.push({ id, op: shape.op, polygon: toPoints(polygon) });
    }
    if (copper.length === 0) throw new ImportError(`${sourceName}: no copper with any area for layer "${layerName}"`);
    geometry[layerName] = copper;
  }
  const project: Record<string, unknown> = { ...template, geometry };
  if (outline) {
    const polygon = roundedPolygon(outline);
    if (polygon.length < 3) throw new ImportError('the board outline has fewer than 3 distinct points');
    project.board = { outline: toPoints(polygon) };
  }
  return project;
}

/**
 * The project as JSON text, two-space indented, with each [x, y] point (or
 * other pair of strings) on one line so long polygons stay readable.
 */
export function serialiseProject(project: Project): string {
  return JSON.stringify(project, null, 2).replace(/\[\s+("(?:[^"\\]|\\.)*"),\s+("(?:[^"\\]|\\.)*")\s+\]/g, '[$1, $2]') + '\n';
}
