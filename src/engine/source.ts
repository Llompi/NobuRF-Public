import type { ExcitationConfig } from './types';

/**
 * Gaussian-modulated sine:  vs(t) = exp(-((t - t0)/tau)^2) * sin(2 pi fc (t - t0))
 *
 * The pulse spectrum is a Gaussian centred on fc with 1/e half-width
 * 1/(pi*tau). We make it as wide as the whole analysis band so the band edges
 * still get ~-9 dB of drive (plenty for a V/I ratio), while keeping the pulse
 * short in time. A short pulse leaves more of the step budget for ring-down,
 * which is what actually limits S11 accuracy on a resonant patch.
 */
export interface SourceParams {
  fcHz: number;
  tauSec: number;
  t0Sec: number;
  amplitude: number;
}

export function sourceParams(exc: ExcitationConfig): SourceParams {
  const fc = ((exc.fMinGHz + exc.fMaxGHz) / 2) * 1e9;
  const span = (exc.fMaxGHz - exc.fMinGHz) * 1e9;
  const tau = 1 / (Math.PI * span);
  return { fcHz: fc, tauSec: tau, t0Sec: 3.5 * tau, amplitude: 1 };
}

export function sourceValue(p: SourceParams, tSec: number): number {
  const u = (tSec - p.t0Sec) / p.tauSec;
  return p.amplitude * Math.exp(-u * u) * Math.sin(2 * Math.PI * p.fcHz * (tSec - p.t0Sec));
}

/** Steps after which the source is effectively off (|vs| < 1e-6). */
export function sourceEndStep(p: SourceParams, dtSec: number): number {
  return Math.ceil((p.t0Sec + 3.72 * p.tauSec) / dtSec);
}
