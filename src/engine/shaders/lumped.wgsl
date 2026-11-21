// Lumped R, L, C components (lumped.ts, stepLumped is the CPU reference): one
// thread per component edge, after the E update and its CPML passes. The main
// E kernel has already applied the component's ca/cb (eDecay/eCurl); this
// pass subtracts the element's history current and advances its states.
// coef holds 10 floats per edge in LUMPED_COEF order; state holds 3 per edge:
// E after the last step, the inductor current xU and the series capacitor voltage xQ.
@group(0) @binding(1) var<storage, read_write> E: array<f32>;
@group(0) @binding(2) var<storage, read> eIndex: array<u32>;
@group(0) @binding(3) var<storage, read> coef: array<f32>;
@group(0) @binding(4) var<storage, read_write> state: array<f32>;

const COEFS: u32 = 10u;
const CB: u32 = 0u;
const G_B: u32 = 1u;
const P_U: u32 = 2u;
const P_Q: u32 = 3u;
const C_UU: u32 = 4u;
const C_UE: u32 = 5u;
const C_UI: u32 = 6u;
const C_QI: u32 = 7u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let m = flat_index(gid, groups, 64u);
  if (m >= arrayLength(&eIndex)) { return; }
  let o = m * COEFS;
  let st = m * 3u;
  let x_u = state[st + 1u];
  let x_q = state[st + 2u];
  let s = coef[o + P_U] * x_u + coef[o + P_Q] * x_q;
  let at = eIndex[m];
  let e_new = E[at] - coef[o + CB] * s;
  E[at] = e_new;
  let e_mean = 0.5 * (e_new + state[st]);
  let u_mean = coef[o + G_B] * e_mean + s;
  state[st] = e_new;
  state[st + 1u] = coef[o + C_UU] * x_u + coef[o + C_UE] * e_mean + coef[o + C_UI] * u_mean;
  state[st + 2u] = x_q + coef[o + C_QI] * u_mean;
}
