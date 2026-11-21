# Which variables matter: the sensitivity study

A design has named variables with allowed ranges (patch length, feed width,
slot position). The sensitivity study answers "which of them moves the result
most, and by how much", from the solver, at the current design.

```bash
npm run design -- sensitivity my.design.json              # a design file, on its coarse search mesh
npm run design -- sensitivity my.design.json --fidelity confirm
npm run design -- sensitivity examples/patch-5g8-graded.json   # any one-port project, on its own mesh
#   [--variables patch_l,feed_w] [--rank f0_mhz|s11_target_db|zin_target_ohm|s11_min_db]
#   [--step-pct 2] [--target 5.8] [--gpu] [--workers N] [--out report.json]
```

The same study is the workbench's **Sensitivity** tab (Rank variables; a
coarse mesh by default, the project's mesh on request) and the design
agent's `sensitivity` tool, so a model can pick which variables to free
before it optimizes. It costs one solve for the design plus two per variable.

## Method

For each variable x with range [min, max] and step h, two extra solves give
the slope of every metric f, second order in h:

| Scheme | Points | Slope |
| --- | --- | --- |
| central | x − h, x + h | (f₊ − f₋) / 2h |
| forward (x − h outside the range) | x + h, x + 2h | (−3f₀ + 4f₁ − f₂) / 2h |
| backward (x + h outside) | x − h, x − 2h | mirror of forward |

A step that another variable's range refuses (an inset deeper than half
the patch it is cut into) counts as outside. A variable with no room for a
step either way is skipped and the report says why.

**Ranking.** The slope times the range is the change the variable can make
across its whole range if the response were linear. That is what the
ranking sorts on: a steep variable with no room to move matters less than a
gentle one with a wide range. A variable with no range in the project is
taken over its value ± 10 %, and the report says so.

**Step size.** 2 % of the range by default, never below the smallest
change the mesh resolves: the edge cell on a graded mesh (its lines follow
the copper edges), two cells on a uniform one (edges snap to cells, and a
size centered on the origin moves each edge by half its change). Below that
a staircased edge does not move at all and the slope reads 0 or a jump.

**Spread and grade.** Each slope comes with the spread of its two one-sided
slopes, |s₂ − s₁| / 2 (for central, s₁ = (f₀ − f₋)/h, s₂ = (f₊ − f₀)/h).
On a smooth, nearly linear response they agree and the spread is small. It
grows with curvature (it equals h|f″|/2), with a jump (a mesh line
appearing, the dip switching to another mode) and with solver noise. It is
an indicator, not an error bound: the central slope's own error, h²f‴/6, is
invisible to it, and noise gives a single draw of it. Each slope is graded:

| Grade | Rule | Read it as |
| --- | --- | --- |
| clean | spread ≤ 25 % of the slope | a slope |
| sign only | spread below the slope | the direction, not the size |
| unresolved | spread at or above the slope | nothing: the result turns, jumps or is flat within ±h |

The ranking puts clean slopes first, then sign-only, then unresolved, so a
jump within the step (which reads as a huge slope) never tops the list.

**Curved.** The change across the range is a straight-line estimate. When
the curvature the spread implies, |f″|·span²/8, exceeds a quarter of it,
the row is marked curved: the slope still holds near the design, the
across-range figure does not. When the grid's cell count differs between
the three solves, the report notes that the mesh changed with the step.

The solves report what the solver says. The slope inherits the solver's own
model error (port, materials, mesh): a coarse search mesh reads resonances a
percent or two low, and slopes on it are good for ranking, not for the last
digit. Run `--fidelity confirm` (or the project mesh in the workbench) for
numbers to quote.

## What it does not do

- **Interactions.** One variable at a time at one design: it does not see
  that inset depth matters only once the resonance is on frequency. A
  design-of-experiments or global (Sobol) study would; it costs many more
  solves.
- **Adjoint.** An adjoint FDTD solve gives the gradient with respect to
  every variable from two solves, whatever their number. Not implemented;
  it is the route for designs with tens of variables.
- **Several ports.** The metrics are one port's S11 and Z_in. The workbench
  refuses projects with more than one port.
- **Variables without a range.** A missing bound is taken at the value
  ± 10 %, and the row says so; ranking such a row against real ranges
  compares a guess with a design limit.

Slopes of a dB metric are slopes of the dB number, and |Z_in| and the dB
metrics are strongly nonlinear near a match. Across a whole range they
extrapolate a straight line through a curve (a dip does not deepen by 88 dB),
so read "across range" for ranking, and the slope for what a small change does.

## Validation

`scripts/validate/sensitivity_patch.ts` checks the study against the slope
the cavity model gives in closed form for a rectangular patch (Balanis,
Antenna Theory, 14.2): f = c / (2 (L + 2ΔL) √ε_eff), so df/dL = −f / (L + 2ΔL),
with ε_eff and ΔL functions of W only. The patch is Chang 1986's 45.5 × 30.5 mm
on ε_r 2.33, h 3.175 mm (graded mesh, a measured benchmark the solver
matches within 1.2 %, [validation.md](validation.md) section 7), with both
sizes unlocked to ± 20 %.

| Check | Solver | Reference | Off | Result |
| --- | --- | --- | --- | --- |
| 1. df/dL against the cavity model, −f₀/(L + 2ΔL) at the solver's f₀ | −83.3 ± 2.5 MHz/mm | −89.0 MHz/mm | −6.5 % (limit 10 %) | pass |
| 2. df/dL at the default step (0.40 mm) against twice it, both graded clean | −83.3 | −84.6 | 1.5 % (limit 3 %) | pass |
| 3. df/dL against a least-squares line through six solves at L ± 0.4, 1.2, 2.0 mm | −83.3 | −84.0 | 0.8 % (limit 3 %) | pass |
| 4. \|df/dW\| below \|df/dL\| / 3, same sign as the model | −5.1 ± 0.6 MHz/mm | −1.9 MHz/mm | | pass |

Fourteen minutes on four CPU cores (fifteen solves of 0.5 M cells), on
main with the graded-mesh copper-edge placement of #58. The run before that
change gave the same verdicts (−7.6, 1.0, 1.3 %).

**History of the criteria.** Checks 1 and 4 were written into the script
before its first run and not changed. An independent review after that run
found that the first version of check 3 (a line through five points over
± 2 steps) was algebraically 0.2 × check 2's first slope + 0.8 × its second,
so it added no evidence, and that check 2's tolerance widened as the spreads
grew. Both were replaced by the versions above, which are stricter, and the
whole script was run again; the first run had passed all four as well.

**What it shows.** The study measures the solver's own slope of the
resonance (step and six-point checks within 1.5 %), and that slope agrees
with the closed form within 6.5 %: the solver's patch behaves like a cavity
of the model's effective length to that accuracy. The cavity model is the
weaker reference here: on this electrically thick board (h/λ_d ≈ 0.05) its
fringing term is approximate.

**What it does not show.** Only df/dL of the resonance is validated
against an outside reference.

- The width check passed on ordering and sign only. The solver's df/dW is
  2.7 times the model's, whose W enters only through ε_eff and ΔL, the
  part of the formula least trusted on thick substrates. The gap is not
  evidence either way; a measured W series would settle it.
- The other metrics' slopes move more with the step (reported, not graded,
  in the data file): |Z_in| at 2.89 GHz reads −77.3 Ω/mm at the default
  step and −58.6 at twice it. The spread cannot see that third-order term;
  the step check below can, and puts the default step's error at about 8 %.
  S11 at the target moves 10 %, the dip depth 22 % (graded sign only).

**The step check** (`--check-step`, the agent tool's `check_step`, the
workbench's *Check the step*) repeats every variable at twice the step. Both
slopes are second order, d(h) = d + c h², so |d(h) − d(2h)| / 3 estimates
the error of d(h). A clean slope whose step error passes 25 % of it is
downgraded like one whose spread does. It doubles the cost.

The unit tests (tests/sensitivity.test.ts) check the formulas exactly: a
quadratic gives the exact slope by every scheme, a jump is graded
unresolved and a jump on a small trend sign only, the step check recovers
the exact error of a cubic, the step never drops below the mesh, a bound
forces a one-sided step, an unresolved jump never outranks a clean slope,
and a stand-in solver with resonance 68 / L GHz gives df/dL within 1 %.

## The Gonzaga open helix

The helix ([benchmarks/gonzaga.md](benchmarks/gonzaga.md)) is built by its
own script rather than a project file, so it has its own hook:

```bash
npx tsx scripts/validate/gonzaga_sensitivity.ts --cell 1.0 [--jobs 4] [--range pitch:9.5:14] [--variables pitch,radius]
```

Each point is one `gonzaga_helix.ts` process. The paper gives no ranges,
so each dimension is taken over its value ± 10 % and the report says so.
Steps are at least one cell of copper movement: a cell for the radius and
the arm width, and for the angles the angle that moves the arm's far end by
a cell (pitch 0.8°, wrap 2.4°). Solved points are cached under a hash of the
helix scripts and the engine, so a rerun of the same code reuses them.

Nine solves on the 1 mm mesh, 17 to 22 minutes each on one CPU core
(10,512 s in all, `point_solve_s` in the data), ranked by the
resonance (at 925 MHz here), each over value ± 10 %:

| Variable | Resonance | Axial ratio at 915 MHz | Dip depth | Azimuth gain |
| --- | --- | --- | --- | --- |
| wrap 170° | −5.4 MHz/° (−184 MHz) | −0.095 dB/° (−3.2 dB) | +0.31 dB/° | unresolved |
| radius 23.6 mm | −37.4 MHz/mm (−177 MHz) | −0.74 dB/mm (−3.5 dB) | +1.0 dB/mm | unresolved |
| pitch 10.5° | +4.9 MHz/° (+10 MHz) | +0.61 dB/° (+1.3 dB) | −4.4 dB/° | −0.02 dB/°, sign only |
| arm width 14.6 mm | −2.3 MHz/mm (−7 MHz) | +0.18 dB/mm (+0.5 dB) | −1.5 dB/mm | −0.01 dB/mm |

The radius and the wrap (circumference and arm length) set the frequency;
the pitch sets the polarisation and the match, with little effect on the
frequency; the arm width trims the match. That is the split of roles the
paper's optimization assumed. Gain barely moves with any of them.

Cross-check against solves the study did not make: the pitch sweep in
gonzaga.md (same mesh, pitch 10° and 11°) gives slopes of 0.61 dB/° in axial
ratio, 5 MHz/° in resonance (the table rounds to 1 MHz) and −4.6 dB/° in dip
depth. The study's 0.613 ± 0.022 dB/°, 4.9 ± 0.6 MHz/° and −4.4 ± 0.7 dB/°
agree. Every step changed the mesh (the staircased cylinder gains or loses
cells), and the wrap and radius resonance slopes are marked curved over
± 10 %.
