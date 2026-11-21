# Kernel benchmarks: WGSL (headless Node) vs CUDA

Purpose: decide the kernel language (WGSL vs CUDA, or lower) from measurements.
Two pieces, one problem:

| Piece | What it runs | Where |
|---|---|---|
| `webgpu_node/` | The real `Fdtd3D` engine and its unchanged WGSL kernels, headless in Node via Dawn (`webgpu` npm package) | any machine with Node 20+; a GPU for meaningful timings |
| `cuda/fdtd_bench.cu` | Four CUDA variants of the same bulk update + a CPU reference, one self-contained file | Colab T4, the GTX 1660 Ti laptop, any NVIDIA GPU |

## The common problem

Both sides build the identical problem (`webgpu_node/bench_problem.ts` and `makeProblem` in `fdtd_bench.cu`, same integer hash and formulas):

- Bulk Yee update only, as in `fdtd_cpu.ts` `updateH`/`updateE` and `update_h.wgsl`/`update_e.wgsl`: `h -= Sc*curl(e)` (forward differences), `e = eDecay*e + eCurl*curl(h)` (backward differences), missing neighbours read 0, index `i + nx*(j + ny*k)`, each field one buffer `[x | y | z]`.
- No CPML slabs, no port. The 1/kappa lookups are kept and graded over 8 cells at every face, so a kernel that dropped them fails the check.
- Random lossy materials per edge (`eDecay` in (0.99, 1], `eps_r` in [1, 4)); initial `e` uniform in [-1, 1), `h = 0`.
- Grids 64x64x48 (the demo grid), 128x128x96 and 256x256x192.
- Correctness: max |E - E_cpu| / max |E_cpu| after 200 steps. Both programs also print `cpuChecksumE`, the sum of the CPU reference E after 200 steps. They must agree (64x64x48: `29068.39547`, 128x128x96: `-12745.30589`), which shows the two problems are the same.
- One cell-update is H + E of one cell. Mcells/s = cells x steps / seconds. "GB/s" is effective: Mcells/s x the minimum DRAM bytes per cell-update for that variant (table below), so it can be compared with the card's bandwidth.

## 1. Headless WebGPU in Node

```sh
npm ci                     # installs the optional webgpu dependency (Dawn for Node)
npm run test:gpu:node      # self-test parity: GPU vs CPU, all kernels (bulk, CPML, port)
npm run bench:wgsl         # the kernel benchmark table
npm run bench:wgsl -- --grids 64x64x48 --seconds 5
```

How it works, without touching the browser path:

- `fdtd3d.ts` imports shaders with Vite's `?raw`. `src/node/register_raw_imports.mjs` registers Node module hooks (`raw_import_hooks.mjs`) that give `?raw` the same meaning, reading the same `.wgsl` files. The npm scripts run `node --import tsx --import ./src/node/register_raw_imports.mjs ...`.
- `src/node/gpu_device.ts` creates the `GPUDevice` with Dawn and passes it to the existing `Fdtd3D` constructor. `Fdtd3D.create` (the browser's `navigator.gpu` path) is not used. It also turns Dawn's asynchronous validation errors into a process exit, so a broken dispatch cannot quietly produce zeros.

**Machine with a GPU.** Nothing to set. Windows picks D3D12, Linux picks the Vulkan driver, macOS picks Metal. Check the `adapter:` line. On the laptop it must name the NVIDIA card, not the Intel iGPU. Close any browser tab running the solver first.

**No GPU (this cloud container, CI).** Dawn needs a Vulkan driver. Point the loader at a software one:

```sh
VK_ICD_FILENAMES=/opt/lavapipe/lvp_icd.json npm run test:gpu:node                  # Mesa lavapipe (llvmpipe)
VK_ICD_FILENAMES=/opt/swiftshader-llvm-fast/vk_swiftshader_icd.json npm run test:gpu:node   # SwiftShader
```

Without a driver it stops with `Dawn found no WebGPU adapter...`.

Results in the cloud container (4 vCPU, no GPU), 2026-11-19:

| Check | lavapipe (llvmpipe, Mesa 26.0.8) | SwiftShader 5.0.0 |
|---|---|---|
| vacuum + CPML parity, 32^3, 1000 steps | 4.1e-7 PASS | 4.1e-7 PASS |
| port V(t), demo grid, lossy FR-4, 300 steps | 9.5e-7 PASS | 2.3e-4 PASS |

`bench:wgsl` on lavapipe: about 45 Mcells/s, and a max relative difference of 1.8e-6 (64x64x48) and 3.0e-6 (128x128x96). Software rendering says nothing about GPU speed. It only shows that the harness and the kernels work. 256x256x192 shows `NOT RUN`: lavapipe caps a storage binding at 128 MiB, and one field buffer of that grid is 144 MiB.

Two findings for whoever owns `fdtd3d.ts`:

- **128 MiB binding limit (fixed).** `Fdtd3D` binds each field (3N floats) as one buffer. `Fdtd3D.create` and the Node harness now request the adapter's own `maxStorageBufferBindingSize` and `maxBufferSize`, so grids over 11.18M cells run wherever the hardware allows. Software adapters (lavapipe, SwiftShader) still cap at 128 MiB, and `bench:wgsl` reports such rows as NOT RUN.
- **65,535 workgroups per dimension (fixed).** A 1D dispatch failed above about 4.2M cells. Kernels now dispatch rows of workgroups (`flatDispatchSize`, `flat_index` in `common.wgsl`); 256x256x192 runs at 2,164 Mcells/s on a GTX 1660 Ti Max-Q.
- **Dawn-in-Node gotcha.** Keep a reference to the object `create()` returns for the life of the process. dawn.node keeps polling the instance but does not keep it alive. Once it is garbage-collected, Node crashes at random (SIGSEGV in `CallbackTaskManager::Flush`, or a glibc mutex assertion). `src/node/gpu_device.ts` keeps it in a module-level variable.

## 2. CUDA

Variants in `cuda/fdtd_bench.cu`:

| Variant | Kernels/step | Idea | Min bytes per cell-update |
|---|---|---|---|
| `naive` | 2 | Line-by-line port of the WGSL, 1 thread per cell, block 64 | 96 |
| `zmarch` | 2 | Thread per (i,j) column marching a z-chunk; the k+-1 plane stays in registers | 96 (less L1/L2 traffic) |
| `fused` | 1 | H and E in one pass with ping-pong buffers. A 1-cell halo of H is recomputed per 32x8 tile into shared memory, so there is no grid-wide barrier | 72 |
| `fused_fp16` | 1 | `fused` with every array stored as fp16 and fp32 math. eDecay is stored as 1 - eDecay to keep precision | 36 |

`zmarch` and `fused` run with z-chunks of 8, 16 and 32 planes; the table prints each. The correctness bar for the fp32 variants is 1e-4 (the program exits 1 above it). The fp16 error is reported, not judged.

Verified here, without a GPU: the device code compiles through clang 18 + NVIDIA ptxas 12.9 for sm_75 with no warnings (registers per thread: naive 27/34, zmarch 44/58, fused 57, fused_fp16 60). The host code compiles. The C++ CPU reference reproduces the TypeScript checksums bit for bit. The fused kernel's halo and z-chunk logic was checked exactly (zero difference) against the reference update with a block-synchronous emulation. Nothing has run on a real GPU yet.

### Google Colab (T4, free)

1. Open `cuda/fdtd_bench_colab.ipynb` in Colab (File > Upload notebook).
2. Runtime > Change runtime type > T4 GPU.
3. Run all. The notebook embeds `fdtd_bench.cu` (regenerate it with
   `python bench/cuda/make_colab_notebook.py` after editing the .cu). The last
   cell is `nvcc -O3 -arch=sm_75 -o fdtd_bench fdtd_bench.cu && ./fdtd_bench`.

### Windows laptop (GTX 1660 Ti)

1. Install the CUDA Toolkit 12.x and Visual Studio 2022 Build Tools with the "Desktop development with C++" workload.
2. Open "x64 Native Tools Command Prompt for VS 2022" in `bench\cuda` and run:
   ```bat
   nvcc -O3 -arch=sm_75 -o fdtd_bench.exe fdtd_bench.cu
   fdtd_bench.exe
   ```
3. Run it plugged in, with the browser closed. Then run `npm run bench:wgsl` on the same laptop. That gives WGSL and CUDA on the same GPU, the same day, for the same problem.

One grid only: `fdtd_bench 64x64x48`. Linux: same `nvcc` line.

Expected run time: a few seconds of GPU time per grid. The single-threaded CPU reference for 256x256x192 takes up to about a minute.

## What to look for

1. **Correctness first.** `maxRelDiff` around 1e-6 for every fp32 row and for WGSL. `cpuChecksumE` equal in both outputs.
2. **Language, same algorithm:** WGSL (`bench:wgsl`) vs CUDA `naive` on the same GPU. A small gap means the language is not the bottleneck.
3. **Algorithm:** `naive` vs `zmarch` vs `fused` vs `fused_fp16`. Look at `%copyBW` (effective GB/s over the measured device-to-device copy bandwidth). About 70-90% means the variant is at its roofline and only moving fewer bytes can help.
4. **Accuracy of fp16:** the `fused_fp16` maxRelDiff. Decide whether it is acceptable for S11. A follow-up would run the real patch case through fp16 and compare S11, not just fields.
5. **Small grid:** 64x64x48 is only 196k cells. Expect a lower `%copyBW` there (launch overhead, too few threads), most of all for the 2-kernel variants.

## Roofline estimate

The update does about 45 flops per cell-update against 96 bytes (0.5 flop/byte). The T4's balance point is 8.1 TFLOP/s / 320 GB/s, about 25 flop/byte, and the 1660 Ti Max-Q's about 17. The kernel is memory-bound by a factor of 30-50, so Mcells/s is approximately bandwidth / bytes per cell-update:

| Variant | B/cell-update | T4 nominal 320 GB/s | T4 at ~80% (practical) | 1660 Ti Max-Q nominal 288 GB/s | at ~80% |
|---|---|---|---|---|---|
| WGSL / naive / zmarch | 96 | 3,330 | ~2,700 | 3,000 | ~2,400 |
| fused fp32 | 72 | 4,440 | ~3,600 | 4,000 | ~3,200 |
| fused fp16 storage | 36 | 8,890 | ~7,100 | 8,000 | ~6,400 |

What the laptop measures today: 1,070 Mcells/s in Edge WebGPU on the demo grid (3000 steps in 552 ms, 184 us per step). That run is not the bulk update alone. On 64x64x48 with an 8-cell CPML, about 83% of the cells (counted per axis slab) also get a CPML pass, about 70 B per cell-update more by estimate. On top of that come about 9 dispatches per step on a small grid. So the real ceiling there is about 288 GB/s / ~170 B, roughly 1,700 Mcells/s, and today's 1,070 is about 60% of it. The levers are bytes and dispatches (fold the CPML into the bulk kernels, fuse H+E, fp16 storage), not the language.

**Can hand-written PTX/SASS beat optimised CUDA? Not plausibly.** At 0.5 flop/byte the SMs are idle 95%+ of the time, waiting on DRAM. Assembly controls instruction choice, scheduling and register allocation. None of those changes the number of bytes that must cross the memory bus, and nvcc already emits coalesced, cached loads. The best SASS can do is reach the same bandwidth roofline that good CUDA C++ already approaches, perhaps a few percent closer on latency-bound small grids. Every lever that matters is expressible in CUDA C++, and nearly all in WGSL too: fusion, fp16 storage (core WGSL `pack2x16float`/`unpack2x16float`, or the `shader-f16` feature), a per-cell material ID instead of two float coefficient arrays (about 51 B fp32, about 27 B fp16), and temporal blocking (several steps per pass through shared memory or L2, the only way past the per-step roofline). The case for CUDA is therefore about tooling and features (profilers, guaranteed shared memory and warp intrinsics), not raw speed, and the CUDA vs WGSL `naive` rows on the same laptop are the measurement that settles it.
