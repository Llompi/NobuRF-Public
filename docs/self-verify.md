# Self-verification suite

The half-cell copper edge offset fixed in #58 went unnoticed for days because openEMS, the reference we compared against, had the same error. This suite checks the solver against things that do not depend on any other program: exact answers, conservation laws and symmetries. It runs from `npm run selfverify`, and from `scripts/ci_local.sh` as a report-only step when `CI_SELFVERIFY=1` is set. It is not a merge gate yet: main fails it until the solver findings below are fixed.

```
npm run selfverify                       # quick tier, seed = current commit
npm run selfverify -- --tier full        # more cases, finer levels (laptop GPU machine or overnight)
npm run selfverify -- --seed abc --only stripline
```

## Rules

These exist so the suite cannot quietly become a list of things the solver already does.

1. Tests and tolerances are written and committed before the suite is run against the solver. The first commit of `scripts/selfverify/` was made before any solve.
2. Every tolerance comes from theory or from the solver's own convergence band, with the derivation next to it in `scripts/selfverify/tolerances.ts`. A tolerance changes only with an entry under "Tolerance changes" below giving the new derivation. "The case failed" is not a derivation.
3. Cases are random draws from parameter ranges a user might pick, seeded by the commit under test. Each commit gets new cases, so nothing can be fitted to a fixed set. Any run can be repeated with `--seed`.
4. This suite does not change the solver. A failure gets a diagnosis and goes to whoever owns the solver. A solver fix must pass the whole suite and the textbook exam, not just the case that failed.
5. A change to the harness after it has seen solver output (a probe in the wrong place, a crash) goes under "Harness changes" with the reason, and must not touch a tolerance or a verdict rule.
6. "inconclusive" is not a pass. The report lists each one with its reason.

## Families

| Family | Truth | Catches | Cannot catch |
|---|---|---|---|
| `pec-box` | Exact eigenfrequencies of the Yee scheme in a PEC box of one dielectric (Taflove eq. 4.47), random sizes, cells and permittivity | Kernel errors: wrong Courant scaling, wrong eps in the update, a sign or index error in the curl | Anything on graded meshes, copper, ports (uniform box only) |
| `conserved-energy` | Leapfrog conserves a discrete energy exactly when the E curl is the transpose of the H curl under the cell-volume weights (taken from the mesh lines, not from the solver's scale factors). Random boards in a closed lossless box, random graded meshes, random initial fields | Graded-mesh scale factors or PEC edges applied inconsistently; index or transposition errors in the update loops; instability (a blow-up is a fail) | A wrong material average (each edge's eps is read back from the solver's own coefficient); errors that keep the operator symmetric, such as copper drawn in the wrong place (the edge offset of #58 is one) |
| `stripline` | Cohn's exact Z0 for a zero-thickness strip between two grounds; the 1D Yee dispersion for beta (the discrete scheme's TEM mode is exact in a uniform fill); Z0 unchanged by translation, mirroring and scaling with the mesh | Sheet-edge placement (any first-order error at copper edges shows as observed order near 1 and a miss of the closed form); mesher asymmetries; unit handling | Microstrip-specific effects (air-dielectric interface), ports (the measurement uses its own field probes), losses |
| `two-port` | Passive S, lossless and lossy, in open space (PML); S21 = S12; S unchanged by mirroring, 90 degree rotation, sub-cell translation, scaling with the mesh, and port relabelling | Port and S-matrix code, CPML gain, spurious loss or gain, rasteriser asymmetries (rounding toward one side), absolute-coordinate dependence | Errors common to both runs of a symmetry pair; errors that keep S unitary and reciprocal (geometry in the wrong place) |

Two kinds of comparison, never mixed:

- Against an exact answer: the closed form, or a law that holds exactly in the discrete scheme.
- Against the solver itself under a transformation. The transformed mesh must map line for line onto the original (if it does not, the mesher fails the check); the two runs are then the same discrete problem and may differ only by roundoff. A self-comparison cannot detect an error both runs share, which is why every family that uses one also has an exact check. The table above says what each one is blind to.

Every run uses the commit's own seed plus the fixed regression seeds in `run.ts` (cases that once exposed a defect; never removed). The run exits non-zero unless every check passes, inconclusive included. `tests/selfverify_frozen.test.ts` pins the hashes of `tolerances.ts` and `measure.ts`, so changing a tolerance or a verdict rule fails the unit tests until the hash is updated alongside an entry below.

## Why this would have caught #58

The edge offset adds a first-order term, c h, to every quantity that depends on where a copper edge is. The stripline family refines the mesh and fits the order of the error against Cohn's exact Z0. With the offset the order is near 1; the threshold is 1.5, halfway between "a first-order term remains" and the formal 2. This is the check that carries the weight.

The second check, Richardson extrapolation at order 2 against Cohn, is weaker than first claimed. For pure first-order data it misses by r/(r+1) of the finest error against a band of 1.25/(r+1), so it fails for refinement ratios above 1.25. But for data of local order p it fails only when (r^p - 1)/(r^2 - 1) < 0.444: p below 1.03 at r = 4/3 and below 1.09 at r = 1.5, and any h^2 term of the same sign widens the band. The reviewer found that the first quick tier (levels 1, 1.5, 2) passed it on pre-#58 data. The quick tier now uses levels 1, 2, 3 (finest ratio 1.5). Neither check needs openEMS. Results below.

## Results

Full reports are in [docs/self-verify/](self-verify/). Same seed (`stripline-study-1`, three random striplines, four refinement levels each) on both commits.

**Before #58 (4a881fc): caught.** All three striplines fail both edge checks. The Z0 error falls at order 0.81 to 0.87 (needs at least 1.5), and the order-2 extrapolation misses Cohn's exact Z0 by 0.7 to 0.9 ohm against bands of 0.43 to 0.66 ohm. At the coarsest level Z0 is 6.6 to 9.2 % low, the signature of strip edges drawn wider than they are.

**Current main (0858537): much better, not clean.** #58 cuts the coarse-level error to 1.4 to 1.7 % low, but:

- The order is still below 1.5 in all three cases (0.63, 1.39, and one non-monotone case). The remaining error shrinks more slowly than first order in case 0 (0.59, 0.46, 0.39, 0.29 ohm). A first-order-like term is left at the strip edges after the correction.
- In case 1 the correction switches itself off at the finest level (edge lines back on the drawn edges) and Z0 jumps down by 0.3 ohm, so a finer mesh gives a worse answer.
- In the first quick run (seed `c600010`) the correction never applied: 4 z cells per half-thickness made the z cells at the strip 0.49 edge cells, outside the 0.8 to 1.2 window, so the edges stayed drawn and the error was first order (0.94), the pre-#58 behaviour. Any user who sets more dielectric cells than the edge cell allows gets the old error with no warning.
- Case 2 (eps_r 1.82, b 1.63 mm): the beta check fails on both commits, an error near 1e-3 that does not fall with refinement. Not yet diagnosed; it may be the harness (the gate or a higher-order mode in the band) rather than the solver.

These go to the solver owners as findings. The suite does not change the solver.

**Second run, after the review fixes** (seed `review-round-2` plus the regression seeds, quick tier, levels 1/2/3; reports `quick-*-round2.md`). Before #58: every stripline fails the order check (0.86 to 0.94) and the Cohn extrapolation, and the mirror check fails because that build's mesher does not follow a mirrored strip. On main: the same three striplines still fail order (0.63 to 0.95) and extrapolation, with the coarse-level error down from 5 to 9 % to 1 to 3 %. Both commits fail the 90 degree rotation (mesh not symmetric between x and y) and the beta check on the `c600010` stripline (band-mean error -2.5e-4 against 1.2e-4; a single-frequency ripple of 1.7e-3, still to be traced in the harness).

Other families on main: the Yee cavity eigenfrequencies match to 6e-6 or better, the conserved energy drifts 9e-9 over 2000 steps on random graded boards (bound 2.7e-5), two-port passivity and reciprocity pass lossless and lossy, and S is unchanged to 4e-6 under mirror, sub-cell translation, scaling and port relabelling. Rotating a board by 90 degrees does not give a rotated mesh, so that check fails: the mesher is not symmetric between x and y. (The first two-port report, `two-port-quick-main.md`, predates harness change 7 and still shows it as inconclusive.)

## Tolerance changes

After the independent adversarial review (Nov 20), before the second run:

1. `roundoffError`: 100 u sqrt(n) to 10 u sqrt(n). The factor 100 was not derived; 10 counts the roundings per value per step (a six-term curl, plus CPML and loss). Tighter, not looser.
2. `MIN_MODE_SEPARATION_BINS`: 8 to 16, and the `PEAK_BIAS_BINS` derivation rewritten. The reviewer measured 0.047 bin of bias at 8 bins with a 30x neighbour, 95 % of the 0.05 allowance, not the 1/20 the old text claimed. At 16 bins it is about 0.006. The pec-box record length doubled to keep testable modes.
3. `MAX_NEIGHBOUR_RATIO` and `MIN_USEFUL_DECAY_DB` moved into `tolerances.ts` with their reasons (values unchanged).

## Harness changes

All after the first quick run on main (seed `c600010...`, report kept in the PR description).

1. `random_board.ts`: two-layer boards gave the second dielectric its own eps_r, and rasterise rejects a lumped port spanning dielectrics of different eps_r. The second layer now uses the core's material. Seen as a crash before any physics result came back.
2. `run.ts`: a family that crashes is reported as a failed check instead of aborting the whole run.
3. `two-port`: the closed lossless box did not ring down (24.7 dB after 40,000 steps: box modes barely coupled to the ports), so its power-balance equality could never be judged. The lossless board now sits in open space (PML) and gets the passivity and reciprocity checks like the lossy one. Energy conservation is covered directly by `conserved-energy`. The symmetry checks no longer wait on the ring-down (each pair runs the same fixed number of steps, so truncation cancels).
4. `stripline`: the soft source also launches a wave toward the near end of the line, and its echo arrived inside the measurement gate. The source now sits half a pulse length from the near end and the gate closes before either echo. No tolerance changed.
5. (Reverted by 6.) `stripline`, beta check: it claimed the 1D Yee dispersion was an exact discrete truth for the line. That was wrong. After fix 4 the beta error fell with refinement (1.7e-3, 6.3e-4, 3.3e-4 over three levels, order about 2.3): the discrete cross-section gives L'C' = eps mu only to O(h^2). The check is now the same form as the Z0 check: Richardson extrapolation of the error must reach 0 within its convergence band. The tolerance terms are the existing ones (GCI 1.25, extraction, roundoff).
6. After the adversarial review: change 5 was a verdict-rule change made after seeing output, on a wrong claim. The discrete scheme does have an exact TEM mode in a uniform fill (E_t the discrete gradient of a discrete static potential), and the reviewer showed the beta error alternates sign across the band, which is contamination, not an L'C' offset. The beta check is back to an exact check, now on the band-mean signed error; the ripple is reported and is a harness problem to find.
7. Also from the review: a NaN or infinite result is a fail (it was "inconclusive", which hid exactly the blow-ups the energy family exists to catch); the run exits non-zero on any inconclusive; mirror, translation, rotation and scaling must reproduce the mesh or fail (a non-mapping mesh used to fall back to a loose band or to inconclusive); "Z0 under scaling without the mesh" is removed (its band was built from the run it was judging); scaling checks now also compare the y lines; the energy weights come from the mesh lines in float64, not from the solver's scale factors; regression seeds added.
8. Change 3 removed the only equality law in two-port (unitary S) in favour of an inequality (passivity). Recorded here as the verdict-rule change it is. A closed box needs a ring-down the CPU cannot afford; the equality should come back on the GPU tier.

## Open items from the review

- Results on main still fail the stripline order check: a residual edge error of 0.065 to 0.09 cell per edge, more than the 0.03 cell rasterise documents.
- `truncationError` ignores how long a resonance rings compared with the pulse; it may be too tight on resonant boards.
- About 2 in 120 random boards crash rasterise ("port not on copper"); a crash counts as a fail.
- Only the CPU reference runs; the WebGPU kernels users run are not covered yet.
