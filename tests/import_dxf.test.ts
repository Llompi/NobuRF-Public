import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dxfLayerOutline, dxfLayerShapes, parseDxf } from '../src/import/dxf';
import { ARC_CHORD_TOLERANCE_MM } from '../src/import/geometry';
import { area, expectBox, expectChordedArea, FIXTURES, paintedArea } from './import_helpers';

const fixtureText = readFileSync(join(FIXTURES, 'board.dxf'), 'utf8');

/** A DXF file with only an ENTITIES section, from [code, value] pairs. */
const dxfEntities = (...pairs: Array<[number, string | number]>) =>
  [[0, 'SECTION'], [2, 'ENTITIES'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']].map(([code, value]) => `${code}\n${value}`).join('\n') + '\n';

describe('DXF import', () => {
  const drawing = parseDxf(fixtureText, 'board.dxf');

  it('reads a closed LWPOLYLINE with a bulge arc, and a nested circle as a hole', () => {
    const [patch, hole] = dxfLayerShapes(drawing, 'PATCH');
    expect([patch.op, hole.op]).toEqual(['add', 'cut']);
    // A 10 mm square whose right side bulges out into a semicircle of radius 5.
    const exactPatch = 100 + (Math.PI * 25) / 2;
    expectChordedArea(area(patch.polygon), exactPatch, Math.PI * 5);
    expectBox([patch.polygon], [0, 0, 15, 10]);
    expectChordedArea(area(hole.polygon), Math.PI * 4, Math.PI * 4);
    expectBox([hole.polygon], [3, 3, 7, 7]);
    expect(paintedArea([patch, hole], [0, 0, 15, 10], 0.02)).toBeCloseTo(exactPatch - Math.PI * 4, 0);
  });

  it('reads a closed POLYLINE with VERTEX entities', () => {
    const [ground] = dxfLayerShapes(drawing, 'GND');
    expect(area(ground.polygon)).toBeCloseTo(47 * 30, 9);
    expectBox([ground.polygon], [-2, -2, 45, 28]);
  });

  it('chains LINE and ARC entities (one drawn backwards) into an outline', () => {
    const outline = dxfLayerOutline(drawing, 'OUTLINE');
    expectChordedArea(area(outline), 47 * 30 - 9 + (Math.PI * 9) / 4, (Math.PI / 2) * 3);
    expectBox([outline], [-2, -2, 45, 28]);
  });

  it('bends the other way for a negative bulge', () => {
    const text = dxfEntities(
      [0, 'LWPOLYLINE'], [8, 'L'], [70, 1],
      [10, 0], [20, 0], [10, 10], [20, 0], [42, -1], [10, 10], [20, 10], [10, 0], [20, 10],
    );
    const [shape] = dxfLayerShapes(parseDxf(text, 'concave.dxf', 'mm'), 'L');
    // The chords cut less out of the square than the true arc, so the area is a little above the exact value.
    const exact = 100 - (Math.PI * 25) / 2;
    expect(area(shape.polygon)).toBeGreaterThanOrEqual(exact);
    expect(area(shape.polygon)).toBeLessThanOrEqual(exact + ARC_CHORD_TOLERANCE_MM * Math.PI * 5);
    expectBox([shape.polygon], [0, 0, 10, 10]);
  });

  it('refuses unsupported entities on a requested layer, naming the line, and ignores other layers', () => {
    const textLine = fixtureText.split('\n').indexOf('TEXT'); // the code line before it, 1-based
    expect(() => dxfLayerShapes(drawing, 'NOTES')).toThrow(`board.dxf:${textLine}: TEXT on layer "NOTES": is not supported`);
  });

  it('names the layers it has when a layer is missing', () => {
    expect(() => dxfLayerShapes(drawing, 'TOP')).toThrow('no entities on layer "TOP" (layers with entities: GND, NOTES, OUTLINE, PATCH)');
  });

  it('refuses a layer whose lines do not close', () => {
    const text = dxfEntities([0, 'LINE'], [8, 'L'], [10, 0], [20, 0], [11, 5], [21, 0]);
    expect(() => dxfLayerShapes(parseDxf(text, 'open.dxf', 'mm'), 'L')).toThrow(/open\.dxf: layer "L": a path ends at .* nothing joined to it/);
  });

  it('needs units from $INSUNITS or the caller, and they must agree', () => {
    const noHeader = dxfEntities([0, 'CIRCLE'], [8, 'C'], [10, 0], [20, 0], [40, 1]);
    expect(() => parseDxf(noHeader, 'bare.dxf')).toThrow('bare.dxf: the file has no $INSUNITS; give its unit');
    const [inchCircle] = dxfLayerShapes(parseDxf(noHeader, 'bare.dxf', 'in'), 'C');
    expectBox([inchCircle.polygon], [-25.4, -25.4, 25.4, 25.4]);
    expect(() => parseDxf(fixtureText, 'board.dxf', 'in')).toThrow(`$INSUNITS says "mm" but "in" was given`);
  });

  it('refuses mirrored (object coordinate system) entities and wide polylines', () => {
    const mirrored = dxfEntities([0, 'CIRCLE'], [8, 'C'], [10, 0], [20, 0], [40, 1], [230, -1]);
    expect(() => dxfLayerShapes(parseDxf(mirrored, 'm.dxf', 'mm'), 'C')).toThrow(/m\.dxf:5: CIRCLE on layer "C": uses an object coordinate system/);
    const wide = dxfEntities([0, 'LWPOLYLINE'], [8, 'W'], [70, 1], [43, 0.5], [10, 0], [20, 0], [10, 1], [20, 0], [10, 1], [20, 1]);
    expect(() => dxfLayerShapes(parseDxf(wide, 'w.dxf', 'mm'), 'W')).toThrow(/w\.dxf:5: LWPOLYLINE on layer "W": has a width/);
  });
});
