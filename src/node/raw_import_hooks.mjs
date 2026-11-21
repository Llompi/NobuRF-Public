// Node module hooks that give `import text from './x.wgsl?raw'` the meaning
// Vite gives it (default export = the file's text). This lets
// src/engine/fdtd3d.ts run unchanged in Node, reading the same .wgsl files the
// browser build bundles, so no shader source is duplicated.
// Registered by register_raw_imports.mjs; see bench/README.md for the command line.
import { readFile } from 'node:fs/promises';

const RAW_SUFFIX = '?raw';

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith(RAW_SUFFIX)) return nextResolve(specifier, context);
  // Relative or absolute paths only, as in the engine; a bare specifier makes new URL throw.
  return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(RAW_SUFFIX)) return nextLoad(url, context);
  const fileUrl = new URL(url);
  fileUrl.search = '';
  const text = await readFile(fileUrl, 'utf8');
  return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
}
