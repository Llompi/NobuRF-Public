/**
 * The validated envelope: the kinds of board that published measurements and
 * textbook cases have checked NobuRF against (docs/validation.md section 7).
 * Mesh convergence says whether the equations were solved finely enough;
 * this says whether the model (feed, materials, geometry) has been shown to
 * match real boards like this one.
 *
 * Gated by feature, not only by number: a range of eps_r means little if the
 * feed or the copper model was never checked. Each entry is the span of the
 * benchmarks that agree with their reference, nothing wider. Known misses
 * (the Sheen branch-line coupler, the alumina microstrip's eps_eff +1.1 to
 * 1.7 %, strip loss) sit outside it until they are explained, which today
 * leaves one-port lumped-fed patches on low-eps substrates. A design outside an entry
 * is not wrong, it is unproven: the finding says what bounds it.
 */
import { shortestWavelength } from '../project/materials';
import type { ResolvedProject } from '../project/resolve';

export interface EnvelopeFinding {
  parameter: string;
  /** The design's value, in words or numbers. */
  value: string;
  /** What has been validated. */
  validated: string;
  inside: boolean;
  /** What the benchmarks bounding this read, and where to find them. */
  evidence: string;
}

const SECTION_7 = 'docs/validation.md section 7';

/** Benchmarks and what they cover: section 7 of docs/validation.md. */
export const VALIDATED = {
  epsR: { min: 2.2, max: 2.33, evidence: `measured benchmarks that agree: eps_r 2.2 (Sheen 1990 patch, -0.4 %) and 2.33 (Chang 1986 patches, -0.7 to +1.8 % on the three in section 7.1, -2.2 to +3.5 % on all six up to h/lambda_d 0.11). The alumina line (9.9) reads eps_eff 0.7 to 1.6 % high, so it is not included: ${SECTION_7}` },
  thicknessInWavelengths: {
    max: 0.1,
    evidence: 'Chang 1986 measured patches: within 3.5 % up to h/lambda_d 0.11; above it NobuRF reads high, +6.6 % at 0.125 rising to +14.5 % at 0.23 with a lumped feed (docs/validation.md section 7.4)',
  },
  frequencyGhz: { min: 2, max: 8, evidence: `the measured resonances that agree lie between 2.31 GHz (Chang 1986) and 7.5 GHz (Sheen 1990 patch): ${SECTION_7}` },
  dielectricLayers: { max: 1, evidence: `every measured benchmark has one substrate: ${SECTION_7}` },
  ports: { max: 1, evidence: 'the measured benchmarks that agree are one-port patches with a lumped feed; the Sheen 1990 four-port branch-line coupler reads 7 to 9 % low, and the SMA edge launch and coax probe are checked against openEMS only (docs/validation.md sections 3.2, 7)' },
  copperLoss: { evidence: 'copper loss matches the Pozar 6.3 cavity wall Q within 0.3 %, but has no measured strip-loss benchmark yet (docs/validation.md sections 7.2, 7.3)' },
  materials: { evidence: 'frequency-dependent and magnetic materials match the closed-form slab reflection and transmission coefficients within 6e-3, most within 2e-3 (docs/validation.md section 2.4), but no measured board or ferrite part has checked them yet' },
  edges: { evidence: 'every benchmark has axis-aligned copper; slanted or curved edges are staircased on the grid, which the mesh band measures but no benchmark has checked' },
} as const;

const fmt = (x: number) => String(Number(x.toPrecision(3)));

/** Where the design sits against each validated feature. */
export function envelopeFindings(resolved: ResolvedProject, fMinGhz: number, fMaxGhz: number): EnvelopeFinding[] {
  const out: EnvelopeFinding[] = [];
  const add = (parameter: string, value: string, validated: string, inside: boolean, evidence: string) =>
    out.push({ parameter, value, validated, inside, evidence });

  const dielectrics = resolved.stackup.flatMap((l) => (l.type === 'dielectric' && l.epsR !== 1 ? [l] : [])); // air is exact
  add('substrate layers', String(dielectrics.length), `at most ${VALIDATED.dielectricLayers.max}`, dielectrics.length <= VALIDATED.dielectricLayers.max, VALIDATED.dielectricLayers.evidence);
  for (const layer of dielectrics) {
    const e = VALIDATED.epsR;
    add(`eps_r of "${layer.name}"`, fmt(layer.epsR), `${e.min} to ${e.max}`, layer.epsR >= e.min && layer.epsR <= e.max, e.evidence);
    // In the shortest wavelength inside the material over the band: lambda0 / sqrt(eps_r) at f_max for a plain substrate.
    const thickness = layer.thicknessMm / shortestWavelength(layer.epsR, layer.responses, fMinGhz * 1e9, fMaxGhz * 1e9).wavelengthMm;
    const t = VALIDATED.thicknessInWavelengths;
    add(`thickness of "${layer.name}" in wavelengths at ${fMaxGhz} GHz`, fmt(thickness), `up to ${t.max}`, thickness <= t.max, t.evidence);
  }
  // A loss tangent alone counts as before: its default wideband model differs from the constant one only in how the loss
  // spreads over the band, and the measured benchmarks are lossless, so neither loss model is checked against them.
  const modelled = resolved.stackup.flatMap((l) => (l.type === 'dielectric' &&
    ((l.responses.permittivity && !l.responses.defaultLoss) || l.responses.permeability) ? [l] : []));
  add('materials', modelled.length > 0 ? `frequency-dependent or magnetic: ${modelled.map((l) => `"${l.name}"`).join(', ')}` : 'eps_r and tan delta, mu_r 1',
    'eps_r and tan delta, mu_r 1', modelled.length === 0, VALIDATED.materials.evidence);
  const f = VALIDATED.frequencyGhz;
  add('band (GHz)', `${fMinGhz} to ${fMaxGhz}`, `${f.min} to ${f.max}`, fMinGhz >= f.min && fMaxGhz <= f.max, f.evidence);

  const kinds = [...new Set(resolved.ports.map((p) => p.kind))].join(', ') || 'none';
  const ports = resolved.ports.length;
  add('ports', `${ports} (${kinds})`, `${VALIDATED.ports.max} lumped`, ports >= 1 && ports <= VALIDATED.ports.max && kinds === 'lumped', VALIDATED.ports.evidence);

  const lossyCopper = resolved.stackup.some((l) => l.type === 'copper' && l.conductivitySPerM !== null);
  add('copper model', lossyCopper ? 'lossy conductor' : 'perfect conductor', 'perfect conductor', !lossyCopper, VALIDATED.copperLoss.evidence);

  const slanted = Object.values(resolved.copper).flat().some((shape) => shape.polygon.some(([x, y], n) => {
    const [x2, y2] = shape.polygon[(n + 1) % shape.polygon.length];
    return Math.abs(x2 - x) > 1e-9 && Math.abs(y2 - y) > 1e-9;
  }));
  add('copper edges', slanted ? 'some slanted or curved' : 'axis-aligned', 'axis-aligned', !slanted, VALIDATED.edges.evidence);
  return out;
}

/** One line per finding outside the envelope, for warnings. */
export function envelopeWarnings(findings: EnvelopeFinding[]): string[] {
  return findings.filter((f) => !f.inside).map((f) =>
    `outside the validated range: ${f.parameter} is ${f.value} (validated: ${f.validated}), so the model is unproven against measurement here. ${f.evidence}`);
}
