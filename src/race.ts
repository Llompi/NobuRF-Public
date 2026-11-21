/**
 * Race view: the same agent task on two (or more) inference hosts, side by
 * side. This tab is the bridge's solver, so it solves every lane on the one
 * GPU and draws each lane's antenna, field, S11 and clock.
 *
 * Clocks, edit counts, model time and tokens come from the bridge. S11 and
 * fields come from this tab's own solves. Nothing here is estimated.
 */
import { connectBridge, type BridgeLinkStatus } from './bridge_client';
import { DEFAULT_GRID } from './engine/config';
import type { FieldSolution } from './engine/field_solution';
import type { PortSpectrum } from './engine/port_dft';
import { SimRunner, type SolveOutcome } from './engine/sim_runner';
import type { LaneState, MicroGeometryDSL, RaceState } from './engine/types';
import { byId, createSerialQueue } from './ui/dom';
import { escapeHtml, fmtClock, fmtDb, matchGrade, prettyEdit, withMinus } from './ui/format';
import { computeFields } from './viewer/field_client';
import { drawS11 } from './viewer/s11_chart';
import { Scene3D } from './viewer/scene3d';

/** Trace colours in lane order, from the stylesheet. */
const LANE_TRACE_COLORS = ['--trace-1', '--trace-2', '--trace-3', '--trace-4'].map((name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
);

interface LaneSolve {
  /** Bridge run id, so a discard from the bridge can find and undo it. */
  runId: string;
  dsl: MicroGeometryDSL;
  outcome: SolveOutcome;
  /** Computed once per solve in a worker and shared by every lane that shows it. */
  fields: Promise<FieldSolution>;
  label?: string;
  reason?: string;
}

class LaneView {
  readonly root: HTMLElement;
  private readonly scene: Scene3D;
  private readonly chart: HTMLCanvasElement;
  private readonly spectrumHistory: PortSpectrum[] = [];
  private lastSolve: LaneSolve | null = null;
  private readonly clock: { root: HTMLElement; value: HTMLElement; caption: HTMLElement };
  state: LaneState;

  constructor(state: LaneState, private readonly traceColor: string, private readonly goalDb: number) {
    this.state = state;
    this.root = document.createElement('section');
    this.root.className = 'lane';
    this.root.style.setProperty('--lane-trace', traceColor);
    this.root.innerHTML = `
      <div class="lane-head">
        <div class="lane-name">
          <h2 class="lane-provider"><span></span></h2>
          <p class="lane-model"></p>
        </div>
        <div class="lane-clock"><span class="number">0.0 s</span><span class="lane-clock-caption">Running</span></div>
      </div>
      <div class="lane-view"></div>
      <dl class="lane-facts">
        <div><dt>S11 at target</dt><dd class="fact-s11">—</dd></div>
        <div><dt>Edits</dt><dd class="fact-edits">0</dd></div>
        <div><dt>Model time</dt><dd class="fact-model-time">—</dd></div>
        <div><dt>Tokens per model-second</dt><dd class="fact-tokens-per-second">—</dd></div>
      </dl>
      <canvas class="lane-chart" role="img"></canvas>
      <p class="lane-last"></p>`;
    byId('lanes').appendChild(this.root);
    this.scene = new Scene3D(this.part('.lane-view'), DEFAULT_GRID);
    this.chart = this.part<HTMLCanvasElement>('.lane-chart');
    this.clock = { root: this.part('.lane-clock'), value: this.part('.lane-clock .number'), caption: this.part('.lane-clock-caption') };
    this.setState(state);
  }

  private part<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector(selector);
    if (!element) throw new Error(`lane view: missing ${selector}`);
    return element as T;
  }

  setState(state: LaneState): void {
    this.state = state;
    this.part('.lane-provider span').textContent = state.provider ?? state.label;
    this.part('.lane-model').textContent = state.provider ? state.label : '';
    this.chart.setAttribute('aria-label', `S11 across the band for ${state.provider ?? state.label}`);
    this.part('.fact-edits').textContent = String(state.it);
    this.part('.fact-model-time').textContent = state.llm_ms > 0 ? fmtClock(state.llm_ms) : '—';
    this.part('.fact-tokens-per-second').textContent =
      state.llm_ms > 0 && state.tokens > 0 ? String(Math.round(state.tokens / (state.llm_ms / 1000))) : '—';
  }

  showSolve(solve: LaneSolve): void {
    this.lastSolve = solve;
    const t = solve.outcome.telemetry;
    this.scene.setGeometry(solve.dsl, solve.outcome.model);
    if (this.spectrumHistory[this.spectrumHistory.length - 1] !== solve.outcome.spectrum) this.spectrumHistory.push(solve.outcome.spectrum);
    this.redraw();
    const s11 = this.part('.fact-s11');
    s11.textContent = fmtDb(t.s11_at_target_db);
    s11.className = `fact-s11 ${matchGrade(t.s11_at_target_db, this.goalDb)}`;
    const what = solve.label ? prettyEdit(solve.label) : '';
    this.part('.lane-last').innerHTML =
      (t.it > 0 ? `Edit ${t.it}: <span class="edit-what">${escapeHtml(what)}</span>` : 'Starting antenna') +
      `<span class="edit-reason">${solve.reason ? escapeHtml(solve.reason) : '&nbsp;'}</span>`;
    solve.fields
      .then((fields) => {
        if (this.lastSolve === solve) this.scene.setFields(fields); // skip if a newer solve already arrived
      })
      .catch((error) => {
        this.part('.lane-last').textContent = `Field plot failed: ${(error as Error).message}`;
      });
  }

  /** Undo a solve the bridge discarded: drop its trace and show the design the bridge kept. */
  rollBackTo(previous: LaneSolve): void {
    const discarded = this.lastSolve?.outcome.spectrum;
    if (this.spectrumHistory[this.spectrumHistory.length - 1] === discarded) this.spectrumHistory.pop();
    this.showSolve(previous);
  }

  redraw(): void {
    if (!this.lastSolve) return;
    drawS11(this.chart, this.lastSolve.outcome.spectrum, this.lastSolve.dsl.target_ghz, this.spectrumHistory, {
      traceColor: this.traceColor,
      goalDb: this.goalDb,
    });
  }

  /** Called every animation frame with the bridge's clock. */
  tick(bridgeNowMs: number, raceStartMs: number): void {
    const s = this.state;
    let shownMs: number;
    let caption: string;
    if (s.matched_ms !== null) {
      shownMs = s.matched_ms;
      caption = 'Reached target';
    } else if (s.status !== 'running') {
      shownMs = s.elapsed_ms;
      caption = s.status === 'gave_up' ? 'Gave up' : s.status === 'error' ? `Error${s.note ? `: ${s.note}` : ''}` : 'Stopped';
    } else {
      const waitingNow = s.queued_since !== null ? bridgeNowMs - s.queued_since : 0;
      shownMs = bridgeNowMs - raceStartMs - s.queue_ms - waitingNow;
      caption = waitingNow > 0 ? 'Waiting for the GPU' : 'Running';
    }
    this.clock.value.textContent = fmtClock(shownMs);
    if (this.clock.caption.textContent !== caption) this.clock.caption.textContent = caption;
    this.clock.root.classList.toggle('reached', s.matched_ms !== null);
  }
}

let runner: SimRunner | null = null;
let race: RaceState | null = null;
/** Bridge clock minus this tab's clock, so lane clocks run off the bridge's time. */
let clockOffsetMs = 0;
const laneViews = new Map<string, LaneView>();
/** Latest solve per lane ('*' = the shared starting antenna), for lanes built after their solve arrived. */
const latestSolveByLane = new Map<string, LaneSolve>();
/** What each lane showed before its latest solve, for rolling back a run the bridge discards. */
const previousSolveByLane = new Map<string, LaneSolve>();
/** Runs the bridge gave up on (timeout). They are never drawn as a lane's current design. */
const discardedRunIds = new Set<string>();

function discardRun(runId: string): void {
  discardedRunIds.add(runId);
  for (const [lane, shown] of latestSolveByLane) {
    if (shown.runId !== runId) continue;
    const previous = previousSolveByLane.get(lane);
    if (!previous) continue; // the race's starting solve: race/start failed, so no lanes show it
    latestSolveByLane.set(lane, previous);
    previousSolveByLane.delete(lane);
    laneViews.get(lane)?.rollBackTo(previous);
  }
}

const RACE_LINK_NOTICE: Record<BridgeLinkStatus, string> = {
  connected: '',
  offline: 'Bridge offline. Start it with npm run dev; this page reconnects on its own.',
  replaced: 'Another NobuRF tab is now solving. Reload this tab to bring the race back here.',
};

const laneName = (lane: LaneState) => lane.provider ?? lane.label;

function applyRace(next: RaceState | null): void {
  const isNewRace = !race || !next || next.t0 !== race.t0;
  race = next;
  if (!next) return;
  clockOffsetMs = next.now - Date.now();

  const banner = byId('race-banner');
  banner.hidden = !next.dry_run && !next.banner;
  banner.textContent = next.banner ?? 'Dry run: scripted edits, no model';

  const targetGHz = next.lanes[0]?.telemetry?.target_ghz;
  const models = new Set(next.lanes.map((l) => l.label));
  byId('race-task').textContent =
    (models.size === 1 ? `${next.lanes[0].label} tunes` : 'Each lane tunes') +
    ` the same patch antenna to S11 ≤ ${withMinus(`${next.target_db} dB`)}${targetGHz ? ` at ${targetGHz} GHz` : ''}, with the same tools.`;

  if (isNewRace) {
    for (const view of laneViews.values()) view.root.remove();
    laneViews.clear();
    next.lanes.forEach((lane, n) => {
      const view = new LaneView(lane, LANE_TRACE_COLORS[n % LANE_TRACE_COLORS.length], next.target_db);
      laneViews.set(lane.id, view);
      const solve = latestSolveByLane.get(lane.id) ?? latestSolveByLane.get('*');
      if (solve) view.showSolve(solve);
    });
  }
  for (const lane of next.lanes) laneViews.get(lane.id)?.setState(lane);
  // Only touch the live region when the sentence changes, so screen readers announce it once.
  const result = raceResultSentence(next);
  if (byId('race-result').textContent !== result) byId('race-result').textContent = result;
}

function raceResultSentence(r: RaceState): string {
  const reached = r.lanes.filter((l) => l.matched_ms !== null).sort((a, b) => a.matched_ms! - b.matched_ms!);
  if (reached.length === 0) return '';
  const [first, second] = reached;
  if (!second) {
    const stillGoing = r.lanes.filter((l) => l !== first && l.status === 'running').map(laneName);
    const still = stillGoing.length === 0 ? '' : ` ${stillGoing.join(' and ')} ${stillGoing.length === 1 ? 'is' : 'are'} still tuning.`;
    return `${laneName(first)} reached the target in ${fmtClock(first.matched_ms!)}.${still}`;
  }
  const ratio = second.matched_ms! / Math.max(1, first.matched_ms!);
  const comparison = ratio < 1.1 ? 'about the same time' : `${ratio.toFixed(1)}× as long`;
  return `${laneName(first)} reached the target in ${fmtClock(first.matched_ms!)}. ${laneName(second)} took ${fmtClock(second.matched_ms!)}, ${comparison}.`;
}

// Solves run one at a time on the shared GPU. The bridge already serialises them; this covers a reload mid-race.
const enqueueSolve = createSerialQueue();
function solve(dsl: MicroGeometryDSL, it: number, lane: string, runId: string): Promise<SolveOutcome> {
  return enqueueSolve(() => {
    if (!runner) throw new Error('WebGPU solver is not ready');
    // Skipped if the bridge gave up while it waited here, so it cannot delay the next lane's edit.
    if (discardedRunIds.has(runId)) throw new Error(`run ${runId} was discarded by the bridge before it started`);
    if (lane === '*') runner.forgetCallers(); // a new race: no lane has a previous geometry yet
    return runner.solve(dsl, it, { callerId: lane });
  });
}

function animate(): void {
  if (race) {
    const bridgeNow = Date.now() + clockOffsetMs;
    for (const view of laneViews.values()) view.tick(bridgeNow, race.t0);
  }
  requestAnimationFrame(animate);
}

async function boot(): Promise<void> {
  try {
    runner = await SimRunner.create();
  } catch (error) {
    byId('race-task').textContent = `This browser has no usable WebGPU: ${(error as Error).message}. Use a recent Chrome or Edge.`;
    return;
  }
  byId('race-gpu').textContent = `GPU: ${runner.engine.adapterName}.`;
  runner.engine.device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    byId('race-task').textContent = `The graphics card stopped responding (${info.message}). Reload the page to restart the solver; the race clocks are not trustworthy after this.`;
  });
  window.addEventListener('resize', () => laneViews.forEach((view) => view.redraw()));
  requestAnimationFrame(animate);

  connectBridge(
    (msg, reply) => {
      if (msg.type === 'race') {
        applyRace(msg.race);
        return;
      }
      if (msg.type === 'discard') {
        discardRun(msg.id);
        return;
      }
      if (msg.type !== 'run') return;
      const lane = msg.lane ?? 'main';
      solve(msg.dsl, msg.it, lane, msg.id)
        .then((outcome) => {
          reply({ type: 'result', id: msg.id, telemetry: outcome.telemetry });
          if (lane === 'main') return; // a main-page edit: solved for the bridge, nothing to draw here
          if (discardedRunIds.has(msg.id)) return; // the bridge kept the lane's previous design
          const laneSolve: LaneSolve = {
            runId: msg.id,
            dsl: msg.dsl, outcome, label: msg.label, reason: msg.reason,
            // In a worker, so the next lane's solve never waits on this lane's post-processing.
            fields: computeFields(outcome.recording, DEFAULT_GRID, msg.dsl.target_ghz),
          };
          if (lane === '*') {
            latestSolveByLane.clear(); // a new race drops the previous race's lanes
            previousSolveByLane.clear();
          } else {
            const shownBefore = latestSolveByLane.get(lane) ?? latestSolveByLane.get('*');
            if (shownBefore) previousSolveByLane.set(lane, shownBefore);
          }
          latestSolveByLane.set(lane, laneSolve);
          const targets = lane === '*' ? [...laneViews.values()] : [laneViews.get(lane)];
          for (const view of targets) view?.showSolve(laneSolve);
        })
        .catch((error) => reply({ type: 'error', id: msg.id, message: String((error as Error).message ?? error) }));
    },
    (link) => {
      byId('race-connection').textContent = RACE_LINK_NOTICE[link];
    },
    () => ({ type: 'hello', adapter: runner?.engine.adapterName ?? 'unknown' }),
  );
}

boot().catch((error) => {
  byId('race-task').textContent = `Start-up failed: ${(error as Error).message}`;
});
