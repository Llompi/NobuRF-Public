import { expect } from 'vitest';
import { ARC_CHORD_TOLERANCE_MM, boundingBox, pointInPolygon, signedPolygonArea, type ImportedShape } from '../src/import/geometry';
import type { Vec2 } from '../src/project/resolve';

export const FIXTURES = 'tests/fixtures/import';

export const area = (polygon: Vec2[]) => Math.abs(signedPolygonArea(polygon));

/**
 * Chords inscribed in a curve lose at most the tolerance times the curve
 * length; they never add area.
 */
export function expectChordedArea(actual: number, exact: number, curveLengthMm: number): void {
  expect(actual).toBeLessThanOrEqual(exact + 1e-9);
  expect(actual).toBeGreaterThanOrEqual(exact - ARC_CHORD_TOLERANCE_MM * curveLengthMm);
}

/** Bounding box of the polygons against [minX, minY, maxX, maxY], within the chord tolerance. */
export function expectBox(polygons: Vec2[][], [minX, minY, maxX, maxY]: number[]): void {
  const box = boundingBox(polygons);
  for (const [actual, expected] of [[box.minX, minX], [box.minY, minY], [box.maxX, maxX], [box.maxY, maxY]]) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(ARC_CHORD_TOLERANCE_MM + 1e-9);
  }
}

/** Copper area after painting `shapes` in order, by sampling cell centres of `stepMm` over [minX, minY, maxX, maxY]. */
export function paintedArea(shapes: ImportedShape[], [minX, minY, maxX, maxY]: number[], stepMm: number): number {
  let cells = 0;
  for (let y = minY + stepMm / 2; y < maxY; y += stepMm) {
    for (let x = minX + stepMm / 2; x < maxX; x += stepMm) {
      let copper = false;
      for (const s of shapes) if (pointInPolygon(s.polygon, [x, y])) copper = s.op === 'add';
      if (copper) cells++;
    }
  }
  return cells * stepMm * stepMm;
}
