// FDTD bulk Yee update: CUDA kernel variants vs a CPU reference.
//
// Same problem as bench/webgpu_node/bench_problem.ts (same integer hash and
// formulas, so the CPU checksums printed here and by `npm run bench:wgsl`
// must agree), same update as src/engine/fdtd_cpu.ts updateH/updateE and the
// WGSL kernels update_h.wgsl / update_e.wgsl:
//   h -= Sc * curl(e)                    forward differences
//   e  = eDecay*e + eCurl * curl(h)      backward differences
// each difference scaled by the 1/kappa of its axis, missing neighbours = 0,
// cell index c = i + nx*(j + ny*k), each field 3 blocks [x | y | z] of N floats.
//
// Variants:
//   naive       2 kernels/step, one thread per cell, a line-by-line port of the WGSL.
//   zmarch      2 kernels/step, one thread per (i,j) column marching a chunk of z:
//               the k+1 (H) or k-1 (E) plane stays in registers.
//   fused       1 kernel/step: H and E in one pass, ping-pong buffers. Each block
//               recomputes H on a one-cell halo at low i and low j (shared memory)
//               so E can use the new H without a grid-wide barrier.
//   fused_fp16  fused with every array stored as fp16 (math in fp32). eDecay is
//               stored as its loss 1 - eDecay so fp16 keeps its precision.
//
// Build:  nvcc -O3 -arch=sm_75 -o fdtd_bench fdtd_bench.cu      (T4 and GTX 1660 Ti are sm_75)
// Run:    ./fdtd_bench                   all three grids
//         ./fdtd_bench 64x64x48          one grid

#include <cuda_fp16.h>
#include <cuda_runtime.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <string>
#include <vector>

#define CUDA_CHECK(call)                                                                       \
  do {                                                                                         \
    cudaError_t status_ = (call);                                                              \
    if (status_ != cudaSuccess) {                                                              \
      fprintf(stderr, "%s:%d %s failed: %s\n", __FILE__, __LINE__, #call, cudaGetErrorString(status_)); \
      exit(1);                                                                                 \
    }                                                                                          \
  } while (0)

constexpr int CORRECTNESS_STEPS = 200;
constexpr int KAPPA_RAMP_CELLS = 8;
constexpr uint32_t HASH_STREAM_E_DECAY = 1;
constexpr uint32_t HASH_STREAM_E_CURL = 2;
constexpr uint32_t HASH_STREAM_INITIAL_E = 3;
/** Variants within this of the CPU reference count as correct (float32 rounding only). */
constexpr double FP32_TOLERANCE = 1e-4;
/** Timed run length: about this many cell-updates per variant, so each run takes ~1 s on a T4. */
constexpr double TIMED_CELL_UPDATES = 2.5e9;

// ---------------------------------------------------------------------------
// Problem (identical to bench_problem.ts)
// ---------------------------------------------------------------------------

/** Uniform in [0, 1) from (index, stream); 24-bit result, exact in float32. */
static double hashUniform(uint32_t index, uint32_t stream) {
  uint32_t x = index * 0x9e3779b1u + stream * 0x85ebca77u;
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return (x >> 8) / 16777216.0;
}

static double benchInvKappa(double x, int n) {
  double depth = (KAPPA_RAMP_CELLS - std::min(x, n - 1 - x)) / KAPPA_RAMP_CELLS;
  depth = std::min(1.0, std::max(0.0, depth));
  return 1.0 / (1.0 + 2.0 * depth * depth * depth);
}

struct Problem {
  int nx, ny, nz, cells;
  double courant;
  std::vector<float> eDecay, eCurl, initialE;
  std::vector<float> hInvKappa[3], eInvKappa[3];  // per axis x, y, z
};

static Problem makeProblem(int nx, int ny, int nz) {
  Problem p;
  p.nx = nx; p.ny = ny; p.nz = nz;
  p.cells = nx * ny * nz;
  p.courant = 0.99 / std::sqrt(3.0);  // DEFAULT_GRID.courant
  const size_t edges = 3 * size_t(p.cells);
  p.eDecay.resize(edges);
  p.eCurl.resize(edges);
  p.initialE.resize(edges);
  for (size_t edge = 0; edge < edges; edge++) {
    p.eDecay[edge] = float(1.0 - 0.01 * hashUniform(uint32_t(edge), HASH_STREAM_E_DECAY));
    p.eCurl[edge] = float(p.courant / (1.0 + 3.0 * hashUniform(uint32_t(edge), HASH_STREAM_E_CURL)));
    p.initialE[edge] = float(2.0 * hashUniform(uint32_t(edge), HASH_STREAM_INITIAL_E) - 1.0);
  }
  const int dims[3] = {nx, ny, nz};
  for (int axis = 0; axis < 3; axis++) {
    for (int u = 0; u < dims[axis]; u++) {
      p.eInvKappa[axis].push_back(float(benchInvKappa(u, dims[axis])));
      p.hInvKappa[axis].push_back(float(benchInvKappa(u + 0.5, dims[axis])));
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// CPU reference: fdtd_cpu.ts updateH/updateE main loops, statement for
// statement (JavaScript computes in double and rounds on store, so this does too).
// ---------------------------------------------------------------------------

static void cpuStep(const Problem& p, std::vector<float>& e, std::vector<float>& h) {
  const int nx = p.nx, ny = p.ny, nz = p.nz, N = p.cells, sy = nx, sz = nx * ny;
  const double Sc = p.courant;
  const float *kx = p.hInvKappa[0].data(), *ky = p.hInvKappa[1].data(), *kz = p.hInvKappa[2].data();
  for (int k = 0; k < nz; k++)
    for (int j = 0; j < ny; j++)
      for (int i = 0; i < nx; i++) {
        const int c = i + nx * (j + ny * k);
        const double exc = e[c], eyc = e[N + c], ezc = e[2 * N + c];
        const double exJ = j + 1 < ny ? e[c + sy] : 0, exK = k + 1 < nz ? e[c + sz] : 0;
        const double eyI = i + 1 < nx ? e[N + c + 1] : 0, eyK = k + 1 < nz ? e[N + c + sz] : 0;
        const double ezI = i + 1 < nx ? e[2 * N + c + 1] : 0, ezJ = j + 1 < ny ? e[2 * N + c + sy] : 0;
        h[c] = float(h[c] - Sc * ((ezJ - ezc) * ky[j] - (eyK - eyc) * kz[k]));
        h[N + c] = float(h[N + c] - Sc * ((exK - exc) * kz[k] - (ezI - ezc) * kx[i]));
        h[2 * N + c] = float(h[2 * N + c] - Sc * ((eyI - eyc) * kx[i] - (exJ - exc) * ky[j]));
      }
  kx = p.eInvKappa[0].data(); ky = p.eInvKappa[1].data(); kz = p.eInvKappa[2].data();
  const float *eDecay = p.eDecay.data(), *eCurl = p.eCurl.data();
  for (int k = 0; k < nz; k++)
    for (int j = 0; j < ny; j++)
      for (int i = 0; i < nx; i++) {
        const int c = i + nx * (j + ny * k);
        const double hxc = h[c], hyc = h[N + c], hzc = h[2 * N + c];
        const double hxJ = j > 0 ? h[c - sy] : 0, hxK = k > 0 ? h[c - sz] : 0;
        const double hyI = i > 0 ? h[N + c - 1] : 0, hyK = k > 0 ? h[N + c - sz] : 0;
        const double hzI = i > 0 ? h[2 * N + c - 1] : 0, hzJ = j > 0 ? h[2 * N + c - sy] : 0;
        e[c] = float(double(eDecay[c]) * e[c] + double(eCurl[c]) * ((hzc - hzJ) * ky[j] - (hyc - hyK) * kz[k]));
        e[N + c] = float(double(eDecay[N + c]) * e[N + c] + double(eCurl[N + c]) * ((hxc - hxK) * kz[k] - (hzc - hzI) * kx[i]));
        e[2 * N + c] = float(double(eDecay[2 * N + c]) * e[2 * N + c] + double(eCurl[2 * N + c]) * ((hyc - hyI) * ky[j] - (hxc - hxJ) * kx[i]));
      }
}

// ---------------------------------------------------------------------------
// Kernels
// ---------------------------------------------------------------------------

struct GridDims {
  int nx, ny, nz, cells;
  float sc;
};

/** 1/kappa per axis, at H positions (u + 1/2) and E positions (u). O(n) each, so cache-resident. */
struct InvKappa {
  const float *hx, *hy, *hz, *ex, *ey, *ez;
};

// --- naive: the WGSL kernels transcribed (workgroup 64 -> block 64) ---

constexpr int NAIVE_BLOCK = 64;

__global__ void updateHNaive(GridDims g, const float* E, float* H, InvKappa kap) {
  const int c = blockIdx.x * blockDim.x + threadIdx.x;
  if (c >= g.cells) return;
  const int n = g.cells, sy = g.nx, sz = g.nx * g.ny;
  const int i = c % g.nx, j = (c / g.nx) % g.ny, k = c / sz;
  const float exc = E[c], eyc = E[n + c], ezc = E[2 * n + c];
  float exJ = 0, exK = 0, eyI = 0, eyK = 0, ezI = 0, ezJ = 0;
  if (i + 1 < g.nx) { eyI = E[n + c + 1]; ezI = E[2 * n + c + 1]; }
  if (j + 1 < g.ny) { exJ = E[c + sy]; ezJ = E[2 * n + c + sy]; }
  if (k + 1 < g.nz) { exK = E[c + sz]; eyK = E[n + c + sz]; }
  const float kx = kap.hx[i], ky = kap.hy[j], kz = kap.hz[k];
  H[c] -= g.sc * ((ezJ - ezc) * ky - (eyK - eyc) * kz);
  H[n + c] -= g.sc * ((exK - exc) * kz - (ezI - ezc) * kx);
  H[2 * n + c] -= g.sc * ((eyI - eyc) * kx - (exJ - exc) * ky);
}

__global__ void updateENaive(GridDims g, float* E, const float* H, const float* eDecay, const float* eCurl, InvKappa kap) {
  const int c = blockIdx.x * blockDim.x + threadIdx.x;
  if (c >= g.cells) return;
  const int n = g.cells, sy = g.nx, sz = g.nx * g.ny;
  const int i = c % g.nx, j = (c / g.nx) % g.ny, k = c / sz;
  const float hxc = H[c], hyc = H[n + c], hzc = H[2 * n + c];
  float hxJ = 0, hxK = 0, hyI = 0, hyK = 0, hzI = 0, hzJ = 0;
  if (i > 0) { hyI = H[n + c - 1]; hzI = H[2 * n + c - 1]; }
  if (j > 0) { hxJ = H[c - sy]; hzJ = H[2 * n + c - sy]; }
  if (k > 0) { hxK = H[c - sz]; hyK = H[n + c - sz]; }
  const float kx = kap.ex[i], ky = kap.ey[j], kz = kap.ez[k];
  E[c] = eDecay[c] * E[c] + eCurl[c] * ((hzc - hzJ) * ky - (hyc - hyK) * kz);
  E[n + c] = eDecay[n + c] * E[n + c] + eCurl[n + c] * ((hxc - hxK) * kz - (hzc - hzI) * kx);
  E[2 * n + c] = eDecay[2 * n + c] * E[2 * n + c] + eCurl[2 * n + c] * ((hyc - hyI) * ky - (hxc - hxJ) * kx);
}

// --- zmarch: thread per (i,j) column, marching zChunk planes ---
// Splitting z into chunks keeps enough threads in flight on small grids
// (64x64 columns alone would be 4096 threads, too few to hide DRAM latency).

constexpr int ZMARCH_BLOCK_X = 32, ZMARCH_BLOCK_Y = 4;

__global__ void updateHZMarch(GridDims g, int zChunk, const float* __restrict__ E, float* __restrict__ H, InvKappa kap) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x, j = blockIdx.y * blockDim.y + threadIdx.y;
  if (i >= g.nx || j >= g.ny) return;
  const int n = g.cells, sy = g.nx, sz = g.nx * g.ny;
  const int k0 = blockIdx.z * zChunk, k1 = min(k0 + zChunk, g.nz);
  const bool hasI = i + 1 < g.nx, hasJ = j + 1 < g.ny;
  const float kx = kap.hx[i], ky = kap.hy[j];
  int c = i + g.nx * (j + g.ny * k0);
  float exc = E[c], eyc = E[n + c], ezc = E[2 * n + c];
  for (int k = k0; k < k1; k++, c += sz) {
    float exK = 0, eyK = 0, ezK = 0;
    if (k + 1 < g.nz) { exK = E[c + sz]; eyK = E[n + c + sz]; ezK = E[2 * n + c + sz]; }
    const float eyI = hasI ? E[n + c + 1] : 0.f, ezI = hasI ? E[2 * n + c + 1] : 0.f;
    const float exJ = hasJ ? E[c + sy] : 0.f, ezJ = hasJ ? E[2 * n + c + sy] : 0.f;
    const float kz = kap.hz[k];
    H[c] -= g.sc * ((ezJ - ezc) * ky - (eyK - eyc) * kz);
    H[n + c] -= g.sc * ((exK - exc) * kz - (ezI - ezc) * kx);
    H[2 * n + c] -= g.sc * ((eyI - eyc) * kx - (exJ - exc) * ky);
    exc = exK; eyc = eyK; ezc = ezK;  // plane k+1 becomes the centre of the next step
  }
}

__global__ void updateEZMarch(GridDims g, int zChunk, float* __restrict__ E, const float* __restrict__ H,
                              const float* __restrict__ eDecay, const float* __restrict__ eCurl, InvKappa kap) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x, j = blockIdx.y * blockDim.y + threadIdx.y;
  if (i >= g.nx || j >= g.ny) return;
  const int n = g.cells, sy = g.nx, sz = g.nx * g.ny;
  const int k0 = blockIdx.z * zChunk, k1 = min(k0 + zChunk, g.nz);
  const float kx = kap.ex[i], ky = kap.ey[j];
  int c = i + g.nx * (j + g.ny * k0);
  float hxK = 0, hyK = 0;  // h at k-1; 0 below the grid
  if (k0 > 0) { hxK = H[c - sz]; hyK = H[n + c - sz]; }
  for (int k = k0; k < k1; k++, c += sz) {
    const float hxc = H[c], hyc = H[n + c], hzc = H[2 * n + c];
    const float hyI = i > 0 ? H[n + c - 1] : 0.f, hzI = i > 0 ? H[2 * n + c - 1] : 0.f;
    const float hxJ = j > 0 ? H[c - sy] : 0.f, hzJ = j > 0 ? H[2 * n + c - sy] : 0.f;
    const float kz = kap.ez[k];
    E[c] = eDecay[c] * E[c] + eCurl[c] * ((hzc - hzJ) * ky - (hyc - hyK) * kz);
    E[n + c] = eDecay[n + c] * E[n + c] + eCurl[n + c] * ((hxc - hxK) * kz - (hzc - hzI) * kx);
    E[2 * n + c] = eDecay[2 * n + c] * E[2 * n + c] + eCurl[2 * n + c] * ((hyc - hyI) * ky - (hxc - hxJ) * kx);
    hxK = hxc; hyK = hyc;
  }
}

// --- fused: H and E in one kernel per step ---
// E at (i,j,k) needs the NEW h at (i-1,j,k), (i,j-1,k), (i,j,k-1). Inputs and
// outputs are separate buffers (ping-pong), so blocks never race; the new h of
// the low-i / low-j neighbour column is recomputed by an extra halo row and
// column of threads and shared through shared memory, and the new h of plane
// k-1 is carried in registers. A chunk that starts at k0 > 0 recomputes plane
// k0-1 first (h only).

constexpr int FUSED_TILE_X = 32, FUSED_TILE_Y = 8;
constexpr int FUSED_THREADS = (FUSED_TILE_X + 1) * (FUSED_TILE_Y + 1);

__device__ __forceinline__ float loadField(const float* p, int index) { return p[index]; }
__device__ __forceinline__ float loadField(const __half* p, int index) { return __half2float(p[index]); }
__device__ __forceinline__ void storeField(float* p, int index, float v) { p[index] = v; }
__device__ __forceinline__ void storeField(__half* p, int index, float v) { p[index] = __float2half_rn(v); }
/** fp32 stores eDecay itself; fp16 stores the loss 1 - eDecay (~0.01), where fp16 has 1000x finer steps than near 1. */
__device__ __forceinline__ float loadDecay(const float* p, int index) { return p[index]; }
__device__ __forceinline__ float loadDecay(const __half* p, int index) { return 1.f - __half2float(p[index]); }

template <typename Store>
__global__ void __launch_bounds__(FUSED_THREADS)
fusedStep(GridDims g, int zChunk, const Store* __restrict__ eIn, const Store* __restrict__ hIn, Store* __restrict__ eOut,
          Store* __restrict__ hOut, const Store* __restrict__ eDecay, const Store* __restrict__ eCurl, InvKappa kap) {
  __shared__ float hxPlane[FUSED_TILE_Y + 1][FUSED_TILE_X + 1];
  __shared__ float hyPlane[FUSED_TILE_Y + 1][FUSED_TILE_X + 1];
  __shared__ float hzPlane[FUSED_TILE_Y + 1][FUSED_TILE_X + 1];
  const int tx = threadIdx.x, ty = threadIdx.y;  // tx == 0 or ty == 0: halo thread (computes h only)
  const int i = blockIdx.x * FUSED_TILE_X + tx - 1, j = blockIdx.y * FUSED_TILE_Y + ty - 1;
  const bool inGrid = i >= 0 && i < g.nx && j >= 0 && j < g.ny;
  const bool ownsColumn = inGrid && tx > 0 && ty > 0;
  const int n = g.cells, sy = g.nx, sz = g.nx * g.ny;
  const int k0 = blockIdx.z * zChunk, k1 = min(k0 + zChunk, g.nz);
  const int kStart = k0 > 0 ? k0 - 1 : 0;

  bool hasI = false, hasJ = false;
  float hkx = 0, hky = 0, ekx = 0, eky = 0;
  int c = 0;
  float exc = 0, eyc = 0, ezc = 0;
  if (inGrid) {
    hasI = i + 1 < g.nx; hasJ = j + 1 < g.ny;
    hkx = kap.hx[i]; hky = kap.hy[j]; ekx = kap.ex[i]; eky = kap.ey[j];
    c = i + g.nx * (j + g.ny * kStart);
    exc = loadField(eIn, c); eyc = loadField(eIn, n + c); ezc = loadField(eIn, 2 * n + c);
  }
  float hxBelow = 0, hyBelow = 0;  // new h at (i,j,k-1); 0 below the grid
  for (int k = kStart; k < k1; k++, c += sz) {
    float hxNew = 0, hyNew = 0, hzNew = 0, exNext = 0, eyNext = 0, ezNext = 0;
    if (inGrid) {
      if (k + 1 < g.nz) { exNext = loadField(eIn, c + sz); eyNext = loadField(eIn, n + c + sz); ezNext = loadField(eIn, 2 * n + c + sz); }
      const float eyI = hasI ? loadField(eIn, n + c + 1) : 0.f, ezI = hasI ? loadField(eIn, 2 * n + c + 1) : 0.f;
      const float exJ = hasJ ? loadField(eIn, c + sy) : 0.f, ezJ = hasJ ? loadField(eIn, 2 * n + c + sy) : 0.f;
      const float kz = kap.hz[k];
      hxNew = loadField(hIn, c) - g.sc * ((ezJ - ezc) * hky - (eyNext - eyc) * kz);
      hyNew = loadField(hIn, n + c) - g.sc * ((exNext - exc) * kz - (ezI - ezc) * hkx);
      hzNew = loadField(hIn, 2 * n + c) - g.sc * ((eyI - eyc) * hkx - (exJ - exc) * hky);
    }
    hxPlane[ty][tx] = hxNew; hyPlane[ty][tx] = hyNew; hzPlane[ty][tx] = hzNew;
    __syncthreads();
    if (ownsColumn && k >= k0) {
      storeField(hOut, c, hxNew); storeField(hOut, n + c, hyNew); storeField(hOut, 2 * n + c, hzNew);
      // Halo threads outside the grid wrote 0: the missing-neighbour rule.
      const float hxJ = hxPlane[ty - 1][tx], hzJ = hzPlane[ty - 1][tx];
      const float hyI = hyPlane[ty][tx - 1], hzI = hzPlane[ty][tx - 1];
      const float kz = kap.ez[k];
      storeField(eOut, c, loadDecay(eDecay, c) * exc + loadField(eCurl, c) * ((hzNew - hzJ) * eky - (hyNew - hyBelow) * kz));
      storeField(eOut, n + c, loadDecay(eDecay, n + c) * eyc + loadField(eCurl, n + c) * ((hxNew - hxBelow) * kz - (hzNew - hzI) * ekx));
      storeField(eOut, 2 * n + c, loadDecay(eDecay, 2 * n + c) * ezc + loadField(eCurl, 2 * n + c) * ((hyNew - hyI) * eky - (hxNew - hxJ) * ekx));
    }
    hxBelow = hxNew; hyBelow = hyNew;
    exc = exNext; eyc = eyNext; ezc = ezNext;
    __syncthreads();  // the planes are overwritten next iteration
  }
}

// ---------------------------------------------------------------------------
// Host side
// ---------------------------------------------------------------------------

template <typename T>
struct DeviceArray {
  T* ptr = nullptr;
  size_t count = 0;
  explicit DeviceArray(size_t n) : count(n) { CUDA_CHECK(cudaMalloc(&ptr, n * sizeof(T))); }
  ~DeviceArray() { cudaFree(ptr); }
  DeviceArray(const DeviceArray&) = delete;
  DeviceArray& operator=(const DeviceArray&) = delete;
  void upload(const std::vector<T>& host) { CUDA_CHECK(cudaMemcpy(ptr, host.data(), count * sizeof(T), cudaMemcpyHostToDevice)); }
  void zero() { CUDA_CHECK(cudaMemset(ptr, 0, count * sizeof(T))); }
  std::vector<T> download() const {
    std::vector<T> host(count);
    CUDA_CHECK(cudaMemcpy(host.data(), ptr, count * sizeof(T), cudaMemcpyDeviceToHost));
    return host;
  }
};

static std::vector<__half> toHalf(const std::vector<float>& values) {
  std::vector<__half> out(values.size());
  for (size_t n = 0; n < values.size(); n++) out[n] = __float2half_rn(values[n]);
  return out;
}

static std::vector<float> toFloat(const std::vector<__half>& values) {
  std::vector<float> out(values.size());
  for (size_t n = 0; n < values.size(); n++) out[n] = __half2float(values[n]);
  return out;
}

/** One way of advancing the fields: reset to the initial state, step, read E. */
struct Variant {
  std::string name;
  int zChunk;  // 0 = not applicable
  /** Minimum DRAM bytes per cell-update: each array element read or written once. */
  int bytesPerCellUpdate;
  /** fp32 variants must match the CPU reference to FP32_TOLERANCE; fp16's error is the measurement. */
  bool mustMatchFp32;
  std::function<void()> reset;
  std::function<void(int steps)> run;
  std::function<std::vector<float>()> readE;
};

static double maxRelativeDifference(const std::vector<float>& actual, const std::vector<float>& reference) {
  double maxDiff = 0, maxRef = 0;
  for (size_t n = 0; n < reference.size(); n++) {
    if (!std::isfinite(actual[n])) return INFINITY;
    maxDiff = std::max(maxDiff, std::fabs(double(actual[n]) - reference[n]));
    maxRef = std::max(maxRef, std::fabs(double(reference[n])));
  }
  return maxDiff / maxRef;
}

static double checksum(const std::vector<float>& values) {
  double sum = 0;
  for (float v : values) sum += v;
  return sum;
}

/** Device-to-device copy bandwidth (read + write): the practical roofline for these kernels. */
static double measureCopyBandwidthGBs() {
  const size_t bytes = size_t(256) << 20;
  DeviceArray<char> src(bytes), dst(bytes);
  CUDA_CHECK(cudaMemcpy(dst.ptr, src.ptr, bytes, cudaMemcpyDeviceToDevice));
  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  const int repeats = 20;
  CUDA_CHECK(cudaEventRecord(start));
  for (int r = 0; r < repeats; r++) CUDA_CHECK(cudaMemcpy(dst.ptr, src.ptr, bytes, cudaMemcpyDeviceToDevice));
  CUDA_CHECK(cudaEventRecord(stop));
  CUDA_CHECK(cudaEventSynchronize(stop));
  float ms = 0;
  CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
  return 2.0 * bytes * repeats / (ms * 1e6);
}

static void benchmarkGrid(int nx, int ny, int nz, double copyGBs, bool& allCorrect) {
  const Problem p = makeProblem(nx, ny, nz);
  const size_t edges = 3 * size_t(p.cells);
  printf("\n== %dx%dx%d (%d cells) ==\n", nx, ny, nz, p.cells);

  printf("CPU reference, %d steps ... ", CORRECTNESS_STEPS);
  fflush(stdout);
  std::vector<float> refE = p.initialE, refH(edges, 0.f);
  for (int s = 0; s < CORRECTNESS_STEPS; s++) cpuStep(p, refE, refH);
  // Same number `npm run bench:wgsl` prints for this grid.
  printf("cpuChecksumE %.10g\n", checksum(refE));

  GridDims dims{nx, ny, nz, p.cells, float(p.courant)};
  DeviceArray<float> kappa[6] = {DeviceArray<float>(nx), DeviceArray<float>(ny), DeviceArray<float>(nz),
                                 DeviceArray<float>(nx), DeviceArray<float>(ny), DeviceArray<float>(nz)};
  for (int axis = 0; axis < 3; axis++) {
    kappa[axis].upload(p.hInvKappa[axis]);
    kappa[3 + axis].upload(p.eInvKappa[axis]);
  }
  const InvKappa kap{kappa[0].ptr, kappa[1].ptr, kappa[2].ptr, kappa[3].ptr, kappa[4].ptr, kappa[5].ptr};

  // fp32 state (the fused variant ping-pongs between A and B).
  DeviceArray<float> eA(edges), eB(edges), hA(edges), hB(edges), eDecay(edges), eCurl(edges);
  eDecay.upload(p.eDecay);
  eCurl.upload(p.eCurl);
  float *eCur = eA.ptr, *eNext = eB.ptr, *hCur = hA.ptr, *hNext = hB.ptr;
  auto resetFloat = [&]() {
    eA.upload(p.initialE);
    hA.zero();
    eCur = eA.ptr; eNext = eB.ptr; hCur = hA.ptr; hNext = hB.ptr;
  };
  auto readFloatE = [&]() {
    std::vector<float> host(edges);
    CUDA_CHECK(cudaMemcpy(host.data(), eCur, edges * sizeof(float), cudaMemcpyDeviceToHost));
    return host;
  };

  // fp16 state.
  std::vector<float> lossHost(edges);
  for (size_t n = 0; n < edges; n++) lossHost[n] = 1.f - p.eDecay[n];
  DeviceArray<__half> eA16(edges), eB16(edges), hA16(edges), hB16(edges), eLoss16(edges), eCurl16(edges);
  eLoss16.upload(toHalf(lossHost));
  eCurl16.upload(toHalf(p.eCurl));
  const std::vector<__half> initialE16 = toHalf(p.initialE);
  __half *eCur16 = eA16.ptr, *eNext16 = eB16.ptr, *hCur16 = hA16.ptr, *hNext16 = hB16.ptr;
  auto resetHalf = [&]() {
    eA16.upload(initialE16);
    hA16.zero();
    eCur16 = eA16.ptr; eNext16 = eB16.ptr; hCur16 = hA16.ptr; hNext16 = hB16.ptr;
  };
  auto readHalfE = [&]() {
    std::vector<__half> host(edges);
    CUDA_CHECK(cudaMemcpy(host.data(), eCur16, edges * sizeof(__half), cudaMemcpyDeviceToHost));
    return toFloat(host);
  };

  std::vector<Variant> variants;
  variants.push_back({"naive", 0, 96, true, resetFloat,
                      [&](int steps) {
                        const int blocks = (p.cells + NAIVE_BLOCK - 1) / NAIVE_BLOCK;
                        for (int s = 0; s < steps; s++) {
                          updateHNaive<<<blocks, NAIVE_BLOCK>>>(dims, eCur, hCur, kap);
                          updateENaive<<<blocks, NAIVE_BLOCK>>>(dims, eCur, hCur, eDecay.ptr, eCurl.ptr, kap);
                        }
                        CUDA_CHECK(cudaGetLastError());
                      },
                      readFloatE});
  for (int zChunk : {8, 16, 32}) {
    const dim3 block(ZMARCH_BLOCK_X, ZMARCH_BLOCK_Y);
    const dim3 grid((nx + ZMARCH_BLOCK_X - 1) / ZMARCH_BLOCK_X, (ny + ZMARCH_BLOCK_Y - 1) / ZMARCH_BLOCK_Y, (nz + zChunk - 1) / zChunk);
    variants.push_back({"zmarch", zChunk, 96, true, resetFloat,
                        [&, block, grid, zChunk](int steps) {
                          for (int s = 0; s < steps; s++) {
                            updateHZMarch<<<grid, block>>>(dims, zChunk, eCur, hCur, kap);
                            updateEZMarch<<<grid, block>>>(dims, zChunk, eCur, hCur, eDecay.ptr, eCurl.ptr, kap);
                          }
                          CUDA_CHECK(cudaGetLastError());
                        },
                        readFloatE});
  }
  for (int zChunk : {8, 16, 32}) {
    const dim3 block(FUSED_TILE_X + 1, FUSED_TILE_Y + 1);
    const dim3 grid((nx + FUSED_TILE_X - 1) / FUSED_TILE_X, (ny + FUSED_TILE_Y - 1) / FUSED_TILE_Y, (nz + zChunk - 1) / zChunk);
    // fp32: read e, h, eDecay, eCurl (48 B) + write e, h (24 B).
    variants.push_back({"fused", zChunk, 72, true, resetFloat,
                        [&, block, grid, zChunk](int steps) {
                          for (int s = 0; s < steps; s++) {
                            fusedStep<float><<<grid, block>>>(dims, zChunk, eCur, hCur, eNext, hNext, eDecay.ptr, eCurl.ptr, kap);
                            std::swap(eCur, eNext);
                            std::swap(hCur, hNext);
                          }
                          CUDA_CHECK(cudaGetLastError());
                        },
                        readFloatE});
    variants.push_back({"fused_fp16", zChunk, 36, false, resetHalf,
                        [&, block, grid, zChunk](int steps) {
                          for (int s = 0; s < steps; s++) {
                            fusedStep<__half><<<grid, block>>>(dims, zChunk, eCur16, hCur16, eNext16, hNext16, eLoss16.ptr, eCurl16.ptr, kap);
                            std::swap(eCur16, eNext16);
                            std::swap(hCur16, hNext16);
                          }
                          CUDA_CHECK(cudaGetLastError());
                        },
                        readHalfE});
  }

  cudaEvent_t start, stop;
  CUDA_CHECK(cudaEventCreate(&start));
  CUDA_CHECK(cudaEventCreate(&stop));
  const int timedSteps = std::max(50, std::min(5000, int(TIMED_CELL_UPDATES / p.cells)));
  printf("%-11s %6s %6s %10s %8s %8s %11s\n", "variant", "zChunk", "steps", "Mcells/s", "GB/s", "%copyBW", "maxRelDiff");
  for (Variant& v : variants) {
    v.reset();
    v.run(CORRECTNESS_STEPS);
    CUDA_CHECK(cudaDeviceSynchronize());
    const double relDiff = maxRelativeDifference(v.readE(), refE);
    if (v.mustMatchFp32 && !(relDiff < FP32_TOLERANCE)) allCorrect = false;

    v.reset();
    v.run(5);  // warm-up
    CUDA_CHECK(cudaEventRecord(start));
    v.run(timedSteps);
    CUDA_CHECK(cudaEventRecord(stop));
    CUDA_CHECK(cudaEventSynchronize(stop));
    float ms = 0;
    CUDA_CHECK(cudaEventElapsedTime(&ms, start, stop));
    const double mcells = double(p.cells) * timedSteps / (ms * 1e3);
    const double gbs = mcells * v.bytesPerCellUpdate / 1e3;
    const std::string chunk = v.zChunk ? std::to_string(v.zChunk) : "-";
    printf("%-11s %6s %6d %10.1f %8.1f %7.0f%% %11.2e\n", v.name.c_str(), chunk.c_str(), timedSteps, mcells, gbs,
           100.0 * gbs / copyGBs, relDiff);
  }
  CUDA_CHECK(cudaEventDestroy(start));
  CUDA_CHECK(cudaEventDestroy(stop));
}

int main(int argc, char** argv) {
  std::vector<std::vector<int>> grids = {{64, 64, 48}, {128, 128, 96}, {256, 256, 192}};
  if (argc > 1) {
    int nx, ny, nz;
    if (argc != 2 || sscanf(argv[1], "%dx%dx%d", &nx, &ny, &nz) != 3 || nx < 2 || ny < 2 || nz < 2) {
      fprintf(stderr, "usage: %s [NXxNYxNZ]\n", argv[0]);
      return 2;
    }
    grids = {{nx, ny, nz}};
  }
  int deviceIndex = 0;
  CUDA_CHECK(cudaGetDevice(&deviceIndex));
  cudaDeviceProp prop;
  CUDA_CHECK(cudaGetDeviceProperties(&prop, deviceIndex));
  const double copyGBs = measureCopyBandwidthGBs();
  printf("device: %s (sm_%d%d, %d SMs, L2 %d KB)\n", prop.name, prop.major, prop.minor, prop.multiProcessorCount, prop.l2CacheSize / 1024);
  printf("measured device-to-device copy bandwidth: %.1f GB/s\n", copyGBs);
  printf("Mcells/s = cell-updates (H+E of one cell) per second; GB/s = Mcells/s x minimum bytes per cell-update\n");
  printf("(naive/zmarch 96 B, fused 72 B, fused_fp16 36 B); maxRelDiff = max|E - E_cpu| / max|E_cpu| after %d steps\n",
         CORRECTNESS_STEPS);
  bool allCorrect = true;
  for (const auto& g : grids) benchmarkGrid(g[0], g[1], g[2], copyGBs, allCorrect);
  if (!allCorrect) {
    fprintf(stderr, "FAIL: an fp32 variant differs from the CPU reference by more than %.0e\n", FP32_TOLERANCE);
    return 1;
  }
  return 0;
}
