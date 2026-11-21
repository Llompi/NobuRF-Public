/** Small display helpers shared by the main page and the race view. */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

export type MatchGrade = 'good' | 'caution' | 'bad';

/** good: at or below the goal; caution: below -10 dB (usable); bad: above. Also the CSS class name. */
export function matchGrade(db: number, goalDb: number): MatchGrade {
  return db <= goalDb ? 'good' : db <= -10 ? 'caution' : 'bad';
}

export const MATCH_GRADE_WORDS: Record<MatchGrade, string> = { good: 'Matched', caution: 'Usable', bad: 'Mismatched' };

const EDIT_FIELD_NAMES: Record<string, string> = {
  inset_depth_mm: 'inset depth',
  inset_gap_mm: 'inset gap',
  patch_w_mm: 'patch width',
  patch_l_mm: 'patch length',
  feed_w_mm: 'feed width',
  corner_chamfer_mm: 'corner chamfer',
};

const fieldName = (key: string) => EDIT_FIELD_NAMES[key] ?? key.replace(/_mm$/, '').replace(/[._]/g, ' ');

/**
 * Bridge errors are written for the agent. This rewrites the two that people meet
 * most (a value out of range, a solve timeout) as sentences; others pass through.
 */
export function readableBridgeError(message: string): string {
  const range = /^(\S+)=(\S+) out of range \[(\S+), (\S+)\]$/.exec(message);
  if (range) {
    const [, key, , lo, hi] = range;
    const name = fieldName(key);
    const unit = key.endsWith('_mm') ? ' mm' : '';
    return `${name[0].toUpperCase()}${name.slice(1)} must be ${withMinus(lo)} to ${withMinus(hi)}${unit}.`;
  }
  const timeout = /^browser did not finish the solve within (\d+) ms$/.exec(message);
  if (timeout) {
    return `The solve took longer than the bridge waits (${Math.round(Number(timeout[1]) / 1000)} s), so the edit was not applied.`;
  }
  return message;
}

/** Human-readable edit, e.g. "inset depth 3 mm" or `+ rect slot "trim" 16×0.3 mm`. */
export function prettyEdit(label: string): string {
  if (label === 'reset') return 'baseline';
  if (label === 'state') return 'current design';
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(label);
  } catch {
    return label;
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (k === 'upsert_feature' && v && typeof v === 'object') {
      const f = v as { id: string; kind: string; w_mm: number; h_mm: number };
      parts.push(`${f.kind.replace('_', ' ')} "${f.id}" ${f.w_mm} × ${f.h_mm} mm`);
    } else if (k === 'remove_feature_id') {
      parts.push(`removed "${String(v)}"`);
    } else {
      parts.push(`${fieldName(k)} ${String(v)} mm`);
    }
  }
  return parts.join(', ') || 'no change';
}

/** Typographic minus (U+2212) for display; JS formats negatives with a hyphen. */
export function withMinus(text: string): string {
  return text.replace(/-/g, '−');
}

/**
 * Below this, dip depth is not converged at 3000 steps (see telemetry deep_dip),
 * so the display says "below −20 dB" instead of a precise-looking number.
 */
export const DEPTH_LIMIT_DB = -20;

/** -19.94 -> "−19.9 dB"; -25.3 -> "below −20 dB". */
export function fmtDb(db: number): string {
  if (db < DEPTH_LIMIT_DB) return withMinus(`below ${DEPTH_LIMIT_DB} dB`);
  return withMinus(`${db.toFixed(1)} dB`);
}

/** 840 -> "840 ms", 32175 -> "32.2 s". */
export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Complex impedance as "56 + j9 Ω". */
export function fmtOhms(re: number, im: number): string {
  return `${withMinus(String(Math.round(re)))} ${im < 0 ? '−' : '+'} j${Math.abs(Math.round(im))} Ω`;
}

/** 12.4 s, 1:05.2 past a minute. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
