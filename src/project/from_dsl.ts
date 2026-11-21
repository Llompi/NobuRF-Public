import { DEFAULT_EXCITATION, ENERGY_STOP_RUN } from '../engine/config';
import type { GridConfig, MicroFeature, MicroGeometryDSL } from '../engine/types';
import { parseProject, type CopperShape, type Point, type Project } from './schema';

/**
 * The parametric patch (MicroGeometryDSL) as a project file on `grid`.
 * Every coordinate is computed with the same arithmetic as isTopCopper in
 * geometry.ts, and the shapes are painted in its order (patch, chamfers,
 * inset notch, slots, stubs, feed line last), so rasterise() of the result
 * reproduces voxelize() edge for edge, with one exception: isTopCopper's
 * slots and notch also remove copper exactly on their edges, project cuts do
 * not. The results differ where such an edge passes through a Yee sample point.
 * Cuts are drawn past the patch outline (nothing is there to remove) so their
 * only edges inside the patch are the ones isTopCopper has too, and the
 * chamfers, whose diagonal isTopCopper already treats as strict, match exactly.
 */
export function patchProjectFromDsl(dsl: MicroGeometryDSL, grid: GridConfig): Project {
  const dx = grid.dxMm;
  const mm = (v: number) => `${v} mm`;
  const rect = (id: string, op: CopperShape['op'], cx: number, cy: number, w: number, h: number): CopperShape => ({
    id, op,
    polygon: [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]]
      .map(([x, y]): Point => [mm(x), mm(y)]),
  });
  const polygon = (id: string, op: CopperShape['op'], points: number[][]): CopperShape => ({
    id, op, polygon: points.map(([x, y]): Point => [mm(x), mm(y)]),
  });

  const { w_mm: W, l_mm: L } = dsl.patch;
  const { w_mm: fw, len_mm: flen, inset_depth_mm: d, inset_gap_mm: gap } = dsl.feed;
  const top: CopperShape[] = [rect('patch', 'add', 0, 0, W, L)];
  const c = dsl.corner_chamfer_mm;
  if (c > 0) {
    // Triangles with their hypotenuse on the chamfer line and both legs 1 mm outside the patch.
    top.push(polygon('chamfer_tr', 'cut', [[W / 2 - c - 1, L / 2 + 1], [W / 2 + 1, L / 2 - c - 1], [W / 2 + 1, L / 2 + 1]]));
    top.push(polygon('chamfer_bl', 'cut', [[-W / 2 + c + 1, -L / 2 - 1], [-W / 2 - 1, -L / 2 + c + 1], [-W / 2 - 1, -L / 2 - 1]]));
  }
  if (d > 0) {
    // Notch: |x| < fw/2 + gap and y < -L/2 + d, starting 1 mm below the patch edge.
    const halfNotch = fw / 2 + gap;
    top.push(polygon('inset_notch', 'cut', [[-halfNotch, -L / 2 - 1], [halfNotch, -L / 2 - 1], [halfNotch, -L / 2 + d], [-halfNotch, -L / 2 + d]]));
  }
  const featureShapes = (f: MicroFeature, op: CopperShape['op']): CopperShape[] => {
    if (f.kind !== 'u_slot') return [rect(f.id, op, f.x_mm, f.y_mm, f.w_mm, f.h_mm)];
    const { x_mm: cx, y_mm: cy, w_mm: w, h_mm: h, t_mm: t } = f;
    return [
      rect(`${f.id}_left`, op, cx - w / 2 + t / 2, cy, t, h),
      rect(`${f.id}_right`, op, cx + w / 2 - t / 2, cy, t, h),
      rect(`${f.id}_bottom`, op, cx, cy - h / 2 + t / 2, w, t),
    ];
  };
  for (const f of dsl.features) if (f.kind !== 'stub') top.push(...featureShapes(f, 'cut'));
  for (const f of dsl.features) if (f.kind === 'stub') top.push(...featureShapes(f, 'add'));
  top.push(polygon('feed', 'add', [[-fw / 2, -L / 2 - flen], [fw / 2, -L / 2 - flen], [fw / 2, -L / 2 + d], [-fw / 2, -L / 2 + d]]));

  // voxelize centres the ground plane in the box; recover the air margins from the grid.
  const marginX = grid.nx / 2 - grid.pmlCells - dsl.ground.w_mm / 2 / dx;
  const marginY = grid.ny / 2 - grid.pmlCells - dsl.ground.l_mm / 2 / dx;
  if (marginX !== marginY || !Number.isInteger(marginX)) {
    throw new Error(`ground ${dsl.ground.w_mm}x${dsl.ground.l_mm} mm does not sit on whole, equal air margins in this grid`);
  }
  const hCells = Math.max(1, Math.round(dsl.substrate.h_mm / dx));
  // Port node as voxelize picks it: x = 0, y stepped inward (ceil) onto the feed line.
  const pj = Math.ceil((-L / 2 - flen) / dx - 1e-9) + grid.ny / 2;
  const pml = { type: 'pml' as const, cells: grid.pmlCells };
  const board = rect('ground', 'add', 0, 0, dsl.ground.w_mm, dsl.ground.l_mm);

  return parseProject({
    noburf_project: 1,
    name: dsl.name,
    variables: {},
    // The legacy grid's loss model (a constant conductivity), which keeps this project bit for bit equal to voxelize().
    materials: { substrate: { eps_r: dsl.substrate.eps_r, tan_delta: dsl.substrate.tan_delta, ...(dsl.substrate.tan_delta > 0 ? { dispersion: { model: 'conductivity' } } : {}) } },
    stackup: [
      { type: 'copper', name: 'gnd', material: 'pec' },
      { type: 'dielectric', name: 'substrate', material: 'substrate', thickness: mm(dsl.substrate.h_mm) },
      { type: 'copper', name: 'top', material: 'pec' },
    ],
    board: { outline: board.polygon },
    geometry: { gnd: [board], top },
    ports: [{ id: 'feed', x: mm(0), y: mm((pj - grid.ny / 2) * dx), between: ['gnd', 'top'], reference_impedance_ohm: DEFAULT_EXCITATION.z0 }],
    boundaries: { x_min: pml, x_max: pml, y_min: pml, y_max: pml, z_min: pml, z_max: pml },
    mesh: {
      cell: mm(dx),
      air_margin_cells: { xy: marginX, below: grid.groundK - grid.pmlCells, above: grid.nz - grid.pmlCells - grid.groundK - hCells },
    },
    analysis: {
      f_min_ghz: DEFAULT_EXCITATION.fMinGHz,
      f_max_ghz: DEFAULT_EXCITATION.fMaxGHz,
      n_freq: DEFAULT_EXCITATION.nFreq,
      loss_reference_ghz: dsl.target_ghz,
      stop: { energy_decay_db: ENERGY_STOP_RUN.stopAtEnergyDecayDb!, max_steps: ENERGY_STOP_RUN.maxSteps },
    },
    outputs: { zin_at_ghz: [dsl.target_ghz] },
  });
}
