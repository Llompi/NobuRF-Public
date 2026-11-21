import { buildCpml, DEFAULT_CPML_GRADING, uniformFaces } from './cpml';
import { vacuumModel } from './fdtd_cpu';
import type { MeshLines } from './mesh';
import { idx3, portCoefficients, portMeshFactors, uniformPortMesh, type VoxelModel } from './voxelize';
import type { GridConfig } from './types';

/**
 * A short z-directed dipole in free space: a lumped port of `seriesCells` Ez
 * cells at the centre of a vacuum box with a CPML on every face, and nothing
 * else. Its current is uniform along a column much shorter than a wavelength,
 * so it radiates as a Hertzian dipole: directivity 1.5 (1.76 dBi) with a
 * sin^2(theta) pattern. The far-field transform's reference case.
 *
 * `mesh` places it on a graded mesh (grid.dxMm must be its smallest cell);
 * by default the grid's uniform cubic mesh.
 */
export function shortDipoleModel(grid: GridConfig, seriesCells: number, z0: number, mesh?: MeshLines): VoxelModel {
  const model = vacuumModel(grid);
  const N = grid.nx * grid.ny * grid.nz;
  const [i, j] = [grid.nx >> 1, grid.ny >> 1];
  const k0 = (grid.nz >> 1) - (seriesCells >> 1);
  const ezIndex = new Uint32Array(seriesCells);
  for (let n = 0; n < seriesCells; n++) {
    ezIndex[n] = 2 * N + idx3(grid, i, j, k0 + n);
    // The port pass owns these cells (as in rasterise.ts).
    model.eCurl[ezIndex[n]] = 0;
  }
  const portMesh = mesh ? portMeshFactors(mesh, i, j, k0, k0 + seriesCells, grid.dxMm) : uniformPortMesh(seriesCells);
  if (mesh) {
    model.mesh = mesh;
    model.cpml = buildCpml(grid, uniformFaces(grid.pmlCells), DEFAULT_CPML_GRADING, mesh);
  }
  model.ports = [{
    i, j, k0, k1: k0 + seriesCells, ezIndex,
    columns: 1, seriesCells, cells: seriesCells, mesh: portMesh,
    ...portCoefficients(grid.courant, 1, z0, portMesh.seriesLength, 1, portMesh.loopLengthX * portMesh.loopLengthY),
  }];
  model.signature = `short-dipole-${seriesCells}${mesh ? '-graded' : ''}`;
  return model;
}
