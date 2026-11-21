# AI-directed design

`npm run design` lets a language model design an antenna on the headless
solver. The model chooses the strategy: which features to switch on, which
variables to free, what to aim for, when to check on the fine mesh and when
to stop. A Nelder-Mead optimiser and the FDTD solver find the numbers. The
model never draws copper and never writes geometry; it works through five
tools on a parametric design file whose ranges the user sets.

```bash
# A design request: target frequency and board size (the X-post format).
npm run design -- new --target 5.8 --board 20x20 --out my.design.json
# Let a model drive it. scripted = fixed rules, no network, no spend.
npm run design -- run my.design.json --model scripted
# You (or another agent) in the model's seat: type one tool call per line.
npm run design -- run my.design.json --model manual
npm run design -- run my.design.json --model cerebras --gpu     # CEREBRAS_API_KEY
npm run design -- run my.design.json --model openrouter --gpu   # OPENROUTER_API_KEY
# The same tools as an MCP server, for OpenClaw (see openclaw/design-agent.json5).
node scripts/design-mcp.mjs mcp my.design.json --gpu
```

`new` options: `--s11 <dB>` (default −10), `--bandwidth <MHz>` (the −10 dB
band around the target must be at least this wide), `--axial-ratio <dB>`
(circular polarisation: boresight axial ratio at the target at most this),
`--substrate name:eps_r:h_mm` (default `FR-4:4.4:1.6`).

`run` options: `--solves N` search-mesh solves for the session (default 60),
`--confirms N` fine-mesh solves (default 3), `--turns N` model turns (16),
`--workers N` CPU solver threads (one per core), `--effort low|medium|high|max`
(reasoning effort, default low), `--run-cap USD` (default 0.50).

## The goal and the finish line

The goal is met when S11 at the target is at or below the limit (−10 dB) and
the deepest point of the dip is within 1 % of the target, plus the bandwidth
and axial-ratio limits when given. One score, 0 exactly when the goal is met:

    score = max(0, S11(target) − limit)                    dB
          + 3 × max(0, |f0 − target| / target − 1 %)        3 dB per % off
          + 10 × bandwidth shortfall / required bandwidth   (when asked)
          + max(0, axial ratio − limit)                     dB (when asked)

The frequency term gives the optimiser a slope when the dip is far from the
target and S11 there is flat. f0 is the deepest point of the band that holds
the target when S11 there meets the limit (so a deeper second mode elsewhere
does not count), otherwise the deepest dip in the band, never a band edge. It
is interpolated between frequency samples. Each solve reports f0, S11 at the target, the
minimum S11, the −10 dB bandwidth around the target and, with an axial-ratio
goal, the boresight axial ratio and its sense (RHCP or LHCP, IEEE).

## The design file

`new` writes a design file: the goal, a project (an edge-fed rectangular
patch on a two-layer board, sized from the textbook formulas and clamped to
the board), the switchable features, and a coarser search mesh.

| Feature | Shapes | Variables (minimum) | Use |
| --- | --- | --- | --- |
| `inset` | two notches beside the feed | `inset_d` (0.5 mm), `inset_gap` (0.5 mm) | match |
| `slot` | transverse slot across the patch | `slot_l` (2 mm), `slot_w` (0.5 mm), `slot_y` | lower the resonance of a patch that cannot grow |
| `stub` | open shunt stub on the feed line | `stub_l` (1 mm), `stub_w` (0.5 mm), `stub_d` | match without cutting the patch |
| `chamfer` | two opposite corners cut at 45° | `chamfer` (0.5 mm) | circular polarisation |

Base variables: `patch_w`, `patch_l`, `feed_w`. The board size is locked.
Every range is an ordinary project range (`min`, `max`, which may name other
variables, e.g. `slot_l` at most `patch_w - 2 mm`), so a user narrows the
search or locks a dimension by editing the project in the design file. A
point outside a range is refused by the project, never solved.

### Tuning your own project

A project built in the workbench (or imported) becomes a design file with
`new --from`:

```bash
npm run design -- new --target 5.8 --from my-project.json --out my.design.json
```

The tuner may change exactly the project's unlocked length variables, each
within its own `min` and `max`; there are no switchable features. `new --from`
refuses what it would otherwise guess or tune by accident: a variable that is
unlocked but lacks a `min` or a `max` (set both, or lock it), one computed
from other variables (lock it so it follows them), one that sets the mesh, the
stackup or the board outline, one nothing uses, a project with nothing to
tune, more than one port, a target outside the analysed band, and an
axial-ratio goal without `outputs.far_field_ghz`. The search runs on the
project's own mesh with a 30 dB energy stop (or the project's, if lower): a
coarser mesh would round each dielectric to a different number of cells and
search a different board.

In the workbench, a variable the tuner may change but that misses a limit
shows "no min" or "no max" in the tree. A plain rectangle (drawn, or imported
from Gerber, DXF or STEP) gets **Make editable** in its inspector: variables
for its size along x and y (`<shape>_dx`, `<shape>_dy`, no limits until you
set them). Along each axis you choose what stays put when it is resized: the
low edge, the middle or the high edge, held by a new locked variable
(`<shape>_x`, `<shape>_y`). The default, Auto, looks at what touches the
rectangle on the same layer: the edges of other copper (cuts and a duplicate
lying on top do not count) and ports (on the upper of their two layers only,
so a ground plane never follows a port).

- Both edges along an axis touch something, like a feed line running from its
  port to its patch: each edge is written as what it touches and that size is
  not tuned, so the line stays on both and follows them if they are editable.
- One edge touches: it stays put, written as the other copper's or the port's
  expression when that uses variables (so it follows), else held by a locked
  variable. A port inside the rectangle keeps the nearer edge, and the log
  warns that a large change can leave the port off the copper.
- Nothing touches: the low edge, and the log says so.

Make a patch editable before its feed so the feed follows the patch. Copper
made editable earlier that touches this rectangle does not follow it, and an
edge that overlaps into other copper instead of meeting its edge is not
detected: this is attachment, not a constraint solver.

The design file format is general: any project works, with a `features` map
naming each feature's shapes and variables. A switched-off feature's shapes
are removed before the solve and its ranges are not checked, so they never
fence in the base variables they name (the stub's position range depends on
`patch_l`). Its variables cannot be swept or freed until it is switched on.

Every cut that opens a patch edge (the inset notches, the chamfers) reaches
0.5 mm past that edge. With the inset off, the feed ends at the patch edge; the
part carried into the inset is the inset's own shape.

## Two meshes

The optimiser searches on a coarse graded mesh (about λ0/26 in the open,
λ0/100 at copper edges, three substrate cells, −30 dB energy stop); `confirm`
solves on the project's own mesh (twice as fine, six substrate cells, −50 dB).
A coarse graded mesh reads a percent or two low (docs/validation.md, 3.1). The
model is told so and is expected to aim the next search off the measured
offset: aim = target × search f0 / confirmed f0.

On the CPU reference solver a search solve takes about 15 s for a 5.8 GHz
patch and solves run in parallel on worker threads (sweeps, the first simplex).
With `--gpu` they run one at a time on the WebGPU kernels.

## Tools

| Tool | What it does |
| --- | --- |
| `brief` | goal, features, variables with resolved ranges, budget (also the opening message) |
| `try_design` | switch features, set values, one search solve |
| `sweep` | 2 to 8 values of one variable, in parallel; does not move the design |
| `optimise` | Nelder-Mead over 1 to 4 free variables from the current design; the best point becomes the current design. `aim_ghz` (inside the analysed band) / `aim_s11_db` replace the goal for this search only: S11, bandwidth and the dip are all measured at the aim. Reports variables that ended at a bound. |
| `sensitivity` | ranks the live variables by how far each one's range moves the resonance, S11 and \|Z_in\| at the target and the dip depth: two extra search solves per variable, central differences, each slope with its spread ([sensitivity.md](sensitivity.md)); does not move the design |
| `confirm` | the current design on the fine mesh |
| `finish` | the model's summary; ends the session |

Errors (unknown variable, refused range, budget spent) come back as tool
results so the model can correct itself.

## Output

`run` writes `<design>.runs/<lane>-<time>/`:

- `journal.jsonl`: every model call (time, tokens, cost, tool calls) and every solve (point, metrics, score).
- `summary.json`: how it ended, the best confirmed design, and the time split:
  wall time = model time + tool (solver) time. This split is the with-vs-without
  Cerebras comparison: the solver part is the same on both lanes.
- `best.project.json`: the final design as a normal project (`npm run noburf -- solve` it).
- `design.json`: the design file with the final values, to continue from.

## The race: with and without Cerebras

```bash
npm run design -- race my.design.json --lanes cerebras,openrouter --gpu
npm run design -- replay <run folder> <run folder>     # from runs already made (left, right)
```

`race` runs the two lanes on the same design, one after the other, each a
normal `run` with its own spend guard and run cap, then writes two replay logs
for the race view (`launch/race-replay/index.html`) and prints the URL to
open with the repo root served. The lanes run one after the other so they get
the same solver with no contention; each lane's clock starts at its own start.
Same task, tools, solver, budget and reasoning effort: the difference between
the lanes is where the model runs.

The view plots S11 at the target for the best design so far (search and
confirm solves alike, by goal score), marks each model turn and the call it
made, shows tokens per second per turn, and ends on the best confirmed design.
A lane counts as having met the goal only when a fine-mesh confirm meets all of
it (frequency, S11, and bandwidth or axial ratio when asked), and the task line
names every part. Tokens per second leave out rate-limit waits; the lane's
clock keeps them, since that is time the lane really lost, and each log
records the total (`rate_limit_wait_s`). An OpenRouter lane is labelled by the
hosts that answered its calls, never assumed to be a GPU host; without
`OPENROUTER_PROVIDERS` OpenRouter picks the fastest host per call. Both lanes'
keys are checked before either runs.
Until Kimi is live on Cerebras, the Cerebras lane runs `CEREBRAS_MODEL`
(gpt-oss-120b) and its label says so; for a like-for-like race set
`CEREBRAS_MODEL` to Kimi and pin the OpenRouter host with
`OPENROUTER_PROVIDERS`.

## Models and spend

| `--model` | Endpoint | Model | Key |
| --- | --- | --- | --- |
| `scripted` | none | fixed rules: inset first, a slot when the length runs out, aim off the confirm offset | none |
| `manual` | none | whoever types on stdin: `name {json}` per line, e.g. `optimise {"free":["patch_l"],"max_solves":12}` | none |
| `cerebras` | api.cerebras.ai | `CEREBRAS_MODEL`, default `gpt-oss-120b` until Kimi K3.1 Pro is live (`moonshotai-kimi-k3.1-pro-trial`) | `CEREBRAS_API_KEY` |
| `openrouter` | openrouter.ai | `OPENROUTER_MODEL`, default `moonshotai/kimi-k3.1-pro`; `OPENROUTER_PROVIDERS` pins hosts | `OPENROUTER_API_KEY` |

Keys come from the environment or `.env`, never the command line. Reasoning
is replayed on every turn, as Cerebras requires for Kimi.

Every call goes through a spend guard, `src/design/spend.ts`:

- Before sending, the call's worst case is charged to the ledger
  `~/.noburf/spend.json`, under a lock file, so two runs on one machine cannot
  spend the same headroom. The worst case is the whole prompt at 2 characters
  per token plus the full completion budget: 1024 tokens at `--effort low`
  (the default), 2048 at medium, 4096 at high or max. The charge is
  refused when it would pass the run cap (`--run-cap`, default $0.50) or the
  provider's lifetime cap (`NOBURF_PROVIDER_CAP_USD`, default $4).
- After the call the charge is corrected to the actual cost: OpenRouter's
  reported cost, else usage × price, else the worst case.
- An HTTP error answer is released (not billed). A call lost after sending
  (connection reset, unreadable body, the 3 minute timeout) keeps its worst
  case.
- Prices default to $0.35 / $0.75 per million for gpt-oss-120b and a
  conservative $3 / $12 for any other model (Kimi included, until its price
  is published). Override them with `NOBURF_PRICE_IN` / `NOBURF_PRICE_OUT`. A
  malformed price, a negative one or a corrupt ledger stops the run; it is
  never read as free.

Because each call reserves its worst case first, a run stops once what it has
spent plus the next call's worst case would pass the run cap. Set the cap to
the expected cost of the run plus one call's worst case (for Kimi at the
conservative $3 / $12 price and low effort, about $0.02 to $0.03 as the prompt
grows; under $0.01 for gpt-oss-120b). On Nov 19 a real Kimi call cost about
$0.009, but the old 4096-token reservation ($0.06 a call) stopped every Kimi
run at a $0.09 cap after 2 to 4 turns. `run` refuses a cap below three
calls' worst case and prints the per-call reservation when it starts.

No setting can raise the caps past $1 a run or $4 a provider, and a price
override can only raise a price: 0 or anything below the built-in price is
refused. On OpenRouter every request carries `provider.max_price` at the
guard's prices, so a dearer host or model is refused by OpenRouter rather than
billed past the reservation. A gateway error (502, 504) keeps its worst case,
since the generation behind it may have run; a reported cost below tokens ×
price is not trusted.

The ledger is per machine and only sees spend through `npm run design`. A
second laptop, a fresh container, OpenClaw or any other script on the same key
starts at $0 here. The provider-side limit (the $5 credit with auto-recharge
off, the OpenRouter key's own limit) is the real stop.

**OpenClaw runs are not guarded.** With `openclaw/design-agent.json5`,
OpenClaw calls the provider itself and the spend guard never sees those calls.
Use `npm run design -- run` for live runs until the guard sits in front of
OpenClaw as a proxy. Never give OpenClaw the Cerebras key that holds the
hackathon credit; use a key with a small provider-side limit of its own. The
MCP server refuses every call after `finish` and after 40 tool calls
(`--max-calls`).

## The closing confirm

When the strategist stops (finish, turn limit, no tool call, spend cap, model
error; not a solver crash) without a confirmed design that meets the goal,
`design run` confirms one more design, if a confirm solve is left: the result
of the last `optimise` when it aimed off the target (`aim_ghz`, the measured
mesh offset) and was never confirmed, else the best search design that was
never confirmed. The
MCP server does not; there the client decides when to stop. A
model that spends the whole search budget and stops still gets its best design
checked. `summary.json` reports it as `closing_confirm`, apart from the model's
own confirms, and its time counts as tool time.

Until the first confirm, about one search's worth of search solves (8 of 60)
is held back: a strategist that spends freely can still re-aim once after the
fine mesh disagrees. The brief and every refusal say how many are held.

A model that answers in text instead of a tool call is told how much budget is
left and asked to act; the third text reply in a row ends the loop with
`no_tool_call`, keeping that text as the summary. By default every request
sends `tool_choice: "required"`, so every reply is a tool call (`finish` is
one): gpt-oss-120b drifted into text replies with `auto`, and Cerebras accepts
`required`. `NOBURF_TOOL_CHOICE=auto` turns it off. Both lanes of a race send
the same value.

## When something fails

A rate limit (HTTP 429) or a server error (5xx) is retried up to five times,
waiting as long as the provider asks (`Retry-After`, else Cerebras' per-minute
`x-ratelimit-reset-*` headers, else 2, 4, 8 … s), never more than 60 s at a
time. A spent daily quota ends the run at once. Each call's `finish_reason`,
retries and wait go into the journal, and `summary.json` reports the total
wait (`rate_limit_wait_s`) apart from model time, so a slow provider and a
slow model can be told apart.

A tool mistake (an unknown variable, a refused range, a spent budget, arguments
that are not a JSON object) goes back to the model as a tool result. A model
error (HTTP error after retries, the spend cap, no message) or a solver crash
ends the loop with `ended` set to `model_error`, `spend_cap` or `tool_error`.
The outputs are still written, including every confirmed design so far.
