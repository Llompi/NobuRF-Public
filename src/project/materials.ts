import {
  anchoredResponse, constantResponse, djordjevicSarkarResponse, DS_DEFAULT_F_HIGH_HZ, DS_DEFAULT_F_LOW_HZ, relativeValue, tableResponse, type MediumResponse, type Pole,
} from '../engine/dispersion';
import type { DielectricMaterial, PoleDef } from './schema';

/**
 * The solver's view of a dielectric: its permittivity and permeability as
 * responses (dispersion.ts), or null where the material is the plain case the
 * main kernels already handle (constant eps_r with tan_delta; mu_r = 1).
 */
export interface MaterialResponses {
  permittivity: MediumResponse | null;
  permeability: MediumResponse | null;
  /** What the fit leaves to know about (a measured table fitted loosely, or a band outside it); rasterise shows them per layer. */
  notes?: string[];
}

/** A table fitted worse than this (relative, in eps' or eps'') gets a note. */
export const TABLE_FIT_NOTE = 0.02;

export interface MaterialBand {
  fMinHz: number;
  fMaxHz: number;
  /** analysis.loss_reference_ghz: where a constant loss tangent is exact. */
  lossReferenceHz: number;
}

const toPoles = (defs: PoleDef[]): Pole[] => defs.map((p) => (p.type === 'debye'
  ? { type: 'debye', delta: p.delta, fRelaxHz: p.f_relax_ghz * 1e9 }
  : { type: 'lorentz', delta: p.delta, fResHz: p.f_res_ghz * 1e9, dampingHz: p.damping_ghz * 1e9 }));

/** Throws an Error with a message for the material's path (resolve.ts adds it). */
export function materialResponses(m: DielectricMaterial, band: MaterialBand): MaterialResponses {
  let permittivity: MediumResponse | null = null;
  const notes: string[] = [];
  const d = m.dispersion;
  if (d?.model === 'djordjevic_sarkar') {
    permittivity = djordjevicSarkarResponse({
      epsR: m.eps_r, tanDelta: m.tan_delta, atHz: d.at_ghz * 1e9,
      fLowHz: d.f_low_hz ?? DS_DEFAULT_F_LOW_HZ, fHighHz: d.f_high_hz ?? DS_DEFAULT_F_HIGH_HZ,
    }, band.fMinHz, band.fMaxHz);
  } else if (d?.model === 'poles') {
    permittivity = anchoredResponse(m.eps_r, m.tan_delta, d.at_ghz * 1e9, toPoles(d.poles), 'dispersion');
  } else if (d?.model === 'table') {
    const fit = tableResponse(d.points.map((p) => ({ fHz: p.f_ghz * 1e9, epsR: p.eps_r, tanDelta: p.tan_delta })));
    permittivity = fit.response;
    if (fit.fitError > TABLE_FIT_NOTE) {
      notes.push(`its permittivity table is fitted to ${(fit.fitError * 100).toPrecision(2)} % at worst; no causal material passes closer to every row ` +
        '(eps\' and loss that disagree, or noise), so check the rows');
    }
    const [first, last] = [d.points[0].f_ghz * 1e9, d.points[d.points.length - 1].f_ghz * 1e9];
    if (band.fMinHz < first || band.fMaxHz > last) {
      notes.push(`its permittivity table spans ${d.points[0].f_ghz} to ${d.points[d.points.length - 1].f_ghz} GHz and the analysis band goes beyond it; ` +
        'outside the table the fitted poles extrapolate');
    }
  }
  const muR = m.mu_r ?? 1;
  const muTan = m.mu_tan_delta ?? 0;
  let permeability: MediumResponse | null = null;
  if (m.mu_dispersion) {
    permeability = anchoredResponse(muR, muTan, m.mu_dispersion.at_ghz * 1e9, toPoles(m.mu_dispersion.poles), 'mu_dispersion');
  } else if (muR !== 1 || muTan !== 0) {
    // As for a loss tangent on eps: a magnetic conductivity exact at the reference frequency.
    permeability = constantResponse(muR, 2 * Math.PI * band.lossReferenceHz * muR * muTan);
  }
  return notes.length > 0 ? { permittivity, permeability, notes } : { permittivity, permeability };
}

/** Band samples for shortestWavelength; pole frequencies inside the band are added to them. */
const INDEX_SAMPLES = 64;

/**
 * The shortest wavelength inside a material over the band, c / (f Re sqrt(eps mu)),
 * with the frequency and refractive index where it occurs. Loss counts (the
 * principal root of the complex product), and so does a resonance inside the
 * band, which a value at f_max alone would miss.
 */
export function shortestWavelength(epsR: number, responses: MaterialResponses, fMinHz: number, fMaxHz: number): { wavelengthMm: number; index: number; atHz: number } {
  const poleHz = [responses.permittivity, responses.permeability].flatMap((r) => r?.poles ?? [])
    .map((p) => (p.type === 'debye' ? p.fRelaxHz : p.fResHz))
    .filter((f) => f > fMinHz && f < fMaxHz);
  const freqs = [...Array.from({ length: INDEX_SAMPLES + 1 }, (_, n) => fMinHz + ((fMaxHz - fMinHz) * n) / INDEX_SAMPLES), ...poleHz];
  let best = { wavelengthMm: Infinity, index: 1, atHz: fMaxHz };
  for (const f of freqs) {
    const [er, ei] = responses.permittivity ? relativeValue(responses.permittivity, f) : [epsR, 0];
    const [mr, mi] = responses.permeability ? relativeValue(responses.permeability, f) : [1, 0];
    const [pr, pi] = [er * mr - ei * mi, er * mi + ei * mr];
    // Re of the principal root; below 1 (above a resonance) the wave is no shorter than in vacuum for meshing.
    const index = Math.max(1, Math.sqrt((Math.hypot(pr, pi) + pr) / 2));
    const wavelengthMm = 299_792_458e3 / f / index;
    if (wavelengthMm < best.wavelengthMm) best = { wavelengthMm, index, atHz: f };
  }
  return best;
}
