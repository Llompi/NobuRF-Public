/**
 * Live view of a co-design run (scripts/design.ts codesign --serve): S11 of
 * the best design and of the solve that is running, a timeline of solves and
 * AI decisions, and the AI's notes. Live from the run's WebSocket (?ws=port),
 * or played back from a journal (?journal=path, or a dropped journal.jsonl).
 */
import { byId } from '../ui/dom';

interface Spectrum { fGHz: number[]; s11Db: number[] }
interface Metrics { f0_ghz: number; s11_at_target_db: number; s11_min_db: number; bandwidth_mhz: number; z_target_ohm?: { re: number; im: number } }
interface Goal { target_ghz: number; s11_max_db: number; f_tolerance_pct: number }
interface SolveRecord {
  fidelity: 'search' | 'confirm';
  point: { enabled: string[]; values: Record<string, number> };
  metrics: Metrics | null;
  score: number;
  error?: string;
  stopped_early?: { steps: number; reason: string };
  spectrum?: Spectrum;
}
interface Decision { note?: string; action?: string; error?: string; free?: string[]; enable?: string[]; disable?: string[]; values?: Record<string, number>; aim_ghz?: number }
type RunEvent =
  | { t_ms: number; type: 'run'; phase: 'start'; goal: Goal; model: string; solver: string; early_stop: string }
  | { t_ms: number; type: 'run'; phase: 'end'; summary: { ended: string; best_confirmed: { met: boolean; metrics: Metrics } | null } }
  | { t_ms: number; type: 'solve'; record: SolveRecord }
  | { t_ms: number; type: 'frame'; frame: { solve: number; stepsDone: number; energyDecayDb: number; metrics: Metrics; spectrum: Spectrum } }
  | { t_ms: number; type: 'review'; trigger: string; solves_asked: number; solves_answered: number; stats: { ms: number }; decision: Decision; user_says?: string[] }
  | { t_ms: number; type: 'tool'; name: string; result: unknown }
  | { t_ms: number; type: 'you'; text: string };

const SVG = 'http://www.w3.org/2000/svg';
const params = new URLSearchParams(location.search);
/** Energy decay (dB) from which a running solve's partial spectrum is drawn; matches the watcher's FRAME_READY_DB. */
const LIVE_TRACE_DB = 10;

const state = {
  goal: null as Goal | null,
  model: '',
  t: 0,
  solves: [] as Array<{ t: number; record: SolveRecord }>,
  live: null as { spectrum: Spectrum; stepsDone: number; energyDecayDb: number } | null,
  liveStopped: false,
  reviews: [] as Array<{ t: number; ms: number; decision: Decision; lag: number }>,
  ended: false,
};

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

const fmt = (x: number, digits: number) => x.toFixed(digits).replace('-', '−');
const bestSearch = () => state.solves.filter((s) => s.record.metrics && !s.record.stopped_early).sort((a, b) => a.record.score - b.record.score)[0] ?? null;
const bestConfirm = () => state.solves.filter((s) => s.record.fidelity === 'confirm' && s.record.metrics).sort((a, b) => a.record.score - b.record.score)[0] ?? null;

// ---------- S11 chart ----------

function drawChart(): void {
  const el = byId<SVGSVGElement & HTMLElement>('chart');
  const { width, height } = el.getBoundingClientRect();
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.replaceChildren();
  const spectra = state.solves.map((s) => s.record.spectrum).filter((s): s is Spectrum => !!s?.fGHz.length);
  const any = state.live?.spectrum ?? spectra[0];
  if (!any || !state.goal) return;
  const pad = { l: 48, r: 16, t: 12, b: 28 };
  const [f0, f1] = [any.fGHz[0], any.fGHz[any.fGHz.length - 1]];
  const [dbMin, dbMax] = [-30, 0];
  const x = (f: number) => pad.l + ((f - f0) / (f1 - f0)) * (width - pad.l - pad.r);
  const y = (db: number) => pad.t + ((dbMax - Math.max(dbMin, Math.min(dbMax, db))) / (dbMax - dbMin)) * (height - pad.t - pad.b);
  for (let db = dbMin; db <= dbMax; db += 10) {
    el.append(svg('line', { class: 'grid', x1: pad.l, x2: width - pad.r, y1: y(db), y2: y(db) }));
    el.append(svg('text', { x: pad.l - 8, y: y(db) + 4, 'text-anchor': 'end' }, `${fmt(db, 0)} dB`));
  }
  const step = (f1 - f0) > 2 ? 0.5 : 0.25;
  for (let f = Math.ceil(f0 / step) * step; f <= f1 + 1e-9; f += step) {
    el.append(svg('line', { class: 'grid', x1: x(f), x2: x(f), y1: pad.t, y2: height - pad.b }));
    el.append(svg('text', { x: x(f), y: height - 8, 'text-anchor': 'middle' }, `${f.toFixed(2)} GHz`));
  }
  const g = state.goal;
  el.append(svg('line', { class: 'limit', x1: pad.l, x2: width - pad.r, y1: y(g.s11_max_db), y2: y(g.s11_max_db) }));
  el.append(svg('line', { class: 'target', x1: x(g.target_ghz), x2: x(g.target_ghz), y1: pad.t, y2: height - pad.b }));
  const path = (s: Spectrum) => s.fGHz.map((f, k) => `${k ? 'L' : 'M'}${x(f).toFixed(1)},${y(s.s11Db[k]).toFixed(1)}`).join('');
  for (const s of spectra.slice(-12)) el.append(svg('path', { class: 'past', d: path(s) }));
  const best = bestSearch();
  if (best?.record.spectrum) el.append(svg('path', { class: 'best', d: path(best.record.spectrum) }));
  if (state.live) el.append(svg('path', { class: `live${state.liveStopped ? ' live-stopped' : ''}`, d: path(state.live.spectrum) }));
}

// ---------- Timeline ----------

function drawTimeline(): void {
  const el = byId<SVGSVGElement & HTMLElement>('timeline');
  const { width, height } = el.getBoundingClientRect();
  el.setAttribute('viewBox', `0 0 ${width} ${height}`);
  el.replaceChildren();
  const pad = { l: 72, r: 16 };
  const span = Math.max(10_000, state.t);
  const x = (t: number) => pad.l + (t / span) * (width - pad.l - pad.r);
  const rows = { solve: 40, ai: 100 };
  el.append(svg('text', { x: 0, y: rows.solve + 4 }, 'Solves'));
  el.append(svg('text', { x: 0, y: rows.ai + 4 }, 'AI'));
  for (const r of Object.values(rows)) el.append(svg('line', { class: 'grid', x1: pad.l, x2: width - pad.r, y1: r, y2: r }));
  const tick = span > 120_000 ? 30_000 : span > 40_000 ? 10_000 : 5_000;
  for (let t = 0; t <= span; t += tick) el.append(svg('text', { x: x(t), y: height - 6, 'text-anchor': 'middle' }, `${t / 1000} s`));
  for (const s of state.solves) {
    const cls = s.record.fidelity === 'confirm' ? 'solve-confirm' : s.record.stopped_early ? 'solve-stopped' : 'solve';
    el.append(svg('circle', { class: cls, cx: x(s.t), cy: rows.solve, r: s.record.fidelity === 'confirm' ? 6 : 4 }));
  }
  for (const r of state.reviews) {
    el.append(svg('line', { class: 'ask', x1: x(r.t - r.ms), x2: x(r.t), y1: rows.ai, y2: rows.ai }));
    const acts = r.decision.action && r.decision.action !== 'continue';
    el.append(svg('circle', { class: acts ? 'answer-act' : 'answer', cx: x(r.t), cy: rows.ai, r: acts ? 5 : 3 }));
  }
}

// ---------- Panels ----------

function setStat(id: string, text: string): void {
  byId(id).textContent = text;
}

function drawStats(): void {
  setStat('stat-elapsed', `${(state.t / 1000).toFixed(1)} s`);
  setStat('stat-solves', String(state.solves.filter((s) => s.record.fidelity === 'search').length));
  setStat('stat-stopped', String(state.solves.filter((s) => s.record.stopped_early).length));
  const recent = state.reviews.slice(-10);
  if (recent.length) {
    const ms = recent.reduce((a, r) => a + r.ms, 0) / recent.length;
    setStat('stat-answer', ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
    const lag = recent.reduce((a, r) => a + r.lag, 0) / recent.length;
    setStat('stat-lag', `${lag.toFixed(1)} solves`);
  }
}

function statRow(term: string, value: string, valueClass = ''): HTMLDivElement {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = value;
  dd.className = valueClass;
  div.append(dt, dd);
  return div;
}

function drawBest(): void {
  const best = bestConfirm() ?? bestSearch();
  const dl = byId('best');
  if (!best?.record.metrics || !state.goal) {
    // Every solve so far was stopped early: there is no finished design to show yet.
    const stopped = state.solves.filter((s) => s.record.stopped_early).length;
    if (stopped) dl.replaceChildren(statRow('Status', `${stopped} ${stopped === 1 ? 'solve' : 'solves'} stopped early, none finished yet`));
    return;
  }
  const m = best.record.metrics;
  const confirmed = best.record.fidelity === 'confirm';
  const met = best.record.score === 0;
  const rows: Array<[string, string]> = [
    ['Status', `${confirmed ? 'Fine mesh' : 'Search mesh'}, ${met ? 'meets the goal' : 'not there yet'}`],
    ['Resonance', `${fmt(m.f0_ghz, 3)} GHz`],
    ['S11 at target', `${fmt(m.s11_at_target_db, 1)} dB`],
    ['−10 dB band', m.bandwidth_mhz ? `${Math.round(m.bandwidth_mhz)} MHz` : 'none'],
    ...(m.z_target_ohm ? [['Z at target', `${Math.round(m.z_target_ohm.re)} ${m.z_target_ohm.im < 0 ? '−' : '+'} j${Math.abs(Math.round(m.z_target_ohm.im))} Ω`] as [string, string]] : []),
    ['Features', best.record.point.enabled.join(', ') || 'none'],
  ];
  dl.replaceChildren(...rows.map(([k, v]) => statRow(k, v, k === 'Status' && met ? 'good' : '')));
}

const ACTION_WORDS: Record<string, string> = {
  continue: 'Continue', stop_solve: 'Stop this solve', redirect: 'Redirect', confirm: 'Check on the fine mesh', stop: 'Finish',
};

function addFeedItem(t: number, action: string, label: string, note: string, you = false): void {
  const li = document.createElement('li');
  if (you) li.className = 'you';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.className = 'number';
  time.textContent = `${(t / 1000).toFixed(1)} s`;
  const act = document.createElement('span');
  act.className = 'action';
  act.dataset.action = action;
  act.textContent = label;
  meta.append(time, act);
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = note;
  li.append(meta, p);
  byId('feed').prepend(li);
}

function redirectText(d: Decision): string {
  const parts = [
    d.enable?.length ? `switch on ${d.enable.join(', ')}` : '',
    d.disable?.length ? `switch off ${d.disable.join(', ')}` : '',
    d.free?.length ? `free ${d.free.join(', ')}` : '',
    d.values ? Object.entries(d.values).map(([k, v]) => `${k} = ${v.toFixed(2)} mm`).join(', ') : '',
    d.aim_ghz ? `aim at ${d.aim_ghz} GHz` : '',
  ].filter(Boolean);
  return parts.length ? ` (${parts.join('; ')})` : '';
}

// ---------- Events ----------

function apply(e: RunEvent): void {
  state.t = Math.max(state.t, e.t_ms);
  switch (e.type) {
    case 'run':
      if (e.phase === 'start') {
        state.goal = e.goal;
        state.model = e.model;
        byId('model').textContent = `${e.model} · ${e.solver}${e.early_stop === 'rule' ? ' · early-stop rule on' : ''}`;
        byId('goal').textContent = `Goal: dip within ${e.goal.f_tolerance_pct} % of ${e.goal.target_ghz} GHz, S11 at most ${fmt(e.goal.s11_max_db, 0)} dB`;
        byId('empty').hidden = true;
      } else {
        state.ended = true;
        const b = e.summary.best_confirmed;
        addFeedItem(e.t_ms, 'stop', 'Run ended', b ? `${b.met ? 'Met the goal' : 'Missed the goal'} on the fine mesh: ${fmt(b.metrics.f0_ghz, 3)} GHz, ${fmt(b.metrics.s11_at_target_db, 1)} dB.` : `No confirmed design (${e.summary.ended}).`);
        setControls(false);
      }
      break;
    case 'frame':
      // Before the field has rung down the partial spectrum is a smear, not a resonance: show it from 10 dB on,
      // the point where the watcher starts reading frames too. Old journals carry no spectrum at all.
      if (!e.frame.spectrum?.fGHz.length || e.frame.energyDecayDb < LIVE_TRACE_DB) break;
      state.live = { spectrum: e.frame.spectrum, stepsDone: e.frame.stepsDone, energyDecayDb: e.frame.energyDecayDb };
      state.liveStopped = false;
      break;
    case 'solve':
      state.solves.push({ t: e.t_ms, record: e.record });
      if (e.record.stopped_early) state.liveStopped = true;
      else state.live = null;
      break;
    case 'review': {
      const d = e.decision;
      state.reviews.push({ t: e.t_ms, ms: e.stats.ms, decision: d, lag: e.solves_answered - e.solves_asked });
      if (d.error) addFeedItem(e.t_ms, 'refused', 'Answer refused', d.error);
      else if (d.action !== 'continue' || e.trigger !== 'solve' || e.user_says || state.reviews.length % 3 === 1) {
        // Every decision that acts or answers the person is shown; of the plain "continue" notes, one in three.
        addFeedItem(e.t_ms, d.action!, ACTION_WORDS[d.action!] ?? d.action!, `${d.note ?? ''}${d.action === 'redirect' ? redirectText(d) : ''}`);
      }
      break;
    }
    case 'tool': {
      const r = e.result as { error?: string; met?: boolean } | null;
      if (r?.error) addFeedItem(e.t_ms, 'refused', `${e.name} refused`, r.error);
      break;
    }
    case 'you':
      addFeedItem(e.t_ms, 'you', 'You', e.text, true);
      break;
  }
}

let frame = 0;
function render(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    drawChart();
    drawTimeline();
    drawStats();
    drawBest();
  });
}

// ---------- Sources ----------

let socket: WebSocket | null = null;

function setControls(on: boolean): void {
  for (const id of ['say-text', 'say-send', 'stop-solve', 'stop-run']) (byId(id) as HTMLButtonElement).disabled = !on;
}

function connect(port: string): void {
  const link = byId('link');
  link.textContent = 'Connecting…';
  socket = new WebSocket(`ws://localhost:${port}`);
  socket.onopen = () => {
    link.textContent = 'Live';
    link.dataset.state = 'live';
    setControls(true);
  };
  socket.onmessage = (m) => {
    apply(JSON.parse(String(m.data)) as RunEvent);
    render();
  };
  socket.onclose = () => {
    link.textContent = state.ended ? 'Run ended' : 'Disconnected';
    link.dataset.state = '';
    setControls(false);
  };
}

async function replay(lines: string[]): Promise<void> {
  const speed = Number(params.get('speed') ?? 1);
  const link = byId('link');
  link.textContent = speed > 0 ? `Playback at ${speed}×` : 'Playback';
  link.dataset.state = 'replay';
  const events = lines.filter(Boolean).map((l) => JSON.parse(l) as RunEvent);
  const start = performance.now();
  for (const e of events) {
    if (speed > 0) {
      const wait = e.t_ms / speed - (performance.now() - start);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    apply(e);
    render();
  }
}

byId<HTMLFormElement>('say').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = byId<HTMLInputElement>('say-text');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.send(JSON.stringify({ type: 'say', text })); // the run echoes it back as a 'you' event, journaled
  input.value = '';
});
byId('stop-solve').addEventListener('click', () => socket?.send(JSON.stringify({ type: 'stop_solve' })));
byId('stop-run').addEventListener('click', () => {
  // Ending also stops the solve in flight; the run then checks its best design on the fine mesh, which takes a while.
  socket?.send(JSON.stringify({ type: 'stop_solve' }));
  socket?.send(JSON.stringify({ type: 'stop' }));
  (byId('stop-run') as HTMLButtonElement).disabled = true;
  byId('link').textContent = 'Ending: checking the best design on the fine mesh';
});
addEventListener('resize', render);
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) await replay((await file.text()).split('\n'));
});

const ws = params.get('ws');
const journal = params.get('journal');
if (ws) connect(ws);
else if (journal) {
  fetch(journal)
    .then((r) => {
      if (!r.ok) throw new Error(`${journal}: HTTP ${r.status}`);
      return r.text();
    })
    .then((text) => replay(text.split('\n')))
    .catch((err: Error) => {
      byId('link').textContent = `Could not load the journal: ${err.message}`;
    });
}
