/**
 * The two constants of edgeLossFactor (voxelize.ts): how the Yee grid's
 * conductor loss behaves at the edge of a zero-thickness sheet.
 *
 * Near a strip edge the quasi-static field is that of a half-plane. The
 * vector potential along the edge, A (on the Ey/Ex nodes), obeys the 5-point
 * Laplacian the Yee curl-curl reduces to, with A = 0 on the sheet. The
 * continuum solution is A = Re sqrt(z): on each face |H| = 1 / (2 sqrt(x)) at
 * distance x from the edge, and the loss of both faces out to R is
 * (1/2) ln(R / cutoff) for a sheet cut off at `cutoff`. This solves the
 * discrete problem on a (2L+1)^2 grid of unit cells, the sheet on the nodes
 * x <= 0 and the exact solution on the outer square, and reports
 *  - cutoffCells: the cutoff, in cells, whose continuum loss equals the grid's
 *    face-H loss summed over the sheet nodes out to R (it converges in R), and
 *  - edgeShare: the loss of the edge node alone over a^2 / 2 (a = 1 here), and
 *  - the edge offset (yeeEdgeOffset, src/engine/yee_edge.ts): how far past
 *    its last node the sheet's edge acts, 0.3535 cells on square cells.
 *
 *   npx tsx scripts/validate/yee_edge_constants.ts [L]
 */

import { halfPlaneField, solveHalfPlane, yeeEdgeOffset } from '../../src/engine/yee_edge';

export function yeeEdgeConstants(L: number): { cutoffCells: number; edgeShare: number; reach: number } {
  const { a, at } = solveHalfPlane(L, (x, y) => halfPlaneField(x, y));
  const faceLoss = (i: number) => a[at(i, 1)] ** 2 + a[at(i, -1)] ** 2;
  const reach = Math.floor(L / 3);
  let sum = 0;
  for (let i = -reach; i <= 0; i++) sum += faceLoss(i);
  // The nodes x = -reach .. 0 stand for the sheet out to reach + 1/2.
  return { cutoffCells: (reach + 0.5) / Math.exp(2 * sum), edgeShare: faceLoss(0) / 0.5, reach };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const L = Number(process.argv[2] ?? 360);
  for (const cells of [0.9, 1.1]) console.log(`edge offset with z cells ${cells} of the edge cell (L 80): ${yeeEdgeOffset(80, cells, cells).toFixed(4)} cells`);
  const { cutoffCells, edgeShare, reach } = yeeEdgeConstants(L);
  console.log(`L ${L}, summed to ${reach} cells: cutoff ${cutoffCells.toFixed(4)} cells, edge share ${edgeShare.toFixed(4)}, edge offset ${yeeEdgeOffset(L).toFixed(4)} cells`);
}
