import { sheetEdgeOffsetCells } from '../src/engine/yee_edge';
import { EDGE_LINE_SETTLE_CELLS } from '../src/project/rasterise';

/**
 * The line the mesher puts for a copper edge drawn at `drawn` with its copper on the `inward`
 * side (+1: towards larger coordinates), or undefined: the line inside the copper, less than
 * `edgeCell` from the edge, whose distance from it is the half-plane offset for the z cells at
 * the layer at copperZ and the cell just outside that line, both measured on this mesh.
 */
export function correctedLine(lines: Float64Array, z: Float64Array, copperZ: number, drawn: number, inward: -1 | 1, edgeCell: number): number | undefined {
  const k = z.findIndex((v) => Math.abs(v - copperZ) < 1e-9);
  for (let n = 0; n < lines.length; n++) {
    const depth = (lines[n] - drawn) * inward;
    if (!(depth > 0 && depth < edgeCell)) continue;
    const cell = Math.abs(lines[n - inward] - lines[n]);
    const shift = sheetEdgeOffsetCells((z[k] - z[k - 1]) / cell, (z[k + 1] - z[k]) / cell) * cell;
    // The mesher settles each line on its outside cell to EDGE_LINE_SETTLE_CELLS (twice that here: one for the last move, one for a step in the offset).
    if (Math.abs(depth - shift) < 2 * EDGE_LINE_SETTLE_CELLS * edgeCell) return lines[n];
  }
  return undefined;
}
