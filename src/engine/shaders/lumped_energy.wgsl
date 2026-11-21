// Energy in the lumped components' inductors and series capacitors
// (lumpedEnergy in lumped.ts), summed by one workgroup into total[0]. The
// energy check adds it to the field energy partials (energy.wgsl).
@group(0) @binding(1) var<storage, read> coef: array<f32>;
@group(0) @binding(2) var<storage, read> state: array<f32>;
@group(0) @binding(3) var<storage, read_write> total: array<f32>;

const COEFS: u32 = 10u;
const ENERGY_U: u32 = 8u;
const ENERGY_Q: u32 = 9u;
var<workgroup> acc: array<f32, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) t: u32) {
  let edges = arrayLength(&state) / 3u;
  var sum = 0.0;
  for (var m = t; m < edges; m += 64u) {
    let x_u = state[3u * m + 1u];
    let x_q = state[3u * m + 2u];
    sum += coef[m * COEFS + ENERGY_U] * x_u * x_u + coef[m * COEFS + ENERGY_Q] * x_q * x_q;
  }
  acc[t] = sum;
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (t < stride) { acc[t] += acc[t + stride]; }
    workgroupBarrier();
  }
  if (t == 0u) { total[0] = acc[0]; }
}
