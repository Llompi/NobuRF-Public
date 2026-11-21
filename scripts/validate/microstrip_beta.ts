/**
 * ε_eff of the Pozar Example 3.7 line from the field itself (docs/validation.md
 * section 7.3), as a check on the two-resonator method in benchmarks.ts.
 *
 * Ez at mid-substrate under the strip is Fourier-transformed at a few
 * frequencies along the middle of the 11.6 mm line, away from the port and the
 * open end. On a uniform grid any mix of forward and backward waves obeys
 * E(y + d) + E(y - d) = 2 cosh(γ d) E(y), so a least-squares fit of cosh(γ d)
 * over all samples gives the propagation constant without knowing the
 * reflection at either end. β = Im(γ) and ε_eff = (β / k0)². The line has
 * tan δ 0.05; it raises β by about 0.03 % (tan² δ / 8).
 *
 *   npx tsx scripts/validate/microstrip_beta.ts                  # the uniform 0.1 mm file
 *   npx tsx scripts/validate/microstrip_beta.ts --wide           # 7.5 mm of board each side; 20 air cells beside it, 40 above
 *   npx tsx scripts/validate/microstrip_beta.ts --copper         # copper strip and ground, lossless alumina
 *   npx tsx scripts/validate/microstrip_beta.ts --copper --strip 4   # a 4 mm strip (W/h = 8)
 *
 * α is fitted too. With the file's tan δ it is the dielectric loss, compared
 * with Pozar eq. 3.198 at the tan δ the solver applies at each frequency (a
 * constant conductivity exact at loss_reference_ghz). With --copper it is the
 * conductor loss, compared with Pucel's formula (closed_forms.ts) for copper
 * 5 and 35 um thick. The solver's copper is a sheet of zero thickness, for
 * which the edge-crowding term has no finite limit, so the two thicknesses
 * bracket a plausible answer rather than give the exact one.
 */
import { readFileSync } from 'node:fs';
import { parseProject } from '../../src/project/schema';
import { rasterise } from '../../src/project/rasterise';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { timestepSec } from '../../src/engine/config';
import { hammerstadJensenStatic, kirschningJansenEpsEff, pucelConductorLossNpPerM } from './closed_forms';

const SPEED_OF_LIGHT_M_PER_S = 299_792_458;
const FILE = new URL('../../examples/benchmarks/pozar-ex3.7-eeff-line-b.json', import.meta.url);
const SAMPLE_FROM_MM = 2;
const SAMPLE_TO_MM = 9.6;
const FREQUENCIES_GHZ = [8, 9.3, 11, 12];

const json = JSON.parse(readFileSync(FILE, 'utf8'));
const copper = process.argv.includes('--copper');
if (copper) {
  json.stackup = json.stackup.map((layer: { type: string }) => (layer.type === 'copper' ? { ...layer, material: 'copper' } : layer));
  json.materials.substrate.tan_delta = 0;
}
const stripArg = process.argv.indexOf('--strip');
const stripMm = stripArg > 0 ? Number(process.argv[stripArg + 1]) : 0.5;
if (!(stripMm > 0)) throw new Error('--strip needs a width in mm');
json.variables.line_w.value = `${stripMm} mm`;
const wide = process.argv.includes('--wide');
json.variables.side.value = `${Math.max(stripMm > 0.5 ? 2.5 + stripMm : 2.5, wide ? 7.5 : 0)} mm`;
if (wide) {
  json.mesh.air_margin_cells = { ...json.mesh.air_margin_cells, xy: 20, above: 40 };
}
const project = parseProject(json);
const { model } = rasterise(project);
const grid = model.grid;
const N = grid.nx * grid.ny * grid.nz;
const port = model.ports[0];
const midSubstrateK = (port.k0 + port.k1) >> 1;
const yLines = model.mesh.y;

const rows: number[] = [];
for (let j = 0; j < grid.ny; j++) {
  const y = yLines[j] - yLines[port.j];
  if (y >= SAMPLE_FROM_MM && y <= SAMPLE_TO_MM) rows.push(j);
}
const spacingMm = yLines[rows[1]] - yLines[rows[0]];
for (let n = 1; n < rows.length; n++) {
  if (Math.abs(yLines[rows[n]] - yLines[rows[n - 1]] - spacingMm) > 1e-9) throw new Error('the sampled stretch needs uniform y spacing');
}
const ezIndex = rows.map((j) => 2 * N + port.i + grid.nx * (j + grid.ny * midSubstrateK));

const dt = timestepSec(grid);
const re = FREQUENCIES_GHZ.map(() => new Float64Array(rows.length));
const im = FREQUENCIES_GHZ.map(() => new Float64Array(rows.length));
const a = project.analysis;
new CpuFdtd(model).run(
  { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0: project.ports[0].reference_impedance_ohm },
  { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 },
  {
    afterStep(step, sim) {
      const t = (step + 1) * dt; // E after step n is at (n + 1) dt
      FREQUENCIES_GHZ.forEach((fGHz, q) => {
        const phase = 2 * Math.PI * fGHz * 1e9 * t;
        const c = Math.cos(phase), s = Math.sin(phase);
        ezIndex.forEach((index, m) => {
          re[q][m] += sim.e[index] * c;
          im[q][m] -= sim.e[index] * s;
        });
      });
    },
  },
  0,
);

/** acosh of a complex number: ln(z + sqrt(z^2 - 1)). Returns [re, im]. */
function complexAcosh(zr: number, zi: number): [number, number] {
  const wr = zr * zr - zi * zi - 1, wi = 2 * zr * zi;
  const r = Math.sqrt(Math.hypot(wr, wi)), theta = Math.atan2(wi, wr) / 2;
  const sr = zr + r * Math.cos(theta), si = zi + r * Math.sin(theta);
  return [Math.log(Math.hypot(sr, si)), Math.atan2(si, sr)];
}

const widthMm = stripMm;
const heightMm = parseFloat(json.stackup.find((layer: { type: string }) => layer.type === 'dielectric').thickness);
const epsR = json.materials.substrate.eps_r as number;
const { epsEff: staticEpsEff, z0Ohm } = hammerstadJensenStatic(widthMm / heightMm, epsR);
const tanDelta = json.materials.substrate.tan_delta as number;
const COPPER_S_PER_M = 5.8e7;
const MU0 = 4e-7 * Math.PI;
/** The reference loss for this run at fGHz, in Np/m: a range when the reference depends on an unmodelled thickness. */
function referenceAlpha(fGHz: number): { low: number; high: number; what: string } {
  const k0 = (2 * Math.PI * fGHz * 1e9) / SPEED_OF_LIGHT_M_PER_S;
  if (copper) {
    const rs = Math.sqrt((2 * Math.PI * a.loss_reference_ghz * 1e9 * MU0) / (2 * COPPER_S_PER_M)); // the solver's Rs, fixed at loss_reference_ghz
    // Thicker copper crowds less at the edges, so 35 um gives the lower loss.
    const [low, high] = [0.035, 0.005].map((t) => pucelConductorLossNpPerM(widthMm, heightMm, t, z0Ohm, rs));
    return { low, high, what: 'Pucel, t 35 to 5 um, Rs at loss_reference_ghz' };
  }
  const tanAtF = (tanDelta * a.loss_reference_ghz) / fGHz;
  // Pozar's filling factor uses the quasi-static eps_eff.
  const alpha = (k0 * epsR * (staticEpsEff - 1) * tanAtF) / (2 * Math.sqrt(staticEpsEff) * (epsR - 1));
  return { low: alpha, high: alpha, what: 'Pozar 3.198' };
}
console.log(`${project.name}: ${rows.length} samples, ${spacingMm.toFixed(3)} mm apart, ${SAMPLE_FROM_MM} to ${SAMPLE_TO_MM} mm from the port`);
FREQUENCIES_GHZ.forEach((fGHz, q) => {
  // Least squares for C in E[m+1] + E[m-1] = 2 C E[m].
  let numRe = 0, numIm = 0, den = 0;
  for (let m = 1; m < rows.length - 1; m++) {
    const sr = re[q][m + 1] + re[q][m - 1], si = im[q][m + 1] + im[q][m - 1];
    const er = 2 * re[q][m], ei = 2 * im[q][m];
    numRe += er * sr + ei * si;
    numIm += er * si - ei * sr;
    den += er * er + ei * ei;
  }
  const [alphaD, betaD] = complexAcosh(numRe / den, numIm / den);
  const beta = Math.abs(betaD) / (spacingMm * 1e-3);
  const k0 = (2 * Math.PI * fGHz * 1e9) / SPEED_OF_LIGHT_M_PER_S;
  const epsEff = (beta / k0) ** 2;
  const reference = kirschningJansenEpsEff(widthMm / heightMm, epsR, staticEpsEff, fGHz, heightMm);
  console.log(`  ${fGHz.toFixed(1)} GHz: eps_eff ${epsEff.toFixed(3)} vs Hammerstad-Jensen + Kirschning-Jansen ${reference.toFixed(3)} ` +
    `(${((epsEff / reference - 1) * 100).toFixed(2)} %)`);
  const alpha = Math.abs(alphaD) / (spacingMm * 1e-3);
  const ref = referenceAlpha(fGHz);
  const percentOff = (r: number) => `${((alpha / r - 1) * 100).toFixed(1)} %`;
  const range = ref.low === ref.high ? `${ref.low.toFixed(2)} Np/m (${percentOff(ref.low)})` : `${ref.low.toFixed(2)} to ${ref.high.toFixed(2)} Np/m (${percentOff(ref.low)} to ${percentOff(ref.high)})`;
  console.log(`           alpha ${alpha.toFixed(2)} Np/m vs ${ref.what} ${range}`);
});
