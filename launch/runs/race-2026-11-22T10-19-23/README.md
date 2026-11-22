# Race of 2026-11-22, 10:19 UTC

This is the run behind the AI design section of the website and the hackathon video. Both runs got the same request:

> a 5.8 GHz patch on a 24 mm FR-4 board, then explain the final design and why each change helped in about 300 words

Both used Kimi K3.1 Pro inside OpenClaw, on the same solver: first on Cerebras (`moonshotai-kimi-k3.1-pro-trial`),
then, starting when that run ended, through OpenRouter (`moonshotai/kimi-k3.1-pro`, served by Parasail). The goal was
a resonance within 1 % of 5.8 GHz with S11 below −10 dB at 5.8 GHz.

| File | What it holds |
| --- | --- |
| `*-summary.json` | the request, the goal, the best confirmed design and its metrics, timing, solve counts, tokens and cost |
| `*-model-calls.json` | every model request: start and end times, HTTP status, time to first token, tokens and, for Cerebras, the server's own timing |
| `*-best.project.json` | the final design as a NobuRF project file, ready to open in the workbench or solve with `npm run noburf -- solve` |
| `replay-*.json` | the event stream the replay view and the video were built from, including S11 at 5.8 GHz after each solve it shows. Its `lobe_glb` paths point at files that aren't published here |

Where the site's numbers come from:

- **Designs tried:** `solves.search` in the summaries (28 and 20). Each run also made 3 confirm solves.
- **Final designs:** `best_confirmed.metrics`. Cerebras reached 5.831 GHz and −10.57 dB at 5.8 GHz
  (`s11_at_target_db`). OpenRouter reached 5.816 GHz and −19.14 dB.
- **Generation time:** for each successful call, the end time minus the time to first token. The Cerebras run had 14
  successful calls, which add up to 7.5 s (the server's own `completion_s` adds up to 7.3 s). The last call, the
  843-token write-up (368 of those tokens reasoning), took 2.6 s; the other 13 calls took 4.8 s together. Waiting for
  first tokens added 44.9 s (`timing.first_token_wait_s`): 33.1 s in the server's queue, the rest reading the prompt.
- **Refused requests:** the Cerebras server refused 45 requests with HTTP 429 (`queue_exceeded`, "high traffic").
  Waiting them out took 646.9 s, or 10 min 47 s (`timing.rate_limit_wait_s`). OpenRouter refused none.
- **Run time:** `timing.wall_s`, 834 s for Cerebras and 137 s for OpenRouter. Neither includes the 84.9 s harness
  startup.
