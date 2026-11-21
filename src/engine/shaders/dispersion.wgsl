// Frequency-dependent and magnetic edges: the snapshot and update passes of
// dispersion.ts (DispersionState is the CPU reference; the update law is in
// that file's header). One thread per listed edge of one field.
//   snapshot: before the main update, state[0] = the edge's field.
//   update:   after the main and CPML passes, recover the step's curl term D
//             from what they wrote and redo the edge with its own medium.
// E (FIELD_IS_E = 1) recovers D through eDecay/eCurl and skips edges with
// eCurl 0 (copper, port cells); H's main update was h + D.
// Medium record (MEDIUM_HEADER + 4 * MAX_POLES floats): cPrev, cDelta, pole
// count, unused, then a1 - 1, a2, b0, b1 per pole. State per edge
// (1 + 2 * MAX_POLES floats): the field before the step, then p, p_prev per pole.
override FIELD_IS_E: u32 = 1u;
override MAX_POLES: u32 = 0u;

@group(0) @binding(1) var<storage, read_write> F: array<f32>;
@group(0) @binding(2) var<storage, read> eDecay: array<f32>;
@group(0) @binding(3) var<storage, read> eCurl: array<f32>;
@group(0) @binding(4) var<storage, read> edgeIndex: array<u32>;
@group(0) @binding(5) var<storage, read> edgeMedium: array<u32>;
@group(0) @binding(6) var<storage, read> media: array<f32>;
@group(0) @binding(7) var<storage, read_write> state: array<f32>;

const MEDIUM_HEADER: u32 = 4u;

@compute @workgroup_size(64)
fn snapshot(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let m = flat_index(gid, groups, 64u);
  if (m >= arrayLength(&edgeIndex)) { return; }
  state[m * (1u + 2u * MAX_POLES)] = F[edgeIndex[m]];
}

@compute @workgroup_size(64)
fn update(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let m = flat_index(gid, groups, 64u);
  if (m >= arrayLength(&edgeIndex)) { return; }
  let at = edgeIndex[m];
  let base = m * (1u + 2u * MAX_POLES);
  let prev = state[base];
  var delta = F[at] - prev;
  if (FIELD_IS_E == 1u) {
    let curl = eCurl[at];
    if (curl == 0.0) { return; }
    delta = P.sc * (F[at] - eDecay[at] * prev) / curl;
  }
  let rec = edgeMedium[m] * (MEDIUM_HEADER + 4u * MAX_POLES);
  let count = u32(media[rec + 2u]);
  var hist = 0.0;
  for (var k = 0u; k < count; k++) {
    let c = rec + MEDIUM_HEADER + 4u * k;
    hist += media[c] * state[base + 1u + 2u * k] + media[c + 1u] * state[base + 2u + 2u * k];
  }
  let next = media[rec] * prev + media[rec + 1u] * (delta - hist);
  for (var k = 0u; k < count; k++) {
    let c = rec + MEDIUM_HEADER + 4u * k;
    let p = state[base + 1u + 2u * k];
    state[base + 1u + 2u * k] = p + media[c] * p + media[c + 1u] * state[base + 2u + 2u * k] + media[c + 2u] * next + media[c + 3u] * prev;
    state[base + 2u + 2u * k] = p;
  }
  F[at] = next;
}

// energy: the listed edges' stored energy minus what energy.wgsl already
// counted for them (DispersionState.energyCorrection), as partial sums of 256
// edges per workgroup, which the host adds to energy.wgsl's (fdtd3d.ts).
// Energy weights per medium (1 + 2 * MAX_POLES floats): inf, then the p^2 and
// (p - p_prev)^2 weights per pole. Factors per edge (energyFactors in
// dispersion.ts): the volume it stands for and the eps the plain sum used;
// volume 0 for an edge that counts in neither.
@group(0) @binding(8) var<storage, read> energyWeights: array<f32>;
@group(0) @binding(9) var<storage, read> energyFactors: array<f32>;
@group(0) @binding(10) var<storage, read_write> partial: array<f32>;

var<workgroup> acc: array<f32, 256>;

@compute @workgroup_size(256)
fn energy(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) t: u32,
          @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let m = flat_index(gid, groups, 256u);
  var stored = 0.0;
  if (m < arrayLength(&edgeIndex) && energyFactors[2u * m] != 0.0) {
    let base = m * (1u + 2u * MAX_POLES);
    let w = edgeMedium[m] * (1u + 2u * MAX_POLES);
    let f = F[edgeIndex[m]];
    stored = (energyWeights[w] - energyFactors[2u * m + 1u]) * f * f;
    for (var k = 0u; k < MAX_POLES; k++) {
      let p = state[base + 1u + 2u * k];
      let dp = p - state[base + 2u + 2u * k];
      stored += energyWeights[w + 1u + 2u * k] * p * p + energyWeights[w + 2u + 2u * k] * dp * dp;
    }
    stored *= energyFactors[2u * m];
  }
  acc[t] = stored;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride >>= 1u) {
    if (t < stride) { acc[t] += acc[t + stride]; }
    workgroupBarrier();
  }
  // As in energy.wgsl: the 2D dispatch can overshoot by part of a row; those workgroups have no slot.
  let group = wg.x + wg.y * groups.x;
  if (t == 0u && group < arrayLength(&partial)) { partial[group] = acc[0]; }
}
