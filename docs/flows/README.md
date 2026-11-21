# Flow maps

Every screen and state of NobuRF on one canvas: the main path runs left to right, and each edge case hangs off the screen it leaves from. Five flows:

- **Workbench** (`#workbench`): start an antenna from a template, a blank board you draw on, or a Gerber, DXF or STEP import; solve it; read every result tab.
- **Solve engine** (`#solve`): what one solve goes through behind the progress bar, and each way it ends early, with the message the page prints.
- **Sentence race, one lane** (`#agent-race`): `design agent-race` from PR #57, from the sentence to the replay files, with the spend cap, rate limits, start-up and deadline kills.
- **Bridge demo page** and **Knob-tuning race** (`#solver`, `#race`): the Nov 19 maps of `index.html` and the first race. Kept for the record; the workbench replaced that page as the app.

![Workbench flow map](exports/workbench.png)

## Open it

```bash
npx serve docs/flows      # then open the printed URL, e.g. http://localhost:3000/#solver
```

It needs a web server because it loads `flows.json`. Links go straight to a screen: `#race/4b` opens "Solve timed out".

Drag or scroll to move. Hold Control or Command and scroll (or pinch) to zoom. Keys: `+` and `-` zoom, `0` fits the map, arrows pan, Escape closes the details panel. Tab moves through the screens; Enter opens one.

## Reading the map

- Numbers are the main path (`1`, `2`, `3`). Letters are branches off that screen (`3a`, `3b`), nearest first.
- Branches above the main path are alternate routes that still work. Branches below are slow, rejected or failed states.
- Line style says the kind of branch: solid for the main path and alternates, long dashes for slow, short dashes for errors and rejections. Colour repeats it but is never the only cue; every line also has a label.
- A dashed empty frame is a state that exists in the code but has no screenshot yet ("Not captured yet"), or one that does not exist at all ("Not built yet").
- A dark text frame is a state with no screen of its own, such as a terminal or a worker: it shows the line the terminal or page prints.
- **Finding** marks a problem the map turned up. The details panel says what is wrong and what to change.

## What the maps turned up

Nov 21 walkthrough of the workbench (all fixed in the same change unless marked open):

| Screen | Finding |
| --- | --- |
| Workbench 2b, 4c | Drawn shapes snapped only to the 0.1 mm grid. A feed drawn 0.1 mm short of the patch made a 0.1 mm cell that set the time step for the whole solve. Edges now line up with nearby copper. |
| Workbench 2d | The STEP import asked for body names without showing any. It now lists the bodies by height. |
| Workbench 2e | A project file chosen in Import failed with a Gerber syntax error. It now says to use Open. |
| Workbench 2f | Copper imported at KiCad page coordinates landed off a new board without a word. A warning now says so. |
| Workbench 6b | "Solve with cuts" stopped a running solve. It is disabled while anything runs. |
| Workbench 6c | Recording a video held the Stop button, and a solve landing mid-recording swapped the field. |
| Workbench 7 | Open: the polar plots and their labels are small at 1440×900. |
| Solve 1b | Open: the small-cell warning does not say which two edges are close. |
| Solve 3d | "neighbours" (UK spelling) in the divergence message. |

Nov 19 maps of the bridge page and the first race:

| Screen | Finding |
| --- | --- |
| Solver 4a | When a solve takes longer than 15 s, the bridge returns 504 and never commits the edit, but the page still logs it. The next edit lands on the old design. |
| Solver 6a | An edit finer than the 0.5 mm grid changes nothing. The agent is told (`no_voxel_change`); the page adds a log row with the same number and no warning. |
| Solver 7a | A second tab takes over the bridge. The first tab then says "bridge offline", which is wrong. |
| Solver 1a | In local mode, Apply and Reset still call the bridge and fail with "Unexpected end of JSON input". |
| Solver 1b, 3a | The no-WebGPU and bad-JSON messages sit in a small status line far from the problem and give no next step. |
| Solver 1c | A lost GPU device is only logged to the console; the page keeps saying "solving". |
| Race 3a, 3b | Nobody has seen what a lane does on a 429, and nothing stops a race on spend. |

## Data

`flows.json` is the only input. Each flow has `nodes` and `edges`, following the flow-map view spec:

| Field | Meaning |
| --- | --- |
| `id` | `3` for a main-path screen, `3a` for a branch off it. The id decides the position. |
| `place` | `"above"` for an alternate route. Branches go below by default. |
| `state_type` | One of `state_vocabulary`: happy, empty, loading, pending, needs_approval, rejected, error, slow, offline, paused, failed, success. |
| `status` | `captured` (needs `screen`), `log` (needs `log`, the text shown in place of a screen), `not_captured` or `not_built`. |
| `summary`, `finding`, `code_ref` | What the screen shows, what is wrong with it, and where it lives in the code. |
| edge `label`, `trigger_kind`, `condition` | The transition as people read it, what fires it (user_action, system_event, timer, agent_decision) and when. |

The page checks the file before drawing: unknown states, missing screens, dangling edges and edges that skip a column stop it with a list of problems.

## Updating

1. Capture the screen at 1440×900 and save it as WebP in `screens/`.
2. Add or edit the node and its edge in `flows.json`.
3. Re-render the PNGs: `node docs/flows/export.mjs` (uses the repo's Playwright dev dependency).

The current screens were captured in headless Chromium with SwiftShader, a software GPU, so the solve times on screen read 38 to 58 s. The race screens come from the offline rehearsal (`npm run race`), with a scripted model at simulated speeds.
