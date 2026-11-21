// Running DFT of the tangential E and H on the far-field Huygens box: one
// thread per box patch, looping over the requested frequencies. Same sampling
// and accumulator layout as tangentialFieldsAtPatch / HuygensDftRecorder in
// huygens_box.ts. Dispatched after the port pass, so counter[0] already holds
// the number of finished steps n + 1: E is at (n + 1) dt and H at (n + 1/2) dt.
@group(0) @binding(1) var<storage, read> E: array<f32>;
@group(0) @binding(2) var<storage, read> H: array<f32>;
@group(0) @binding(3) var<storage, read> counter: array<u32>;
// Per patch: (cell index of the low corner node, normal axis, bits of the f32
// weight of H below the face, unused).
@group(0) @binding(4) var<storage, read> patches: array<vec4<u32>>;
// Per frequency: f * dt, in cycles per step.
@group(0) @binding(5) var<storage, read> cycles_per_step: array<f32>;
// 8 floats per (patch, frequency): re, im of e_p, e_q, h_p, h_q.
@group(0) @binding(6) var<storage, read_write> acc: array<f32>;

const TWO_PI: f32 = 6.283185307179586;

fn axis_stride(axis: u32) -> u32 {
  return select(select(P.nx * P.ny, P.nx, axis == 1u), 1u, axis == 0u);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let s = flat_index(gid, groups, 64u);
  if (s >= arrayLength(&patches)) { return; }
  let sample = patches[s];
  let a = sample.y;
  let p = (a + 1u) % 3u;
  let q = (a + 2u) % 3u;
  let sa = axis_stride(a);
  let sp = axis_stride(p);
  let sq = axis_stride(q);
  let p_at_cell = p * P.n + sample.x;
  let q_at_cell = q * P.n + sample.x;
  let ep = 0.5 * (E[p_at_cell] + E[p_at_cell + sq]);
  let eq = 0.5 * (E[q_at_cell] + E[q_at_cell + sp]);
  let below = 0.5 * bitcast<f32>(sample.z);
  let above = 0.5 - below;
  let hp = above * (H[p_at_cell] + H[p_at_cell + sp]) + below * (H[p_at_cell - sa] + H[p_at_cell - sa + sp]);
  let hq = above * (H[q_at_cell] + H[q_at_cell + sq]) + below * (H[q_at_cell - sa] + H[q_at_cell - sa + sq]);

  let steps_done = f32(counter[0]);
  let frequencies = arrayLength(&cycles_per_step);
  for (var f = 0u; f < frequencies; f++) {
    // Phase in cycles, wrapped by fract: at 100 cycles (about 20k steps at 6 GHz) f32 is good to ~1e-5 cycles.
    let phase_e = TWO_PI * fract(cycles_per_step[f] * steps_done);
    let phase_h = TWO_PI * fract(cycles_per_step[f] * (steps_done - 0.5));
    let ce = cos(phase_e);
    let se = -sin(phase_e);
    let ch = cos(phase_h);
    let sh = -sin(phase_h);
    let base = (s * frequencies + f) * 8u;
    acc[base] += ep * ce;
    acc[base + 1u] += ep * se;
    acc[base + 2u] += eq * ce;
    acc[base + 3u] += eq * se;
    acc[base + 4u] += hp * ch;
    acc[base + 5u] += hp * sh;
    acc[base + 6u] += hq * ch;
    acc[base + 7u] += hq * sh;
  }
}
