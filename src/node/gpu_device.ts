/**
 * Headless WebGPU device for Node via Dawn (the `webgpu` npm package, a
 * optionalDependency). Replaces only Fdtd3D.create's use of navigator.gpu; the
 * engine itself takes a GPUDevice and runs unchanged.
 */
import { create, globals } from 'webgpu';

export interface NodeGpu {
  device: GPUDevice;
  adapterName: string;
}

/**
 * dawn.node keeps polling the instance for finished GPU work, but does not
 * keep the JS object alive: once the instance is garbage-collected, the next
 * poll dereferences freed memory (seen here as SIGSEGV in
 * CallbackTaskManager::Flush, or a glibc mutex assertion). A browser holds
 * navigator.gpu for the page's lifetime; this module-level reference does the same.
 */
let dawnInstance: GPU | null = null;

export const NO_WEBGPU_ADAPTER_MESSAGE =
  'Dawn found no WebGPU adapter. Without a GPU driver, point the Vulkan loader at a software driver, ' +
  'e.g. VK_ICD_FILENAMES=/opt/lavapipe/lvp_icd.json (see bench/README.md for drivers).';

async function requestNodeAdapter(): Promise<GPUAdapter | null> {
  // fdtd3d.ts uses the GPUBufferUsage / GPUMapMode constants as browser globals.
  Object.assign(globalThis, globals);
  dawnInstance ??= create([]);
  return dawnInstance.requestAdapter({ powerPreference: 'high-performance' });
}

function adapterNameOf(adapter: GPUAdapter): string {
  const info = adapter.info;
  return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || 'unnamed adapter';
}

/**
 * The name of the adapter createNodeGpuDevice would use, without opening a
 * device, or null when there is none. A software adapter (llvmpipe,
 * SwiftShader) counts: its name says so, and it still runs the kernels on all
 * CPU cores, faster than the single-threaded CPU reference.
 */
export async function findNodeGpuAdapterName(): Promise<string | null> {
  const adapter = await requestNodeAdapter();
  return adapter && adapterNameOf(adapter);
}

export async function createNodeGpuDevice(): Promise<NodeGpu> {
  const adapter = await requestNodeAdapter();
  if (!adapter) throw new Error(NO_WEBGPU_ADAPTER_MESSAGE);
  // The default 128 MiB binding limit is smaller than one field buffer
  // (3N floats) once N > 11.2M cells, e.g. the 256x256x192 benchmark grid.
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  // Dawn reports validation errors asynchronously; without this a broken
  // dispatch would silently produce zeros. Fail the process instead.
  device.onuncapturederror = (event) => {
    console.error('[webgpu] uncaptured error:', event.error.message);
    process.exit(1);
  };
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') console.error('[webgpu] device lost:', info.message);
  });
  return { device, adapterName: adapterNameOf(adapter) };
}
