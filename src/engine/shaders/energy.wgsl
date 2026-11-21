// Partial sums of the field energy, one per workgroup of 256 cells; the host adds
// the partials (fdtd3d.ts). Same quantity as CpuFdtd.energy(): each edge's
// eps_r e^2 or h^2 times the volume it stands for, so a graded mesh's large
// cells and a substrate's slow fields count as they should. eps_r comes back
// from the update coefficients, eps_r = Sc (1 + eDecay) / (2 eCurl), exact for
// dielectricEdge. PEC, copper and port edges (eCurl = 0) count 0.
@group(0) @binding(1) var<storage, read> E: array<f32>;
@group(0) @binding(2) var<storage, read> H: array<f32>;
@group(0) @binding(3) var<storage, read> eDecay: array<f32>;
@group(0) @binding(4) var<storage, read> eCurl: array<f32>;
@group(0) @binding(5) var<storage, read> cpml: array<f32>;
@group(0) @binding(6) var<storage, read_write> partial: array<f32>;

var<workgroup> acc: array<f32, 256>;

fn e_term(at: u32, volume: f32) -> f32 {
  let curl = eCurl[at];
  if (curl == 0.0) { return 0.0; }
  let e = E[at];
  return P.sc * (1.0 + eDecay[at]) / (2.0 * curl) * volume * e * e;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_index) t: u32,
        @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let c = flat_index(gid, groups, 256u);
  var sum = 0.0;
  if (c < P.n) {
    let n = P.n;
    let i = c % P.nx;
    let j = (c / P.nx) % P.ny;
    let k = c / (P.nx * P.ny);
    // Widths in units of the smallest cell: a cell (H position) or a dual cell (E position).
    let cellX = 1.0 / cpml[prof_index(0u, PROF_H_DIFF_SCALE, i)];
    let cellY = 1.0 / cpml[prof_index(1u, PROF_H_DIFF_SCALE, j)];
    let cellZ = 1.0 / cpml[prof_index(2u, PROF_H_DIFF_SCALE, k)];
    let dualX = 1.0 / cpml[prof_index(0u, PROF_E_DIFF_SCALE, i)];
    let dualY = 1.0 / cpml[prof_index(1u, PROF_E_DIFF_SCALE, j)];
    let dualZ = 1.0 / cpml[prof_index(2u, PROF_E_DIFF_SCALE, k)];
    sum = e_term(c, cellX * dualY * dualZ) + e_term(n + c, dualX * cellY * dualZ) + e_term(2u * n + c, dualX * dualY * cellZ);
    let hx = H[c];
    let hy = H[n + c];
    let hz = H[2u * n + c];
    sum += dualX * cellY * cellZ * hx * hx + cellX * dualY * cellZ * hy * hy + cellX * cellY * dualZ * hz * hz;
  }
  acc[t] = sum;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride >>= 1u) {
    if (t < stride) { acc[t] += acc[t + stride]; }
    workgroupBarrier();
  }
  // The 2D dispatch can overshoot by part of a row; those workgroups have no partial slot.
  let group = wg.x + wg.y * groups.x;
  if (t == 0u && group < arrayLength(&partial)) { partial[group] = acc[0]; }
}
