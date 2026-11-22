/**
 * Plated holes from an Excellon drill file (the PTH file KiCad, Altium and
 * most CAM tools write next to the Gerbers), as NobuRF vias through the whole
 * stackup. Gerbers carry no holes, so without this an imported board has no
 * ground stitching and no plated connector shells, and its pours float.
 *
 * Read: the header's tools (T<n>C<diameter>) with their X2 plating attribute
 * where the exporter gives one, METRIC or INCH (M71 / M72), the file's
 * FileFunction (plated or not, and the copper layers it spans), drill hits
 * (X..Y.., either coordinate modal), G85 slots (X..Y..G85X..Y..) and routed
 * straight slots (G00 to the start, M15, G01 to the end, M16). Coordinates
 * must carry a decimal point, as KiCad's "decimal" format writes them. Any
 * other command is refused with its line number rather than skipped, since a
 * skipped repeat (R) or offset (G93) would put holes in the wrong place.
 *
 * A slot becomes a fence of two vias, one at each end; the plated wall between
 * the ends is left out. For a connector shell tab that keeps its ground
 * contact at both ends of the tab.
 */
import type { Via } from '../project/schema';
import { ImportError, roundToNanometre } from './geometry';

export interface DrillHole {
  x: number;
  y: number;
  /** Finished hole diameter, mm. */
  drill: number;
  plated: boolean;
  /** The far end of a slot, or undefined for a round hole. */
  to?: [number, number];
}

export interface DrillFile {
  holes: DrillHole[];
  /** Copper layers the file's holes span, 1 = top, from its FileFunction; null when the file does not say. */
  span: [number, number] | null;
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)$/;
/** Header and mode lines that place nothing and change nothing this reader keeps. */
const INERT = /^(M48|%|G90|G05|M30|M00|M95|FMAT,\d|VER,\d|DETECT,(ON|OFF)|ATC,(ON|OFF)|ICI,OFF|LZ|TZ|T0+)$/;

export function parseExcellon(text: string, sourceName: string): DrillFile {
  const tools = new Map<string, { drill: number; plated: boolean }>();
  let scale = 1; // mm per file unit
  let tool: string | null = null;
  let filePlated = true;
  let span: [number, number] | null = null;
  let pendingPlated: boolean | null = null; // the X2 attribute on the line before a tool definition
  let position: [number, number] | null = null;
  let routing = false; // route mode (after G00)
  let toolDown = false;
  let cuts = 0; // straight segments since the last plunge
  let inBody = false; // after the header's closing %
  const holes: DrillHole[] = [];
  const fail = (line: number, why: string): never => {
    throw new ImportError(`${sourceName} line ${line}: ${why}`);
  };
  const coordinate = (value: string, line: number): number => {
    if (!NUMBER.test(value)) fail(line, `"${value}" is not a number`);
    if (!value.includes('.')) fail(line, 'coordinates without a decimal point (an implied-decimal format) are not supported; export the drill file in decimal format');
    return Number(value) * scale;
  };
  /** X and Y from "X..Y..", "X.." or "Y..", the missing one kept from the last position. */
  const point = (s: string, line: number): [number, number] => {
    const m = /^(?:X([-+.\d]+))?(?:Y([-+.\d]+))?$/.exec(s);
    if (!m || (m[1] === undefined && m[2] === undefined)) fail(line, `expected a coordinate in "${s}"`);
    if ((m![1] === undefined || m![2] === undefined) && position === null) fail(line, `"${s}" gives one coordinate before any position is known`);
    const p: [number, number] = [m![1] === undefined ? position![0] : coordinate(m![1], line), m![2] === undefined ? position![1] : coordinate(m![2], line)];
    position = p;
    return p;
  };
  const current = (line: number) => {
    if (tool === null) fail(line, 'a hole before any tool is chosen');
    return tools.get(tool!)!;
  };

  text.split(/\r?\n/).forEach((raw, n) => {
    const line = n + 1;
    const fileFunction = /TF\.FileFunction,(Plated|NonPlated|MixedPlating),(\d+),(\d+)/i.exec(raw);
    if (fileFunction) {
      filePlated = fileFunction[1].toLowerCase() !== 'nonplated';
      span = [Number(fileFunction[2]), Number(fileFunction[3])];
    }
    const attribute = /TA\.AperFunction,(Plated|NonPlated)\b/i.exec(raw);
    if (attribute) pendingPlated = attribute[1].toLowerCase() === 'plated';
    if (/;\s*TYPE=NON_PLATED/i.test(raw)) filePlated = false;
    if (/;\s*TYPE=PLATED/i.test(raw)) filePlated = true;
    const s = raw.replace(/;.*$/, '').trim();
    if (!s) return;
    if (/^(METRIC|M71)\b/.test(s)) return void (scale = 1);
    if (/^(INCH|M72)\b/.test(s)) return void (scale = 25.4);
    if (INERT.test(s)) {
      if (s === 'G05') routing = false;
      if (s === '%' || s === 'M95') inBody = true;
      if (/^T0+$/.test(s)) tool = null;
      return;
    }
    const definition = /^T(\d+)(?:F\d+S\d+)?C(.*)$/.exec(s);
    if (definition) {
      const diameter = Number(definition[2]);
      if (!NUMBER.test(definition[2]) || !(diameter > 0)) fail(line, `tool T${definition[1]} has no valid diameter ("${definition[2]}")`);
      const id = String(Number(definition[1]));
      tools.set(id, { drill: diameter * scale, plated: pendingPlated ?? filePlated });
      pendingPlated = null;
      // In the program body a definition also selects the tool, as drill machines read it.
      if (inBody) tool = id;
      return;
    }
    const select = /^T(\d+)$/.exec(s);
    if (select) {
      const id = String(Number(select[1]));
      if (!tools.has(id)) fail(line, `tool T${select[1]} is used but never defined`);
      tool = id;
      return;
    }
    // Route mode: G00 moves with the tool up; M15 plunges; G01 cuts a straight slot; M16 / M17 lift.
    const move = /^G00(.*)$/.exec(s);
    if (move) {
      routing = true;
      toolDown = false;
      if (move[1]) point(move[1], line);
      return;
    }
    if (s === 'M15') {
      if (!routing || position === null) fail(line, 'M15 (plunge) outside route mode');
      toolDown = true;
      cuts = 0;
      return;
    }
    if (s === 'M16' || s === 'M17') return void (toolDown = false);
    const cut = /^G01(.*)$/.exec(s);
    if (cut || (routing && /^[XY]/.test(s))) {
      if (!routing || !toolDown) fail(line, `"${s}" cuts with the router up or outside route mode`);
      // Each slot becomes a via at each end; a route with a corner would put two vias on the corner.
      if (++cuts > 1) fail(line, 'a routed path with more than one straight segment is not supported; only straight slots are');
      const from = position!;
      const to = point(cut ? cut[1] : s, line);
      const t = current(line);
      holes.push({ x: from[0], y: from[1], drill: t.drill, plated: t.plated, to });
      return;
    }
    if (/^[XY]/.test(s)) {
      const t = current(line);
      const slot = s.split('G85');
      if (slot.length === 2) {
        const from = point(slot[0], line);
        holes.push({ x: from[0], y: from[1], drill: t.drill, plated: t.plated, to: point(slot[1], line) });
      } else {
        const [x, y] = point(s, line);
        holes.push({ x, y, drill: t.drill, plated: t.plated });
      }
      return;
    }
    fail(line, `"${s}" is not a command this reader supports (drill hits, G85 slots and straight routed slots are)`);
  });
  if (holes.length === 0) throw new ImportError(`${sourceName}: no holes`);
  return { holes, span };
}

const length = (mm: number) => `${roundToNanometre(mm)} mm`;

/**
 * Vias for the plated holes, numbered drill-<firstNumber>, and on, through
 * `between` (the bottom and top copper layers): each joins the copper it
 * touches on its way through, so pads join and pours with a drawn clearance
 * stay apart. Non-plated holes are counted, not made. A file that spans only
 * some of the `copperLayers` (blind or buried holes) is refused.
 */
export function drillVias(file: DrillFile, between: [string, string], copperLayers: number, sourceName: string, firstNumber = 1): { vias: Via[]; skipped: number } {
  if (file.span && (Math.min(...file.span) !== 1 || Math.max(...file.span) !== copperLayers)) {
    throw new ImportError(`${sourceName} spans copper layers ${file.span[0]} to ${file.span[1]} of ${copperLayers}: blind and buried holes are not supported, only through holes`);
  }
  const plated = file.holes.filter((h) => h.plated);
  if (plated.length === 0) throw new ImportError(`${sourceName} has no plated holes (it is the non-plated, NPTH, file?); only plated holes become vias`);
  const vias = plated.map((h, n): Via => {
    const id = `drill-${firstNumber + n}`;
    const drill = length(h.drill);
    const [x0, y0] = [roundToNanometre(h.x), roundToNanometre(h.y)];
    if (!h.to) return { id, x: length(x0), y: length(y0), drill, between };
    const [x1, y1] = [roundToNanometre(h.to[0]), roundToNanometre(h.to[1])];
    const span = Math.hypot(x1 - x0, y1 - y0);
    // Pitch rounded down, so the fence's second via still lands on the slot's far end; a slot so short that
    // the pitch would not clear the drill is one hole at its middle.
    const pitch = Math.floor(span * 1e6) / 1e6;
    if (pitch <= h.drill) return { id, x: length((x0 + x1) / 2), y: length((y0 + y1) / 2), drill, between };
    return { id, x: length(x0), y: length(y0), drill, between, to: [length(x1), length(y1)], pitch: `${pitch} mm` };
  });
  return { vias, skipped: file.holes.length - plated.length };
}
