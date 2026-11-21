/**
 * Conformal copper validation: patches whose edges are not on mesh lines.
 *
 *   npx tsx scripts/validate/conformal_patch.ts circle <cell mm> <staircase|conformal> [<offset x mm> <offset y mm>]
 *   npx tsx scripts/validate/conformal_patch.ts rect <cell mm> <staircase|conformal|graded> <angle deg>
 *
 * circle: a probe-fed circular patch (probe on the node at (3, 0) mm), radius 8 mm, on 1.5 mm of eps_r 2.2
 *   (lossless, PEC copper), its centre moved by the offset against the mesh.
 *   Closed form for the TM11 mode: Balanis, Antenna Theory, 4th ed., eqs.
 *   14-67 and 14-69 (effective radius after Kaloi / Shen et al.).
 * rect: a 12 x 9 mm patch on the same substrate, probe-fed 2.5 mm off centre
 *   along its 9 mm side, turned by the angle about its centre (probe turned
 *   with it, then snapped to the nearest node). Turning changes nothing
 *   physical, so every angle should give the resonance of the unturned
 *   patch, whose edges lie on mesh lines (24 mm board, cells dividing 1.5 mm).
 *   A square would not do: its two degenerate modes split differently at
 *   each angle.
 *
 * The resonance is the peak of Re(Z_in) (Chang et al.'s definition), refined
 * with a parabola. Air and board sizes are fixed in mm, so only the cell
 * changes between runs. Prints one JSON line.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { solveProjectText } from '../noburf';

export type PatchKind = 'circle' | 'rect';
export type PatchMode = 'staircase' | 'conformal' | 'graded';

const RADIUS_MM = 8;
/** Rectangle: resonant length L along y before turning, so TM01 stands well apart from TM10. */
const RECT_W_MM = 12;
const RECT_L_MM = 9;
const H_MM = 1.5;
const EPS_R = 2.2;
const C_MM_PER_NS = 299.792458;
const mm = (v: number) => `${v.toFixed(6)} mm`;
const rect = (x0: number, y0: number, x1: number, y1: number) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** Balanis eq. 14-69: effective radius of a circular patch. */
function effectiveRadiusMm(a: number, h: number, epsR: number): number {
  return a * Math.sqrt(1 + ((2 * h) / (Math.PI * a * epsR)) * (Math.log((Math.PI * a) / (2 * h)) + 1.7726));
}
/** Balanis eq. 14-67: TM11 resonance, 1.8412 c / (2 pi a_e sqrt(eps_r)). */
export const circleClosedFormGHz = () => (1.8412 * C_MM_PER_NS) / (2 * Math.PI * effectiveRadiusMm(RADIUS_MM, H_MM, EPS_R) * Math.sqrt(EPS_R));

/** circle: `args` is the centre offset in mm; rect: `args[0]` is the angle in degrees. */
function geometry(kind: PatchKind, [a1, a2]: [number, number]): { patch: number[][]; probe: [number, number]; board: number } {
  if (kind === 'circle') {
    // 256 sides: the polygon's area is 0.01 % short of the circle's.
    const patch = Array.from({ length: 256 }, (_, k) => [a1 + RADIUS_MM * Math.cos((2 * Math.PI * k) / 256), a2 + RADIUS_MM * Math.sin((2 * Math.PI * k) / 256)]);
    // The probe stays on one mesh node (3 mm is a whole number of every cell in the sweep), so moving the patch moves only the copper.
    return { patch, probe: [3, 0], board: 2 * RADIUS_MM + 8 };
  }
  const t = (a1 * Math.PI) / 180;
  const turn = ([x, y]: number[]): [number, number] => [x * Math.cos(t) - y * Math.sin(t), x * Math.sin(t) + y * Math.cos(t)];
  return { patch: rect(-RECT_W_MM / 2, -RECT_L_MM / 2, RECT_W_MM / 2, RECT_L_MM / 2).map(turn), probe: turn([0, -2.5]), board: 24 };
}

/** The project file of one validation patch. */
export function patchProject(kind: PatchKind, cell: number, mode: PatchMode, args: [number, number] = [0, 0]) {
  if (mode === 'graded' && (kind !== 'rect' || args[0] !== 0)) throw new Error('graded is the reference for the unturned rectangle only');
  const g = geometry(kind, args);
  const halfBoard = g.board / 2;
  const pml = { type: 'pml', cells: 8 };
  const cellsFor = (lengthMm: number) => Math.max(1, Math.round(lengthMm / cell));
  return {
    noburf_project: 1,
    name: `${kind}-${mode}-${cell}`,
    variables: {},
    materials: { substrate: { eps_r: EPS_R, tan_delta: 0 } },
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'core', material: 'substrate', thickness: mm(H_MM) },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: rect(-halfBoard, -halfBoard, halfBoard, halfBoard).map(([x, y]) => [mm(x), mm(y)]) },
    geometry: {
      gnd: [{ id: 'ground', op: 'add', polygon: rect(-halfBoard, -halfBoard, halfBoard, halfBoard).map(([x, y]) => [mm(x), mm(y)]) }],
      top: [{ id: 'patch', op: 'add', polygon: g.patch.map(([x, y]) => [mm(x), mm(y)]) }],
    },
    ports: [{ id: 'probe', x: mm(g.probe[0]), y: mm(g.probe[1]), between: ['top', 'gnd'], reference_impedance_ohm: 50 }],
    boundaries: { x_min: pml, x_max: pml, y_min: pml, y_max: pml, z_min: { type: 'pec' }, z_max: pml },
    mesh: {
      cell: mm(cell),
      air_margin_cells: { xy: cellsFor(4), below: 1, above: cellsFor(8) },
      ...(mode === 'conformal' ? { conformal: true } : {}),
      ...(mode === 'graded' ? { graded: { edge_cell: mm(cell / 2), dielectric_cells: Math.round(H_MM / cell), max_growth: 1.3 } } : {}),
    },
    analysis: {
      f_min_ghz: kind === 'circle' ? 5.5 : 8.5,
      f_max_ghz: kind === 'circle' ? 8 : 12,
      n_freq: 251,
      loss_reference_ghz: 7,
      stop: { energy_decay_db: 50, max_steps: 60000 },
    },
    outputs: { zin_at_ghz: [kind === 'circle' ? 7 : 10] },
  };
}

/** Solve one validation patch on the CPU; its resonance is the peak of Re(Z_in), refined with a parabola. */
export async function patchResonance(kind: PatchKind, cell: number, mode: PatchMode, args: [number, number] = [0, 0]) {
  const project = patchProject(kind, cell, mode, args);
  const solve = await solveProjectText(JSON.stringify(project), project.name, false);
  const { fGHz, zRe } = solve.spec;
  let k = 0;
  for (let m = 1; m < zRe.length; m++) if (zRe[m] > zRe[k]) k = m;
  if (k === 0 || k === zRe.length - 1) throw new Error(`Re Z peak at the band edge (${fGHz[k]} GHz)`);
  const [p, q, r] = [zRe[k - 1], zRe[k], zRe[k + 1]];
  const offset = (0.5 * (p - r)) / (p - 2 * q + r);
  return { solve, fGHz: fGHz[k] + offset * (fGHz[1] - fGHz[0]), reZ: q - 0.25 * (p - r) * offset };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [kind, cellArg, mode, a1 = '0', a2 = '0'] = process.argv.slice(2);
  const cell = Number(cellArg);
  if (!['circle', 'rect'].includes(kind) || !(cell > 0) || !['staircase', 'conformal', 'graded'].includes(mode)) {
    throw new Error('usage: conformal_patch.ts circle|rect <cell mm> staircase|conformal|graded [<offset x> <offset y> | <angle deg>]');
  }
  const args: [number, number] = [Number(a1), Number(a2)];
  const { solve, fGHz, reZ } = await patchResonance(kind as PatchKind, cell, mode as PatchMode, args);
  const { nx, ny, nz } = solve.model.grid;
  console.log(JSON.stringify({
    kind, mode, cell, arg: args, cells: nx * ny * nz, steps: solve.steps, stopped: solve.stoppedOnEnergy,
    conformalFaces: solve.model.conformal?.hIndex.length ?? 0, fGHz, reZ,
    ...(kind === 'circle' ? { closedFormGHz: circleClosedFormGHz() } : {}),
    solveSeconds: solve.solveMs / 1000, warnings: solve.warnings,
  }));
}
