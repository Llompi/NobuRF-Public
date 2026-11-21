import type { PortSpectrum } from '../engine/port_dft';
import { fmtDb } from '../ui/format';

export interface S11ChartOptions {
  /** Colour of the current trace. */
  traceColor: string;
  /** Draws a dashed goal line at this level (dB), e.g. -15. */
  goalDb?: number;
}

const AXIS_TEXT = '#9ba3af';
const GRID_LINE = 'rgba(255, 255, 255, 0.07)';
const DB_FLOOR = -30;

/**
 * S11 against frequency, drawn like a network-analyser trace: thin grid,
 * dB axis on the left, the target frequency and goal level as dashed rules,
 * earlier iterations as faint grey traces, and the current trace on top with
 * its deepest point labelled.
 */
export function drawS11(
  canvas: HTMLCanvasElement,
  spec: PortSpectrum,
  targetGHz: number,
  history: PortSpectrum[] = [],
  { traceColor, goalDb }: S11ChartOptions,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('S11 chart: 2D canvas context unavailable');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return; // not laid out yet; the resize handler redraws
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);

  const pad = { left: 44, right: 10, top: 30, bottom: 24 };
  const fFirst = spec.fGHz[0];
  const fLast = spec.fGHz[spec.fGHz.length - 1];
  const xOf = (fGHz: number) => pad.left + ((fGHz - fFirst) / (fLast - fFirst)) * (width - pad.left - pad.right);
  const yOf = (db: number) => pad.top + (Math.max(DB_FLOOR, Math.min(0, db)) / DB_FLOOR) * (height - pad.top - pad.bottom);

  ctx.clearRect(0, 0, width, height);
  ctx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID_LINE;
  ctx.fillStyle = AXIS_TEXT;
  for (let db = 0; db >= DB_FLOOR; db -= 10) {
    ctx.beginPath();
    ctx.moveTo(pad.left, yOf(db));
    ctx.lineTo(width - pad.right, yOf(db));
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(db === 0 ? '0 dB' : `−${-db}`, pad.left - 8, yOf(db));
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const lastLabel = `${fLast.toFixed(1)} GHz`;
  const lastLabelLeft = width - pad.right - ctx.measureText(lastLabel).width;
  for (let f = Math.ceil(fFirst * 2) / 2; f < fLast - 1e-9; f += 0.5) {
    const label = f.toFixed(1);
    const labelRight = xOf(f) + ctx.measureText(label).width / 2;
    if (labelRight + 6 < lastLabelLeft) ctx.fillText(label, xOf(f), height - 6);
  }
  ctx.textAlign = 'right';
  ctx.fillText(lastLabel, width - pad.right, height - 6);

  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.beginPath();
  ctx.moveTo(xOf(targetGHz), pad.top);
  ctx.lineTo(xOf(targetGHz), height - pad.bottom);
  if (goalDb !== undefined) {
    ctx.moveTo(pad.left, yOf(goalDb));
    ctx.lineTo(width - pad.right, yOf(goalDb));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  const tracePath = (s: PortSpectrum) => {
    ctx.beginPath();
    s.fGHz.forEach((f, m) => (m === 0 ? ctx.moveTo(xOf(f), yOf(s.s11Db[m])) : ctx.lineTo(xOf(f), yOf(s.s11Db[m]))));
  };

  const earlier = history.filter((s) => s !== spec).slice(-4);
  earlier.forEach((s, n) => {
    tracePath(s);
    ctx.strokeStyle = `rgba(154, 163, 178, ${0.15 + (0.25 * (n + 1)) / earlier.length})`;
    ctx.stroke();
  });

  tracePath(spec);
  ctx.strokeStyle = traceColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  let deepest = 0;
  for (let m = 1; m < spec.s11Db.length; m++) if (spec.s11Db[m] < spec.s11Db[deepest]) deepest = m;
  const markerX = xOf(spec.fGHz[deepest]);
  const markerY = yOf(spec.s11Db[deepest]);
  ctx.fillStyle = traceColor;
  ctx.beginPath();
  ctx.arc(markerX, markerY, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Marker readout above the plot area, as on a network analyser, so it never covers the trace.
  ctx.fillStyle = '#e9ebef';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`Min ${fmtDb(spec.s11Db[deepest])} at ${spec.fGHz[deepest].toFixed(2)} GHz`, width - pad.right, 2);
}
