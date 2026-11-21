import { uniformFaces, type PmlFaces } from './cpml';
import type { ExcitationConfig, GridConfig, RunControl } from './types';

/** Speed of light (m/s) and free-space impedance (ohms). */
export const C0 = 299_792_458;
export const ETA0 = 376.730_313_668;
export const EPS0 = 8.854_187_8128e-12;

/**
 * Default grid: 64 x 64 x 48 cubic cells of 0.5 mm (32 x 32 x 24 mm box,
 * ~196k cells). Sized for a 5.8 GHz patch on 1.5 mm FR-4:
 *   - substrate = 3 cells thick (coarse but resolves the fringing field),
 *   - lambda0 at 6.5 GHz = 46 mm = 92 cells, so >= 20 cells per wavelength
 *     everywhere in the band (dispersion error well under 1 %),
 *   - CPML is 8 cells = 4 mm on every face.
 */
export const DEFAULT_GRID: GridConfig = {
  nx: 64,
  ny: 64,
  nz: 48,
  dxMm: 0.5,
  courant: 0.99 / Math.sqrt(3),
  pmlCells: 8,
  groundK: 12,
  stepsPerRun: 3000,
};

export const DEFAULT_EXCITATION: ExcitationConfig = {
  fMinGHz: 4.5,
  fMaxGHz: 7.5,
  nFreq: 121,
  z0: 50,
};

/** Fixed-length run of the demo grid, as the GPU path and the race use. */
export const FIXED_RUN: RunControl = { maxSteps: DEFAULT_GRID.stepsPerRun, stopAtEnergyDecayDb: null, energyCheckEverySteps: 100 };

/**
 * Run until the field energy is 50 dB below its peak (openEMS's default end
 * criterion is the same figure), capped at 20,000 steps.
 */
export const ENERGY_STOP_RUN: RunControl = { maxSteps: 20_000, stopAtEnergyDecayDb: 50, energyCheckEverySteps: 100 };

export function timestepSec(grid: GridConfig): number {
  return (grid.courant * grid.dxMm * 1e-3) / C0;
}

export function assertRunControl(control: RunControl): void {
  if (!Number.isInteger(control.maxSteps) || control.maxSteps < 1) throw new Error(`maxSteps must be a positive integer, got ${control.maxSteps}`);
  if (!Number.isInteger(control.energyCheckEverySteps) || control.energyCheckEverySteps < 1) {
    throw new Error(`energyCheckEverySteps must be a positive integer, got ${control.energyCheckEverySteps}`);
  }
  const stop = control.stopAtEnergyDecayDb;
  if (stop !== null && !(stop > 0)) throw new Error(`stopAtEnergyDecayDb must be > 0 dB or null, got ${stop}`);
}

/**
 * Throws with a readable message if the grid cannot run stably. `faces` gives
 * the PML thickness per face when it is not grid.pmlCells everywhere.
 */
export function assertStableGrid(grid: GridConfig, faces: PmlFaces = uniformFaces(grid.pmlCells)): void {
  assertStableCourant(grid);
  const axes = [['nx', faces.xLow, faces.xHigh], ['ny', faces.yLow, faces.yHigh], ['nz', faces.zLow, faces.zHigh]] as const;
  for (const [k, low, high] of axes) {
    if (!Number.isInteger(grid[k]) || grid[k] < low + high + 4) {
      throw new Error(`${k}=${grid[k]} is too small for a ${low} + ${high}-cell PML`);
    }
  }
}

export function assertStableCourant(grid: GridConfig): void {
  const limit = 1 / Math.sqrt(3);
  if (!(grid.courant > 0 && grid.courant < limit)) {
    throw new Error(`Courant number ${grid.courant} violates the 3D limit 1/sqrt(3) = ${limit.toFixed(4)}`);
  }
}
