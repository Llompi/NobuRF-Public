# Race of 2026-11-22, 10:19 UTC

This is the run behind the AI design section of the website and the hackathon video. Both lanes got the same request:

> a 5.8 GHz patch on a 24 mm FR-4 board, then explain the final design and why each change helped in about 300 words

Both lanes used Kimi K3.1 Pro inside OpenClaw, on the same solver. The Cerebras lane ran first. The other lane, the
same model through OpenRouter, started after it finished. The goal was a resonance within 1 % of 5.8 GHz with S11
below −10 dB.

| File | What it holds |
| --- | --- |
| `*-summary.json` | the request, the goal, the best confirmed design and its metrics, timing, solve counts, tokens and cost |
| `*-model-calls.json` | every model request: start and end times, HTTP status, time to first token, tokens and, for Cerebras, the server's own timing |
| `*-best.project.json` | the final design as a NobuRF project file, ready to open in the workbench or solve with `npm run noburf -- solve` |
| `replay-*.json` | the S11 curve of every design the lane tried, as used for the replay and the video |

Where the site's numbers come from:

- **Designs tried:** `solves.search` in the summaries (28 and 20). Each lane also ran 3 fine-mesh confirm solves.
- **Final designs:** `best_confirmed.metrics`. Cerebras reached 5.831 GHz and −10.57 dB at 5.8 GHz. The other lane
  reached 5.816 GHz and −19.14 dB.
- **Model generation:** for each successful call, the end time minus the time to first token. The Cerebras lane made
  14 such calls, which add up to 7.5 s. The last one, the 843-token write-up, took 2.6 s, and the 13 design steps took
  4.8 s together. Before their first tokens, the calls also spent 44.9 s in total waiting in the server's queue
  (`timing.first_token_wait_s`).
- **Rate limits:** 45 Cerebras requests were refused with HTTP 429 during hackathon traffic. Waiting them out took
  646.9 s (10 min 47 s, `timing.rate_limit_wait_s`). The other lane had none and finished in 137 s.
