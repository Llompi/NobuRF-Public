// Running DFT of Ex, Ey, Ez, Hx, Hy, Hz at every node of the grid: one thread
// per node, looping over the requested frequencies. Same sampling and
// accumulator layout as VolumeDftRecorder in volume_dft.ts. Dispatched after
// the port pass, so counter[0] already holds the number of finished steps
// n + 1: E is at (n + 1) dt and H at (n + 1/2) dt.
@group(0) @binding(1) var<storage, read> E: array<f32>;
@group(0) @binding(2) var<storage, read> H: array<f32>;
@group(0) @binding(3) var<storage, read> counter: array<u32>;
// [0] = nodes to record (the whole grid, P.n); kept as a buffer so the kernel
// binds the same seven resources as the other DFT kernels.
@group(0) @binding(4) var<storage, read> nodes: array<u32>;
// Per frequency: f * dt, in cycles per step.
@group(0) @binding(5) var<storage, read> cycles_per_step: array<f32>;
// re, im per (frequency, component, node); see volumeDftIndex.
@group(0) @binding(6) var<storage, read_write> acc: array<f32>;

const TWO_PI: f32 = 6.283185307179586;
const COMPONENTS: u32 = 6u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let node = flat_index(gid, groups, 64u);
  let count = nodes[0];
  if (node >= count) { return; }
  var values: array<f32, 6>;
  values[0] = E[node];
  values[1] = E[P.n + node];
  values[2] = E[2u * P.n + node];
  values[3] = H[node];
  values[4] = H[P.n + node];
  values[5] = H[2u * P.n + node];

  let steps_done = f32(counter[0]);
  let frequencies = arrayLength(&cycles_per_step);
  for (var f = 0u; f < frequencies; f++) {
    // Phase in cycles, wrapped by fract, as in plane_dft.wgsl.
    let phase_e = TWO_PI * fract(cycles_per_step[f] * steps_done);
    let phase_h = TWO_PI * fract(cycles_per_step[f] * (steps_done - 0.5));
    let rotate_e = vec2<f32>(cos(phase_e), -sin(phase_e));
    let rotate_h = vec2<f32>(cos(phase_h), -sin(phase_h));
    for (var c = 0u; c < COMPONENTS; c++) {
      let rotate = select(rotate_h, rotate_e, c < 3u);
      let at = 2u * ((f * COMPONENTS + c) * count + node);
      acc[at] += values[c] * rotate.x;
      acc[at + 1u] += values[c] * rotate.y;
    }
  }
}
