# Live AI co-design: findings (Nov 20, 2026)

A test of whether a fast model (Cerebras) can earn its keep by reviewing every
solve of an antenna search as it happens, and steering a classical optimiser.
The work is parked: the project moved to a different Cerebras demo. This note
records what was measured, what is kept, and what is experimental.

## Question

Can a model that answers in well under a second change the outcome of a
design search, compared with the same optimiser running alone or with a slow
model? If not, the Cerebras speed is not the thing that matters here.

## Measurements

Laptop GPU (GTX 1660 Ti), 16 × 16 mm board, 5.8 GHz inset-fed patch, goal
S11 at most −10 dB within 1 %. One run of each, so read these as indications,
not statistics.

| Setup | Fine-mesh result | Notes |
|---|---|---|
| Optimiser alone (scripted strategist) | −5.7 dB, missed | |
| Rules watcher, instant | −8.2 dB, missed | |
| Rules watcher, slowed to 8 s per answer | −7.4 dB, missed | stands in for a slow GPU-hosted model |
| gpt-oss-120b watcher on Cerebras | −7.7 dB, missed | |
| Kimi K3.1 watcher on OpenRouter | −9.8 dB at 5.762 GHz, missed | stopped by its spend cap at 33 of 60 solves |
| Kimi strategist (Nov 19, no watcher) | −12.7 dB, met | for reference |

Latency:

- Search solve on the laptop GPU: about 2 s.
- Cerebras gpt-oss-120b: 0.27 s to first token, 0.44 s whole answer. This key
  allows 5 requests a minute, so a real run waits about a minute between calls.
- OpenRouter Kimi (Nebius): 0.4 s first token, about 1.2 s typical, 5.7 s worst.

Offline check on the run logs (not code in the repo):

- A Gaussian-process surrogate fitted to the solves predicts f0 with a median
  error of 24 MHz near existing data.
- Replaying expected-improvement picks over the logged pool reached Kimi's best
  design in 11 solves instead of 29. The pool limits what it could pick, so this
  suggests, it does not prove, that a surrogate inner loop needs 2 to 3 times
  fewer solves.
- The coarse search mesh reads S11 1.68 dB better than the fine confirm mesh
  (sd 0.29 dB, same sign every time). The f0 offset has no consistent sign.
  This optimism is why every run above missed.

## Verdict

Per-solve review beats the optimiser alone, but at 2 s solves a 0.4 s model and
a 1.2 s model reach the same answers: the model is not the bottleneck, so
Cerebras speed does not show. Where speed would show is inside a running solve
(decide before it finishes) and in keeping pace with a person giving
instructions. Both work mechanically. With a 5-requests-a-minute key, neither
could be shown live on Cerebras.

## What is kept and works

- **Mesh gap per run** (`DesignSession.meshGap()`): measured from every
  confirmed design that was also solved on the search mesh, never assumed. The
  watcher sees it as `mesh_gap`, and a redirect can set `aim_ghz` and
  `aim_s11_db` to aim past it. This is the fix for the misses above.
- **Live frames from a running GPU solve**: the engine's opt-in `portHistory`
  hook reads the port signal at each energy check; `portSpectrum` on the
  partial signal gives an early f0 and S11. An `AbortSignal` stops the solve,
  and the stopped solve returns its newest frame, marked `stopped_early`. On
  lavapipe the early f0 matched the finished solve to 1 MHz once the field had
  rung down 10 dB.
- **Early stop without a model** (`EarlyStopRule`): two agreeing frames past
  10 dB decay with f0 more than 4 % off the target.
- **Person in the loop**: requests typed into the live view reach the model on
  its next call (`user_says`), "Stop this solve" ends the running solve, and
  "End run" stops and confirms the best design.
- **Bug fixes** that apply beyond co-design: console lines lost during GPU
  solves (`print` writes to stdout directly), a redirect loop when the search
  budget was spent, a redirect that silently dropped features after a search
  with no usable solve, and fail-fast when every solve of a search fails.

## Experimental, off unless asked for

- `npm run design -- codesign <file>` (the watcher loop). Nothing else
  calls it. The latency probe used for the numbers above was removed when
  this merged: it was a second request path to keep under the spend rules.
- The live view page, `codesign.html` (`?ws=PORT` live from `--serve`,
  `?journal=PATH` to play back a run).

## Not done

- The surrogate inner loop replacing Nelder-Mead.
- Re-solving stopped designs in full to measure how often an early stop was
  right.
- The model benchmark matrix (rules, gpt-oss, qwen, Kimi, Opus). It was costed
  at about $0.90 and not run.
