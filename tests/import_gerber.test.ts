import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARC_CHORD_TOLERANCE_MM, ImportError } from '../src/import/geometry';
import { gerberOutline, parseGerber } from '../src/import/gerber';
import { area, expectBox, expectChordedArea, FIXTURES, paintedArea } from './import_helpers';

const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

/** A minimal Gerber file in mm, 4.6 format, around `body` lines. */
const gerber = (...body: string[]) => ['%FSLAX46Y46*%', '%MOMM*%', ...body, 'M02*'].join('\n');

describe('Gerber import: KiCad-style copper layer', () => {
  const image = parseGerber(fixture('board-F_Cu.gbr'), 'board-F_Cu.gbr');
  // Painting order: rectangle flash, RoundRect flash (9 primitives), line, arc (band + 2 caps), region, clear flash.
  const [rectangle, ...rest] = image.shapes;
  const roundRect = rest.slice(0, 9);
  const [line, arcBand, arcCapStart, arcCapEnd, region, clearCircle] = rest.slice(9);

  it('reads every object in file order with its polarity', () => {
    expect(image.shapes).toHaveLength(16);
    expect(image.shapes.slice(0, -1).every((s) => s.op === 'add')).toBe(true);
    expect(clearCircle.op).toBe('cut');
    expect(image.flashCount).toBe(3);
    expect(image.regionCount).toBe(1);
    expect(image.drawnPaths).toHaveLength(2);
  });

  it('flashes a 2 x 1 mm rectangle at (10, 5)', () => {
    expect(area(rectangle.polygon)).toBeCloseTo(2, 12);
    expectBox([rectangle.polygon], [9, 4.5, 11, 5.5]);
  });

  it('flashes a KiCad RoundRect macro as a 2 x 1 mm pad with 0.25 mm corners', () => {
    expectBox(roundRect.map((s) => s.polygon), [39, 4.5, 41, 5.5]);
    const exact = 2 - (4 - Math.PI) * 0.25 ** 2;
    // The four rounded corners together are one chorded circle of radius 0.25 mm; sampling adds up to 0.002 mm^2.
    const painted = paintedArea(roundRect, [39, 4.5, 41, 5.5], 0.005);
    expect(painted).toBeLessThanOrEqual(exact + 0.002);
    expect(painted).toBeGreaterThanOrEqual(exact - ARC_CHORD_TOLERANCE_MM * 2 * Math.PI * 0.25 - 0.002);
  });

  it('strokes a 10 mm line with a 0.5 mm round pen into a stadium', () => {
    expectChordedArea(area(line.polygon), 10 * 0.5 + Math.PI * 0.25 ** 2, 2 * Math.PI * 0.25);
    expectBox([line.polygon], [-0.25, -0.25, 10.25, 0.25]);
  });

  it('strokes a quarter arc of radius 5 into a ring band with round caps', () => {
    const exactBand = (Math.PI / 4) * (5.25 ** 2 - 4.75 ** 2);
    expectChordedArea(area(arcBand.polygon), exactBand, (Math.PI / 2) * 10.0);
    expectBox([arcBand.polygon], [25, 0, 30.25, 5.25]);
    expectBox([arcCapStart.polygon], [29.75, -0.25, 30.25, 0.25]);
    expectBox([arcCapEnd.polygon], [24.75, 4.75, 25.25, 5.25]);
  });

  it('reads a region with a G03 arc and cuts the clear-polarity flash out of it', () => {
    const exactRegion = 100 + (Math.PI * 25) / 2;
    expectChordedArea(area(region.polygon), exactRegion, Math.PI * 5);
    expectBox([region.polygon], [0, 10, 10, 25]);
    expectChordedArea(area(clearCircle.polygon), Math.PI, 2 * Math.PI);
    expect(paintedArea([region, clearCircle], [0, 10, 10, 25], 0.02)).toBeCloseTo(exactRegion - Math.PI, 0);
  });
});

describe('Gerber import: board outline', () => {
  it('chains the Edge.Cuts lines and arc (one drawn backwards) into one closed loop', () => {
    const outline = gerberOutline(parseGerber(fixture('board-Edge_Cuts.gbr'), 'edge.gbr'), 'edge.gbr');
    expectChordedArea(area(outline), 47 * 30 - 9 + (Math.PI * 9) / 4, (Math.PI / 2) * 3);
    expectBox([outline], [-2, -2, 45, 28]);
  });

  it('refuses an outline that does not close', () => {
    const open = parseGerber(gerber('%ADD10C,0.1*%', 'D10*', 'G01*', 'X0Y0D02*', 'X10000000Y0D01*', 'X10000000Y10000000D01*'), 'open.gbr');
    expect(() => gerberOutline(open, 'open.gbr')).toThrow(/open\.gbr: board outline: a path ends at \((0|10)\.0000, .*nothing joined to it/);
  });
});

describe('Gerber import: formats', () => {
  it('reads inch files', () => {
    const image = parseGerber(['%FSLAX24Y24*%', '%MOIN*%', '%ADD10R,0.1X0.05*%', 'D10*', 'X10000Y10000D03*', 'M02*'].join('\n'), 'inch.gbr');
    expect(area(image.shapes[0].polygon)).toBeCloseTo(0.1 * 0.05 * 25.4 ** 2, 12);
    expectBox([image.shapes[0].polygon], [25.4 - 1.27, 25.4 - 0.635, 25.4 + 1.27, 25.4 + 0.635]);
  });

  it('reads trailing-zero-omitted coordinates', () => {
    const image = parseGerber(['%FSTAX23Y23*%', '%MOMM*%', '%ADD10R,2X2*%', 'D10*', 'X1Y-02D03*', 'M02*'].join('\n'), 'trailing.gbr');
    expectBox([image.shapes[0].polygon], [9, -3, 11, -1]);
  });

  it('reads macro variables and arithmetic', () => {
    const image = parseGerber(gerber('%AMBOX*$3=$1x2*21,1,$3,$2/2+(1-1),0,0,90*%', '%ADD10BOX,1.5X4*%', 'D10*', 'X0Y0D03*'), 'macro.gbr');
    // 3 mm wide, 2 mm high, rotated by 90 degrees: 2 mm wide, 3 mm high.
    expectBox([image.shapes[0].polygon], [-1, -1.5, 1, 1.5]);
  });

  it('flashes regular polygon and obround apertures', () => {
    const image = parseGerber(gerber('%ADD10P,2X4X45*%', '%ADD11O,3X1*%', 'D10*', 'X0Y0D03*', 'D11*', 'X0Y0D03*'), 'shapes.gbr');
    expect(area(image.shapes[0].polygon)).toBeCloseTo(2, 12); // a square with a 2 mm diagonal
    expectChordedArea(area(image.shapes[1].polygon), 2 + Math.PI * 0.25, Math.PI);
    expectBox([image.shapes[1].polygon], [-1.5, -0.5, 1.5, 0.5]);
  });
});

describe('Gerber import: errors name the line', () => {
  it.each([
    ['step and repeat', ['%SRX2Y2I5.0J5.0*%'], /bad\.gbr:3: unsupported extended command "%SRX2Y2I5\.0J5\.0\*%"/],
    ['single-quadrant arcs', ['G74*'], /bad\.gbr:3: G74 single-quadrant arc mode is not supported/],
    ['an aperture hole', ['%ADD10C,1X0.5*%'], /bad\.gbr:3: aperture D10 has a hole/],
    ['an unknown G code', ['G12*'], /bad\.gbr:3: unsupported G code G12/],
    ['incremental coordinates', ['G91*'], /bad\.gbr:3: G91 incremental/],
    ['a thermal macro primitive', ['%AMT*7,0,0,1,0.8,0.1,0*%', '%ADD10T*%'], /bad\.gbr:4: macro "T": macro primitive 7 is not supported/],
    ['clear exposure in a macro', ['%AMCLR*1,0,1,0,0*%', '%ADD10CLR*%'], /bad\.gbr:4: macro "CLR": .*clear exposure/],
    ['an open region contour', ['G01*', 'G36*', 'X0Y0D02*', 'X1000000Y0D01*', 'X0Y1000000D01*', 'G37*'], /bad\.gbr:8: region contour is not closed/],
    ['an undefined aperture', ['D11*'], /bad\.gbr:3: aperture D11 is not defined/],
    ['an arc without G75', ['%ADD10C,0.1*%', 'D10*', 'G03*', 'X0Y0D02*', 'X0Y0I1000000J0D01*'], /bad\.gbr:7: arc in single-quadrant mode/],
  ])('refuses %s', (_, body, message) => {
    expect(() => parseGerber(gerber(...body), 'bad.gbr')).toThrow(ImportError);
    expect(() => parseGerber(gerber(...body), 'bad.gbr')).toThrow(message);
  });

  it('refuses a truncated file without M02', () => {
    expect(() => parseGerber('%FSLAX46Y46*%\n%MOMM*%\n', 'cut.gbr')).toThrow(/cut\.gbr: the file has no end-of-file command \(M02\)/);
  });

  it('refuses coordinates before the format', () => {
    expect(() => parseGerber('%MOMM*%\n%ADD10C,1*%\nD10*\nX0Y0D03*\nM02*', 'early.gbr')).toThrow(/early\.gbr:4: a coordinate appears before the format/);
  });
});
