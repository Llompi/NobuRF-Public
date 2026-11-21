import { interp, type PortSpectrum } from './port_dft';
import type { SimTelemetry } from './types';

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
/** JSON has no Infinity/NaN (they serialize as null and confuse the agent). Clamp to a large sentinel. */
const safe = (x: number) => (Number.isFinite(x) ? x : Number.isNaN(x) ? 0 : Math.sign(x) * 1e6);

export interface TelemetryInput {
  spec: PortSpectrum;
  targetGHz: number;
  it: number;
  solveMs: number;
  steps: number;
  warn?: string[];
  curvePoints?: number;
}

/**
 * Reduce a full port spectrum to the few numbers an agent needs to pick its
 * next edit. Budget: the serialized JSON of telemetry + geometry DSL must stay
 * under 1,600 characters (~400 tokens); see tests/token_budget.test.ts.
 */
export function buildTelemetry(inp: TelemetryInput): SimTelemetry {
  const { spec, targetGHz } = inp;
  const f = spec.fGHz;
  const s = spec.s11Db;
  let iMin = 0;
  for (let m = 1; m < s.length; m++) if (s[m] < s[iMin]) iMin = m;

  // -10 dB bandwidth: walk outward from the dip while S11 stays below -10 dB.
  let bw = 0;
  if (s[iMin] <= -10) {
    let lo = iMin, hi = iMin;
    while (lo > 0 && s[lo - 1] <= -10) lo--;
    while (hi < s.length - 1 && s[hi + 1] <= -10) hi++;
    bw = f[hi] - f[lo];
  }

  const nPts = inp.curvePoints ?? 12;
  const curve: Array<[number, number]> = [];
  for (let p = 0; p < nPts; p++) {
    const fg = f[0] + ((f[f.length - 1] - f[0]) * p) / (nPts - 1);
    curve.push([r2(fg), r1(interp(f, s, fg))]);
  }

  const warn = [...(inp.warn ?? [])];
  if (spec.residual > 0.02) {
    warn.push(`ringdown_incomplete(${Math.round(spec.residual * 100)}%): increase steps; S11 depth is approximate`);
  }
  // Measured: inset 4 mm reads -19 dB at 3000 steps and -25 dB at 6000, while f0 does not move.
  // The port voltage has rung down by then, so the residual check above stays quiet; flag depth directly.
  if (s[iMin] < -20) warn.push('deep_dip: depth below -20 dB is not converged at this step count; treat it as "below -20 dB"');
  // A dip pinned to a band edge usually means the real resonance is outside the band.
  if (iMin === 0 || iMin === s.length - 1) warn.push('dip_at_band_edge: true f0 may be outside the sweep');

  return {
    it: inp.it,
    target_ghz: targetGHz,
    f0_ghz: r2(f[iMin]),
    s11_min_db: r1(s[iMin]),
    s11_at_target_db: r1(interp(f, s, targetGHz)),
    zin_target: [Math.round(safe(interp(f, spec.zRe, targetGHz))), Math.round(safe(interp(f, spec.zIm, targetGHz)))],
    bw10_ghz: r2(bw),
    curve,
    solve_ms: Math.round(inp.solveMs),
    steps: inp.steps,
    warn,
  };
}
