/**
 * Whether each lumped port touches copper on both layers it connects. A port
 * in bare laminate still solves, but it drives nothing, so the result is
 * meaningless; this is the most common way an import or an edit breaks a
 * board without breaking the project file.
 */
import type { ResolvedProject, ResolvedShape, Vec2 } from '../project/resolve';

/** Points this close to a shape's outline count as on it (feeds usually end exactly at the port). */
const ON_EDGE_MM = 1e-6;

function distanceToSegment([px, py]: Vec2, [ax, ay]: Vec2, [bx, by]: Vec2): number {
  const [dx, dy] = [bx - ax, by - ay];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function onOutline(polygon: Vec2[], point: Vec2): boolean {
  return polygon.some((a, n) => distanceToSegment(point, a, polygon[(n + 1) % polygon.length]) <= ON_EDGE_MM);
}

function strictlyInside(polygon: Vec2[], [x, y]: Vec2): boolean {
  let inside = false;
  for (let n = 0, prev = polygon.length - 1; n < polygon.length; prev = n++) {
    const [ax, ay] = polygon[prev];
    const [bx, by] = polygon[n];
    if (ay > y !== by > y && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  return inside && !onOutline(polygon, [x, y]);
}

/**
 * Copper at `point` after painting `shapes` in order: an add covers its inside
 * and its outline, a cut removes only its inside, as the rasteriser does.
 */
export function copperAt(shapes: ResolvedShape[], point: Vec2): boolean {
  let copper = false;
  for (const shape of shapes) {
    if (shape.op === 'add' && (strictlyInside(shape.polygon, point) || onOutline(shape.polygon, point))) copper = true;
    else if (shape.op === 'cut' && strictlyInside(shape.polygon, point)) copper = false;
  }
  return copper;
}

/** One line per lumped port that misses copper on a layer it connects, e.g. 'Port feed is not on copper on layer "top".' */
export function portsOffCopper(project: ResolvedProject): string[] {
  const problems: string[] = [];
  for (const port of project.ports) {
    if (port.kind !== 'lumped') continue; // An SMA launch sits on the board edge; the rasteriser checks it.
    const missing = port.between.filter((layer) => !copperAt(project.copper[layer] ?? [], [port.xMm, port.yMm]));
    if (missing.length) {
      problems.push(`Port ${port.id} is not on copper on ${missing.length > 1 ? 'layers' : 'layer'} ${missing.map((l) => `"${l}"`).join(' and ')}, so it drives nothing. Move the port or the copper.`);
    }
  }
  return problems;
}
