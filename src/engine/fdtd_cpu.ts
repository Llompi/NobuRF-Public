import { ETA0, assertRunControl, timestepSec } from './config';
import { activeConformalFaces, applyConformalFaces, type ConformalFaces } from './conformal';
import { applySparseRows } from './thin_sheets';
import { DispersionState, energyFactors } from './dispersion';
import { EnergyStop } from './energy_stop';
import { LumpedState, lumpedEnergy, stepLumped } from './lumped';
import { buildCpml, gridMesh, slabLayer, uniformFaces, type AxisCpml, type PmlFaces } from './cpml';
import { sourceEndStep, sourceParams, sourceValue } from './source';
import type { CoaxRunPlanes, CoaxRunSamples, ExcitationConfig, GridConfig, PortSamples, RunControl } from './types';
import { assertActivePort, FACE_STATE_HEADER, sheetFaceLoss, type FaceLoss, type VoxelModel } from './voxelize';

/**
 * Something that reads the fields after every step of CpuFdtd.run, such as the
 * Huygens-box DFT of the far-field transform (huygens_box.ts). A run without
 * one costs nothing extra.
 */
export interface StepRecorder {
  /** Called after step `stepIndex` (0-based): E is at (stepIndex + 1) dt, H at (stepIndex + 1/2) dt. */
  afterStep(stepIndex: number, sim: CpuFdtd): void;
}

/** Largest carried fraction: 2^-23, twice the relative rounding of a float32 subtraction that leaves h nearly unchanged. */
export const MAX_CARRY = 2 ** -23;

/**
 * Takes each copper face's loss from its H component, in float32 as
 * sheet_loss.wgsl does. The loss (rate * h, often 1e-7 of h) is mostly below
 * h's float32 spacing, so h - loss alone would round back to h. The part the
 * subtraction drops is carried to the next step as a fraction of h (h changes
 * sign every half period, so an absolute remainder would be taken with the
 * wrong sign), and over many steps the component loses what the rate says.
 * With a frequency-dependent impedance (faces.terms > 0) the high-pass terms
 * of FaceLoss add to the loss; `state` holds their history,
 * FACE_STATE_HEADER + terms floats per component.
 */
export function applyFaceLoss(h: Float32Array, faces: FaceLoss, carry: Float32Array, state?: Float32Array): void {
  const f = Math.fround;
  const terms = faces.terms;
  const stride = FACE_STATE_HEADER + terms;
  for (let m = 0; m < faces.hIndex.length; m++) {
    const i = faces.hIndex[m];
    const before = h[i];
    let loss = f(f(faces.rate[m] + carry[m]) * before);
    if (terms > 0) {
      const base = m * stride;
      const x = f(f(1.5 * before) - f(0.5 * state![base]));
      const sum = f(x + state![base + 1]);
      for (let k = 0; k < terms; k++) {
        const phi = f(f(faces.lowPass[2 * k] * state![base + FACE_STATE_HEADER + k]) + f(faces.lowPass[2 * k + 1] * sum));
        loss = f(loss + f(faces.weight[m * terms + k] * f(x - phi)));
        state![base + FACE_STATE_HEADER + k] = phi;
      }
      state![base] = before;
      state![base + 1] = x;
    }
    if (loss === 0) continue;
    const after = f(before - loss);
    // The residue is under half a float32 spacing of `after`; as a fraction of a small `before` (the high-pass terms keep a
    // loss where h crosses zero) it could be large, so it is held to MAX_CARRY, which a loss proportional to h never reaches.
    carry[m] = before === 0 ? 0 : Math.max(-MAX_CARRY, Math.min(MAX_CARRY, f(f(loss - f(before - after)) / before)));
    h[i] = after;
  }
}

/**
 * CPU reference implementation of exactly the same update equations as the
 * WGSL kernels (shaders/*.wgsl). It is the oracle: every GPU kernel change is
 * compared against it, and Node tests use it because CI has no GPU.
 * Plain JavaScript, O(N) per step: fine for test grids, slow for the 196k-cell
 * demo grid (about 15 s per 3,000 steps). Do not use it in the UI.
 *
 * Normalised fields: e = E*dRef, h = eta0*H*dRef, where dRef is the smallest
 * cell (all cells on a uniform mesh):
 *   h  = h - Sc * curl(e)                     (forward differences)
 *   e  = eDecay*e + eCurl * curl(h)           (backward differences)
 * Every difference is multiplied by its axis's difference scale from cpml.ts:
 * 1/kappa in the CPML, times dRef / width on a graded mesh (exactly 1 on a
 * uniform mesh outside the PML).
 * eDecay and eCurl are per Yee edge (see voxelize.ts): 1 and Sc/eps_r for a
 * lossless dielectric, 0 curl on PEC edges, and the semi-implicit conductivity
 * form for lossy dielectrics. Missing neighbours outside the box read as 0.
 *
 * Open boundaries are a CPML (cpml.ts). Inside a PML slab each difference is
 * scaled by 1/kappa in the main pass, and a second pass over the slabs only
 * updates the auxiliary psi fields and adds them, scaled the same way as the
 * curl they belong to. The split is exact because the update is linear.
 */
export class CpuFdtd {
  readonly N: number;
  readonly e: Float32Array;
  readonly h: Float32Array;
  /** psi per axis [x, y, z]; each holds two slab blocks (see slabUpdate). */
  readonly psiE: Float32Array[];
  readonly psiH: Float32Array[];
  /** Conductor-sheet faces: these H components lose `rate` of themselves before each H update (sheetFaceLoss). */
  private readonly faceLoss: FaceLoss;
  /** The part of each face's loss that float32 h could not take yet, as a fraction of h (applyFaceLoss). */
  private readonly faceCarry: Float32Array;
  /** History of a frequency-dependent face impedance per component (applyFaceLoss). */
  private readonly faceLowPassed: Float32Array;
  /** State of the model's lumped components (lumped.ts); null without any. */
  readonly lumpedState: LumpedState | null;
  /** Dispersive and magnetic edges (dispersion.ts): saved before each update, redone after its CPML pass. */
  private readonly dispersionE: DispersionState | null;
  private readonly dispersionH: DispersionState | null;
  /** energyFactors of the dispersive E and magnetic H edges. */
  private readonly energyFactors: Record<'e' | 'h', Float32Array | undefined>;

  /** Faces next to conformal copper: their H update is divided by their free area (conformal.ts). */
  private readonly conformal: ConformalFaces | null;
  /** Ghost E pieces and H regions of thin sheets (thin_sheets.ts); empty without any. */
  readonly ghostE: Float32Array;
  readonly ghostH: Float32Array;

  constructor(readonly model: VoxelModel) {
    this.ghostE = new Float32Array(model.thinSheets?.ghostE ?? 0);
    this.ghostH = new Float32Array(model.thinSheets?.ghostH ?? 0);
    this.conformal = activeConformalFaces(model);
    this.faceLoss = sheetFaceLoss(model);
    this.faceCarry = new Float32Array(this.faceLoss.hIndex.length);
    this.faceLowPassed = new Float32Array(this.faceLoss.terms === 0 ? 0 : this.faceLoss.hIndex.length * (FACE_STATE_HEADER + this.faceLoss.terms));
    this.lumpedState = model.lumped ? new LumpedState(model.lumped.eIndex.length) : null;
    this.dispersionE = model.dispersion?.e ? new DispersionState(model.dispersion.e) : null;
    this.dispersionH = model.dispersion?.h ? new DispersionState(model.dispersion.h) : null;
    this.energyFactors = { e: energyFactors(model, 'e'), h: energyFactors(model, 'h') };
    const { nx, ny, nz } = model.grid;
    this.N = nx * ny * nz;
    this.e = new Float32Array(3 * this.N);
    this.h = new Float32Array(3 * this.N);
    const axes = [model.cpml.x, model.cpml.y, model.cpml.z];
    const slabCells = axes.map((ax) => ((ax.low + ax.high) * this.N) / ax.n);
    this.psiE = slabCells.map((n) => new Float32Array(2 * n));
    this.psiH = slabCells.map((n) => new Float32Array(2 * n));
  }

  reset(): void {
    this.e.fill(0);
    this.h.fill(0);
    this.ghostE.fill(0);
    this.ghostH.fill(0);
    this.faceCarry.fill(0);
    this.faceLowPassed.fill(0);
    for (const p of [...this.psiE, ...this.psiH]) p.fill(0);
    this.lumpedState?.reset();
    this.dispersionE?.reset();
    this.dispersionH?.reset();
  }

  updateH(): void {
    const { nx, ny, nz, courant: Sc } = this.model.grid;
    const { e, h, N } = this;
    // Before the face loss: a magnetic edge's update divides the surface-impedance term by mu too, as Faraday's law does.
    this.dispersionH?.snapshot(h);
    applyFaceLoss(h, this.faceLoss, this.faceCarry, this.faceLowPassed);
    const kx = this.model.cpml.x.hDiffScale;
    const ky = this.model.cpml.y.hDiffScale;
    const kz = this.model.cpml.z.hDiffScale;
    const sy = nx;
    const sz = nx * ny;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          const exc = e[c];
          const eyc = e[N + c];
          const ezc = e[2 * N + c];
          const exJ = j + 1 < ny ? e[c + sy] : 0;
          const exK = k + 1 < nz ? e[c + sz] : 0;
          const eyI = i + 1 < nx ? e[N + c + 1] : 0;
          const eyK = k + 1 < nz ? e[N + c + sz] : 0;
          const ezI = i + 1 < nx ? e[2 * N + c + 1] : 0;
          const ezJ = j + 1 < ny ? e[2 * N + c + sy] : 0;
          h[c] -= Sc * ((ezJ - ezc) * ky[j] - (eyK - eyc) * kz[k]);
          h[N + c] -= Sc * ((exK - exc) * kz[k] - (ezI - ezc) * kx[i]);
          h[2 * N + c] -= Sc * ((eyI - eyc) * kx[i] - (exJ - exc) * ky[j]);
        }
      }
    }
    this.slabUpdate('h');
    // E has not changed since the main pass, so this is the same curl again, scaled.
    if (this.conformal) applyConformalFaces(this.conformal, this.e, this.h);
    if (this.model.thinSheets) applySparseRows(this.model.thinSheets.h, this.h, this.ghostH, this.e, this.ghostE);
    this.dispersionH?.update(h, Sc);
  }

  updateE(): void {
    const { nx, ny, nz } = this.model.grid;
    const { e, h, N } = this;
    const { eDecay, eCurl } = this.model;
    const kx = this.model.cpml.x.eDiffScale;
    const ky = this.model.cpml.y.eDiffScale;
    const kz = this.model.cpml.z.eDiffScale;
    const sy = nx;
    const sz = nx * ny;
    this.dispersionE?.snapshot(e);
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const c = i + nx * (j + ny * k);
          const hxc = h[c];
          const hyc = h[N + c];
          const hzc = h[2 * N + c];
          const hxJ = j > 0 ? h[c - sy] : 0;
          const hxK = k > 0 ? h[c - sz] : 0;
          const hyI = i > 0 ? h[N + c - 1] : 0;
          const hyK = k > 0 ? h[N + c - sz] : 0;
          const hzI = i > 0 ? h[2 * N + c - 1] : 0;
          const hzJ = j > 0 ? h[2 * N + c - sy] : 0;
          e[c] = eDecay[c] * e[c] + eCurl[c] * ((hzc - hzJ) * ky[j] - (hyc - hyK) * kz[k]);
          e[N + c] = eDecay[N + c] * e[N + c] + eCurl[N + c] * ((hxc - hxK) * kz[k] - (hzc - hzI) * kx[i]);
          e[2 * N + c] = eDecay[2 * N + c] * e[2 * N + c] + eCurl[2 * N + c] * ((hyc - hyI) * kx[i] - (hxc - hxJ) * ky[j]);
        }
      }
    }
    this.slabUpdate('e');
    if (this.model.thinSheets) applySparseRows(this.model.thinSheets.e, this.e, this.ghostE, this.h, this.ghostH);
    this.dispersionE?.update(e, this.model.grid.courant, { decay: eDecay, curl: eCurl });
    if (this.lumpedState) stepLumped(this.model.lumped!, this.lumpedState, this.e);
  }

  /**
   * CPML pass for one field. For axis a, let p and q be the next two
   * components in cyclic order (a = x: p = y, q = z). The curls contain
   *   E_p: -d_a H_q    E_q: +d_a H_p    H_p: -d_a E_q    H_q: +d_a E_p
   * so psi block 0 follows the derivative that feeds component p, block 1 the
   * one that feeds q, and they are added with signs - and +.
   * E uses backward differences at node u, H forward differences at u + 1/2.
   */
  private slabUpdate(field: 'e' | 'h'): void {
    const { grid, eCurl } = this.model;
    const dims = [grid.nx, grid.ny, grid.nz];
    const strides = [1, grid.nx, grid.nx * grid.ny];
    const { N } = this;
    const target = field === 'e' ? this.e : this.h;
    const source = field === 'e' ? this.h : this.e;
    const axes: AxisCpml[] = [this.model.cpml.x, this.model.cpml.y, this.model.cpml.z];
    for (let a = 0; a < 3; a++) {
      const ax = axes[a];
      const layers = ax.low + ax.high;
      if (layers === 0) continue;
      const p = (a + 1) % 3;
      const q = (a + 2) % 3;
      const psi = field === 'e' ? this.psiE[a] : this.psiH[a];
      const slabN = (layers * N) / ax.n;
      const b = field === 'e' ? ax.eB : ax.hB;
      const cc = field === 'e' ? ax.eC : ax.hC;
      const sa = strides[a];
      const [dp, dq] = [dims[p], dims[q]];
      const [sp, sq] = [strides[p], strides[q]];
      // psi index: the slab is the box with axis a shrunk to `layers`, x fastest.
      const slabDims = [...dims];
      slabDims[a] = layers;
      const slabStrides = [1, slabDims[0], slabDims[0] * slabDims[1]];
      const [ta, tp, tq] = [slabStrides[a], slabStrides[p], slabStrides[q]];
      for (let u = 0; u < ax.n; u++) {
        const layer = slabLayer(ax, u);
        if (layer < 0) continue;
        const bu = b[u];
        const cu = cc[u];
        for (let iq = 0; iq < dq; iq++) {
          for (let ip = 0; ip < dp; ip++) {
            const cell = u * sa + ip * sp + iq * sq;
            const s = layer * ta + ip * tp + iq * tq;
            let dP: number;
            let dQ: number;
            if (field === 'e') {
              // backward difference of H_q and H_p along a
              dP = source[q * N + cell] - (u > 0 ? source[q * N + cell - sa] : 0);
              dQ = source[p * N + cell] - (u > 0 ? source[p * N + cell - sa] : 0);
            } else {
              // forward difference of E_q and E_p along a
              dP = (u + 1 < ax.n ? source[q * N + cell + sa] : 0) - source[q * N + cell];
              dQ = (u + 1 < ax.n ? source[p * N + cell + sa] : 0) - source[p * N + cell];
            }
            const psiP = (psi[s] = bu * psi[s] + cu * dP);
            const psiQ = (psi[slabN + s] = bu * psi[slabN + s] + cu * dQ);
            if (field === 'e') {
              target[p * N + cell] -= eCurl[p * N + cell] * psiP;
              target[q * N + cell] += eCurl[q * N + cell] * psiQ;
            } else {
              target[p * N + cell] += grid.courant * psiP;
              target[q * N + cell] -= grid.courant * psiQ;
            }
          }
        }
      }
    }
  }

  /**
   * The H loop around Ez cell c, with the Hy sides (differenced along x)
   * weighted by `wx` and the Hx sides by `wy`: with the curl scales it is curl(h)_z as in updateE,
   * with the loop lengths it is the current through the cell. The port is
   * never inside a PML.
   */
  private loopHz(c: number, wx: number, wy: number): number {
    const { nx } = this.model.grid;
    const { h, N } = this;
    return (h[N + c] - h[N + c - 1]) * wx - (h[c] - h[c - nx]) * wy;
  }

  /**
   * Resistive port update + V/I probe for every port. Every port is a matched
   * resistor; only `activePort` also carries the source vs. Returns [v, i] per
   * port, where v = -(sum of E dz over the centre column) = V_top - V_bottom
   * and i = current flowing up through the middle cell of every column (Ampere
   * loop of H around each, converted to amps; their sum is the loop around the strip).
   */
  updatePort(vs: number, activePort: number): Array<[v: number, i: number]> {
    return this.model.ports.map((p, n) => {
      const N = this.N;
      const m = p.mesh;
      const vsCell = n === activePort ? vs / m.seriesLength : 0;
      for (let cell = 0; cell < p.cells; cell++) {
        const ez = p.ezIndex[cell];
        const c = ez - 2 * N;
        this.e[ez] = p.ca * this.e[ez] + p.cb * this.loopHz(c, m.curlScaleX, m.curlScaleY) + p.cs * vsCell;
      }
      const centreFirst = (p.columns >> 1) * p.seriesCells;
      let vsum = 0;
      for (let cell = 0; cell < p.seriesCells; cell++) vsum += this.e[p.ezIndex[centreFirst + cell]] * m.cellLength[cell];
      const mid = p.seriesCells >> 1;
      let current = 0;
      for (let column = 0; column < p.columns; column++) {
        current += this.loopHz(p.ezIndex[column * p.seriesCells + mid] - 2 * N, m.loopLengthY, m.loopLengthX);
      }
      return [-vsum, current / ETA0];
    });
  }

  /**
   * Solve with the source on `activePort`. With an energy stop, the run ends
   * at the first check after the source has finished where the field energy
   * is `stopAtEnergyDecayDb` below its peak; otherwise it runs maxSteps.
   */
  run(exc: ExcitationConfig, control: RunControl, recorder?: StepRecorder, activePort = 0): PortSamples {
    assertActivePort(this.model, activePort);
    const r = this.runWithCoax(exc, control, recorder, activePort, { source: null, probes: [] });
    return { ...r.ports[activePort], ports: r.ports, dtSec: r.dtSec, energyDecayDb: r.energyDecayDb, stoppedOnEnergy: r.stoppedOnEnergy };
  }

  /**
   * run() with coax planes: the source is on lumped port `activePort`, or on
   * coax.source when activePort is null (every lumped port is then a passive
   * load), and every coax probe is read after each step.
   */
  runWithCoax(exc: ExcitationConfig, control: RunControl, recorder: StepRecorder | undefined, activePort: number | null, coax: CoaxRunPlanes): CoaxRunSamples {
    assertRunControl(control);
    if (activePort === null ? coax.source === null : coax.source !== null) throw new Error('a run needs exactly one source: a lumped port or a coax source plane');
    if (activePort !== null) assertActivePort(this.model, activePort);
    const measureEnergy = control.stopAtEnergyDecayDb !== null;
    const dt = timestepSec(this.model.grid);
    const sp = sourceParams(exc);
    const sourceEnd = sourceEndStep(sp, dt);
    const ports = this.model.ports.map(() => ({ v: new Float32Array(control.maxSteps), i: new Float32Array(control.maxSteps) }));
    const probes = coax.probes.map(() => new Float64Array(control.maxSteps));
    this.reset();
    const energyStop = new EnergyStop(control, sourceEnd);
    let steps = control.maxSteps;
    for (let n = 0; n < control.maxSteps; n++) {
      this.updateH();
      this.updateE();
      const s = sourceValue(sp, (n + 0.5) * dt);
      if (coax.source) {
        const { edges, mode } = coax.source;
        for (let m = 0; m < edges.length; m++) this.e[edges[m]] += s * mode[m];
      }
      coax.probes.forEach((p, q) => {
        let v = 0;
        for (let m = 0; m < p.edges.length; m++) v += p.weights[m] * this.e[p.edges[m]];
        probes[q][n] = v;
      });
      this.updatePort(s, activePort ?? -1).forEach(([vn, in_], p) => {
        ports[p].v[n] = vn;
        ports[p].i[n] = in_;
      });
      recorder?.afterStep(n, this);
      if (measureEnergy && (n + 1) % control.energyCheckEverySteps === 0 && energyStop.check(n + 1, this.energy())) {
        steps = n + 1;
        break;
      }
    }
    return {
      ports: ports.map(({ v, i }) => ({ v: v.slice(0, steps), i: i.slice(0, steps) })),
      coaxProbeVolts: probes.map((p) => p.slice(0, steps)),
      dtSec: dt,
      steps,
      energyDecayDb: energyStop.decayDb,
      stoppedOnEnergy: energyStop.reached,
    };
  }

  /**
   * Field energy in normalised units (proportional to joules): each edge's
   * eps_r e^2 or h^2 times the volume it stands for, so a graded mesh's large
   * cells and a substrate's slow fields count as they should. eps_r comes back
   * from the update coefficients, eps_r = Sc (1 + eDecay) / (2 eCurl), exact for
   * dielectricEdge. PEC, copper and port edges (eCurl = 0) count 0. Lumped
   * component edges count with their parallel capacitance in eps_r, plus the
   * energy of their inductors and series capacitors (lumpedEnergy).
   * Dispersive and magnetic edges count their high-frequency value and the
   * energy held in their poles instead (DispersionState.energyCorrection).
   * energy.wgsl, lumped_energy.wgsl and dispersion.wgsl compute the same sum on the GPU.
   */
  energy(): number {
    const { nx, ny, nz, courant: Sc } = this.model.grid;
    const { e, h, N } = this;
    const { eDecay, eCurl, cpml } = this.model;
    const eTerm = (at: number, volume: number) => (eCurl[at] === 0 ? 0 : ((Sc * (1 + eDecay[at])) / (2 * eCurl[at])) * volume * e[at] * e[at]);
    let s = 0;
    let c = 0;
    for (let k = 0; k < nz; k++) {
      // Widths in units of the smallest cell: a cell (H position) or a dual cell (E position).
      const [cellZ, dualZ] = [1 / cpml.z.hDiffScale[k], 1 / cpml.z.eDiffScale[k]];
      for (let j = 0; j < ny; j++) {
        const [cellY, dualY] = [1 / cpml.y.hDiffScale[j], 1 / cpml.y.eDiffScale[j]];
        for (let i = 0; i < nx; i++, c++) {
          const [cellX, dualX] = [1 / cpml.x.hDiffScale[i], 1 / cpml.x.eDiffScale[i]];
          s += eTerm(c, cellX * dualY * dualZ) + eTerm(N + c, dualX * cellY * dualZ) + eTerm(2 * N + c, dualX * dualY * cellZ);
          s += dualX * cellY * cellZ * h[c] * h[c] + cellX * dualY * cellZ * h[N + c] * h[N + c] + cellX * cellY * dualZ * h[2 * N + c] * h[2 * N + c];
        }
      }
    }
    if (this.dispersionE) s += this.dispersionE.energyCorrection(e, this.energyFactors.e!);
    if (this.dispersionH) s += this.dispersionH.energyCorrection(h, this.energyFactors.h!);
    return this.lumpedState ? s + lumpedEnergy(this.model.lumped!, this.lumpedState) : s;
  }
}

/** Vacuum model (no copper, no port) for solver-only tests. */
export function vacuumModel(grid: GridConfig, faces?: PmlFaces): VoxelModel {
  const N = grid.nx * grid.ny * grid.nz;
  return {
    grid,
    eDecay: new Float32Array(3 * N).fill(1),
    eCurl: new Float32Array(3 * N).fill(grid.courant),
    mesh: gridMesh(grid),
    cpml: buildCpml(grid, faces),
    ports: [],
    patchK: 0,
    topCopper: new Uint8Array(grid.nx * grid.ny),
    signature: 'vacuum',
  };
}

/**
 * Closed PEC box filled with one dielectric, no PML: the analytic cavity
 * tests. The high faces are PEC because missing neighbours read 0; the low
 * faces are made PEC here by zeroing their tangential E.
 */
export function pecBoxModel(grid: GridConfig, epsR: number): VoxelModel {
  const { nx, ny, nz } = grid;
  const N = nx * ny * nz;
  const m = vacuumModel(grid, uniformFaces(0));
  m.eCurl.fill(grid.courant / epsR);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = i + nx * (j + ny * k);
    if (j === 0 || k === 0) m.eCurl[c] = 0;
    if (i === 0 || k === 0) m.eCurl[N + c] = 0;
    if (i === 0 || j === 0) m.eCurl[2 * N + c] = 0;
  }
  return m;
}
