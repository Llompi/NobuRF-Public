/**
 * Frequency-dependent and magnetic materials: Debye and Lorentz poles, the
 * Djordjevic-Sarkar wideband FR-4 model, and the auxiliary-differential-
 * equation (ADE) update that runs them in the FDTD loop.
 *
 * One relative response serves both fields: eps_r(w) on E edges and mu_r(w)
 * on H edges, with the e^(+j w t) convention (loss is a negative imaginary part):
 *   x(w) = inf + sum_k chi_k(w) - j lossRate / w
 *   Debye    chi = delta / (1 + j w tau),               tau = 1 / (2 pi f_relax)
 *   Lorentz  chi = delta w0^2 / (w0^2 - w^2 + j w g),  w0 = 2 pi f_res, g = 2 pi damping
 * lossRate is sigma / eps0 for E (a conductivity) and sigma_m / mu0 for H (a
 * magnetic loss), in 1/s. Taflove and Hagness, "Computational
 * Electrodynamics", 3rd ed., ch. 9, give both pole types and their ADEs.
 *
 * Update. In the solver's normalised units (e = E dRef, h = eta0 H dRef) both
 * fields obey the same law per edge,
 *   inf (f' - f) + sum_k (p_k' - p_k) + s (f' + f) / 2 = D,     s = lossRate dt,
 * where f is the field before the step, f' after it, p_k the pole's
 * polarisation (magnetisation) in field units, and D the step's curl term:
 * Sc curl(h) for E, -Sc curl(e) for H, CPML and graded-mesh scales included.
 * Each pole is a second-order recursion
 *   p' = a1 p + a2 p_prev + b0 f' + b1 f
 *   Debye   (trapezoidal ADE, Okoniewski et al., IEEE MGWL 7(5), 1997):
 *           r = dt / (2 tau), a1 = (1 - r) / (1 + r), a2 = 0, b0 = b1 = r delta / (1 + r)
 *   Lorentz (central-difference ADE, Taflove and Hagness sec. 9.4.3):
 *           d = 1 + g dt / 2, a1 = (2 - (w0 dt)^2) / d, a2 = (g dt / 2 - 1) / d,
 *           b0 = 0, b1 = delta (w0 dt)^2 / d
 * so f' = cPrev f + cDelta (D - sum_k ((a1 - 1) p_k + a2 p_prev_k)) with
 *   den = inf + B0 + s / 2, cPrev = (inf - B1 - s / 2) / den, cDelta = 1 / den,
 * B0 and B1 the sums of the poles' b0 and b1. With no poles this is exactly
 * dielectricEdge's semi-implicit lossy update.
 *
 * The main E and H kernels are unchanged. A listed edge has its field saved
 * before the step (snapshot) and, once the main and CPML passes are done,
 * D is recovered from what they wrote and the edge is redone with its own
 * physics (update). For E, D = Sc (e_main - eDecay e) / eCurl; for H the main
 * kernel's update is h_main = h + D. So eDecay and eCurl of a dispersive edge
 * can be anything nonzero; rasterise gives them the material's single-
 * frequency stand-in (eps' and loss at analysis.loss_reference_ghz), so the
 * energy stop, the port and the coax painting see sensible values. An E
 * edge with eCurl 0 (copper, a port cell) is skipped each step, so a list
 * may hold port cells that withoutPorts later turns back into dielectric.
 *
 * Stored energy. The energy stop sums eps e^2 + h^2 (CpuFdtd.energy,
 * energy.wgsl) with the stand-in eps. On a listed edge that is replaced by
 *   inf f^2 + sum_k p_k^2 / delta_k                      (Debye)
 *         + (p_k - p_prev_k)^2 / (delta_k (w0 dt)^2)     (Lorentz, the kinetic part)
 * which is what the poles' equations conserve: for a Debye pole,
 * tau p' + p = delta f, so d/dt (inf f^2 + p^2 / delta) / 2 = f D' - tau p'^2 / delta.
 * A slow pole keeps energy after the field has rung down and gives it back
 * at low frequencies; without it the stop ended wideband FR-4 runs early
 * (0.4 % in |S21| at 50 MHz on a differential pair).
 */
import { nnls } from './nnls';

import type { VoxelModel } from './voxelize';

export type Pole =
  | { type: 'debye'; delta: number; fRelaxHz: number }
  | { type: 'lorentz'; delta: number; fResHz: number; dampingHz: number };

export interface MediumResponse {
  inf: number;
  /** sigma / eps0 (E) or sigma_m / mu0 (H), in 1/s. */
  lossRate: number;
  poles: Pole[];
}

export type Complex = [re: number, im: number];

export const constantResponse = (value: number, lossRate = 0): MediumResponse => ({ inf: value, lossRate, poles: [] });
export const VACUUM_RESPONSE: MediumResponse = constantResponse(1);

export function poleSusceptibility(pole: Pole, fHz: number): Complex {
  const w = 2 * Math.PI * fHz;
  if (pole.type === 'debye') {
    const wt = fHz / pole.fRelaxHz;
    const den = 1 + wt * wt;
    return [pole.delta / den, (-pole.delta * wt) / den];
  }
  const w0 = 2 * Math.PI * pole.fResHz;
  const g = 2 * Math.PI * pole.dampingHz;
  const re = w0 * w0 - w * w;
  const im = w * g;
  const den = re * re + im * im;
  const scale = pole.delta * w0 * w0;
  return [(scale * re) / den, (-scale * im) / den];
}

/** The relative permittivity or permeability at fHz. */
export function relativeValue(r: MediumResponse, fHz: number): Complex {
  let re = r.inf;
  let im = -r.lossRate / (2 * Math.PI * fHz);
  for (const pole of r.poles) {
    const [cr, ci] = poleSusceptibility(pole, fHz);
    re += cr;
    im += ci;
  }
  return [re, im];
}

/**
 * The response with these poles that has real part `real` and loss tangent
 * `lossTangent` at fHz: inf and lossRate take up the difference, as the
 * Djordjevic-Sarkar model does for its constant terms. Fails if that needs
 * inf below 1 (the explicit update's stability rests on it) or a negative
 * loss (gain).
 */
export function anchoredResponse(real: number, lossTangent: number, fHz: number, poles: Pole[], what: string): MediumResponse {
  const [chiRe, chiIm] = relativeValue({ inf: 0, lossRate: 0, poles }, fHz);
  // Rounding can leave 1 - 1e-16 where the poles take exactly real - 1.
  const inf = Math.abs(real - chiRe - 1) < 1e-12 * real ? 1 : real - chiRe;
  const missingLoss = real * lossTangent + chiIm; // eps'' wanted minus eps'' the poles already give
  if (!(inf >= 1)) throw new Error(`${what}: the poles add ${chiRe.toPrecision(4)} at ${fHz / 1e9} GHz, leaving ${inf.toPrecision(4)} for the high-frequency value; it must be at least 1, so lower the poles' delta`);
  if (missingLoss < -1e-9 * real) {
    throw new Error(`${what}: the poles alone are lossier at ${fHz / 1e9} GHz (tan delta ${(-chiIm / real).toPrecision(3)}) than the given ${lossTangent}`);
  }
  return { inf, lossRate: Math.max(0, missingLoss) * 2 * Math.PI * fHz, poles };
}

/* ------------------------------------------------------------------------ */
/* Djordjevic-Sarkar wideband model                                          */
/* ------------------------------------------------------------------------ */

/**
 * Djordjevic, Biljic, Likar-Smiljanic and Sarkar, "Wideband frequency-domain
 * characterization of FR-4 and time-domain causality", IEEE Trans. EMC 43(4),
 * 662-667, 2001:
 *   eps(w) = eps_inf + k log10((w2 + j w) / (w1 + j w)),   k = delta_eps / (m2 - m1)
 * with w1 = 2 pi fLow, w2 = 2 pi fHigh. Its loss is nearly constant between
 * fLow and fHigh, which is what glass-epoxy laminates show, and it is causal.
 * k and eps_inf are set so the model has eps_r and tan_delta at the
 * measurement frequency, as EM tools that offer it take their input.
 */
export interface DjordjevicSarkar {
  epsR: number;
  tanDelta: number;
  atHz: number;
  fLowHz: number;
  fHighHz: number;
}

/** Default corner frequencies, far outside any band this solver runs, so the loss is flat across it. */
export const DS_DEFAULT_F_LOW_HZ = 1e3;
export const DS_DEFAULT_F_HIGH_HZ = 1e12;

function dsConstants(m: DjordjevicSarkar): { k: number; epsInf: number } {
  if (!(m.fLowHz > 0 && m.fHighHz > m.fLowHz)) throw new Error(`Djordjevic-Sarkar: f_low ${m.fLowHz} Hz must be positive and below f_high ${m.fHighHz} Hz`);
  if (!(m.atHz > m.fLowHz && m.atHz < m.fHighHz)) throw new Error(`Djordjevic-Sarkar: the measurement frequency must lie between f_low and f_high`);
  // Im log10((w2 + j w) / (w1 + j w)) = (atan(w / w2) - atan(w / w1)) / ln 10; frequencies cancel in w / w1.
  const lossShape = (Math.atan(m.atHz / m.fLowHz) - Math.atan(m.atHz / m.fHighHz)) / Math.LN10;
  const k = (m.epsR * m.tanDelta) / lossShape;
  const realShape = Math.log10((m.fHighHz ** 2 + m.atHz ** 2) / (m.fLowHz ** 2 + m.atHz ** 2)) / 2;
  return { k, epsInf: m.epsR - k * realShape };
}

/** The closed-form Djordjevic-Sarkar permittivity at fHz (the reference the pole fit is tested against). */
export function djordjevicSarkarExact(m: DjordjevicSarkar, fHz: number): Complex {
  const { k, epsInf } = dsConstants(m);
  const re = epsInf + (k * Math.log10((m.fHighHz ** 2 + fHz ** 2) / (m.fLowHz ** 2 + fHz ** 2))) / 2;
  const im = (k * (Math.atan(fHz / m.fHighHz) - Math.atan(fHz / m.fLowHz))) / Math.LN10;
  return [re, im];
}

/**
 * Debye poles per decade of the fit. With the model's corners far outside the
 * band, the trapezoid rule in log frequency converges exponentially: 2 per
 * decade fits eps' to 1e-4 and eps'' to 0.3 % (tests/dispersion.test.ts).
 */
const DS_POLES_PER_DECADE = 2;
/** Gauss-Legendre poles per decade when a corner of the model lies within DS_GUARD_DECADES of the band. */
const DS_POLES_PER_DECADE_CLIPPED = 3;
/** Decades of poles kept beyond the band on each side; the rest of the distribution is one pole per side. */
const DS_GUARD_DECADES = 1.5;

/**
 * The Djordjevic-Sarkar model as a sum of Debye poles for the band
 * [fMinHz, fMaxHz]. The model is exactly a continuous Debye distribution,
 * uniform in log relaxation frequency between fLow and fHigh:
 *   eps = eps_inf + (k / ln 10) * integral over ln F from ln fLow to ln fHigh of 1 / (1 + j f / F),
 * so it is discretised with the trapezoid rule in ln F, which converges
 * exponentially for this integrand. The relaxations more than
 * DS_GUARD_DECADES outside the band are folded into one pole per side. Finally the poles are scaled and inf set so the fit is exact at the
 * measurement frequency.
 */
export function djordjevicSarkarResponse(m: DjordjevicSarkar, fMinHz: number, fMaxHz: number): MediumResponse {
  if (m.tanDelta === 0) return constantResponse(m.epsR); // k = 0: the model is a constant
  const { k } = dsConstants(m);
  const weight = k / Math.LN10; // per unit of ln F
  const lo = Math.max(m.fLowHz, Math.min(fMinHz, m.atHz) / 10 ** DS_GUARD_DECADES);
  const hi = Math.min(m.fHighHz, Math.max(fMaxHz, m.atHz) * 10 ** DS_GUARD_DECADES);
  const span = Math.log(hi / lo);
  const poles: Pole[] = [];
  if (lo === m.fLowHz || hi === m.fHighHz) {
    // A corner of the model near the band ends the distribution sharply there, where the
    // trapezoid rule is only second order. Gauss-Legendre has no endpoint error.
    const { nodes, weights } = gaussLegendre(Math.ceil((span / Math.LN10) * DS_POLES_PER_DECADE_CLIPPED));
    nodes.forEach((x, n) => poles.push({ type: 'debye', delta: (weight * span * weights[n]) / 2, fRelaxHz: lo * Math.exp((span * (x + 1)) / 2) }));
  } else {
    const intervals = Math.max(1, Math.ceil((span / Math.LN10) * DS_POLES_PER_DECADE));
    const step = span / intervals;
    for (let n = 0; n <= intervals; n++) {
      const end = n === 0 || n === intervals ? 0.5 : 1;
      poles.push({ type: 'debye', delta: weight * step * end, fRelaxHz: lo * Math.exp(n * step) });
    }
  }
  // Each tail becomes one Debye pole with the tail's first two moments, so the
  // error in the band falls as (band / tail edge)^2 instead of linearly.
  if (lo > m.fLowHz) {
    // f >> F: integral of 1/(1 + j f/F) d ln F ~ (lo^2 - fLow^2) / (2 f^2) - j (lo - fLow) / f.
    const fRelaxHz = (lo + m.fLowHz) / 2;
    poles.push({ type: 'debye', delta: (weight * (lo - m.fLowHz)) / fRelaxHz, fRelaxHz });
  }
  if (hi < m.fHighHz) {
    // f << F: the integral ~ ln(fHigh / hi) - j f (1/hi - 1/fHigh).
    const delta = Math.log(m.fHighHz / hi);
    poles.push({ type: 'debye', delta: weight * delta, fRelaxHz: delta / (1 / hi - 1 / m.fHighHz) });
  }
  // The quadrature's small loss error is a scale on all poles (the model's loss is all poles), not a conductivity, which would grow as 1/f.
  const [, fitIm] = relativeValue({ inf: 0, lossRate: 0, poles }, m.atHz);
  const scale = (m.epsR * m.tanDelta) / -fitIm;
  const scaled = poles.map((p) => ({ ...p, delta: p.delta * scale }));
  const r = anchoredResponse(m.epsR, m.tanDelta, m.atHz, scaled, 'Djordjevic-Sarkar fit');
  return { ...r, lossRate: 0 };
}

/* ------------------------------------------------------------------------ */
/* Measured tables                                                           */
/* ------------------------------------------------------------------------ */

/** One row of a measured permittivity table (a laminate datasheet's Dk and Df). */
export interface PermittivityPoint { fHz: number; epsR: number; tanDelta: number }

/** Debye relaxations per decade of a table fit, and decades of them beyond the table on each side. */
const TABLE_POLES_PER_DECADE = 3;
const TABLE_GUARD_DECADES = 1;
/** Floor on a row's eps'' scale, relative to eps', so a lossless row is fitted in tan delta to 1e-4 rather than divided by 0. */
const TABLE_LOSS_FLOOR = 1e-4;

/**
 * A causal, passive response through a measured table: a high-frequency value
 * inf >= 1 and Debye poles of non-negative delta at fixed relaxation
 * frequencies, log-spaced from a decade below the table to a decade above,
 *   eps(f) = inf + sum_k delta_k / (1 + j f / F_k),
 * fitted by non-negative least squares to eps' and eps'' of every row, each
 * relative to its own value. A sum of Debye terms with non-negative weights
 * is causal and passive whatever the weights (Taflove and Hagness sec. 9.2),
 * so a table that is not (noise, or eps' and eps'' that break Kramers-Kronig)
 * comes out as the nearest response that is, and fitError says how near:
 * the worst relative error over the rows, of eps' and of eps'' (tan delta for
 * rows with almost no loss). No conductivity term: a table says nothing about
 * DC, and a conductivity would put a loss there that grows as 1 / f.
 */
export function tableResponse(points: PermittivityPoint[]): { response: MediumResponse; fitError: number } {
  const fLo = points[0].fHz / 10 ** TABLE_GUARD_DECADES;
  const fHi = points[points.length - 1].fHz * 10 ** TABLE_GUARD_DECADES;
  const count = Math.ceil(Math.log10(fHi / fLo) * TABLE_POLES_PER_DECADE) + 1;
  const relax = Array.from({ length: count }, (_, n) => fLo * (fHi / fLo) ** (n / (count - 1)));
  // Unknowns: inf - 1, then delta_k. Each row of eps' reads (inf - 1 + sum ...) / eps' = 1 - 1 / eps'.
  const rows: number[][] = [];
  const rhs: number[] = [];
  for (const p of points) {
    const lossScale = p.epsR * Math.max(p.tanDelta, TABLE_LOSS_FLOOR);
    const x = relax.map((F) => p.fHz / F);
    rows.push([1 / p.epsR, ...x.map((v) => 1 / (1 + v * v) / p.epsR)]);
    rhs.push(1 - 1 / p.epsR);
    rows.push([0, ...x.map((v) => v / (1 + v * v) / lossScale)]);
    rhs.push((p.epsR * p.tanDelta) / lossScale);
  }
  const solution = nnls(rows, rhs);
  const response: MediumResponse = {
    inf: 1 + solution[0],
    lossRate: 0,
    poles: relax.flatMap((fRelaxHz, k): Pole[] => (solution[k + 1] > 0 ? [{ type: 'debye', delta: solution[k + 1], fRelaxHz }] : [])),
  };
  let fitError = 0;
  for (const p of points) {
    const [re, im] = relativeValue(response, p.fHz);
    const lossScale = p.epsR * Math.max(p.tanDelta, TABLE_LOSS_FLOOR);
    fitError = Math.max(fitError, Math.abs(re / p.epsR - 1), Math.abs((-im - p.epsR * p.tanDelta) / lossScale));
  }
  return { response, fitError };
}

/** Gauss-Legendre nodes and weights on [-1, 1] (Newton on the Legendre recurrence; Press et al., Numerical Recipes, sec. 4.6). */
function gaussLegendre(n: number): { nodes: number[]; weights: number[] } {
  const nodes: number[] = [];
  const weights: number[] = [];
  for (let i = 1; i <= n; i++) {
    let x = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 1;
    for (let iter = 0; iter < 100; iter++) {
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= n; k++) [p0, p1] = [p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k];
      dp = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) < 1e-15) break;
    }
    nodes.push(x);
    weights.push(2 / ((1 - x * x) * dp * dp));
  }
  return { nodes, weights };
}

/* ------------------------------------------------------------------------ */
/* The ADE coefficients and the per-edge tables the engines read             */
/* ------------------------------------------------------------------------ */

export interface PoleUpdate { a1: number; a2: number; b0: number; b1: number }

/**
 * Lorentz ADE stability. Coupled to the field, a pole oscillates at
 * w0 sqrt(1 + delta / inf), and the explicit central difference needs that
 * times dt below 2. Kept well inside, so the pole is also resolved in time.
 */
const MAX_LORENTZ_COUPLED_W0_DT = 1;

export function poleUpdate(pole: Pole, dtSec: number): PoleUpdate {
  if (!(pole.delta >= 0)) throw new Error(`pole delta must be >= 0, got ${pole.delta}`);
  if (pole.type === 'debye') {
    if (!(pole.fRelaxHz > 0)) throw new Error(`Debye relaxation frequency must be > 0, got ${pole.fRelaxHz}`);
    const r = Math.PI * pole.fRelaxHz * dtSec; // dt / (2 tau)
    const b = (r * pole.delta) / (1 + r);
    return { a1: (1 - r) / (1 + r), a2: 0, b0: b, b1: b };
  }
  if (!(pole.fResHz > 0 && pole.dampingHz >= 0)) throw new Error(`Lorentz pole needs f_res > 0 and damping >= 0, got ${pole.fResHz}, ${pole.dampingHz}`);
  const w0dt = 2 * Math.PI * pole.fResHz * dtSec;
  const half = Math.PI * pole.dampingHz * dtSec; // g dt / 2
  const d = 1 + half;
  return { a1: (2 - w0dt * w0dt) / d, a2: (half - 1) / d, b0: 0, b1: (pole.delta * w0dt * w0dt) / d };
}

/** Floats ahead of the poles in each medium record: cPrev, cDelta, pole count, unused. */
export const MEDIUM_HEADER = 4;
export const POLE_WORDS = 4;

/**
 * The listed edges of one field and the media they use. Each medium record is
 * MEDIUM_HEADER + POLE_WORDS * maxPoles floats: [cPrev, cDelta, poleCount, 0,
 * then a1 - 1, a2, b0, b1 per pole]. The engines keep per edge 1 + 2 * maxPoles
 * state floats: the field before the step, then p and p_prev per pole.
 */
export interface EdgeDispersion {
  /** Index into the field buffer (E or H, three blocks of N) of each listed edge. */
  index: Uint32Array;
  /** Medium record of each edge. */
  medium: Uint32Array;
  maxPoles: number;
  media: Float32Array;
  /** Stored-energy weights of each medium (energyWords floats): inf, then per pole the p^2 and (p - p_prev)^2 weights. */
  energy: Float32Array;
}

export interface ModelDispersion {
  e?: EdgeDispersion;
  h?: EdgeDispersion;
}

export const mediumWords = (maxPoles: number) => MEDIUM_HEADER + POLE_WORDS * maxPoles;
export const stateStride = (maxPoles: number) => 1 + 2 * maxPoles;
export const energyWords = (maxPoles: number) => 1 + 2 * maxPoles;

/** A medium's stored-energy weights (see the header): inf, then 1 / delta and 1 / (delta (w0 dt)^2) per pole; 0 for a pole with delta 0, which holds nothing. */
export function mediumEnergyWeights(r: MediumResponse, dtSec: number, maxPoles = r.poles.length): Float64Array {
  const w = new Float64Array(energyWords(maxPoles));
  w[0] = r.inf;
  r.poles.forEach((p, k) => {
    if (p.delta === 0) return;
    w[1 + 2 * k] = 1 / p.delta;
    if (p.type === 'lorentz') w[2 + 2 * k] = 1 / (p.delta * (2 * Math.PI * p.fResHz * dtSec) ** 2);
  });
  return w;
}

/** A weighted mixture of responses: an edge on an interface takes each side by its share of the dual cell. */
export type Mixture = Array<{ response: MediumResponse; weight: number }>;

/**
 * Collects the edges of one field with their mixtures and compiles the media
 * table. The mixture of eps (or mu) responses is linear, so an interface edge
 * is exact: inf, lossRate and every pole's delta scale with the weight.
 */
export class DispersionBuilder {
  private readonly ids = new Map<MediumResponse, number>();
  private readonly media = new Map<string, MediumResponse>();
  private readonly mediumIndex = new Map<string, number>();
  private readonly edges: number[] = [];
  private readonly edgeMedium: number[] = [];

  constructor(private readonly dtSec: number) {}

  add(index: number, mixture: Mixture): void {
    // Merge repeats of one response (a plane inside a thick layer has the same material on both sides).
    const merged = new Map<MediumResponse, number>();
    for (const { response, weight } of mixture) if (weight > 0) merged.set(response, (merged.get(response) ?? 0) + weight);
    const parts = [...merged].map(([response, weight]) => {
      if (!this.ids.has(response)) this.ids.set(response, this.ids.size);
      return { id: this.ids.get(response)!, response, weight };
    }).sort((a, b) => a.id - b.id);
    const key = parts.map((p) => `${p.id}:${p.weight}`).join('|');
    let m = this.mediumIndex.get(key);
    if (m === undefined) {
      m = this.mediumIndex.size;
      this.mediumIndex.set(key, m);
      this.media.set(key, mix(parts));
    }
    this.edges.push(index);
    this.edgeMedium.push(m);
  }

  build(): EdgeDispersion | undefined {
    if (this.edges.length === 0) return undefined;
    const media = [...this.media.values()];
    const maxPoles = Math.max(0, ...media.map((r) => r.poles.length));
    const words = mediumWords(maxPoles);
    const table = new Float32Array(media.length * words);
    media.forEach((r, n) => table.set(mediumRecord(r, this.dtSec, maxPoles), n * words));
    const energy = new Float32Array(media.length * energyWords(maxPoles));
    media.forEach((r, n) => energy.set(mediumEnergyWeights(r, this.dtSec, maxPoles), n * energyWords(maxPoles)));
    if (new Set(this.edges).size !== this.edges.length) throw new Error('dispersion: an edge is listed twice');
    return { index: Uint32Array.from(this.edges), medium: Uint32Array.from(this.edgeMedium), maxPoles, media: table, energy };
  }
}

function mix(parts: Array<{ response: MediumResponse; weight: number }>): MediumResponse {
  const total = parts.reduce((s, p) => s + p.weight, 0);
  return {
    inf: parts.reduce((s, p) => s + (p.weight / total) * p.response.inf, 0),
    lossRate: parts.reduce((s, p) => s + (p.weight / total) * p.response.lossRate, 0),
    poles: parts.flatMap((p) => p.response.poles.map((pole) => ({ ...pole, delta: (pole.delta * p.weight) / total }))),
  };
}

/** One medium record (see EdgeDispersion), in doubles. */
export function mediumRecord(r: MediumResponse, dtSec: number, maxPoles = r.poles.length): Float64Array {
  if (!(r.inf >= 1)) throw new Error(`dispersion: high-frequency value ${r.inf} must be at least 1`);
  if (!(r.lossRate >= 0)) throw new Error(`dispersion: loss ${r.lossRate} must be >= 0`);
  for (const p of r.poles) {
    if (p.type !== 'lorentz') continue;
    const coupled = 2 * Math.PI * p.fResHz * dtSec * Math.sqrt(1 + p.delta / r.inf);
    if (coupled > MAX_LORENTZ_COUPLED_W0_DT) {
      throw new Error(`Lorentz pole at ${(p.fResHz / 1e9).toPrecision(4)} GHz with delta ${p.delta.toPrecision(4)} is too fast for the time step ` +
        `(w0 dt sqrt(1 + delta / inf) = ${coupled.toFixed(2)} > ${MAX_LORENTZ_COUPLED_W0_DT}); use smaller cells, a lower f_res or a smaller delta`);
    }
  }
  const updates = r.poles.map((p) => poleUpdate(p, dtSec));
  const s = r.lossRate * dtSec;
  const b0 = updates.reduce((t, u) => t + u.b0, 0);
  const b1 = updates.reduce((t, u) => t + u.b1, 0);
  const den = r.inf + b0 + s / 2;
  const rec = new Float64Array(mediumWords(maxPoles));
  rec[0] = (r.inf - b1 - s / 2) / den;
  rec[1] = 1 / den;
  rec[2] = updates.length;
  // a1 - 1, not a1: a slow Debye pole has a1 within float32 rounding of 1.
  updates.forEach((u, k) => rec.set([u.a1 - 1, u.a2, u.b0, u.b1], MEDIUM_HEADER + POLE_WORDS * k));
  return rec;
}

/** A copy of `d` without the edges in `drop` (e.g. edges a coax connector repaints). */
export function withoutEdges(d: EdgeDispersion | undefined, drop: ReadonlySet<number>): EdgeDispersion | undefined {
  if (!d) return undefined;
  const keep: number[] = [];
  for (let m = 0; m < d.index.length; m++) if (!drop.has(d.index[m])) keep.push(m);
  if (keep.length === 0) return undefined;
  return { ...d, index: Uint32Array.from(keep, (m) => d.index[m]), medium: Uint32Array.from(keep, (m) => d.medium[m]) };
}

/**
 * The CPU reference of the snapshot and update passes (dispersion.wgsl runs
 * the same arithmetic in float32).
 */
export class DispersionState {
  readonly state: Float32Array;
  private readonly stride: number;
  private readonly words: number;

  constructor(readonly d: EdgeDispersion) {
    this.stride = stateStride(d.maxPoles);
    this.words = mediumWords(d.maxPoles);
    this.state = new Float32Array(d.index.length * this.stride);
  }

  reset(): void {
    this.state.fill(0);
  }

  /**
   * Stored energy of the listed edges (see the header) minus what the plain
   * sum already counted for them. `factors` holds [volume, stand-in] per
   * listed edge (energyFactors); a volume of 0 counts nothing.
   */
  energyCorrection(field: Float32Array, factors: Float32Array): number {
    const { index, medium, energy, maxPoles } = this.d;
    const { state, stride } = this;
    const words = energyWords(maxPoles);
    let s = 0;
    for (let m = 0; m < index.length; m++) {
      const volume = factors[2 * m];
      if (volume === 0) continue;
      const base = m * stride;
      const w = medium[m] * words;
      const f = field[index[m]];
      let stored = (energy[w] - factors[2 * m + 1]) * f * f;
      for (let k = 0; k < maxPoles; k++) {
        const p = state[base + 1 + 2 * k];
        const dp = p - state[base + 2 + 2 * k];
        stored += energy[w + 1 + 2 * k] * p * p + energy[w + 2 + 2 * k] * dp * dp;
      }
      s += stored * volume;
    }
    return s;
  }

  /** Save every listed edge's field before the main update. */
  snapshot(field: Float32Array): void {
    const { index } = this.d;
    for (let m = 0; m < index.length; m++) this.state[m * this.stride] = field[index[m]];
  }

  /**
   * Redo each listed edge after the main and CPML passes. With `e` given
   * (an E field), D is recovered through its eDecay and eCurl; without, the
   * main update was f + D (the H kernel).
   */
  update(field: Float32Array, courant: number, e?: { decay: Float32Array; curl: Float32Array }): void {
    const { index, medium, media } = this.d;
    const { state, stride, words } = this;
    for (let m = 0; m < index.length; m++) {
      const at = index[m];
      const base = m * stride;
      const prev = state[base];
      let delta: number;
      if (e) {
        const curl = e.curl[at];
        if (curl === 0) continue;
        delta = (courant * (field[at] - e.decay[at] * prev)) / curl;
      } else {
        delta = field[at] - prev;
      }
      const rec = medium[m] * words;
      const count = media[rec + 2];
      let hist = 0;
      for (let k = 0; k < count; k++) {
        const c = rec + MEDIUM_HEADER + POLE_WORDS * k;
        hist += media[c] * state[base + 1 + 2 * k] + media[c + 1] * state[base + 2 + 2 * k];
      }
      const next = media[rec] * prev + media[rec + 1] * (delta - hist);
      for (let k = 0; k < count; k++) {
        const c = rec + MEDIUM_HEADER + POLE_WORDS * k;
        const p = state[base + 1 + 2 * k];
        state[base + 1 + 2 * k] = p + media[c] * p + media[c + 1] * state[base + 2 + 2 * k] + media[c + 2] * next + media[c + 3] * prev;
        state[base + 2 + 2 * k] = p;
      }
      field[at] = next;
    }
  }
}

/**
 * [volume, stand-in] per listed edge of model.dispersion[field], the weights
 * energy() gives the edge: the volume it stands for in units of the smallest
 * cell, and the eps_r the plain sum counts it with (1 for H). An E edge with
 * eCurl 0 gets volume 0: it counts in neither sum. dispersion.wgsl reads the
 * same table.
 */
export function energyFactors(model: VoxelModel, field: 'e' | 'h'): Float32Array | undefined {
  const d = model.dispersion?.[field];
  if (!d) return undefined;
  const { nx, ny, nz, courant: Sc } = model.grid;
  const N = nx * ny * nz;
  const { cpml, eDecay, eCurl } = model;
  const out = new Float32Array(2 * d.index.length);
  d.index.forEach((at, m) => {
    if (field === 'e' && eCurl[at] === 0) return;
    const axis = Math.floor(at / N);
    const c = at - axis * N;
    const node = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))];
    const profiles = [cpml.x, cpml.y, cpml.z];
    // An E edge spans a cell along its axis and dual cells across it; an H edge the reverse.
    let volume = 1;
    for (let a = 0; a < 3; a++) {
      const along = (a === axis) === (field === 'e');
      volume /= (along ? profiles[a].hDiffScale : profiles[a].eDiffScale)[node[a]];
    }
    out[2 * m] = volume;
    out[2 * m + 1] = field === 'e' ? (Sc * (1 + eDecay[at])) / (2 * eCurl[at]) : 1;
  });
  return out;
}
