// Magnetic update, normalised units (h = eta0*H*dRef, e = E*dRef, dRef the smallest cell):
//   h <- h - Sc*curl(e)   forward differences, missing neighbour = 0,
// each difference multiplied by its axis's difference scale (1/kappa in the
// CPML, times dRef / cell width on a graded mesh; see cpml.ts).
// The psi terms are added afterwards by cpml.wgsl, over the PML slabs only.
// E and H are each one buffer of 3 blocks [x | y | z] of n floats.
@group(0) @binding(1) var<storage, read> E: array<f32>;
@group(0) @binding(2) var<storage, read_write> H: array<f32>;
@group(0) @binding(3) var<storage, read> cpml: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let c = flat_index(gid, groups, 64u);
  if (c >= P.n) { return; }
  let n = P.n;
  let sy = P.nx;
  let sz = P.nx * P.ny;
  let i = c % P.nx;
  let j = (c / P.nx) % P.ny;
  let k = c / sz;

  let exc = E[c];
  let eyc = E[n + c];
  let ezc = E[2u * n + c];
  var exJ = 0.0; var exK = 0.0; var eyI = 0.0; var eyK = 0.0; var ezI = 0.0; var ezJ = 0.0;
  if (i + 1u < P.nx) { eyI = E[n + c + 1u];  ezI = E[2u * n + c + 1u]; }
  if (j + 1u < P.ny) { exJ = E[c + sy];      ezJ = E[2u * n + c + sy]; }
  if (k + 1u < P.nz) { exK = E[c + sz];      eyK = E[n + c + sz]; }

  let kx = cpml[prof_index(0u, PROF_H_DIFF_SCALE, i)];
  let ky = cpml[prof_index(1u, PROF_H_DIFF_SCALE, j)];
  let kz = cpml[prof_index(2u, PROF_H_DIFF_SCALE, k)];
  H[c]          -= P.sc * ((ezJ - ezc) * ky - (eyK - eyc) * kz);
  H[n + c]      -= P.sc * ((exK - exc) * kz - (ezI - ezc) * kx);
  H[2u * n + c] -= P.sc * ((eyI - eyc) * kx - (exJ - exc) * ky);
}
