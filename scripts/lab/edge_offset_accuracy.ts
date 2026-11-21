/**
 * How accurate the mesher's sheet-edge offset is: yeeEdgeOffset at the
 * mesher's grid size (L = 40, yee_edge.ts) against L = 120, over the z cell
 * ratios the mesher uses it for (EDGE_OFFSET_CELL_RATIO in rasterise.ts,
 * 0.25 to 2 edge cells below and above the sheet). Prints the difference in
 * cells for each pair and the largest.
 *
 *   npx tsx scripts/lab/edge_offset_accuracy.ts
 */
import { yeeEdgeOffset } from '../../src/engine/yee_edge';

const RATIOS = [0.25, 0.35, 0.5, 0.7, 1, 1.4, 2];

function main(): void {
  let worst = { diff: 0, below: 0, above: 0 };
  console.log('below  above  L40       L120      L40 - L120 (cells)');
  for (const below of RATIOS) for (const above of RATIOS) {
    if (above < below) continue; // symmetric in below / above
    const [coarse, fine] = [yeeEdgeOffset(40, below, above), yeeEdgeOffset(120, below, above)];
    const diff = coarse - fine;
    if (Math.abs(diff) > Math.abs(worst.diff)) worst = { diff, below, above };
    console.log(`${below.toFixed(2)}   ${above.toFixed(2)}   ${coarse.toFixed(5)}   ${fine.toFixed(5)}   ${diff.toExponential(2)}`);
  }
  console.log(`largest |L40 - L120|: ${Math.abs(worst.diff).toExponential(2)} cells at (${worst.below}, ${worst.above})`);
}

if (process.argv[1]?.endsWith('edge_offset_accuracy.ts')) main();
