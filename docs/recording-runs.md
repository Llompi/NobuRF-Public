# Recording OpenClaw runs

`npm run record` wraps the two OpenClaw commands, `design agent` and `design agent-race`, without changing them.
It shows the run in the terminal as usual and also:

- records the terminal as an asciinema v2 file (`terminal.cast`, in the race or run folder). The first lines name
  the OpenClaw version and the exact command, and OpenClaw's tool calls (`noburf__start_design`,
  `noburf__optimise`, ...) are shown in bold blue, so the recording makes clear that OpenClaw drives the run;
- adds one line per lane to `runs/ledger.jsonl`: lane, model, hosts that answered, request, result, wall time,
  model time and its split (below), solver time, turns, tokens, cost, the command and the recording;
- rewrites `runs/ledger.md`: every run, then each race with the Cerebras lane beside the other lane.

## Queue time versus the model's own time

A slow queue says nothing about how fast the model generates, so each model call is split three ways:

- **Wait**: from sending the call to its first streamed token. This is the provider's queue, reading the prompt and
  the network. During the Nov 21 overload this was 37 to 101 s per call on Cerebras.
- **Generation**: from the first streamed token to the last, timed on this machine by the relay. Tokens per second
  use this time only, so they leave every queue out. Replies that arrive in one burst (under 50 ms) are left out of
  tokens per second, not counted as instant.
- **Server**: the provider's own figures. Cerebras sends `time_info` (queue, prompt and completion seconds) with each
  reply, and the relay keeps it. The GPU host sends none, so its column reads n/a.

Wall time is still reported as measured, queue included, beside the generation figures. The race table shows both
speed-ups: generation (queue left out) and wall (queue kept in).

```
npm run record -- agent-race "a 5.8 GHz patch on a 24 mm FR-4 board" --gpu
npm run record -- agent "a 2.4 GHz patch under 40 mm" --lane cerebras --gpu
npm run record -- report
```

Every option after the command goes to `design` unchanged, and keys stay where `design` reads them (the environment
or `.env`). Runs made with `--upstream` (a local stand-in model) are labeled "stand-in model, not a result" in the
ledger and the report.

## Turning a recording into video

`asciinema play runs/agent/race-<time>/terminal.cast` replays it in a terminal. For the video,
[agg](https://github.com/asciinema/agg) renders it to a GIF, and ffmpeg turns that into an MP4:

```
agg --font-size 20 --speed 1 terminal.cast terminal.gif
ffmpeg -i terminal.gif -movflags faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" terminal.mp4
```

Keep `--speed 1` for any clip that shows timing: a sped-up clip must say so on screen.
