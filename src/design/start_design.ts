import { BUILTIN_MATERIALS } from '../project/schema';
import type { DesignFile } from './design_file';
import { parseDesignFile } from './design_file';
import type { DesignGoal } from './goal';
import type { ChatTool } from './llm';
import { patchDesign, patchEstimateMm } from './patch_template';

/** Substrates a request may name: the built-in dielectrics a patch is made on (air is not a board). */
export const BOARD_SUBSTRATES = Object.entries(BUILTIN_MATERIALS)
  .filter(([name, m]) => m.kind === 'dielectric' && name !== 'air')
  .map(([name]) => name);

/** What a design request may ask for, in the solver's validated range for a patch on a two-layer board. */
const LIMITS = {
  target_ghz: [1, 12],
  board_mm: [5, 150],
  thickness_mm: [0.1, 5],
  s11_max_db: [-40, -3],
  min_bandwidth_mhz: [1, 2000],
  max_axial_ratio_db: [0.5, 10],
} as const;

/**
 * The first tool of a session that starts from a sentence: the model reads the
 * person's request ("a 2.4 GHz patch under 30 mm on FR-4") and states it as a
 * goal and a board. The solver then builds the starting antenna from textbook
 * formulas; the model never writes geometry.
 */
export const START_DESIGN_TOOL: ChatTool = {
  name: 'start_design',
  description:
    "Turn the person's request into a design goal and a board, and build the starting antenna (an edge-fed rectangular patch sized " +
    'from textbook formulas). Call it once, before any other tool. Returns the brief. Only state what the request says or clearly implies; ' +
    'leave optional limits out when the request does not ask for them.',
  parameters: {
    type: 'object',
    properties: {
      target_ghz: { type: 'number', minimum: LIMITS.target_ghz[0], maximum: LIMITS.target_ghz[1], description: 'Centre frequency.' },
      board_w_mm: { type: 'number', minimum: LIMITS.board_mm[0], maximum: LIMITS.board_mm[1], description: 'Board width (across the feed). "Under 30 mm" means 30.' },
      board_l_mm: { type: 'number', minimum: LIMITS.board_mm[0], maximum: LIMITS.board_mm[1], description: 'Board length (along the feed).' },
      substrate: { type: 'string', enum: BOARD_SUBSTRATES, description: 'Board material. Default FR-4.' },
      thickness_mm: { type: 'number', minimum: LIMITS.thickness_mm[0], maximum: LIMITS.thickness_mm[1], description: 'Substrate thickness. Default 1.6.' },
      s11_max_db: { type: 'number', minimum: LIMITS.s11_max_db[0], maximum: LIMITS.s11_max_db[1], description: 'Match: S11 at the target at most this. Default -10.' },
      min_bandwidth_mhz: { type: 'number', minimum: LIMITS.min_bandwidth_mhz[0], maximum: LIMITS.min_bandwidth_mhz[1], description: 'Only when the request asks for bandwidth.' },
      max_axial_ratio_db: { type: 'number', minimum: LIMITS.max_axial_ratio_db[0], maximum: LIMITS.max_axial_ratio_db[1], description: 'Only when the request asks for circular polarisation.' },
    },
    required: ['target_ghz', 'board_w_mm', 'board_l_mm'],
    additionalProperties: false,
  },
};

export interface DesignRequest {
  target_ghz: number;
  board_w_mm: number;
  board_l_mm: number;
  substrate?: string;
  thickness_mm?: number;
  s11_max_db?: number;
  min_bandwidth_mhz?: number;
  max_axial_ratio_db?: number;
}

const ALLOWED = new Set(Object.keys((START_DESIGN_TOOL.parameters as { properties: object }).properties));

function inRange(args: Record<string, unknown>, name: string, [min, max]: readonly [number, number], required: boolean): number | undefined {
  const v = args[name];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  if (v < min || v > max) throw new Error(`${name} must be between ${min} and ${max}, got ${v}`);
  return v;
}

/** A request as the tool receives it (untrusted JSON), checked. Throws with a message the model can act on. */
export function parseDesignRequest(args: Record<string, unknown>): DesignRequest {
  const unknown = Object.keys(args).filter((k) => !ALLOWED.has(k));
  if (unknown.length) throw new Error(`unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  const substrate = args.substrate ?? 'FR-4';
  if (typeof substrate !== 'string' || !BOARD_SUBSTRATES.includes(substrate)) throw new Error(`substrate must be one of ${BOARD_SUBSTRATES.join(', ')}`);
  const request: DesignRequest = {
    target_ghz: inRange(args, 'target_ghz', LIMITS.target_ghz, true)!,
    board_w_mm: inRange(args, 'board_w_mm', LIMITS.board_mm, true)!,
    board_l_mm: inRange(args, 'board_l_mm', LIMITS.board_mm, true)!,
    substrate,
    thickness_mm: inRange(args, 'thickness_mm', LIMITS.thickness_mm, false) ?? 1.6,
    s11_max_db: inRange(args, 's11_max_db', LIMITS.s11_max_db, false) ?? -10,
  };
  const bandwidth = inRange(args, 'min_bandwidth_mhz', LIMITS.min_bandwidth_mhz, false);
  const axialRatio = inRange(args, 'max_axial_ratio_db', LIMITS.max_axial_ratio_db, false);
  if (bandwidth !== undefined) request.min_bandwidth_mhz = bandwidth;
  if (axialRatio !== undefined) request.max_axial_ratio_db = axialRatio;
  return request;
}

/**
 * The design file for a request: an edge-fed patch on the named built-in
 * substrate. The substrate's permittivity comes from the material itself, so
 * the textbook sizing and the solve can never disagree about it.
 */
export function designFromRequest(request: DesignRequest): DesignFile {
  const material = request.substrate ?? 'FR-4';
  const builtIn = BUILTIN_MATERIALS[material];
  if (builtIn?.kind !== 'dielectric') throw new Error(`substrate must be one of ${BOARD_SUBSTRATES.join(', ')}`);
  const goal: DesignGoal = {
    target_ghz: request.target_ghz,
    s11_max_db: request.s11_max_db ?? -10,
    f_tolerance_pct: 1,
    ...(request.min_bandwidth_mhz !== undefined ? { min_bandwidth_mhz: request.min_bandwidth_mhz } : {}),
    ...(request.max_axial_ratio_db !== undefined ? { max_axial_ratio_db: request.max_axial_ratio_db } : {}),
  };
  const design = patchDesign({
    goal,
    boardWMm: request.board_w_mm,
    boardLMm: request.board_l_mm,
    substrate: { material, epsR: builtIn.eps_r, thicknessMm: request.thickness_mm ?? 1.6 },
  });
  return parseDesignFile(design); // the template must itself be valid
}

/**
 * What the textbook says about the request, for the model's first look: the patch the formulas give for the
 * target and substrate, and whether the board is smaller than that (so the design must be miniaturised or the
 * request cannot be met as asked).
 */
export function sizingNote(request: DesignRequest) {
  const material = BUILTIN_MATERIALS[request.substrate ?? 'FR-4'];
  if (material?.kind !== 'dielectric') throw new Error(`unknown substrate ${request.substrate}`);
  const est = patchEstimateMm(request.target_ghz, material.eps_r, request.thickness_mm ?? 1.6);
  const round = (x: number) => Number(x.toFixed(1));
  // The template leaves 2 mm across and 6 mm along the feed for the feed line and the port.
  const fits = est.w <= request.board_w_mm - 2 && est.l <= request.board_l_mm - 6;
  return {
    textbook_patch_mm: { w: round(est.w), l: round(est.l) },
    fits_board: fits,
    ...(fits ? {} : { note: 'the textbook patch does not fit this board: the starting patch is clamped to it, so the resonance starts above the target' }),
  };
}
