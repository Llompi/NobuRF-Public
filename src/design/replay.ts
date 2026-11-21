import type { DesignGoal } from './goal';

/**
 * A design run's journal as a race replay log, the format the race view plays
 * (launch/race-replay/index.html): times in ms from the lane's start, a start,
 * one model_turn_done per model call, an edit per tool call the model made,
 * a solve_done whenever the best design so far changes and at the end of
 * each tool call, and done.
 *
 * The trace is the best design so far, by goal score (search and confirm
 * solves alike), not every solve: Nelder-Mead probes bad points on purpose,
 * and a line that jumps with each probe would hide the progress the race is
 * about. done carries the best confirmed design (the fine mesh, the number
 * that counts) when there is one.
 */
export interface ReplayEvent {
  time_ms: number;
  type: 'start' | 'model_turn_done' | 'edit' | 'solve_done' | 'done' | 'say' | 'heard' | 'goal';
  s11_db_at_target?: number | null;
  /** Whether the design shown meets the whole goal (frequency and S11), so the view does not judge by S11 alone. */
  goal_met?: boolean;
  output_tokens?: number;
  /** model_turn_done: the call's own time, so the view can show thinking apart from the solver, and the
   *  rate-limit wait just before the call (in the lane's clock, not thinking). */
  model_ms?: number;
  wait_ms?: number;
  /** On a solve_done: the model has the turn after it (the tool returned, or a retried call began). */
  model_thinking?: boolean;
  edit?: string;
  /**
   * say: what the person wrote mid-run, at the time they wrote it. heard: when the model got it (with its next
   * tool result). goal: the goal the model set with start_design, in words, from then on.
   */
  text?: string;
  task?: string;
  reason?: string;
}

export interface ReplayLog {
  /** True when a stand-in provider played the model (a rehearsal): the view says so on screen. */
  is_sample_data: boolean;
  /** The agent harness that drove the model (OpenClaw for a sentence race); the view names it. */
  harness?: string;
  lane_label: string;
  match_threshold_db: number;
  target_ghz: number;
  /** The task line the view shows. */
  task: string;
  /** Whether a design met the whole goal on the confirm mesh, and its numbers. */
  result: { met: boolean; f0_ghz: number; s11_db_at_target: number; mesh: 'confirm' | 'search' };
  model_s: number;
  /** Time the lane spent waiting out rate limits: in its clock, not in model_s or tokens/s. */
  rate_limit_wait_s: number;
  cost_usd: number;
  /** Sentence races: the person's request word for word, the lane's solver time, and its final design's 3D lobe (.glb URL). */
  prompt?: string;
  tools_s?: number;
  lobe_glb?: string;
  events: ReplayEvent[];
}

interface JournalSolve {
  t_ms: number;
  type: 'solve';
  record: { fidelity: 'search' | 'confirm'; score: number; metrics: { s11_at_target_db: number; f0_ghz: number } | null };
}
interface JournalModel {
  t_ms: number;
  type: 'model';
  stats: { ms: number; completion_tokens: number | null; retry_wait_ms?: number; served_by?: string };
  text: string | null;
  tool_calls: Array<{ name: string; arguments: string }>;
}
interface JournalTool {
  t_ms: number;
  type: 'tool';
  name: string;
  /** start_design: the goal it set. */
  goal?: DesignGoal;
}
interface JournalSay {
  t_ms: number;
  type: 'say';
  text: string;
  heard_ms?: number;
}
export type JournalEntry = JournalSolve | JournalModel | JournalTool | JournalSay;

const round1 = (x: number) => Math.round(x * 10) / 10;

/** One line per tool call, as a viewer reads it: what the strategist asked for, not the raw JSON. */
export function describeCall(name: string, argsText: string): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(argsText || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
  } catch {
    return `${name} (unreadable arguments)`;
  }
  const on = Array.isArray(args.enable) ? ` with ${(args.enable as string[]).join(' + ') || 'no features'}` : '';
  const mm = (v: unknown) => (typeof v === 'number' ? `${Number(v.toFixed(2))} mm` : String(v));
  switch (name) {
    case 'optimise': {
      const aim = typeof args.aim_ghz === 'number' ? `, aiming at ${args.aim_ghz} GHz` : '';
      return `optimise ${Array.isArray(args.free) ? (args.free as string[]).join(', ') : '?'}${on}${aim}`;
    }
    case 'sweep':
      return `sweep ${args.variable} from ${mm(args.from_mm)} to ${mm(args.to_mm)}`;
    case 'try_design': {
      const values = args.values && typeof args.values === 'object' ? Object.entries(args.values as Record<string, unknown>).map(([k, v]) => `${k} = ${mm(v)}`) : [];
      return `try ${values.join(', ') || 'the current design'}${on}`;
    }
    case 'start_design': {
      if (typeof args.target_ghz !== 'number') return 'start the design';
      const board = `${args.board_w_mm} x ${args.board_l_mm} mm ${typeof args.substrate === 'string' ? args.substrate : 'FR-4'}`;
      const extras = [
        typeof args.min_bandwidth_mhz === 'number' ? `${args.min_bandwidth_mhz} MHz wide` : '',
        typeof args.max_axial_ratio_db === 'number' ? 'circularly polarised' : '',
      ].filter(Boolean);
      return `start: ${args.target_ghz} GHz on a ${board} board${extras.length ? `, ${extras.join(', ')}` : ''}`;
    }
    case 'confirm':
      return 'confirm on the fine mesh';
    case 'finish':
      return 'finish';
    default:
      return name;
  }
}

/** The whole goal in words: every limit that goal_met checks. */
export function taskText(goal: DesignGoal): string {
  const parts = [`S11 at or below ${goal.s11_max_db} dB with the dip within ${goal.f_tolerance_pct} %`];
  if (goal.min_bandwidth_mhz !== undefined) parts.push(`at least ${goal.min_bandwidth_mhz} MHz of bandwidth`);
  if (goal.max_axial_ratio_db !== undefined) parts.push(`axial ratio at most ${goal.max_axial_ratio_db} dB`);
  const last = parts.pop()!;
  return `design a ${goal.target_ghz} GHz patch antenna, ${parts.length ? `${parts.join(', ')} and ${last}` : last}`;
}

/** The hosts that answered a lane's model calls, as the provider named them. */
export function servedBy(journal: JournalEntry[]): string[] {
  return [...new Set(journal.flatMap((e) => (e.type === 'model' && e.stats.served_by ? [e.stats.served_by] : [])))];
}

export function replayFromJournal(
  journal: JournalEntry[],
  options: { laneLabel: string; goal: DesignGoal; modelS: number; costUsd: number; prompt?: string; toolsS?: number; lobeUrl?: string; standIn?: boolean; harness?: string },
): ReplayLog {
  const solves = journal.filter((e): e is JournalSolve => e.type === 'solve' && e.record.metrics !== null);
  if (!solves.length) throw new Error('the journal has no solved design to replay');
  const events: ReplayEvent[] = [];
  // The view needs an S11 to start the trace from: the first design solved.
  events.push({ time_ms: 0, type: 'start', s11_db_at_target: round1(solves[0].record.metrics!.s11_at_target_db) });
  let best: JournalSolve | null = null;
  let bestConfirmed: JournalSolve | null = null;
  // Met counts only on the confirm mesh: the search mesh can read a percent or two off.
  let previousBest: JournalSolve | null = null;
  let startsSeen = 0;
  // A message is heard when a tool returns, later than it was written: those marks go in by time at the end.
  const heard: ReplayEvent[] = [];
  const metOnConfirm = (e: JournalSolve) => e.record.fidelity === 'confirm' && e.record.score === 0;
  for (const entry of journal) {
    if (entry.type === 'model') {
      // The view divides tokens by the time since the previous step. A rate-limit wait inside the call is not the
      // model's speed: mark where the answered attempt began (the trace stays flat), so tokens/s covers that alone.
      // The lane's clock keeps the wait; it is real time the lane lost.
      if (entry.stats.retry_wait_ms && best) {
        events.push({ time_ms: Math.max(0, entry.t_ms - entry.stats.ms), type: 'solve_done', s11_db_at_target: round1(best.record.metrics!.s11_at_target_db), goal_met: metOnConfirm(best), model_thinking: true });
      }
      // A turn logged in the same millisecond as the step before it gets 1 ms.
      const at = Math.max(entry.t_ms, (events[events.length - 1]?.time_ms ?? 0) + 1);
      events.push({ time_ms: at, type: 'model_turn_done', output_tokens: entry.stats.completion_tokens ?? 0, model_ms: entry.stats.ms, ...(entry.stats.retry_wait_ms ? { wait_ms: entry.stats.retry_wait_ms } : {}) });
      for (const call of entry.tool_calls) {
        const edit = describeCall(call.name, call.arguments);
        events.push({ time_ms: at, type: 'edit', edit: call.name === 'start_design' && startsSeen > 0 ? edit.replace(/^start/, 'restart') : edit });
      }
    } else if (entry.type === 'say') {
      events.push({ time_ms: entry.t_ms, type: 'say', text: entry.text });
      if (entry.heard_ms !== undefined) heard.push({ time_ms: entry.heard_ms, type: 'heard', text: entry.text });
    } else if (entry.type === 'tool' && entry.name === 'start_design') {
      if (entry.goal) events.push({ time_ms: entry.t_ms, type: 'goal', task: taskText(entry.goal) });
      // A restart after the person changed the request: the designs so far answered the old goal.
      if (startsSeen++ > 0) {
        previousBest = bestConfirmed ?? best;
        best = null;
        bestConfirmed = null;
      }
    } else if (entry.type === 'tool' && best) {
      // The tool's end: the view times each model turn from the previous solve_done, so mark it (the trace stays flat).
      // After finish the model has nothing left to think about: the harness is shutting down.
      events.push({ time_ms: entry.t_ms, type: 'solve_done', s11_db_at_target: round1(best.record.metrics!.s11_at_target_db), goal_met: metOnConfirm(best), model_thinking: entry.name !== 'finish' });
    } else if (entry.type === 'solve' && entry.record.metrics) {
      if (entry.record.fidelity === 'confirm' && (!bestConfirmed || entry.record.score < bestConfirmed.record.score)) bestConfirmed = entry;
      // At an equal score a confirmed design takes the place of a search one.
      const better = !best || entry.record.score < best.record.score || (entry.record.score === best.record.score && metOnConfirm(entry) && !metOnConfirm(best));
      if (better) {
        best = entry;
        events.push({ time_ms: entry.t_ms, type: 'solve_done', s11_db_at_target: round1(entry.record.metrics.s11_at_target_db), goal_met: metOnConfirm(entry) });
      }
    }
  }
  for (const mark of heard) {
    const at = events.findIndex((e) => e.time_ms > mark.time_ms);
    events.splice(at < 0 ? events.length : at, 0, mark);
  }
  // A restart with no solve after it leaves the last design solved for the old goal.
  const final = bestConfirmed ?? best ?? previousBest!;
  const endMs = Math.max(...journal.map((e) => e.t_ms), ...events.map((e) => e.time_ms));
  events.push({ time_ms: endMs, type: 'done', s11_db_at_target: round1(final.record.metrics!.s11_at_target_db), goal_met: bestConfirmed !== null && metOnConfirm(bestConfirmed) });
  return {
    is_sample_data: options.standIn === true,
    ...(options.harness ? { harness: options.harness } : {}),
    lane_label: options.laneLabel,
    match_threshold_db: options.goal.s11_max_db,
    target_ghz: options.goal.target_ghz,
    task: taskText(options.goal),
    result: {
      met: bestConfirmed?.record.score === 0,
      f0_ghz: Number(final.record.metrics!.f0_ghz.toFixed(3)),
      s11_db_at_target: round1(final.record.metrics!.s11_at_target_db),
      mesh: bestConfirmed ? 'confirm' : 'search',
    },
    model_s: options.modelS,
    rate_limit_wait_s: round1(journal.reduce((sum, e) => sum + (e.type === 'model' ? e.stats.retry_wait_ms ?? 0 : 0), 0) / 1000),
    cost_usd: options.costUsd,
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(options.toolsS !== undefined ? { tools_s: options.toolsS } : {}),
    ...(options.lobeUrl !== undefined ? { lobe_glb: options.lobeUrl } : {}),
    events,
  };
}
