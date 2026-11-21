# OpenClaw + Kimi K3.1 Pro

Three ways to let OpenClaw drive NobuRF:

- From a sentence, with the spend guard: `npm run design -- agent "<request>"` writes an OpenClaw config for the
  run, starts the MCP server with `start_design` as its first tool, and puts the model behind a local proxy that
  holds the key and enforces the caps. `agent-race` does it for two lanes. See
  [docs/design-agent.md](../docs/design-agent.md#from-a-sentence-through-openclaw).

- The design tools, as an MCP server: `openclaw/design-agent.json5` registers
  `node scripts/design-mcp.mjs mcp <design.json>`. The tools, the goal and the spend caps are described in
  [docs/design-agent.md](../docs/design-agent.md). OpenClaw runs are not covered by NobuRF's own spend
  caps; read that page's "Models and spend" section first.
- The live demo page's bridge, as HTTP tools: `tools.json` is the contract for `get_state`, `apply_edit`
  and `reset` on `server/bridge.ts`, and `server/rate_meter.ts` is the RPM/TPM guard.

`system_prompt.md` lists the facts the model needs about the demo patch.

## Saturday checklist (10:00 AM PT onward)

1. `openclaw plugins install @openclaw/cerebras-provider`, then
   `openclaw onboard --auth-choice cerebras-api-key` (key from `CEREBRAS_API_KEY`).
2. `CEREBRAS_MODEL=moonshotai-kimi-k3.1-pro-trial npm run cerebras:ping` to confirm
   trial access and the elevated limits.
3. Register `get_state`, `apply_edit`, `reset` (see `tools.json`) as OpenClaw tools
   pointing at `http://127.0.0.1:8787`.
4. Write `system_prompt.md`, build the loop, and record tokens with
   `POST /api/meter/record` after each Cerebras call so the HUD shows live RPM/TPM.
5. Race runner: same baseline, Cerebras vs a GPU provider, side by side.

Provider facts (from docs.openclaw.ai/providers/cerebras, checked Nov 19): env var
`CEREBRAS_API_KEY`, OpenAI-compatible API at `https://api.cerebras.ai/v1`, model ids
in `provider/model` form (so likely `cerebras/moonshotai-kimi-k3.1-pro-trial`;
confirm at kickoff).
