/**
 * Units and reference limits for emissions views. The solver's phasors are
 * peak values for a 1 V peak source behind the port's reference resistance
 * (near_to_far.ts); emissions are quoted as RMS field strengths for a stated
 * drive power.
 */

/**
 * Factor from the solver's fields to those of a source that makes `driveDbm`
 * available to a matched load. A 1 V peak source behind z0 makes
 * 1 / (8 z0) W available; fields scale with the square root of power.
 */
export function driveScale(driveDbm: number, z0Ohm: number): number {
  const availableW = 1e-3 * 10 ** (driveDbm / 10);
  return Math.sqrt(availableW * 8 * z0Ohm);
}

/** dB(µV/m) of a peak phasor magnitude in V/m (RMS = peak / sqrt 2). */
export const dbMicrovoltPerMetre = (peakVPerM: number): number => 20 * Math.log10(peakVPerM / Math.SQRT2 / 1e-6);

/** dB(µA/m) of a peak phasor magnitude in A/m. */
export const dbMicroampPerMetre = (peakAPerM: number): number => 20 * Math.log10(peakAPerM / Math.SQRT2 / 1e-6);

export interface RadiatedLimit {
  name: string;
  distanceM: number;
  /** Limit in dB(µV/m) from each band's lower edge (MHz) up to the next band's. */
  bands: ReadonlyArray<{ fromMHz: number; dbMicrovoltPerMetre: number }>;
}

/**
 * FCC Part 15.109 radiated limits for unintentional radiators (digital
 * devices), from 30 MHz up; above 1 GHz they apply to the average detector,
 * with the peak allowed 20 dB more (15.35(b)). 15.109(a), Class B at 3 m:
 * 100, 150, 200, 500 µV/m. 15.109(b), Class A at 10 m: 90, 150, 210, 300 µV/m.
 */
export const FCC_CLASS_B_3M: RadiatedLimit = {
  name: 'FCC Part 15 Class B', distanceM: 3,
  bands: [{ fromMHz: 30, dbMicrovoltPerMetre: 40 }, { fromMHz: 88, dbMicrovoltPerMetre: 43.5 }, { fromMHz: 216, dbMicrovoltPerMetre: 46 }, { fromMHz: 960, dbMicrovoltPerMetre: 54 }],
};

export const FCC_CLASS_A_10M: RadiatedLimit = {
  name: 'FCC Part 15 Class A', distanceM: 10,
  bands: [{ fromMHz: 30, dbMicrovoltPerMetre: 39.1 }, { fromMHz: 88, dbMicrovoltPerMetre: 43.5 }, { fromMHz: 216, dbMicrovoltPerMetre: 46.4 }, { fromMHz: 960, dbMicrovoltPerMetre: 49.5 }],
};

/** The limit at `frequencyMHz`, or null below the limit's first band. */
export function limitAt(limit: RadiatedLimit, frequencyMHz: number): number | null {
  let value: number | null = null;
  for (const band of limit.bands) if (frequencyMHz >= band.fromMHz) value = band.dbMicrovoltPerMetre;
  return value;
}
