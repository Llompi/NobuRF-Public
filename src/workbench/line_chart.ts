/**
 * Line chart for the result views (|S| in dB and Z in ohms against
 * frequency, a TDR trace against time), drawn like a network analyser:
 * hairline grid, labelled axes, one colour per trace with its name at the
 * right end, and a marker readout that follows the pointer.
 */
import { withMinus } from '../ui/format';

/**
 * Smallest and largest of the values, by a loop: a chart can hold traces x frequencies points (160k for a
 * 4-port at 10,000 frequencies), more arguments than Math.min(...values) can take. NaN values are skipped.
 */
export function extent(values: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let n = 0; n < values.length; n++) {
    if (values[n] < lo) lo = values[n];
    if (values[n] > hi) hi = values[n];
  }
  return [lo, hi];
}

export interface Trace {
  name: string;
  color: string;
  dashed?: boolean;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
}

export interface ChartSpec {
  traces: Trace[];
  yUnit: string;
  /** Unit of the x axis; default GHz. */
  xUnit?: string;
  /** Fixed y range; otherwise from the data, padded and rounded to the tick step. */
  yMin?: number;
  yMax?: number;
  /** Horizontal reference lines, e.g. -10 dB. */
  rules?: Array<{ y: number; label: string }>;
  /** Vertical reference lines, e.g. the design frequency. */
  markers?: Array<{ x: number; label: string }>;
}

const AXIS_TEXT = '#9ba3af';
const GRID = 'rgba(255, 255, 255, 0.07)';
const RULE = 'rgba(255, 255, 255, 0.32)';
const FONT = '12px Inter, system-ui, sans-serif';

function niceStep(span: number, targetTicks: number): number {
  const raw = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const f = raw / magnitude;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * magnitude;
}

const fmt = (v: number, step: number) => withMinus(v.toFixed(Math.max(0, -Math.floor(Math.log10(step) + 1e-9))));

export class LineChart {
  private spec: ChartSpec | null = null;
  private hoverX: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointermove', (e) => {
      this.hoverX = e.offsetX;
      this.draw();
    });
    canvas.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(spec: ChartSpec): void {
    this.spec = spec;
    this.draw();
  }

  draw(): void {
    const spec = this.spec;
    const canvas = this.canvas;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!spec || width === 0 || height === 0 || spec.traces.length === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.font = FONT;

    const xs = spec.traces.flatMap((t) => Array.from(t.x));
    const ys = spec.traces.flatMap((t) => Array.from(t.y)).filter(Number.isFinite);
    const [x0, x1] = extent(xs);
    const [yLo, yHi] = extent(ys);
    let [y0, y1] = [spec.yMin ?? yLo, spec.yMax ?? yHi];
    if (y1 - y0 < 1e-9) [y0, y1] = [y0 - 1, y1 + 1];
    const yStep = niceStep(y1 - y0, 6);
    if (spec.yMin === undefined) y0 = Math.floor(y0 / yStep) * yStep;
    if (spec.yMax === undefined) y1 = Math.ceil(y1 / yStep) * yStep;

    const labelWidth = Math.max(...spec.traces.map((t) => ctx.measureText(t.name).width)) + 12;
    const pad = { left: 52, right: Math.max(16, labelWidth), top: 28, bottom: 30 };
    const px = (x: number) => pad.left + ((x - x0) / (x1 - x0)) * (width - pad.left - pad.right);
    const py = (y: number) => pad.top + (1 - (Math.max(y0, Math.min(y1, y)) - y0) / (y1 - y0)) * (height - pad.top - pad.bottom);
    ctx.clearRect(0, 0, width, height);

    // Grid and axes.
    ctx.lineWidth = 1;
    ctx.textBaseline = 'middle';
    for (let y = y0; y <= y1 + yStep / 2; y += yStep) {
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(pad.left, Math.round(py(y)) + 0.5);
      ctx.lineTo(width - pad.right, Math.round(py(y)) + 0.5);
      ctx.stroke();
      ctx.fillStyle = AXIS_TEXT;
      ctx.textAlign = 'right';
      ctx.fillText(fmt(y, yStep), pad.left - 8, py(y));
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(spec.yUnit, 4, 6);
    const xStep = niceStep(x1 - x0, Math.max(3, Math.floor((width - pad.left - pad.right) / 90)));
    ctx.textAlign = 'center';
    for (let x = Math.ceil(x0 / xStep) * xStep; x <= x1 + 1e-9; x += xStep) {
      ctx.strokeStyle = GRID;
      ctx.beginPath();
      ctx.moveTo(Math.round(px(x)) + 0.5, pad.top);
      ctx.lineTo(Math.round(px(x)) + 0.5, height - pad.bottom);
      ctx.stroke();
      ctx.fillStyle = AXIS_TEXT;
      ctx.fillText(fmt(x, xStep), px(x), height - pad.bottom + 8);
    }
    ctx.textAlign = 'right';
    ctx.fillText(spec.xUnit ?? 'GHz', width - 4, height - pad.bottom + 8);

    // Reference lines.
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = RULE;
    ctx.fillStyle = AXIS_TEXT;
    ctx.textBaseline = 'bottom';
    for (const rule of spec.rules ?? []) {
      if (rule.y < y0 || rule.y > y1) continue;
      ctx.beginPath();
      ctx.moveTo(pad.left, py(rule.y));
      ctx.lineTo(width - pad.right, py(rule.y));
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillText(rule.label, pad.left + 4, py(rule.y) - 2);
    }
    // Labels sit in rows at the foot; a label that would run into the one before it (0.48 GHz next to 1 GHz)
    // goes up a row instead of printing over it. Rows stop at half the plot height: past that a label is left
    // out (its line stays), rather than climbing over the traces.
    const rowEnds: number[] = [];
    const rowHeight = 14;
    const maxRows = Math.max(1, Math.floor((height - pad.top - pad.bottom) / 2 / rowHeight));
    const plotRight = width - pad.right;
    const seen = new Set<number>();
    const markers = (spec.markers ?? []).filter((m) => Number.isFinite(m.x) && m.x >= x0 && m.x <= x1 && !seen.has(m.x) && seen.add(m.x));
    for (const marker of markers.sort((a, b) => a.x - b.x)) {
      ctx.beginPath();
      ctx.moveTo(px(marker.x), pad.top);
      ctx.lineTo(px(marker.x), height - pad.bottom);
      ctx.stroke();
      // Inside the plot at the foot, clear of the pointer readout along the top. A label that would run past
      // the plot's right edge (into the trace names) goes on the left of its line.
      const w = ctx.measureText(marker.label).width;
      const left = px(marker.x) + 4 + w > plotRight ? px(marker.x) - 4 - w : px(marker.x) + 4;
      let row = rowEnds.findIndex((end) => left > end + 4);
      if (row < 0) row = rowEnds.length;
      if (row >= maxRows) continue;
      rowEnds[row] = left + w;
      ctx.textAlign = 'left';
      ctx.fillText(marker.label, left, height - pad.bottom - 6 - row * rowHeight);
    }
    ctx.setLineDash([]);

    // Traces, each named at its right end.
    ctx.lineJoin = 'round';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labelYs: number[] = [];
    for (const t of spec.traces) {
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(t.dashed ? [6, 4] : []);
      ctx.beginPath();
      let started = false;
      for (let n = 0; n < t.x.length; n++) {
        if (!Number.isFinite(t.y[n])) {
          started = false;
          continue;
        }
        (started ? ctx.lineTo : ctx.moveTo).call(ctx, px(t.x[n]), py(t.y[n]));
        started = true;
      }
      ctx.stroke();
      let labelY = py(t.y[t.y.length - 1]);
      for (const used of labelYs) if (Math.abs(labelY - used) < 14) labelY = used + 14;
      labelYs.push(labelY);
      ctx.fillStyle = t.color;
      ctx.fillText(t.name, width - pad.right + 6, labelY);
    }
    ctx.setLineDash([]);

    // Pointer readout: a vertical line and every trace's value there.
    if (this.hoverX !== null && this.hoverX >= pad.left && this.hoverX <= width - pad.right) {
      const x = x0 + ((this.hoverX - pad.left) / (width - pad.left - pad.right)) * (x1 - x0);
      ctx.strokeStyle = 'rgba(233, 235, 239, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.hoverX + 0.5, pad.top);
      ctx.lineTo(this.hoverX + 0.5, height - pad.bottom);
      ctx.stroke();
      let sampleX = x;
      const parts = spec.traces.map((t) => {
        let n = 0;
        for (let m = 1; m < t.x.length; m++) if (Math.abs(t.x[m] - x) < Math.abs(t.x[n] - x)) n = m;
        sampleX = t.x[n];
        ctx.fillStyle = t.color;
        ctx.beginPath();
        ctx.arc(px(t.x[n]), py(t.y[n]), 3.5, 0, Math.PI * 2);
        ctx.fill();
        return `${t.name} ${withMinus(t.y[n].toFixed(2))}`;
      });
      ctx.fillStyle = '#e9ebef';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`${sampleX.toFixed(3)} ${spec.xUnit ?? 'GHz'}   ${parts.join('   ')}`, width - pad.right, 4);
    }
  }
}
