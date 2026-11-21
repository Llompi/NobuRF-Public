// Electric update:  e <- eDecay*e + eCurl*curl(h), backward differences, each
// multiplied by its axis's difference scale (1/kappa in the CPML, times
// dRef / dual width on a graded mesh; see cpml.ts). eDecay and eCurl are per component
// (3 blocks): 1 and Sc/eps_r for a lossless dielectric, the semi-implicit
// conductivity form for a lossy one, and eCurl = 0 on PEC edges, so a copper
// sheet zeroes only tangential E and stays zero thickness. Port cells also
// have eCurl = 0 here and are owned by port.wgsl, which runs after the CPML pass.
@group(0) @binding(1) var<storage, read_write> E: array<f32>;
@group(0) @binding(2) var<storage, read> H: array<f32>;
@group(0) @binding(3) var<storage, read> eDecay: array<f32>;
@group(0) @binding(4) var<storage, read> eCurl: array<f32>;
@group(0) @binding(5) var<storage, read> cpml: array<f32>;

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

  let hxc = H[c];
  let hyc = H[n + c];
  let hzc = H[2u * n + c];
  var hxJ = 0.0; var hxK = 0.0; var hyI = 0.0; var hyK = 0.0; var hzI = 0.0; var hzJ = 0.0;
  if (i > 0u) { hyI = H[n + c - 1u];  hzI = H[2u * n + c - 1u]; }
  if (j > 0u) { hxJ = H[c - sy];      hzJ = H[2u * n + c - sy]; }
  if (k > 0u) { hxK = H[c - sz];      hyK = H[n + c - sz]; }

  let kx = cpml[prof_index(0u, PROF_E_DIFF_SCALE, i)];
  let ky = cpml[prof_index(1u, PROF_E_DIFF_SCALE, j)];
  let kz = cpml[prof_index(2u, PROF_E_DIFF_SCALE, k)];
  E[c]          = eDecay[c]          * E[c]          + eCurl[c]          * ((hzc - hzJ) * ky - (hyc - hyK) * kz);
  E[n + c]      = eDecay[n + c]      * E[n + c]      + eCurl[n + c]      * ((hxc - hxK) * kz - (hzc - hzI) * kx);
  E[2u * n + c] = eDecay[2u * n + c] * E[2u * n + c] + eCurl[2u * n + c] * ((hyc - hyI) * kx - (hxc - hxJ) * ky);
}
