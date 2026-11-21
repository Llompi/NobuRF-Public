/**
 * Transmission-line parameters of a straight strip between two ports:
 * Z0, eps_eff and loss from the fields along it (lineFromFields). The step
 * TDR the Line view shows is in engine/time_domain.ts.
 *
 * Why not from the S-matrix alone: the lumped ports at the line ends add
 * their own series inductance and shunt capacitance inside the reference
 * planes. On a 1.6 mm FR-4 line a single-line S-matrix extraction read
 * eps_eff 5.3 for a line whose closed-form value is 3.3. The field fit
 * looks only at the middle of the line, where the ports have no say.
 */

/** mm per ns, the speed of light. */
const C_MM_PER_NS = 299.792458;

type C = [re: number, im: number];
const sub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]];
const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a: C, b: C): C => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const sqrt = (a: C): C => {
  const r = Math.hypot(a[0], a[1]);
  const re = Math.sqrt((r + a[0]) / 2);
  const im = Math.sign(a[1] || 1) * Math.sqrt(Math.max(0, (r - a[0]) / 2));
  return [re, im];
};
const abs = (a: C) => Math.hypot(a[0], a[1]);

/** Free-space wave impedance, ohm. */
const ETA0 = 376.730313668;

export interface LineFromFields {
  fGHz: number;
  z0: number;
  epsEff: number;
  lossDbPerMm: number;
  /** The stretch of line the fit used (mm along the line) and how well the telegrapher equations fit it (0 = exactly). */
  fromMm: number;
  toMm: number;
  residual: number;
}

/** What the field fit needs from a solve: the field planes and where the two ports are. */
export interface LineFieldInput {
  xMm: ArrayLike<number>;
  yMm: ArrayLike<number>;
  /** Thickness of the dielectric between the strip and its ground, the span Ez is integrated over. */
  substrateMm: number;
  planes: Array<{ frequencyGHz: number; ez: { re: ArrayLike<number>; im: ArrayLike<number> }; jx: { re: ArrayLike<number>; im: ArrayLike<number> }; jy: { re: ArrayLike<number>; im: ArrayLike<number> } }>;
  ports: [{ xMm: number; yMm: number }, { xMm: number; yMm: number }];
}

/**
 * Z0, eps_eff and loss from the fields along the middle of a straight line,
 * away from both ports, so the ports' own parasitics drop out (the S-matrix
 * extraction above cannot separate them).
 *
 * At every mesh line across the strip: V = Ez h under the strip's centre
 * (Ez at mid-substrate), I = the integral of the strip's surface current
 * across it. A TEM or quasi-TEM line obeys dV/ds = -Z I and dI/ds = -Y V; a
 * least-squares fit of Z and Y over the middle of the line gives
 * gamma = sqrt(Z Y) and Z0 = sqrt(Z / Y), whatever standing wave the port
 * mismatches set up. The ends within max(3 h, 1 mm) of a port are left out.
 * Units: e and h are the solver's normalised fields (e = E dRef,
 * h = eta0 H dRef), so Z0 = eta0 sqrt(Z' / Y') in them.
 */
export function lineFromFields(input: LineFieldInput): LineFromFields[] {
  const [p1, p2] = input.ports;
  const alongY = Math.abs(p2.yMm - p1.yMm) >= Math.abs(p2.xMm - p1.xMm);
  if (Math.abs(alongY ? p2.xMm - p1.xMm : p2.yMm - p1.yMm) > 1e-6) throw new Error('the two ports must sit on a line parallel to x or y');
  const across = alongY ? input.xMm : input.yMm;
  const along = alongY ? input.yMm : input.xMm;
  const centre = alongY ? p1.xMm : p1.yMm;
  const [start, end] = alongY ? [p1.yMm, p2.yMm].sort((a, b) => a - b) : [p1.xMm, p2.xMm].sort((a, b) => a - b);
  const margin = Math.max(3 * input.substrateMm, 1);
  const nx = input.xMm.length;
  const nearest = (lines: ArrayLike<number>, v: number) => {
    let best = 0;
    for (let n = 1; n < lines.length; n++) if (Math.abs(lines[n] - v) < Math.abs(lines[best] - v)) best = n;
    return best;
  };
  const ic = nearest(across, centre);
  const ks: number[] = [];
  for (let k = 0; k < along.length; k++) if (along[k] >= start + margin && along[k] <= end - margin) ks.push(k);
  if (ks.length < 4) throw new Error(`the line is too short for a field fit: it needs more than ${(2 * margin).toFixed(1)} mm between the ports`);
  const index = (a: number, k: number) => (alongY ? a + nx * k : k + nx * a);
  // Widths of the cells around each node across the line, for the current integral.
  const dual = Array.from(across, (_, a) => ((across[Math.min(a + 1, across.length - 1)] - across[Math.max(a - 1, 0)]) / 2));

  return input.planes.map((plane) => {
    const j = alongY ? plane.jy : plane.jx;
    const V: C[] = ks.map((k) => [plane.ez.re[index(ic, k)] * input.substrateMm, plane.ez.im[index(ic, k)] * input.substrateMm]);
    // The strip's own current only: outward from the centre line until the surface current drops into the gap
    // beside the strip, so return current in a top-layer ground pour or a neighbouring line does not cancel it.
    const I: C[] = ks.map((k) => {
      const magnitude = (a: number) => Math.hypot(j.re[index(a, k)], j.im[index(a, k)]);
      let peak = 0;
      for (let a = 0; a < across.length; a++) peak = Math.max(peak, magnitude(a));
      const onStrip = (a: number) => magnitude(a) > 0.02 * peak;
      let [lo, hi] = [ic, ic];
      while (lo > 0 && onStrip(lo - 1)) lo--;
      while (hi < across.length - 1 && onStrip(hi + 1)) hi++;
      // Then the tail past the strip edge, as long as it keeps falling: the bottom of the gap is where the strip ends.
      while (lo > 0 && magnitude(lo - 1) < magnitude(lo)) lo--;
      while (hi < across.length - 1 && magnitude(hi + 1) < magnitude(hi)) hi++;
      let re = 0;
      let im = 0;
      for (let a = lo; a <= hi; a++) {
        re += j.re[index(a, k)] * dual[a];
        im += j.im[index(a, k)] * dual[a];
      }
      return [re, im];
    });
    // Least squares, segment by segment: dV/ds = -Z I_mid, dI/ds = -Y V_mid.
    let [zNum, zDen, yNum, yDen]: [C, number, C, number] = [[0, 0], 0, [0, 0], 0];
    for (let n = 0; n + 1 < ks.length; n++) {
      const ds = along[ks[n + 1]] - along[ks[n]];
      const dV: C = [(V[n + 1][0] - V[n][0]) / ds, (V[n + 1][1] - V[n][1]) / ds];
      const dI: C = [(I[n + 1][0] - I[n][0]) / ds, (I[n + 1][1] - I[n][1]) / ds];
      const iMid: C = [(I[n][0] + I[n + 1][0]) / 2, (I[n][1] + I[n + 1][1]) / 2];
      const vMid: C = [(V[n][0] + V[n + 1][0]) / 2, (V[n][1] + V[n + 1][1]) / 2];
      // Z = -sum(dV conj(I)) / sum(|I|^2), likewise Y.
      zNum = sub(zNum, mul(dV, [iMid[0], -iMid[1]]));
      zDen += iMid[0] ** 2 + iMid[1] ** 2;
      yNum = sub(yNum, mul(dI, [vMid[0], -vMid[1]]));
      yDen += vMid[0] ** 2 + vMid[1] ** 2;
    }
    const z: C = [zNum[0] / zDen, zNum[1] / zDen];
    const y: C = [yNum[0] / yDen, yNum[1] / yDen];
    let gamma = sqrt(mul(z, y));
    if (gamma[1] < 0) gamma = [-gamma[0], -gamma[1]];
    let z0 = sqrt(div(z, y));
    if (z0[0] < 0) z0 = [-z0[0], -z0[1]];
    // How far the measured V and I are from the two fitted line equations, relative to their size; the worse of the two.
    const misfitOf = (a: C[], b: C[], coefficient: C) => {
      let misfit = 0;
      let size = 0;
      for (let n = 0; n + 1 < ks.length; n++) {
        const ds = along[ks[n + 1]] - along[ks[n]];
        const mid: C = [(b[n][0] + b[n + 1][0]) / 2, (b[n][1] + b[n + 1][1]) / 2];
        const slope: C = [-(a[n + 1][0] - a[n][0]) / ds, -(a[n + 1][1] - a[n][1]) / ds];
        misfit += abs(sub(slope, mul(coefficient, mid))) ** 2;
        size += abs(slope) ** 2;
      }
      return Math.sqrt(misfit / size);
    };
    const lambda0Mm = C_MM_PER_NS / plane.frequencyGHz;
    return {
      fGHz: plane.frequencyGHz,
      z0: ETA0 * abs(z0),
      epsEff: ((gamma[1] * lambda0Mm) / (2 * Math.PI)) ** 2,
      // Signed: a passive line has alpha > 0 here, so a negative value marks a failed fit, not a gain.
      lossDbPerMm: (20 / Math.LN10) * gamma[0],
      fromMm: along[ks[0]],
      toMm: along[ks.at(-1)!],
      residual: Math.max(misfitOf(V, I, z), misfitOf(I, V, y)),
    };
  });
}
