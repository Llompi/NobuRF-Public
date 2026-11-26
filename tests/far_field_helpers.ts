import type { FarFieldResult } from '../src/engine/near_to_far';

/** Directivity in dBi at one grid direction of a far-field result. */
export const directivityAt = (r: FarFieldResult, thetaDeg: number, phiDeg: number) =>
  r.directivityDbi[r.thetaDeg.indexOf(thetaDeg) * r.phiDeg.length + r.phiDeg.indexOf(phiDeg)];
