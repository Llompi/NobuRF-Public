# Using NobuRF from an agent

NobuRF is a 3D field solver (FDTD) for antennas and other planar copper
on a board. This page is for an AI agent, or a person setting one up, that
wants to design or check a board with it. You need Node 20 or newer and this
repository (and, for `npm run design -- agent`, OpenClaw on Node 24.16 or newer). A GPU is optional: the same kernels run on the GPU through Dawn
(`--gpu`) or on a CPU reference.

```bash
git clone https://github.com/Llompi/NobuRF && cd NobuRF && npm install
```

## Three ways in

| You want to | Run | Details |
| --- | --- | --- |
| Design an antenna from a request in words | `node scripts/design-mcp.mjs mcp --out <folder> [--gpu]` as an MCP server | below |
| Solve a board you already have (project JSON, Gerber, DXF, STEP) | `npm run noburf -- solve <project.json> [--gpu] [--mesh-check check]` | [docs/project-file.md](docs/project-file.md) |
| Analyze a differential pair from any four-port Touchstone file (NobuRF, another solver or a VNA) | `npm run noburf -- pair <file.s4p> --pair 1,2 --pair 3,4 [--zdiff 90] [--zcomm 30] [--at <GHz>]` | [docs/differential-pairs.md](docs/differential-pairs.md) |
| Run a whole design session headless, with a model you pick | `npm run design -- agent "<request>" --lane cerebras\|openrouter` | [docs/design-agent.md](docs/design-agent.md) |

## The design tools (MCP)

`scripts/design-mcp.mjs` is a stdio MCP server. Started with `--out <folder>`,
it begins with no design: your first call turns the request into one.

| Tool | What it does |
| --- | --- |
| `start_design` | the request as a goal and a board: target GHz, board width and length, substrate (FR-4 or RO4003C), thickness, S11 limit, and bandwidth or circular polarisation only when asked. Builds an edge-fed patch sized from textbook formulas and returns the brief, with a note when the textbook patch does not fit the board |
| `brief` | the goal, switchable features (inset, slot, stub, chamfer), every variable with its range, the solve budget |
| `try_design` | switch features, set values, one solve on the coarse search mesh |
| `sweep` | 2 to 8 values of one variable, solved in parallel |
| `optimise` | Nelder-Mead over 1 to 4 variables; the solver finds the numbers, you pick the strategy |
| `confirm` | the current design on the fine mesh: the result that counts |
| `finish` | your summary; ends the session |

The server writes `design.json` and `journal.jsonl` (every solve and tool call)
to the folder. `--solves N` and `--confirms N` set the budget, `--max-calls N`
caps tool calls (default 40), and `--closing-confirm` confirms your best
unconfirmed design when your client closes the server's input. With
`--inbox <file>`, lines the person appends to that file mid-run (see
`src/design/inbox.ts`) come back with your next tool result as `person_says`:
replan to follow them, calling `start_design` again if the goal changed.
Anything that can write that file speaks with the person's authority, so keep
it in a folder only they can write to.

Add it to an MCP client, for example:

```bash
claude mcp add noburf -- node "$PWD/scripts/design-mcp.mjs" mcp --out "$PWD/runs/my-antenna" --gpu
```

For OpenClaw, `npm run design -- agent` writes the config itself
(`openclaw.json5` in the run folder); `openclaw/design-agent.json5` is the
hand-written equivalent for a design file you already have.

## What to trust, and how to say it

Report what the tools return, with its limits. They are the honest part of
the result.

- **Only a `confirm` result counts.** The search mesh is coarse and can sit a
  percent or two off the fine mesh. A goal is met when a confirmed design
  meets it.
- **Mesh error bar:** `noburf solve --mesh-check check` solves on finer grids
  and reports how far the resonance and S11 could still move. It measures
  discretisation only, not port or material model error.
  See [docs/self-check.md](docs/self-check.md).
- **Validated range:** `noburf solve` also says whether the design's features
  (substrate, port, copper model, band) match benchmarks that agree with
  measurement. Today that is one-port, lumped-fed patches on low-permittivity
  substrates. Outside that range, say so.
- **Agreement with other solvers:** the demo patch's resonance agrees with
  openEMS within 1 % at the same resolution. The
  [validation report](docs/validation.md) lists what does not agree yet.
- Do not claim gain, efficiency or bandwidth the tools did not report, and do
  not describe the design as built or measured.

## Spend

`npm run design -- agent` and `agent-race` put every model call behind a local
proxy that holds the API key (OpenClaw is started with no keys in its
environment) and reserves each call's worst case before sending it: at most
$1 a run and $4 a provider, on a per-machine ledger
(`~/.noburf/spend.json`). An MCP client you run yourself calls its own model,
so those caps do not apply to it.
