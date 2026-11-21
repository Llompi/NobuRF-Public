/**
 * Frequency-dependent surface impedance of copper sheets: the skin effect
 * (Rs grows as sqrt(f)) and surface roughness, as a causal impedance the
 * time-domain update can apply.
 *
 * A good conductor thick compared with the skin depth has
 *   Zs(f) = (1 + j) Rs(f),  Rs(f) = sqrt(pi f mu0 / sigma)
 * (Ramo, Whinnery and Van Duzer, "Fields and Waves in Communication
 * Electronics", sec. 3.17), and a rough one Re Zs = K(f) Rs(f), K the
 * roughness factor of the models below. The impedance is fitted on the band
 * with non-negative high-pass terms,
 *   z(f) = r0 + sum_k w_k (j f / f_k) / (1 + j f / f_k),
 * each a resistor w_k in parallel with an inductor, so z is causal and
 * passive by construction. z is relative to Rs of smooth copper at
 * the loss reference frequency, which the sheets carry (rsOhm), so one
 * shape serves every edge of a conductor whatever its edge-loss factor.
 *
 * In the update each term is h minus a low-passed copy of h (sheetFaceLoss in
 * voxelize.ts, applyFaceLoss in fdtd_cpu.ts, sheet_loss.wgsl).
 */
import { nnls } from './nnls';

const MU0 = 4e-7 * Math.PI;

/** Skin depth sqrt(1 / (pi f mu0 sigma)) in metres. */
export function skinDepthM(conductivitySPerM: number, fHz: number): number {
  return 1 / Math.sqrt(Math.PI * fHz * MU0 * conductivitySPerM);
}

/**
 * Surface roughness of a copper foil:
 *  - hammerstad: Hammerstad and Jensen, "Accurate models for microstrip
 *    computer-aided design", IEEE MTT-S Digest 1980, 407-409:
 *    K = 1 + (2 / pi) atan(1.4 (rms / delta)^2). Saturates at 2.
 *  - groisse: Groisse, Bardi, Biro, Preis and Richter, "Parameters of lossy
 *    cavity resonators calculated by the finite element method", IEEE Trans.
 *    Magnetics 32(3), 894-897, 1996: K = 1 + exp(-(delta / (2 rms))^1.6).
 *    Saturates at 2.
 *  - huray: Huray et al., "Impact of copper surface texture on loss: a
 *    model that works", DesignCon 2010, with one sphere size (the
 *    "cannonball" form of Simonovich, DesignCon 2015):
 *    K = 1 + (3 / 2) SR / (1 + delta / a + delta^2 / (2 a^2)),
 *    a the sphere radius and SR = N 4 pi a^2 / A_flat the spheres' surface
 *    over the flat area they sit on. Grows past 2 for rough foils.
 */
export type Roughness =
  | { model: 'hammerstad'; rmsUm: number }
  | { model: 'groisse'; rmsUm: number }
  | { model: 'huray'; radiusUm: number; surfaceRatio: number };

export function roughnessFactor(r: Roughness | null, conductivitySPerM: number, fHz: number): number {
  if (!r) return 1;
  const delta = skinDepthM(conductivitySPerM, fHz);
  switch (r.model) {
    case 'hammerstad': return 1 + (2 / Math.PI) * Math.atan(1.4 * (r.rmsUm * 1e-6 / delta) ** 2);
    case 'groisse': return 1 + Math.exp(-((delta / (2 * r.rmsUm * 1e-6)) ** 1.6));
    case 'huray': {
      const a = r.radiusUm * 1e-6;
      return 1 + (1.5 * r.surfaceRatio) / (1 + delta / a + (delta * delta) / (2 * a * a));
    }
  }
}

/** High-pass corner frequencies shared by every conductor of one model, and each conductor's weights on them. */
export interface SurfaceShape {
  /** Frequency-independent part, relative to smooth Rs at the reference. */
  r0: number;
  /** Weight of each high-pass term, relative to smooth Rs at the reference. */
  weights: number[];
}

export interface SurfacePoles {
  cornerHz: number[];
}

/** Corners per decade, and decades of corners beyond the band on each side. */
const CORNERS_PER_DECADE = 3;
const GUARD_DECADES = 1;
/**
 * Weight of the reactance rows against the resistance rows. The resistance is
 * what the loss depends on and all the roughness models give, so it is fitted
 * to 1e-3; this little weight on the reactance pins the shape outside the
 * band, so smooth copper also comes out with X = R in the band (to 0.2 %).
 * A rough surface's reactance is whatever the causal fit makes of it: the
 * models say nothing about it, and next to a line's own inductance it is
 * small (X / (w L) is about skin depth / substrate height).
 */
const REACTANCE_WEIGHT = 0.003;
/** Band samples the impedance is fitted on, log-spaced. */
const FIT_SAMPLES = 60;

/** The corner frequencies for a band: log-spaced from a decade below to a decade above it. */
export function surfacePoles(fMinHz: number, fMaxHz: number): SurfacePoles {
  if (!(fMinHz > 0 && fMaxHz > fMinHz)) throw new Error(`surface impedance band needs 0 < f_min < f_max, got ${fMinHz} to ${fMaxHz} Hz`);
  const lo = Math.log10(fMinHz) - GUARD_DECADES;
  const hi = Math.log10(fMaxHz) + GUARD_DECADES;
  const count = Math.ceil((hi - lo) * CORNERS_PER_DECADE) + 1;
  return { cornerHz: Array.from({ length: count }, (_, n) => 10 ** (lo + ((hi - lo) * n) / (count - 1))) };
}

/** z(f) of a fitted shape, relative to smooth Rs at the reference. */
export function shapeImpedance(shape: SurfaceShape, poles: SurfacePoles, fHz: number): [number, number] {
  let re = shape.r0;
  let im = 0;
  poles.cornerHz.forEach((fk, k) => {
    const x = fHz / fk;
    re += (shape.weights[k] * x * x) / (1 + x * x);
    im += (shape.weights[k] * x) / (1 + x * x);
  });
  return [re, im];
}

/**
 * Fits (1 + j) sqrt(f / fRef) K(f), the conductor's impedance relative to
 * smooth Rs at fRef, on [fMin, fMax] in relative terms, real and imaginary
 * parts alike. For smooth copper that is the exact skin-effect impedance.
 * The roughness models give only a resistance, which the fit follows; see
 * REACTANCE_WEIGHT for the reactance.
 * Returns the shape and the worst relative error in the band of its
 * resistance and of its reactance.
 */
export function fitSurfaceShape(
  conductivitySPerM: number, roughness: Roughness | null, fMinHz: number, fMaxHz: number, fRefHz: number, poles: SurfacePoles,
): { shape: SurfaceShape; resistanceError: number; reactanceError: number } {
  const freqs = Array.from({ length: FIT_SAMPLES }, (_, n) => fMinHz * (fMaxHz / fMinHz) ** (n / (FIT_SAMPLES - 1)));
  const target = (f: number) => Math.sqrt(f / fRefHz) * roughnessFactor(roughness, conductivitySPerM, f);
  // Each row divided by its target: the fit is relative, so the low end of the band counts as much as the high.
  const rows = freqs.flatMap((f) => {
    const t = target(f);
    const x = poles.cornerHz.map((fk) => f / fk);
    return [
      [1 / t, ...x.map((v) => (v * v) / (1 + v * v) / t)],
      [0, ...x.map((v) => (REACTANCE_WEIGHT * v) / (1 + v * v) / t)],
    ];
  });
  const solution = nnls(rows, rows.map((_, n) => (n % 2 === 0 ? 1 : REACTANCE_WEIGHT)));
  const shape = { r0: solution[0], weights: solution.slice(1) };
  const errors = freqs.map((f) => shapeImpedance(shape, poles, f).map((part) => Math.abs(part / target(f) - 1)));
  return { shape, resistanceError: Math.max(...errors.map((e) => e[0])), reactanceError: Math.max(...errors.map((e) => e[1])) };
}
