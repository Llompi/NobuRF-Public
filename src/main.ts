import { connectBridge, type BridgeLinkStatus } from './bridge_client';
import { DEFAULT_EXCITATION, DEFAULT_GRID } from './engine/config';
import { baselineGeometry } from './engine/geometry';
import type { PortSpectrum } from './engine/port_dft';
import { SimRunner } from './engine/sim_runner';
import type { MicroGeometryDSL, SimTelemetry } from './engine/types';
import { byId, createSerialQueue } from './ui/dom';
import { escapeHtml, fmtDb, readableBridgeError, fmtDuration, fmtOhms, MATCH_GRADE_WORDS, matchGrade, prettyEdit, withMinus } from './ui/format';
import { computeFields } from './viewer/field_client';
import { drawS11 } from './viewer/s11_chart';
import { Scene3D, type FieldPlotMode } from './viewer/scene3d';
import { drawSmith } from './viewer/smith_chart';

const MATCH_GOAL_DB = -15;
const TRACE_COLOR = getComputedStyle(document.documentElement).getPropertyValue('--trace-1').trim();
const params = new URLSearchParams(location.search);
// ?share hides developer controls for clean screenshots and video.
if (params.has('share')) document.body.classList.add('share');
// ?manual says the edits were scripted by a person, so a screenshot can't pass for agent output.
if (params.has('manual')) byId('log-title').textContent = 'Manual tuning steps';

const scene = new Scene3D(byId('viewport'), DEFAULT_GRID);
// Exposed for the screenshot and video capture scripts (camera and phase control).
(window as unknown as { __scene: Scene3D }).__scene = scene;

let runner: SimRunner | null = null;
let chartKind: 's11' | 'smith' = 's11';
let bridgeLink: BridgeLinkStatus = 'connected';
/** Runs the bridge gave up on. They must never show as the current design. */
const discardedRunIds = new Set<string>();
/** The bridge run whose result is on screen, so a late discard can roll it back. */
let shownRunId: string | null = null;
const spectrumHistory: PortSpectrum[] = [];
let latest: { spectrum: PortSpectrum; targetGHz: number } | null = null;
const enqueueSolve = createSerialQueue();

const NOT_APPLIED_NOTICE = 'The last edit was not applied: its solve took longer than the bridge waits for. The view shows the design the bridge kept.';

const BRIDGE_LINK_NOTICE: Record<BridgeLinkStatus, string> = {
  connected: '',
  offline: 'Running without the bridge: this page solves the starting antenna. Agent edits need npm run dev.',
  replaced: 'Another NobuRF tab is now solving agent edits. Reload this tab to bring them back here.',
};

/** Status line. A bridge problem stays visible until it is resolved. */
function setStatus(text: string, isError = false): void {
  const status = byId('status');
  status.textContent = [text, BRIDGE_LINK_NOTICE[bridgeLink]].filter(Boolean).join(' ');
  // Without the bridge the page still works, so only a replaced tab or a real error is shown as a problem.
  status.classList.toggle('bad', isError || bridgeLink === 'replaced');
  status.hidden = status.textContent === '';
}

/** A problem that stops the solver, shown where the antenna would be, with the next step. */
function showBlockingProblem(title: string, nextStep: string, detail: string): void {
  byId('viewport-message-title').textContent = title;
  byId('viewport-message-body').textContent = nextStep;
  byId('viewport-message-detail').textContent = detail;
  byId('viewport-message').hidden = false;
  setStatus('');
}

function drawChart(): void {
  if (!latest) return;
  const canvas = byId<HTMLCanvasElement>('chart');
  if (chartKind === 's11') {
    byId('chart-title').textContent = 'S11 across the band';
    drawS11(canvas, latest.spectrum, latest.targetGHz, spectrumHistory, { traceColor: TRACE_COLOR, goalDb: MATCH_GOAL_DB });
  } else {
    byId('chart-title').textContent = 'Input impedance, Smith chart';
    drawSmith(canvas, latest.spectrum, latest.targetGHz, {
      traceColor: TRACE_COLOR, referenceOhms: DEFAULT_EXCITATION.z0, goalDb: MATCH_GOAL_DB,
    });
  }
}

function drawLegend(): void {
  const legend = scene.legend();
  byId('legend').hidden = legend === null;
  if (!legend) return;
  byId('legend-title').textContent = legend.title;
  byId('legend-ramp').style.background = legend.scaleCss;
  byId('legend-bottom').textContent = legend.ticks[0];
  byId('legend-middle').textContent = legend.ticks[1];
  byId('legend-top').textContent = legend.ticks[2];
}

function showTelemetry(t: SimTelemetry, spectrum: PortSpectrum): void {
  if (spectrumHistory[spectrumHistory.length - 1] !== spectrum) spectrumHistory.push(spectrum);
  latest = { spectrum, targetGHz: t.target_ghz };
  drawChart();

  const grade = matchGrade(t.s11_at_target_db, MATCH_GOAL_DB);
  byId('target-ghz').textContent = String(t.target_ghz);
  const value = byId('s11-at-target');
  value.textContent = fmtDb(t.s11_at_target_db);
  value.className = `number ${grade}`;
  const status = byId('match-status');
  status.textContent = MATCH_GRADE_WORDS[grade];
  status.className = `readout-status ${grade}`;
  byId('deepest-dip').textContent = `Deepest dip ${fmtDb(t.s11_min_db)} at ${t.f0_ghz.toFixed(2)} GHz`;

  byId('fact-impedance').textContent = fmtOhms(t.zin_target[0], t.zin_target[1]);
  const offsetMhz = Math.round((t.f0_ghz - t.target_ghz) * 1000);
  byId('fact-offset').textContent = withMinus(`${offsetMhz > 0 ? '+' : ''}${offsetMhz} MHz`);
  byId('fact-bandwidth').textContent = t.bw10_ghz > 0 ? `${Math.round(t.bw10_ghz * 1000)} MHz` : 'none';
  byId('fact-solve').textContent = t.solve_ms > 0 ? fmtDuration(t.solve_ms) : 'reused, geometry unchanged';
}

function logEdit(t: SimTelemetry, label: string | undefined, reason: string | undefined, runId: string | null): void {
  if (!label) return;
  const list = byId('log');
  if (label === 'reset') list.innerHTML = '';
  const item = document.createElement('li');
  if (runId !== null) item.dataset.runId = runId;
  const unchanged = t.warn.some((w) => w.startsWith('no_voxel_change'));
  const note = unchanged ? `Smaller than the ${DEFAULT_GRID.dxMm} mm grid, so the geometry did not change.` : '';
  item.classList.toggle('unchanged', unchanged);
  item.innerHTML =
    `<span class="edit-number">${t.it}</span>` +
    `<span class="edit-what">${escapeHtml(prettyEdit(label))}</span>` +
    (unchanged
      ? '<span class="edit-result">no change</span>'
      : `<span class="edit-result ${matchGrade(t.s11_at_target_db, MATCH_GOAL_DB)}">${fmtDb(t.s11_at_target_db)}</span>`) +
    [reason, note].filter(Boolean).map((text) => `<span class="edit-reason">${escapeHtml(text!)}</span>`).join('');
  list.prepend(item);
}

function solve(dsl: MicroGeometryDSL, it: number, label?: string, reason?: string, runId: string | null = null): Promise<SimTelemetry> {
  return enqueueSolve(async () => {
    if (!runner) throw new Error('WebGPU solver is not ready');
    // A run the bridge gave up on while it waited in this queue is skipped, so it cannot delay the next edit.
    if (runId !== null && discardedRunIds.has(runId)) throw new Error(`run ${runId} was discarded by the bridge before it started`);
    setStatus(it === 0 ? 'Solving the starting antenna…' : `Solving edit ${it}…`);
    const outcome = await runner.solve(dsl, it, { callerId: 'main' });
    if (runId !== null && discardedRunIds.has(runId)) {
      setStatus(NOT_APPLIED_NOTICE, true);
      return outcome.telemetry;
    }
    shownRunId = runId;
    scene.setGeometry(dsl, outcome.model);
    showTelemetry(outcome.telemetry, outcome.spectrum);
    logEdit(outcome.telemetry, label, reason, runId);
    setStatus('');
    // Field plot and far field are computed in a worker, so the result goes back to the bridge without waiting.
    computeFields(outcome.recording, DEFAULT_GRID, dsl.target_ghz)
      .then((fields) => {
        scene.setFields(fields);
        drawLegend();
        byId('fact-directivity').textContent = `${withMinus(fields.farField.peakDbi.toFixed(1))} dBi`;
      })
      .catch((error) => setStatus(`Field plot failed: ${(error as Error).message}`, true));
    return outcome.telemetry;
  });
}

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error('The bridge is not running, so edits cannot be applied. Start it with npm run dev, then reload.');
  }
  const json = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? `${path}: HTTP ${response.status}`);
  return json;
}

function pressOnly(selector: string, pressed: HTMLButtonElement): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(selector)) button.setAttribute('aria-pressed', String(button === pressed));
}

function wireControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-field-mode]')) {
    button.onclick = () => {
      scene.mode = button.dataset.fieldMode as FieldPlotMode;
      pressOnly('[data-field-mode]', button);
      scene.refreshField();
      drawLegend();
    };
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-chart]')) {
    button.onclick = () => {
      chartKind = button.dataset.chart as 's11' | 'smith';
      pressOnly('[data-chart]', button);
      drawChart();
    };
  }
  byId<HTMLInputElement>('toggle-relief').onchange = (event) => {
    scene.relief = (event.target as HTMLInputElement).checked;
    scene.refreshField();
  };
  byId<HTMLInputElement>('toggle-far-field').onchange = (event) => (scene.showFarField = (event.target as HTMLInputElement).checked);

  const apply = byId<HTMLButtonElement>('apply-edit');
  const reset = byId<HTMLButtonElement>('reset-geometry');
  const editError = byId('edit-error');
  // Errors show under the edit box, next to what caused them.
  const whileBusy = async (action: () => Promise<unknown>) => {
    apply.disabled = reset.disabled = true;
    editError.hidden = true;
    try {
      await action();
    } catch (error) {
      editError.textContent = readableBridgeError((error as Error).message);
      editError.hidden = false;
    } finally {
      apply.disabled = reset.disabled = false;
    }
  };
  // Edits go through the bridge so it stays the single source of truth. The JSON stays in the box on failure.
  apply.onclick = () =>
    whileBusy(async () => {
      let edit: unknown;
      try {
        edit = JSON.parse(byId<HTMLTextAreaElement>('edit-json').value);
      } catch {
        throw new Error('This is not valid JSON. Check quotes and commas, for example {"inset_depth_mm": 4}.');
      }
      await api('/api/apply_edit', edit);
    });
  reset.onclick = () => whileBusy(() => api('/api/reset', {}));
  window.addEventListener('resize', drawChart);
}

async function boot(): Promise<void> {
  wireControls();
  try {
    runner = await SimRunner.create();
  } catch (error) {
    showBlockingProblem(
      'This browser cannot run the solver',
      'NobuRF solves on your graphics card through WebGPU. Open this page in a recent Chrome or Edge on a computer with hardware acceleration turned on.',
      (error as Error).message,
    );
    return;
  }
  runner.engine.device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    showBlockingProblem(
      'The graphics card stopped responding',
      'The solver lost its GPU, often after a driver reset or a very long solve. Reload the page to start it again.',
      info.message,
    );
  });

  connectBridge(
    (msg, reply) => {
      if (msg.type === 'discard') {
        discardRun(msg.id);
        return;
      }
      if (msg.type !== 'run') return; // race messages are for race.html
      solve(msg.dsl, msg.it, msg.label, msg.reason, msg.id)
        .then((telemetry) => reply({ type: 'result', id: msg.id, telemetry }))
        .catch((error) => reply({ type: 'error', id: msg.id, message: String((error as Error).message ?? error) }));
    },
    (link) => {
      bridgeLink = link;
      setStatus('');
    },
    () => ({ type: 'hello', adapter: runner?.engine.adapterName ?? 'unknown' }),
  );

  // First paint: the bridge's current design, or the baseline antenna when the bridge is not running.
  let state: BridgeState | null = null;
  try {
    state = await fetchBridgeState();
  } catch {
    bridgeLink = 'offline'; // shown in the status line; the page still solves the baseline locally
  }
  if (state) await solve(state.geometry, state.it, state.it === 0 ? 'reset' : 'state');
  else await solve(baselineGeometry(), 0, 'reset');
}

type BridgeState = { geometry: MicroGeometryDSL; it: number };
const fetchBridgeState = async () => (await api('/api/state')) as BridgeState;

/** The bridge gave up on a run. Mark its log row, and if it is on screen, go back to the design the bridge kept. */
function discardRun(runId: string): void {
  discardedRunIds.add(runId);
  const row = document.querySelector<HTMLElement>(`#log li[data-run-id="${CSS.escape(runId)}"]`);
  if (row) {
    row.classList.add('discarded');
    row.querySelector('.edit-result')!.textContent = 'not applied';
  }
  if (runId !== shownRunId) {
    setStatus(NOT_APPLIED_NOTICE, true);
    return;
  }
  spectrumHistory.pop(); // the discarded run's trace, so it does not linger as an earlier iteration
  fetchBridgeState()
    .then((state) => solve(state.geometry, state.it))
    .then(() => setStatus(NOT_APPLIED_NOTICE, true))
    .catch((error) => setStatus(`Could not reload the bridge design: ${(error as Error).message}`, true));
}

boot().catch((error) => setStatus(`Start-up failed: ${(error as Error).message}`, true));
