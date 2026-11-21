// Shared declarations, prepended to every kernel by fdtd3d.ts.
// Layout must match the params buffer written in Fdtd3D.load() (fdtd3d.ts) (8 rows x 16 bytes = 128 bytes).
// Per-port values (coefficients, source scale, mesh factors) are the port kernel's descriptors (port.wgsl).
struct Params {
  nx: u32, ny: u32, nz: u32, n: u32,        // grid dims, n = nx*ny*nz
  sc: f32, _pad1: f32, _pad2: f32, _pad3: f32, // Courant number
  port_cells: u32, port_count: u32, max_steps: u32, _pad0: u32,  // port_cells: cells of all ports together
  t0_steps: f32, tau_steps: f32, w_rad_per_step: f32, _pad4: f32, // source pulse, in steps
  pml_low: vec4<u32>,                       // CPML cells on the low face of x, y, z
  pml_high: vec4<u32>,                      // ... and on the high face
  psi_offset: vec4<u32>,                    // start of each axis's two psi blocks
  slab_cells: vec4<u32>,                    // cells in each axis's slab (one psi block)
};
@group(0) @binding(0) var<uniform> P: Params;

// CPML coefficient buffer: per axis, six arrays of that axis's length, in the
// order eB, eC, eDiffScale, hB, hC, hDiffScale (see cpml.ts); axes x, y, z back to back.
const PROF_E_B: u32 = 0u;
const PROF_E_C: u32 = 1u;
const PROF_E_DIFF_SCALE: u32 = 2u;
const PROF_H_B: u32 = 3u;
const PROF_H_C: u32 = 4u;
const PROF_H_DIFF_SCALE: u32 = 5u;

fn axis_len(axis: u32) -> u32 {
  return select(select(P.nz, P.ny, axis == 1u), P.nx, axis == 0u);
}

fn prof_index(axis: u32, which: u32, node: u32) -> u32 {
  var base = 0u;
  if (axis > 0u) { base += 6u * P.nx; }
  if (axis > 1u) { base += 6u * P.ny; }
  return base + which * axis_len(axis) + node;
}

// The source pulse of source.ts at unit amplitude, sampled at (step + 1/2) dt:
// the semi-implicit update averages E^n and E^(n+1). Used by port.wgsl and coax.wgsl.
fn source_shape(step: u32) -> f32 {
  let t = f32(step) + 0.5 - P.t0_steps;
  let u = t / P.tau_steps;
  return exp(-u * u) * sin(P.w_rad_per_step * t);
}

// Full-grid kernels are dispatched as a 2D grid of workgroups (see
// flatDispatchSize in fdtd3d.ts) because one dimension holds at most 65535
// workgroups. This flattens the invocation back to a 1D index.
fn flat_index(gid: vec3<u32>, groups: vec3<u32>, workgroup_size: u32) -> u32 {
  return gid.x + gid.y * groups.x * workgroup_size;
}
