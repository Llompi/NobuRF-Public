// Thin-sheet corrections (thin_sheets.ts): row r adds the sum over
// k in [rowStart[r], rowStart[r + 1]) of coef[k] * source(from[k]) to
// target(rowTarget[r]). An index with the top bit set names a ghost slot (an
// extra unknown on the far side of a sheet) instead of the field itself. Run
// once after the H update (target H, source E) and once after the E update
// (target E, source H). One thread per row; each row has its own target.
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<storage, read_write> dstGhost: array<f32>;
@group(0) @binding(3) var<storage, read> src: array<f32>;
@group(0) @binding(4) var<storage, read> srcGhost: array<f32>;
@group(0) @binding(5) var<storage, read> rowTarget: array<u32>;
@group(0) @binding(6) var<storage, read> rowStart: array<u32>;
@group(0) @binding(7) var<storage, read> srcIndex: array<u32>;
@group(0) @binding(8) var<storage, read> coef: array<f32>;

const GHOST: u32 = 0x80000000u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let r = flat_index(gid, groups, 64u);
  if (r >= arrayLength(&rowTarget)) { return; }
  var sum = 0.0;
  for (var k = rowStart[r]; k < rowStart[r + 1u]; k++) {
    let s = srcIndex[k];
    if ((s & GHOST) != 0u) { sum += coef[k] * srcGhost[s ^ GHOST]; } else { sum += coef[k] * src[s]; }
  }
  let t = rowTarget[r];
  if ((t & GHOST) != 0u) { dstGhost[t ^ GHOST] += sum; } else { dst[t] += sum; }
}
