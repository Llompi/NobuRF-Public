/** Closed-form microstrip references shared by the validation scripts. */

const FREE_SPACE_IMPEDANCE_OHM = 376.730313668;

/**
 * Hammerstad and Jensen, "Accurate models for microstrip computer-aided
 * design," IEEE MTT-S Int. Microwave Symp. Digest, 1980, pp. 407-409: static
 * effective permittivity (their eqs. for a(u), b(eps_r)) and impedance of a
 * zero-thickness strip, u = W/h. Quoted accuracy: 0.2 % for eps_eff
 * (eps_r <= 128, 0.01 <= u <= 100), 0.01 % for Z0 in air (u <= 1000).
 */
export function hammerstadJensenStatic(widthOverHeight: number, epsR: number): { epsEff: number; z0Ohm: number; z0AirOhm: number } {
  const u = widthOverHeight;
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
  const b = 0.564 * ((epsR - 0.9) / (epsR + 3)) ** 0.053;
  const epsEff = (epsR + 1) / 2 + ((epsR - 1) / 2) * (1 + 10 / u) ** (-a * b);
  const fu = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528));
  const z0AirOhm = (FREE_SPACE_IMPEDANCE_OHM / (2 * Math.PI)) * Math.log(fu / u + Math.sqrt(1 + (2 / u) ** 2));
  return { epsEff, z0Ohm: z0AirOhm / Math.sqrt(epsEff), z0AirOhm };
}

/**
 * Kirschning and Jansen, "Accurate model for effective dielectric constant of
 * microstrip with validity up to millimetre-wave frequencies," Electronics
 * Letters 18(6), 1982, pp. 272-273: dispersion of eps_eff. fn = f[GHz] * h[mm].
 */
export function kirschningJansenEpsEff(widthOverHeight: number, epsR: number, staticEpsEff: number, frequencyGHz: number, heightMm: number): number {
  const u = widthOverHeight;
  const fn = frequencyGHz * heightMm;
  const p1 = 0.27488 + (0.6315 + 0.525 / (1 + 0.0157 * fn) ** 20) * u - 0.065683 * Math.exp(-8.7513 * u);
  const p2 = 0.33622 * (1 - Math.exp(-0.03442 * epsR));
  const p3 = 0.0363 * Math.exp(-4.6 * u) * (1 - Math.exp(-((fn / 38.7) ** 4.97)));
  const p4 = 1 + 2.751 * (1 - Math.exp(-((epsR / 15.916) ** 8)));
  const p = p1 * p2 * ((0.1844 + p3 * p4) * fn) ** 1.5763;
  return epsR - (epsR - staticEpsEff) / (1 + p);
}

/**
 * Conductor loss of a microstrip of thickness t, strip and ground, in Np/m:
 * Pucel, Massé and Hartwig, "Losses in microstrip," IEEE Trans. MTT 16(6),
 * 1968, pp. 342-350, in the form of Gupta, Garg, Bahl and Bhartia,
 * "Microstrip Lines and Slotlines." The ln(2h/t) term is the current crowding
 * at the strip edges; it grows without bound as t -> 0. The narrow branch
 * (W/h < 1/(2 pi)) is not implemented. The two fits meet at W/h = 2 with a
 * step of about 12 %. Lengths in mm.
 */
export function pucelConductorLossNpPerM(widthMm: number, heightMm: number, thicknessMm: number, z0Ohm: number, rsOhm: number): number {
  const w = widthMm, h = heightMm, t = thicknessMm;
  if (w / h < 1 / (2 * Math.PI)) throw new Error('pucelConductorLossNpPerM: W/h below 1/(2 pi) is not implemented');
  const we = w + (t / Math.PI) * (1 + Math.log((2 * h) / t));
  const edge = 1 + h / we + (h / (Math.PI * we)) * (Math.log((2 * h) / t) - t / h);
  const shape = w / h <= 2
    ? (1 / (2 * Math.PI)) * (1 - (we / (4 * h)) ** 2)
    : (we / h + we / (Math.PI * h) / (we / (2 * h) + 0.94)) / (we / h + (2 / Math.PI) * Math.log(2 * Math.PI * Math.E * (we / (2 * h) + 0.94))) ** 2;
  return (shape * edge * rsOhm) / (z0Ohm * h * 1e-3);
}
