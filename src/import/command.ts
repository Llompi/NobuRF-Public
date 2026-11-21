import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolveProject, type Vec2 } from '../project/resolve';
import type { Project } from '../project/schema';
import { dxfLayerOutline, dxfLayerShapes, parseDxf, type DxfDrawing } from './dxf';
import { roundToNanometre, translatePolygon, type ImportedShape } from './geometry';
import { gerberOutline, parseGerber } from './gerber';
import { parseOriginSpec, resolveOrigin, type OriginSpec } from './origin';
import { parseStep, stepCopper, stepOutline, UP_AXES, type StepModel, type UpAxis } from './step';
import { buildImportedProject, serialiseProject, type ImportedCopperLayer } from './project';

/**
 * `noburf import`: copper from Gerber, DXF or STEP files into a project
 * built from a template.
 *
 *   noburf import --stackup <template.json> --layer <copper>=<source> ... [--outline <source>]
 *                 [--units <unit>] [--step-up <axis>] [--origin "<x>, <y>" | outline-min | outline-center]
 *                 --out <project.json>
 *
 * A source is a Gerber file, a DXF file and layer ("board.dxf:TOP"), or a
 * STEP file and a body selector ("board.step:*_PCB",
 * "board.step:@0.5mm..0.535mm"; see selectStepBodies). --units gives the
 * unit of DXF files without $INSUNITS, --step-up the STEP axis that points
 * out of the board's top, and --origin moves the files' coordinates (see
 * origin.ts).
 */

export const IMPORT_USAGE =
  'usage: noburf import --stackup <template.json> --layer <copper>=<file>[:<DXF layer or STEP bodies>] ... ' +
  '[--outline <file>[:<DXF layer or STEP body>]] [--units mm|in|mil|um|cm|m] [--step-up z|y|x|-z|-y|-x] ' +
  '[--origin "<x>, <y>" | outline-min | outline-center] --out <project.json>';

interface ImportArguments {
  templatePath: string;
  layers: Array<{ layerName: string; source: string }>;
  outlineSource: string | undefined;
  dxfUnit: string | undefined;
  origin: OriginSpec | undefined;
  stepUp: UpAxis;
  outPath: string;
}

function parseImportArguments(argv: string[]): ImportArguments {
  let templatePath: string | undefined;
  let outPath: string | undefined;
  let outlineSource: string | undefined;
  let dxfUnit: string | undefined;
  let origin: OriginSpec | undefined;
  let stepUp: UpAxis = 'z';
  const layers: ImportArguments['layers'] = [];
  for (let n = 0; n < argv.length; n++) {
    const [flag, value] = [argv[n], argv[n + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value\n${IMPORT_USAGE}`);
    n++;
    if (flag === '--stackup') templatePath = value;
    else if (flag === '--out') outPath = value;
    else if (flag === '--outline') outlineSource = value;
    else if (flag === '--units') dxfUnit = value;
    else if (flag === '--origin') origin = parseOriginSpec(value);
    else if (flag === '--step-up') {
      stepUp = UP_AXES.find((a) => a === value) ?? (() => {
        throw new Error(`--step-up ${value}: expected one of ${UP_AXES.join(', ')}`);
      })();
    }
    else if (flag === '--layer') {
      const m = /^([^=]+)=(.+)$/.exec(value);
      if (!m) throw new Error(`--layer ${value}: expected <copper layer>=<file>\n${IMPORT_USAGE}`);
      layers.push({ layerName: m[1], source: m[2] });
    } else throw new Error(`unknown option ${flag}\n${IMPORT_USAGE}`);
  }
  if (!templatePath || !outPath || layers.length === 0) throw new Error(IMPORT_USAGE);
  return { templatePath, layers, outlineSource, dxfUnit, origin, stepUp, outPath };
}

type Source =
  | { kind: 'gerber'; path: string }
  | { kind: 'dxf'; path: string; layer: string }
  | { kind: 'step'; path: string; selector: string };

/** "board.dxf:TOP" is a DXF layer, "board.step:<selector>" STEP bodies; any other file is Gerber. */
function splitSource(source: string): Source {
  if (/\.(stpz|step\.gz|stp\.gz)(:|$)/i.test(source)) throw new Error(`${source}: compressed STEP is not read; unzip it to a .step file first`);
  // The shortest path ending in .dxf/.step/.stp that is followed by ":" or the end, so a selector may contain dots.
  const m = /^(.*?\.(dxf|step|stp))(?::(.*))?$/i.exec(source);
  if (!m) return { kind: 'gerber', path: source };
  const isDxf = m[2].toLowerCase() === 'dxf';
  if (!m[3]) {
    throw new Error(isDxf
      ? `${source}: name the DXF layer to import, e.g. ${m[1]}:TOP`
      : `${source}: name the bodies to import, e.g. ${m[1]}:*_PCB or ${m[1]}:@0.5mm..0.535mm (any name that matches nothing lists them)`);
  }
  return isDxf ? { kind: 'dxf', path: m[1], layer: m[3] } : { kind: 'step', path: m[1], selector: m[3] };
}

/**
 * STEP copper carries real heights; the template's stackup says how far
 * apart its copper layers are. Each pair of neighbouring STEP layers whose
 * gap (top of the lower bodies to bottom of the upper ones) differs from
 * the dielectric between them in the stackup gets a warning, since the
 * solve would use the stackup.
 */
function stackupMismatches(project: Project, stepHeights: Map<string, { zMin: number; zMax: number }>): string[] {
  const stackup = resolveProject(project).stackup;
  const warnings: string[] = [];
  let below: { name: string; zMax: number } | undefined;
  let dielectricMm = 0;
  for (const layer of stackup) {
    if (layer.type === 'dielectric') {
      dielectricMm += layer.thicknessMm;
      continue;
    }
    const heights = stepHeights.get(layer.name);
    if (!heights) continue;
    if (below) {
      const gapMm = heights.zMin - below.zMax;
      if (Math.abs(gapMm - dielectricMm) > 1e-3) {
        warnings.push(`warning: in the STEP file "${layer.name}" is ${formatMm(gapMm)} mm above "${below.name}", but the stackup puts ${formatMm(dielectricMm)} mm of dielectric between them; the solve uses the stackup`);
      }
    }
    below = { name: layer.name, zMax: heights.zMax };
    dielectricMm = 0;
  }
  return warnings;
}

const formatMm = (mm: number) => `${roundToNanometre(mm)}`;

export function runImportCommand(argv: string[]): void {
  const args = parseImportArguments(argv);
  const dxfDrawings = new Map<string, DxfDrawing>();
  const stepModels = new Map<string, StepModel>();
  const dxf = (path: string) => {
    if (!dxfDrawings.has(path)) dxfDrawings.set(path, parseDxf(readFileSync(path, 'utf8'), basename(path), args.dxfUnit));
    return dxfDrawings.get(path)!;
  };
  const step = (path: string) => {
    if (!stepModels.has(path)) stepModels.set(path, parseStep(readFileSync(path, 'utf8'), basename(path), args.stepUp));
    return stepModels.get(path)!;
  };
  const notes: string[] = [];

  const stepHeights = new Map<string, { zMin: number; zMax: number }>(); // copper layer -> STEP bodies' height range
  const fileLayers: ImportedCopperLayer[] = args.layers.map(({ layerName, source }) => {
    const from = splitSource(source);
    let shapes: ImportedShape[];
    if (from.kind === 'gerber') shapes = parseGerber(readFileSync(from.path, 'utf8'), basename(from.path)).shapes;
    else if (from.kind === 'dxf') shapes = dxfLayerShapes(dxf(from.path), from.layer);
    else {
      const copper = stepCopper(step(from.path), from.selector);
      shapes = copper.shapes;
      const low = Math.min(...copper.bodies.map((b) => b.zMin));
      const high = Math.max(...copper.bodies.map((b) => b.zMax));
      stepHeights.set(layerName, { zMin: low, zMax: high });
      notes.push(`${layerName} from ${copper.bodies.length} STEP ${copper.bodies.length === 1 ? 'body' : 'bodies'} at z ${formatMm(low)} to ${formatMm(high)} mm`);
    }
    return { layerName, sourceName: source, shapes };
  });

  let fileOutline: Vec2[] | undefined;
  if (args.outlineSource !== undefined) {
    const from = splitSource(args.outlineSource);
    if (from.kind === 'gerber') fileOutline = gerberOutline(parseGerber(readFileSync(from.path, 'utf8'), basename(from.path)), basename(from.path));
    else if (from.kind === 'dxf') fileOutline = dxfLayerOutline(dxf(from.path), from.layer);
    else {
      const board = stepOutline(step(from.path), from.selector);
      fileOutline = board.outline;
      const thickness = `board "${board.body.name}" z ${formatMm(board.body.zMin)} to ${formatMm(board.body.zMax)} mm`;
      const holes = board.holesLeftOut === 1 ? '1 hole' : `${board.holesLeftOut} holes`;
      notes.push(board.holesLeftOut > 0 ? `${thickness}, ${holes} in it left out (the outline has no cut-outs)` : thickness);
    }
  }
  const [originX, originY] = args.origin ? resolveOrigin(args.origin, fileOutline) : [0, 0];
  const shift = (polygon: Vec2[]) => translatePolygon(polygon, [-originX, -originY]);
  const layers = fileLayers.map((layer) => ({ ...layer, shapes: layer.shapes.map((s) => ({ ...s, polygon: shift(s.polygon) })) }));
  const outline = fileOutline && shift(fileOutline);

  let template: unknown;
  const templateText = readFileSync(args.templatePath, 'utf8');
  try {
    template = JSON.parse(templateText);
  } catch (e) {
    throw new Error(`${args.templatePath} is not valid JSON: ${(e as Error).message}`);
  }
  const project = buildImportedProject(template, layers, outline);
  writeFileSync(args.outPath, serialiseProject(project));
  const counts = layers.map((l) => `${l.layerName} ${project.geometry[l.layerName].length} shapes`).join(', ');
  notes.push(...stackupMismatches(project, stepHeights));
  if (args.origin) notes.push(`file point (${formatMm(originX)}, ${formatMm(originY)}) mm is now (0, 0)`);
  console.log(`${args.outPath}: ${counts}${outline ? `, outline ${project.board.outline.length} points` : ''}`);
  for (const note of notes) console.log(`  ${note}`);
}
