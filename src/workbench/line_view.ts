/**
 * The Line view, for a two-port project whose ports sit at the two ends of a
 * straight strip: Z0, eps_eff and loss from the fields along the strip, and
 * a step TDR from each port.
 */
import { escapeHtml, withMinus } from '../ui/format';
import { LineChart, type Trace } from './line_chart';
import { stepTdr } from '../engine/time_domain';
import { lineFromFields, type LineFromFields } from './line_analysis';
import type { WorkbenchResult } from './solve';

const C_MM_PER_NS = 299.792458;

export type LineAnalysis =
  | { ok: true; fit: LineFromFields[] | null; fitProblem: string | null }
  | { ok: false; reason: string };

/** Whether the result is a line between two ports, and the field fit when it can be made. */
export function analyseLine(r: WorkbenchResult): LineAnalysis {
  if (r.portIds.length !== 2) return { ok: false, reason: 'The line view needs exactly two ports.' };
  if (r.s.re.some((row) => row.some((column) => !column))) return { ok: false, reason: 'The line view needs both ports excited.' };
  const fields = r.fields;
  if (!fields) return { ok: false, reason: 'The line view needs the field planes, which this result does not have.' };
  if (r.portsJoinedByCopper === false) {
    return { ok: false, reason: `The line view needs the two ports joined by one strip on layer ${fields.copperLayer}; there they sit on separate copper.` };
  }
  const onStrip = r.ports.every((p) => p.between.includes(fields.copperLayer));
  try {
    if (!onStrip) throw new Error(`both ports must connect to ${fields.copperLayer}, the copper layer the field planes watch`);
    const fit = lineFromFields({
      xMm: fields.xMm, yMm: fields.yMm, substrateMm: 2 * (fields.copperZMm - fields.ezZMm),
      // The fit reads the first run's fields (the first excited port driven), also when the views show an array's drives.
      planes: r.fieldRuns?.[0].planes ?? fields.planes, ports: [r.ports[0], r.ports[1]],
    });
    return { ok: true, fit, fitProblem: null };
  } catch (error) {
    return { ok: true, fit: null, fitProblem: (error as Error).message };
  }
}

/** Above this the field is not one uniform line (a bend, an off-centre port, a second conductor). */
const MAX_RESIDUAL = 0.1;
/**
 * A step that comes back at least this much of itself reads as an open end:
 * 19 times the reference impedance. The chart stops there and labels it
 * "open", where the ohms would mean nothing (stepTdr's ceiling is 1999 times).
 */
const OPEN_REFLECTION = 0.9;

/** TDR traces as the chart draws them: capped at the open level, which is returned when a trace reaches it (else null). */
export function capTdrAtOpen(tracesOhm: Float64Array[], zRef: number): { shownOhm: Float64Array[]; openOhm: number | null } {
  const openOhm = (zRef * (1 + OPEN_REFLECTION)) / (1 - OPEN_REFLECTION);
  const reachesOpen = tracesOhm.some((trace) => trace.some((z) => z >= openOhm));
  return { shownOhm: tracesOhm.map((trace) => trace.map((z) => Math.min(z, openOhm))), openOhm: reachesOpen ? openOhm : null };
}
const TDR_COLORS = ['#f2a33a', '#8eaaf5'];
const facts = (rows: Array<[string, string]>) => rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');

export class LineView {
  private readonly chart: LineChart;

  constructor(canvas: HTMLCanvasElement, private readonly factsEl: HTMLElement, private readonly notesEl: HTMLElement) {
    this.chart = new LineChart(canvas);
  }

  show(r: WorkbenchResult, analysis: Extract<LineAnalysis, { ok: true }>): void {
    const zRef = r.z0[0];
    const fTop = r.s.fGHz[r.s.fGHz.length - 1];
    const lengthMm = Math.hypot(r.ports[1].xMm - r.ports[0].xMm, r.ports[1].yMm - r.ports[0].yMm);
    const epsEff = analysis.fit?.[0]?.epsEff ?? 4.4;
    // Three round trips: the line, the far port, and what rings after it.
    const durationNs = (3 * 2 * lengthMm * Math.sqrt(epsEff)) / C_MM_PER_NS;
    const fromPort = (n: 0 | 1) => stepTdr(r.s.fGHz, r.s.re[n][n]!, r.s.im[n][n]!, zRef, durationNs);
    const tdr = [fromPort(0), fromPort(1)];
    const { shownOhm, openOhm } = capTdrAtOpen(tdr.map((t) => t.zOhm), zRef);
    const traces: Trace[] = tdr.map((t, n) => ({ name: `From ${r.portIds[n]}`, color: TDR_COLORS[n], dashed: n === 1, x: t.tNs, y: shownOhm[n] }));
    const roundTripNs = (2 * lengthMm * Math.sqrt(epsEff)) / C_MM_PER_NS;
    // At least 10 ohm either side of the reference, so a near-match does not fill the chart with a few ohms of ripple.
    let [lo, hi] = [zRef - 10, zRef + 10];
    for (const trace of shownOhm) for (const z of trace) [lo, hi] = [Math.min(lo, z), Math.max(hi, z)];
    const [yMin, yMax] = [Math.floor(lo / 5) * 5, Math.ceil(hi / 5) * 5];
    this.chart.set({
      traces, yUnit: 'Ω', xUnit: 'ns', yMin, yMax,
      rules: [{ y: zRef, label: `${zRef} Ω` }, ...(openOhm === null ? [] : [{ y: openOhm, label: 'open' }])],
      markers: analysis.fit ? [{ x: Number(roundTripNs.toFixed(3)), label: 'Far port' }] : [],
    });

    const rows: Array<[string, string]> = [];
    const notes: string[] = [];
    const worst = analysis.fit ? Math.max(...analysis.fit.map((f) => f.residual)) : Infinity;
    if (analysis.fit && worst <= MAX_RESIDUAL) {
      for (const f of analysis.fit) rows.push([`At ${f.fGHz} GHz`, `Z0 ${f.z0.toFixed(1)} Ω, εeff ${f.epsEff.toFixed(3)}`]);
      const first = analysis.fit[0];
      rows.push(['Fitted over', `${(first.toMm - first.fromMm).toFixed(1)} mm of the ${lengthMm.toFixed(1)} mm line, ${withMinus(first.fromMm.toFixed(1))} to ${withMinus(first.toMm.toFixed(1))} mm`]);
      rows.push(['Fit residual', `${(100 * worst).toFixed(1)} %`]);
      notes.push('Z0 and εeff come from the field along the middle of the strip, away from the ports, so the lumped port connections do not enter them. ' +
        'Loss is not shown: over a window this short it is below what the fit can resolve.');
    } else if (analysis.fit) {
      rows.push(['Z0 and εeff', `Not shown: the field does not follow a single uniform line (residual ${(100 * worst).toFixed(0)} %). Check that both ports sit on the center line of one straight strip.`]);
    } else {
      rows.push(['Z0 and εeff', `Not available: ${analysis.fitProblem}.`]);
    }
    rows.push(['TDR rise time', `${tdr[0].riseTimePs.toFixed(0)} ps, set by the ${fTop} GHz top of the band`]);
    notes.push('The TDR is computed from S11 and S22 and includes the ports: the steps at either end are the port connections.');
    const f = r.s.fGHz;
    const df = (f[f.length - 1] - f[0]) / (f.length - 1);
    if (f[0] > 2 * df) {
      notes.push(`The band starts at ${f[0]} GHz, so the TDR level is extrapolated towards DC and can be several ohms off; its shape and timing hold. ` +
        'For a true level, start the band one frequency step above DC.');
    }
    this.factsEl.innerHTML = facts(rows);
    this.notesEl.innerHTML = notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
  }
}
