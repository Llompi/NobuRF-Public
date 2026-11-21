/**
 * Every solve's self-check, shared by `noburf solve` and the workbench:
 * mesh convergence with an error bar (convergence.ts), physics checks on S
 * (checks.ts) and where the design sits against what has been validated
 * (envelope.ts). Each failure becomes a warning in plain words.
 */
import type { ResolvedProject } from '../project/resolve';
import { energyCheck, passivityCheck, reciprocityCheck, type CheckResult } from './checks';
import type { MeshLines } from '../engine/mesh';
import { meshConvergence, RESONANCE_TOLERANCE, type Behaviour, type ConvergenceReport, type LevelSolve, type SolveLevel } from './convergence';
import { envelopeFindings, envelopeWarnings, type EnvelopeFinding } from './envelope';

export type AccuracyMode = 'check' | 'refine' | 'off';

export interface AccuracyReport {
  mode: AccuracyMode;
  convergence: ConvergenceReport | null;
  /** Why there is no convergence report: "off", why the project cannot take one, or the error a level raised. */
  unavailable: string | null;
  checks: CheckResult[];
  envelope: EnvelopeFinding[];
  warnings: string[];
}

export interface SolvedLevel extends LevelSolve {
  runs: Array<{ energyDecayDb: number; stoppedOnEnergy: boolean }>;
}

/**
 * Representative cell size of the board region (Celik's h = (V / N)^(1/3)):
 * the cells inside the board outline's bounding box and through the stackup,
 * z = 0 to its top. The PML and the air keep their own cell counts between
 * levels, so counting them would misstate the refinement ratio.
 */
export function boardCellSizeMm(mesh: MeshLines, resolved: ResolvedProject): number {
  const xs = resolved.boardOutline.map((p) => p[0]), ys = resolved.boardOutline.map((p) => p[1]);
  const top = resolved.stackup.reduce((z, l) => z + (l.type === 'dielectric' ? l.thicknessMm : 0), 0);
  const inside = (lines: Float64Array, lo: number, hi: number) => {
    let n = 0;
    for (let k = 1; k < lines.length; k++) {
      const mid = (lines[k - 1] + lines[k]) / 2;
      if (mid > lo && mid < hi) n++;
    }
    return n;
  };
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const cells = inside(mesh.x, x0, x1) * inside(mesh.y, y0, y1) * inside(mesh.z, 0, top);
  if (!(cells > 0)) throw new Error('internal: no cells inside the board region');
  return Math.cbrt(((x1 - x0) * (y1 - y0) * top) / cells);
}

/**
 * Why the mesh study cannot run on this project, or null. Both cases make
 * the levels something other than one board on systematically refined
 * meshes, so the GCI would measure the wrong thing.
 */
export function meshStudyBlocker(json: Record<string, any>): string | null {
  if (!json.mesh.graded) {
    return 'a uniform mesh rounds each layer to whole cells, so a finer mesh is not the same board refined evenly; use a graded mesh';
  }
  const coax = (json.ports as Array<{ kind?: string }>).find((p) => p.kind === 'sma_edge' || p.kind === 'coax_probe');
  if (coax) return `the ${coax.kind} feed is meshed with fixed-size cells that do not scale with the rest, so the meshes are not refined evenly`;
  return null;
}

export async function assessAccuracy<T extends SolvedLevel>(
  json: Record<string, any>, baseline: T, solveLevel: (json: Record<string, any>, scale: number) => Promise<T>,
  resolved: ResolvedProject, options: { mode: AccuracyMode; tolerance: number },
): Promise<{ report: AccuracyReport; finest: T }> {
  const warnings: string[] = [];
  const a = json.analysis as { f_min_ghz: number; f_max_ghz: number; stop: { energy_decay_db: number } };
  let convergence: ConvergenceReport | null = null;
  let unavailable: string | null = options.mode === 'off' ? 'off' : meshStudyBlocker(json);
  // A level cut off before it rang down would feed truncated S into the estimate, the project's own included.
  if (unavailable === null && !energyCheck(baseline.runs, a.stop.energy_decay_db).passed) {
    unavailable = 'the project mesh stopped before ringing down, so a finer mesh would be compared with truncated S; raise analysis.stop.max_steps';
  }
  let finest = baseline;
  if (unavailable === null) {
    const rungDown = async (levelJson: Record<string, any>, scale: number) => {
      const level = await solveLevel(levelJson, scale);
      const short = energyCheck(level.runs, a.stop.energy_decay_db);
      if (!short.passed) throw new Error(`the mesh with cells x${scale.toFixed(3)} stopped before ringing down (${short.detail})`);
      return level;
    };
    try {
      const run = await meshConvergence(json, baseline, rungDown as SolveLevel, { mode: options.mode as 'check' | 'refine', tolerance: options.tolerance });
      convergence = run.report;
      finest = run.finest as T;
    } catch (e) {
      // The first finer mesh failed, did not ring down, or is no different
      // on the board. The project mesh's solve stands, without an error
      // bar, and says so.
      unavailable = (e as Error).message;
    }
  }
  if (unavailable !== null && unavailable !== 'off') warnings.push(`no mesh error bar: ${unavailable}`);
  const checks = [passivityCheck(finest.s), reciprocityCheck(finest.s), energyCheck(finest.runs, a.stop.energy_decay_db)]
    .filter((c): c is CheckResult => c !== null);
  // The solvers already warn about a run cut off before it rang down, with the step cap to raise.
  for (const c of checks) {
    if (c.name === 'energy_decay' || !c.marginal) continue;
    warnings.push(`${c.name} check ${c.passed ? 'marginal' : 'failed'}: ${c.detail}`);
  }
  const envelope = envelopeFindings(resolved, a.f_min_ghz, a.f_max_ghz);
  warnings.push(...envelopeWarnings(envelope));
  if (convergence) warnings.push(...convergenceWarnings(convergence));
  return { report: { mode: options.mode, convergence, unavailable, checks, envelope, warnings }, finest };
}

/**
 * Only what changes how far to trust the numbers. Delta S over the whole
 * band is not one of them on its own: near a sharp dip a resonance shift a
 * fraction of a percent wide moves S a lot, so it is reported, not warned.
 */
function convergenceWarnings(c: ConvergenceReport): string[] {
  const out: string[] = [];
  if (c.refineStopped) out.push(`refining stopped early, so the result is from the finest mesh that solved: ${c.refineStopped}`);
  const f = c.fResGhz;
  const pct = f ? (100 * f.uncertainty) / f.value : 0;
  if (f && ROUGH.includes(f.behaviour)) {
    out.push(`the resonance ${BEHAVIOUR_TEXT[f.behaviour as keyof typeof BEHAVIOUR_TEXT]}, so its mesh band of ${pct.toFixed(1)} % is a rough bound; refine the mesh`);
  } else if (f && pct > 100 * RESONANCE_WARNING) {
    out.push(`the resonance is uncertain by ${pct.toFixed(1)} % from the mesh alone; refine the mesh or check it with two finer meshes`);
  }
  if (!f && !c.converged) {
    const last = c.levels[c.levels.length - 1];
    out.push(`S still moves by up to ${last.deltaS!.toFixed(3)} between the two finest meshes (tolerance ${c.tolerance}); refine the mesh`);
  }
  return out;
}

/** A resonance band above this warns: wider than the benchmarks' agreement with measurement. */
const RESONANCE_WARNING = 0.01;

/** Behaviours whose band is only a rough bound. */
const ROUGH: Behaviour[] = ['oscillatory', 'divergent'];

export const BEHAVIOUR_TEXT: Record<Exclude<Behaviour, 'monotone' | 'unchanged'>, string> = {
  'two-level': 'is measured on two meshes, so the band assumes first-order convergence with a safety factor of 3',
  'low-order': 'converges more slowly than first order, so the band uses order 0.8 and a safety factor of 3',
  'high-order': 'converges faster than the formal second order, a sign of noise, so the band uses order 2 and a safety factor of 3',
  oscillatory: 'moves back and forth between meshes',
  divergent: 'moves further on each finer mesh',
};

/** What the band is and is not. */
export const BAND_SCOPE = 'mesh discretisation uncertainty only; it excludes port and material model error';

/** How far the last pass moved S and the resonance, against the stop rule's tolerances. */
export function lastChange(r: ConvergenceReport): string {
  const [previous, last] = r.levels.slice(-2);
  const text = [`Delta S ${last.deltaS!.toFixed(4)} (tolerance ${r.tolerance})`];
  if (last.fResGhz !== null && previous.fResGhz !== null) {
    const pct = (100 * Math.abs(last.fResGhz - previous.fResGhz)) / last.fResGhz;
    text.push(`resonance shift ${pct.toFixed(2)} % (tolerance ${100 * RESONANCE_TOLERANCE} %)`);
  }
  return text.join(', ');
}

/** One line: the result with its band, or why there is none. */
export function convergenceSummary(r: ConvergenceReport): string {
  const parts = [`${r.converged ? 'settled' : 'still moving'}: ${lastChange(r)}`];
  if (r.s11Min) parts.unshift(`|S11| at the dip ${r.s11Min.value.toFixed(3)} +/- ${r.s11Min.uncertainty.toFixed(3)}`);
  const f = r.fResGhz;
  if (f) {
    const pct = (100 * f.uncertainty) / f.value;
    const how = f.behaviour === 'monotone' ? ` (observed order ${f.observedOrder!.toFixed(2)})`
      : f.behaviour === 'unchanged' ? '' : ` (the resonance ${BEHAVIOUR_TEXT[f.behaviour]})`;
    parts.unshift(`f_res ${f.value.toFixed(4)} GHz +/- ${pct.toFixed(2)} %${how}`);
  }
  return `mesh ${r.mode} over ${r.levels.length} meshes (${BAND_SCOPE}): ${parts.join(', ')}`;
}
