import { volumeDftIndex, type VolumeDftComponent } from '../engine/volume_dft';
import type { FieldMaps, FieldVolume } from './solve';

/**
 * Cuts through the solve box for the model view: a plane of mesh nodes normal
 * to x, y or z, and any field component or magnitude on it, from the
 * whole-grid field DFT (FieldMaps.volume, engine/volume_dft.ts).
 *
 * The solver keeps each component at its own Yee position, half a cell off the
 * node along one axis (E) or two (H). A cut puts every component on the nodes
 * by linear interpolation between its two neighbours along each offset axis,
 * weighted by the actual (graded) cell sizes. Values stay in the solver's
 * normalised units (e = E*dRef, h = eta0*H*dRef): only ratios mean anything.
 */

/** The axis normal to the cut: 'z' is an XY cut. */
export type CutAxis = 'x' | 'y' | 'z';
export type CutComponent = VolumeDftComponent;
/** A component, or the magnitude of the E or H vector. */
export type CutQuantity = CutComponent | 'e' | 'h';
export const CUT_QUANTITIES: readonly CutQuantity[] = ['ex', 'ey', 'ez', 'e', 'hx', 'hy', 'hz', 'h'];

export interface FieldCut {
  axis: CutAxis;
  /** Node index along the axis. */
  index: number;
}

export interface CutGrid {
  /** The in-plane axes, in the order the values are stored (u fastest). */
  u: CutAxis;
  v: CutAxis;
  /** Node coordinates (mm) of the cut, PML left out. */
  uMm: Float64Array;
  vMm: Float64Array;
  /** Coordinate of the cut along its axis, mm. */
  atMm: number;
}

export interface ComplexGrid {
  re: Float32Array;
  im: Float32Array;
}

const IN_PLANE: Record<CutAxis, [CutAxis, CutAxis]> = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] };
/** The axes along which each component sits half a cell off the node. */
const HALF_OFFSET: Record<CutComponent, readonly CutAxis[]> = {
  ex: ['x'], ey: ['y'], ez: ['z'], hx: ['y', 'z'], hy: ['x', 'z'], hz: ['x', 'y'],
};
const AXES: readonly CutAxis[] = ['x', 'y', 'z'];

export const quantityLabel = (q: CutQuantity): string => (q === 'e' ? '|E|' : q === 'h' ? '|H|' : q[0].toUpperCase() + q[1]);
export const isMagnitude = (q: CutQuantity): q is 'e' | 'h' => q === 'e' || q === 'h';
export const planeLabel = (axis: CutAxis): string => IN_PLANE[axis].join('').toUpperCase();
/** The in-plane components of the vector a quantity belongs to, for arrows: [u, v]. */
export function inPlaneComponents(q: CutQuantity, axis: CutAxis): [CutComponent, CutComponent] {
  const field = q[0] as 'e' | 'h';
  const [u, v] = IN_PLANE[axis];
  return [`${field}${u}` as CutComponent, `${field}${v}` as CutComponent];
}

export interface Lines {
  mm: Float64Array;
  /** First and last node index inside the PML. */
  first: number;
  last: number;
}

/** Node positions along `axis` and the node indices a cut may take there: the nodes inside the PML. */
export function cutRange(fields: FieldMaps, volume: FieldVolume, axis: CutAxis): Lines {
  if (axis === 'x') return { mm: fields.xMm, first: fields.pml.xLow, last: fields.xMm.length - 1 - fields.pml.xHigh };
  if (axis === 'y') return { mm: fields.yMm, first: fields.pml.yLow, last: fields.yMm.length - 1 - fields.pml.yHigh };
  return { mm: volume.zMm, first: volume.pmlZ.low, last: volume.zMm.length - 1 - volume.pmlZ.high };
}

/** The node positions (mm) a cut along an axis can take. */
export const cutPositions = (lines: Lines): Float64Array => lines.mm.slice(lines.first, lines.last + 1);

/** The node nearest `mm` along `axis`, inside the PML. */
export function nearestCutIndex(fields: FieldMaps, volume: FieldVolume, axis: CutAxis, mm: number): number {
  const { mm: lines, first, last } = cutRange(fields, volume, axis);
  let best = first;
  for (let n = first + 1; n <= last; n++) if (Math.abs(lines[n] - mm) < Math.abs(lines[best] - mm)) best = n;
  return best;
}

export function cutGrid(fields: FieldMaps, volume: FieldVolume, cut: FieldCut): CutGrid {
  const [u, v] = IN_PLANE[cut.axis];
  const along = cutRange(fields, volume, cut.axis);
  if (!Number.isInteger(cut.index) || cut.index < along.first || cut.index > along.last) {
    throw new Error(`cut at node ${cut.index} along ${cut.axis} is outside ${along.first}..${along.last}`);
  }
  return { u, v, uMm: cutPositions(cutRange(fields, volume, u)), vMm: cutPositions(cutRange(fields, volume, v)), atMm: along.mm[cut.index] };
}

/**
 * Interpolation stencil of one component onto node n along one axis: the
 * values at n - 1/2 (index n - 1) and n + 1/2 (index n), weighted by the
 * distance to each, or the one value when there is no cell on a side.
 */
function stencil(mm: Float64Array, n: number, halfOffset: boolean): Array<[index: number, weight: number]> {
  if (!halfOffset) return [[n, 1]];
  const last = mm.length - 1;
  if (n === 0) return [[0, 1]];
  if (n === last) return [[last - 1, 1]];
  const below = mm[n] - mm[n - 1];
  const above = mm[n + 1] - mm[n];
  // The value at n - 1/2 is below/2 away, the one at n + 1/2 is above/2 away.
  return [[n - 1, above / (below + above)], [n, below / (below + above)]];
}

/** One component on the nodes of a cut, at field frequency `frequency` (an index into FieldMaps.planes). */
export function cutComponent(fields: FieldMaps, volume: FieldVolume, frequency: number, cut: FieldCut, component: CutComponent): ComplexGrid {
  if (frequency < 0 || frequency >= volume.frequencies) throw new Error(`no field volume at frequency ${frequency}; it has ${volume.frequencies}`);
  const grid = cutGrid(fields, volume, cut);
  const layout = { nx: fields.xMm.length, ny: fields.yMm.length, nz: volume.zMm.length, frequencies: volume.frequencies };
  const base = volumeDftIndex(layout, frequency, component, 0, 0, 0);
  const lines: Record<CutAxis, Float64Array> = { x: fields.xMm, y: fields.yMm, z: volume.zMm };
  const firsts: Record<CutAxis, number> = { x: fields.pml.xLow, y: fields.pml.yLow, z: volume.pmlZ.low };
  const offset = HALF_OFFSET[component];
  const acc = volume.accumulators;
  const out: ComplexGrid = { re: new Float32Array(grid.uMm.length * grid.vMm.length), im: new Float32Array(grid.uMm.length * grid.vMm.length) };
  // Flat-index stride of a step along each axis, so the stencil sums need no per-term objects.
  const stride: Record<CutAxis, number> = { x: 2, y: 2 * layout.nx, z: 2 * layout.nx * layout.ny };
  const normal = stencil(lines[cut.axis], cut.index, offset.includes(cut.axis)).map(([n, w]): [number, number] => [n * stride[cut.axis], w]);
  const alongU = Array.from(grid.uMm, (_, a) => stencil(lines[grid.u], firsts[grid.u] + a, offset.includes(grid.u)).map(([n, w]): [number, number] => [n * stride[grid.u], w]));
  for (let b = 0; b < grid.vMm.length; b++) {
    const sv = stencil(lines[grid.v], firsts[grid.v] + b, offset.includes(grid.v));
    for (let a = 0; a < grid.uMm.length; a++) {
      let re = 0;
      let im = 0;
      for (const [pu, wu] of alongU[a]) for (const [nv, wv] of sv) for (const [pn, wn] of normal) {
        const w = wu * wv * wn;
        const p = base + pu + nv * stride[grid.v] + pn;
        re += w * acc[p];
        im += w * acc[p + 1];
      }
      out.re[a + grid.uMm.length * b] = re;
      out.im[a + grid.uMm.length * b] = im;
    }
  }
  return out;
}

/** The three components of a field on a cut, for magnitudes and arrows. */
export function cutVector(fields: FieldMaps, volume: FieldVolume, frequency: number, cut: FieldCut, field: 'e' | 'h'): Record<CutAxis, ComplexGrid> {
  const [x, y, z] = AXES.map((axis) => cutComponent(fields, volume, frequency, cut, `${field}${axis}` as CutComponent));
  return { x, y, z };
}

/** |F| = sqrt(|Fx|^2 + |Fy|^2 + |Fz|^2) of complex phasors: the peak of the field's magnitude over a cycle for linear polarisation. */
export function magnitude(vector: Record<CutAxis, ComplexGrid>): Float32Array {
  const out = new Float32Array(vector.x.re.length);
  for (let n = 0; n < out.length; n++) {
    out[n] = Math.hypot(vector.x.re[n], vector.x.im[n], vector.y.re[n], vector.y.im[n], vector.z.re[n], vector.z.im[n]);
  }
  return out;
}
