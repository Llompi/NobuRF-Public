// CPML psi update over one axis's slabs, for E (FIELD_IS_E = true) or H.
// Mirrors CpuFdtd.slabUpdate in fdtd_cpu.ts line for line. One pipeline per
// (field, axis), selected with override constants, one thread per slab cell.
//
// For axis a, p and q are the next two components in cyclic order. The curls contain
//   E_p: -d_a H_q    E_q: +d_a H_p    H_p: -d_a E_q    H_q: +d_a E_p
// psi block 0 follows the derivative feeding p, block 1 the one feeding q.
override AXIS: u32;
override FIELD_IS_E: bool;

@group(0) @binding(1) var<storage, read_write> target_field: array<f32>;
@group(0) @binding(2) var<storage, read> source_field: array<f32>;
@group(0) @binding(3) var<storage, read_write> psi: array<f32>;
@group(0) @binding(4) var<storage, read> cpml: array<f32>;
// eCurl for the E pass; unused (bound to a 4-byte dummy) for H.
@group(0) @binding(5) var<storage, read> eCurl: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let s = flat_index(gid, groups, 64u);
  let slab_n = P.slab_cells[AXIS];
  if (s >= slab_n) { return; }
  let n = P.n;
  let low = P.pml_low[AXIS];
  let high = P.pml_high[AXIS];
  let len = axis_len(AXIS);
  let layers = low + high;

  // Slab box: the grid with axis AXIS shrunk to `layers`, x fastest.
  var dims = vec3<u32>(P.nx, P.ny, P.nz);
  dims[AXIS] = layers;
  var coord = vec3<u32>(s % dims.x, (s / dims.x) % dims.y, s / (dims.x * dims.y));
  let layer = coord[AXIS];
  var u = layer;
  if (layer >= low) { u = layer + len - high - low; }
  coord[AXIS] = u;
  let cell = coord.x + P.nx * (coord.y + P.ny * coord.z);
  let strides = vec3<u32>(1u, P.nx, P.nx * P.ny);
  let sa = strides[AXIS];
  let p = (AXIS + 1u) % 3u;
  let q = (AXIS + 2u) % 3u;

  var d_p = 0.0;
  var d_q = 0.0;
  var b = 0.0;
  var cc = 0.0;
  if (FIELD_IS_E) {
    // backward differences of H_q and H_p along the axis
    var prev_q = 0.0; var prev_p = 0.0;
    if (u > 0u) { prev_q = source_field[q * n + cell - sa]; prev_p = source_field[p * n + cell - sa]; }
    d_p = source_field[q * n + cell] - prev_q;
    d_q = source_field[p * n + cell] - prev_p;
    b = cpml[prof_index(AXIS, PROF_E_B, u)];
    cc = cpml[prof_index(AXIS, PROF_E_C, u)];
  } else {
    // forward differences of E_q and E_p along the axis
    var next_q = 0.0; var next_p = 0.0;
    if (u + 1u < len) { next_q = source_field[q * n + cell + sa]; next_p = source_field[p * n + cell + sa]; }
    d_p = next_q - source_field[q * n + cell];
    d_q = next_p - source_field[p * n + cell];
    b = cpml[prof_index(AXIS, PROF_H_B, u)];
    cc = cpml[prof_index(AXIS, PROF_H_C, u)];
  }
  let ip = P.psi_offset[AXIS] + s;
  let iq = ip + slab_n;
  let psi_p = b * psi[ip] + cc * d_p;
  let psi_q = b * psi[iq] + cc * d_q;
  psi[ip] = psi_p;
  psi[iq] = psi_q;
  if (FIELD_IS_E) {
    target_field[p * n + cell] -= eCurl[p * n + cell] * psi_p;
    target_field[q * n + cell] += eCurl[q * n + cell] * psi_q;
  } else {
    target_field[p * n + cell] += P.sc * psi_p;
    target_field[q * n + cell] -= P.sc * psi_q;
  }
}
