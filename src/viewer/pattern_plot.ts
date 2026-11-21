/**
 * Radiation-pattern cuts as a standalone SVG: the E-plane and H-plane side by
 * side, each a polar plot in dBi with the co-polar trace solid and the
 * cross-polar trace dashed (Ludwig 3). Pure string output, so the CLI writes it
 * into the results bundle and the browser can drop it into the page.
 *
 * Polar convention as on antenna ranges and in commercial solvers: theta = 0
 * (broadside, +z) at the top, positive theta clockwise toward the plane's phi,
 * negative theta toward phi + 180, theta = 180 (behind the ground) at the bottom.
 * The radius is directivity in dBi over a fixed 40 dB span below a top ring
 * rounded up to 5 dB; anything lower sits on the centre.
 */
import { planeCut, polarisedDirectivity, toDb, type FarFieldPattern, type PlaneCut, type PolarisationAxis } from '../engine/far_field_pattern';

const RANGE_DB = 40;
const RING_STEP_DB = 10;
const SPOKE_STEP_DEG = 30;

const PANEL = 360;
const RADIUS = 132;
const HEADER = 84;
const FOOTER = 56;

export interface PatternPlotInput {
  pattern: FarFieldPattern;
  frequencyGHz: number;
  polarisation: PolarisationAxis;
  /** One line under the title, e.g. the project name and what the numbers are. */
  caption: string;
}

const fmt = (x: number, digits = 1) => (x < 0 ? '−' : '') + Math.abs(x).toFixed(digits);
const escapeXml = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

interface Trace {
  name: string;
  cssClass: string;
  cut: PlaneCut;
}

function polarPanel(title: string, traces: Trace[], topDb: number, originX: number): string {
  const cx = originX + PANEL / 2;
  const cy = HEADER + PANEL / 2;
  const radiusOf = (db: number) => (RADIUS * Math.max(0, db - (topDb - RANGE_DB))) / RANGE_DB;
  const point = (angleDeg: number, db: number): [number, number] => {
    const a = (angleDeg * Math.PI) / 180;
    const r = radiusOf(db);
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  const parts: string[] = [];
  const ringLabels: string[] = [];
  parts.push(`<text class="panel-title" x="${cx}" y="${HEADER - 4}" text-anchor="middle">${escapeXml(title)}</text>`);
  // Rings, labelled between the 0 and 30 degree spokes; the labels go on top
  // of the traces with a halo so a trace never hides them.
  for (let db = topDb; db >= topDb - RANGE_DB + 1e-9; db -= RING_STEP_DB) {
    parts.push(`<circle class="grid${db === topDb ? ' grid-outer' : ''}" cx="${cx}" cy="${cy}" r="${radiusOf(db).toFixed(2)}"/>`);
    const [lx, ly] = point(15, db);
    ringLabels.push(`<text class="tick ring-label" x="${(lx + 3).toFixed(2)}" y="${(ly + 4).toFixed(2)}">${fmt(db, 0)}</text>`);
  }
  for (let angle = -180 + SPOKE_STEP_DEG; angle <= 180; angle += SPOKE_STEP_DEG) {
    const [x, y] = point(angle, topDb);
    parts.push(`<line class="grid" x1="${cx}" y1="${cy}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}"/>`);
    const a = (angle * Math.PI) / 180;
    const [lx, ly] = [cx + (RADIUS + 16) * Math.sin(a), cy - (RADIUS + 16) * Math.cos(a)];
    const anchor = Math.abs(Math.sin(a)) < 0.2 ? 'middle' : Math.sin(a) > 0 ? 'start' : 'end';
    parts.push(`<text class="tick" x="${lx.toFixed(2)}" y="${(ly + 4).toFixed(2)}" text-anchor="${anchor}">${angle === 180 ? '180' : fmt(angle, 0)}°</text>`);
  }
  for (const t of traces) {
    const d = Array.from(t.cut.angleDeg, (angle, i) => {
      const [x, y] = point(angle, toDb(t.cut.value[i]));
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }).join(' ');
    parts.push(`<path class="trace ${t.cssClass}" d="${d}"/>`);
  }
  parts.push(...ringLabels);
  // Hover targets: one per angle, larger than the line, listing both traces.
  const angles = traces[0].cut.angleDeg;
  for (let i = 0; i < angles.length; i++) {
    const strongest = Math.max(...traces.map((t) => toDb(t.cut.value[i])));
    const [x, y] = point(angles[i], strongest);
    const floorDb = topDb - RANGE_DB;
    const reading = (db: number) => (db < floorDb ? `below ${fmt(floorDb, 0)}` : fmt(db));
    const lines = traces.map((t) => `${t.name} ${reading(toDb(t.cut.value[i]))} dBi`).join(', ');
    parts.push(`<circle class="hit" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="6"><title>θ ${fmt(angles[i], 0)}°: ${lines}</title></circle>`);
  }
  return parts.join('\n');
}

/** Both principal-plane cuts as one SVG document. */
export function patternCutsSvg({ pattern, frequencyGHz, polarisation, caption }: PatternPlotInput): string {
  const { co, cross } = polarisedDirectivity(pattern, polarisation);
  const ePhi = polarisation === 'x' ? 0 : 90;
  const hPhi = polarisation === 'x' ? 90 : 0;
  let peak = -Infinity;
  for (let n = 0; n < co.length; n++) peak = Math.max(peak, toDb(co[n] + cross[n]));
  const topDb = Math.ceil(peak / 5) * 5;
  const traces = (phi: number): Trace[] => [
    { name: 'Co-polar', cssClass: 'co', cut: planeCut(pattern, co, phi) },
    { name: 'Cross-polar', cssClass: 'cross', cut: planeCut(pattern, cross, phi) },
  ];
  const width = 2 * PANEL;
  const height = HEADER + PANEL + FOOTER;
  const legendY = HEADER + PANEL + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
  aria-label="Radiation pattern at ${frequencyGHz} GHz: E-plane and H-plane cuts, co- and cross-polar directivity in dBi">
<style>
  svg { --surface: #ffffff; --text: #16191d; --muted: #5b6470; --grid: rgba(0, 0, 0, 0.12); --co: #b5650a; --cross: #3d63c7; }
  @media (prefers-color-scheme: dark) {
    svg { --surface: #0d0f12; --text: #e9ebef; --muted: #9ba3af; --grid: rgba(255, 255, 255, 0.12); --co: #cc7e1a; --cross: #6688e0; }
  }
  .bg { fill: var(--surface); }
  text { font-family: 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif; fill: var(--muted); }
  .title { font-size: 16px; font-weight: 600; fill: var(--text); }
  .caption { font-size: 12px; }
  .panel-title { font-size: 14px; font-weight: 600; fill: var(--text); }
  .tick { font-family: 'Inter', system-ui, sans-serif; font-variant-numeric: tabular-nums; font-size: 11px; }
  .ring-label { paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; }
  .legend { font-size: 12px; fill: var(--text); }
  .grid { fill: none; stroke: var(--grid); stroke-width: 1; }
  .grid-outer { stroke-width: 1.5; }
  .trace { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .co { stroke: var(--co); }
  .cross { stroke: var(--cross); stroke-dasharray: 6 4; }
  .hit { fill: transparent; stroke: none; }
  .hit:hover { fill: var(--text); fill-opacity: 0.25; }
</style>
<rect class="bg" width="${width}" height="${height}"/>
<text class="title" x="16" y="24">Radiation pattern, ${frequencyGHz} GHz</text>
<text class="caption" x="16" y="42">${escapeXml(caption)}</text>
${polarPanel(`E-plane (φ = ${ePhi}°)`, traces(ePhi), topDb, 0)}
${polarPanel(`H-plane (φ = ${hPhi}°)`, traces(hPhi), topDb, PANEL)}
<line class="trace co" x1="${width / 2 - 170}" y1="${legendY}" x2="${width / 2 - 146}" y2="${legendY}"/>
<text class="legend" x="${width / 2 - 140}" y="${legendY + 4}">Co-polar (${polarisation}), solid</text>
<line class="trace cross" x1="${width / 2 + 20}" y1="${legendY}" x2="${width / 2 + 44}" y2="${legendY}"/>
<text class="legend" x="${width / 2 + 50}" y="${legendY + 4}">Cross-polar, dashed</text>
<text class="caption" x="16" y="${height - 12}">Directivity in dBi, Ludwig-3 polarisation. θ from broadside (+z); negative θ is the half plane at φ + 180°.</text>
</svg>
`;
}
