/**
 * NobuRF Workbench: open or build a project, edit it, solve it in a worker,
 * and look at the results. One ProjectStore holds the document; the tree,
 * inspector and 3D view re-render from it after every edit.
 */
import { rasterise } from '../project/rasterise';
import type { Vec2 } from '../project/resolve';
import type { Project } from '../project/schema';
import { byId } from '../ui/dom';
import { escapeHtml, fmtClock, withMinus } from '../ui/format';
import * as actions from './doc_actions';
import type { DrawToolKind, Drawn } from './draw_tool';
import { chartPng, csvFile, download, safeName, touchstoneFile } from './export';
import { canRecordVideo, fieldFramePng, phaseDegrees, recordPhaseCycle } from './field_capture';
import { ImportDialog } from './import_dialog';
import { analyseLine, LineView } from './line_view';
import { pairState, PairView, solveRelevantText, withPairs } from './pair_view';
import { differentialJson } from '../engine/differential';
import { MaterialDialog } from './material_dialog';
import { NewProjectDialog } from './new_project_dialog';
import { Inspector } from './inspector';
import { ModelView, type CameraPreset, type FieldMode } from './model_view';
import type { CutAxis, CutQuantity } from './field_cut';
import { EmissionsView } from './emissions_view';
import { ResultViews } from './results';
import { runSensitivity, SensitivityView } from './sensitivity';
import { parseSelectionKey, selectionKey } from './selection';
import type { SolverChoice, SolveProgress, WorkbenchResult } from './solve';
import { SolveCancelled, startSolve } from './solve_client';
import type { AccuracyMode } from '../verify/accuracy';
import { portsOffCopper } from './port_check';
import { SolveProgressMeter } from './progress';
import { portlessView } from './portless_view';
import { ProjectStore } from './store';
import { ProjectTree } from './tree';

const DEFAULT_EXAMPLE = 'patch-5g8-far-field.json';
const AUTOSAVE_KEY = 'noburf.workbench.project';

const examples = import.meta.glob('/examples/**/*.json', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
const exampleName = (path: string) => path.replace(/^\/examples\//, '');

/* ------------------------------------------------------------------ state */

const store = new ProjectStore({}, DEFAULT_EXAMPLE);
let result: WorkbenchResult | null = null;
let solving: { cancel(): void } | null = null;
/** True while `solving` is the sensitivity study rather than a solve. */
let ranking = false;
/** True while the field video is being encoded: nothing may replace the field under it. */
let recording = false;

const modelView = new ModelView(byId('model-canvas'), (key) => tree.select(key), { onDrawn, onCursor: showDrawCursor });
const inspector = new Inspector(byId('inspector'), store, (key) => tree.select(key), (kind, text) => message(kind, text));
const tree = new ProjectTree(byId('tree'), store, onSelect, onTreeAction);
const results = new ResultViews({
  sChart: byId('sparams-chart'), sFacts: byId('sparams-facts'),
  smith: byId('smith-chart'), smithFacts: byId('smith-facts'),
  zChart: byId('impedance-chart'), zFacts: byId('impedance-facts'),
  farField: byId('farfield-plot'), farFieldFacts: byId('farfield-facts'),
}, (entry) => modelView.setLobe(entry));
const emissionsView = new EmissionsView({
  map: byId('nf-map'), mapArea: byId('nf-map-area'), empty: byId('nf-empty'),
  height: byId('nf-height'), frequency: byId('nf-frequency'), quantity: byId('nf-quantity'), drive: byId('nf-drive'),
  facts: byId('emissions-facts'), notes: byId('emissions-notes'),
});
const lineView = new LineView(byId('line-chart'), byId('line-facts'), byId('line-notes'));
const pairView = new PairView({
  bar: byId('pair-bar'), sChart: byId('pair-s-chart'), tdrChart: byId('pair-tdr-chart'), facts: byId('pair-facts'), notes: byId('pair-notes'),
}, (pairs) => store.update((doc) => withPairs(doc as Record<string, unknown>, pairs)));
const sensitivityView = new SensitivityView({
  rows: byId('sens-rows'), metric: byId('sens-metric'), facts: byId('sens-facts'), notes: byId('sens-notes'), empty: byId('sens-empty'),
});
new ImportDialog(store, message);
const materialDialog = new MaterialDialog(store, (name) => tree.select(selectionKey({ kind: 'material', name })));
new NewProjectDialog((project) => openText(JSON.stringify(project), `${project.name}.json`));
(window as unknown as { __workbench: unknown }).__workbench = { store, modelView };

/* -------------------------------------------------------------- messages */

type MessageKind = 'info' | 'warning' | 'error';

function message(kind: MessageKind, text: string): void {
  const list = byId('messages');
  const item = document.createElement('li');
  item.className = kind;
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  item.innerHTML = `<time>${time}</time><span class="kind">${{ info: 'Info', warning: 'Warning', error: 'Error' }[kind]}</span><span>${escapeHtml(text)}</span>`;
  list.prepend(item);
  while (list.children.length > 50) list.lastElementChild!.remove();
}

/* ------------------------------------------------------------------- views */

const TABS = ['model', 'sparams', 'smith', 'impedance', 'farfield', 'emissions', 'line', 'pair', 'sensitivity'] as const;
type Tab = (typeof TABS)[number];

function showTab(tab: Tab): void {
  for (const t of TABS) {
    const selected = t === tab;
    byId(`tab-${t}`).setAttribute('aria-selected', String(selected));
    byId(`tab-${t}`).tabIndex = selected ? 0 : -1;
    byId(`view-${t}`).hidden = !selected;
  }
}

function wireTabs(): void {
  const tablist = document.querySelector<HTMLElement>('.tabs')!;
  tablist.addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLButtonElement>('[role="tab"]');
    if (tab && !tab.disabled) showTab(tab.id.replace('tab-', '') as Tab);
  });
  tablist.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const enabled = TABS.filter((t) => !byId<HTMLButtonElement>(`tab-${t}`).disabled);
    const at = enabled.findIndex((t) => byId(`tab-${t}`).getAttribute('aria-selected') === 'true');
    const next = enabled[(at + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
    showTab(next);
    byId(`tab-${next}`).focus();
  });
}

function updateResultTabs(): void {
  const has = result !== null;
  for (const t of ['sparams', 'smith', 'impedance'] as const) byId<HTMLButtonElement>(`tab-${t}`).disabled = !has;
  byId<HTMLButtonElement>('tab-farfield').disabled = !result?.farField;
  byId('tab-farfield').title = result?.farField ? 'Gain, directivity and the radiation pattern'
    : 'Enter a frequency in "Far field at" under Setup, Analysis and outputs, then solve';
  byId<HTMLButtonElement>('tab-emissions').disabled = !result?.farField && !result?.nearField;
  byId('tab-emissions').title = result?.farField || result?.nearField ? 'Radiated emissions and near-field scans'
    : 'Enter "Far field at" or "Near-field scan at" under Setup, Analysis and outputs, then solve';
  if (result && !byId<HTMLButtonElement>('tab-emissions').disabled) emissionsView.show(result);
  const line = result ? analyseLine(result) : null;
  byId<HTMLButtonElement>('tab-line').disabled = !line?.ok;
  byId('tab-line').title = line && !line.ok ? line.reason : 'For two ports at the ends of a straight strip';
  if (result && line?.ok) lineView.show(result, line);
  updatePairTab();
  // A tab that this result cannot fill must not keep showing the last one.
  const open = TABS.find((t) => byId(`tab-${t}`).getAttribute('aria-selected') === 'true');
  if (open && byId<HTMLButtonElement>(`tab-${open}`).disabled) showTab(result ? 'sparams' : 'model');
  const fields = result?.fields ?? null;
  document.querySelector<HTMLButtonElement>('[data-field="ez"]')!.disabled = !fields;
  document.querySelector<HTMLButtonElement>('[data-field="current"]')!.disabled = !fields;
  const cutButton = document.querySelector<HTMLButtonElement>('[data-field="cut"]')!;
  cutButton.disabled = !fields;
  if (!fields) showFieldMode('none'); // A disabled button must not stay pressed.
  byId<HTMLInputElement>('show-lobe').disabled = !result?.farField;
}

/** The Differential tab follows the document's pairing, which can change without a new solve. */
function updatePairTab(): void {
  const state = result ? pairState(result, store.document) : null;
  const tab = byId<HTMLButtonElement>('tab-pair');
  tab.disabled = !state || state.kind === 'unavailable';
  tab.title = state?.kind === 'unavailable' ? state.reason : 'Mixed-mode S-parameters, differential impedance and skew of paired ports';
  if (result && state && state.kind !== 'unavailable') pairView.show(result, state);
}

function onSelect(key: string): void {
  inspector.show(key);
  modelView.setSelection(parseSelectionKey(key));
  const kind = parseSelectionKey(key).kind;
  if (kind === 'shape' || kind === 'port' || kind === 'component' || kind === 'layer') showTab('model');
}

function onTreeAction(action: string): void {
  const doc = store.document as Project;
  try {
    if (action === 'add-variable') {
      const { doc: next, name } = actions.addVariable(doc);
      store.update(() => next);
      tree.select(selectionKey({ kind: 'variable', name }));
    } else if (action === 'add-material') {
      materialDialog.open();
    } else if (action === 'add-layer') {
      const { doc: next, index } = actions.addLayerPair(doc);
      store.update(() => next);
      tree.select(selectionKey({ kind: 'layer', index }));
    } else if (action === 'add-port') {
      const { doc: next, index } = actions.addPort(doc);
      store.update(() => next);
      tree.select(selectionKey({ kind: 'port', index }));
    } else if (action === 'add-component') {
      const { doc: next, index } = actions.addComponent(doc);
      store.update(() => next);
      tree.select(selectionKey({ kind: 'component', index }));
    } else if (action === 'add-via') {
      const { doc: next, index } = actions.addVia(doc);
      store.update(() => next);
      tree.select(selectionKey({ kind: 'via', index }));
    } else if (action.startsWith('add-shape:')) {
      const layer = action.slice('add-shape:'.length);
      const { doc: next, index } = actions.addRectangle(doc, layer);
      store.update(() => next);
      tree.select(selectionKey({ kind: 'shape', layer, index }));
    }
  } catch (error) {
    message('error', `That change needs a project that opens without errors first: ${(error as Error).message}`);
  }
}

/** Port problems already reported, so an edit that leaves them as they are does not repeat the message. */
let reportedPortProblems = '';

function renderValidity(): void {
  const v = store.validation;
  const portProblems = v.resolved ? portsOffCopper(v.resolved) : [];
  const el = byId('validity');
  el.className = `validity ${v.error ? 'bad' : portProblems.length ? 'caution' : solving ? 'busy' : 'good'}`;
  el.textContent = v.error ? 'Needs a fix before it can be solved' : portProblems.length ? 'A port is not on copper' : solving ? 'Solving' : 'Ready to solve';
  el.title = portProblems.join('\n');
  const key = portProblems.join('\n');
  if (key && key !== reportedPortProblems) for (const problem of portProblems) message('warning', problem);
  reportedPortProblems = key;
  // While the video encodes, the recording holds these; it calls renderValidity again when it lets go.
  if (!recording) {
    byId<HTMLButtonElement>('solve').disabled = !solving && v.error !== null;
    byId<HTMLButtonElement>('sens-run').disabled = solving ? !ranking : v.error !== null;
    // "Solve with cuts" starts a solve; while one runs it must not act as the Stop it would otherwise become.
    byId<HTMLButtonElement>('cut-resolve').disabled = solving !== null || v.error !== null;
  }
  byId<HTMLButtonElement>('undo').disabled = !store.canUndo;
  byId<HTMLButtonElement>('redo').disabled = !store.canRedo;
  const name = (store.document as Project)?.name;
  document.title = `${typeof name === 'string' ? name + (store.dirty ? ' (edited)' : '') + ' · ' : ''}NobuRF Workbench`;
  const save = byId('save');
  save.classList.toggle('unsaved', store.dirty);
  save.title = store.dirty ? 'Save (Ctrl+S). There are unsaved changes.' : 'Save (Ctrl+S)';
}

function renderStale(): void {
  const empty = byId('stage-empty');
  // The pairing is post-processing: changing it leaves the solve current.
  const stale = result !== null && solveRelevantText(JSON.parse(result.projectText)) !== solveRelevantText(store.document);
  empty.hidden = !stale;
  empty.textContent = stale ? 'The project has changed since this solve. Results are from the earlier version; solve again to update them.' : '';
}

/** The last meshing error told to the user, so an edit that leaves it unchanged does not repeat it. */
let lastMeshError = '';

/** Meshes the project when the mesh is shown, or when a coax port widens the solve box past what the settings say. */
function refreshMesh(): void {
  const project = store.lastValid?.project;
  const showLines = byId<HTMLInputElement>('show-mesh').checked;
  if (!project || (!showLines && !project.ports.some((p) => p.kind === 'sma_edge' || p.kind === 'coax_probe'))) {
    lastMeshError = '';
    return modelView.setMesh(null);
  }
  try {
    const { model } = rasterise(project);
    modelView.setMesh(model.mesh, model.cpml.faces, showLines);
  } catch (error) {
    modelView.setMesh(null);
    // Said once per new problem: this runs on every edit of a coax project.
    const text = (error as Error).message;
    if (text !== lastMeshError) message('error', `Mesh: ${text}`);
    lastMeshError = text;
    return;
  }
  lastMeshError = '';
}

store.subscribe(() => {
  tree.render();
  inspector.render();
  renderValidity();
  renderStale();
  updatePairTab();
  const v = store.validation;
  const shown = v.resolved ?? portlessView(store.document);
  if (shown) {
    modelView.setProject(shown);
    modelView.setSelection(parseSelectionKey(tree.selection));
    if (v.resolved) refreshMesh();
    else modelView.setMesh(null);
  }
  fillDrawLayers();
  autosave();
});

/* ---------------------------------------------------------------- autosave */

interface Autosave {
  fileName: string;
  doc: unknown;
  /** The version last opened or saved, so unsaved edits stay marked as unsaved after a reload. */
  saved: unknown;
}

let autosaveFailed = false;

function autosave(): void {
  const entry: Autosave = { fileName: store.fileName, doc: store.document, saved: store.savedDocument };
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(entry));
    autosaveFailed = false;
  } catch (error) {
    // Private windows and full storage: the project still works, but a reload would lose unsaved edits.
    // An older copy left behind would come back on reload as if it were the last session, so drop it.
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch {
      // Storage blocked outright: there is no older copy to drop either.
    }
    if (!autosaveFailed) message('warning', `This browser would not keep a copy of the project (${(error as Error).message}). Save before you close or reload the page.`);
    autosaveFailed = true;
  }
}

function readAutosave(): Autosave | null {
  let text: string | null;
  try {
    text = localStorage.getItem(AUTOSAVE_KEY);
  } catch {
    return null; // Storage blocked: there is no copy to read. autosave() reports this on the first edit.
  }
  if (text === null) return null;
  try {
    const entry = JSON.parse(text);
    if (entry && typeof entry.fileName === 'string' && entry.doc !== undefined) {
      return { fileName: entry.fileName, doc: entry.doc, saved: entry.saved ?? entry.doc };
    }
  } catch {
    // Reported below with the other unusable entries.
  }
  message('warning', 'The copy of your last session kept by this browser could not be read, so the example opened instead.');
  return null;
}

// The autosave covers a reload; without it, ask before the edits are lost.
window.addEventListener('beforeunload', (e) => {
  if ((autosaveFailed && store.dirty) || solving) e.preventDefault();
});

/* -------------------------------------------------------------------- solve */

/**
 * A solve in progress, kept in this tab's sessionStorage, which a reload and
 * a restored crashed tab keep. Finding it at start-up means the last solve
 * never finished; the page says so rather than leaving the user to wonder.
 */
const RUNNING_SOLVE_KEY = 'noburf.workbench.running-solve';

function markSolveRunning(projectText: string | null): void {
  try {
    if (projectText === null) sessionStorage.removeItem(RUNNING_SOLVE_KEY);
    else sessionStorage.setItem(RUNNING_SOLVE_KEY, JSON.stringify({ fileName: store.fileName, startedAt: Date.now(), projectText }));
  } catch {
    // Storage blocked: the interrupted-solve notice is a courtesy and the solve itself is unaffected.
  }
}

function reportInterruptedSolve(): void {
  let entry: { fileName: string; startedAt: number; projectText: string } | null = null;
  try {
    entry = JSON.parse(sessionStorage.getItem(RUNNING_SOLVE_KEY) ?? 'null');
    sessionStorage.removeItem(RUNNING_SOLVE_KEY);
  } catch {
    return; // Storage blocked: nothing was recorded.
  }
  if (!entry) return;
  const time = new Date(entry.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const same = entry.projectText === JSON.stringify(store.document) ? ' The project is unchanged, so Solve runs it again.' : '';
  message('warning', `The solve of ${entry.fileName} started at ${time} did not finish: the page was reloaded, closed or crashed. Nothing from it was kept.${same}`);
}

function showProgress(label: string, detail: string, fraction: number | null): void {
  byId('progress').hidden = false;
  byId('progress-label').textContent = label;
  byId('progress-detail').textContent = detail;
  const bar = byId('progress-bar');
  bar.classList.toggle('indeterminate', fraction === null);
  bar.style.width = fraction === null ? '' : `${Math.round(100 * Math.min(1, fraction))}%`;
  // Screen readers get the same number; with none, the bar is indeterminate and says only its label.
  const track = byId('progress-track');
  if (fraction === null) track.removeAttribute('aria-valuenow');
  else track.setAttribute('aria-valuenow', String(Math.round(100 * Math.min(1, fraction))));
}

function solve(): void {
  const button = byId<HTMLButtonElement>('solve');
  if (solving) {
    solving.cancel();
    return;
  }
  if (recording || store.validation.error) return;
  const text = JSON.stringify(store.document);
  const choice = byId<HTMLSelectElement>('solver-choice').value as SolverChoice;
  const accuracy = byId<HTMLSelectElement>('mesh-check-choice').value as AccuracyMode;
  const t0 = performance.now();
  let latest: SolveProgress | null = null;
  const meter = new SolveProgressMeter();
  let shownWarnings = new Set<string>();
  const ticker = setInterval(() => {
    if (latest) {
      const t = meter.view(latest, performance.now() - t0);
      showProgress(t.label, t.detail, t.fraction);
    }
  }, 250);
  showProgress('Building the mesh', '', null);
  // Cuts cost memory and solve time, so only a solve started in Cut mode records them.
  const run = startSolve(text, choice, accuracy, cutModeOn(), {
    onStart: (s) => {
      message('info', `Solving on ${s.solver}: ${s.nx} × ${s.ny} × ${s.nz} cells (${(s.nx * s.ny * s.nz / 1e6).toFixed(2)} million), up to ${s.maxSteps.toLocaleString('en-US')} steps${s.runs > 1 ? `, ${s.runs} runs` : ''}.`);
      shownWarnings = new Set(s.warnings);
      for (const w of s.warnings) message('warning', w);
      showProgress(`Solving on ${s.solver}`, '', null);
    },
    onProgress: (p) => (latest = p),
  });
  solving = run;
  markSolveRunning(text);
  button.textContent = 'Stop';
  button.classList.add('stop');
  run.done
    .then((r) => {
      result = r;
      results.show(r);
      modelView.setResults(r.fields, r.farField?.entries[0] ?? null);
      updateResultTabs();
      fillFieldFrequencies();
      drawLegend();
      renderStale();
      for (const w of r.warnings) if (!shownWarnings.has(w)) message('warning', w);
      // The time loop alone, and the whole wait from the click: mesh, GPU setup and the far field are in the second.
      message('info', `Solved in ${fmtClock(performance.now() - t0)} on ${r.solver} (time loop ${fmtClock(r.solveMs)}).`);
      showTab('sparams');
    })
    .catch((error) => {
      if (error instanceof SolveCancelled) message('info', 'Solve stopped.');
      else message('error', `The solve failed: ${(error as Error).message}`);
    })
    .finally(() => {
      markSolveRunning(null);
      clearInterval(ticker);
      solving = null;
      byId('progress').hidden = true;
      button.textContent = 'Solve';
      button.classList.remove('stop');
      renderValidity();
    });
  renderValidity();
}

/**
 * The sensitivity study: 1 + 2 solves per unlocked variable, one at a time in
 * the solve worker. It holds the Solve button (as Stop) while it runs, so the
 * two never share the GPU.
 */
function rankVariables(): void {
  const runButton = byId<HTMLButtonElement>('sens-run');
  const solveButton = byId<HTMLButtonElement>('solve');
  if (solving) {
    if (ranking) solving.cancel();
    return;
  }
  if (recording) return;
  const doc = store.lastValid?.project;
  if (!doc || store.validation.error) {
    message('error', 'The project needs a fix before the variables can be ranked.');
    return;
  }
  const coarse = byId<HTMLSelectElement>('sens-mesh').value === 'coarse';
  const startedText = JSON.stringify(store.document);
  const choice = byId<HTMLSelectElement>('solver-choice').value as SolverChoice;
  const t0 = performance.now();
  let solver = '';
  let index = 0;
  let count = 0;
  let latest: SolveProgress | null = null;
  let meter = new SolveProgressMeter();
  const ticker = setInterval(() => {
    if (!latest || !count) return;
    const t = meter.view(latest, performance.now() - t0);
    showProgress(`Ranking variables: solve ${index + 1} of ${count}`, t.detail, (index + (t.fraction ?? 0)) / count);
  }, 250);
  let run;
  try {
    run = runSensitivity(doc, choice, coarse, byId<HTMLInputElement>('sens-check-step').checked, {
      onSolve: (n, total) => {
        index = n;
        count = total;
        latest = null;
        meter = new SolveProgressMeter();
        showProgress(`Ranking variables: solve ${n + 1} of ${total}`, '', n / total);
      },
      onStart: (start) => (solver = start.solver),
      onProgress: (p) => (latest = p),
    });
  } catch (error) {
    clearInterval(ticker);
    message('error', `Sensitivity: ${(error as Error).message}`);
    return;
  }
  solving = run;
  ranking = true;
  showProgress('Ranking variables', '', null);
  for (const b of [runButton, solveButton]) {
    b.textContent = 'Stop';
    b.classList.add('stop');
  }
  run.done
    .then((report) => {
      if (!report) return message('info', 'Ranking stopped.');
      const seconds = (performance.now() - t0) / 1000;
      const changed = JSON.stringify(store.document) !== startedText;
      sensitivityView.show(report, { mesh: coarse ? 'coarse mesh' : "project's mesh", seconds, solver, changed });
      const top = report.rows[0];
      const topClean = top?.slopes[report.rankBy]?.grade === 'clean';
      message('info', `Ranked ${report.rows.length} variable${report.rows.length === 1 ? '' : 's'} in ${fmtClock(seconds * 1000)} (${report.solves} solves)` +
        `${topClean ? `; ${top.variable.name} moves the resonance most` : ''}.${changed ? ' The project changed while it ran, so the ranking is for the earlier version.' : ''}`);
      showTab('sensitivity');
    })
    .catch((error) => message('error', `Sensitivity: ${(error as Error).message}`))
    .finally(() => {
      clearInterval(ticker);
      solving = null;
      ranking = false;
      byId('progress').hidden = true;
      runButton.textContent = 'Rank variables';
      solveButton.textContent = 'Solve';
      for (const b of [runButton, solveButton]) b.classList.remove('stop');
      renderValidity();
    });
  renderValidity();
}

/* -------------------------------------------------------------- 3D controls */

function fillFieldFrequencies(): void {
  const planes = result?.fields?.planes ?? [];
  const select = byId<HTMLSelectElement>('field-frequency');
  select.innerHTML = planes.map((p, n) => `<option value="${n}">${p.frequencyGHz} GHz</option>`).join('');
  byId('field-frequency-label').hidden = planes.length < 2;
}

function drawLegend(): void {
  showPhaseControls();
  showCutControls();
  const legend = modelView.legend();
  byId('field-legend').hidden = legend === null;
  if (!legend) return;
  byId('field-legend-ramp').hidden = legend.scaleCss === 'none';
  byId('field-legend-title').textContent = legend.title;
  byId('field-legend-ramp').style.background = legend.scaleCss.replace('to top', 'to right');
  byId('field-legend-low').textContent = legend.low;
  byId('field-legend-high').textContent = legend.high;
}

function showFieldMode(mode: FieldMode): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-field]')) b.setAttribute('aria-pressed', String(b.dataset.field === mode));
  modelView.setFieldMode(mode);
  drawLegend();
}

/* -------------------------------------------------------------------- cuts */

/** The cut's field, plane, position and arrows, shown in Cut mode only. */
const cutModeOn = () => document.querySelector('[data-field="cut"]')?.getAttribute('aria-pressed') === 'true';

function showCutControls(): void {
  const cut = modelView.cutSettings;
  const pressed = cutModeOn();
  const fields = result?.fields;
  // A solve that was not asked for cuts: one click solves again with them.
  byId('cut-resolve').hidden = !pressed || !fields || !!fields.volume || fields.volumeAsked;
  byId('cut-controls').hidden = !pressed || !cut;
  if (!pressed || !cut) return;
  byId<HTMLSelectElement>('cut-quantity').value = cut.quantity;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-cut-axis]')) b.setAttribute('aria-pressed', String(b.dataset.cutAxis === cut.axis));
  byId<HTMLInputElement>('cut-arrows').checked = cut.arrows;
  const positions = modelView.cutPositions(cut.axis)!;
  const position = modelView.cutPosition!;
  const slider = byId<HTMLInputElement>('cut-position');
  slider.max = String(positions.length - 1);
  // Leave the thumb alone while it is being dragged: the drag sets the position.
  if (document.activeElement !== slider) slider.value = String(position);
  slider.setAttribute('aria-valuetext', `${cut.axis} = ${positions[position].toFixed(2)} mm`);
  byId('cut-position-label').textContent = cut.axis;
  byId('cut-readout').textContent = `${positions[position].toFixed(2)} mm`;
}

/* ------------------------------------------------------- phase and capture */

/** Phase controls and the video button only for a field whose instant depends on the phase. */
function showPhaseControls(): void {
  const phased = modelView.fieldHasPhase();
  byId('phase-row').hidden = !phased;
  byId<HTMLButtonElement>('capture-video').hidden = !phased;
  showPlaying();
  showPhase(modelView.fieldPhase);
}

function showPlaying(): void {
  const button = byId<HTMLButtonElement>('phase-play');
  button.textContent = modelView.isPlaying ? 'Pause' : 'Play';
  // showPhase leaves the spoken value alone while playing, so refresh it when playback stops.
  if (!modelView.isPlaying) byId('phase-slider').setAttribute('aria-valuetext', `${phaseDegrees(modelView.fieldPhase)} degrees`);
}

function showPhase(phase: number): void {
  const degrees = phaseDegrees(phase);
  const slider = byId<HTMLInputElement>('phase-slider');
  // Leave the thumb alone while it is being dragged: the drag sets the phase.
  if (document.activeElement !== slider || modelView.isPlaying) slider.value = String(degrees);
  // Not every frame while playing, or a screen reader reads out a stream of numbers.
  if (!modelView.isPlaying) slider.setAttribute('aria-valuetext', `${degrees} degrees`);
  byId('phase-readout').textContent = `${degrees}°`;
}

function wirePhaseControls(): void {
  modelView.onPhaseChange = showPhase;
  modelView.onPlayingChange = showPlaying;
  byId('phase-play').addEventListener('click', () => modelView.setPlaying(!modelView.isPlaying));
  byId<HTMLInputElement>('phase-slider').addEventListener('input', (e) => {
    modelView.setPlaying(false);
    modelView.setPhase((Number((e.target as HTMLInputElement).value) * Math.PI) / 180);
  });
  const video = byId<HTMLButtonElement>('capture-video');
  video.disabled = !canRecordVideo();
  if (video.disabled) video.title = 'This browser cannot encode video';
  const fileStem = () => {
    const legend = modelView.legend()!;
    return `${safeName(result?.projectName ?? 'field')}-${safeName(legend.title.split(',')[0].toLowerCase())}`;
  };
  byId('capture-png').addEventListener('click', async () => {
    const legend = modelView.legend();
    if (!legend) return;
    const phase = modelView.fieldHasPhase() ? `-${phaseDegrees(modelView.fieldPhase)}deg` : '';
    download(`${fileStem()}${phase}.png`, await fieldFramePng(modelView, legend.title));
  });
  video.addEventListener('click', async () => {
    const legend = modelView.legend();
    if (!legend || video.disabled) return;
    // A solve landing mid-recording would swap the field under it, and its Stop button is held with the rest.
    if (solving) return message('info', `The video can be made once the ${ranking ? 'ranking' : 'solve'} has finished.`);
    const fileName = `${fileStem()}-cycle`;
    // Hold everything that would change the field under the recording; restore each control's own state after.
    const controls = [
      ...['phase-play', 'phase-slider', 'capture-png', 'capture-video', 'field-frequency', 'solve', 'sens-run', 'new', 'open', 'examples', 'import', 'undo', 'redo',
        'cut-quantity', 'cut-position', 'cut-arrows', 'cut-resolve'].map((id) => byId<HTMLButtonElement>(id)),
      ...document.querySelectorAll<HTMLButtonElement>('[data-field], [data-cut-axis]'),
    ].map((control) => ({ control, wasDisabled: control.disabled }));
    for (const { control } of controls) control.disabled = true;
    recording = true;
    video.textContent = 'Encoding…';
    try {
      download(`${fileName}.webm`, await recordPhaseCycle(modelView, legend.title));
    } catch (error) {
      message('error', `Could not make the video: ${(error as Error).message}.`);
    } finally {
      recording = false;
      for (const { control, wasDisabled } of controls) control.disabled = wasDisabled;
      video.textContent = 'Video';
      renderValidity(); // the document may have changed meanwhile (an inspector edit)
    }
  });
}

function wireCutControls(): void {
  byId('cut-resolve').addEventListener('click', solve);
  byId<HTMLSelectElement>('cut-quantity').addEventListener('change', (e) => {
    modelView.setCut({ quantity: (e.target as HTMLSelectElement).value as CutQuantity });
    drawLegend();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cut-axis]')) {
    button.addEventListener('click', () => {
      modelView.setCut({ axis: button.dataset.cutAxis as CutAxis });
      drawLegend();
    });
  }
  byId<HTMLInputElement>('cut-position').addEventListener('input', (e) => {
    modelView.setCut({ position: Number((e.target as HTMLInputElement).value) });
    drawLegend();
  });
  byId<HTMLInputElement>('cut-arrows').addEventListener('change', (e) => {
    modelView.setCut({ arrows: (e.target as HTMLInputElement).checked });
    drawLegend();
  });
}

function wireModelControls(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-field]')) {
    button.addEventListener('click', () => showFieldMode(button.dataset.field as FieldMode));
  }
  byId<HTMLSelectElement>('field-frequency').addEventListener('change', (e) => {
    modelView.setFieldFrequency(Number((e.target as HTMLSelectElement).value));
    drawLegend();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-camera]')) {
    button.addEventListener('click', () => modelView.setCamera(button.dataset.camera as CameraPreset));
  }
  byId<HTMLInputElement>('show-lobe').addEventListener('change', (e) => modelView.setLobeVisible((e.target as HTMLInputElement).checked));
  byId<HTMLInputElement>('show-domain').addEventListener('change', (e) => modelView.setShowDomain((e.target as HTMLInputElement).checked));
  byId<HTMLInputElement>('show-mesh').addEventListener('change', refreshMesh);
}

/* -------------------------------------------------------------------- files */

/** True when there are no unsaved edits, or the user agrees to drop them. */
function mayReplaceProject(replacement: string): boolean {
  return !store.dirty || confirm(`Open ${replacement}? Your unsaved changes to ${store.fileName} will be lost.`);
}

function openText(text: string, fileName: string): void {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    message('error', `${fileName} is not a project file: it is not valid JSON (${(error as Error).message}).`);
    return;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    message('error', `${fileName} is not a project file: it holds JSON, but not a project object.`);
    return;
  }
  // A dropped file can arrive while the video is encoding; the buttons that open files are held then.
  if (recording) return message('info', `${fileName} was not opened: the field video is still encoding.`);
  if (!mayReplaceProject(fileName)) return;
  solving?.cancel(); // Its results would land on the new project.
  result = null;
  updateResultTabs();
  modelView.setResults(null, null);
  drawLegend();
  showTab('model');
  store.load(doc, fileName);
  tree.select('project');
  modelView.setCamera('iso');
  const problem = store.validation.error;
  if (problem && problem.path === '$.ports' && (store.document as Project).ports?.length === 0) {
    message('info', `Opened ${fileName}. Draw or import copper, then add a port to solve.`);
  } else {
    message(problem ? 'warning' : 'info', problem
      ? `Opened ${fileName}. It has a problem to fix before solving: ${problem.path}: ${problem.message}`
      : `Opened ${fileName}.`);
  }
}

function wireFiles(): void {
  const input = byId<HTMLInputElement>('open-file');
  byId('open').addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) openText(await file.text(), file.name);
    input.value = '';
  });
  const select = byId<HTMLSelectElement>('examples');
  select.innerHTML += Object.keys(examples).sort().map((path) => `<option value="${escapeHtml(path)}">${escapeHtml(exampleName(path))}</option>`).join('');
  select.addEventListener('change', async () => {
    const path = select.value;
    select.value = '';
    if (path) openText(await examples[path](), exampleName(path).split('/').pop()!);
  });
  byId('save').addEventListener('click', () => {
    download(store.fileName.endsWith('.json') ? store.fileName : `${store.fileName}.json`, store.text(), 'application/json');
    // The browser gives no word on whether the download was kept; a started download counts as saved.
    store.markSaved();
  });
  // Export buttons in the result views.
  byId('stage').addEventListener('click', async (e) => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-export]');
    if (!button || !result) return;
    const kind = button.dataset.export;
    if (kind === 'touchstone') {
      const file = touchstoneFile(result);
      if (!file) return message('warning', 'Touchstone needs the full S-matrix: excite every port under Analysis and solve again. CSV has what this solve measured.');
      download(file.fileName, file.text);
    } else if (kind === 'csv') {
      const file = csvFile(result);
      download(file.fileName, file.text, 'text/csv');
    } else if (kind === 'pair-json') {
      const state = pairState(result, store.document);
      if (state.kind !== 'paired' && state.kind !== 'proposed') return;
      const json = differentialJson(state.report, result.portIds, state.specs, result.zinGHz);
      download(`${safeName(result.projectName)}-differential.json`, JSON.stringify({ project: result.projectName, ...json }, null, 2) + '\n', 'application/json');
    } else if (kind === 'png') {
      const background = getComputedStyle(document.body).backgroundColor;
      download(`${safeName(result.projectName)}-${button.dataset.chart!.replace('-chart', '')}.png`, await chartPng(byId<HTMLCanvasElement>(button.dataset.chart!), background));
    }
  });
  // Drop a project file anywhere on the page.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    // While the import dialog is open, a drop belongs to its file field, never to the project behind it.
    if (byId<HTMLDialogElement>('import-dialog').open) {
      if (e.target !== byId('import-file')) e.preventDefault();
      return;
    }
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) openText(await file.text(), file.name);
  });
}

/* ------------------------------------------------------------------ drawing */

const DRAW_HINTS: Record<DrawToolKind, string> = {
  select: '',
  rectangle: 'Drag on the board to draw a rectangle. Edges line up with nearby copper and the board edge; hold Shift to turn that off. Esc to stop.',
  polygon: 'Click each corner; corners line up with nearby copper and the board edge (hold Shift to turn that off). Double-click, Enter or a click on the first corner finishes; Backspace removes a corner, Esc stops.',
  port: 'Click on copper where the port goes. It runs down to the next copper layer, or up from the bottom one. Esc to stop.',
};

function setDrawTool(kind: DrawToolKind): void {
  const layer = byId<HTMLSelectElement>('draw-layer').value;
  if (kind !== 'select' && !layer) return message('warning', 'Add a copper layer first: drawing needs one to draw on.');
  if (kind !== 'select' && !modelView.draw.active) {
    showTab('model');
    modelView.setCamera('top');
  }
  modelView.draw.set(kind, layer);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) button.setAttribute('aria-pressed', String(button.dataset.tool === kind));
  const hint = byId('draw-hint');
  hint.textContent = DRAW_HINTS[kind];
  hint.hidden = kind === 'select';
  if (kind === 'select') showDrawCursor(null);
}

/** The copper layers, top first; keeps the chosen one while it exists. */
function fillDrawLayers(): void {
  const select = byId<HTMLSelectElement>('draw-layer');
  const stackup = (store.document as Partial<Project>).stackup;
  const copper = Array.isArray(stackup) ? stackup.filter((l) => l.type === 'copper').map((l) => l.name).reverse() : [];
  const before = select.value;
  const keep = copper.includes(before) ? before : copper[0] ?? '';
  select.innerHTML = copper.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  select.value = keep;
  // The layer drawn on was renamed or deleted: follow the dropdown, or stop drawing.
  if (keep !== before && modelView.draw.active) setDrawTool(keep ? modelView.draw.tool : 'select');
}

function showDrawCursor(at: Vec2 | null): void {
  const fmt = (v: number) => withMinus(v.toFixed(1));
  byId('draw-cursor').textContent = at ? `x ${fmt(at[0])}  y ${fmt(at[1])} mm` : '';
}

/** Adds what was drawn to the project; false when it was refused. */
function onDrawn(drawn: Drawn): boolean {
  const doc = store.document as Project;
  try {
    if (drawn.kind === 'port') {
      const { doc: next, index } = actions.addPortAt(doc, drawn.layer, drawn.at);
      store.update(() => next);
      tree.select(selectionKey({ kind: 'port', index }));
      setDrawTool('select');
    } else {
      const { doc: next, index } = actions.addDrawnShape(doc, drawn.layer, drawn.points);
      store.update(() => next);
      // The tool stays on for the next shape; Esc or Select leaves it.
      tree.select(selectionKey({ kind: 'shape', layer: drawn.layer, index }));
    }
  } catch (error) {
    message('error', `Could not add it: ${(error as Error).message}`);
    return false;
  }
  return true;
}

function wireDrawing(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    button.addEventListener('click', () => setDrawTool(button.dataset.tool as DrawToolKind));
  }
  byId('draw-layer').addEventListener('change', () => modelView.draw.active && setDrawTool(modelView.draw.tool));
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, select, textarea, dialog')) return;
    // Enter and Backspace belong to a focused button or tree item; Esc always reaches the tool.
    const ownsKey = e.key !== 'Escape' && target.closest('button, a, [tabindex], [role]');
    if (!ownsKey && modelView.draw.key(e)) {
      e.preventDefault();
      if (!modelView.draw.active) setDrawTool('select');
      return;
    }
    const tool = ({ r: 'rectangle', p: 'polygon', t: 'port' } as Record<string, DrawToolKind>)[e.key.toLowerCase()];
    if (tool) {
      e.preventDefault();
      // Pressing the key of the tool in use keeps the shape in progress.
      if (!e.repeat && tool !== modelView.draw.tool) setDrawTool(tool);
    }
  });
}

function wireKeys(): void {
  byId('undo').addEventListener('click', () => store.undo());
  byId('redo').addEventListener('click', () => store.redo());
  byId('solve').addEventListener('click', solve);
  byId('sens-run').addEventListener('click', rankVariables);
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const inField = (e.target as HTMLElement).matches('input[type="text"], textarea');
    // Commit a half-typed value (its change event) before saving or solving.
    if (inField && (e.key.toLowerCase() === 's' || e.key === 'Enter')) (e.target as HTMLElement).blur();
    if (recording && !inField && /^[zy]$/i.test(e.key)) {
      e.preventDefault(); // Undo and Redo are held while the video encodes, keys included.
    } else if (e.key.toLowerCase() === 'z' && !inField) {
      e.preventDefault();
      if (e.shiftKey) store.redo();
      else store.undo();
    } else if (e.key.toLowerCase() === 'y' && !inField) {
      e.preventDefault();
      store.redo();
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      byId('save').click();
    } else if (e.key === 'Enter' && !byId<HTMLButtonElement>('solve').disabled && !solving) {
      e.preventDefault();
      solve();
    }
  });
}

/* --------------------------------------------------------------------- boot */

async function boot(): Promise<void> {
  wireTabs();
  wireModelControls();
  wirePhaseControls();
  wireCutControls();
  wireFiles();
  wireKeys();
  wireDrawing();
  updateResultTabs();
  let saved = readAutosave();
  const fresh = new URLSearchParams(location.search).has('fresh');
  if (saved) {
    try {
      store.load(saved.doc, saved.fileName, saved.saved);
      tree.select('project');
    } catch (error) {
      // A saved copy that no longer loads must not stop the page from starting; open the example instead.
      message('warning', `Could not restore ${saved.fileName} from your last session (${(error as Error).message}). Opened the example instead.`);
      store.markSaved(); // The broken copy is dropped, not edited: opening the example must not ask to keep it.
      saved = null;
    }
  }
  if (saved && !fresh) {
    message('info', `Restored ${saved.fileName} from your last session${store.dirty ? ', with its unsaved changes' : ''}. Open an example to start over.`);
  } else {
    // With ?fresh, openText asks before dropping unsaved edits from the last session.
    const path = Object.keys(examples).find((p) => p.endsWith('/' + DEFAULT_EXAMPLE))!;
    openText(await examples[path](), DEFAULT_EXAMPLE);
  }
  reportInterruptedSolve(); // after the project is settled, so "unchanged" compares with what is open
  showTab('model');
}

boot().catch((error) => message('error', `Start-up failed: ${(error as Error).message}`));
