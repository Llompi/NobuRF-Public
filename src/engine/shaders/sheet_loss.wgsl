// Copper faces (sheetFaceLoss in voxelize.ts): each listed H component loses
// `rate` of itself before the H update, the surface impedance Rs of the face
// next to it. The loss is often 1e-7 of H, below H's float32 spacing, so the
// part the subtraction drops is carried to the next step as a fraction of H
// (as applyFaceLoss in fdtd_cpu.ts). A frequency-dependent impedance adds
// TERMS high-pass terms, weight * (x - phi): x is H at the time of E
// (1.5 H - 0.5 H_prev) and phi its bilinear low-pass. State per component:
// H_prev, x_prev, then phi per term (FaceLoss in voxelize.ts). One thread
// per listed component; a component is listed once.
override TERMS: u32 = 0u;
const STATE_HEADER: u32 = 2u;
const MAX_CARRY: f32 = 1.1920929e-7; // 2^-23

@group(0) @binding(1) var<storage, read_write> H: array<f32>;
@group(0) @binding(2) var<storage, read> hIndex: array<u32>;
@group(0) @binding(3) var<storage, read> rate: array<f32>;
@group(0) @binding(4) var<storage, read_write> carry: array<f32>;
@group(0) @binding(5) var<storage, read> weight: array<f32>;
@group(0) @binding(6) var<storage, read> lowPass: array<f32>;
@group(0) @binding(7) var<storage, read_write> state: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let m = flat_index(gid, groups, 64u);
  if (m >= arrayLength(&hIndex)) { return; }
  let i = hIndex[m];
  let before = H[i];
  var loss = (rate[m] + carry[m]) * before;
  if (TERMS > 0u) {
    let base = m * (STATE_HEADER + TERMS);
    let x = 1.5 * before - 0.5 * state[base];
    let sum = x + state[base + 1u];
    for (var k = 0u; k < TERMS; k++) {
      let phi = lowPass[2u * k] * state[base + STATE_HEADER + k] + lowPass[2u * k + 1u] * sum;
      loss = loss + weight[m * TERMS + k] * (x - phi);
      state[base + STATE_HEADER + k] = phi;
    }
    state[base] = before;
    state[base + 1u] = x;
  }
  if (loss == 0.0) { return; }
  let after = before - loss;
  // Held to MAX_CARRY as in applyFaceLoss: near a zero crossing of H the residue over a tiny `before` could be large.
  carry[m] = select(clamp((loss - (before - after)) / before, -MAX_CARRY, MAX_CARRY), 0.0, before == 0.0);
  H[i] = after;
}
