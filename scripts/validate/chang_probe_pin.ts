/**
 * Feed-model check for the Chang 1986 patches (docs/validation.md section 7.4).
 *
 * The benchmark files feed each patch with a lumped port: a source column
 * spanning the whole substrate. A coaxial probe is a metal pin with the source
 * at the ground plane. On a substrate a fifth of a wavelength thick the two
 * are not the same circuit, so this script solves the same project file both
 * ways and prints where Re(Z_in) peaks. The pin is the port column made PEC
 * above a one-cell gap at the ground; it is a filament, much thinner than
 * Chang's SMA pin: it shows how much the feed model matters and does not
 * model Chang's probe. CpuFdtd only (the GPU runner reads ports[0].k1).
 * Diagnostic only: the project schema has no pin feed.
 *
 * With --coax it instead solves the file once with its feed replaced by the
 * schema's coax_probe port (an SMA line below the ground, its pin rising
 * through a cut in the ground plane), and prints the peak read as in the
 * benchmark: parabola through the three samples at the lowest maximum. The
 * two-feed mode prints the nearest sample instead, as its table in the docs
 * says.
 *
 *   npx tsx scripts/validate/chang_probe_pin.ts examples/benchmarks/graded/chang1986-17x11-h9.525.json
 *   npx tsx scripts/validate/chang_probe_pin.ts examples/benchmarks/graded/chang1986-17x11-h9.525.json --coax
 */
import { readFileSync } from 'node:fs';
import { parseProject } from '../../src/project/schema';
import { rasterise } from '../../src/project/rasterise';
import { CpuFdtd } from '../../src/engine/fdtd_cpu';
import { portSpectrum } from '../../src/engine/port_dft';
import { portCoefficients, portMeshFactors } from '../../src/engine/voxelize';
import { solveProjectText } from '../noburf';

/** Index of the lowest local maximum of Re(Z_in) that beats three samples on each side (the benchmark's reader). */
function lowestPeakIndex(zRe: ArrayLike<number>): number | null {
  for (let k = 3; k < zRe.length - 3; k++) {
    let isPeak = true;
    for (let d = 1; d <= 3 && isPeak; d++) isPeak = zRe[k] > zRe[k - d] && zRe[k] >= zRe[k + d];
    if (isPeak) return k;
  }
  return null;
}

function lowestPeak(fGHz: ArrayLike<number>, zRe: ArrayLike<number>): number | null {
  const k = lowestPeakIndex(zRe);
  return k === null ? null : fGHz[k];
}

/** The lowest peak refined by a parabola through its three samples, as benchmarks.ts reads it. */
function lowestPeakVertex(fGHz: ArrayLike<number>, zRe: ArrayLike<number>): number | null {
  const k = lowestPeakIndex(zRe);
  if (k === null) return null;
  const [a, b, c] = [zRe[k - 1], zRe[k], zRe[k + 1]];
  return fGHz[k] + ((0.5 * (a - c)) / (a - 2 * b + c)) * (fGHz[k + 1] - fGHz[k]);
}

async function solveWithCoaxProbe(file: string): Promise<number | null> {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  // The Chang files list the lumped column as [ground, patch]; coax_probe takes [signal, ground].
  json.ports = json.ports.map((p: { id: string; x: string; y: string; between: [string, string]; reference_impedance_ohm: number }) => {
    if (p.between[0] !== 'gnd') throw new Error(`${file}: expected the port to run from gnd, got ${p.between.join(' to ')}`);
    return { kind: 'coax_probe', id: p.id, x: p.x, y: p.y, between: [p.between[1], p.between[0]], reference_impedance_ohm: p.reference_impedance_ohm };
  });
  const solved = await solveProjectText(JSON.stringify(json), file, false);
  return lowestPeakVertex(solved.spec.fGHz, solved.spec.zRe);
}

function solve(file: string, feed: 'lumped column' | 'pin'): number | null {
  const project = parseProject(JSON.parse(readFileSync(file, 'utf8')));
  const { model } = rasterise(project);
  const z0 = project.ports[0].reference_impedance_ohm;
  if (feed === 'pin') {
    const p = model.ports[0];
    // portCoefficients: cb = Sc / eps / den and cs = b / den with den = 1 + b / 2, so den = 1 / (1 - cs / 2).
    const epsR = (model.grid.courant * (1 - p.cs / 2)) / p.cb;
    const gap = portMeshFactors(model.mesh, p.i, p.j, p.k0, p.k0 + 1, model.grid.dxMm);
    const coefficients = portCoefficients(model.grid.courant, epsR, z0, gap.seriesLength, 1, gap.loopLengthX * gap.loopLengthY);
    // The column's cells above the gap keep eDecay 1 and eCurl 0 from the rasteriser, which is PEC once the port no longer drives them.
    model.ports[0] = { ...p, k1: p.k0 + 1, ezIndex: p.ezIndex.slice(0, 1), seriesCells: 1, cells: 1, mesh: gap, ...coefficients };
  }
  const a = project.analysis;
  const exc = { fMinGHz: a.f_min_ghz, fMaxGHz: a.f_max_ghz, nFreq: a.n_freq, z0 };
  const samples = new CpuFdtd(model).run(exc, { maxSteps: a.stop.max_steps, stopAtEnergyDecayDb: a.stop.energy_decay_db, energyCheckEverySteps: 100 }, undefined, 0);
  const spectrum = portSpectrum(samples, exc);
  return lowestPeak(spectrum.fGHz, spectrum.zRe);
}

const file = process.argv[2];
if (!file) throw new Error('usage: npx tsx scripts/validate/chang_probe_pin.ts <chang project file> [--coax]');
if (process.argv.includes('--coax')) {
  solveWithCoaxProbe(file).then((f) => console.log(`coax probe: lowest Re(Z_in) peak ${f === null ? 'not found in the band' : `${f.toFixed(4)} GHz`}`));
} else for (const feed of ['lumped column', 'pin'] as const) {
  const f = solve(file, feed);
  console.log(`${feed}: lowest Re(Z_in) peak ${f === null ? 'not found in the band' : `${f.toFixed(3)} GHz`}`);
}
