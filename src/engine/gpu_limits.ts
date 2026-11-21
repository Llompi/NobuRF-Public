/**
 * Port limits of the GPU engine (fdtd3d.ts), in a module without WGSL
 * imports so the CLI can check a model before it loads the GPU solver.
 */

/** Cells of all ports together: the port kernel is one workgroup of 64 threads (port.wgsl repeats it). */
export const MAX_PORT_CELLS = 64;
export const MAX_PORTS = 8;

/** Why the GPU engine cannot load a model with these ports, or null when it can. */
export function gpuPortLimitExceeded(ports: ReadonlyArray<{ cells: number }>): string | null {
  const portCells = ports.reduce((sum, p) => sum + p.cells, 0);
  if (ports.length > MAX_PORTS) return `the model has ${ports.length} ports and the GPU engine takes at most ${MAX_PORTS}`;
  if (portCells > MAX_PORT_CELLS) return `the ports span ${portCells} cells together and the GPU engine takes at most ${MAX_PORT_CELLS}`;
  return null;
}
