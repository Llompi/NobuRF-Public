// Lumped resistive ports + V/I probes (see PortSpec in voxelize.ts). The
// cells of every port are flattened into portEz, port after port; a port is
// `columns` columns side by side of `series_cells` Ez cells, each column from
// the bottom up. Every port is a matched resistor; only the active port has a
// non-zero vs_scale. V is a port's centre column, I the total through every
// column's middle cell. One workgroup. The step counter lives in a storage
// buffer and is advanced here, on the GPU, so hundreds of steps can be
// encoded in one submit. (A `step` field in the uniform would NOT work:
// queue.writeBuffer lands before the whole submit, so every step in the batch
// would see the same value.)

// One port; layout must match the descriptors written in Fdtd3D.load() (12 words, 48 bytes).
struct PortDesc {
  first_cell: u32,           // index of the port's first cell in portEz
  series_cells: u32,         // Ez cells in series in each column
  columns: u32,              // columns side by side
  _pad: u32,
  ca: f32, cb: f32, cs: f32, // E' = ca*E + cb*curlH + cs*vsCell (portCoefficients)
  vs_scale: f32,             // source amplitude / (column height / dRef) on the active port, 0 on the others
  curl_scale: vec2<f32>,     // PortMeshFactors.curlScaleX, curlScaleY
  loop_length: vec2<f32>,    // PortMeshFactors.loopLengthX, loopLengthY
};

@group(0) @binding(1) var<storage, read_write> E: array<f32>;
@group(0) @binding(2) var<storage, read> H: array<f32>;
@group(0) @binding(3) var<storage, read> portEz: array<u32>;     // absolute E indices
@group(0) @binding(4) var<storage, read_write> hist: array<f32>; // per step, per port: [v, i]
@group(0) @binding(5) var<storage, read_write> counter: array<u32>;
@group(0) @binding(6) var<storage, read> portLength: array<f32>; // dz / dRef of each cell (PortMeshFactors.cellLength): the V weights
@group(0) @binding(7) var<storage, read> ports: array<PortDesc>;

const ETA0: f32 = 376.730313668;
const MAX_PORT_CELLS: u32 = 64u;
var<workgroup> vcell: array<f32, 64>;

// The H loop around Ez cell c, Hy sides weighted by wx and Hx sides by wy:
// with the curl scales it is curl(h)_z, with the loop lengths the current (see loopHz in fdtd_cpu.ts).
fn loop_hz(c: u32, wx: f32, wy: f32) -> f32 {
  let n = P.n;
  return (H[n + c] - H[n + c - 1u]) * wx - (H[c] - H[c - P.nx]) * wy;
}

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) t: u32) {
  let step = counter[0];
  let shape = source_shape(step);

  var mine = 0.0;
  if (t < P.port_cells && t < MAX_PORT_CELLS) {
    // The port this cell belongs to: ports are stored in cell order.
    var p = 0u;
    while (t >= ports[p].first_cell + ports[p].series_cells * ports[p].columns) { p++; }
    let d = ports[p];
    let ez = portEz[t];
    let c = ez - 2u * P.n;
    mine = d.ca * E[ez] + d.cb * loop_hz(c, d.curl_scale.x, d.curl_scale.y) + d.cs * (shape * d.vs_scale);
    E[ez] = mine;
  }
  vcell[t] = mine;
  workgroupBarrier();

  // Thread p reduces port p.
  if (t < P.port_count && step < P.max_steps) {
    let d = ports[t];
    let centre_first = d.first_cell + (d.columns / 2u) * d.series_cells;
    var vsum = 0.0;
    for (var m = 0u; m < d.series_cells; m++) { vsum += vcell[centre_first + m] * portLength[centre_first + m]; }
    let mid = d.series_cells / 2u;
    var current = 0.0;
    for (var column = 0u; column < d.columns; column++) {
      current += loop_hz(portEz[d.first_cell + column * d.series_cells + mid] - 2u * P.n, d.loop_length.y, d.loop_length.x);
    }
    let base = 2u * (step * P.port_count + t);
    hist[base] = -vsum;                 // V_top - V_bottom
    hist[base + 1u] = current / ETA0;   // amps, at (step+1/2) dt
  }
  if (t == 0u) { counter[0] = step + 1u; }
}
