// Running DFT of Ex, Ey, Ez, Hx, Hy on whole z planes: one thread per
// (plane, node), looping over the requested frequencies. Same sampling and
// accumulator layout as PlaneDftRecorder in plane_dft.ts. Dispatched after the
// port pass, so counter[0] already holds the number of finished steps n + 1:
// E is at (n + 1) dt and H at (n + 1/2) dt.
@group(0) @binding(1) var<storage, read> E: array<f32>;
@group(0) @binding(2) var<storage, read> H: array<f32>;
@group(0) @binding(3) var<storage, read> counter: array<u32>;
// z node index of each plane.
@group(0) @binding(4) var<storage, read> planes_k: array<u32>;
// Per frequency: f * dt, in cycles per step.
@group(0) @binding(5) var<storage, read> cycles_per_step: array<f32>;
// re, im per (plane, frequency, component, node); see planeDftIndex.
@group(0) @binding(6) var<storage, read_write> acc: array<f32>;

const TWO_PI: f32 = 6.283185307179586;
const COMPONENTS: u32 = 5u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let t = flat_index(gid, groups, 64u);
  let plane_size = P.nx * P.ny;
  let plane = t / plane_size;
  if (plane >= arrayLength(&planes_k)) { return; }
  let node = t - plane * plane_size;
  let cell = planes_k[plane] * plane_size + node;
  var values: array<f32, 5>;
  values[0] = E[cell];
  values[1] = E[P.n + cell];
  values[2] = E[2u * P.n + cell];
  values[3] = H[cell];
  values[4] = H[P.n + cell];

  let steps_done = f32(counter[0]);
  let frequencies = arrayLength(&cycles_per_step);
  for (var f = 0u; f < frequencies; f++) {
    // Phase in cycles, wrapped by fract, as in huygens_dft.wgsl.
    let phase_e = TWO_PI * fract(cycles_per_step[f] * steps_done);
    let phase_h = TWO_PI * fract(cycles_per_step[f] * (steps_done - 0.5));
    let rotate_e = vec2<f32>(cos(phase_e), -sin(phase_e));
    let rotate_h = vec2<f32>(cos(phase_h), -sin(phase_h));
    for (var c = 0u; c < COMPONENTS; c++) {
      let rotate = select(rotate_h, rotate_e, c < 3u);
      let at = 2u * (((plane * frequencies + f) * COMPONENTS + c) * plane_size + node);
      acc[at] += values[c] * rotate.x;
      acc[at + 1u] += values[c] * rotate.y;
    }
  }
}
