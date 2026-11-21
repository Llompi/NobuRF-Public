# The textbook exam

Fourteen worked examples from Pozar's *Microwave Engineering* and Balanis's
*Antenna Theory*, each built as a NobuRF project file, solved with
`noburf solve`, and graded against the book. The question is how far a
student gets with NobuRF as the only electromagnetic tool.

**Short version.** On the exam's default mesh the 34 graded rows come out
13 pass, 7 close, 10 fail and 4 inconclusive on main at `0858537`. The first
run, on `a70eeb5`, scored 11 pass, 5 close, 14 fail and 4 inconclusive; the
only change between the two expected to affect these projects is PR #58,
which places graded-mesh grid lines inside the copper edges
([before and after](#before-and-after-the-sheet-edge-fix)). Other merges in
between touched the engine (copper loss, lumped R, L and C and more), but
these projects are PEC and mostly lossless; the monopole and waveguide,
which have no strip edges on a graded mesh, reproduce to the last digit, and
the mesh signatures are unchanged. Main has since gained #61, #63, #66 and
#67; the exam pins `0858537`, and a later rerun would pick those up.
Every metric is the one fixed before the first full run; see
[grading changes after the run](#grading-changes-after-the-first-run).

- Pass: the transmission-line and stub problems. These are the Z0 and 90°
  length of Ex. 3.7's line (50.1 Ω, 90.8°), the single-stub tuner
  (|Γ| = 0.013 at 2 GHz), the quarter-wave open-stub notch (−0.7 %), the
  quarter-wave transformer, the branch-line coupler's 90° phase, and the
  half-wave dipole's resonant length, directivity and beamwidth.
- Close: Ex. 3.7's εe (+1.6 % against Pozar's eq. 3.195), the
  transformers' ripple (worst |Γ| 0.078 and 0.080 against 0.05 across the
  book's band) and the Chebyshev's band centre (−3.6 %), the coupler's
  through arm (−3.5 dB), and the patch directivity on both grounds.
- Fail on both meshes: the branch-line coupler (nulls 7.8 to 7.9 % high)
  and the stepped-impedance filter (cutoff 10 to 13 % low, though it still
  meets the 20 dB requirement). The binomial's band centre fails on the
  default mesh (−5.0 %) and is close on the refined one (−4.7 %); the
  Chebyshev's centre passes on the refined mesh.
- Fail, solved on one mesh only: the λ/2 resonator, the dipole impedance at
  exactly λ/2, and the monopole's impedance at λ/4 and its resonant height.
  In each, the book's model leaves something out: junctions, open ends,
  wire radius, the coupling gaps. No independent solver run exists yet to
  split the gap between the book and NobuRF.
- Inconclusive: the stripline and the rectangular waveguide. Their solves
  never rang down.
- Cannot be posed: anything that needs lumped R, L or C, vias, non-planar
  metal, ferrites, dispersive materials or a multi-port far field (list
  below).

NobuRF gives textbook answers for planar microstrip lines and stubs on its
default graded mesh, provided the ports are de-embedded. The exam needed
external scripts for that.


## Grading changes after the first run

The scorecard was computed with the solver on main at `0858537`; each
`result.json` records that commit. Their `tracked_files_modified` flag is
set because the old result files and two far-field project files in this
exam's own folders were being rewritten during the run. The solver source
(`src/`, `scripts/noburf.ts`) was unmodified, and this branch does not
change it.

The metrics, tolerances and references in `exam.py`, `theory.py` and
`scorecard.py` are the ones merged with the first scorecard. One piece of
the frozen measurement code did change, after the solves had finished:
`network.py` now takes the sign of each de-embedding error box from an ideal
line of half the thru's phase. The old rule followed continuity and flipped
the box above 3 to 4.4 GHz on four of the five calibration kits. A flip
cancels unless two ports use different kits, and no graded row reads a
quantity where it does not cancel, so regrading with the old and the new
`network.py` gives an identical `grades.json`.

The grading code was revised after the first full run had been seen. A
metric picked after the results can be picked to pass, so the scorecard
counts only the metrics fixed before that run. The later ones appear as
extra rows marked "chosen after the run, not counted".

| Problem | Metric before the run (counted) | Metric after the run (not counted) | Effect (first run, `a70eeb5`) |
| --- | --- | --- | --- |
| Ex. 5.5 quarter-wave | Centre of the band where \|Γ\| ≤ 2Γm around f0 | Midway between the outermost \|Γ\| minima | Would turn close (−2.4 %) into pass (−1.7 %). On the rerun both metrics pass. An earlier version of this scorecard counted the later metric here by mistake |
| Ex. 5.6 binomial, Ex. 5.7 Chebyshev | Centre of the band where \|Γ\| ≤ 2Γm around f0 | Midway between the outermost \|Γ\| minima | Would turn binomial fail into pass and Chebyshev fail into close. On the rerun the later metric is worse for the binomial (−18 %). It also suits a binomial design poorly: the book's answer is one null at f0, and NobuRF has two |
| Ex. 8.6 stepped filter | First −3 dB crossing of \|S21\| | −3 dB below the passband level, removing the dielectric loss the ideal reference lacks | Fail either way (−10.7 % against −8.1 %) |
| Ex. 3.5 stripline | Pass (εe) and close (Z0) | Inconclusive | Graded down, not up: the longer line's solve never rang down (0 dB decay; the shorter one reached 24 to 26 dB), so its numbers are not a converged answer. The original grades are in the git history |

## The rules

- **NobuRF solves every field.** Each structure is a project file in
  [`examples/textbook/`](../examples/textbook/), solved by `noburf solve`
  as a user would run it.
- **The network arithmetic is scripted.** Putting a load impedance on a
  port, removing the feed lines, and reading a bandwidth off a curve are in
  [`scripts/textbook_exam/network.py`](../scripts/textbook_exam/network.py).
  This is Pozar ch. 4 algebra, not EM.
- **Reference values are recomputed from the book's formulas** in
  [`theory.py`](../scripts/textbook_exam/theory.py). Where an example prints
  its numbers, the recomputation matches them: Ex. 3.7's W = 3.91 mm,
  εe = 1.87 and 21.9 mm; Ex. 5.5's 29 %; Ex. 5.6's 91.7 / 70.7 / 54.5 Ω and
  70 %; Ex. 5.7's 101 %; the dipole's 73 + j42.5 Ω and 2.15 dBi. Some rows
  have no printed answer, and the reference column then holds a derived
  value:
  - the stepped filter's cutoff is that of the same sections as ideal
    lines;
  - the patch directivity is Balanis's two-slot cavity model, integrated
    numerically;
  - the resonant lengths are the midpoint of the range Balanis quotes for
    thin wires.

  The notes beside each row say which kind of reference it is.
- **Structures are drawn as the book designs them.** Widths come from
  Pozar's synthesis (eq. 3.197) and lengths from its εe (eq. 3.195). Stubs
  and arms are drawn as specified, with no open-end or junction correction
  unless the book makes one.
- **The default mesh for the microstrip circuits** was fixed before any
  result was seen. It is graded, with 0.2 mm cells at copper edges, 4 cells
  across the substrate, a 1 mm largest cell, an 8-cell CPML and a 50 dB
  energy stop. The antennas, the waveguide and the stripline need their
  own meshes, which are given in their project files. The four circuits
  that failed were solved again with the edge cell halved and 8 substrate
  cells (largest cell unchanged); these are the "refined mesh" rows.
- **Grades.**
  - Frequencies and lengths: pass within 2 %, close within 5 %. Tighter for
    quantities a textbook pins down exactly: microstrip εe and line phase
    1 % and 3 %, the WR-90 cutoff 1 % and 3 %, stripline εe 0.5 % and 2 %.
  - Impedances: pass within 5 %, close within 10 %; line Z0 within 2 % and
    5 %.
  - Directivity 0.2 and 0.5 dB (dipole), 0.5 and 1 dB (patch); beamwidth
    3 % and 6 %; the coupler's 90° phase 3° and 8°.
  - Levels in dB, |Γ| and phases are graded in absolute units, and each row
    states its tolerance.

### Why the circuits are de-embedded

A NobuRF lumped port is a 50 Ω source in one vertical column of cells. At
the end of a microstrip line, that column is a discontinuity of its own. On
the 3.9 mm line of Ex. 3.7, a plain 20 mm thru reflects |S11| = 0.10 at
3 GHz and 0.40 at 5 GHz, so a raw circuit would mostly measure its ports.

Every port therefore sits at the end of a 10 mm feed line, and a thru-line
calibration removes the feed and the port together. This is Engen and
Hoer's TRL, with the mirror symmetry of the thru standing in for the
reflect standard. Each line impedance gets its own kit: a 20 mm thru and
two lines 12 and 48 mm longer. At each frequency the line whose phase is
nearest 90° is used.

TRL cannot measure the line's impedance, only refer results to it. The
impedance is taken from the line in the low-frequency limit, where the
port's parasitics vanish, and that same limit is the exam's measurement of
Z0. The two-line method gives the propagation constant exactly whatever the
ports do, and that is how εe is measured.

## Scorecard

| Problem | Quantity | Reference | NobuRF | Error | Verdict |
| --- | --- | --- | --- | --- | --- |
| Pozar Ex. 3.7 | eps_eff of the 50 ohm line (W = 3.91 mm) | 1.871 | 1.902 | +1.6 % | Close |
| Pozar Ex. 3.7 | Phase of the 21.9 mm line at 2.5 GHz | 90 deg | 90.78 deg | +0.9 % | Pass |
| Pozar Ex. 3.7 | Characteristic impedance | 50 ohm | 50.12 ohm | +0.2 % | Pass |
| Pozar Ex. 3.5 | eps_eff (TEM: equals eps_r) | 2.2 | 2.175 | -1.1 % | Inconclusive |
| Pozar Ex. 3.5 | Characteristic impedance | 50 ohm | 53.2 ohm | +6.4 % | Inconclusive |
| Pozar §3.3 (WR-90, TE10) | TE10 cutoff frequency | 6.557 GHz | 6.928 GHz | +5.7 % | Inconclusive |
| Pozar §3.3 (WR-90, TE10) | Guide wavelength at 10 GHz | 39.71 mm | 42.45 mm | +6.9 % | Inconclusive |
| Pozar Ex. 5.5 | Centre of the matched band (\|Gamma\| <= 0.4) | 3 GHz | 2.942 GHz | -1.9 % | Pass |
| Pozar Ex. 5.5 | Centre, midway between the outermost \|Gamma\| minima (chosen after the run, not counted) | 3 GHz | 2.95 GHz | -1.7 % | Pass |
| Pozar Ex. 5.5 | Worst \|Gamma\| over the book's band (29 %, 2.56 to 3.44 GHz) | 0.2 | 0.211 | +0.01 | Pass |
| Pozar Ex. 5.6 | Centre of the matched band (\|Gamma\| <= 0.1) | 3 GHz | 2.849 GHz | -5.0 % | Fail |
| Pozar Ex. 5.6 | Centre, midway between the outermost \|Gamma\| minima (chosen after the run, not counted) | 3 GHz | 2.45 GHz | -18.3 % | Fail |
| Pozar Ex. 5.6 | Worst \|Gamma\| over the book's band (71 %, 1.93 to 4.07 GHz) | 0.05 | 0.078 | +0.03 | Close |
| Pozar Ex. 5.7 | Centre of the matched band (\|Gamma\| <= 0.1) | 3 GHz | 2.891 GHz | -3.6 % | Close |
| Pozar Ex. 5.7 | Centre, midway between the outermost \|Gamma\| minima (chosen after the run, not counted) | 3 GHz | 2.875 GHz | -4.2 % | Close |
| Pozar Ex. 5.7 | Worst \|Gamma\| over the book's band (101 %, 1.49 to 4.51 GHz) | 0.05 | 0.08 | +0.03 | Close |
| Pozar Ex. 5.2 | Frequency of best match | 2 GHz | 2.001 GHz | +0.0 % | Pass |
| Pozar Ex. 5.2 | \|Gamma\| at 2 GHz | 0 | 0.013 | +0.01 | Pass |
| Pozar §3.8, §8.5 | S21 null of a lambda/4 open stub | 2.5 GHz | 2.483 GHz | -0.7 % | Pass |
| Pozar Ex. 6.2 | Resonant frequency | 5 GHz | 4.558 GHz | -8.8 % | Fail |
| Pozar Ex. 8.6 | -3 dB cutoff | 2.419 GHz | 2.177 GHz | -10.0 % | Fail |
| Pozar Ex. 8.6 | Attenuation at 4 GHz (book: at least 20 dB) | 20 dB | 25.86 dB | +5.86 dB | Pass |
| Pozar Ex. 8.6 | -3 dB cutoff from the passband level (chosen after the run, not counted) | 2.419 GHz | 2.237 GHz | -7.5 % | Fail |
| Pozar §7.5 | Isolation (S41) null | 3 GHz | 3.236 GHz | +7.9 % | Fail |
| Pozar §7.5 | Input match (S11) null | 3 GHz | 3.234 GHz | +7.8 % | Fail |
| Pozar §7.5 | Through \|S21\| at 3 GHz | -3.01 dB | -3.541 dB | -0.53 dB | Close |
| Pozar §7.5 | Coupled \|S31\| at 3 GHz | -3.01 dB | -2.895 dB | +0.12 dB | Pass |
| Pozar §7.5 | Phase of S21 relative to S31 at 3 GHz | 90 deg | 89.45 deg | -0.55 deg | Pass |
| Pozar Ex. 5.6 (refined mesh) | Centre of the matched band (\|Gamma\| <= 0.1) | 3 GHz | 2.858 GHz | -4.7 % | Close |
| Pozar Ex. 5.6 (refined mesh) | Centre, midway between the outermost \|Gamma\| minima (chosen after the run, not counted) | 3 GHz | 3.4 GHz | +13.3 % | Fail |
| Pozar Ex. 5.6 (refined mesh) | Worst \|Gamma\| over the book's band (71 %, 1.93 to 4.07 GHz) | 0.05 | 0.085 | +0.03 | Close |
| Pozar Ex. 5.7 (refined mesh) | Centre of the matched band (\|Gamma\| <= 0.1) | 3 GHz | 2.948 GHz | -1.7 % | Pass |
| Pozar Ex. 5.7 (refined mesh) | Centre, midway between the outermost \|Gamma\| minima (chosen after the run, not counted) | 3 GHz | 2.95 GHz | -1.7 % | Pass |
| Pozar Ex. 5.7 (refined mesh) | Worst \|Gamma\| over the book's band (101 %, 1.49 to 4.51 GHz) | 0.05 | 0.064 | +0.01 | Close |
| Pozar §7.5 (refined mesh) | Isolation (S41) null | 3 GHz | 3.238 GHz | +7.9 % | Fail |
| Pozar §7.5 (refined mesh) | Input match (S11) null | 3 GHz | 3.236 GHz | +7.9 % | Fail |
| Pozar §7.5 (refined mesh) | Through \|S21\| at 3 GHz | -3.01 dB | -3.525 dB | -0.51 dB | Close |
| Pozar §7.5 (refined mesh) | Coupled \|S31\| at 3 GHz | -3.01 dB | -2.905 dB | +0.11 dB | Pass |
| Pozar §7.5 (refined mesh) | Phase of S21 relative to S31 at 3 GHz | 90 deg | 89.34 deg | -0.66 deg | Pass |
| Pozar Ex. 8.6 (refined mesh) | -3 dB cutoff | 2.419 GHz | 2.094 GHz | -13.4 % | Fail |
| Pozar Ex. 8.6 (refined mesh) | Attenuation at 4 GHz (book: at least 20 dB) | 20 dB | 27.77 dB | +7.77 dB | Pass |
| Pozar Ex. 8.6 (refined mesh) | -3 dB cutoff from the passband level (chosen after the run, not counted) | 2.419 GHz | 2.151 GHz | -11.1 % | Fail |
| Balanis §4.6, §8.5 | R_in at L = lambda/2 | 73.08 ohm | 89.27 ohm | +22.2 % | Fail |
| Balanis §4.6, §8.5 | X_in at L = lambda/2 | 42.52 ohm | 49.32 ohm | +16.0 % | Fail |
| Balanis §4.6, §8.5 | Resonant length L/lambda (X = 0) | 0.475 | 0.473 | -0.4 % | Pass |
| Balanis §4.6, §8.5 | Directivity | 2.151 dBi | 2.233 dBi | +0.08 dBi | Pass |
| Balanis §4.6, §8.5 | Half-power beamwidth (E-plane) | 78.08 deg | 76.55 deg | -1.9 % | Pass |
| Balanis §4.7.4 | R_in at h = lambda/4 | 36.54 ohm | 57.95 ohm | +58.6 % | Fail |
| Balanis §4.7.4 | X_in at h = lambda/4 | 21.26 ohm | 32.23 ohm | +51.6 % | Fail |
| Balanis §4.7.4 | Resonant height h/lambda (X = 0) | 0.237 | 0.221 | -6.9 % | Fail |
| Balanis Ex. 14.1, §14.2.3 | Directivity, benchmark file's 31.8 x 29 mm ground | 7.077 dBi | 8.059 dBi | +0.98 dBi | Close |
| Balanis Ex. 14.1, §14.2.3 | Directivity, 120 mm ground | 7.077 dBi | 7.704 dBi | +0.63 dBi | Close |

On the default mesh, with the refined-mesh rows and the four rows marked "chosen after the run" left out: 13 pass, 7 close, 10 fail and 4 inconclusive.

Each row's data is in
[`docs/textbook-exam/results/grades.json`](textbook-exam/results/grades.json).
Each solve's `result.json` sits beside it, with provenance, steps, energy
decay and the solver's warnings, along with its Touchstone file. Three
cases had solves that stopped short of 50 dB, and the results above already account for
them:

| Solve | Energy decay | How the result handles it |
| --- | --- | --- |
| Stripline | 0 dB (long line), 24 dB (short line) | Graded inconclusive |
| Waveguide | about 23 dB | Graded inconclusive |
| Refined branch-line coupler | 40.2 dB | Agrees with the default-mesh run, which reached 50 dB |

The monopole was set to stop at 40 dB.

## What the results say

**Line constants.** The two-line method reads εe = 1.902 on Ex. 3.7's
line, 1.6 % above Pozar's eq. 3.195 and 1.1 % above Hammerstad–Jensen, so
the 21.9 mm line comes out at 90.8° instead of 90°. Against the static
Hammerstad–Jensen value the excess is:

| Line | εe, 1 to 4 GHz mean | Hammerstad–Jensen (static) | Excess |
| --- | --- | --- | --- |
| Ex. 3.7, 50 Ω on εr 2.2 | 1.902 | 1.881 | +1.1 % |
| 50 Ω on RO4003C | 2.816 | 2.787 | +1.0 % |
| 100 Ω on RO4003C | 2.558 | 2.554 | +0.2 % |

Most of it is in the comparison rather than the solver. For Ex. 3.7 a 2D
breakdown (backend thread, PR #58) gives about +0.5 % for dispersion (the
measured value is a 1 to 4 GHz mean, the formula is static), +0.27 % for the
finite 16 mm board, +0.2 % for the grid and +0.1 % for the error of the
Hammerstad–Jensen formula. Those add up to about +1.1 %, the whole excess
within the precision of each estimate, though each was estimated separately
rather than in one solve. A stripline
run, where εe must equal εr, was meant to check the dielectric on its own.
It did not ring down: the two ground sheets stop one cell short of the PEC
box, so they are not tied together. It needs vias.

**Z0.** Lines drawn with Pozar's widths should be 50 and 100 Ω;
Hammerstad–Jensen agrees with Pozar's synthesis to 0.2 %.

| Line | Default mesh | Edge cell halved | On `a70eeb5` (default, halved) |
| --- | --- | --- | --- |
| Ex. 3.7, 50 Ω | 50.1 Ω | not run | 48.9 Ω |
| 50 Ω on RO4003C (1.82 mm) | 49.6 Ω | 49.8 Ω | 47.5, 48.7 Ω |
| 100 Ω on RO4003C (0.46 mm) | 99.9 Ω | 99.1 Ω | 89.7, 93.9 Ω |

On `a70eeb5`, Z0 read 5 to 10 % low and converged at first order with the
edge cell, because a grid line on the drawn edge of a zero-thickness strip
makes it behave as if it were wider. With grid lines a third of a cell
inside the copper, both meshes are within 1 %.

**Matching networks.**

- The quarter-wave transformer passes: its band is centred 1.9 % low, and
  across the book's 29 % band its worst |Γ| is 0.21, slightly over the 0.20
  limit. The exam's absolute tolerance (pass within 0.05) is symmetric, so
  this row passes although the one-sided spec is exceeded by 0.01.
- The stub tuner matches the 60 − j80 Ω load to |Γ| = 0.013 at 2 GHz, as
  the book says it should. The load is held at 60 − j80 Ω at every
  frequency, so only the 2 GHz rows are the book's problem. The λ/4 open
  stub's notch lands 0.7 % below the ideal value and 1.2 % above the value
  with Hammerstad's open-end correction.
- The three-section transformers are close. At 3 GHz |Γ| is about 0.02, but
  the matched band sits low: the band with |Γ| ≤ 0.1 is centred 5.0 %
  (binomial) and 3.6 % (Chebyshev) below 3 GHz, and the worst |Γ| across the
  book's band is 0.078 and 0.080 against 0.05. The binomial has two shallow
  minima, at 2.0 and 2.9 GHz, where the book has one null at 3 GHz. On the
  refined mesh the Chebyshev is centred within 1.7 % (worst |Γ| 0.064) and
  the binomial stays about the same (−4.7 %, 0.085). With Z0 now right, what
  is left is likely the three impedance steps, which the book's circuit does
  not have, plus the εe excess (about −0.5 % in frequency). No solve
  separates those yet.

**The branch-line coupler misses on both meshes.** Its arms are λ/4 centre
to centre, as Pozar's ideal circuit has them, but NobuRF puts the isolation
and match nulls at 3.235 GHz, 7.8 % above the design frequency. The split is
−3.5 / −2.9 dB, an imbalance of 0.6 dB, while the 90° phase is right to
0.6°. Halving the edge cell moves the nulls to 3.237 GHz, and PR #58 moved
them by under 0.005 GHz, so neither resolution nor the strip-edge error is the
cause. The book's circuit has no junctions; the real coupler has
four T-junctions, which is why practical designs adjust the arm lengths.
Whether 7.8 % is the right size for that effect needs an independent solver
on the same geometry. NobuRF's run of Sheen's measured coupler
(validation.md §7.5) has well-defined nulls only with SMA edge ports: there it
lands 0.8 to 3.2 % below the measurement, while lumped ports give a flat
floor instead of nulls.

**Resonators and filters.**

- The λ/2 Teflon resonator (Ex. 6.2) resonates at 4.56 GHz, 8.8 % below the
  book's 5 GHz. The book's length ignores the open ends; with Hammerstad's
  end correction the expected value is 4.68 GHz. NobuRF is 2.5 % below
  that, and the 1 mm coupling gaps and the εe excess both push the
  resonance lower.
- The stepped-impedance low-pass filter (Ex. 8.6) is solved with the
  book's FR-4 (tan δ 0.02, about 0.5 dB through the filter). Its −3 dB
  point is at 2.18 GHz on the default mesh and 2.09 GHz on the refined one,
  10.0 and 13.4 % below the reference. Measured 3 dB below its own passband
  level instead (a metric chosen after the run, not counted) it is 2.24 and
  2.15 GHz. The same sections treated
  as ideal lines give 2.42 GHz, and the design target is 2.5 GHz. Its 20 Ω
  sections are 11.3 mm wide and 2.1 to 7.8 mm long, wider than they are
  long, and the ideal-line model gives them no end fringing. The filter
  still meets the requirement the example starts from: 26 to 28 dB at 4 GHz,
  against 20 dB.

**Antennas.**

- The half-wave dipole is two flat strips on two layers, joined by a
  one-cell port at the centre. Its pattern is right: 2.23 dBi against
  2.15 dBi, and a 76.6° beamwidth against 78°.
  - It resonates at L = 0.473 λ, inside Balanis's 0.47 to 0.48 λ, with
    R = 72.7 Ω there.
  - At exactly λ/2 it reads 89 + j49 Ω, against the induced-EMF
    73 + j42.5 Ω. Balanis quotes that value, but it assumes a sinusoidal
    current on an infinitely thin wire.
  - NobuRF's R rises from 71 to 89 Ω across the 6 % between resonance and
    λ/2, so a grade taken there is very sensitive to small length effects.
- The quarter-wave monopole is the pin of an SMA probe, rising 25 mm
  through air to a 2 × 2 mm pad over a 3 λ ground with the SMA's 4.1 mm bore
  at its base. Its R at resonance is 34.6 Ω, against image theory's half of
  the dipole's 72.7 Ω. It resonates at h = 0.221 λ, 7 % below the thin-wire
  0.2375 λ. The pin is thick (radius 0.006 λ), and that and the pad both
  lower the resonance.
- The patch of Balanis Ex. 14.1 radiates 8.1 dBi on the 31.8 × 29 mm ground
  used by the existing benchmark file, and 7.7 dBi on a 120 mm ground. The
  two-slot cavity model, integrated numerically at NobuRF's resonance
  (9.43 GHz; it was 9.28 GHz on `a70eeb5`), gives 7.1 dBi. The example
  does not specify a ground plane.

**The waveguide could not be answered.** It is air-filled WR-90 between
two probe ports, with PEC side walls and PML ends.

- The field never rang down: 23 dB in 150,000 steps.
- The probes reflect |S11| ≈ 0.9.
- The two solves are not consistent with a lossless line.

A waveguide needs a mode port and a boundary that absorbs a guided mode
near cutoff, and NobuRF has neither.

## Before and after the sheet-edge fix

The first run used main at `a70eeb5`. The rerun used main at `0858537`,
after PR #58, which places graded-mesh grid lines about a third of a cell
inside each copper edge, a rule derived from the grid rather than fitted to
these lines. Every solve was redone; grading and references did not change.
Counted rows on the default mesh whose verdict moved:

| Row | `a70eeb5` | `0858537` |
| --- | --- | --- |
| Ex. 3.7 line Z0 | 48.9 Ω, close | 50.1 Ω, pass |
| Ex. 5.5 centre of the matched band | 2.928 GHz, close | 2.942 GHz, pass |
| Ex. 5.6 worst \|Γ\| over the band | 0.101, fail | 0.078, close |
| Ex. 5.7 centre of the matched band | 2.19 GHz, fail | 2.89 GHz, close |
| Ex. 5.7 worst \|Γ\| over the band | 0.101, fail | 0.080, close |
| Ex. 14.1 patch directivity, benchmark ground | 8.02 dBi, fail | 8.06 dBi against a 7.08 dBi model, close |

The patch row moved because the model is evaluated at NobuRF's resonance,
which rose 1.6 %; NobuRF's own directivity barely changed. The refined
binomial went the other way, from pass (3.00 GHz, 0.050) to close
(2.86 GHz, 0.085): the earlier refined-mesh pass came from narrow sections
that still read low in Z0 on that mesh. The monopole and the waveguide gave
the same numbers to the last digit; neither has strip edges on a graded mesh.

## Problems NobuRF cannot pose

These problems need something the project file cannot describe.

| Book problem | What it needs | Missing in NobuRF |
| --- | --- | --- |
| Pozar §5.1 L-sections with lumped L and C; ch. 8 lumped low-pass and band-pass prototypes; ch. 4 attenuators and lumped loads | Lumped R, L, C on a grid edge | **Lumped elements**. The only lumped element is the port, a resistor of its reference impedance between two layers |
| Pozar §7.3, Wilkinson divider | A 100 Ω resistor between the two output traces, on the same layer | **Lumped elements**, horizontal |
| Pozar Ex. 5.2 as printed (short-circuited stubs); shorted patches, PIFAs, via fences, grounded CPW, stripline | A conductor through the substrate to ground | **Vias**. The only vertical metal is a coax probe pin |
| Pozar ch. 3, waveguide wall loss α_c; waveguide circuits generally | Lossy walls on all four sides; a waveguide port | Domain walls are perfect, and there is no mode port (see the WR-90 rows) |
| Pozar chs. 2 and 3, coaxial line and circular waveguide; Balanis ch. 13 horns and ch. 15 reflectors | Curved or non-planar 3D metal | **Geometry** is flat sheets on a layer stack, plus the built-in SMA |
| Pozar ch. 9, ferrite isolators, circulators and phase shifters | Gyrotropic (tensor) permeability | **Anisotropic and magnetic materials** |
| Any problem with ε(f) over a wide band | Debye or Lorentz dielectrics | **Dispersive materials**. The loss tangent is exact at one frequency |
| Balanis ch. 6, arrays: array factor, phased and Dolph–Chebyshev arrays | Several driven ports with set amplitudes and phases, and their combined pattern | **Far field with more than one port**, and no excitation weights |
| Balanis ch. 10, helix; vertical dipoles; Yagis with round elements | Thin wires in any direction | **Thin-wire model** |
| Balanis ch. 14, circularly polarised patches: axial ratio | Axial ratio from the far field | Not reported. `far_field.json` holds complex E_θ and E_φ, so it is a post-processing step |
| Pozar chs. 10 to 13: noise, amplifiers, mixers, oscillators | Active and nonlinear devices | Outside a field solver's job. 3D field solvers generally leave these to a circuit simulator |

These could be built today but were not run:

- the rat-race, whose polygon ring would staircase on the grid;
- the coupled-line coupler and the coupled-line band-pass filter, which
  need even- and odd-mode synthesis for microstrip;
- a Yagi made of flat strips;
- the mutual impedance of two dipoles;
- a small loop, whose radiation resistance is a fraction of an ohm, too
  small to read reliably at a 50 Ω port.

## Earlier results that count toward the exam

The validation report already solved four textbook problems with the same
solver. They are not rerun here.

| Problem | Result | Grade | Where |
| --- | --- | --- | --- |
| Pozar Ex. 6.3, copper cavity: f0 and Q | f0 −0.06 %; Q within 0.3 % with dielectric loss, wall loss and both | Pass | [validation.md §7.2](validation.md#72-pozar-example-63-copper-cavity-frequency-and-q) |
| Balanis, infinitesimal dipole directivity, 1.76 dBi | 1.76 dBi, sin² pattern | Pass | [validation.md §4.4](validation.md#44-far-field-near-to-far-field-transform) |
| Balanis Ex. 14.1, patch resonance at 10 GHz (transmission-line model) | −5.7 to −6.0 % | Fail against the book. On another patch where the same model reads 5 % high, openEMS agrees with NobuRF to 0.4 % | [validation.md §7.1](validation.md#71-resonance-against-measurement-and-textbook-values) |
| Balanis Ex. 14.2, input resistance: 228 Ω at the edge, 50 Ω at the inset | 182 Ω (−20 %) and 33 Ω (−35 %) | Fail. The cavity model ignores the probe and the finite ground, and no independent solve exists yet | same |

Beyond the textbooks, the same solver is within 3.5 % of the measured
resonances of Chang et al. (1986) for h/λd up to 0.11. It is within 1.0 % of
the measured roll-off of the Sheen et al. (1990) low-pass filter
([validation.md §7.4, §7.5](validation.md#74-chang-1986-all-eleven-patches-where-the-lumped-feed-stops-working)).

## Gap list, ranked

The gaps are ranked by how many rows each would fix here and how many book
problems it would open up.

| # | Gap | What it fixes in this exam | Size |
| --- | --- | --- | --- |
| 1 | ~~Strip-edge accuracy~~ Done in PR #58 | Narrow-line Z0, now within 1 % on the default mesh | Done |
| 2 | **Calibrated ports in `noburf solve`**: built-in de-embedding (TRL or a mode port with a reference plane) | Every circuit row. The exam needed 3 extra solves per line impedance and a Python calibration to get past the port's own reflection | Medium |
| 3 | **Lumped R, L, C** on any grid edge, horizontal included | Pozar's L-sections, Wilkinson divider, lumped filter prototypes, chip-resistor loads | Small to medium; it is a standard FDTD extension |
| 4 | **Vias** | Short-circuited stubs as Ex. 5.2 prints them, stripline, shorted patches and PIFAs, via fences, grounded coplanar line | Small; it is a PEC column, as the port already is |
| 5 | **An independent solve of the junction-dominated cases** (the branch-line coupler and stepped filter in openEMS or another independent solver, from a converter or a port of the geometry) | Says whether the coupler's +7.8 % and the filter's shift come from NobuRF or from the book's junction-free model | Small |
| 6 | **The microstrip εe excess** (+0.2 to +1.1 % against the static formula, mostly dispersion and board size) | Shifts microstrip frequencies by up to about −0.5 % | Small; the estimated parts add up to the whole excess |
| 7 | **Waveguide ports and guided-mode absorption** | The WR-90 rows; waveguide problems in Pozar chs. 3 and 4 | Medium |
| 8 | **Far field for several ports, with excitation weights** | Balanis ch. 6 arrays | Medium |
| 9 | **Thin wires in any direction** | Vertical dipoles, helices, Yagis with round elements | Medium to large |
| 10 | **Dispersive and anisotropic materials** | Wideband FR-4 and ferrites (Pozar ch. 9) | Medium each |
| 11 | Axial ratio in `far_field.json` | Circular polarisation problems | Small; it post-processes data already written |

## Reproduce

```bash
pip install numpy
python3 scripts/textbook_exam/exam.py               # every case on the GPU (hours on a software GPU)
python3 scripts/textbook_exam/exam.py --only line,stub-tuner
python3 scripts/textbook_exam/exam.py --cpu         # CPU reference solver
python3 scripts/textbook_exam/scorecard.py          # the scorecard table
```

A solve is skipped when its project file has not changed since the stored
result; the script checks the SHA-256 in `result.json`. These runs used the
WebGPU kernels on lavapipe, Mesa's software Vulkan driver, in a cloud
container, at about 36 million cell updates per second.

## References

- D. M. Pozar, *Microwave Engineering*, 4th ed., Wiley, 2012.
- C. A. Balanis, *Antenna Theory: Analysis and Design*, 4th ed., Wiley, 2016.
- E. Hammerstad, Ø. Jensen, "Accurate models for microstrip computer-aided design," *IEEE MTT-S Digest*, 1980.
- G. F. Engen, C. A. Hoer, "Thru-reflect-line: an improved technique for calibrating the dual six-port automatic network analyzer," *IEEE Trans. MTT*, 27(12), 1979.
- R. B. Marks, "A multiline method of network analyzer calibration," *IEEE Trans. MTT*, 39(7), 1991.

Section and example numbers refer to the 4th editions. They were checked
against the worked values where an example prints them, but not page by
page against the books.
