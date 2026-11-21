// Faces next to conformal copper (conformal.ts): after the H update, each
// listed H component adds its four edges' E times their coefficients, which
// divides that face's update by its free area. E has not changed since the H
// pass, so this is the same curl again. One thread per face; a face is
// listed once.
@group(0) @binding(1) var<storage, read_write> H: array<f32>;
@group(0) @binding(2) var<storage, read> E: array<f32>;
@group(0) @binding(3) var<storage, read> hIndex: array<u32>;
@group(0) @binding(4) var<storage, read> eIndex: array<u32>;
@group(0) @binding(5) var<storage, read> coef: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let m = flat_index(gid, groups, 64u);
  if (m >= arrayLength(&hIndex)) { return; }
  let q = 4u * m;
  H[hIndex[m]] += coef[q] * E[eIndex[q]] + coef[q + 1u] * E[eIndex[q + 1u]] + coef[q + 2u] * E[eIndex[q + 2u]] + coef[q + 3u] * E[eIndex[q + 3u]];
}
