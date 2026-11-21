import { cellWidth, type MeshLines } from './mesh';
import type { CpuFdtd, StepRecorder } from './fdtd_cpu';
import type { GridConfig } from './types';
import type { VoxelModel } from './voxelize';

/**
 * The closed Huygens box of the near-to-far-field transform (near_to_far.ts),
 * and the running DFT of the tangential fields on it.
 *
 * The box is six node planes: lo[a] and hi[a] along each axis a. Each face is
 * cut into patches, one per cell face, and every quantity is sampled at the
 * patch centre. On a face normal to a, with p = a + 1 and q = a + 2 (cyclic),
 * the patch centre sits at (a, p + 1/2, q + 1/2) in cell units. The Yee
 * components around it (see voxelize.ts for their positions):
 *   E_p at (a, p + 1/2, q)            -> mean of q and q + 1          (2 values)
 *   E_q at (a, p, q + 1/2)            -> mean of p and p + 1          (2 values)
 *   H_p at (a + 1/2, p, q + 1/2)      -> a -/+ 1/2, p, p + 1  (4 values)
 *   H_q at (a + 1/2, p + 1/2, q)      -> a -/+ 1/2, q, q + 1  (4 values)
 * so E and H meet at the same point. Along p and q the patch centre is the
 * midpoint of the two nodes, so those averages are plain means on any mesh.
 * Along the normal, H sits at the centres of the cells below and above the
 * face; on a graded mesh those cells differ in width, and H is interpolated
 * linearly to the face (hBelowWeight; 1/2 on a uniform mesh). They do not meet in time: after step n,
 * E is at (n + 1) dt and H at (n + 1/2) dt, and each is transformed with its
 * own sample time (the same treatment port_dft.ts gives V and I).
 *
 * Accumulator layout, shared by the CPU recorder below and the WGSL kernel
 * (shaders/huygens_dft.wgsl): 8 numbers per (sample, frequency) at
 * ((sample * frequencyCount) + frequency) * 8, holding re, im of the
 * normalised e_p, e_q, h_p, h_q (e = E*dRef, h = eta0*H*dRef, dRef the
 * smallest cell, grid.dxMm), with the DFT
 * F = sum_n f(t_n) exp(-j w t_n) (no dt factor; every phasor is later divided
 * by the source's DFT, which cancels it).
 */

export interface HuygensBox {
  /** Node index of the low face on each axis. */
  lo: [number, number, number];
  /** Node index of the high face on each axis. */
  hi: [number, number, number];
}

/** Clean cells between the PML's inner face and the Huygens box. */
export const HUYGENS_PML_GAP_CELLS = 2;
/**
 * Air margin (cells) a project needs on every side for the box to fit between
 * the PML gap and the board: the gap, the box plane, and one cell of air. The
 * high faces need one more than the low ones (see huygensBoxInsidePml), so
 * this is the high-side figure, applied everywhere.
 */
export const HUYGENS_MIN_AIR_MARGIN_CELLS = HUYGENS_PML_GAP_CELLS + 2;

export const VALUES_PER_SAMPLE_FREQUENCY = 8;

const AXIS_LENGTH_KEYS = ['nx', 'ny', 'nz'] as const;
type Axis = 0 | 1 | 2;
const meshAxis = (mesh: MeshLines, a: number): Float64Array => [mesh.x, mesh.y, mesh.z][a];

/**
 * The box HUYGENS_PML_GAP_CELLS clean cells inside the PML on every face. Low
 * side: PML E nodes are 0..L-1, so the first clean node is L. High side: the
 * PML starts at node n - L, so the last clean node is n - L - 1. Throws if a
 * face has no PML: the transform assumes the box radiates into open space.
 */
export function huygensBoxInsidePml(model: VoxelModel): HuygensBox {
  const { faces } = model.cpml;
  const pml = [[faces.xLow, faces.xHigh], [faces.yLow, faces.yHigh], [faces.zLow, faces.zHigh]];
  const lo: [number, number, number] = [0, 0, 0];
  const hi: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const [low, high] = pml[a];
    if (low === 0 || high === 0) throw new Error(`far field needs a PML on every face; axis ${'xyz'[a]} has a bare wall`);
    lo[a] = low + HUYGENS_PML_GAP_CELLS;
    hi[a] = model.grid[AXIS_LENGTH_KEYS[a]] - high - 1 - HUYGENS_PML_GAP_CELLS;
  }
  return { lo, hi };
}

/**
 * Throws unless every E edge that is not plain air (copper, dielectric, the
 * port) lies strictly inside the box: the equivalence theorem needs every
 * source inside the surface and only free space on it.
 */
export function assertBoxEnclosesSources(model: VoxelModel, box: HuygensBox): void {
  const { nx, ny, nz, courant } = model.grid;
  const airCurl = Math.fround(courant);
  const N = nx * ny * nz;
  for (let a = 0; a < 3; a++) {
    if (!(box.lo[a] >= 1 && box.hi[a] - box.lo[a] >= 2 && box.hi[a] < model.grid[AXIS_LENGTH_KEYS[a]] - 1)) {
      throw new Error(`Huygens box [${box.lo}]..[${box.hi}] is degenerate or touches the grid edge on axis ${'xyz'[a]}`);
    }
  }
  for (let component = 0; component < 3; component++) {
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const index = component * N + i + nx * (j + ny * k);
      if (model.eDecay[index] === 1 && model.eCurl[index] === airCurl) continue;
      const position = [i, j, k];
      position[component] += 0.5;
      for (let a = 0; a < 3; a++) {
        if (!(position[a] > box.lo[a] && position[a] < box.hi[a])) {
          throw new Error(`Huygens box [${box.lo}]..[${box.hi}] does not enclose the non-air ${'xyz'[component]} edge at node (${i}, ${j}, ${k}); ` +
            'give the model more air between the structure and the PML');
        }
      }
    }
  }
}

/** The box cut into patches, with what the transform needs for each. */
export interface HuygensSurface {
  box: HuygensBox;
  count: number;
  /** Cell index i + nx (j + ny k) of the patch's low corner node. */
  cell: Uint32Array;
  normalAxis: Uint8Array;
  /** +1 on a high face, -1 on a low face: the outward normal is outwardSign * axis. */
  outwardSign: Int8Array;
  /** Patch centre in metres, relative to the box centre: [x0, y0, z0, x1, ...]. */
  centreM: Float64Array;
  /** Patch edge lengths along p and q in metres: the patch area. */
  lengthPM: Float64Array;
  lengthQM: Float64Array;
  /** Weight of H in the cell below the face (the one above gets 1 - it): linear interpolation to the face. */
  hBelowWeight: Float32Array;
  /** dRef in metres: e = E * dRef and h = eta0 * H * dRef everywhere on the mesh. */
  fieldScaleM: number;
  /** Box centre in mesh coordinates (mm): the origin of centreM. */
  centreMm: [number, number, number];
}

export function huygensSurface(model: VoxelModel, box: HuygensBox): HuygensSurface {
  assertBoxEnclosesSources(model, box);
  const { nx, ny, dxMm } = model.grid;
  const nodes = [0, 1, 2].map((a) => meshAxis(model.mesh, a));
  const centreMm = [0, 1, 2].map((a) => (nodes[a][box.lo[a]] + nodes[a][box.hi[a]]) / 2) as [number, number, number];
  let count = 0;
  for (let a = 0; a < 3; a++) {
    const p = (a + 1) % 3;
    const q = (a + 2) % 3;
    count += 2 * (box.hi[p] - box.lo[p]) * (box.hi[q] - box.lo[q]);
  }
  const surface: HuygensSurface = {
    box, count,
    cell: new Uint32Array(count),
    normalAxis: new Uint8Array(count),
    outwardSign: new Int8Array(count),
    centreM: new Float64Array(3 * count),
    lengthPM: new Float64Array(count),
    lengthQM: new Float64Array(count),
    hBelowWeight: new Float32Array(count),
    fieldScaleM: dxMm * 1e-3,
    centreMm,
  };
  let s = 0;
  for (const a of [0, 1, 2] as const) {
    const p = ((a + 1) % 3) as Axis;
    const q = ((a + 2) % 3) as Axis;
    for (const [side, nodeA] of [[-1, box.lo[a]], [1, box.hi[a]]] as const) {
      const widthBelow = cellWidth(nodes[a], nodeA - 1);
      const widthAbove = cellWidth(nodes[a], nodeA);
      const hBelowWeight = widthAbove / (widthBelow + widthAbove);
      for (let iq = box.lo[q]; iq < box.hi[q]; iq++) {
        for (let ip = box.lo[p]; ip < box.hi[p]; ip++) {
          const node = [0, 0, 0];
          node[a] = nodeA;
          node[p] = ip;
          node[q] = iq;
          surface.cell[s] = node[0] + nx * (node[1] + ny * node[2]);
          surface.normalAxis[s] = a;
          surface.outwardSign[s] = side;
          surface.centreM[3 * s + a] = (nodes[a][nodeA] - centreMm[a]) * 1e-3;
          surface.centreM[3 * s + p] = ((nodes[p][ip] + nodes[p][ip + 1]) / 2 - centreMm[p]) * 1e-3;
          surface.centreM[3 * s + q] = ((nodes[q][iq] + nodes[q][iq + 1]) / 2 - centreMm[q]) * 1e-3;
          surface.lengthPM[s] = cellWidth(nodes[p], ip) * 1e-3;
          surface.lengthQM[s] = cellWidth(nodes[q], iq) * 1e-3;
          surface.hBelowWeight[s] = hBelowWeight;
          s++;
        }
      }
    }
  }
  return surface;
}

const fieldStrides = (grid: GridConfig) => [1, grid.nx, grid.nx * grid.ny];

/**
 * Normalised e_p, e_q, h_p, h_q at the centre of patch s (see the header).
 * Same arithmetic as huygens_dft.wgsl.
 */
export function tangentialFieldsAtPatch(surface: HuygensSurface, s: number, grid: GridConfig, e: Float32Array, h: Float32Array, out: Float64Array): void {
  const N = grid.nx * grid.ny * grid.nz;
  const strides = fieldStrides(grid);
  const a = surface.normalAxis[s];
  const p = (a + 1) % 3;
  const q = (a + 2) % 3;
  const [sa, sp, sq] = [strides[a], strides[p], strides[q]];
  // Index of component p (q) at the patch's corner cell, in the E and H buffers alike.
  const pAtCell = p * N + surface.cell[s];
  const qAtCell = q * N + surface.cell[s];
  out[0] = 0.5 * (e[pAtCell] + e[pAtCell + sq]);
  out[1] = 0.5 * (e[qAtCell] + e[qAtCell + sp]);
  const below = 0.5 * surface.hBelowWeight[s];
  const above = 0.5 - below;
  out[2] = above * (h[pAtCell] + h[pAtCell + sp]) + below * (h[pAtCell - sa] + h[pAtCell - sa + sp]);
  out[3] = above * (h[qAtCell] + h[qAtCell + sq]) + below * (h[qAtCell - sa] + h[qAtCell - sa + sq]);
}

/**
 * CPU running DFT of the tangential fields on the box, one call per step
 * (pass it to CpuFdtd.run). Phases are exact in float64.
 */
export class HuygensDftRecorder implements StepRecorder {
  readonly accumulators: Float64Array;
  private readonly omegaDt: Float64Array;
  private readonly fields = new Float64Array(4);
  private readonly phasors: Float64Array;

  constructor(readonly surface: HuygensSurface, readonly frequenciesHz: readonly number[], dtSec: number) {
    if (frequenciesHz.length === 0) throw new Error('HuygensDftRecorder: no frequencies');
    this.accumulators = new Float64Array(surface.count * frequenciesHz.length * VALUES_PER_SAMPLE_FREQUENCY);
    this.omegaDt = Float64Array.from(frequenciesHz, (f) => 2 * Math.PI * f * dtSec);
    this.phasors = new Float64Array(4 * frequenciesHz.length);
  }

  afterStep(stepIndex: number, sim: CpuFdtd): void {
    const frequencyCount = this.omegaDt.length;
    for (let f = 0; f < frequencyCount; f++) {
      const phaseE = this.omegaDt[f] * (stepIndex + 1);
      const phaseH = this.omegaDt[f] * (stepIndex + 0.5);
      this.phasors[4 * f] = Math.cos(phaseE);
      this.phasors[4 * f + 1] = -Math.sin(phaseE);
      this.phasors[4 * f + 2] = Math.cos(phaseH);
      this.phasors[4 * f + 3] = -Math.sin(phaseH);
    }
    const { fields, phasors, accumulators } = this;
    const grid = sim.model.grid;
    for (let s = 0; s < this.surface.count; s++) {
      tangentialFieldsAtPatch(this.surface, s, grid, sim.e, sim.h, fields);
      for (let f = 0; f < frequencyCount; f++) {
        const base = (s * frequencyCount + f) * VALUES_PER_SAMPLE_FREQUENCY;
        const [cE, sE, cH, sH] = [phasors[4 * f], phasors[4 * f + 1], phasors[4 * f + 2], phasors[4 * f + 3]];
        accumulators[base] += fields[0] * cE;
        accumulators[base + 1] += fields[0] * sE;
        accumulators[base + 2] += fields[1] * cE;
        accumulators[base + 3] += fields[1] * sE;
        accumulators[base + 4] += fields[2] * cH;
        accumulators[base + 5] += fields[2] * sH;
        accumulators[base + 6] += fields[3] * cH;
        accumulators[base + 7] += fields[3] * sH;
      }
    }
  }
}
