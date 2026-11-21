import { ETA0 } from './config';
import type { Complex } from './port_dft';

/**
 * Lumped R, L and C components on Yee E edges (a chip resistor across a gap in
 * a trace, a shunt capacitor from a pad to ground, a series RLC). Each edge
 * that a component covers carries its share of the component in parallel with
 * the edge's own dielectric, and a component of several edges in series along
 * a column splits its impedance among them in proportion to their lengths, so
 * every edge sees the same relation between its E and the current density.
 *
 * Normalised units (as in fdtd_cpu.ts, e = E dRef, h = eta0 H dRef): on an
 * edge of length l and dual cross-section A (in dRef and dRef^2), the cell
 * voltage is e * l and the current I enters the E update as u = eta0 I / A:
 *   a (e' - e) = Sc curl(h) - Sc (G_bg ebar + u),     ebar = (e' + e) / 2
 * where a is the edge's eps_r and G_bg its dielectric loss. A column of
 * height L (dRef) holding impedance Z(s) gives every edge u = e / zeta(s) with
 *   zeta(s) = Z(s) A / (eta0 L),
 * so R, L and C become rho = R A / (eta0 L), lambda = L A / (eta0 L) and
 * gamma = C eta0 L / A (both in seconds).
 *
 * Time stepping is the trapezoidal rule on the element (the companion model a
 * circuit simulator uses), with the element current taken over the step that
 * E takes, so the energy the element absorbs, ebar * u * dt, is exactly the
 * change of its stored energy plus R's loss. The scheme is therefore stable
 * for any non-negative R, L and C, however small, at the grid's own Courant
 * limit. A capacitor in parallel adds gamma Sc / dt to the edge's eps_r (the
 * exact parallel-plate equivalent); every other part is a state per edge.
 *
 * Per edge, the step after the main E update (which used eDecay = ca and
 * eCurl = cb from lumpedEdgeCoefficients) is the same for both connections:
 *   s     = pU xU + pQ xQ                 the element's history current
 *   e'   -= cb s
 *   ubar  = gB ebar + s                   the element current over the step
 *   xU'   = cUU xU + cUE ebar + cUI ubar  inductor current
 *   xQ'   = xQ + cQI ubar                 series capacitor voltage
 * parallel: xU is the inductor branch current w, u = ebar/rho + (w + w')/2, w' = w + dt/lambda ebar.
 * series: xU is the loop current u^n and xQ the capacitor voltage q^n at the step's
 * ends; with Zd = 2 lambda/dt + rho + dt/(2 gamma), ubar = (ebar + 2 lambda/dt u^n - q^n) / Zd.
 * lumped.wgsl runs the same step on the GPU.
 */

export type ComponentConnection = 'series' | 'parallel';

/** A component's value; absent parts are null. SI units. */
export interface ComponentValues {
  resistanceOhm: number | null;
  inductanceH: number | null;
  capacitanceF: number | null;
  connection: ComponentConnection;
}

/** Floats per edge in LumpedEdges.coef; the layout of LUMPED_COEF. */
export const LUMPED_COEFS_PER_EDGE = 10;

/** Offsets into one edge's coefficients. lumped.wgsl reads the same layout. */
export const LUMPED_COEF = { cb: 0, gB: 1, pU: 2, pQ: 3, cUU: 4, cUE: 5, cUI: 6, cQI: 7, energyU: 8, energyQ: 9 } as const;

/**
 * Every E edge that carries a component, as flat arrays (one model may hold
 * many components). The main E kernel's eDecay/eCurl at these edges are the
 * component's ca/cb; `coef` holds LUMPED_COEFS_PER_EDGE floats per edge.
 */
export interface LumpedEdges {
  eIndex: Uint32Array;
  coef: Float32Array;
}

/** The edge an E update coefficient pair describes: eps_r and the loss G_bg (in u per e). */
export function edgeMedium(courant: number, eDecay: number, eCurl: number): { epsR: number; lossG: number } {
  if (!(eCurl > 0)) throw new Error('a lumped component needs a dielectric edge (eCurl > 0), not copper or a port');
  const epsR = (courant * (1 + eDecay)) / (2 * eCurl);
  return { epsR, lossG: (2 * epsR * (1 - eDecay)) / (courant * (1 + eDecay)) };
}

export interface LumpedEdgeGeometry {
  /** Edge length / dRef: the edge's share of its column. */
  edgeLength: number;
  /** Column height / dRef: every edge in series along the component together. */
  columnLength: number;
  /** Dual cross-section across the edge / dRef^2. */
  crossSection: number;
}

/**
 * The main-kernel coefficients (ca, cb) and the component step coefficients of
 * one edge. `values` is what this edge's column holds (a component spread over
 * n parallel columns gives each n R, n L and C / n). The edge's medium comes
 * from its dielectric coefficients before the component was placed.
 */
export function lumpedEdgeCoefficients(
  courant: number, dtSec: number, medium: { epsR: number; lossG: number }, geometry: LumpedEdgeGeometry, values: ComponentValues,
): { ca: number; cb: number; coef: Float32Array } {
  const { resistanceOhm: r, inductanceH: l, capacitanceF: c, connection } = values;
  if (r === null && l === null && c === null) throw new Error('a lumped component needs a resistance, an inductance or a capacitance');
  for (const [name, v] of [['resistance', r], ['inductance', l], ['capacitance', c]] as const) {
    if (v !== null && !(v > 0 && Number.isFinite(v))) throw new Error(`component ${name} must be a positive finite number, got ${v}`);
  }
  const { edgeLength, columnLength, crossSection: A } = geometry;
  const rho = r === null ? null : (r * A) / (ETA0 * columnLength);
  const lambda = l === null ? null : (l * A) / (ETA0 * columnLength);
  const gamma = c === null ? null : (c * ETA0 * columnLength) / A;
  const volume = edgeLength * A;
  const coef = new Float32Array(LUMPED_COEFS_PER_EDGE);
  const K = LUMPED_COEF;
  let addedEps = 0;
  let gB: number;
  if (connection === 'parallel') {
    gB = (rho === null ? 0 : 1 / rho) + (lambda === null ? 0 : dtSec / (2 * lambda));
    if (gamma !== null) addedEps = (courant * gamma) / dtSec;
    if (lambda !== null) {
      coef[K.pU] = 1;
      coef[K.cUU] = 1;
      coef[K.cUE] = dtSec / lambda;
      coef[K.energyU] = (courant * volume * lambda) / dtSec;
    }
  } else {
    const inductive = lambda === null ? 0 : (2 * lambda) / dtSec;
    const zd = inductive + (rho ?? 0) + (gamma === null ? 0 : dtSec / (2 * gamma));
    gB = 1 / zd;
    if (lambda !== null) {
      coef[K.pU] = inductive / zd;
      coef[K.cUU] = -1;
      coef[K.cUI] = 2;
      coef[K.energyU] = (courant * volume * lambda) / dtSec;
    }
    if (gamma !== null) {
      coef[K.pQ] = -1 / zd;
      coef[K.cQI] = dtSec / gamma;
      coef[K.energyQ] = (courant * volume * gamma) / dtSec;
    }
  }
  const a = medium.epsR + addedEps;
  const halfLoss = (courant * (medium.lossG + gB)) / 2;
  const cb = courant / (a + halfLoss);
  coef[K.cb] = cb;
  coef[K.gB] = gB;
  return { ca: (a - halfLoss) / (a + halfLoss), cb, coef };
}

/** Per-edge state of every component in a model: E after the last step and the two element states. */
export class LumpedState {
  readonly ePrev: Float32Array;
  readonly xU: Float32Array;
  readonly xQ: Float32Array;

  constructor(edgeCount: number) {
    this.ePrev = new Float32Array(edgeCount);
    this.xU = new Float32Array(edgeCount);
    this.xQ = new Float32Array(edgeCount);
  }

  reset(): void {
    this.ePrev.fill(0);
    this.xU.fill(0);
    this.xQ.fill(0);
  }
}

/** The component step on every edge, after the main E update and its CPML pass. */
export function stepLumped(edges: LumpedEdges, state: LumpedState, e: Float32Array): void {
  const { eIndex, coef } = edges;
  const { ePrev, xU, xQ } = state;
  const K = LUMPED_COEF;
  for (let m = 0; m < eIndex.length; m++) {
    const o = m * LUMPED_COEFS_PER_EDGE;
    const s = coef[o + K.pU] * xU[m] + coef[o + K.pQ] * xQ[m];
    const eNew = e[eIndex[m]] - coef[o + K.cb] * s;
    e[eIndex[m]] = eNew;
    const eMean = 0.5 * (eNew + ePrev[m]);
    const uMean = coef[o + K.gB] * eMean + s;
    xU[m] = coef[o + K.cUU] * xU[m] + coef[o + K.cUE] * eMean + coef[o + K.cUI] * uMean;
    xQ[m] += coef[o + K.cQI] * uMean;
    ePrev[m] = eNew;
  }
}

/** Energy in the components' inductors and series capacitors, in the units of CpuFdtd.energy(). */
export function lumpedEnergy(edges: LumpedEdges, state: LumpedState): number {
  let sum = 0;
  for (let m = 0; m < edges.eIndex.length; m++) {
    const o = m * LUMPED_COEFS_PER_EDGE;
    sum += edges.coef[o + LUMPED_COEF.energyU] * state.xU[m] ** 2 + edges.coef[o + LUMPED_COEF.energyQ] * state.xQ[m] ** 2;
  }
  return sum;
}

/** One edge a component covers: its E-buffer index and its lengths (see LumpedEdgeGeometry). */
export interface ComponentEdge {
  eIndex: number;
  edgeLength: number;
  crossSection: number;
}

/** A component on the grid: `columns` side by side, each a run of edges in series that holds the whole component. */
export interface ComponentPlacement {
  columns: ComponentEdge[][];
  values: ComponentValues;
}

/**
 * Put components on the grid: rewrites eDecay/eCurl of their edges to the
 * component's ca/cb (the edges must be dielectric, see edgeMedium) and returns
 * the step coefficients. Spread over n columns, each column holds n R, n L and
 * C / n, so the columns in parallel are the component. An edge belongs to at
 * most one component.
 */
export function placeComponents(
  eDecay: Float32Array, eCurl: Float32Array, courant: number, dtSec: number, placements: ComponentPlacement[],
): LumpedEdges {
  const eIndex: number[] = [];
  const coef: number[] = [];
  const taken = new Set<number>();
  for (const { columns, values } of placements) {
    const n = columns.length;
    if (n === 0 || columns.some((column) => column.length === 0)) throw new Error('a component needs at least one edge in every column');
    const columnValues: ComponentValues = {
      ...values,
      resistanceOhm: values.resistanceOhm === null ? null : values.resistanceOhm * n,
      inductanceH: values.inductanceH === null ? null : values.inductanceH * n,
      capacitanceF: values.capacitanceF === null ? null : values.capacitanceF / n,
    };
    for (const column of columns) {
      const columnLength = column.reduce((sum, edge) => sum + edge.edgeLength, 0);
      for (const edge of column) {
        if (taken.has(edge.eIndex)) throw new Error(`E edge ${edge.eIndex} carries two lumped components`);
        taken.add(edge.eIndex);
        const medium = edgeMedium(courant, eDecay[edge.eIndex], eCurl[edge.eIndex]);
        const c = lumpedEdgeCoefficients(courant, dtSec, medium, { edgeLength: edge.edgeLength, columnLength, crossSection: edge.crossSection }, columnValues);
        eDecay[edge.eIndex] = c.ca;
        eCurl[edge.eIndex] = c.cb;
        eIndex.push(edge.eIndex);
        coef.push(...c.coef);
      }
    }
  }
  return { eIndex: Uint32Array.from(eIndex), coef: Float32Array.from(coef) };
}

/** The ideal circuit's impedance Z(j 2 pi f) of a component value, in ohm. */
export function componentImpedance(values: ComponentValues, fHz: number): Complex {
  const w = 2 * Math.PI * fHz;
  const parts: Complex[] = [];
  if (values.resistanceOhm !== null) parts.push([values.resistanceOhm, 0]);
  if (values.inductanceH !== null) parts.push([0, w * values.inductanceH]);
  if (values.capacitanceF !== null) parts.push([0, -1 / (w * values.capacitanceF)]);
  if (values.connection === 'series') return parts.reduce((z, p) => [z[0] + p[0], z[1] + p[1]], [0, 0]);
  const admittance = parts.reduce<Complex>((y, [re, im]) => {
    const d = re * re + im * im;
    return [y[0] + re / d, y[1] - im / d];
  }, [0, 0]);
  const d = admittance[0] ** 2 + admittance[1] ** 2;
  return [admittance[0] / d, -admittance[1] / d];
}
