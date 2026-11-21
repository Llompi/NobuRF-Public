# Contributing to NobuRF

Bug reports, validation cases and pull requests are all welcome.

## Before you start

For anything larger than a small fix, open an issue first so we can agree on the approach. Changes to the solver
should come with a check against a reference, either an analytic result or openEMS, the way the
[validation report](docs/validation.md) does it.

## Set up

You need Node 20 or later. A GPU is optional: `npm test` runs on the CPU, and the GPU tests skip or use a
software driver.

```bash
npm install
npm run dev:web        # Vite on :5173; open /workbench.html in Chrome or Edge
npm run dev            # Vite plus the tool bridge on :8787, for the demo page and the agent
```

## Tests

```bash
npm run typecheck
SKIP_SLOW=1 npm test   # about 30 s; without SKIP_SLOW, 8 slow solver tests also run
npm run test:gpu:node  # every WGSL kernel against the CPU reference, through Dawn
```

Without a GPU, set `VK_ICD_FILENAMES` to a software Vulkan driver such as lavapipe for the GPU tests.
The [README](README.md#tests) lists every test command.

`scripts/ci_local.sh <branch>` runs what the GitHub test workflow runs, on your branch merged into
`origin/main`, in a throwaway worktree. It writes a Markdown summary you can paste into the pull request.

## Pull requests

- Keep one change per pull request, with tests for it.
- Say what you checked by hand. For the workbench, that means the flow you changed, in a browser, with
  a screenshot.
- Solver changes: show the result against a reference before and after.

## Contributor License Agreement

NobuRF is licensed under the [GNU AGPL-3.0](LICENSE). Before your first pull request can be merged, you need to
sign the [Contributor License Agreement](CLA.md). A bot comments on your pull request with a sentence to paste
back; that comment is your signature, and it covers all your later pull requests too.

The CLA lets the project owner keep NobuRF under one license holder, so it can change the license or offer other
terms in the future. You keep the copyright in your work.

## Code style

- Simple first. Solve the problem in front of you, not one that might come later.
- Fail loudly. No empty `catch` blocks and no silent fallbacks to default values.
- Use descriptive names, even when they are long.
- Remove code that is no longer used rather than leaving it in.
