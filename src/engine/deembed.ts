import { solveComplex, type Complex, type ScatteringResult } from './port_dft';

/**
 * Network arithmetic for de-embedding: removing the port and a length of feed
 * line from a solved S-matrix, so the result refers to a plane on the line.
 *
 * A two-port is kept as its ABCD (transfer) matrix, [V1; I1] = M [V2; I2],
 * which cascades by multiplication. The error box of one port is the ABCD of
 * "port, then feed line" from the external port to the reference plane.
 *
 * The error box comes from calibration standards solved with the same port
 * and feed: a mirror-symmetric thru (two feeds back to back) and lines longer
 * than it. This is the thru-line method of Engen and Hoer (TRL, 1979), with
 * the mirror symmetry of the thru standing in for the reflect standard, as in
 * the textbook exam's calibration (scripts/textbook_exam/network.py), which
 * this module reproduces.
 */

/** ABCD of a two-port at one frequency: [[a, b], [c, d]]. */
export interface Abcd {
  a: Complex;
  b: Complex;
  c: Complex;
  d: Complex;
}

/** S of a two-port at one frequency. */
export interface TwoPortS {
  s11: Complex;
  s12: Complex;
  s21: Complex;
  s22: Complex;
}

const add = ([ar, ai]: Complex, [br, bi]: Complex): Complex => [ar + br, ai + bi];
const sub = ([ar, ai]: Complex, [br, bi]: Complex): Complex => [ar - br, ai - bi];
const mul = ([ar, ai]: Complex, [br, bi]: Complex): Complex => [ar * br - ai * bi, ar * bi + ai * br];
const scale = ([ar, ai]: Complex, k: number): Complex => [ar * k, ai * k];
const abs = ([ar, ai]: Complex) => Math.hypot(ar, ai);
const arg = ([ar, ai]: Complex) => Math.atan2(ai, ar);

function div([ar, ai]: Complex, [br, bi]: Complex): Complex {
  const den = br * br + bi * bi;
  return [(ar * br + ai * bi) / den, (ai * br - ar * bi) / den];
}

/** Principal square root. */
export function csqrt([re, im]: Complex): Complex {
  const r = Math.hypot(re, im);
  const x = Math.sqrt((r + re) / 2);
  const y = Math.sqrt(Math.max(0, (r - re) / 2));
  return [x, im < 0 ? -y : y];
}

/** Principal logarithm. */
const clog = (z: Complex): Complex => [Math.log(abs(z)), arg(z)];

export function sToAbcd({ s11, s12, s21, s22 }: TwoPortS, z0: number): Abcd {
  const one: Complex = [1, 0];
  const d = scale(s21, 2);
  const s12s21 = mul(s12, s21);
  return {
    a: div(add(mul(add(one, s11), sub(one, s22)), s12s21), d),
    b: scale(div(sub(mul(add(one, s11), add(one, s22)), s12s21), d), z0),
    c: scale(div(sub(mul(sub(one, s11), sub(one, s22)), s12s21), d), 1 / z0),
    d: div(add(mul(sub(one, s11), add(one, s22)), s12s21), d),
  };
}

export function abcdToS({ a, b, c, d }: Abcd, z0: number): TwoPortS {
  const bz = scale(b, 1 / z0);
  const cz = scale(c, z0);
  const den = add(add(a, bz), add(cz, d));
  return {
    s11: div(sub(add(a, bz), add(cz, d)), den),
    s12: div(scale(sub(mul(a, d), mul(b, c)), 2), den),
    s21: div([2, 0], den),
    s22: div(sub(add(bz, d), add(a, cz)), den),
  };
}

export function abcdMultiply(x: Abcd, y: Abcd): Abcd {
  return {
    a: add(mul(x.a, y.a), mul(x.b, y.c)),
    b: add(mul(x.a, y.b), mul(x.b, y.d)),
    c: add(mul(x.c, y.a), mul(x.d, y.c)),
    d: add(mul(x.c, y.b), mul(x.d, y.d)),
  };
}

export function abcdInverse(m: Abcd): Abcd {
  const det = sub(mul(m.a, m.d), mul(m.b, m.c));
  return { a: div(m.d, det), b: div(scale(m.b, -1), det), c: div(scale(m.c, -1), det), d: div(m.a, det) };
}

/** ABCD of a uniform line: propagation constant gamma (per mm), length in mm, impedance z. */
export function lineAbcd(gammaPerMm: Complex, lengthMm: number, z: Complex): Abcd {
  const [gr, gi] = scale(gammaPerMm, lengthMm);
  // cosh and sinh of a complex argument.
  const cosh: Complex = [Math.cosh(gr) * Math.cos(gi), Math.sinh(gr) * Math.sin(gi)];
  const sinh: Complex = [Math.sinh(gr) * Math.cos(gi), Math.cosh(gr) * Math.sin(gi)];
  return { a: cosh, b: mul(z, sinh), c: div(sinh, z), d: cosh };
}

/** The two-port S of a two-port ScatteringResult at frequency m (S12 = S_0,1). */
export function twoPortAt(s: ScatteringResult, m: number): TwoPortS {
  const at = (i: number, j: number): Complex => {
    const re = s.re[i][j];
    const im = s.im[i][j];
    if (!re || !im) throw new Error('de-embedding needs every port of the standard excited');
    return [re[m], im[m]];
  };
  return { s11: at(0, 0), s12: at(0, 1), s21: at(1, 0), s22: at(1, 1) };
}

/** Pick z or -z, whichever is nearer `previous`: the sign of a square root followed along frequency. */
function nearer(z: Complex, previous: Complex): Complex {
  return abs(sub(z, previous)) <= abs(add(z, previous)) ? z : scale(z, -1);
}

/**
 * One half of a mirror-symmetric thru, taken as symmetric itself (a = d):
 * thru = H flip(H) gives a^2 = (T11 + 1) / 2, b = T12 / 2a, c = T21 / 2a.
 * Exact for a symmetric half (a uniform line); a port is not symmetric, so
 * this is only used where its parasitics vanish (low frequencies) or where
 * no line standard has a usable phase. The sign of a follows continuity from
 * the first frequency; thruLineErrorBoxes sets the sign of each box itself.
 */
export function halfThru(thru: Abcd[]): Abcd[] {
  let previous: Complex = [1, 0];
  return thru.map((t) => {
    const t11 = scale(add(t.a, t.d), 0.5);
    const a = nearer(csqrt(scale(add(t11, [1, 0]), 0.5)), previous);
    previous = a;
    return { a, b: div(t.b, scale(a, 2)), c: div(t.c, scale(a, 2)), d: a };
  });
}

/** Phase of each value, unwrapped along the list (steps taken as less than pi), starting from the principal value. */
export function unwrappedPhase(values: Complex[]): number[] {
  const out: number[] = [];
  for (const [k, v] of values.entries()) {
    const phase = arg(v);
    if (k === 0) {
      out.push(phase);
      continue;
    }
    const step = phase - arg(values[k - 1]);
    out.push(out[k - 1] + step - 2 * Math.PI * Math.round(step / (2 * Math.PI)));
  }
  return out;
}

/**
 * B or -B, whichever is nearer a lossless line of electrical length theta and
 * impedance z: [[cos, j z sin], [j sin / z, cos]]. The thru fixes the error box
 * only up to its sign (thru = B flip(B) = (-B) flip(-B)); a wrong sign turns
 * the de-embedded transmission by 180 degrees. Theta is half the thru's
 * unwrapped transmission phase, so this holds wherever the port's parasitics
 * turn the phase by less than 90 degrees, at any feed length. (Following the
 * sign along frequency instead fails where a passes through zero, at a quarter
 * wavelength.)
 */
function oriented(box: Abcd, theta: number, z: number): Abcd {
  const [c, s] = [Math.cos(theta), Math.sin(theta)];
  const score = (box.a[0] + box.d[0]) * c + (box.b[1] / z + box.c[1] * z) * s;
  return score >= 0 ? box : { a: scale(box.a, -1), b: scale(box.b, -1), c: scale(box.c, -1), d: scale(box.d, -1) };
}

/** A line standard: its S over the calibration band and how much longer it is than the thru. */
export interface LineStandard {
  s: TwoPortS[];
  extraMm: number;
}

/** Electrical length of the extra line, in degrees, from an effective permittivity guess. */
export function expectedPhaseDeg(fGHz: number, epsEff: number, extraMm: number): number {
  return (360 * fGHz * 1e9 * Math.sqrt(epsEff) * extraMm * 1e-3) / 299_792_458;
}

/** A line standard is used only where its extra length is this far from 0 and 180 degrees (sin >= 0.34). */
export const LINE_PHASE_MARGIN_DEG = 20;

export interface ErrorBoxes {
  /** Per frequency: ABCD from the external port to the reference plane. */
  box: Abcd[];
  /** Per frequency: the line's propagation constant per mm (alpha + j beta) from the line standard; null where none was usable. */
  gammaPerMm: Array<Complex | null>;
  /** Per frequency: index into the line standards of the one used, or null where the symmetric-half estimate was used instead. */
  lineUsed: Array<number | null>;
}

/**
 * Error box of one port (port, feed, up to the middle of the thru) from the
 * thru and the line standards, at every calibration frequency.
 *
 * The thru is A flip(A), and a line adds dL of uniform line between the
 * halves, so M_line M_thru^-1 = A L A^-1, whose eigenvalues are exp(+-gamma dL)
 * whatever the port does (Marks 1991) and whose eigenvector for exp(+gamma dL)
 * is A [Z_line, 1]^T. With det A = 1 (reciprocity) that fixes A up to the
 * line impedance, which no thru-line set can measure (Engen and Hoer 1979):
 * it is passed in. At each frequency the line whose measured phase (from the
 * eigenvalues of line x thru^-1, folded to 0..180 degrees) is nearest 90
 * degrees is used; where none is at least LINE_PHASE_MARGIN_DEG from 0 and
 * 180 degrees, the symmetric half of the thru is used instead. epsEffGuess
 * only picks which eigenvalue is exp(+gamma dL) and unwraps its phase.
 */
export function thruLineErrorBoxes(fGHz: ArrayLike<number>, thru: TwoPortS[], lines: LineStandard[], epsEffGuess: number, zLine: number, z0: number): ErrorBoxes {
  const thruAbcd = thru.map((t) => sToAbcd(t, z0));
  const halves = halfThru(thruAbcd);
  // Electrical length of one half: half the thru's transmission phase (S21 = exp(-j 2 theta)).
  const theta = unwrappedPhase(thru.map((t) => t.s21)).map((phase) => -phase / 2);
  const box: Abcd[] = [];
  const gammaPerMm: Array<Complex | null> = [];
  const lineUsed: Array<number | null> = [];
  for (let k = 0; k < fGHz.length; k++) {
    const t = thruAbcd[k];
    // Each line over the thru: P = L T^-1, whose eigenvalues are exp(+-gamma dL). Their measured
    // phase, folded to [0, 180] degrees, picks the line: the one nearest 90 degrees, where the
    // eigenvectors are best conditioned. The guessed eps_eff only picks the root below, so an
    // error in it cannot choose a line that is near 0 or 180 degrees in fact.
    const measured = lines.map((l) => {
      const p = abcdMultiply(sToAbcd(l.s[k], z0), abcdInverse(t));
      // Eigenvalues of the 2x2 P: (tr +- sqrt(tr^2 - 4 det)) / 2.
      const tr = add(p.a, p.d);
      const det = sub(mul(p.a, p.d), mul(p.b, p.c));
      const root = csqrt(sub(mul(tr, tr), scale(det, 4)));
      const values = [scale(add(tr, root), 0.5), scale(sub(tr, root), 0.5)];
      return { p, values, foldedDeg: (Math.abs(arg(values[0])) * 180) / Math.PI };
    });
    const distance = (n: number) => Math.abs(measured[n].foldedDeg - 90);
    let pick = 0;
    for (let n = 1; n < lines.length; n++) if (distance(n) < distance(pick)) pick = n;
    if (lines.length === 0 || distance(pick) > 90 - LINE_PHASE_MARGIN_DEG) {
      box.push(oriented(halves[k], theta[k], zLine));
      gammaPerMm.push(null);
      lineUsed.push(null);
      continue;
    }
    const { p, values } = measured[pick];
    // A line's ABCD has eigenvalues cosh(gamma l) +- sinh(gamma l) = exp(+-gamma l); exp(+gamma dL)
    // is the one whose phase is nearest the expected +beta dL.
    const wantRad = (expectedPhaseDeg(fGHz[k], epsEffGuess, lines[pick].extraMm) * Math.PI) / 180;
    const miss = (v: Complex) => Math.abs(Math.atan2(Math.sin(arg(v) - wantRad), Math.cos(arg(v) - wantRad)));
    const plus = miss(values[0]) <= miss(values[1]) ? values[0] : values[1];
    // Eigenvector [v0, v1] of P for `plus`: (P - lambda I) v = 0, from the row with the larger off-diagonal (both made dimensionless with zLine).
    const rho = abs(p.b) / zLine >= abs(p.c) * zLine
      ? div(scale(p.b, -1), sub(p.a, plus)) // (a - l) v0 + b v1 = 0
      : div(sub(p.d, plus), scale(p.c, -1)); // c v0 + (d - l) v1 = 0
    const t11 = scale(add(t.a, t.d), 0.5);
    const t11p1 = add(t11, [1, 0]);
    const a2 = div(mul(t11p1, sub(t.b, mul(rho, t11p1))), scale(sub(mul(rho, t.c), t11p1), 2 * zLine));
    const a = csqrt(a2);
    const d = div(t11p1, scale(a, 2));
    box.push(oriented({ a, b: div(t.b, scale(a, 2)), c: div(t.c, scale(d, 2)), d }, theta[k], zLine));
    const logV = clog(plus);
    const turns = Math.round((wantRad - logV[1]) / (2 * Math.PI));
    gammaPerMm.push(scale([logV[0], logV[1] + 2 * Math.PI * turns], 1 / lines[pick].extraMm));
    lineUsed.push(pick);
  }
  return { box, gammaPerMm, lineUsed };
}

/**
 * The line impedance in the limit f -> 0, where the port's parasitics vanish:
 * sqrt(B / C) of the line standard de-embedded with the symmetric half of the
 * thru, fitted as Z0 + c f^2 (least squares) at the frequencies up to fMaxGHz.
 * Returns the fit and the number of points it used.
 */
export function lowFrequencyLineImpedance(fGHz: ArrayLike<number>, thru: TwoPortS[], line: TwoPortS[], z0: number, fMaxGHz: number): { zOhm: number; points: number } {
  const half = halfThru(thru.map((t) => sToAbcd(t, z0)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < fGHz.length && fGHz[k] <= fMaxGHz; k++) {
    const inner = abcdMultiply(abcdMultiply(abcdInverse(half[k]), sToAbcd(line[k], z0)), abcdInverse(flip(half[k])));
    xs.push(fGHz[k] ** 2);
    ys.push(csqrt(div(inner.b, inner.c))[0]);
  }
  if (xs.length < 3) throw new Error(`the line impedance fit needs at least 3 calibration frequencies at or below ${fMaxGHz.toFixed(3)} GHz, got ${xs.length}`);
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
  }
  return { zOhm: my - (sxx > 0 ? sxy / sxx : 0) * mx, points: n };
}

/** The same two-port seen from its other end (a reciprocal network turned round): [[d, b], [c, a]]. */
export function flip(m: Abcd): Abcd {
  return { a: m.d, b: m.b, c: m.c, d: m.a };
}

/**
 * Remove an error box from each port of an N-port. boxes[i][m] is port i's
 * ABCD (external port to reference plane) at frequency m, or boxes[i] null
 * for a port that is not de-embedded. Port i's fixture S is referenced to
 * z0[i] on both sides, so the result keeps each port's reference impedance.
 *
 * With the fixtures' S on the diagonal (F11, F12, F21, F22) and
 * M = (S_measured - F11) F21^-1, the de-embedded S = (F12 + M F22)^-1 M.
 */
export function deembedPorts(s: ScatteringResult, boxes: Array<Abcd[] | null>, z0: number[]): ScatteringResult {
  const n = s.re.length;
  if (boxes.length !== n || z0.length !== n) throw new Error(`de-embedding: ${n} ports but ${boxes.length} error boxes and ${z0.length} impedances`);
  if (s.re.some((row) => row.some((column) => column === null))) throw new Error('de-embedding needs the full S-matrix (every port excited)');
  const nf = s.fGHz.length;
  for (const b of boxes) if (b && b.length !== nf) throw new Error(`de-embedding: an error box has ${b.length} frequencies, the S-matrix ${nf}`);
  const re = s.re.map((row) => row.map(() => new Float64Array(nf)));
  const im = s.re.map((row) => row.map(() => new Float64Array(nf)));
  const through: TwoPortS = { s11: [0, 0], s12: [1, 0], s21: [1, 0], s22: [0, 0] };
  for (let m = 0; m < nf; m++) {
    const f = boxes.map((b, i) => (b ? abcdToS(b[m], z0[i]) : through));
    const measured = (i: number, j: number): Complex => [s.re[i][j]![m], s.im[i][j]![m]];
    // M = (S - F11) F21^-1: column j divided by F21_j.
    const big = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => div(sub(measured(i, j), i === j ? f[i].s11 : [0, 0]), f[j].s21)));
    // F12 + M F22: column j of M times F22_j, plus F12 on the diagonal.
    const lhs = big.map((row, i) => row.map((x, j) => add(mul(x, f[j].s22), i === j ? f[i].s12 : [0, 0])));
    const out = solveComplex(lhs, big);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) [re[i][j][m], im[i][j][m]] = out[i][j];
  }
  return { ...s, re, im };
}
