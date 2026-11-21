import type { GeometryEdit, MicroFeature, MicroGeometryDSL } from './types';

/**
 * Baseline: a deliberately mismatched 5.8 GHz patch on 1.5 mm FR-4.
 *  - Edge-fed (inset 0): the radiating-edge resistance of a patch like this is
 *    a few hundred ohms, so S11 sits around -2..-5 dB. Deepening the inset is
 *    the textbook fix (R_in ~ R_edge * cos^2(pi * d / L)).
 *  - Slightly long (12.4 mm vs ~11.8 mm design) so f0 lands below target and
 *    the agent also has a frequency error to correct.
 */
export function baselineGeometry(): MicroGeometryDSL {
  return {
    version: 1,
    name: 'patch-5g8-baseline',
    target_ghz: 5.8,
    substrate: { eps_r: 4.4, h_mm: 1.5, tan_delta: 0 },
    ground: { w_mm: 24, l_mm: 24 },
    patch: { w_mm: 16, l_mm: 12.4 },
    feed: { w_mm: 2.5, len_mm: 4, inset_depth_mm: 0, inset_gap_mm: 1 },
    corner_chamfer_mm: 0,
    features: [],
  };
}

export function cloneGeometry(g: MicroGeometryDSL): MicroGeometryDSL {
  return JSON.parse(JSON.stringify(g)) as MicroGeometryDSL;
}

/* ------------------------------------------------------------------------ */
/* Validation                                                                 */
/* ------------------------------------------------------------------------ */

export class EditError extends Error {}

const FEATURE_ID = /^[a-z0-9_-]{1,24}$/i;
const MAX_FEATURES = 12;

function finite(name: string, v: unknown, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new EditError(`${name} must be a finite number`);
  if (v < lo || v > hi) throw new EditError(`${name}=${v} out of range [${lo}, ${hi}]`);
  return v;
}

function validateFeature(f: unknown, g: MicroGeometryDSL): MicroFeature {
  if (!f || typeof f !== 'object') throw new EditError('upsert_feature must be an object');
  const o = f as Record<string, unknown>;
  if (typeof o.id !== 'string' || !FEATURE_ID.test(o.id)) {
    throw new EditError('feature.id must match /^[a-z0-9_-]{1,24}$/i');
  }
  const half = Math.max(g.ground.w_mm, g.ground.l_mm) / 2;
  const x = finite('feature.x_mm', o.x_mm, -half, half);
  const y = finite('feature.y_mm', o.y_mm, -half, half);
  const w = finite('feature.w_mm', o.w_mm, 0.1, g.ground.w_mm);
  const h = finite('feature.h_mm', o.h_mm, 0.1, g.ground.l_mm);
  switch (o.kind) {
    case 'rect_slot':
      return { id: o.id, kind: 'rect_slot', x_mm: x, y_mm: y, w_mm: w, h_mm: h };
    case 'stub':
      return { id: o.id, kind: 'stub', x_mm: x, y_mm: y, w_mm: w, h_mm: h };
    case 'u_slot': {
      const t = finite('feature.t_mm', o.t_mm, 0.1, Math.min(w, h) / 2);
      return { id: o.id, kind: 'u_slot', x_mm: x, y_mm: y, w_mm: w, h_mm: h, t_mm: t };
    }
    default:
      throw new EditError(`feature.kind must be rect_slot | u_slot | stub (got ${String(o.kind)})`);
  }
}

/** Structural checks on a whole DSL document (used on reset and after every edit). */
export function validateGeometry(g: MicroGeometryDSL): void {
  finite('substrate.eps_r', g.substrate.eps_r, 1, 12);
  finite('substrate.h_mm', g.substrate.h_mm, 0.2, 5);
  finite('substrate.tan_delta', g.substrate.tan_delta, 0, 0.1);
  finite('target_ghz', g.target_ghz, 0.5, 40);
  finite('patch.w_mm', g.patch.w_mm, 1, g.ground.w_mm - 1);
  finite('patch.l_mm', g.patch.l_mm, 1, g.ground.l_mm - 1);
  finite('feed.w_mm', g.feed.w_mm, 0.2, g.patch.w_mm / 2);
  finite('feed.len_mm', g.feed.len_mm, 0, g.ground.l_mm);
  finite('feed.inset_depth_mm', g.feed.inset_depth_mm, 0, g.patch.l_mm * 0.45);
  finite('feed.inset_gap_mm', g.feed.inset_gap_mm, 0.1, g.patch.w_mm / 4);
  finite('corner_chamfer_mm', g.corner_chamfer_mm, 0, Math.min(g.patch.w_mm, g.patch.l_mm) * 0.4);
  if (g.features.length > MAX_FEATURES) throw new EditError(`at most ${MAX_FEATURES} features`);
  const ids = new Set<string>();
  for (const f of g.features) {
    if (ids.has(f.id)) throw new EditError(`duplicate feature id ${f.id}`);
    ids.add(f.id);
  }
  // Inset notch must not cut the patch in two.
  if (g.feed.w_mm + 2 * g.feed.inset_gap_mm >= g.patch.w_mm - 1) {
    throw new EditError('feed + inset gaps are wider than the patch');
  }
  // Port must stay on the board, clear of the edge.
  const portY = g.patch.l_mm / 2 + g.feed.len_mm;
  if (portY > g.ground.l_mm / 2 - 0.5) throw new EditError('feed runs off the ground plane');
}

/**
 * Apply a surgical delta. Returns a new DSL (input is not mutated).
 * Throws EditError with an agent-readable message on bad input.
 */
export function applyEdit(g: MicroGeometryDSL, edit: GeometryEdit): MicroGeometryDSL {
  if (!edit || typeof edit !== 'object') throw new EditError('edit must be an object');
  const allowed = new Set([
    'reason', // free-text rationale from the agent; logged by the bridge, never applied
    'inset_depth_mm', 'inset_gap_mm', 'corner_chamfer_mm', 'patch_w_mm', 'patch_l_mm',
    'feed_w_mm', 'upsert_feature', 'remove_feature_id',
  ]);
  const keys = Object.keys(edit).filter((k) => k !== 'reason');
  if (keys.length === 0) throw new EditError('empty edit');
  if (edit.reason !== undefined && (typeof edit.reason !== 'string' || edit.reason.length > 300)) {
    throw new EditError('reason must be a string of at most 300 characters');
  }
  for (const k of keys) if (!allowed.has(k)) throw new EditError(`unknown field ${k}`);

  const out = cloneGeometry(g);
  if (edit.patch_w_mm !== undefined) out.patch.w_mm = finite('patch_w_mm', edit.patch_w_mm, 1, out.ground.w_mm - 1);
  if (edit.patch_l_mm !== undefined) out.patch.l_mm = finite('patch_l_mm', edit.patch_l_mm, 1, out.ground.l_mm - 1);
  if (edit.feed_w_mm !== undefined) out.feed.w_mm = finite('feed_w_mm', edit.feed_w_mm, 0.2, out.patch.w_mm / 2);
  if (edit.inset_depth_mm !== undefined) out.feed.inset_depth_mm = finite('inset_depth_mm', edit.inset_depth_mm, 0, out.patch.l_mm * 0.45);
  if (edit.inset_gap_mm !== undefined) out.feed.inset_gap_mm = finite('inset_gap_mm', edit.inset_gap_mm, 0.1, out.patch.w_mm / 4);
  if (edit.corner_chamfer_mm !== undefined) {
    out.corner_chamfer_mm = finite('corner_chamfer_mm', edit.corner_chamfer_mm, 0, Math.min(out.patch.w_mm, out.patch.l_mm) * 0.4);
  }
  if (edit.remove_feature_id !== undefined) {
    const before = out.features.length;
    out.features = out.features.filter((f) => f.id !== edit.remove_feature_id);
    if (out.features.length === before) throw new EditError(`no feature with id ${edit.remove_feature_id}`);
  }
  if (edit.upsert_feature !== undefined) {
    const f = validateFeature(edit.upsert_feature, out);
    const i = out.features.findIndex((x) => x.id === f.id);
    if (i >= 0) out.features[i] = f;
    else out.features.push(f);
  }
  validateGeometry(out);
  return out;
}

/* ------------------------------------------------------------------------ */
/* Copper predicate (patch layer). Coordinates in mm, patch centre = origin.  */
/* ------------------------------------------------------------------------ */

function inRect(x: number, y: number, cx: number, cy: number, w: number, h: number): boolean {
  return Math.abs(x - cx) <= w / 2 && Math.abs(y - cy) <= h / 2;
}

function inFeature(f: MicroFeature, x: number, y: number): boolean {
  if (f.kind !== 'u_slot') return inRect(x, y, f.x_mm, f.y_mm, f.w_mm, f.h_mm);
  // U = left arm + right arm + bottom bar (bottom = toward the feed at -y).
  const { x_mm: cx, y_mm: cy, w_mm: w, h_mm: h, t_mm: t } = f;
  return (
    inRect(x, y, cx - w / 2 + t / 2, cy, t, h) ||
    inRect(x, y, cx + w / 2 - t / 2, cy, t, h) ||
    inRect(x, y, cx, cy - h / 2 + t / 2, w, t)
  );
}

/**
 * Is (x, y) on top-layer copper? Order of operations matters and is fixed:
 *   patch -> chamfers -> inset notch -> slots -> stubs -> feed line.
 * The feed line is painted last so a slot can never disconnect the port.
 */
export function isTopCopper(g: MicroGeometryDSL, x: number, y: number): boolean {
  const { w_mm: W, l_mm: L } = g.patch;
  const { w_mm: fw, len_mm: flen, inset_depth_mm: d, inset_gap_mm: gap } = g.feed;

  // Feed line: from the port (y = -L/2 - flen) up to the bottom of the notch.
  if (Math.abs(x) <= fw / 2 && y >= -L / 2 - flen && y <= -L / 2 + d) return true;

  let cu = inRect(x, y, 0, 0, W, L);
  if (cu && g.corner_chamfer_mm > 0) {
    // Chamfer the top-right and bottom-left corners (classic single-feed CP patch).
    const c = g.corner_chamfer_mm;
    if (x - (W / 2 - c) + (y - L / 2) > 0) cu = false; // top-right
    if (-x - (W / 2 - c) - (y + L / 2) > 0) cu = false; // bottom-left
  }
  if (cu && d > 0 && Math.abs(x) <= fw / 2 + gap && y <= -L / 2 + d) cu = false;

  for (const f of g.features) {
    if (f.kind !== 'stub' && cu && inFeature(f, x, y)) cu = false;
  }
  for (const f of g.features) {
    if (f.kind === 'stub' && inFeature(f, x, y)) cu = true;
  }
  return cu;
}

/**
 * Textbook (Hammerstad / Balanis transmission-line model) TM010 resonance of a
 * rectangular patch, used only as a sanity check on the FDTD result. Expect
 * the solver to land within a few percent: the model ignores the finite ground
 * plane, the feed and the inset, and the 0.5 mm grid adds its own error.
 */
export function textbookPatchF0GHz(g: MicroGeometryDSL): number {
  const c = 299_792_458;
  const er = g.substrate.eps_r;
  const h = g.substrate.h_mm;
  const W = g.patch.w_mm;
  const eeff = (er + 1) / 2 + ((er - 1) / 2) / Math.sqrt(1 + (12 * h) / W);
  const dL = (0.412 * h * (eeff + 0.3) * (W / h + 0.264)) / ((eeff - 0.258) * (W / h + 0.8));
  return c / (2 * (g.patch.l_mm + 2 * dL) * 1e-3 * Math.sqrt(eeff)) / 1e9;
}
