// Starts scripts/design.ts with the TypeScript and ?raw hooks registered in code, so a
// harness can launch it from any working directory and on Windows paths:
//   node <repo>/scripts/design-mcp.mjs mcp <design.json> [--gpu]
// (OpenClaw's MCP config does this; see openclaw/design-agent.json5.)
import { register } from 'tsx/esm/api';

register();
await import('../src/node/register_raw_imports.mjs');
const { runMain } = await import('./design.ts');
runMain();
