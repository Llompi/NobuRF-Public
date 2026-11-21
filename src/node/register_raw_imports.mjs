// `node --import tsx --import ./src/node/register_raw_imports.mjs script.ts`
// Hooks registered later run first, so these see `?raw` specifiers before tsx does.
import { register } from 'node:module';

register('./raw_import_hooks.mjs', import.meta.url);
