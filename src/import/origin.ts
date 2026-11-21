import { evaluateLength, ExpressionError } from '../project/expression';
import type { Vec2 } from '../project/resolve';
import { boundingBox, ImportError } from './geometry';

/**
 * Where the imported files' point (0, 0) should move. CAD and PCB tools often
 * export page coordinates, so a board sits at (150 mm, -80 mm) while the
 * template's port is typed near the origin. `--origin` names the point in
 * the files' coordinates that becomes (0, 0) in the project:
 *
 *   --origin "150 mm, -80 mm"   a point, lengths with units
 *   --origin outline-min        the outline's lower-left bounding-box corner
 *   --origin outline-center     the centre of the outline's bounding box
 *
 * The keywords need an imported outline. Every imported shape and the
 * outline move by the same amount; the template (port, variables) does not
 * move, so it is written in the shifted coordinates.
 */

export const ORIGIN_KEYWORDS = ['outline-min', 'outline-center'] as const;

export type OriginSpec = { point: Vec2 } | { keyword: (typeof ORIGIN_KEYWORDS)[number] };

export function parseOriginSpec(text: string): OriginSpec {
  const keyword = ORIGIN_KEYWORDS.find((k) => k === text.trim());
  if (keyword) return { keyword };
  const parts = text.split(',');
  if (parts.length !== 2) {
    throw new ImportError(`--origin "${text}": expected "<x>, <y>" with units (e.g. "150 mm, -80 mm") or one of ${ORIGIN_KEYWORDS.join(', ')}`);
  }
  const noVariables = (name: string): never => {
    throw new ExpressionError(`"${name}" is not a unit; --origin takes plain lengths such as "150 mm"`);
  };
  try {
    return { point: [evaluateLength(parts[0].trim(), noVariables), evaluateLength(parts[1].trim(), noVariables)] };
  } catch (e) {
    if (e instanceof ExpressionError) throw new ImportError(`--origin "${text}": ${e.message}`);
    throw e;
  }
}

/** The point (in the files' mm) that becomes (0, 0). */
export function resolveOrigin(spec: OriginSpec, outline: Vec2[] | undefined): Vec2 {
  if ('point' in spec) return spec.point;
  if (!outline) throw new ImportError(`--origin ${spec.keyword} needs an imported outline (--outline)`);
  const box = boundingBox([outline]);
  return spec.keyword === 'outline-min' ? [box.minX, box.minY] : [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2];
}
