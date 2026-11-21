import { deembedPorts, expectedPhaseDeg, LINE_PHASE_MARGIN_DEG, lowFrequencyLineImpedance, thruLineErrorBoxes, twoPortAt, unwrappedPhase, type Abcd, type LineStandard } from '../engine/deembed';
import type { ScatteringResult } from '../engine/port_dft';
import { locateInPolygon, paint } from './rasterise';
import { resolveProject, type ResolvedProject, type Vec2 } from './resolve';
import { fail, type Project } from './schema';

/**
 * De-embedding a port from its project alone (ports[].deembed).
 *
 * A lumped port at the end of a straight feed line is a discontinuity of its
 * own: the column of cells it drives reflects and stores charge. To remove it
 * with its feed, NobuRF reads the feed from the project (which way it runs,
 * its width, the layers above and below), builds a calibration kit on the
 * same stackup, mesh and band (a thru of two feeds back to back, and lines
 * longer than it), solves the kit, and takes each port's error box from it by
 * the thru-line method (src/engine/deembed.ts). Results then refer to a plane
 * `length` along the line from the port, in the port's reference impedance.
 *
 * The kit is the feed alone, so the feed must be a uniform strip on one layer
 * with every other copper layer either solid or empty under it and around it,
 * and nothing else (copper on the strip's layer, ports, components, vias) near it.
 * Anything else is refused rather than calibrated wrongly.
 */

const C_MM_PER_NS = 299.792458;
/** The feed is electrically short (at most 30 degrees) up to the frequency where its length is a twelfth of a guided wavelength. */
const SHORT_FEED_FRACTION = 1 / 12;
/** Calibration frequencies wanted at or below that frequency, for the line impedance fit. */
const IMPEDANCE_FIT_POINTS = 6;
/** Each line standard is designed to span 25 to 155 degrees, inside the 20 to 160 degrees thruLineErrorBoxes accepts. */
const LINE_DESIGN_LOW_DEG = 25;
const LINE_DESIGN_HIGH_DEG = 155;
const MAX_LINE_STANDARDS = 4;
/**
 * The longest line standard is at least this many feed lengths: the impedance
 * fit reads it through the symmetric half of the thru, whose error (the port's
 * asymmetry) must be small next to the line itself.
 */
const IMPEDANCE_LINE_FEEDS = 2;
/** Longest extra line in a kit; lower frequencies fall back to the symmetric-half estimate. */
export const MAX_EXTRA_LINE_MM = 150;
/** Width tolerance along the feed. */
const WIDTH_TOLERANCE_MM = 1e-3;
/** The kit board reaches this many substrate heights past each strip edge (or the project board's edge, if nearer). */
const KIT_SIDE_HEIGHTS = 10;
/** No other copper on the strip's layer within this many substrate heights of the strip (at least one strip width). */
const CLEARANCE_HEIGHTS = 3;
/** Sample points per direction when checking the copper around a feed. */
const MAX_FOOTPRINT_SAMPLES = 400;
/** Kit band limits: the schema's n_freq and f_min bounds. */
const MAX_KIT_FREQUENCIES = 10_000;
const MIN_KIT_GHZ = 0.01;
/** thruLineErrorBoxes takes the wrong root once the measured line phase is 90 degrees from the guessed one; warn at half that. */
const ROOT_MISS_WARN_DEG = 45;

export type Direction = '+x' | '-x' | '+y' | '-y';
const DIRECTIONS: Direction[] = ['+x', '-x', '+y', '-y'];
const unit = (d: Direction): Vec2 => ({ '+x': [1, 0], '-x': [-1, 0], '+y': [0, 1], '-y': [0, -1] } as const)[d] as Vec2;
/** The across direction: the feed direction turned 90 degrees anticlockwise. */
const across = ([dx, dy]: Vec2): Vec2 => [-dy, dx];

/** A port's feed line as read from the project, in mm. */
export interface Feed {
  portIndex: number;
  portId: string;
  lengthMm: number;
  direction: Direction;
  signalLayer: string;
  referenceLayer: string;
  /** Other copper layers that are solid under the feed (filled in the kit). */
  solidLayers: string[];
  /** Strip edges from the port's centreline, along across(direction): [right side as negative, left side as positive]. */
  edgesMm: [number, number];
  /** Copper of the strip behind the port (0 when the port is on the strip's end). */
  overhangMm: number;
  /** Board behind the port, and to each side of the centreline, as the kit board uses them. */
  backMm: number;
  sidesMm: [number, number];
  /** Height of the strip above (or below) its reference layer. */
  heightMm: number;
  /** Largest eps_r in the stackup: an upper bound on the line's effective permittivity. */
  epsMax: number;
}

function layerHeights(r: ResolvedProject): Map<string, number> {
  const z = new Map<string, number>();
  let at = 0;
  for (const layer of r.stackup) {
    if (layer.type === 'copper') z.set(layer.name, at);
    else at += layer.thicknessMm;
  }
  return z;
}

/** How far copper continues from p along u (up to `limit`), sampled every `step` and refined by bisection. */
function reach(covered: (x: number, y: number) => boolean, p: Vec2, u: Vec2, limit: number, step: number): number {
  const at = (t: number) => covered(p[0] + u[0] * t, p[1] + u[1] * t);
  if (!at(0)) return 0;
  let inside = 0;
  for (let t = step; t <= limit + 1e-12; t += step) {
    if (!at(Math.min(t, limit))) {
      let lo = inside;
      let hi = Math.min(t, limit);
      while (hi - lo > 1e-6) {
        const mid = (lo + hi) / 2;
        if (at(mid)) lo = mid; else hi = mid;
      }
      return lo;
    }
    inside = Math.min(t, limit);
  }
  return limit;
}

/** Distance from p along u to the board outline (the first crossing), or Infinity. */
function rayToOutline(outline: Vec2[], p: Vec2, u: Vec2): number {
  let best = Infinity;
  for (let n = 0; n < outline.length; n++) {
    const a = outline[n];
    const b = outline[(n + 1) % outline.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const den = u[0] * ey - u[1] * ex;
    if (Math.abs(den) < 1e-15) continue;
    const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
    const s = ((a[0] - p[0]) * u[1] - (a[1] - p[1]) * u[0]) / den;
    if (t >= -1e-9 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, Math.max(0, t));
  }
  return best;
}

function maxDielectricEps(r: ResolvedProject): number {
  return Math.max(1, ...r.stackup.map((l) => (l.type === 'dielectric' ? l.epsR : 1)));
}

/**
 * The feed of port `index`, read from the project, or a ProjectError that
 * says why the port cannot be de-embedded from the project alone.
 */
export function readFeed(r: ResolvedProject, index: number): Feed {
  const port = r.ports[index];
  const path = `$.ports[${index}].deembed`;
  if (port.kind !== 'lumped' || port.deembedMm === null) fail(path, 'only a lumped port with deembed.length is de-embedded');
  const lengthMm = port.deembedMm;
  const p: Vec2 = [port.xMm, port.yMm];
  const onBoard = (x: number, y: number) => locateInPolygon(r.boardOutline, x, y) !== 'outside';
  const copper = (layer: string) => (x: number, y: number) => onBoard(x, y) && paint(r.copper[layer] ?? [], x, y);
  const heights = layerHeights(r);
  const finest = r.graded ? Math.min(r.graded.edgeCellMm, r.cellMm) : r.cellMm;
  const step = Math.min(finest / 4, lengthMm / 64);

  type Candidate = Feed & { score: number };
  const candidates: Candidate[] = [];
  const reasons: string[] = [];
  for (const [signalLayer, referenceLayer] of [port.between, [port.between[1], port.between[0]] as [string, string]]) {
    const strip = copper(signalLayer);
    const heightMm = Math.abs(heights.get(signalLayer)! - heights.get(referenceLayer)!);
    for (const direction of DIRECTIONS) {
      const u = unit(direction);
      const v = across(u);
      const at = (s: number, t: number): Vec2 => [p[0] + u[0] * s + v[0] * t, p[1] + u[1] * s + v[1] * t];
      const overhangOf = (copperTest: typeof strip) => reach(copperTest, p, [-u[0], -u[1]], lengthMm, step);
      if (reach(strip, p, u, lengthMm, step) < lengthMm - 1e-6) continue;
      // Width at stations along the feed: the strip's edges either side of the centreline.
      const stations = Math.max(8, Math.ceil(lengthMm / step));
      const widthLimit = Math.max(50 * heightMm, 4 * lengthMm);
      let edges: [number, number] | null = null;
      let uniform = true;
      for (let k = 0; k < stations && uniform; k++) {
        const c = at(((k + 0.5) / stations) * lengthMm, 0);
        const here: [number, number] = [-reach(strip, c, [-v[0], -v[1]], widthLimit, step), reach(strip, c, v, widthLimit, step)];
        if (edges === null) edges = here;
        uniform = Math.abs(here[0] - edges[0]) <= WIDTH_TOLERANCE_MM && Math.abs(here[1] - edges[1]) <= WIDTH_TOLERANCE_MM;
      }
      if (!uniform || edges === null) {
        reasons.push(`on "${signalLayer}" toward ${direction} the copper changes width within ${lengthMm} mm of the port`);
        continue;
      }
      // Bisection lands within 1e-6 mm of an edge; put it on the drawn edge, so the kit draws the same number.
      const drawn = (r.copper[signalLayer] ?? []).flatMap((shape) => shape.polygon.map((q) => (q[0] - p[0]) * v[0] + (q[1] - p[1]) * v[1]));
      edges = edges.map((t) => drawn.find((d) => Math.abs(d - t) < 1e-5) ?? t) as [number, number];
      const widthMm = edges[1] - edges[0];
      if (widthMm >= widthLimit - 1e-6) continue; // a plane, not a strip
      const overhangMm = overhangOf(strip);
      const side = (sign: 1 | -1) => Math.min(rayToOutline(r.boardOutline, p, [sign * v[0], sign * v[1]]), (sign === 1 ? edges![1] : -edges![0]) + KIT_SIDE_HEIGHTS * heightMm);
      const sidesMm: [number, number] = [side(-1), side(1)];
      // The kit footprint: from the kit board's back edge behind the port to the end of the feed, the full kit width.
      const backMm = Math.min(rayToOutline(r.boardOutline, p, [-u[0], -u[1]]), overhangOf(strip) + lengthMm);
      const footprint = (test: (x: number, y: number) => boolean) => {
        let any = false;
        let all = true;
        const ns = Math.min(MAX_FOOTPRINT_SAMPLES, Math.max(8, Math.ceil((backMm + lengthMm) / step)));
        const nt = Math.min(MAX_FOOTPRINT_SAMPLES, Math.max(8, Math.ceil((sidesMm[0] + sidesMm[1]) / Math.max(step, finest / 2))));
        for (let a = 0; a < ns; a++) {
          for (let b = 0; b < nt; b++) {
            const q = at(-backMm + ((a + 0.5) / ns) * (backMm + lengthMm), -sidesMm[0] + ((b + 0.5) / nt) * (sidesMm[0] + sidesMm[1]));
            const c = test(q[0], q[1]);
            any ||= c;
            all &&= c;
          }
        }
        return { any, all };
      };
      if (!footprint(copper(referenceLayer)).all) {
        reasons.push(`"${referenceLayer}" is not solid under the feed on "${signalLayer}" toward ${direction}`);
        continue;
      }
      const solidLayers: string[] = [];
      let otherLayersOk = true;
      for (const name of Object.keys(r.copper)) {
        if (name === signalLayer || name === referenceLayer) continue;
        const f = footprint(copper(name));
        if (f.all) solidLayers.push(name);
        else if (f.any) {
          reasons.push(`layer "${name}" is neither solid nor empty around the feed toward ${direction}`);
          otherLayersOk = false;
        }
      }
      if (!otherLayersOk) continue;
      // Nothing else on the strip's layer near the strip.
      const clear = Math.max(CLEARANCE_HEIGHTS * heightMm, widthMm);
      const ns = Math.min(MAX_FOOTPRINT_SAMPLES, Math.max(8, Math.ceil((backMm + lengthMm) / step)));
      let crowded = false;
      for (let a = 0; a < ns && !crowded; a++) {
        const s = -backMm + ((a + 0.5) / ns) * (backMm + lengthMm);
        // Behind the port only the strip's own overhang belongs there; beside it, nothing.
        if (s < -overhangMm && strip(...at(s, (edges[0] + edges[1]) / 2))) {
          crowded = true;
          break;
        }
        for (let b = 1; b <= 16 && !crowded; b++) {
          const t = (b / 16) * clear;
          crowded = strip(...at(s, edges[1] + t)) || strip(...at(s, edges[0] - t));
        }
      }
      if (crowded) {
        reasons.push(`other copper on "${signalLayer}" lies within ${clear.toFixed(2)} mm of the feed toward ${direction} (a coplanar ground or a neighboring trace)`);
        continue;
      }
      candidates.push({
        portIndex: index, portId: port.id, lengthMm, direction, signalLayer, referenceLayer, solidLayers, edgesMm: edges, overhangMm,
        backMm, sidesMm, heightMm, epsMax: maxDielectricEps(r), score: overhangMm,
      });
    }
  }
  if (candidates.length === 0) {
    fail(path, `no straight feed of uniform width runs ${lengthMm} mm from the port on "${port.between[0]}" or "${port.between[1]}"` +
      (reasons.length ? `: ${[...new Set(reasons)].join('; ')}` : ''));
  }
  candidates.sort((a, b) => a.score - b.score);
  if (candidates.length > 1 && candidates[1].score - candidates[0].score < 1e-6) {
    fail(path, `the port could feed ${candidates.map((c) => `toward ${c.direction} on "${c.signalLayer}"`).join(' or ')}; put the port on the end of its feed line`);
  }
  // Nothing else may sit on the feed: another port or a component would be in the DUT but not in the kit.
  const feed = candidates[0];
  const u = unit(feed.direction);
  const v = across(u);
  const local = (x: number, y: number): Vec2 => [(x - p[0]) * u[0] + (y - p[1]) * u[1], (x - p[0]) * v[0] + (y - p[1]) * v[1]];
  const insideFootprint = ([s, t]: Vec2) => s > -feed.overhangMm - 1e-9 && s < lengthMm + 1e-9 && t > -feed.sidesMm[0] && t < feed.sidesMm[1];
  r.ports.forEach((q, n) => {
    if (n !== index && insideFootprint(local(q.xMm, q.yMm))) fail(path, `port "${q.id}" sits on the feed of port "${port.id}"`);
  });
  for (const c of r.components) {
    const place = c.place;
    const points: Vec2[] = place.kind === 'between'
      ? [[place.xMm, place.yMm]]
      : [place.fromMm, place.toMm].map((along): Vec2 => (place.axis === 0 ? [along, place.acrossMm] : [place.acrossMm, along]));
    if (points.some((q) => insideFootprint(local(...q)))) fail(path, `component "${c.id}" sits on the feed of port "${port.id}"`);
  }
  for (const via of r.vias) {
    const [s, t] = local(via.xMm, via.yMm);
    const reach = via.antipadRadiusMm ?? via.radiusMm;
    // Behind the port too, where other copper is refused (backMm).
    const behind = Math.max(feed.overhangMm, feed.backMm);
    const near = s > -behind - reach && s < lengthMm + reach && t > -feed.sidesMm[0] - reach && t < feed.sidesMm[1] + reach;
    if (near) fail(path, `via "${via.id}" sits on or beside the feed of port "${port.id}"; the calibration kit would not have it`);
  }
  const { score: _score, ...rest } = feed;
  return rest;
}

/** The calibration band: the project's frequencies, refined by `stride` and extended down by `below` steps, so the project's band is every stride-th kit point from `below` on. */
export interface KitBand {
  fMinGHz: number;
  fMaxGHz: number;
  nFreq: number;
  below: number;
  stride: number;
}

/** The frequency up to which a feed of lengthMm is electrically short, for an effective permittivity epsEff. */
export function shortFeedGHz(lengthMm: number, epsEff: number): number {
  return (SHORT_FEED_FRACTION * C_MM_PER_NS) / (lengthMm * Math.sqrt(epsEff));
}

export function kitBand(analysis: Project['analysis'], feedLengthMm: number, epsMax: number): KitBand {
  const { f_min_ghz: fMin, f_max_ghz: fMax } = analysis;
  const n = Math.max(2, analysis.n_freq);
  const df = (fMax - fMin) / (n - 1);
  // The short-feed frequency, estimated with the largest eps_r (so low). The kit needs IMPEDANCE_FIT_POINTS
  // points at or below it for the impedance fit, and its first point there, where the error box starts
  // near the identity and its sign can be followed up the band.
  const fFit = shortFeedGHz(feedLengthMm, epsMax);
  const stride = Math.max(1, Math.ceil(df / (fFit / (IMPEDANCE_FIT_POINTS + 1))));
  const h = df / stride;
  // h <= fFit / 7, so the first point stays at least h above 0.
  const below = Math.max(0, Math.ceil((fMin - (fFit - (IMPEDANCE_FIT_POINTS - 1) * h)) / h - 1e-9));
  const nFreq = below + stride * (n - 1) + 1;
  const fMinGHz = fMin - below * h;
  if (nFreq > MAX_KIT_FREQUENCIES || fMinGHz < MIN_KIT_GHZ) {
    throw new Error(`a ${feedLengthMm} mm feed over ${fMin} to ${fMax} GHz needs a calibration band of ${nFreq} points from ${fMinGHz.toPrecision(3)} GHz, ` +
      `beyond the ${MAX_KIT_FREQUENCIES} points from ${MIN_KIT_GHZ} GHz a project allows; de-embed a shorter length or raise analysis.n_freq`);
  }
  return { fMinGHz, fMaxGHz: fMax, nFreq, below, stride };
}

/** Extra lengths of the line standards: each spans 25 to 155 degrees, longest first, from fLoGHz up to fHiGHz. */
export function lineStandardsMm(fLoGHz: number, fHiGHz: number, epsEff: number): number[] {
  const lengthAt = (deg: number, fGHz: number) => (deg / 360) * C_MM_PER_NS / (fGHz * Math.sqrt(epsEff));
  const out: number[] = [];
  let extra = Math.min(MAX_EXTRA_LINE_MM, lengthAt(LINE_DESIGN_LOW_DEG, fLoGHz));
  while (out.length < MAX_LINE_STANDARDS) {
    out.push(extra);
    if (expectedPhaseDeg(fHiGHz, epsEff, extra) <= LINE_DESIGN_HIGH_DEG) break;
    extra *= LINE_DESIGN_LOW_DEG / LINE_DESIGN_HIGH_DEG;
  }
  return out;
}

const mm = (v: number) => `${Number(v.toFixed(6))} mm`;


/**
 * The kit's feed geometry, relative to the grid node the project's port
 * snaps to. A uniform mesh starts at the board's low corner, so the kit's
 * strip lands on the same cells as the project's only if its edges sit at
 * the same offsets from the port's node and the kit board's low edges are
 * whole cells from it. Graded meshes put lines on every edge and port, so
 * the feed is used as drawn. `acrossSign` is +1 when the kit's across
 * direction runs along +y (a kit along x) and -1 when it runs along -x.
 */
function onProjectGrid(project: Project, feed: Feed, acrossSign: 1 | -1): Pick<Feed, 'backMm' | 'sidesMm' | 'edgesMm' | 'overhangMm'> {
  const r = resolveProject(project);
  if (r.graded) return feed;
  const dx = r.cellMm;
  const port = r.ports[feed.portIndex];
  const drawn: Vec2 = [port.xMm, port.yMm];
  const node = [0, 1].map((axis) => {
    const low = Math.min(...r.boardOutline.map((q) => q[axis]));
    return low + Math.round((drawn[axis] - low) / dx) * dx;
  });
  const u = unit(feed.direction);
  const v = across(u);
  // Drawn-port coordinates to node coordinates: add the drawn port's offset from the node.
  const ds = (drawn[0] - node[0]) * u[0] + (drawn[1] - node[1]) * u[1];
  const dt = (drawn[0] - node[0]) * v[0] + (drawn[1] - node[1]) * v[1];
  // Rounded, not raised: a cell of the project's grid is board where its centre is, so an edge
  // under half a cell past the node leaves that cell air, as the kit's rounded edge does.
  const wholeCells = (mm: number) => Math.round(mm / dx) * dx;
  const sides: [number, number] = [feed.sidesMm[0] - dt, feed.sidesMm[1] + dt];
  // The low edge across, in the kit's own axes: -sides[0] along +y, or -sides[1] along -x.
  if (acrossSign === 1) sides[0] = wholeCells(sides[0]);
  else sides[1] = wholeCells(sides[1]);
  return {
    backMm: wholeCells(feed.backMm - ds),
    sidesMm: sides,
    edgesMm: [feed.edgesMm[0] + dt, feed.edgesMm[1] + dt],
    overhangMm: feed.overhangMm - ds,
  };
}

/**
 * The kit project for a feed: the project's stackup, materials, mesh,
 * boundaries and loss settings; the strip from port 1 at the origin running
 * along the feed's axis for 2 x length + extraMm, port 2 at its end; the
 * reference and solid layers filled over the kit board. Rotated so the
 * feed runs toward +x or +y, so a feed and its mirror image share one kit.
 */
export function kitProject(project: Project, feed: Feed, extraMm: number, band: KitBand, label: string): Project {
  const axis = feed.direction[1] as 'x' | 'y';
  const u: Vec2 = axis === 'x' ? [1, 0] : [0, 1];
  const v = across(u);
  const point = (s: number, t: number): [string, string] => [mm(u[0] * s + v[0] * t), mm(u[1] * s + v[1] * t)];
  const rect = (s0: number, s1: number, t0: number, t1: number) => [point(s0, t0), point(s1, t0), point(s1, t1), point(s0, t1)];
  const span = 2 * feed.lengthMm + extraMm;
  const { backMm, sidesMm, edgesMm, overhangMm } = onProjectGrid(project, feed, v[0] !== 0 ? -1 : 1);
  const board = rect(-backMm, span + backMm, -sidesMm[0], sidesMm[1]);
  const geometry: Project['geometry'] = {};
  for (const layer of project.stackup) {
    if (layer.type !== 'copper') continue;
    if (layer.name === feed.signalLayer) {
      geometry[layer.name] = [{ id: 'strip', op: 'add', polygon: rect(-overhangMm, span + overhangMm, edgesMm[0], edgesMm[1]) }];
    } else if (layer.name === feed.referenceLayer || feed.solidLayers.includes(layer.name)) {
      geometry[layer.name] = [{ id: 'plane', op: 'add', polygon: board }];
    } else {
      geometry[layer.name] = [];
    }
  }
  const port = project.ports[feed.portIndex];
  const z0 = port.reference_impedance_ohm;
  const [x2, y2] = point(span, 0);
  return {
    noburf_project: 1,
    name: `${project.name}-kit-${label}`,
    variables: project.variables,
    materials: project.materials,
    stackup: project.stackup,
    board: { outline: board },
    geometry,
    ports: [
      { id: 'p1', x: mm(0), y: mm(0), between: port.between, reference_impedance_ohm: z0 },
      { id: 'p2', x: x2, y: y2, between: port.between, reference_impedance_ohm: z0 },
    ],
    boundaries: project.boundaries,
    mesh: project.mesh,
    analysis: {
      f_min_ghz: band.fMinGHz,
      f_max_ghz: band.fMaxGHz,
      n_freq: band.nFreq,
      loss_reference_ghz: project.analysis.loss_reference_ghz,
      stop: project.analysis.stop,
    },
    outputs: { zin_at_ghz: [] },
  };
}

/** What de-embedding found for one port: the feed, the kit and the line it measured. */
export interface PortDeembedding {
  feed: Feed;
  kit: { band: KitBand; extraLinesMm: number[]; solves: number; reusedFrom: string | null };
  /** Line impedance in the low-frequency limit (the reference the error box is scaled to) and how many points the fit used. */
  zLineOhm: number;
  zFitPoints: number;
  zFitMaxGHz: number;
  /** Effective permittivity from the longest line's delay over the thru's (picks the TRL roots); the line lengths came from the thru's delay alone. */
  epsEffGuess: number;
  /** Per project frequency: the line's effective permittivity and loss from the line standard, null where none was usable. */
  epsEff: Array<number | null>;
  lossDbPerMm: Array<number | null>;
  /** Project frequencies at which the symmetric half of the thru stood in for the line standards. */
  halfThruGHz: number[];
}

/** Solves a kit project (two lumped ports) and returns its full S-matrix. */
export type KitSolver = (kit: Project) => Promise<ScatteringResult>;

/** Group delay from the slope of the unwrapped S21 phase over the band (ns). */
function delayNs(s: ScatteringResult): number {
  const xs = Array.from(s.fGHz);
  const ys = unwrappedPhase(xs.map((_, m) => [s.re[1][0]![m], s.im[1][0]![m]]));
  const n = xs.length;
  const mx = xs.reduce((sum, x) => sum + x, 0) / n;
  const my = ys.reduce((sum, y) => sum + y, 0) / n;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
  }
  return -(sxy / sxx) / (2 * Math.PI);
}

/** Effective permittivity of a line from a delay over its length, clamped to [1, epsMax]. */
const epsEffOfDelay = (delay: number, lengthMm: number, epsMax: number) => Math.min(epsMax, Math.max(1, ((delay * C_MM_PER_NS) / lengthMm) ** 2));

/**
 * On a uniform mesh (cell given) every kit spans whole cells, so its two ports
 * land alike on the grid: the extra lines are rounded to whole cells (at least
 * one, no two alike). A graded mesh puts lines on both ports anyway.
 */
function onWholeCells(extras: number[], cellMm: number | null): number[] {
  if (cellMm === null) return extras;
  return [...new Set(extras.map((x) => Math.max(1, Math.round(x / cellMm))))].map((n) => n * cellMm);
}

/** The kit project's port and strip, without the band: ports whose kits match share one set of solves. */
const kitKey = (project: Project, feed: Feed) => JSON.stringify(kitProject(project, feed, 0, { fMinGHz: 1, fMaxGHz: 2, nFreq: 2, below: 0, stride: 1 }, 'key'));

/**
 * Everything de-embedding can refuse before the project is solved: the full
 * S-matrix (every port excited), each de-embedded port's feed, its length on
 * a uniform mesh and its calibration band. Returns the feeds, in port order.
 */
export function checkDeembedding(project: Project): Feed[] {
  const r = resolveProject(project);
  const indices = r.ports.flatMap((p, index) => (p.deembedMm === null ? [] : [index]));
  if (indices.length > 0 && r.excite.length !== r.ports.length) {
    fail('$.analysis.excite', 'de-embedding needs the full S-matrix; excite every port (leave analysis.excite out)');
  }
  return indices.map((index) => {
    const feed = readFeed(r, index);
    if (!r.graded && Math.abs(feed.lengthMm / (r.cellMm / 2) - Math.round(feed.lengthMm / (r.cellMm / 2))) > 1e-6) {
      fail(`$.ports[${index}].deembed.length`, `on a uniform mesh the length must be a whole number of half cells (${r.cellMm / 2} mm), so the kit's thru is whole cells long; got ${feed.lengthMm} mm`);
    }
    kitBand(project.analysis, feed.lengthMm, feed.epsMax);
    return feed;
  });
}

/**
 * De-embed the ports of `project` that ask for it from the solved S-matrix
 * `s` (every port excited). Solves each distinct kit with `solve`.
 */
export async function deembedProject(project: Project, s: ScatteringResult, solve: KitSolver, log: (line: string) => void = () => {}): Promise<{ s: ScatteringResult; ports: PortDeembedding[]; warnings: string[] }> {
  const r = resolveProject(project);
  const warnings: string[] = [];
  const boxes: Array<Abcd[] | null> = r.ports.map(() => null);
  const done = new Map<string, { boxes: Abcd[]; report: PortDeembedding }>();
  const reports: PortDeembedding[] = [];
  for (const feed of checkDeembedding(project)) {
    const index = feed.portIndex;
    const key = kitKey(project, feed);
    const known = done.get(key);
    if (known) {
      boxes[index] = known.boxes;
      reports.push({ ...known.report, feed, kit: { ...known.report.kit, solves: 0, reusedFrom: known.report.feed.portId } });
      continue;
    }
    const band = kitBand(project.analysis, feed.lengthMm, feed.epsMax);
    const z0 = r.ports[index].z0;
    log(`de-embedding port "${feed.portId}": ${feed.lengthMm} mm of ${(feed.edgesMm[1] - feed.edgesMm[0]).toFixed(3)} mm strip on "${feed.signalLayer}" toward ${feed.direction}; solving the thru`);
    const thru = await solve(kitProject(project, feed, 0, band, `${feed.portId}-thru`));
    // The thru's delay includes the ports' own, so this reads high; it only sizes the line standards.
    const epsEffDesign = epsEffOfDelay(delayNs(thru), 2 * feed.lengthMm, feed.epsMax);
    // Start low enough that the longest line is IMPEDANCE_LINE_FEEDS feeds long.
    const fStartGHz = Math.min(project.analysis.f_min_ghz, (LINE_DESIGN_LOW_DEG / 360) * C_MM_PER_NS / (IMPEDANCE_LINE_FEEDS * feed.lengthMm * Math.sqrt(epsEffDesign)));
    const extraLinesMm = onWholeCells(lineStandardsMm(fStartGHz, project.analysis.f_max_ghz, epsEffDesign), r.graded ? null : r.cellMm);
    const lines: LineStandard[] = [];
    const lineResults: ScatteringResult[] = [];
    for (const [n, extra] of extraLinesMm.entries()) {
      log(`de-embedding port "${feed.portId}": solving line standard ${n + 1} of ${extraLinesMm.length} (${extra.toFixed(2)} mm longer)`);
      const line = await solve(kitProject(project, feed, extra, band, `${feed.portId}-line${n + 1}`));
      lineResults.push(line);
      lines.push({ s: Array.from(line.fGHz, (_, m) => twoPortAt(line, m)), extraMm: extra });
    }
    // The longest line's delay less the thru's is the extra line's alone: the ports cancel. This guess picks the roots.
    const epsEffGuess = epsEffOfDelay(delayNs(lineResults[0]) - delayNs(thru), lines[0].extraMm, feed.epsMax);
    const thruS = Array.from(thru.fGHz, (_, m) => twoPortAt(thru, m));
    const zFitMaxGHz = shortFeedGHz(feed.lengthMm, epsEffGuess);
    const fit = lowFrequencyLineImpedance(thru.fGHz, thruS, lines[0].s, z0, zFitMaxGHz);
    const kit = thruLineErrorBoxes(thru.fGHz, thruS, lines, epsEffGuess, fit.zOhm, z0);
    const at = (m: number) => band.below + m * band.stride;
    const nf = s.fGHz.length;
    for (let m = 0; m < nf; m++) {
      if (Math.abs(thru.fGHz[at(m)] - s.fGHz[m]) > 1e-6 * Math.max(1, s.fGHz[m])) {
        throw new Error(`internal: kit frequency ${thru.fGHz[at(m)]} GHz does not match the project's ${s.fGHz[m]} GHz`);
      }
    }
    const portBoxes = Array.from({ length: nf }, (_, m) => kit.box[at(m)]);
    const k0 = (fGHz: number) => (2 * Math.PI * fGHz) / C_MM_PER_NS;
    const gammas = Array.from({ length: nf }, (_, m) => kit.gammaPerMm[at(m)]);
    const report: PortDeembedding = {
      feed,
      kit: { band, extraLinesMm, solves: 1 + lines.length, reusedFrom: null },
      zLineOhm: fit.zOhm,
      zFitPoints: fit.points,
      zFitMaxGHz,
      epsEffGuess,
      epsEff: gammas.map((g, m) => (g ? (g[1] / k0(s.fGHz[m])) ** 2 : null)),
      lossDbPerMm: gammas.map((g) => (g ? (20 / Math.LN10) * g[0] : null)),
      halfThruGHz: Array.from(s.fGHz).filter((_, m) => kit.lineUsed[at(m)] === null),
    };
    // Each line standard's root exp(+gamma dL) was picked as the one nearer the phase the guess predicts; it is
    // safe while the measured phase stays well inside 90 degrees of that prediction.
    let worstMissDeg = 0;
    kit.lineUsed.forEach((n, k) => {
      const g = kit.gammaPerMm[k];
      if (n === null || g === null) return;
      const measuredDeg = (g[1] * lines[n].extraMm * 180) / Math.PI;
      worstMissDeg = Math.max(worstMissDeg, Math.abs(measuredDeg - expectedPhaseDeg(thru.fGHz[k], epsEffGuess, lines[n].extraMm)));
    });
    if (worstMissDeg > ROOT_MISS_WARN_DEG) {
      warnings.push(`port "${feed.portId}": a line standard's measured phase is ${worstMissDeg.toFixed(0)} degrees from the phase predicted by the ` +
        `delay of the longest line over the thru (eps_eff ${epsEffGuess.toFixed(3)}), close to the 90 degrees at which the wrong root would be taken; check the de-embedded phase`);
    }
    if (report.halfThruGHz.length) {
      warnings.push(`port "${feed.portId}": at ${report.halfThruGHz.length} of ${nf} frequencies (${Math.min(...report.halfThruGHz).toFixed(3)} to ` +
        `${Math.max(...report.halfThruGHz).toFixed(3)} GHz) no line standard is at least ${LINE_PHASE_MARGIN_DEG} degrees from 0 and 180, ` +
        'so the port is removed as the symmetric half of the thru there, which keeps part of the port\'s own reflection');
    }
    boxes[index] = portBoxes;
    done.set(key, { boxes: portBoxes, report });
    reports.push(report);
  }
  if (reports.length === 0) return { s, ports: [], warnings };
  return { s: deembedPorts(s, boxes, r.ports.map((p) => p.z0)), ports: reports, warnings };
}
