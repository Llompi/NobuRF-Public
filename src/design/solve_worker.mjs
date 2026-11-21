// Worker entry: registers the TypeScript hooks in this thread (a worker does not
// inherit hooks registered in code by its parent), then loads the worker itself.
import { register } from 'tsx/esm/api';

register();
await import('../node/register_raw_imports.mjs');
await import('./solve_worker.ts');
