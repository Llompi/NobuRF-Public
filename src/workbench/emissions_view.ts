/**
 * The Emissions view: a near-field scan of the board, drawn like an EMC
 * scanner's map (field strength in dB over the board, copper outlined), and
 * the field strength at 3 m and 10 m from the far-field transform, against
 * the FCC Part 15 radiated limits. Both scale with a drive power set here,
 * so changing it never needs a new solve.
 */
import { dbMicroampPerMetre, dbMicrovoltPerMetre, driveScale, FCC_CLASS_A_10M, FCC_CLASS_B_3M, limitAt, type RadiatedLimit } from '../engine/emc';
import type { ScanPlane } from '../engine/near_field';
import { escapeHtml, withMinus } from '../ui/format';
import { MAGNITUDE_SCALE, srgbLut } from '../viewer/colormap';
import type { FieldMaps, WorkbenchResult } from './solve';

export const SCAN_QUANTITIES = ['h', 'e', 'hx', 'hy', 'hz', 'ex', 'ey', 'ez'] as const;
export type ScanQuantity = (typeof SCAN_QUANTITIES)[number];

const QUANTITY_LABELS: Record<ScanQuantity, string> = {
  h: '|H|', e: '|E|', hx: '|Hx|', hy: '|Hy|', hz: '|Hz|', ex: '|Ex|', ey: '|Ey|', ez: '|Ez|',
};

/** dB below the map's peak where the colour scale bottoms out. */
export const MAP_RANGE_DB = 40;

const LUT = srgbLut(MAGNITUDE_SCALE);
const AXIS_TEXT = '#9ba3af';
const FONT = '12px Inter, system-ui, sans-serif';
const COPPER_OUTLINE = 'rgba(255, 255, 255, 0.75)';

const isMagneticQuantity = (q: ScanQuantity) => q[0] === 'h';
export const quantityUnit = (q: ScanQuantity) => (isMagneticQuantity(q) ? 'dBµA/m' : 'dBµV/m');

/**
 * The quantity in dB(µA/m) or dB(µV/m) RMS at every node, for the drive
 * scale `scale`. Vector magnitudes are the root sum of squares of the three
 * components' magnitudes. -Infinity where the field is exactly zero.
 */
export function scanDb(plane: ScanPlane, quantity: ScanQuantity, scale: number): Float64Array {
  const parts = quantity === 'h' ? (['hx', 'hy', 'hz'] as const) : quantity === 'e' ? (['ex', 'ey', 'ez'] as const) : [quantity];
  const toDb = isMagneticQuantity(quantity) ? dbMicroampPerMetre : dbMicrovoltPerMetre;
  const n = plane.ex.re.length;
  const out = new Float64Array(n);
  for (let node = 0; node < n; node++) {
    let sum = 0;
    for (const c of parts) sum += plane[c].re[node] ** 2 + plane[c].im[node] ** 2;
    out[node] = toDb(scale * Math.sqrt(sum));
  }
  return out;
}

/**
 * The nodes whose scan stencil (one node either side) stays out of the PML and
 * off the grid edge, so every value there is the solver's free-space field.
 */
export function scanWindow(fields: Pick<FieldMaps, 'xMm' | 'yMm' | 'pml'>) {
  return {
    i0: fields.pml.xLow + 1, i1: fields.xMm.length - 2 - fields.pml.xHigh,
    j0: fields.pml.yLow + 1, j1: fields.yMm.length - 2 - fields.pml.yHigh,
  };
}

export interface DistanceRow {
  frequencyGHz: number;
  distanceM: number;
  dbMicrovoltPerMetre: number;
  limit: RadiatedLimit;
  limitDb: number | null;
}

/** E at 3 m and 10 m for each far-field frequency, with the FCC limit for that distance. */
export function distanceRows(r: WorkbenchResult, driveDbm: number): DistanceRow[] {
  if (!r.farField) return [];
  const scale = driveScale(driveDbm, r.z0[r.excited[0]]);
  return r.farField.entries.flatMap((entry) => {
    const frequencyGHz = entry.result.frequencyHz / 1e9;
    return ([[3, entry.fieldAt3mVPerM, FCC_CLASS_B_3M], [10, entry.fieldAt10mVPerM, FCC_CLASS_A_10M]] as const).map(([distanceM, e, limit]) => ({
      frequencyGHz, distanceM, dbMicrovoltPerMetre: dbMicrovoltPerMetre(scale * e), limit, limitDb: limitAt(limit, frequencyGHz * 1000),
    }));
  });
}

/** EIRP in dBm at the far field's peak for the drive: 4 pi U_max, where U_max = gain * accepted power / (4 pi). */
export function eirpDbm(r: WorkbenchResult, entryIndex: number, driveDbm: number): number {
  const f = r.farField!.entries[entryIndex].result;
  const scale = driveScale(driveDbm, r.z0[r.excited[0]]);
  const eirpW = 10 ** (f.peakGainDbi / 10) * f.acceptedPowerW * scale * scale;
  return 10 * Math.log10(eirpW / 1e-3);
}

const fmtDb = (x: number) => withMinus(x.toFixed(1));
const facts = (rows: Array<[string, string]>) => rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');

function niceStep(span: number, targetTicks: number): number {
  const raw = span / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const f = raw / magnitude;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * magnitude;
}

/** Index n and weight w with lines[n] <= x <= lines[n + 1] and x = (1 - w) lines[n] + w lines[n + 1], within [lo, hi]. */
function bracket(lines: Float64Array, lo: number, hi: number, x: number): [number, number] {
  let n = lo;
  while (n + 1 < hi && lines[n + 1] < x) n++;
  const w = (x - lines[n]) / (lines[n + 1] - lines[n]);
  return [n, Math.min(1, Math.max(0, w))];
}

export class EmissionsView {
  private result: WorkbenchResult | null = null;
  private heightIndex = 0;
  private frequencyIndex = 0;
  private quantity: ScanQuantity = 'h';
  private driveDbm = 0;
  private hover: { x: number; y: number } | null = null;

  constructor(private readonly el: {
    map: HTMLCanvasElement; mapArea: HTMLElement; empty: HTMLElement;
    height: HTMLSelectElement; frequency: HTMLSelectElement; quantity: HTMLSelectElement; drive: HTMLInputElement;
    facts: HTMLElement; notes: HTMLElement;
  }) {
    el.quantity.innerHTML = SCAN_QUANTITIES.map((q) => `<option value="${q}">${QUANTITY_LABELS[q]}</option>`).join('');
    el.height.addEventListener('change', () => this.set({ heightIndex: Number(el.height.value) }));
    el.frequency.addEventListener('change', () => this.set({ frequencyIndex: Number(el.frequency.value) }));
    el.quantity.addEventListener('change', () => this.set({ quantity: el.quantity.value as ScanQuantity }));
    el.drive.addEventListener('input', () => {
      const v = el.drive.valueAsNumber;
      el.drive.setAttribute('aria-invalid', String(!Number.isFinite(v)));
      if (Number.isFinite(v)) this.set({ driveDbm: v });
    });
    el.map.addEventListener('pointermove', (e) => {
      this.hover = { x: e.offsetX, y: e.offsetY };
      this.draw();
    });
    el.map.addEventListener('pointerleave', () => {
      this.hover = null;
      this.draw();
    });
    new ResizeObserver(() => this.draw()).observe(el.map);
  }

  show(r: WorkbenchResult): void {
    this.result = r;
    this.cache = null;
    this.heightIndex = 0;
    this.frequencyIndex = 0;
    const scans = r.nearField ?? [];
    this.el.height.innerHTML = scans.map((s, n) => `<option value="${n}">${s.meshHeightMm.toFixed(2)} mm</option>`).join('');
    this.el.frequency.innerHTML = (r.fields?.planes ?? []).map((p, n) => `<option value="${n}">${p.frequencyGHz} GHz</option>`).join('');
    for (const control of [this.el.height, this.el.frequency, this.el.quantity]) control.disabled = scans.length === 0;
    this.el.mapArea.hidden = scans.length === 0;
    this.el.empty.hidden = scans.length > 0;
    this.el.empty.textContent = 'No near-field scan in this solve. Add heights under Outputs, "Near-field scan at", and solve again to map the field over the board.';
    this.render();
  }

  private set(change: { heightIndex?: number; frequencyIndex?: number; quantity?: ScanQuantity; driveDbm?: number }): void {
    Object.assign(this, change);
    this.render();
  }

  private render(): void {
    this.draw();
    this.renderFacts();
  }

  /** The map's values for the current choices; kept between draws so pointer moves only redraw. */
  private cache: { key: string; db: Float64Array; linear: Float64Array } | null = null;

  private current() {
    const r = this.result;
    const scan = r?.nearField?.[this.heightIndex];
    if (!r || !scan || !r.fields) return null;
    const plane = scan.planes[this.frequencyIndex];
    const key = [this.heightIndex, this.frequencyIndex, this.quantity, this.driveDbm].join('|');
    if (this.cache?.key !== key) {
      const db = scanDb(plane, this.quantity, driveScale(this.driveDbm, r.z0[r.excited[0]]));
      this.cache = { key, db, linear: Float64Array.from(db, (d) => 10 ** (d / 20)) };
    }
    return { r, scan, fields: r.fields, plane, db: this.cache.db, linear: this.cache.linear, window: scanWindow(r.fields) };
  }

  /** The window's strongest node: its value and position. */
  private peak(c: NonNullable<ReturnType<EmissionsView['current']>>) {
    const { i0, i1, j0, j1 } = c.window;
    const nx = c.fields.xMm.length;
    let best = i0 + nx * j0;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (c.db[i + nx * j] > c.db[best]) best = i + nx * j;
    return { db: c.db[best], xMm: c.fields.xMm[best % nx], yMm: c.fields.yMm[Math.floor(best / nx)] };
  }

  private renderFacts(): void {
    const r = this.result;
    if (!r) return;
    const rows: Array<[string, string]> = [];
    const c = this.current();
    if (c) {
      const peak = this.peak(c);
      const asked = c.scan.heightMm.toFixed(2) === c.scan.meshHeightMm.toFixed(2) ? '' : `, nearest mesh plane to ${c.scan.heightMm} mm`;
      rows.push(
        ['Scan plane', `${c.scan.meshHeightMm.toFixed(2)} mm above layer ${c.fields.copperLayer}${asked}`],
        [`Peak ${QUANTITY_LABELS[this.quantity]}`, `${fmtDb(peak.db)} ${quantityUnit(this.quantity)} at x ${peak.xMm.toFixed(1)}, y ${peak.yMm.toFixed(1)} mm`],
      );
    }
    rows.push(['Drive', `${withMinus(String(this.driveDbm))} dBm available at port ${r.portIds[r.excited[0]]} (${r.z0[r.excited[0]]} Ω source)`]);
    const distance = distanceRows(r, this.driveDbm);
    for (const row of distance) {
      const reference = row.limitDb === null ? '' : `; ref. limit ${fmtDb(row.limitDb)}, ${row.limit.name} at ${row.limit.distanceM} m`;
      rows.push([`E at ${row.distanceM} m, ${row.frequencyGHz} GHz`, `${fmtDb(row.dbMicrovoltPerMetre)} dBµV/m${reference}`]);
    }
    r.farField?.entries.forEach((entry, n) => rows.push([`EIRP, ${entry.result.frequencyHz / 1e9} GHz`, `${fmtDb(eirpDbm(r, n, this.driveDbm))} dBm`]));
    this.el.facts.innerHTML = facts(rows);
    const notes: string[] = [];
    if (r.nearField && r.fields) notes.push(`The map is the solver's field at the mesh nodes of one plane, RMS, with ${MAP_RANGE_DB} dB of color range. |E| and |H| combine all three components at each node; a real probe averages one component over its loop. White lines outline the copper on layer ${r.fields.copperLayer}.`);
    if (distance.length) {
      notes.push('Field at a distance: free space, in the direction of peak gain, from the far-field box with the full near-zone terms. A test site with a ground plane can read up to 6 dB higher.');
      notes.push('The source is the port drive, not a board\'s unintentional emission, and cables, enclosures and real noise sources are not modeled, so this is no compliance verdict. The FCC Part 15.109 limits (Class B at 3 m, Class A at 10 m, average detector above 1 GHz) are shown for reference only; CISPR limits are not included. An antenna\'s own signal falls under transmitter rules (for example 15.247), so compare EIRP there.');
    } else {
      notes.push('Field at 3 m and 10 m needs a far field: add frequencies under Outputs, "Far field at".');
    }
    this.el.notes.innerHTML = notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
  }

  draw(): void {
    const canvas = this.el.map;
    const c = this.current();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!c || width === 0 || height === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.font = FONT;

    const { i0, i1, j0, j1 } = c.window;
    const { xMm, yMm } = c.fields;
    const [x0, x1, y0, y1] = [xMm[i0], xMm[i1], yMm[j0], yMm[j1]];
    // Equal mm per pixel on both axes; room on the left and below for tick labels, on the right for the scale.
    const margin = { left: 44, right: 96, top: 26, bottom: 34 };
    if (width <= margin.left + margin.right || height <= margin.top + margin.bottom) return;
    const mmPerPx = Math.max((x1 - x0) / (width - margin.left - margin.right), (y1 - y0) / (height - margin.top - margin.bottom));
    const plotW = (x1 - x0) / mmPerPx;
    const plotH = (y1 - y0) / mmPerPx;
    const [left, top] = [margin.left, margin.top];

    const peak = this.peak(c);
    // The scale tops out at the next multiple of 10 dB above the peak, so its ticks are round numbers.
    const ceiling = Math.ceil(peak.db / 10) * 10;
    const floor = ceiling - MAP_RANGE_DB;
    const nx = xMm.length;
    // The map, bilinear between nodes in field magnitude, at device resolution.
    const pw = Math.max(1, Math.round(plotW * dpr));
    const ph = Math.max(1, Math.round(plotH * dpr));
    const image = ctx.createImageData(pw, ph);
    const columns = Array.from({ length: pw }, (_, px) => bracket(xMm, i0, i1, x0 + ((px + 0.5) / pw) * (x1 - x0)));
    const linear = c.linear;
    for (let py = 0; py < ph; py++) {
      const [j, wy] = bracket(yMm, j0, j1, y1 - ((py + 0.5) / ph) * (y1 - y0));
      for (let px = 0; px < pw; px++) {
        const [i, wx] = columns[px];
        const n = i + nx * j;
        const v = (1 - wy) * ((1 - wx) * linear[n] + wx * linear[n + 1]) + wy * ((1 - wx) * linear[n + nx] + wx * linear[n + nx + 1]);
        const t = Math.min(1, Math.max(0, (20 * Math.log10(v) - floor) / MAP_RANGE_DB));
        const lut = 3 * Math.round(t * 255);
        const o = 4 * (px + pw * py);
        image.data[o] = LUT[lut];
        image.data[o + 1] = LUT[lut + 1];
        image.data[o + 2] = LUT[lut + 2];
        image.data[o + 3] = 255;
      }
    }
    const toX = (mm: number) => left + (mm - x0) / mmPerPx;
    const toY = (mm: number) => top + (y1 - mm) / mmPerPx;
    ctx.putImageData(image, Math.round(left * dpr), Math.round(top * dpr));

    // Copper outline: a segment between each copper node and a bare neighbour, halfway between them.
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, plotW, plotH);
    ctx.clip();
    ctx.strokeStyle = COPPER_OUTLINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const mask = c.fields.copperMask;
    const half = (lines: Float64Array, n: number, side: -1 | 1) => (lines[n] + lines[n + side]) / 2;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!mask[i + nx * j]) continue;
        const [xl, xr, yb, yt] = [half(xMm, i, -1), half(xMm, i, 1), half(yMm, j, -1), half(yMm, j, 1)];
        const edge = (ax: number, ay: number, bx: number, by: number) => {
          ctx.moveTo(toX(ax), toY(ay));
          ctx.lineTo(toX(bx), toY(by));
        };
        if (!mask[i - 1 + nx * j]) edge(xl, yb, xl, yt);
        if (!mask[i + 1 + nx * j]) edge(xr, yb, xr, yt);
        if (!mask[i + nx * (j - 1)]) edge(xl, yb, xr, yb);
        if (!mask[i + nx * (j + 1)]) edge(xl, yt, xr, yt);
      }
    }
    ctx.stroke();
    ctx.restore();

    // Peak marker: a ring, so the map under it stays visible.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(toX(peak.xMm), toY(peak.yMm), 6, 0, 2 * Math.PI);
    ctx.stroke();

    // Axes in mm.
    ctx.fillStyle = AXIS_TEXT;
    const step = niceStep(Math.max(x1 - x0, y1 - y0), 6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let v = Math.ceil(x0 / step) * step; v <= x1 + 1e-9; v += step) ctx.fillText(withMinus(String(+v.toFixed(3))), toX(v), top + plotH + 6);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(y0 / step) * step; v <= y1 + 1e-9; v += step) ctx.fillText(withMinus(String(+v.toFixed(3))), left - 6, toY(v));
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('mm', left + plotW + 16, top + plotH + 6);

    // Colour scale: the ceiling at the top, MAP_RANGE_DB below at the bottom, a tick every 10 dB.
    const barX = left + plotW + 22;
    const ramp = ctx.createLinearGradient(0, top + plotH, 0, top);
    for (let n = 0; n <= 10; n++) {
      const l = 3 * Math.round((n / 10) * 255);
      ramp.addColorStop(n / 10, `rgb(${LUT[l]} ${LUT[l + 1]} ${LUT[l + 2]})`);
    }
    ctx.fillStyle = ramp;
    ctx.fillRect(barX, top, 10, plotH);
    ctx.fillStyle = AXIS_TEXT;
    ctx.textBaseline = 'middle';
    for (let d = 0; d <= MAP_RANGE_DB; d += 10) ctx.fillText(withMinus(String(ceiling - d)), barX + 16, top + (d / MAP_RANGE_DB) * plotH);
    ctx.textBaseline = 'bottom';
    ctx.fillText(quantityUnit(this.quantity), barX - 4, top - 6);

    // Title and pointer readout above the map.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e6e8eb';
    const f = c.fields.planes[this.frequencyIndex].frequencyGHz;
    let caption = `${QUANTITY_LABELS[this.quantity]}, ${c.scan.meshHeightMm.toFixed(2)} mm above layer ${c.fields.copperLayer}, ${f} GHz`;
    const p = this.hover;
    if (p && p.x >= left && p.x <= left + plotW && p.y >= top && p.y <= top + plotH) {
      const [xAt, yAt] = [x0 + (p.x - left) * mmPerPx, y1 - (p.y - top) * mmPerPx];
      const [i, wx] = bracket(xMm, i0, i1, xAt);
      const [j, wy] = bracket(yMm, j0, j1, yAt);
      const n = i + nx * j;
      const v = (1 - wy) * ((1 - wx) * linear[n] + wx * linear[n + 1]) + wy * ((1 - wx) * linear[n + nx] + wx * linear[n + nx + 1]);
      caption = `x ${withMinus(xAt.toFixed(1))}, y ${withMinus(yAt.toFixed(1))} mm: ${fmtDb(20 * Math.log10(v))} ${quantityUnit(this.quantity)}`;
    }
    ctx.fillText(caption, left, top - 8);
    this.el.map.setAttribute('aria-label', `Near-field map of ${QUANTITY_LABELS[this.quantity]} at ${c.scan.meshHeightMm.toFixed(2)} mm, ${f} GHz. Peak ${fmtDb(peak.db)} ${quantityUnit(this.quantity)} at x ${peak.xMm.toFixed(1)}, y ${peak.yMm.toFixed(1)} mm.`);
  }
}
