/**
 * Random microstrip-style boards for the law and symmetry families: a ground,
 * one or two dielectric layers, a trace from port 1 to port 2 with a bend,
 * a stub and a triangular patch (slanted edges, so the staircase rules are
 * exercised), all with random sizes and positions. Nothing here is a model
 * that failed before.
 */
import type { BoardSpec, Vec2 } from '../board_spec';
import type { Rng } from '../rng';
import { C0 } from '../../../src/engine/config';

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

export function randomBoard(rng: Rng, name: string, options: { boundary: 'pec' | 'pml'; lossy: boolean; layers: 1 | 2 }): BoardSpec {
  const lx = rng.uniform(8, 14);
  const ly = rng.uniform(8, 14);
  const edgeCellMm = rng.uniform(0.2, 0.35);
  const traceW = rng.uniform(4, 8) * edgeCellMm;
  const epsR = rng.uniform(1.5, 8);
  const h1 = rng.uniform(0.5, 1.5);
  const tanDelta = options.lossy ? rng.uniform(0.005, 0.03) : 0;
  const stackup: BoardSpec['stackup'] = [
    { type: 'copper', name: 'gnd' },
    { type: 'dielectric', name: 'core', thicknessMm: h1, epsR, tanDelta },
  ];
  if (options.layers === 2) {
    // The core's material: a lumped port cannot span dielectrics of different eps_r (rasterise rejects it).
    stackup.push({ type: 'copper', name: 'inner' }, { type: 'dielectric', name: 'prepreg', thicknessMm: rng.uniform(0.3, 1), epsR, tanDelta });
  }
  stackup.push({ type: 'copper', name: 'top' });

  // Trace: from (x1, yA) right to xm, up to yB, right to x2. Ports at both ends, on the trace's centre line.
  const margin = 1.5;
  const x1 = margin;
  const x2 = lx - margin;
  const xm = rng.uniform(lx * 0.35, lx * 0.65);
  const yA = rng.uniform(margin, ly * 0.4);
  const yB = rng.uniform(ly * 0.6, ly - margin);
  const half = traceW / 2;
  const top: Vec2[][] = [
    rect(x1, yA - half, xm + half, yA + half),
    rect(xm - half, yA - half, xm + half, yB + half),
    rect(xm - half, yB - half, x2, yB + half),
    // Open stub off the vertical run, random length and side.
    (() => {
      const ys = rng.uniform(yA + 2 * traceW, yB - 2 * traceW);
      const len = rng.uniform(1, Math.min(3, xm - x1 - 1));
      return rect(xm - half - len, ys - half, xm - half, ys + half);
    })(),
    // Triangle hanging off the last run: slanted edges.
    (() => {
      const cx = rng.uniform(xm + 1.5, x2 - 1);
      const size = rng.uniform(1, 2);
      return [[cx - size / 2, yB + half], [cx + size / 2, yB + half], [cx + rng.uniform(-0.3, 0.3) * size, Math.min(yB + half + size, ly - 0.2)]] as Vec2[];
    })(),
  ];
  const copper: Record<string, Vec2[][]> = { gnd: [rect(0, 0, lx, ly)], top };
  if (options.layers === 2) {
    // An inner-layer island under part of the trace, with a cut-free gap around the port columns.
    const ix = rng.uniform(x1 + 1.5, xm - 1);
    copper.inner = [rect(ix, rng.uniform(0.3, yA - half - 0.5), rng.uniform(xm + 1, x2 - 1.5), rng.uniform(yB + half + 0.5, ly - 0.3))];
  }
  const cellMm = rng.uniform(0.8, 1.4);
  const maxEps = Math.max(...stackup.map((l) => l.epsR ?? 1));
  // Ten cells per wavelength at the largest cell in the densest dielectric at f_max.
  const fMaxGHz = Math.min(20, C0 / (10 * cellMm * 1e-3 * Math.sqrt(maxEps)) / 1e9);
  const between: [string, string] = ['gnd', 'top'];
  return {
    name,
    outline: rect(0, 0, lx, ly),
    stackup,
    copper,
    ports: [{ id: 'p1', at: [x1, yA], between }, { id: 'p2', at: [x2, yB], between }],
    boundary: { xy: options.boundary, z: options.boundary },
    mesh: {
      cellMm,
      edgeCellMm,
      dielectricCells: rng.integer(2, 4),
      maxGrowth: rng.uniform(1.2, 1.5),
      margin: { xy: rng.integer(1, 3), below: rng.integer(1, 2), above: rng.integer(2, 5) },
    },
    band: { fMinGHz: 0.2 * fMaxGHz, fMaxGHz, nFreq: 41 },
    stop: { decayDb: 60, maxSteps: 40000 },
  };
}
