import type { Project } from '../project/schema';
import type { DesignFile, FeatureMap } from './design_file';
import type { DesignGoal } from './goal';

/** mm GHz: the speed of light in mm per ns. */
const C_MM_GHZ = 299.792458;

export interface PatchRequest {
  goal: DesignGoal;
  /** Board size; the patch, its feed and every feature must fit on it. */
  boardWMm: number;
  boardLMm: number;
  /** Substrate: a built-in dielectric name, default FR-4 (eps_r 4.4, tan delta 0.02). */
  substrate?: { material: string; epsR: number; thicknessMm: number };
}

const DEFAULT_SUBSTRATE = { material: 'FR-4', epsR: 4.4, thicknessMm: 1.6 };

/** Rectangular patch width and length for a resonance at f (Balanis, Antenna Theory, 4th ed., 14.2). */
export function patchEstimateMm(fGhz: number, epsR: number, hMm: number): { w: number; l: number } {
  const w = (C_MM_GHZ / (2 * fGhz)) * Math.sqrt(2 / (epsR + 1));
  const epsEff = (epsR + 1) / 2 + ((epsR - 1) / 2) / Math.sqrt(1 + (12 * hMm) / w);
  const dl = (0.412 * hMm * (epsEff + 0.3) * (w / hMm + 0.264)) / ((epsEff - 0.258) * (w / hMm + 0.8));
  return { w, l: C_MM_GHZ / (2 * fGhz * Math.sqrt(epsEff)) - 2 * dl };
}

/** Microstrip width for an impedance (Hammerstad's synthesis, as in Pozar, Microwave Engineering, 3.198). */
export function microstripWidthMm(z0: number, epsR: number, hMm: number): number {
  const a = (z0 / 60) * Math.sqrt((epsR + 1) / 2) + ((epsR - 1) / (epsR + 1)) * (0.23 + 0.11 / epsR);
  const narrow = (8 * Math.exp(a)) / (Math.exp(2 * a) - 2);
  if (narrow < 2) return narrow * hMm;
  const b = (377 * Math.PI) / (2 * z0 * Math.sqrt(epsR));
  return hMm * (2 / Math.PI) * (b - 1 - Math.log(2 * b - 1) + ((epsR - 1) / (2 * epsR)) * (Math.log(b - 1) + 0.39 - 0.61 / epsR));
}

const mm = (x: number) => `${Number(x.toFixed(3))} mm`;
/** A cell size rounded down to a 0.05 mm step, so mesh settings read cleanly. */
const cellMm = (x: number) => Math.max(0.05, Math.floor(x / 0.05) * 0.05);
const rect = (x0: string, y0: string, x1: string, y1: string): Array<[string, string]> => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/**
 * The features the strategist may switch on, each with the shapes it adds to
 * the template and the variables that size it. The minimum sizes live on the
 * variables (min / max), so the solver refuses anything thinner.
 */
export const PATCH_FEATURES: FeatureMap = {
  inset: {
    what: 'inset feed: two notches beside the feed line, so the line meets the patch inside its edge (matching)',
    shapes: ['inset_left', 'inset_right', 'inset_feed'],
    variables: ['inset_d', 'inset_gap'],
  },
  slot: {
    what: 'transverse slot across the patch center: lengthens the current path, lowering the resonance (miniaturization)',
    shapes: ['slot'],
    variables: ['slot_l', 'slot_w', 'slot_y'],
  },
  stub: {
    what: 'open shunt stub on the feed line, on the +x side (matching without cutting the patch)',
    shapes: ['stub'],
    variables: ['stub_l', 'stub_w', 'stub_d'],
  },
  chamfer: {
    what: 'two opposite patch corners cut at 45 degrees: splits the patch into two orthogonal modes for circular polarization',
    shapes: ['chamfer_a', 'chamfer_b'],
    variables: ['chamfer'],
  },
};

/**
 * A design file for an edge-fed rectangular patch on a two-layer board: the
 * starting point of a design request ("5.8 GHz on 20 x 20 mm"). Sizes start
 * from the textbook estimate, clamped to the board. The template holds every
 * feature's shapes; the design session removes the ones that are switched off.
 */
export function patchDesign(request: PatchRequest): DesignFile {
  const { goal, boardWMm, boardLMm } = request;
  const sub = request.substrate ?? DEFAULT_SUBSTRATE;
  const f = goal.target_ghz;
  const lambda0 = C_MM_GHZ / f;
  const est = patchEstimateMm(f, sub.epsR, sub.thicknessMm);
  const feedW = microstripWidthMm(50, sub.epsR, sub.thicknessMm);
  // Room for the feed: the port sits 1 mm in from the board edge, the patch at least 2 mm beyond it.
  const patchWMax = boardWMm - 2;
  const patchLMax = boardLMm - 6;
  if (patchWMax < 4 || patchLMax < 4) throw new Error(`a ${boardWMm} x ${boardLMm} mm board leaves no room for a patch and its feed`);
  const patchW = Math.min(est.w, patchWMax);
  const patchL = Math.min(est.l, patchLMax);
  const farField = goal.max_axial_ratio_db !== undefined;

  const project: Project = {
    noburf_project: 1,
    name: `patch-${f}ghz-${boardWMm}x${boardLMm}mm`,
    variables: {
      board_w: { value: mm(boardWMm), locked: true },
      board_l: { value: mm(boardLMm), locked: true },
      patch_w: { value: mm(patchW), min: '4 mm', max: 'board_w - 2 mm' },
      patch_l: { value: mm(patchL), min: '4 mm', max: 'board_l - 6 mm' },
      feed_w: { value: mm(feedW), min: '0.5 mm', max: 'patch_w / 3' },
      port_y: { value: '-board_l / 2 + 1 mm', locked: true },
      inset_d: { value: mm(patchL * 0.3), min: '0.5 mm', max: 'patch_l / 2' },
      inset_gap: { value: '1 mm', min: '0.5 mm', max: '3 mm' },
      slot_l: { value: mm(patchW * 0.5), min: '2 mm', max: 'patch_w - 2 mm' },
      slot_w: { value: '1 mm', min: '0.5 mm', max: 'patch_l / 4' },
      slot_y: { value: '0 mm', min: '-patch_l / 4', max: 'patch_l / 4' },
      stub_l: { value: '3 mm', min: '1 mm', max: 'board_w / 2 - feed_w / 2 - 1 mm' },
      stub_w: { value: '1 mm', min: '0.5 mm', max: '3 mm' },
      stub_d: { value: mm(Math.max(1, Math.min(2, (boardLMm - patchL) / 2 - 2))), min: 'stub_w / 2 + 0.5 mm', max: 'board_l / 2 - patch_l / 2 - 1.5 mm - stub_w / 2' },
      chamfer: { value: mm(patchW * 0.1), min: '0.5 mm', max: 'patch_w / 4' },
    },
    materials: {},
    stackup: [
      { type: 'copper', name: 'gnd', material: 'copper' },
      { type: 'dielectric', name: 'core', material: sub.material, thickness: mm(sub.thicknessMm) },
      { type: 'copper', name: 'top', material: 'copper' },
    ],
    board: { outline: rect('-board_w / 2', '-board_l / 2', 'board_w / 2', 'board_l / 2') },
    geometry: {
      gnd: [{ id: 'ground', op: 'add', polygon: rect('-board_w / 2', '-board_l / 2', 'board_w / 2', 'board_l / 2') }],
      // Paint order: patch, then every cut, then the feed and stub (so the inset notches never cut the line).
      top: [
        { id: 'patch', op: 'add', polygon: rect('-patch_w / 2', '-patch_l / 2', 'patch_w / 2', 'patch_l / 2') },
        { id: 'slot', op: 'cut', polygon: rect('-slot_l / 2', 'slot_y - slot_w / 2', 'slot_l / 2', 'slot_y + slot_w / 2') },
        // A cut keeps copper on its own outline (rasterise.ts), so every cut that opens a patch
        // edge reaches 0.5 mm past it; otherwise a copper rim stays on the old edge.
        { id: 'chamfer_a', op: 'cut', polygon: [['patch_w / 2 - chamfer - 0.5 mm', 'patch_l / 2 + 0.5 mm'], ['patch_w / 2 + 0.5 mm', 'patch_l / 2 - chamfer - 0.5 mm'], ['patch_w / 2 + 0.5 mm', 'patch_l / 2 + 0.5 mm']] },
        { id: 'chamfer_b', op: 'cut', polygon: [['-patch_w / 2 + chamfer + 0.5 mm', '-patch_l / 2 - 0.5 mm'], ['-patch_w / 2 - 0.5 mm', '-patch_l / 2 + chamfer + 0.5 mm'], ['-patch_w / 2 - 0.5 mm', '-patch_l / 2 - 0.5 mm']] },
        { id: 'inset_left', op: 'cut', polygon: rect('-feed_w / 2 - inset_gap', '-patch_l / 2 - 0.5 mm', '-feed_w / 2', '-patch_l / 2 + inset_d') },
        { id: 'inset_right', op: 'cut', polygon: rect('feed_w / 2', '-patch_l / 2 - 0.5 mm', 'feed_w / 2 + inset_gap', '-patch_l / 2 + inset_d') },
        { id: 'feed', op: 'add', polygon: rect('-feed_w / 2', 'port_y', 'feed_w / 2', '-patch_l / 2') },
        // The line carried into the inset, between the notches: part of the inset feature, so a slot never meets it otherwise.
        { id: 'inset_feed', op: 'add', polygon: rect('-feed_w / 2', '-patch_l / 2 - 0.5 mm', 'feed_w / 2', '-patch_l / 2 + inset_d') },
        { id: 'stub', op: 'add', polygon: rect('feed_w / 2', '-patch_l / 2 - stub_d - stub_w / 2', 'feed_w / 2 + stub_l', '-patch_l / 2 - stub_d + stub_w / 2') },
      ],
    },
    ports: [{ id: 'feed', x: '0 mm', y: 'port_y', between: ['gnd', 'top'], reference_impedance_ohm: 50 }],
    boundaries: {
      x_min: { type: 'pml', cells: 8 }, x_max: { type: 'pml', cells: 8 },
      y_min: { type: 'pml', cells: 8 }, y_max: { type: 'pml', cells: 8 },
      z_min: { type: 'pml', cells: 8 }, z_max: { type: 'pml', cells: 8 },
    },
    mesh: meshFor(lambda0, sub.thicknessMm, 'confirm', farField),
    analysis: {
      f_min_ghz: Number((f * 0.75).toFixed(3)),
      f_max_ghz: Number((f * 1.25).toFixed(3)),
      n_freq: 101,
      loss_reference_ghz: f,
      stop: { energy_decay_db: 50, max_steps: 20000 },
    },
    outputs: { zin_at_ghz: [f], ...(farField ? { far_field_ghz: [f] } : {}) },
  };
  return {
    noburf_design: 1,
    goal,
    features: PATCH_FEATURES,
    enabled: [],
    search: { mesh: meshFor(lambda0, sub.thicknessMm, 'search', farField), energy_decay_db: 30 },
    project,
  };
}

/**
 * Graded meshes scaled to the wavelength. Search: about 26 cells per free-space
 * wavelength in the open, fast enough for an optimiser on a CPU. Confirm: twice
 * as fine. A far field needs 4 cells of air on every side for its Huygens box.
 */
function meshFor(lambda0Mm: number, substrateMm: number, fidelity: 'search' | 'confirm', farField: boolean): Project['mesh'] {
  const cell = cellMm(lambda0Mm / (fidelity === 'search' ? 26 : 52));
  const aboveCells = Math.ceil(lambda0Mm / 4 / cell);
  return {
    cell: mm(cell),
    air_margin_cells: { xy: farField ? 4 : 1, below: farField ? 4 : 2, above: aboveCells },
    graded: {
      edge_cell: mm(Math.min(cellMm(cell / 4), substrateMm / 3)),
      dielectric_cells: fidelity === 'search' ? 3 : 6,
      max_growth: 1.3,
    },
  };
}
