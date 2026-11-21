# NobuRF documentation

## Using NobuRF

- [Workbench guide](workbench.md): build or import a board, solve it in the browser, read the results.
- [Hosting](hosting.md): how the public site is built and served from Cloudflare Pages, and why traffic costs nothing.
- [Project file](project-file.md): the JSON format the workbench and the `noburf` command share, the
  `noburf solve` and `noburf import` commands, and what each output file holds.
- [De-embedding ports](deembedding.md): remove a lumped port and its feed line from the results, with a
  calibration kit NobuRF builds from the project.
- [Vias](vias.md): plated vias, via fences and antipads, how they are meshed, and how close they come
  to an exact two-post formula, and what a via at the end of a microstrip reads.
- [Differential pairs](differential-pairs.md): mixed-mode S-parameters, differential impedance and skew of
  paired ports, in the workbench, from a solve and from any Touchstone file (`noburf pair`).
- [AI-directed design](design-agent.md): `npm run design`, where a language model picks the design
  strategy and the solver and an optimiser find the numbers. Covers spend caps and the Cerebras race.
- [Which variables matter](sensitivity.md): `npm run design -- sensitivity`, the workbench's
  Sensitivity tab and the agent tool that rank a design's variables by their effect, with the method's limits.
- [Published benchmarks](../examples/benchmarks/README.md): project files for solved problems from
  the literature.

## How far to trust the results

- [Mesh check and validated range](self-check.md): the opt-in mesh-convergence error bar, physics checks and validated
  range every solve reports, and the published method behind them.
- [Validation report](validation.md): analytic checks, the patch against openEMS, textbook models,
  published measurements, and what still disagrees.
- [Kernel benchmarks](../bench/README.md): WGSL and CUDA kernel throughput.

## Working on NobuRF

- [Contributing](../CONTRIBUTING.md): setup, tests, the local CI script, the CLA.
- [Workbench states](workbench-states.md): the app's project, solve and import states, and which
  transitions are allowed.
- [Flow maps](flows/README.md): every screen and state of the original single-patch demo and the
  agent race.
- [OpenClaw setup](../openclaw/README.md): running the design tools from OpenClaw.
