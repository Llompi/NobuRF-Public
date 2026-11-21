import { ETA0, timestepSec } from './config';
import { buildCpml, gridMesh, type Cpml } from './cpml';
import type { ModelDispersion } from './dispersion';
import type { SurfaceShape } from './surface_impedance';
import { cellWidth, dualWidth, type MeshLines } from './mesh';
import { isTopCopper } from './geometry';
import type { ConformalFaces } from './conformal';
import type { ThinSheetUpdate } from './thin_sheets';
import type { LumpedEdges } from './lumped';
import type { GridConfig, MicroGeometryDSL } from './types';

/**
 * Turns the geometry DSL into per-Yee-edge material coefficients.
 *
 * Memory layout (shared by the CPU reference and the WGSL kernels):
 *   cell index  idx = i + nx * (j + ny * k)
 *   E / H / eDecay / eCurl buffers hold 3 blocks of N = nx*ny*nz floats: [x | y | z].
 *
 * Yee positions (in cell units):
 *   Ex (i+1/2, j, k)   Ey (i, j+1/2, k)   Ez (i, j, k+1/2)
 *   Hx (i, j+1/2, k+1/2)   Hy (i+1/2, j, k+1/2)   Hz (i+1/2, j+1/2, k)
 *
 * Why per-component coefficients instead of one coefficient per cell: a copper
 * sheet lying in the plane z = k must zero the *tangential* Ex/Ey on that
 * plane but leave Ez (which straddles k..k+1) alone. With a single per-cell
 * value the sheet silently grows one cell thick, which for a 3-cell substrate
 * is a 33 % thickness error. Three blocks cost +1.5 MB and fix that.
 */

/**
 * How the lumped port is spread across the feed trace at its node row.
 *   line : one vertical Ez column at the feed centre (zero width, one edge).
 *          Same object as openEMS's AddLumpedPort with start/stop on one line.
 *   strip: one column on every grid node across the trace width, the
 *          resistance and source shared in parallel. V is read on the centre
 *          column and I is the total current through all columns, as openEMS
 *          does for a lumped port box as wide as the trace.
 */
export type LumpedPortKind = 'line' | 'strip';

export interface PortSpec {
  /** Node (i, j) of the centre port column, and its z range [k0, k1). */
  i: number;
  j: number;
  k0: number;
  k1: number;
  /**
   * Absolute indices into the E buffer (z block) of every port cell, column
   * after column from low x to high x, each column from k0 up.
   */
  ezIndex: Uint32Array;
  /** Per-cell resistive-source coefficients: E' = ca*E + cb*curlH + cs*vsCell. */
  ca: number;
  cb: number;
  cs: number;
  /** Ez columns side by side across the trace: 1 for a line port, odd for a strip. */
  columns: number;
  /** Ez cells in series in each column. The source voltage is split across them. */
  seriesCells: number;
  /** All port cells: columns * seriesCells. */
  cells: number;
  /** Mesh factors at the port column; all 1 (and seriesLength = seriesCells) on a uniform mesh. */
  mesh: PortMeshFactors;
}

/**
 * Lengths at the port column in units of dRef, the mesh's smallest cell.
 * V = sum of E dz up the column, I = loop integral of H around it, and the
 * source and resistor are split along the column in proportion to dz, so the
 * column carries a uniform E = V / height at DC whatever its cells.
 */
export interface PortMeshFactors {
  /** Column height / dRef. The source voltage per cell is V_source / seriesLength. */
  seriesLength: number;
  /** dz / dRef of each series cell, bottom up: the weights of the V sum. */
  cellLength: Float32Array;
  /** dRef / dual width along x and y at the column: the scale of the curl in the port cells' E update. */
  curlScaleX: number;
  curlScaleY: number;
  /** Dual width / dRef along x and y: the H loop's segment lengths for I. */
  loopLengthX: number;
  loopLengthY: number;
}

export function uniformPortMesh(seriesCells: number): PortMeshFactors {
  return { seriesLength: seriesCells, cellLength: new Float32Array(seriesCells).fill(1), curlScaleX: 1, curlScaleY: 1, loopLengthX: 1, loopLengthY: 1 };
}

/** Port factors for a column at node (i, j) spanning cells k0 .. k1 - 1 of a graded mesh. */
export function portMeshFactors(mesh: MeshLines, i: number, j: number, k0: number, k1: number, dRefMm: number): PortMeshFactors {
  const cellLength = Float32Array.from({ length: k1 - k0 }, (_, n) => cellWidth(mesh.z, k0 + n) / dRefMm);
  return {
    seriesLength: (mesh.z[k1] - mesh.z[k0]) / dRefMm,
    cellLength,
    curlScaleX: dRefMm / dualWidth(mesh.x, i),
    curlScaleY: dRefMm / dualWidth(mesh.y, j),
    loopLengthX: dualWidth(mesh.x, i) / dRefMm,
    loopLengthY: dualWidth(mesh.y, j) / dRefMm,
  };
}

export interface VoxelModel {
  grid: GridConfig;
  /** 3N floats: e <- eDecay*e + eCurl*curl(h). 1 on lossless edges. */
  eDecay: Float32Array;
  /** 3N floats: Sc/eps_r on lossless edges, 0 on PEC edges and on port cells. */
  eCurl: Float32Array;
  /** Node coordinates (mm) per axis; uniform for the DSL voxeliser. grid.dxMm is its smallest cell. */
  mesh: MeshLines;
  cpml: Cpml;
  /**
   * Lumped ports, in project order. Every port is a matched resistor; the
   * run's active port also carries the source (CpuFdtd.run, RunOptions.activePort).
   */
  ports: PortSpec[];
  patchK: number;
  /** nx*ny copper occupancy of the top layer, sampled at cell centres (viewer only). */
  topCopper: Uint8Array;
  /** Copper of finite conductivity; absent: every metal edge is PEC. */
  sheets?: ConductorSheets;
  /** Faces of conformal copper (conformal.ts); absent: copper is a staircase of whole edges. */
  conformal?: ConformalFaces;
  /** Thin copper sheets off the mesh planes (thin_sheets.ts); absent: none. */
  thinSheets?: ThinSheetUpdate;
  /** Edges carrying lumped R, L, C components (lumped.ts); absent: none. */
  lumped?: LumpedEdges;
  /**
   * Frequency-dependent and magnetic edges (dispersion.ts); absent: every E
   * edge is the constant eDecay/eCurl dielectric and every H edge vacuum.
   */
  dispersion?: ModelDispersion;
  /** Cheap hash of the material arrays, used to detect edits below grid resolution. */
  signature: string;
}

/** The port that carries the source must exist: a run without one would measure nothing. */
export function assertActivePort(model: VoxelModel, activePort: number): void {
  if (!Number.isInteger(activePort) || activePort < 0 || activePort >= model.ports.length) {
    throw new Error(`active port ${activePort} does not exist; the model has ${model.ports.length} port(s)`);
  }
}

export const idx3 = (g: GridConfig, i: number, j: number, k: number) => i + g.nx * (j + g.ny * k);

function fnv1a(buf: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let n = 0; n < buf.length; n++) {
    h ^= buf[n];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** VoxelModel.signature of a pair of material arrays. */
/** The parts of a model besides eDecay and eCurl that change what a run computes. */
type SignatureParts = Partial<Pick<VoxelModel, 'sheets' | 'dispersion' | 'lumped' | 'conformal' | 'thinSheets'>>;

export function materialSignature(eDecay: Float32Array, eCurl: Float32Array, { sheets, dispersion, lumped, conformal, thinSheets }: SignatureParts = {}): string {
  const bytes = (a: ArrayBufferView) => fnv1a(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  const surface = sheets?.surface;
  const surfacePart = surface ? bytes(surface.shapeIndex) + bytes(Float64Array.from([...surface.cornerHz, ...surface.shapes.flatMap((s) => [s.r0, ...s.weights])])) : '';
  const sheetPart = sheets ? bytes(sheets.eIndex) + bytes(sheets.normalAxis) + bytes(sheets.rsOhm) + surfacePart : '';
  const dispersionPart = [dispersion?.e, dispersion?.h].map((d) => (d ? bytes(d.index) + bytes(d.medium) + bytes(d.media) : '')).join('');
  const lumpedPart = lumped ? bytes(lumped.eIndex) + bytes(lumped.coef) : '';
  const conformalPart = conformal ? bytes(conformal.hIndex) + bytes(conformal.coef) : '';
  const thinPart = thinSheets ? [thinSheets.h, thinSheets.e].map((r) => bytes(r.target) + bytes(r.source) + bytes(r.coef)).join('') : '';
  return bytes(eCurl) + bytes(eDecay) + sheetPart + dispersionPart + lumpedPart + conformalPart + thinPart;
}

/**
 * Update coefficients of one E edge in a dielectric with relative permittivity
 * epsR and conductivity given as sigmaDtOverEps0 = sigma*dt/eps0. Semi-implicit
 * (Taflove eq. 3.31): the loss is averaged over E^n and E^(n+1), which is
 * stable for any sigma.
 */
export function dielectricEdge(courant: number, epsR: number, sigmaDtOverEps0: number): { decay: number; curl: number } {
  const half = sigmaDtOverEps0 / (2 * epsR);
  return { decay: (1 - half) / (1 + half), curl: courant / epsR / (1 + half) };
}

const MU0 = 4e-7 * Math.PI;

/**
 * The Yee grid at the edge of a zero-thickness sheet (scripts/validate/yee_edge_constants.ts):
 * its face-H loss summed over the sheet is that of a continuum sheet whose
 * edge current is cut off this many cells from the edge,
 */
export const YEE_EDGE_CUTOFF_CELLS = 0.272;
/** and the edge node alone carries this multiple of a^2 / 2, for an edge field |H| = a / (2 sqrt(x)) on each face. */
export const YEE_EDGE_LOSS_SHARE = 1.302;

/**
 * Factor on the surface resistance of the outermost copper edge of a sheet,
 * along a copper boundary, so the sheet loses what copper `thicknessMm` thick
 * loses at its edge. The current along a thin edge goes as 1/sqrt(distance),
 * and its loss, the integral of the square, has no finite limit for zero
 * thickness: the edge's thickness sets it. For a rectangular edge of
 * thickness t the exact map of the edge (Schwarz-Christoffel, z = t/(2 pi)
 * (sqrt(w^2 - 1) + arccosh w)) gives the loss of a zero-thickness sheet cut
 * off t / (4 pi e^pi) from its edge, about t / 290. The grid's own cutoff is
 * YEE_EDGE_CUTOFF_CELLS cells, so the edge node takes the loss between the
 * two: (a^2 / 2) ln(gridCutoff / copperCutoff), on top of the
 * YEE_EDGE_LOSS_SHARE * a^2 / 2 it has. Never below 1 (a cell finer than the
 * copper's cutoff would already resolve it).
 */
export function edgeLossFactor(edgeCellMm: number, thicknessMm: number): number {
  if (!(thicknessMm > 0)) throw new Error(`copper thickness must be > 0, got ${thicknessMm} mm`);
  const copperCutoffMm = thicknessMm / (4 * Math.PI * Math.exp(Math.PI));
  return Math.max(1, 1 + Math.log((YEE_EDGE_CUTOFF_CELLS * edgeCellMm) / copperCutoffMm) / YEE_EDGE_LOSS_SHARE);
}

/**
 * Surface resistance of a good conductor, thick compared with the skin depth:
 * Rs = sqrt(pi f mu0 / sigma). Copper at 5.8 GHz: 0.020 ohm (skin depth 0.87 um).
 */
export function surfaceResistanceOhm(conductivitySPerM: number, fHz: number): number {
  return Math.sqrt((Math.PI * fHz * MU0) / conductivitySPerM);
}

/**
 * Copper of finite conductivity, thick compared with the skin depth. Each
 * listed tangential E edge is held at zero (PEC: eCurl 0) and each of its two
 * faces is a surface impedance Rs, E_t = Rs n x H on that face. The face's E
 * enters the update of the H component next to it (sheetFaceLoss), so every
 * face loses Rs |H_t|^2 of its own: a trace with current on both faces loses
 * on both, which a single resistive E edge (loss Rs |K_top + K_bottom|^2)
 * cannot do. Rs is evaluated at one reference frequency, as for loss tangents.
 */
export interface ConductorSheets {
  /** E-buffer index of each sheet edge. */
  eIndex: Uint32Array;
  /** Axis (0 x, 1 y, 2 z) normal to the sheet at that edge. */
  normalAxis: Uint8Array;
  rsOhm: Float32Array;
  /**
   * The impedance's frequency dependence (surface_impedance.ts): each sheet's
   * impedance is rsOhm times its shape, z(f) = r0 + sum_k w_k (j f / f_k) / (1 + j f / f_k).
   * Absent: rsOhm at every frequency.
   */
  surface?: SheetSurface;
}

export interface SheetSurface {
  /** High-pass corners shared by every shape. */
  cornerHz: number[];
  shapes: SurfaceShape[];
  /** Shape of each sheet edge. */
  shapeIndex: Uint8Array;
}

/**
 * The per-step face loss of the H components next to copper (sheetFaceLoss).
 * Each listed component m loses, before the H update,
 *   rate[m] h + sum_k weight[m terms + k] (x - phi_k),
 * the high-pass terms of a frequency-dependent impedance (terms 0 for a
 * frequency-independent Rs). x is h at the time E is (h one half step ahead,
 * extrapolated from this step's h and the last: 1.5 h - 0.5 h_prev), since
 * the reactance of a lag of half a step would read as resistance
 * (X sin(w dt / 2), a loss error of w dt / 2 for copper's X = R). phi_k is x
 * low-passed at corner f_k by the bilinear transform:
 *   phi_k <- lowPass[2k] phi_k + lowPass[2k + 1] (x + x_prev).
 * State per component: h_prev, x_prev, then phi_k (FACE_STATE_HEADER + terms floats).
 */
export const FACE_STATE_HEADER = 2;

export interface FaceLoss {
  hIndex: Uint32Array;
  rate: Float32Array;
  terms: number;
  weight: Float32Array;
  /** Per term: the bilinear low-pass's (1 - r) / (1 + r) and r / (1 + r), r = pi f_k dt. */
  lowPass: Float32Array;
}

/**
 * Per-step decay of every H component on a face of a conductor sheet:
 * h <- h - rate * h before the H update. With h = eta0 H, the face E is
 * (Rs / eta0) h; in the H update it adds -Sc * diffScale * (Rs / eta0) * h, a
 * pure decay on every face whichever its orientation (power flows into the
 * conductor). An H component between two sheets takes both. A sheet edge
 * repainted as a dielectric since (eCurl != 0, e.g. a coax anti-pad) is no
 * longer copper and is skipped.
 */
/**
 * The fraction of one H component a copper face takes each step:
 * 1 - exp(-Sc * diffScale * Rs / eta0), where diffScale is the H update's
 * difference scale along the face normal. It is often below 1e-6, so it is
 * kept as a rate rather than a float32 factor next to 1, and the engines
 * apply it with a carried remainder (applyFaceLoss in fdtd_cpu.ts): rate * h
 * is then far below h's own float32 spacing, and a plain h -= rate * h would
 * round to h and lose nothing.
 */
export function faceLossRate(courant: number, hDiffScale: number, rsOhm: number): number {
  return -Math.expm1(-courant * hDiffScale * (rsOhm / ETA0));
}

/**
 * Largest share of an H component a copper face may take in one step, at any
 * frequency (see sheetFaceLoss). At the Nyquist frequency a step multiplies h
 * by 1 - (rate + 2 sum weight), so past 2 it grows: measured on a 1D line,
 * stable at 1.81 and unstable at 2.01. Half that is the limit. Copper on
 * 0.1 mm cells takes about 1e-3.
 */
export const MAX_FACE_STEP_LOSS = 1;

export function sheetFaceLoss(model: VoxelModel): FaceLoss {
  const sheets = model.sheets;
  const surface = sheets?.surface;
  const terms = surface?.cornerHz.length ?? 0;
  const lowPass = Float32Array.from((surface?.cornerHz ?? []).flatMap((f) => {
    const r = Math.PI * f * timestepSec(model.grid);
    return [(1 - r) / (1 + r), r / (1 + r)];
  }));
  if (!sheets) return { hIndex: new Uint32Array(0), rate: new Float32Array(0), terms, weight: new Float32Array(0), lowPass };
  const { nx, ny, nz, courant: Sc } = model.grid;
  const N = nx * ny * nz;
  const dims = [nx, ny, nz];
  const strides = [1, nx, nx * ny];
  const hScale = [model.cpml.x.hDiffScale, model.cpml.y.hDiffScale, model.cpml.z.hDiffScale];
  // Two faces on one component: it keeps (1 - r1)(1 - r2), so it loses r1 + r2 - r1 r2.
  // Their high-pass terms, each far below 1, add.
  const rates = new Map<number, { rate: number; weight: number[] }>();
  const add = (index: number, scale: number, rs: number, shape: SurfaceShape | null) => {
    const q = rates.get(index) ?? { rate: 0, weight: new Array<number>(terms).fill(0) };
    const r = faceLossRate(Sc, scale, rs * (shape?.r0 ?? 1));
    q.rate = q.rate + r - q.rate * r;
    shape?.weights.forEach((w, k) => (q.weight[k] += (Sc * scale * rs * w) / ETA0));
    rates.set(index, q);
  };
  for (let s = 0; s < sheets.eIndex.length; s++) {
    const e = sheets.eIndex[s];
    if (model.eCurl[e] !== 0) continue;
    const along = Math.floor(e / N);
    const c = e - along * N;
    const normal = sheets.normalAxis[s];
    if (normal === along || normal > 2) throw new Error(`sheet edge ${e}: normal axis ${normal} must be another axis than the edge's (${along})`);
    const h = (3 - along - normal) * N; // the H component tangential to the sheet and across the edge
    const at = [c % nx, Math.floor(c / nx) % ny, Math.floor(c / (nx * ny))][normal];
    const rs = sheets.rsOhm[s];
    const shape = surface ? surface.shapes[surface.shapeIndex[s]] : null;
    // H at index c sits half a cell above the edge along the normal; c - stride half a cell below.
    if (at < dims[normal] - 1) add(h + c, hScale[normal][at], rs, shape);
    if (at > 0) add(h + c - strides[normal], hScale[normal][at - 1], rs, shape);
  }
  const hIndex = Uint32Array.from(rates.keys());
  const listed = hIndex.length === 0 ? [] : [...rates.values()];
  // At the grid's Nyquist frequency h alternates sign, x = 1.5 h - 0.5 h_prev is 2 h and every low-pass is 0, so
  // one step takes (rate + 2 sum weight) h. Past MAX_FACE_STEP_LOSS the explicit face update nears instability.
  // A loop, not Math.max(...list): a fine board has a few hundred thousand faces, more arguments than a Web Worker's stack holds.
  let worst = 0;
  for (const q of listed) worst = Math.max(worst, q.rate + 2 * q.weight.reduce((sum, w) => sum + w, 0));
  if (worst > MAX_FACE_STEP_LOSS) {
    throw new Error(`a copper face would take ${(worst * 100).toPrecision(3)} % of its H field in one step at the grid's highest frequency ` +
      `(at most ${MAX_FACE_STEP_LOSS * 100} %; past 200 % the update grows): the surface impedance there is too large for the cells, ` +
      'as for a conductor far poorer than copper; raise its conductivity, lower f_max_ghz or the roughness, or use larger cells');
  }
  return {
    hIndex,
    rate: Float32Array.from(listed, (q) => q.rate),
    terms,
    weight: Float32Array.from(listed.flatMap((q) => q.weight)),
    lowPass,
  };
}

/**
 * A loss tangent as a constant conductivity, exact at fRefHz:
 * sigma = 2 pi f eps0 eps_r tan(delta). openEMS models FR-4 the same way.
 * Away from fRefHz the effective tan(delta) scales as fRef/f, under 25 % off
 * across a 4.5 to 7.5 GHz band referenced at 6 GHz.
 */
export function lossTangentSigmaDtOverEps0(epsR: number, tanDelta: number, fRefHz: number, dtSec: number): number {
  if (!(tanDelta >= 0)) throw new Error(`loss tangent must be >= 0, got ${tanDelta}`);
  return 2 * Math.PI * fRefHz * epsR * tanDelta * dtSec;
}

/**
 * Port coefficients for a resistive voltage source spread over the series Ez
 * cells of each of `columns` parallel columns (Piket-May / Taflove lumped
 * element, semi-implicit in E). Each column holds z0 * columns, split along it
 * in proportion to cell height, so the columns in parallel present z0 (openEMS
 * splits a lumped element's R the same way).
 * Fields are stored as e = E*dRef and h = eta0*H*dRef, so with lengths in
 * units of dRef (column height L, cross-section A of one Ez cell)
 *   b = Sc * eta0 * L / (eps_r * R_column * A)   is dimensionless,
 * written below as Sc * eta0 / (eps_r * R_column / L * A). On a uniform mesh
 * L is the cell count and A = 1.
 */
export function portCoefficients(courant: number, epsR: number, z0: number, seriesLength: number, columns = 1, crossSection = 1) {
  const rCell = (z0 * columns) / seriesLength;
  const b = (courant * ETA0) / (epsR * rCell * crossSection);
  const den = 1 + b / 2;
  return { ca: (1 - b / 2) / den, cb: courant / epsR / den, cs: b / den };
}

export function voxelize(g: MicroGeometryDSL, grid: GridConfig, z0 = 50, portKind: LumpedPortKind = 'line'): VoxelModel {
  const { nx, ny, nz, dxMm: dx, courant: Sc, groundK } = grid;
  const N = nx * ny * nz;
  const hCells = Math.max(1, Math.round(g.substrate.h_mm / dx));
  const patchK = groundK + hCells;
  if (groundK <= grid.pmlCells) throw new Error(`groundK=${groundK} must sit above the ${grid.pmlCells}-cell PML`);
  if (patchK >= nz - grid.pmlCells - 1) throw new Error('substrate too thick for this grid');

  const halfGW = g.ground.w_mm / 2;
  const halfGL = g.ground.l_mm / 2;
  const interiorHalfX = (nx / 2 - grid.pmlCells) * dx;
  const interiorHalfY = (ny / 2 - grid.pmlCells) * dx;
  if (halfGW > interiorHalfX + 1e-9 || halfGL > interiorHalfY + 1e-9) {
    throw new Error(
      `ground ${g.ground.w_mm}x${g.ground.l_mm} mm does not fit inside the PML-free region ` +
        `(${(2 * interiorHalfX).toFixed(1)}x${(2 * interiorHalfY).toFixed(1)} mm)`,
    );
  }

  const xOf = (fi: number) => (fi - nx / 2) * dx;
  const yOf = (fj: number) => (fj - ny / 2) * dx;
  const onBoard = (x: number, y: number) => Math.abs(x) <= halfGW + 1e-9 && Math.abs(y) <= halfGL + 1e-9;
  const er = g.substrate.eps_r;
  const substrateSigma = lossTangentSigmaDtOverEps0(er, g.substrate.tan_delta, g.target_ghz * 1e9, timestepSec(grid));
  const eDecay = new Float32Array(3 * N).fill(1);
  const eCurl = new Float32Array(3 * N);
  const setDielectric = (index: number, epsR: number, sigma: number) => {
    const edge = dielectricEdge(Sc, epsR, sigma);
    eDecay[index] = edge.decay;
    eCurl[index] = edge.curl;
  };
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = idx3(grid, i, j, k);
        // --- Ex at (i+1/2, j, k) and Ey at (i, j+1/2, k): tangential to z-planes.
        for (const comp of [0, 1] as const) {
          const x = comp === 0 ? xOf(i + 0.5) : xOf(i);
          const y = comp === 0 ? yOf(j) : yOf(j + 0.5);
          const board = onBoard(x, y);
          let eps = 1;
          let sigma = 0;
          let pec = false;
          if (board) {
            if (k > groundK && k < patchK) {
              eps = er;
              sigma = substrateSigma;
            } else if (k === groundK || k === patchK) {
              // Interface average of the two half cells.
              eps = (er + 1) / 2;
              sigma = substrateSigma / 2;
            }
            if (k === groundK) pec = true;
            if (k === patchK && isTopCopper(g, x, y)) pec = true;
          }
          if (pec) eCurl[comp * N + c] = 0;
          else setDielectric(comp * N + c, eps, sigma);
        }
        // --- Ez at (i, j, k+1/2): normal to the copper planes, only sees dielectric.
        const zIn = k >= groundK && k < patchK && onBoard(xOf(i), yOf(j));
        setDielectric(2 * N + c, zIn ? er : 1, zIn ? substrateSigma : 0);
      }
    }
  }

  // --- Port: vertical column at the open end of the feed line.
  const pi = nx / 2; // feed is centred on x = 0, which is node nx/2 (nx even)
  if (!Number.isInteger(pi)) throw new Error('nx must be even so the feed center is a grid node');
  const portYmm = -g.patch.l_mm / 2 - g.feed.len_mm;
  // Step inward (ceil) so the node is on the line, never just past its end.
  const pj = Math.ceil(portYmm / dx - 1e-9) + ny / 2;
  // Require copper Ex edges on both sides of the port node. A feed narrower
  // than one cell would voxelise to a single zero-width Ey wire whose
  // impedance has nothing to do with the requested trace width.
  const touches =
    eCurl[0 * N + idx3(grid, pi, pj, patchK)] === 0 &&
    eCurl[0 * N + idx3(grid, pi - 1, pj, patchK)] === 0;
  if (!touches) {
    throw new Error(
      `port node (${pi},${pj}) is not on the feed copper; feed width ${g.feed.w_mm} mm ` +
        `must be >= one cell (${dx} mm)`,
    );
  }
  // Strip: every node on the port row within the trace width. The trace is
  // centred on pi, so the count is odd and pi is the centre column.
  const halfColumns = portKind === 'line' ? 0 : Math.floor(g.feed.w_mm / 2 / dx + 1e-9);
  const columns = 2 * halfColumns + 1;
  const seriesCells = patchK - groundK;
  const cells = columns * seriesCells;
  const ezIndex = new Uint32Array(cells);
  for (let column = 0; column < columns; column++) {
    const ci = pi - halfColumns + column;
    const onCopper = eCurl[idx3(grid, ci - 1, pj, patchK)] === 0 || eCurl[idx3(grid, ci, pj, patchK)] === 0;
    if (!onCopper) throw new Error(`strip port column at node (${ci},${pj}) is not on the feed copper`);
    for (let n = 0; n < seriesCells; n++) {
      const cell = column * seriesCells + n;
      ezIndex[cell] = 2 * N + idx3(grid, ci, pj, groundK + n);
      // The main kernel leaves these alone (decay 1, curl 0); the port kernel owns them.
      eDecay[ezIndex[cell]] = 1;
      eCurl[ezIndex[cell]] = 0;
    }
  }
  const coef = portCoefficients(Sc, er, z0, seriesCells, columns);

  const topCopper = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      topCopper[i + nx * j] = isTopCopper(g, xOf(i + 0.5), yOf(j + 0.5)) ? 1 : 0;
    }
  }

  return {
    grid,
    eDecay,
    eCurl,
    mesh: gridMesh(grid),
    cpml: buildCpml(grid),
    ports: [{ i: pi, j: pj, k0: groundK, k1: patchK, ezIndex, columns, seriesCells, cells, mesh: uniformPortMesh(seriesCells), ...coef }],
    patchK,
    topCopper,
    signature: materialSignature(eDecay, eCurl),
  };
}
