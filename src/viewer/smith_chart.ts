import type { Spectrum } from '../engine/port_dft';
import { fmtOhms } from '../ui/format';

const GRID_LINE = 'rgba(255, 255, 255, 0.12)';
const AXIS_TEXT = '#9ba3af';

export interface SmithChartOptions {
  traceColor: string;
  referenceOhms: number;
  /** Draws the |S11| circle for this return loss (dB), e.g. -15. */
  goalDb?: number;
}

/**
 * Impedance Smith chart of Z_in across the band. Grid: resistance circles
 * r = 0, 0.2, 0.5, 1, 2, 5 and reactance arcs x = ±0.2, 0.5, 1, 2, 5. The
 * target frequency is marked and labelled with its impedance in ohms.
 */
export function drawSmith(canvas: HTMLCanvasElement, spec: Spectrum, targetGHz: number, options: SmithChartOptions): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Smith chart: 2D canvas context unavailable');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const radius = Math.min(width, height) / 2 - 14;
  const cx = width / 2;
  const cy = height / 2;
  const toCanvas = (gRe: number, gIm: number): [number, number] => [cx + gRe * radius, cy - gIm * radius];

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.lineWidth = 1;
  ctx.strokeStyle = GRID_LINE;
  for (const r of [0, 0.2, 0.5, 1, 2, 5]) {
    // Constant-resistance circle: centre (r/(1+r), 0), radius 1/(1+r).
    const [x, y] = toCanvas(r / (1 + r), 0);
    ctx.beginPath();
    ctx.arc(x, y, radius / (1 + r), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const xr of [0.2, 0.5, 1, 2, 5]) {
    for (const sign of [1, -1]) {
      // Constant-reactance arc: centre (1, 1/x), radius 1/x.
      const [x, y] = toCanvas(1, sign / xr);
      ctx.beginPath();
      ctx.arc(x, y, radius / xr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.beginPath();
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.stroke();
  ctx.restore();

  // Normalised resistance values where each circle crosses the real axis.
  ctx.font = '11px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillStyle = AXIS_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const r of [0.2, 0.5, 1, 2, 5]) ctx.fillText(String(r), toCanvas((r - 1) / (r + 1), 0)[0], cy + 3);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  if (options.goalDb !== undefined) {
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 10 ** (options.goalDb / 20), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const z0 = options.referenceOhms;
  const gamma = (m: number): [number, number] => {
    const zr = spec.zRe[m] / z0;
    const zi = spec.zIm[m] / z0;
    // (z - 1) / (z + 1)
    const den = (zr + 1) ** 2 + zi ** 2;
    return [(zr * zr + zi * zi - 1) / den, (2 * zi) / den];
  };

  ctx.strokeStyle = options.traceColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let m = 0; m < spec.fGHz.length; m++) {
    const [x, y] = toCanvas(...gamma(m));
    if (m === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  let atTarget = 0;
  for (let m = 1; m < spec.fGHz.length; m++) {
    if (Math.abs(spec.fGHz[m] - targetGHz) < Math.abs(spec.fGHz[atTarget] - targetGHz)) atTarget = m;
  }
  const [mx, my] = toCanvas(...gamma(atTarget));
  ctx.fillStyle = options.traceColor;
  ctx.beginPath();
  ctx.arc(mx, my, 4, 0, Math.PI * 2);
  ctx.fill();

  // Marker readout in the top-left corner so it never covers the grid labels or the trace.
  ctx.font = '12px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillStyle = '#e9ebef';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${targetGHz} GHz`, 4, 4);
  ctx.fillText(fmtOhms(spec.zRe[atTarget], spec.zIm[atTarget]), 4, 20);
  ctx.fillStyle = AXIS_TEXT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`Z₀ = ${z0} Ω`, 4, height - 4);
}
