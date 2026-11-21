/**
 * Data for the frequency-dependent and magnetic materials checks
 * (docs/validation.md section 2.4; tests/dispersion.test.ts asserts the same):
 *   1. The Djordjevic-Sarkar FR-4 model, closed form against the Debye-pole
 *      fit the solver runs, 1 MHz to 100 GHz (fit for a 1-11 GHz band).
 *   2. Slabs of Debye eps, Lorentz mu and Djordjevic-Sarkar FR-4 on the 1D
 *      line, FDTD reflection and transmission against the closed-form slab.
 *
 *   npx tsx scripts/validate/dispersion.ts   -> docs/validation/data/dispersion.json
 *   python docs/validation/dispersion_plot.py -> docs/validation/img/13_dispersive_materials.png
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { constantResponse, djordjevicSarkarExact, djordjevicSarkarResponse, relativeValue, type DjordjevicSarkar } from '../../src/engine/dispersion';
import { measureSlab, SLAB_DEFAULT, type SlabMaterial } from './dispersive_slab';

const OUT = new URL('../../docs/validation/data/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const FR4: DjordjevicSarkar = { epsR: 4.4, tanDelta: 0.02, atHz: 1e9, fLowHz: 1e3, fHighHz: 1e12 };
const BAND: [number, number] = [1e9, 11e9];
const fit = djordjevicSarkarResponse(FR4, ...BAND);
const logFreqs = Array.from({ length: 121 }, (_, n) => 1e6 * 10 ** (n / 24));
const ds = {
  band_ghz: BAND.map((f) => f / 1e9),
  poles: fit.poles.length,
  f_ghz: logFreqs.map((f) => f / 1e9),
  exact: logFreqs.map((f) => djordjevicSarkarExact(FR4, f)),
  fit: logFreqs.map((f) => relativeValue(fit, f)),
};

const slabs: Record<string, SlabMaterial> = {
  'Debye εr: ε∞ 2, Δε 3, relaxing at 3 GHz': { eps: { inf: 2, lossRate: 0, poles: [{ type: 'debye', delta: 3, fRelaxHz: 3e9 }] }, mu: constantResponse(1) },
  'Lorentz μr: μ∞ 1, Δμ 3, resonant at 6 GHz, damping 2 GHz (εr 2)': {
    eps: constantResponse(2), mu: { inf: 1, lossRate: 0, poles: [{ type: 'lorentz', delta: 3, fResHz: 6e9, dampingHz: 2e9 }] },
  },
  'Djordjevic-Sarkar FR-4: εr 4.4, tan δ 0.02 at 1 GHz': { eps: fit, mu: constantResponse(1) },
};
const slabFreqs = Array.from({ length: 41 }, (_, n) => 1e9 + n * 0.25e9);
const slab = Object.entries(slabs).map(([name, material]) => {
  const runs = measureSlab(material, slabFreqs);
  const worst = Math.max(...runs.map((r) => Math.max(
    Math.hypot(r.gamma[0] - r.exact.gamma[0], r.gamma[1] - r.exact.gamma[1]),
    Math.hypot(r.t[0] - r.exact.t[0], r.t[1] - r.exact.t[1]))));
  console.log(`${name}: worst |dGamma|, |dT| ${worst.toExponential(2)}`);
  return { name, worst, runs: runs.map((r) => ({ f_ghz: r.fHz / 1e9, gamma: r.gamma, t: r.t, exact_gamma: r.exact.gamma, exact_t: r.exact.t })) };
});

writeFileSync(new URL('dispersion.json', OUT), JSON.stringify({ ds, slab, slab_setup: SLAB_DEFAULT }, null, 1));
console.log(`D-S fit: ${fit.poles.length} Debye poles for ${BAND.map((f) => f / 1e9).join('-')} GHz`);
