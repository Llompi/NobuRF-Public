/**
 * Low-pass step responses from S-parameters, as a VNA's time-domain option
 * computes them: S on a harmonic grid from DC (the band's step, f_k = k df),
 * a Kaiser window, the inverse transform to the impulse response and its
 * running sum to the step response. From a reflection term that is a TDR
 * (impedance against round-trip time); from a transmission term a TDT, whose
 * 50 % crossing is the delay through the network.
 *
 * Below the band's lowest frequency there is no data: S is extrapolated
 * linearly to a real value at DC, from the two lowest points. The trace is
 * exact only to the extent that guess is; a band starting near DC (f_min a
 * few df) keeps it small.
 */

type C = [re: number, im: number];

export interface StepResponse {
  /** Time, ns; the trace starts at 0. */
  tNs: Float64Array;
  /** Response to a unit step at t = 0. */
  step: Float64Array;
  /** 10-90 % rise time of the windowed step itself, ps: the time resolution of the trace. */
  riseTimePs: number;
}

export interface TdrTrace {
  /** Round-trip time, ns. */
  tNs: Float64Array;
  /** Impedance seen from the port, ohm. */
  zOhm: Float64Array;
  /** 10-90 % rise time of the step the trace corresponds to, ps. */
  riseTimePs: number;
}

/** Kaiser window, beta 6: the usual low-pass TDR compromise between ringing and rise time. */
function kaiser(n: number, length: number, beta = 6): number {
  const i0 = (x: number) => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 30; k++) {
      term *= (x / (2 * k)) ** 2;
      sum += term;
    }
    return sum;
  };
  const r = n / length;
  return i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0(beta);
}

/** Step response of one S term (re[m], im[m] at fGHz[m], an evenly spaced band) over 0 to durationNs. */
export function lowPassStep(fGHz: ArrayLike<number>, re: ArrayLike<number>, im: ArrayLike<number>, durationNs: number): StepResponse {
  const n = fGHz.length;
  if (n < 2) throw new Error('a step response needs at least two frequencies');
  const df = (fGHz[n - 1] - fGHz[0]) / (n - 1);
  const kMax = Math.floor(fGHz[n - 1] / df + 1e-9);
  const at = (fk: number): C => {
    if (fk >= fGHz[0]) {
      // Linear interpolation on the solved grid.
      const x = Math.min(n - 1 - 1e-12, (fk - fGHz[0]) / df);
      const m = Math.floor(x);
      const t = x - m;
      return [re[m] + t * (re[m + 1] - re[m]), im[m] + t * (im[m + 1] - im[m])];
    }
    // Below the band: straight line from the lowest point towards a real DC value.
    const dc = re[0] - ((re[1] - re[0]) / (fGHz[1] - fGHz[0])) * fGHz[0];
    const t = fk / fGHz[0];
    return [dc + t * (re[0] - dc), t * im[0]];
  };
  const window = Array.from({ length: kMax + 1 }, (_, k) => kaiser(k, kMax + 1));
  const spectrum = window.map((w, k): C => {
    const v = at(k * df);
    return [v[0] * w, v[1] * w];
  });
  // Sixteen samples per period of the highest frequency, so the running sum is accurate and the trace smooth;
  // start before t = 0, as the windowed impulse spreads both ways.
  const fTop = fGHz[n - 1];
  const dtNs = 1 / (16 * fTop);
  const leadNs = 4 / fTop;
  const steps = Math.min(Math.ceil((durationNs + leadNs) / dtNs), 40000);
  const running = stepResponse(spectrum, df, dtNs, -leadNs, steps);
  const keep = running.findIndex((_, i) => -leadNs + i * dtNs >= 0);
  const tNs = Float64Array.from({ length: steps - keep }, (_, i) => -leadNs + (keep + i) * dtNs);
  // Rise time: the same transform of a perfect short-to-open step (S = 1 at every frequency).
  const unit = stepResponse(window.map((w): C => [w, 0]), df, dtNs / 4, -leadNs, Math.ceil((2 * leadNs) / (dtNs / 4)));
  const t10 = unit.findIndex((v) => v >= 0.1);
  const t90 = unit.findIndex((v) => v >= 0.9);
  return { tNs, step: running.subarray(keep), riseTimePs: ((t90 - t10) * dtNs * 1000) / 4 };
}

/** Step TDR from a reflection term: Z = Zref (1 + rho) / (1 - rho) along the round-trip time. */
export function stepTdr(fGHz: ArrayLike<number>, re: ArrayLike<number>, im: ArrayLike<number>, zRef: number, durationNs: number): TdrTrace {
  const { tNs, step, riseTimePs } = lowPassStep(fGHz, re, im, durationNs);
  const zOhm = Float64Array.from(step, (r) => {
    const c = Math.max(-0.999, Math.min(0.999, r));
    return (zRef * (1 + c)) / (1 - c);
  });
  return { tNs, zOhm, riseTimePs };
}

/**
 * When a step through a network (a TDT) first reaches `fraction` of the level
 * it settles to, ns, interpolated between samples. The settled level is the
 * median of the last fifth of the trace, so the trace must run well past the
 * delay. With a symmetric window the 50 % crossing of a pure delay sits
 * exactly at the delay, whatever the rise time.
 */
export function crossingTimeNs(r: StepResponse, fraction = 0.5): number {
  const tail = Array.from(r.step.subarray(Math.floor(0.8 * r.step.length))).sort((a, b) => a - b);
  const settled = tail[Math.floor(tail.length / 2)];
  if (!(Math.abs(settled) > 0.05)) throw new Error(`the step settles at ${settled.toFixed(3)}, too little for a transmission delay: is this a through path?`);
  const level = fraction * settled;
  const above = (v: number) => (settled > 0 ? v >= level : v <= level);
  const k = r.step.findIndex(above);
  if (k <= 0) throw new Error('the step is already past its crossing at t = 0: the trace must start before the delay');
  const [t0, t1, v0, v1] = [r.tNs[k - 1], r.tNs[k], r.step[k - 1], r.step[k]];
  return t0 + ((level - v0) / (v1 - v0)) * (t1 - t0);
}

/** Running integral (trapezoidal) of the impulse response df (S0 + 2 Re sum S_k e^{j 2 pi k df t}), from t0 in `steps` steps of dt. */
function stepResponse(spectrum: C[], df: number, dtNs: number, t0Ns: number, steps: number): Float64Array {
  const out = new Float64Array(steps);
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = t0Ns + i * dtNs;
    let h = spectrum[0][0];
    for (let k = 1; k < spectrum.length; k++) {
      const phase = 2 * Math.PI * k * df * t;
      h += 2 * (spectrum[k][0] * Math.cos(phase) - spectrum[k][1] * Math.sin(phase));
    }
    // Trapezoidal: the sum up to t, not up to t + dt, so a delay reads without a half-sample bias.
    sum += h * df * dtNs;
    out[i] = sum - (h * df * dtNs) / 2;
  }
  return out;
}
