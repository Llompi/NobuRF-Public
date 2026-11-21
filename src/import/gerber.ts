import type { Vec2 } from '../project/resolve';
import {
  arcBandPolygon, arcPathPoints, chainIntoClosedLoops, circlePolygon, convexHull, counterClockwiseSweep,
  failImport, rotatePoint, translatePolygon, type ImportedShape,
} from './geometry';

/**
 * RS-274X (Gerber X2/X3) reader for copper and board-outline layers: the
 * subset that KiCad, Altium, Eagle and friends write for those layers.
 *
 * Supported:
 *   %FS (leading or trailing zero omission, absolute), %MO MM / IN (and the
 *   deprecated G70 / G71), %AD with C, R, O and P apertures, %AM aperture
 *   macros with primitives 1 (circle), 4 (outline), 5 (polygon), 20 (vector
 *   line), 21 (center line), variables and arithmetic, D01 / D02 / D03,
 *   G01, G02 / G03 with G75, G36 / G37 regions, %LP D / C, %IP POS, and the
 *   deprecated G54 / G55 / G90 prefixes. Attributes (%TF %TA %TO %TD), %IN
 *   and G04 comments carry no geometry and are read past.
 * Refused with an error naming the line: anything else, e.g. %SR step and
 * repeat, %AB block apertures, %LM / %LR / %LS transforms, %IP NEG,
 * incremental coordinates, G74 single-quadrant arcs, aperture holes, macro
 * primitive 7 (thermal) and clear exposure inside a macro.
 *
 * Output, in mm: the painted copper as polygons in file order (dark
 * polarity is "add", clear is "cut"), and the centre line of every drawn
 * line or arc outside regions (for board outlines). Flashes and strokes
 * become polygons: a circle within ARC_CHORD_TOLERANCE_MM, a round-pen line
 * is the hull of the two end circles, an arc is a ring band plus two
 * round caps (three shapes).
 */

export interface GerberImage {
  /** Copper in painting order. */
  shapes: ImportedShape[];
  /** Centre lines of D01 draws outside regions, as point lists. */
  drawnPaths: Vec2[][];
  flashCount: number;
  regionCount: number;
}

type Aperture =
  | { kind: 'circle'; diameterMm: number }
  | { kind: 'rectangle'; widthMm: number; heightMm: number }
  | { kind: 'obround'; widthMm: number; heightMm: number }
  | { kind: 'polygon'; outerDiameterMm: number; vertices: number; rotationDeg: number }
  | { kind: 'macro'; name: string; polygons: Vec2[][] };

interface GerberCommand {
  text: string;
  line: number;
  extended: boolean;
}

/** Split the file into word commands ("X1Y2D01") and extended commands ("%ADD10C,0.5*%" -> "ADD10C,0.5"). */
function tokenize(text: string, sourceName: string): GerberCommand[] {
  const commands: GerberCommand[] = [];
  let line = 1;
  let n = 0;
  const readBlock = (stopAt: string): { body: string; startLine: number } => {
    const startLine = line;
    let body = '';
    while (n < text.length && text[n] !== stopAt) {
      if (text[n] === '\n') line++;
      else if (text[n] !== '\r') body += text[n];
      n++;
    }
    if (n >= text.length) failImport(sourceName, startLine, `command "${body.slice(0, 40)}" is not terminated by "${stopAt}"`);
    n++;
    return { body, startLine };
  };
  while (n < text.length) {
    const c = text[n];
    if (c === '\n') {
      line++;
      n++;
    } else if (/\s/.test(c)) {
      n++;
    } else if (c === '%') {
      n++;
      const { body, startLine } = readBlock('%');
      // One % ... % may hold several *-terminated blocks; an aperture macro keeps them together.
      if (body.startsWith('AM')) commands.push({ text: body, line: startLine, extended: true });
      else for (const block of body.split('*')) if (block.trim()) commands.push({ text: block.trim(), line: startLine, extended: true });
    } else {
      const { body, startLine } = readBlock('*');
      commands.push({ text: body.trim(), line: startLine, extended: false });
    }
  }
  return commands;
}

/* ------------------------------------------------------------------------ */
/* Aperture macros                                                            */
/* ------------------------------------------------------------------------ */

/** Evaluate a macro expression: numbers, $n variables, + - x / and parentheses. */
function evaluateMacroExpression(source: string, variables: Map<number, number>, fail: (message: string) => never): number {
  const tokens = source.replace(/\s+/g, '').match(/\$\d+|\d*\.?\d+(?:[eE][+-]?\d+)?|[-+xX/()]|./g) ?? [];
  let n = 0;
  const peek = () => tokens[n];
  const expression = (): number => {
    let value = term();
    while (peek() === '+' || peek() === '-') value = tokens[n++] === '+' ? value + term() : value - term();
    return value;
  };
  const term = (): number => {
    let value = unary();
    while (peek() === 'x' || peek() === 'X' || peek() === '/') value = tokens[n++] === '/' ? value / unary() : value * unary();
    return value;
  };
  const unary = (): number => {
    if (peek() === '-') { n++; return -unary(); }
    if (peek() === '+') { n++; return unary(); }
    return primary();
  };
  const primary = (): number => {
    const t = tokens[n++];
    if (t === undefined) fail(`expression "${source}" ends unexpectedly`);
    if (t === '(') {
      const value = expression();
      if (tokens[n++] !== ')') fail(`expression "${source}" is missing ")"`);
      return value;
    }
    if (t.startsWith('$')) {
      const value = variables.get(Number(t.slice(1)));
      // An unset variable is 0 by the specification.
      return value ?? 0;
    }
    const value = Number(t);
    if (!Number.isFinite(value)) fail(`unexpected "${t}" in expression "${source}"`);
    return value;
  };
  const value = expression();
  if (n !== tokens.length) fail(`unexpected "${tokens[n]}" in expression "${source}"`);
  if (!Number.isFinite(value)) fail(`expression "${source}" does not evaluate to a finite number`);
  return value;
}

/**
 * Instantiate a macro with its aperture parameters, as polygons in mm
 * around the flash point. `unitMm` converts the macro's lengths.
 */
function instantiateMacro(macroBlocks: string[], parameters: number[], unitMm: number, fail: (message: string) => never): Vec2[][] {
  const variables = new Map<number, number>(parameters.map((p, n) => [n + 1, p]));
  const polygons: Vec2[][] = [];
  for (const block of macroBlocks) {
    if (/^0(\s|$)/.test(block)) continue; // comment primitive
    const assignment = /^\$(\d+)=(.+)$/.exec(block);
    if (assignment) {
      variables.set(Number(assignment[1]), evaluateMacroExpression(assignment[2], variables, fail));
      continue;
    }
    const [code, ...fields] = block.split(',');
    const values = fields.map((f) => evaluateMacroExpression(f, variables, fail));
    const need = (count: number) => {
      if (values.length < count) fail(`macro primitive ${code} needs ${count} parameters, got ${values.length}`);
    };
    const mm = (v: number) => v * unitMm;
    if (!['1', '4', '5', '20', '21'].includes(code.trim())) {
      fail(`macro primitive ${code} is not supported (supported: 1 circle, 4 outline, 5 polygon, 20 vector line, 21 center line)`);
    }
    need(1);
    if (values[0] !== 1) fail(`macro primitive "${block}" has clear exposure (0); only dark exposure is supported inside a macro`);
    const place = (shape: Vec2[], rotationDeg: number) => shape.map((p) => rotatePoint(p, rotationDeg));
    switch (code.trim()) {
      case '1': { // circle: exposure, diameter, cx, cy[, rotation]
        need(4);
        polygons.push(place(circlePolygon([mm(values[2]), mm(values[3])], mm(values[1]) / 2), values[4] ?? 0));
        break;
      }
      case '20': { // vector line: exposure, width, sx, sy, ex, ey, rotation
        need(7);
        const [w, sx, sy, ex, ey] = values.slice(1, 6).map(mm);
        const length = Math.hypot(ex - sx, ey - sy);
        const [nx, ny] = length > 0 ? [(-(ey - sy) / length) * (w / 2), ((ex - sx) / length) * (w / 2)] : [0, 0];
        polygons.push(place([[sx + nx, sy + ny], [ex + nx, ey + ny], [ex - nx, ey - ny], [sx - nx, sy - ny]], values[6]));
        break;
      }
      case '21': { // center line: exposure, width, height, cx, cy, rotation
        need(6);
        const [w, h, cx, cy] = values.slice(1, 5).map(mm);
        polygons.push(place([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], values[5]));
        break;
      }
      case '4': { // outline: exposure, n, x0, y0, ..., xn, yn, rotation
        need(2);
        const vertexCount = values[1] + 1;
        need(2 + 2 * vertexCount + 1);
        const points = Array.from({ length: vertexCount }, (_, k): Vec2 => [mm(values[2 + 2 * k]), mm(values[3 + 2 * k])]);
        points.pop(); // the last point repeats the first
        polygons.push(place(points, values[2 + 2 * vertexCount]));
        break;
      }
      case '5': { // polygon: exposure, vertices, cx, cy, diameter, rotation
        need(6);
        if (!Number.isInteger(values[1]) || values[1] < 3 || values[1] > 12) fail(`macro polygon needs 3 to 12 vertices, got ${values[1]}`);
        polygons.push(place(regularPolygon([mm(values[2]), mm(values[3])], mm(values[4]), values[1], 0), values[5]));
        break;
      }
    }
  }
  return polygons;
}

function regularPolygon(center: Vec2, outerDiameterMm: number, vertices: number, rotationDeg: number): Vec2[] {
  return Array.from({ length: vertices }, (_, k): Vec2 => {
    const a = ((rotationDeg + (360 * k) / vertices) * Math.PI) / 180;
    return [center[0] + (outerDiameterMm / 2) * Math.cos(a), center[1] + (outerDiameterMm / 2) * Math.sin(a)];
  });
}

/** Aperture outline around the origin, as one or more polygons. */
function aperturePolygons(aperture: Aperture): Vec2[][] {
  switch (aperture.kind) {
    case 'circle':
      return [circlePolygon([0, 0], aperture.diameterMm / 2)];
    case 'rectangle': {
      const [w, h] = [aperture.widthMm / 2, aperture.heightMm / 2];
      return [[[-w, -h], [w, -h], [w, h], [-w, h]]];
    }
    case 'obround': {
      // A stadium: the hull of two circles on the long axis.
      const radius = Math.min(aperture.widthMm, aperture.heightMm) / 2;
      const offset = Math.max(aperture.widthMm, aperture.heightMm) / 2 - radius;
      const [a, b]: Vec2[] = aperture.widthMm >= aperture.heightMm ? [[-offset, 0], [offset, 0]] : [[0, -offset], [0, offset]];
      return [convexHull([...circlePolygon(a, radius), ...circlePolygon(b, radius)])];
    }
    case 'polygon':
      return [regularPolygon([0, 0], aperture.outerDiameterMm, aperture.vertices, aperture.rotationDeg)];
    case 'macro':
      return aperture.polygons;
  }
}

/* ------------------------------------------------------------------------ */
/* The reader                                                                 */
/* ------------------------------------------------------------------------ */

const WORD_COMMAND = /^(?:G0*(\d+))?(?:X([+-]?\d+))?(?:Y([+-]?\d+))?(?:I([+-]?\d+))?(?:J([+-]?\d+))?(?:D0*(\d+))?$/;

/** Arcs whose start and end radii differ by more than this are refused. */
const ARC_RADIUS_MISMATCH_MM = 1e-3;

export function parseGerber(text: string, sourceName: string): GerberImage {
  const image: GerberImage = { shapes: [], drawnPaths: [], flashCount: 0, regionCount: 0 };
  let line = 0;
  function fail(message: string): never {
    return failImport(sourceName, line || undefined, message);
  }

  let format: { integerDigits: number; decimalDigits: number; trailingZerosOmitted: boolean } | undefined;
  let unitMm: number | undefined;
  const macros = new Map<string, string[]>();
  const apertures = new Map<number, Aperture>();
  let currentAperture: Aperture | undefined;
  let currentApertureNumber: number | undefined;
  let interpolation: 'linear' | 'clockwise' | 'counterclockwise' | undefined;
  let multiQuadrant = false;
  let polarity: 'add' | 'cut' = 'add';
  let point: Vec2 | undefined;
  let region: { contours: Vec2[][]; contour: Vec2[] | undefined } | undefined;
  let ended = false;

  const requireUnits = () => unitMm ?? fail('a length appears before the unit is set (%MOMM*% or %MOIN*%)');

  const coordinate = (digits: string | undefined, current: number | undefined, axis: string): number => {
    if (digits === undefined) {
      if (current === undefined) fail(`${axis} is missing and there is no current point to take it from`);
      return current;
    }
    if (!format) fail('a coordinate appears before the format is set (%FS...*%)');
    const sign = digits.startsWith('-') ? -1 : 1;
    let magnitude = digits.replace(/^[+-]/, '');
    const totalDigits = format.integerDigits + format.decimalDigits;
    if (magnitude.length > totalDigits) fail(`coordinate ${digits} has more than the ${totalDigits} digits set by %FS`);
    if (format.trailingZerosOmitted) magnitude = magnitude.padEnd(totalDigits, '0');
    return (sign * Number(magnitude) * requireUnits()) / 10 ** format.decimalDigits;
  };
  /** I and J are offsets, never modal. */
  const offset = (digits: string | undefined) => (digits === undefined ? 0 : coordinate(digits, undefined, 'offset'));

  const paint = (polygon: Vec2[]) => image.shapes.push({ op: polarity, polygon });

  const flash = (at: Vec2) => {
    if (!currentAperture) fail('D03 flash before any aperture is selected');
    for (const polygon of aperturePolygons(currentAperture)) paint(translatePolygon(polygon, at));
    image.flashCount++;
  };

  /** The arc from `from` to `to` with centre offset (i, j), as a centre, radius and signed sweep. */
  const arcGeometry = (from: Vec2, to: Vec2, i: number, j: number) => {
    if (!multiQuadrant) fail('arc in single-quadrant mode; only multi-quadrant arcs (G75) are supported');
    const center: Vec2 = [from[0] + i, from[1] + j];
    const radius = Math.hypot(from[0] - center[0], from[1] - center[1]);
    const endRadius = Math.hypot(to[0] - center[0], to[1] - center[1]);
    if (Math.abs(radius - endRadius) > ARC_RADIUS_MISMATCH_MM) {
      fail(`arc start and end are ${radius.toFixed(6)} mm and ${endRadius.toFixed(6)} mm from its center; they must be equal`);
    }
    const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
    const a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
    const sweep = interpolation === 'counterclockwise' ? counterClockwiseSweep(a0, a1) : -counterClockwiseSweep(a1, a0);
    return { center, radius, startAngle: a0, sweep };
  };

  const strokeLine = (from: Vec2, to: Vec2) => {
    if (!currentAperture) fail('D01 draw before any aperture is selected');
    if (currentAperture.kind !== 'circle' && currentAperture.kind !== 'rectangle') {
      fail(`a line drawn with a ${currentAperture.kind} aperture (D${currentApertureNumber}); only circle and rectangle apertures can draw`);
    }
    const [pen] = aperturePolygons(currentAperture);
    paint(convexHull([...translatePolygon(pen, from), ...translatePolygon(pen, to)]));
  };

  const strokeArc = (from: Vec2, to: Vec2, arc: ReturnType<typeof arcGeometry>) => {
    if (currentAperture?.kind !== 'circle') fail(`an arc drawn with ${currentAperture ? `a ${currentAperture.kind}` : 'no'} aperture; arcs need a circle aperture`);
    const halfWidth = currentAperture.diameterMm / 2;
    if (halfWidth >= arc.radius) fail(`arc of radius ${arc.radius} mm drawn with a ${2 * halfWidth} mm pen; the pen must be narrower than the arc's diameter`);
    paint(arcBandPolygon(arc.center, arc.radius, halfWidth, arc.startAngle, arc.sweep));
    paint(translatePolygon(circlePolygon([0, 0], halfWidth), from));
    paint(translatePolygon(circlePolygon([0, 0], halfWidth), to));
  };

  const interpolate = (to: Vec2, i: number, j: number) => {
    const from = point ?? fail('D01 draw without a current point');
    if (!interpolation) fail('D01 draw before the interpolation mode is set (G01, G02 or G03)');
    const arc = interpolation === 'linear' ? undefined : arcGeometry(from, to, i, j);
    const path: Vec2[] = arc ? arcPathPoints(from, to, arc.center, arc.sweep) : [to];
    if (region) {
      if (!region.contour) region.contour = [from];
      region.contour.push(...path);
      return;
    }
    if (arc) strokeArc(from, to, arc);
    else strokeLine(from, to);
    image.drawnPaths.push([from, ...path]);
  };

  const closeContour = () => {
    const contour = region?.contour;
    if (!contour) return;
    const [first, last] = [contour[0], contour[contour.length - 1]];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-9) {
      fail(`region contour is not closed: it starts at (${first.join(', ')}) mm and ends at (${last.join(', ')}) mm`);
    }
    region!.contours.push(contour.slice(0, -1));
    region!.contour = undefined;
  };

  const extendedCommand = (command: string) => {
    const code = command.slice(0, 2);
    switch (code) {
      case 'FS': {
        const m = /^FS([LT])([AI])X(\d)(\d)Y(\d)(\d)$/.exec(command);
        if (!m) fail(`unsupported format "%${command}*%"; expected e.g. %FSLAX46Y46*%`);
        if (m[2] === 'I') fail('incremental coordinates (%FS.I...) are not supported; export absolute coordinates');
        if (m[3] !== m[5] || m[4] !== m[6]) fail(`X and Y formats differ in "%${command}*%"`);
        format = { integerDigits: Number(m[3]), decimalDigits: Number(m[4]), trailingZerosOmitted: m[1] === 'T' };
        return;
      }
      case 'MO':
        if (command === 'MOMM') unitMm = 1;
        else if (command === 'MOIN') unitMm = 25.4;
        else fail(`unknown unit "%${command}*%"; expected %MOMM*% or %MOIN*%`);
        return;
      case 'LP':
        if (region) fail('polarity cannot change inside a region (G36 ... G37)');
        if (command === 'LPD') polarity = 'add';
        else if (command === 'LPC') polarity = 'cut';
        else fail(`unknown polarity "%${command}*%"; expected %LPD*% or %LPC*%`);
        return;
      case 'AM': {
        const [header, ...blocks] = command.split('*').map((b) => b.trim()).filter((b) => b !== '');
        macros.set(header.slice(2), blocks);
        return;
      }
      case 'AD':
        defineAperture(command);
        return;
      case 'IP':
        if (command !== 'IPPOS') fail(`"%${command}*%" (negative image) is not supported`);
        return;
      case 'TF': case 'TA': case 'TO': case 'TD': case 'IN':
        return; // attributes and the image name carry no geometry
      default:
        fail(`unsupported extended command "%${command}*%"`);
    }
  };

  const defineAperture = (command: string) => {
    const m = /^ADD(\d+)([A-Za-z_.$][A-Za-z0-9_.$-]*)(?:,(.*))?$/.exec(command);
    if (!m) fail(`cannot read aperture definition "%${command}*%"`);
    const number = Number(m[1]);
    if (number < 10) fail(`aperture number D${number} is reserved; apertures are D10 and up`);
    const parameters = m[3] === undefined ? [] : m[3].split('X').map((v) => {
      const value = Number(v);
      if (v.trim() === '' || !Number.isFinite(value)) fail(`aperture D${number} parameter "${v}" is not a number`);
      return value;
    });
    const mm = (v: number) => v * requireUnits();
    const expect = (count: number, shape: string) => {
      if (parameters.length > count) fail(`aperture D${number} has a hole; holes in apertures are not supported`);
      if (parameters.length < count) fail(`aperture D${number} (${shape}) needs ${count} parameters, got ${parameters.length}`);
    };
    let aperture: Aperture;
    switch (m[2]) {
      case 'C':
        expect(1, 'circle');
        aperture = { kind: 'circle', diameterMm: mm(parameters[0]) };
        break;
      case 'R':
        expect(2, 'rectangle');
        aperture = { kind: 'rectangle', widthMm: mm(parameters[0]), heightMm: mm(parameters[1]) };
        break;
      case 'O':
        expect(2, 'obround');
        aperture = { kind: 'obround', widthMm: mm(parameters[0]), heightMm: mm(parameters[1]) };
        break;
      case 'P':
        if (parameters.length === 2) parameters.push(0);
        expect(3, 'polygon');
        if (!Number.isInteger(parameters[1]) || parameters[1] < 3 || parameters[1] > 12) fail(`aperture D${number} polygon needs 3 to 12 vertices, got ${parameters[1]}`);
        aperture = { kind: 'polygon', outerDiameterMm: mm(parameters[0]), vertices: parameters[1], rotationDeg: parameters[2] };
        break;
      default: {
        const macro = macros.get(m[2]);
        if (!macro) fail(`aperture D${number} uses undefined macro or unknown template "${m[2]}"`);
        aperture = { kind: 'macro', name: m[2], polygons: instantiateMacro(macro, parameters, requireUnits(), (message) => fail(`macro "${m[2]}": ${message}`)) };
      }
    }
    apertures.set(number, aperture);
  };

  const wordCommand = (command: string) => {
    if (/^G0*4(\D|$)/.test(command)) return; // G04 comment
    if (/^M0*2$/.test(command)) {
      ended = true;
      return;
    }
    const m = WORD_COMMAND.exec(command);
    if (!m || command === '') fail(`unsupported command "${command}*"`);
    const [, g, x, y, i, j, d] = m;
    const hasCoordinates = x !== undefined || y !== undefined || i !== undefined || j !== undefined;
    if (g !== undefined) {
      switch (Number(g)) {
        case 1: interpolation = 'linear'; break;
        case 2: interpolation = 'clockwise'; break;
        case 3: interpolation = 'counterclockwise'; break;
        case 75: multiQuadrant = true; break;
        case 74: fail('G74 single-quadrant arc mode is not supported; export with G75 multi-quadrant arcs');
        case 36:
          if (region) fail('G36 inside a region');
          region = { contours: [], contour: undefined };
          break;
        case 37: {
          if (!region) fail('G37 without a matching G36');
          closeContour();
          for (const contour of region.contours) paint(contour);
          image.regionCount++;
          region = undefined;
          break;
        }
        case 70: unitMm = 25.4; break;
        case 71: unitMm = 1; break;
        case 54: case 55: case 90: break; // deprecated prefixes: select aperture, prepare flash, absolute coordinates
        case 91: fail('G91 incremental coordinates are not supported');
        default: fail(`unsupported G code G${g}`);
      }
      if ((Number(g) === 36 || Number(g) === 37) && (hasCoordinates || d !== undefined)) fail(`G${g} must stand alone`);
    }
    if (d === undefined) {
      if (hasCoordinates) fail(`coordinates without an operation (D01, D02 or D03) in "${command}*"`);
      return;
    }
    const operation = Number(d);
    if (operation >= 10) {
      if (hasCoordinates) fail(`aperture selection with coordinates in "${command}*"`);
      if (region) fail(`aperture selection D${operation} inside a region`);
      currentAperture = apertures.get(operation) ?? fail(`aperture D${operation} is not defined`);
      currentApertureNumber = operation;
      return;
    }
    const to: Vec2 = [coordinate(x, point?.[0], 'X'), coordinate(y, point?.[1], 'Y')];
    if (operation === 1) interpolate(to, offset(i), offset(j));
    else if (operation === 2) {
      closeContour();
      point = to;
      return;
    } else if (operation === 3) {
      if (region) fail('D03 flash inside a region');
      flash(to);
    } else fail(`unsupported operation D0${operation}`);
    point = to;
  };

  for (const command of tokenize(text, sourceName)) {
    line = command.line;
    if (ended) fail(`"${command.text}" after the end of file (M02)`);
    if (command.extended) extendedCommand(command.text);
    else wordCommand(command.text);
  }
  line = 0;
  if (region) failImport(sourceName, undefined, 'the file ends inside a region (G36 without G37)');
  if (!ended) failImport(sourceName, undefined, 'the file has no end-of-file command (M02); it may be truncated');
  return image;
}

/**
 * The board outline from an outline (profile, Edge.Cuts) Gerber: the centre
 * lines of its drawn lines and arcs, chained into one closed loop.
 */
export function gerberOutline(image: GerberImage, sourceName: string): Vec2[] {
  if (image.flashCount > 0 || image.regionCount > 0) {
    failImport(sourceName, undefined, `an outline file must hold only drawn lines and arcs; it has ${image.flashCount} flashes and ${image.regionCount} regions`);
  }
  if (image.drawnPaths.length === 0) failImport(sourceName, undefined, 'no drawn lines or arcs to make an outline from');
  const loops = chainIntoClosedLoops(image.drawnPaths, sourceName, 'board outline');
  if (loops.length !== 1) {
    failImport(sourceName, undefined, `board outline has ${loops.length} closed loops; a NobuRF board outline is one polygon (cut-outs inside the board are not supported)`);
  }
  return loops[0];
}
