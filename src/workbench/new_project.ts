/**
 * Starting points for a new project, from a few numbers an RF engineer
 * already has: a frequency, a laminate and its thickness. The patch reuses
 * the design agent's textbook template (design/patch_template.ts); the line
 * is a 50 ohm microstrip between two ports, the usual first check of a
 * laminate and a mesh; the pair is two such lines side by side, paired at
 * both ends, for differential results.
 */
import { timestepSec } from '../engine/config';
import { TIMING_ENERGY_DECAY_DB } from '../engine/differential';
import { sourceEndStep, sourceParams } from '../engine/source';
import { microstripWidthMm, patchDesign, patchEstimateMm } from '../design/patch_template';
import { applyProjectEdit } from '../project/edits';
import { rasterise } from '../project/rasterise';
import { resolveProject } from '../project/resolve';
import { BUILTIN_MATERIALS, parseProject, type Project } from '../project/schema';
import { isConductor, libraryMaterial, projectMaterial } from './material_library';

/** mm GHz: the speed of light in mm per ns. */
const C_MM_GHZ = 299.792458;

export type Template = 'patch' | 'line' | 'pair' | 'blank';

export interface NewProjectSpec {
  template: Template;
  name: string;
  frequencyGHz: number;
  /** A built-in or library dielectric. */
  substrate: string;
  thicknessMm: number;
  /** Board size; absent: sized from the design. */
  boardWMm?: number;
  boardLMm?: number;
}

/** εr of a built-in or library dielectric. */
export function substrateEpsR(name: string): number {
  const builtin = Object.hasOwn(BUILTIN_MATERIALS, name) ? BUILTIN_MATERIALS[name] : undefined;
  if (builtin?.kind === 'dielectric') return builtin.eps_r;
  const entry = libraryMaterial(name);
  if (entry && !isConductor(entry)) return entry.eps_r;
  throw new Error(`"${name}" is not a dielectric in the built-in materials or the library`);
}

/** Board size the template picks when none is given: room around the patch, or a line a few wavelengths long. */
export function defaultBoardMm(spec: Omit<NewProjectSpec, 'boardWMm' | 'boardLMm' | 'name'>): { w: number; l: number } {
  const epsR = substrateEpsR(spec.substrate);
  if (spec.template === 'patch') {
    const est = patchEstimateMm(spec.frequencyGHz, epsR, spec.thicknessMm);
    return { w: Math.ceil(1.5 * est.w), l: Math.ceil(1.5 * est.l + 6) };
  }
  if (spec.template === 'blank') {
    // Half a free-space wavelength square, at least 20 mm: room for a patch, a filter or a short line.
    const side = Math.max(20, Math.ceil(C_MM_GHZ / spec.frequencyGHz / 2));
    return { w: side, l: side };
  }
  const width = microstripWidthMm(50, epsR, spec.thicknessMm);
  // The pair adds a second strip and a gap of twice the width.
  const span = spec.template === 'pair' ? (1 + PAIR_GAP_WIDTHS + 1) * width : width;
  // Half a guided wavelength at the design frequency, at least 20 mm. Across: the strip plus six substrate
  // heights of ground on each side, where a microstrip's fringing field has died away.
  const guided = C_MM_GHZ / spec.frequencyGHz / Math.sqrt((epsR + 1) / 2);
  return { w: Math.max(10, Math.ceil(span + 12 * spec.thicknessMm)), l: Math.max(20, Math.ceil(guided / 2)) };
}

export function newProject(spec: NewProjectSpec): Project {
  const board = { ...defaultBoardMm(spec), ...(spec.boardWMm ? { w: spec.boardWMm } : {}), ...(spec.boardLMm ? { l: spec.boardLMm } : {}) };
  const project = spec.template === 'patch' ? patchProject(spec, board)
    : spec.template === 'line' ? lineProject(spec, board)
    : spec.template === 'pair' ? pairProject(spec, board)
    : blankProject(spec, board);
  project.name = spec.name;
  const entry = libraryMaterial(spec.substrate);
  if (entry) project.materials[spec.substrate] = projectMaterial(entry);
  if (spec.template === 'pair') useWidebandSubstrate(project, spec);
  // A blank board has no port yet, so it cannot pass validation: it opens with that as the one problem to fix.
  if (spec.template === 'blank') return project;
  const parsed = parseProject(withoutUnusedVariables(project));
  try {
    resolveProject(parsed);
  } catch (error) {
    throw new Error(`The template does not fit these numbers: ${(error as Error).message}.`);
  }
  parsed.analysis.stop.max_steps = stepLimit(parsed, spec.frequencyGHz);
  return parsed;
}

/**
 * A step limit with room for the pulse and 200 periods of ring-down at the
 * design frequency; the energy stop normally ends the run well before it.
 * The time step follows the finest cell, so a fixed limit would cut short a
 * low-frequency design on a thin laminate.
 */
function stepLimit(project: Project, frequencyGHz: number): number {
  const a = project.analysis;
  const dtSec = timestepSec(rasterise(project).model.grid);
  const pulse = sourceEndStep(sourceParams({ fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: 50 }), dtSec);
  const ringDown = 200 / (frequencyGHz * 1e9) / dtSec;
  return Math.max(20000, Math.ceil((pulse + ringDown) / 1000) * 1000);
}

function patchProject(spec: NewProjectSpec, board: { w: number; l: number }): Project {
  const epsR = substrateEpsR(spec.substrate);
  const design = patchDesign({
    goal: { target_ghz: spec.frequencyGHz, s11_max_db: -10, f_tolerance_pct: 1 },
    boardWMm: board.w,
    boardLMm: board.l,
    substrate: { material: spec.substrate, epsR, thicknessMm: spec.thicknessMm },
  });
  const est = patchEstimateMm(spec.frequencyGHz, epsR, spec.thicknessMm);
  const feedW = microstripWidthMm(50, epsR, spec.thicknessMm);
  // The design agent keeps the feed under a third of the patch so an inset fits beside it. The plain
  // edge-fed patch has no inset, and textbook designs on thick, low-εr laminates need more: Balanis
  // Example 14.1 (10 GHz, εr 2.2, 1.588 mm) has a 4.9 mm feed on an 11.9 mm patch.
  const patchW = Math.min(est.w, board.w - 2);
  if (feedW > patchW / 2) {
    const boardLimited = board.w - 2 < est.w;
    throw new Error(`A 50 Ω feed on ${spec.thicknessMm} mm ${spec.substrate} is ${feedW.toFixed(2)} mm wide, more than half ` +
      `the ${patchW.toFixed(1)} mm patch. Use a thinner substrate${boardLimited ? ' or a wider board' : ''}.`);
  }
  design.project.variables.feed_w.max = 'patch_w / 2';
  const entry = libraryMaterial(spec.substrate);
  if (entry) design.project.materials[spec.substrate] = projectMaterial(entry);
  // The plain patch: the design agent's optional inset, slot, stub and chamfer shapes removed.
  let project = design.project;
  for (const feature of Object.values(design.features)) {
    for (const id of feature.shapes) project = applyProjectEdit(project, { op: 'remove_polygon', id }).project;
  }
  project = structuredClone(project);
  // The agent's bounds keep its search to sizes a hand-etched board can hold; a new project only needs them positive.
  project.variables.patch_w.min = '1 mm';
  project.variables.patch_l.min = '1 mm';
  project.variables.feed_w.min = '0.1 mm';
  // An eighth of a wavelength of air past the board edge, so the absorbing boundary is clear of the radiating ground edge.
  const cell = Number.parseFloat(project.mesh.cell);
  project.mesh.air_margin_cells.xy = Math.max(4, Math.ceil(C_MM_GHZ / spec.frequencyGHz / 8 / cell));
  return project;
}

const DIELECTRIC_CELLS = 4;
const mm = (x: number) => `${Number(x.toFixed(3))} mm`;
const cellMm = (x: number) => Math.max(0.05, Math.floor(x / 0.05) * 0.05);

function lineProject(spec: NewProjectSpec, board: { w: number; l: number }): Project {
  const f = spec.frequencyGHz;
  const lineW = microstripWidthMm(50, substrateEpsR(spec.substrate), spec.thicknessMm);
  if (board.l < 6) throw new Error('The line needs a board at least 6 mm long: the ports sit 1 mm in from each end.');
  if (board.w < 2 * lineW) throw new Error(`The board must be at least twice as wide as the ${lineW.toFixed(2)} mm line, ${Math.ceil(2 * lineW)} mm.`);
  const fMax = 2 * f;
  const cell = cellMm(C_MM_GHZ / fMax / 40);
  const rect = (x0: string, y0: string, x1: string, y1: string): Array<[string, string]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const pml = { type: 'pml' as const, cells: 8 };
  return {
    noburf_project: 1,
    name: spec.name,
    variables: {
      board_w: { value: mm(board.w), locked: true },
      board_l: { value: mm(board.l), locked: true },
      line_w: { value: mm(lineW), min: '0.1 mm', max: 'board_w / 2' },
      port_y: { value: 'board_l / 2 - 1 mm', locked: true },
    },
    materials: {},
    stackup: [
      { type: 'copper', name: 'gnd', material: 'copper' },
      { type: 'dielectric', name: 'core', material: spec.substrate, thickness: mm(spec.thicknessMm) },
      { type: 'copper', name: 'top', material: 'copper' },
    ],
    board: { outline: rect('-board_w / 2', '-board_l / 2', 'board_w / 2', 'board_l / 2') },
    geometry: {
      gnd: [{ id: 'ground', op: 'add', polygon: rect('-board_w / 2', '-board_l / 2', 'board_w / 2', 'board_l / 2') }],
      top: [{ id: 'line', op: 'add', polygon: rect('-line_w / 2', '-port_y', 'line_w / 2', 'port_y') }],
    },
    ports: [
      { id: 'p1', x: '0 mm', y: '-port_y', between: ['gnd', 'top'], reference_impedance_ohm: 50 },
      { id: 'p2', x: '0 mm', y: 'port_y', between: ['gnd', 'top'], reference_impedance_ohm: 50 },
    ],
    boundaries: { x_min: pml, x_max: pml, y_min: pml, y_max: pml, z_min: pml, z_max: pml },
    mesh: {
      cell: mm(cell),
      air_margin_cells: { xy: 2, below: 2, above: Math.ceil(C_MM_GHZ / f / 8 / cell) },
      graded: { edge_cell: mm(Math.min(cellMm(cell / 4), spec.thicknessMm / DIELECTRIC_CELLS)), dielectric_cells: DIELECTRIC_CELLS, max_growth: 1.3 },
    },
    analysis: {
      // Down to one frequency step above DC, so the TDR's DC level needs no long extrapolation.
      f_min_ghz: Number((fMax / 200).toFixed(4)),
      f_max_ghz: fMax,
      n_freq: 201,
      loss_reference_ghz: f,
      stop: { energy_decay_db: 40, max_steps: 20000 }, // set from the time step in newProject
    },
    // Three frequencies, so the line view has Z0 and eps_eff from the fields at each (see line_analysis.ts).
    outputs: { zin_at_ghz: [f / 2, f, (3 * f) / 2].map((x) => Number(x.toFixed(3))) },
  };
}

/** Gap between the pair's strips, in strip widths: loosely coupled, so each line stays near 50 ohm and the pair a little under 100 ohm. */
const PAIR_GAP_WIDTHS = 2;

/**
 * Two of the template's 50 ohm lines side by side, a gap of two widths apart,
 * with ports p1, n1 at one end and p2, n2 at the other, already paired as D1
 * and D2. The gap is a variable, so the pair can be tightened toward a
 * differential impedance target.
 */
function pairProject(spec: NewProjectSpec, board: { w: number; l: number }): Project {
  const project = lineProject(spec, board);
  const lineW = Number.parseFloat(project.variables.line_w.value);
  if (board.w < (2 + PAIR_GAP_WIDTHS) * lineW + 2) throw new Error(`The board must be at least ${Math.ceil((2 + PAIR_GAP_WIDTHS) * lineW + 2)} mm wide for the pair.`);
  project.variables.gap = { value: mm(PAIR_GAP_WIDTHS * lineW), min: '0.05 mm', max: 'board_w / 2' };
  const rect = (x0: string, x1: string): Array<[string, string]> => [[x0, '-port_y'], [x1, '-port_y'], [x1, 'port_y'], [x0, 'port_y']];
  project.geometry.top = [
    { id: 'line_p', op: 'add', polygon: rect('-gap / 2 - line_w', '-gap / 2') },
    { id: 'line_n', op: 'add', polygon: rect('gap / 2', 'gap / 2 + line_w') },
  ];
  const port = (id: string, x: string, y: string) => ({ id, x, y, between: ['gnd', 'top'] as [string, string], reference_impedance_ohm: 50 });
  project.ports = [
    port('p1', '-(gap + line_w) / 2', '-port_y'), port('n1', '(gap + line_w) / 2', '-port_y'),
    port('p2', '-(gap + line_w) / 2', 'port_y'), port('n2', '(gap + line_w) / 2', 'port_y'),
  ];
  project.outputs.differential_pairs = [{ id: 'D1', positive: 'p1', negative: 'n1' }, { id: 'D2', positive: 'p2', negative: 'n2' }];
  project.analysis.stop.energy_decay_db = TIMING_ENERGY_DECAY_DB;
  return project;
}

/**
 * A pair's TDR and step responses reach down to DC. A plain loss tangent is a
 * constant conductivity, exact at the design frequency but still leaking there
 * (on 0.5 mm FR-4 about 800 Ω to ground along an 18 mm line), which pulls the
 * TDR level down. The substrate becomes a Djordjevic-Sarkar material with the
 * same eps_r and tan delta at the design frequency, whose loss vanishes at DC.
 */
function useWidebandSubstrate(project: Project, spec: NewProjectSpec): void {
  const builtin = Object.hasOwn(BUILTIN_MATERIALS, spec.substrate) ? BUILTIN_MATERIALS[spec.substrate] : undefined;
  const base = builtin?.kind === 'dielectric' ? builtin : project.materials[spec.substrate];
  if (!base || !('eps_r' in base) || base.tan_delta === 0 || base.dispersion) return;
  const name = `${spec.substrate} wideband at ${spec.frequencyGHz} GHz`;
  const { kind: _kind, ...material } = { kind: 'dielectric', ...base };
  project.materials[name] = { ...material, dispersion: { model: 'djordjevic_sarkar', at_ghz: spec.frequencyGHz } };
  delete project.materials[spec.substrate];
  for (const layer of project.stackup) if (layer.type === 'dielectric' && layer.material === spec.substrate) layer.material = name;
}

/**
 * The empty board, like a new design in a full-wave tool: ground, the
 * laminate and an empty top copper layer, ready for drawn or imported copper
 * and ports. Mesh and band as for the line; more air above, as whatever is
 * drawn may radiate.
 */
function blankProject(spec: NewProjectSpec, board: { w: number; l: number }): Project {
  if (board.w < 10 || board.l < 10) throw new Error('A blank board must be at least 10 mm on each side.');
  const project = lineProject(spec, board);
  const f = spec.frequencyGHz;
  const cell = Number.parseFloat(project.mesh.cell);
  delete project.variables.line_w;
  delete project.variables.port_y;
  project.geometry.top = [];
  project.ports = [];
  project.mesh.air_margin_cells = { xy: Math.ceil(C_MM_GHZ / f / 8 / cell), below: 2, above: Math.ceil(C_MM_GHZ / f / 4 / cell) };
  project.analysis.f_min_ghz = Number((f / 4).toFixed(3));
  // With no port to measure, the step limit cannot come from the mesh yet; this covers a 50 mm board at 1 GHz.
  project.analysis.stop.max_steps = 40000;
  project.outputs = { zin_at_ghz: [f] };
  return project;
}

/** Drops variables no expression uses (the template's switched-off features), repeating until none is left. */
export function withoutUnusedVariables(project: Project): Project {
  const next = structuredClone(project);
  for (let changed = true; changed;) {
    changed = false;
    for (const name of Object.keys(next.variables)) {
      const others = { ...next.variables };
      delete others[name];
      const rest = JSON.stringify({ ...next, variables: others });
      if (!new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(rest)) {
        delete next.variables[name];
        changed = true;
      }
    }
  }
  return next;
}
