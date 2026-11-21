// Coax wave-port planes (TemPlane in coax_feed.ts): the TEM soft source on one
// cross-section of the coax and the mode-voltage probes on others. Both run
// after the CPML E passes and before the port pass, so counter[0] still holds
// this step's n, and the probes read E after the source, as runCoaxFeed does.
@group(0) @binding(1) var<storage, read_write> E: array<f32>;
@group(0) @binding(2) var<storage, read> counter: array<u32>;
// E-buffer indices of the plane edges; for the probes, every plane back to back.
@group(0) @binding(3) var<storage, read> edges: array<u32>;
// Source: the mode times the source amplitude, per edge. Probes: the projection weights.
@group(0) @binding(4) var<storage, read> values: array<f32>;
// Probes only: first edge and edge count of each plane.
@group(0) @binding(5) var<storage, read> planes: array<vec2<u32>>;
// Probes only: mode voltage per step, per plane.
@group(0) @binding(6) var<storage, read_write> hist: array<f32>;

// One thread per source edge: E += s(t) * mode.
@compute @workgroup_size(64)
fn source(@builtin(global_invocation_id) gid: vec3<u32>) {
  let m = gid.x;
  if (m >= arrayLength(&edges)) { return; }
  E[edges[m]] += source_shape(counter[0]) * values[m];
}

const PROBE_WG: u32 = 256u;
var<workgroup> partial: array<f32, 256>;

// One workgroup per probe plane: V = sum of weights * E over its edges.
@compute @workgroup_size(256)
fn probe(@builtin(local_invocation_index) t: u32, @builtin(workgroup_id) wg: vec3<u32>) {
  let plane = planes[wg.x];
  var sum = 0.0;
  for (var m = t; m < plane.y; m += PROBE_WG) {
    let at = plane.x + m;
    sum += values[at] * E[edges[at]];
  }
  partial[t] = sum;
  workgroupBarrier();
  for (var stride = PROBE_WG / 2u; stride > 0u; stride >>= 1u) {
    if (t < stride) { partial[t] += partial[t + stride]; }
    workgroupBarrier();
  }
  let step = counter[0];
  if (t == 0u && step < P.max_steps) { hist[step * arrayLength(&planes) + wg.x] = partial[0]; }
}
