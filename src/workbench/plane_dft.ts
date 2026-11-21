import { planeDftIndex, type PlaneDftLayout } from '../engine/plane_dft';

/**
 * The field plots' phasors, put on the nx * ny nodes from the engine's plane
 * DFT (engine/plane_dft.ts, filled the same way on the CPU and the GPU):
 *
 *   - Ez halfway through a dielectric layer (the plane the patch's cavity mode lives on).
 *   - The surface current on a copper layer: Js = z x (H_above - H_below),
 *     from Hx and Hy half a cell above (plane k) and below (plane k - 1) it.
 *
 * Jx at node (i, j) averages the Hy jumps at i - 1/2 and i + 1/2, Jy the Hx
 * jumps at j - 1/2 and j + 1/2. Values stay in the solver's normalised
 * units: only ratios mean anything.
 */

export interface ComplexPlane {
  re: Float32Array;
  im: Float32Array;
}

export interface FieldPlanes {
  frequencyGHz: number;
  /** Ez on the dielectric plane, nx * ny nodes, index i + nx * j. */
  ez: ComplexPlane;
  /** Surface current on the copper plane, nx * ny nodes. */
  jx: ComplexPlane;
  jy: ComplexPlane;
}

export interface MonitorPlanes {
  /** Cell index k of the Ez half-plane (Ez sits at k + 1/2). */
  ezK: number;
  /** Node index k of the copper sheet; needs a cell below it. */
  copperK: number;
}

/** The z planes to ask the engine for: each requested once, as it refuses repeats. */
export function planeDftRequest(m: MonitorPlanes): number[] {
  if (m.copperK < 1) throw new Error(`field monitor: copper plane ${m.copperK} has no cell below it`);
  return [...new Set([m.ezK, m.copperK - 1, m.copperK])];
}

export function fieldPlanesFromDft(acc: ArrayLike<number>, layout: PlaneDftLayout, m: MonitorPlanes): FieldPlanes[] {
  const { nx, ny, planesK } = layout;
  const plane = (k: number) => planesK.indexOf(k);
  const [ezPlane, abovePlane, belowPlane] = [plane(m.ezK), plane(m.copperK), plane(m.copperK - 1)];
  return layout.frequenciesHz.map((f, n) => {
    const out = (): ComplexPlane => ({ re: new Float32Array(nx * ny), im: new Float32Array(nx * ny) });
    const ez = out();
    const jx = out();
    const jy = out();
    const ezAt = planeDftIndex(layout, ezPlane, n, 'ez', 0, 0);
    const base = (p: number, c: 'hx' | 'hy') => planeDftIndex(layout, p, n, c, 0, 0);
    const [hxA, hxB, hyA, hyB] = [base(abovePlane, 'hx'), base(belowPlane, 'hx'), base(abovePlane, 'hy'), base(belowPlane, 'hy')];
    // Jump of H across the sheet at cell c, part 0 re / 1 im.
    const dHx = (c: number, part: number) => acc[hxA + 2 * c + part] - acc[hxB + 2 * c + part];
    const dHy = (c: number, part: number) => acc[hyA + 2 * c + part] - acc[hyB + 2 * c + part];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = i + nx * j;
        ez.re[c] = acc[ezAt + 2 * c];
        ez.im[c] = acc[ezAt + 2 * c + 1];
        for (let part = 0; part < 2; part++) {
          // Js = z x dH: Jx = -dHy, Jy = dHx. Hy lives at i + 1/2, Hx at j + 1/2: average the two neighbours of the node.
          const hy = (dHy(c, part) + (i > 0 ? dHy(c - 1, part) : 0)) / (i > 0 ? 2 : 1);
          const hx = (dHx(c, part) + (j > 0 ? dHx(c - nx, part) : 0)) / (j > 0 ? 2 : 1);
          (part === 0 ? jx.re : jx.im)[c] = -hy;
          (part === 0 ? jy.re : jy.im)[c] = hx;
        }
      }
    }
    return { frequencyGHz: f / 1e9, ez, jx, jy };
  });
}
