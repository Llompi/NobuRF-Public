/** f0 and Q of one resonance from a recorded ring-down, shared by the validation scripts. */

/** Complex DFT of rec[from, from + len) at f, Hann window. */
function windowedDft(rec: Float64Array, dt: number, f: number, from: number, len: number): [number, number] {
  let re = 0, im = 0;
  for (let n = 0; n < len; n++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (len - 1));
    const ph = 2 * Math.PI * f * (from + n) * dt;
    re += rec[from + n] * w * Math.cos(ph);
    im -= rec[from + n] * w * Math.sin(ph);
  }
  return [re, im];
}

/**
 * f0 from the phase advance between successive windows, Q from the slope of
 * ln|A| over time: |A| ~ exp(-omega t / 2Q). Both use the whole ring-down after
 * the source has stopped.
 */
export function analyse(rec: Float64Array, dt: number, start: number, fGuess: number) {
  const len = Math.round(20 / (fGuess * dt));
  const hop = Math.floor(len / 2);
  const t: number[] = [], lnA: number[] = [], phase: number[] = [];
  for (let from = start; from + len <= rec.length; from += hop) {
    const [re, im] = windowedDft(rec, dt, fGuess, from, len);
    t.push((from + len / 2) * dt);
    lnA.push(Math.log(Math.hypot(re, im)));
    phase.push(Math.atan2(im, re));
  }
  // Unwrap the phase between windows.
  for (let n = 1; n < phase.length; n++) phase[n] += 2 * Math.PI * Math.round((phase[n - 1] - phase[n]) / (2 * Math.PI));
  const fit = (y: number[]) => {
    const m = t.length;
    const mt = t.reduce((s, v) => s + v, 0) / m, my = y.reduce((s, v) => s + v, 0) / m;
    let sxy = 0, sxx = 0;
    for (let n = 0; n < m; n++) { sxy += (t[n] - mt) * (y[n] - my); sxx += (t[n] - mt) ** 2; }
    return sxy / sxx;
  };
  // The DFT carrier is e^(-j 2 pi fGuess t), so the phase advances at 2 pi (f0 - fGuess).
  const f0 = fGuess + fit(phase) / (2 * Math.PI);
  const decay = -fit(lnA);
  return { f0_ghz: f0 / 1e9, q: decay > 0 ? (Math.PI * f0) / decay : Infinity, windows: t.length };
}
