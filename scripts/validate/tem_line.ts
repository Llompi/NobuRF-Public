/**
 * A 1D TEM line built from the 3D kernel: Ez between a PEC plate at k = 0 and
 * the PEC outer wall at k = nz, with all Hx forced to zero every step (PMC
 * side walls). The field is then uniform in y and z and the 3D update reduces
 * exactly to the 1D Yee update along x, at the same Courant number.
 *
 * Used for phase velocity, the PEC short and the absorbing-boundary reflection
 * (scripts/validate/analytic.ts, tests/cpml.test.ts).
 */
import { DEFAULT_GRID, timestepSec } from '../../src/engine/config';
import { DEFAULT_CPML_GRADING, buildCpml, uniformFaces, type CpmlGrading } from '../../src/engine/cpml';
import { CpuFdtd, vacuumModel } from '../../src/engine/fdtd_cpu';
import type { GridConfig } from '../../src/engine/types';
import { dielectricEdge } from '../../src/engine/voxelize';

/** Uniform filling of the line; sigmaDtOverEps0 as in voxelize.ts. */
export interface LineMedium { epsR: number; sigmaDtOverEps0: number }
const VACUUM: LineMedium = { epsR: 1, sigmaDtOverEps0: 0 };

export type LineTermination = { kind: 'none' } | { kind: 'pec'; wallI: number } | { kind: 'pml'; cells: number; grading?: CpmlGrading };

export const LINE_SOURCE_I = 40;

/**
 * Runs the line and records Ez at `probes`. A PML termination starts at node
 * nx - cells and ends on the PEC wall at x = nx.
 */
export function temLine(nx: number, termination: LineTermination, probes: number[], steps: number, medium = VACUUM) {
  const ny = 2, nz = 2;
  const g: GridConfig = { ...DEFAULT_GRID, nx, ny, nz, dxMm: 0.5, pmlCells: 0, groundK: 1 };
  const N = nx * ny * nz;
  const m = vacuumModel(g, uniformFaces(0));
  const edge = dielectricEdge(g.courant, medium.epsR, medium.sigmaDtOverEps0);
  m.eDecay.fill(edge.decay);
  m.eCurl.fill(edge.curl);
  if (termination.kind === 'pml') {
    m.cpml = buildCpml(g, { ...uniformFaces(0), xHigh: termination.cells }, termination.grading ?? DEFAULT_CPML_GRADING);
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    m.eCurl[i + nx * j] = 0; // Ex on k = 0
    m.eCurl[N + i + nx * j] = 0; // Ey on k = 0
  }
  if (termination.kind === 'pec') {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = termination.wallI; i < nx; i++) {
      m.eCurl[2 * N + i + nx * (j + ny * k)] = 0; // Ez = 0 from the wall on
    }
  }
  const s = new CpuFdtd(m);
  const dt = timestepSec(g);
  const rec = probes.map(() => new Float64Array(steps));
  // Gaussian-modulated sine, 2-10 GHz (the same family as the patch source).
  const fc = 6e9, tau = 1 / (Math.PI * 8e9), t0 = 4 * tau;
  for (let n = 0; n < steps; n++) {
    s.updateH();
    s.h.fill(0, 0, N); // PMC side walls: Hx = 0
    s.updateE();
    const t = (n + 0.5) * dt, u = (t - t0) / tau;
    const v = Math.exp(-u * u) * Math.sin(2 * Math.PI * fc * (t - t0));
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) s.e[2 * N + LINE_SOURCE_I + nx * (j + ny * k)] += v;
    for (let q = 0; q < probes.length; q++) rec[q][n] = s.e[2 * N + probes[q]];
  }
  return { rec, dt, grid: g };
}

export function dft(rec: Float64Array, dt: number, f: number, t0 = 0): [number, number] {
  let re = 0, im = 0;
  const w = 2 * Math.PI * f;
  for (let n = 0; n < rec.length; n++) {
    const t = (n + t0) * dt;
    re += rec[n] * Math.cos(w * t);
    im -= rec[n] * Math.sin(w * t);
  }
  return [re, im];
}

/** Complex reflection coefficient: DFT(total - incident) / DFT(incident) at each frequency. */
export function reflection(total: Float64Array, incident: Float64Array, dt: number, freqs: number[]): Array<[number, number]> {
  const diff = new Float64Array(total.length);
  for (let n = 0; n < total.length; n++) diff[n] = total[n] - incident[n];
  return freqs.map((f) => {
    const [rr, ri] = dft(diff, dt, f), [ir, ii] = dft(incident, dt, f);
    const den = ir * ir + ii * ii;
    return [(rr * ir + ri * ii) / den, (ri * ir - rr * ii) / den];
  });
}

/**
 * Worst reflection (dB) of a PML of `cells` across `freqs`, measured
 * `probeGap` cells in front of it. The reference is a line long enough that
 * nothing returns within the record.
 */
export function pmlReflectionDb(cells: number, freqs: number[], grading?: CpmlGrading, probeGap = 100, steps = 2500) {
  // The pulse passes the probe by step ~1000 and its echo by ~1400; the rest
  // of the record catches the PML's slow low-frequency tail.
  const probe = 400;
  const nx = probe + probeGap + cells;
  const ref = temLine(probe + steps, { kind: 'none' }, [probe], steps);
  const run = temLine(nx, { kind: 'pml', cells, grading }, [probe], steps);
  const gamma = reflection(run.rec[0], ref.rec[0], ref.dt, freqs);
  return gamma.map(([r, i]) => 20 * Math.log10(Math.hypot(r, i)));
}
