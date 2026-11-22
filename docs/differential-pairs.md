# Differential pairs

A differential pair, such as USB D+ and D−, is solved like any other board: four lumped ports, one
at each end of each trace, and one run per port. NobuRF then reads the 4×4 S-matrix as a pair:
mixed-mode S-parameters, differential and common-mode impedance from a TDR, the delay through the
pair and the intra-pair skew. All of it is post-processing of the single-ended S-matrix, so it
also works on a Touchstone file from another solver or a VNA.

## Three ways in

- **Workbench.** New, Differential pair gives two coupled 50 Ω lines with the ports already paired.
  For any other board with four or more ports, solve it and open the Differential tab: if the
  project has no pairing yet, the tab proposes one and shows its results; Use this pairing writes it
  into the project. See [workbench.md](workbench.md#results).
- **Project file.** List the pair ends under `outputs.differential_pairs`. `noburf solve` then writes
  `differential.json` next to `sparams.s4p` and adds a `differential` summary to `result.json`.

  ```json
  "differential_pairs": [
    { "id": "D1", "positive": "p1", "negative": "n1", "differential_ohm": 90, "common_ohm": 30 },
    { "id": "D2", "positive": "p2", "negative": "n2", "differential_ohm": 90, "common_ohm": 30 }
  ]
  ```

  Each entry is one end of a pair. Every port must be in exactly one entry, and both lines of an end
  need the same `reference_impedance_ohm`. Without `differential_ohm` and `common_ohm` the mode
  references are twice and half the ports' own (100 Ω and 25 Ω on 50 Ω ports). The pairing never
  changes a solve.
- **Any Touchstone file**, for a person or an agent:

  ```bash
  npm run noburf -- pair board.s4p --pair 1,2 --pair 3,4 --zdiff 90 --zcomm 30 --at 0.24 --at 0.48
  ```

  `--pair positive,negative` names one end by its port numbers in the file, so there is no guess
  about port order (files differ: 1,2 / 3,4 or 1,3 / 2,4). The JSON goes to stdout, or to
  `--out file.json`, and a one-line summary per through to stderr.

## What is computed, and how

**Mixed-mode S.** With ports P1, N1 at one end and P2, N2 at the other, the mixed-mode waves are
a_d = (a_P − a_N)/√2 and a_c = (a_P + a_N)/√2 (Bockelman and Eisenstadt, IEEE Trans. MTT 43(7),
1995), so S_mm = M S Mᵀ. These are the power waves of V_d = V_P − V_N, I_d = (I_P − I_N)/2 on 2 Z0 and
of V_c = (V_P + V_N)/2, I_c = I_P + I_N on Z0/2, so moving to other mode references (90 Ω for USB 2.0)
is an ordinary renormalisation of the mixed-mode ports through the impedance matrix, with the routine
the coax feed already uses. Sdd is differential in and out, Scc common, Scd differential in and
common out (mode conversion), Sdc the reverse. Sdd21 reads "differential out at end 2, in at end 1".

**Differential and common-mode impedance.** A low-pass step TDR of Sdd11 on the differential
reference, and of Scc11 on the common one, as a VNA's time-domain option computes it (Kaiser window,
β 6). The figure reported for the line is the median over the middle half of the line: round-trip
times from half to one and a half of the one-way delay, which leaves out the port connections at
both ends. The trace itself shows the ports as bumps.

**Delay and skew.** Delay is the 50 % crossing of a step through the pair (TDT). Skew is the 50 %
crossing of the positive line's step minus the negative line's, each line driven on its own with the
others loaded. On a coupled pair a single line's phase delay mixes the even and odd modes, which is
why the time domain is used rather than S31 against S42 phase. A positive skew means the positive
line arrives later.

**Cross-check from mode conversion.** For two matched lines that differ only in delay by d,
Scd21 / Sdd21 = −j tan(π f d), so Im(Scd21 / Sdd21) gives d at every frequency. NobuRF reports the
median and the range over the frequencies where |Sdd21| is above −6 dB. When the two skew figures
disagree, the lines differ in more than delay (impedance or loss), and the skew depends on the edge
rate; the TDR rise time is reported with it.

## Checks

| Check | Result |
| --- | --- |
| Ideal symmetric coupled line (Pozar, Microwave Engineering, 4th ed., 7.6), Ze 60 Ω, Zo 45 Ω | Sdd equals the odd-mode line and Scc the even-mode line to 1e-12; Scd and Sdc below 1e-14; on 90 Ω and 30 Ω references Sdd11 and Scc11 vanish (below 1e-9); the TDR reads 90.0 Ω and 30.0 Ω; the delay is the odd-mode delay to 0.5 ps; skew zero |
| Two uncoupled lines, one 2 mm longer at εeff 3 | TDT skew −11.56 ps within 0.05 ps; the mode-conversion figure agrees to 1e-6 ps; polarity swap flips both signs |
| scikit-rf 2.2 `Network.se2gmm`, an independent implementation ([`scripts/validate/mixed_mode_skrf.py`](../scripts/validate/mixed_mode_skrf.py)) | All 16 terms agree to the 0.001 dB / 0.01° rounding of the JSON (largest difference 1.0e-4 of \|S\|), on a NobuRF solve and on an asymmetric synthetic 4-port, at 100/25 Ω, 90/30 Ω and 85/40 Ω |

Run the scikit-rf check on any four-port file whose ports run P1, N1, P2, N2:

```bash
pip install scikit-rf
python scripts/validate/mixed_mode_skrf.py runs/my-pair.results/sparams.s4p --zdiff 90 --zcomm 30
```

## Checked against openEMS

The same lossless pair (PEC copper, εr 4.4, no dielectric loss, lumped ports at the line centers) in
openEMS 0.37 ([`validation/openems/diff_pair_openems.py`](../validation/openems/diff_pair_openems.py),
0.1 mm cells across the lines, 10 mm of air to an 8-cell PML, 60 dB energy stop, about 400,000 cells,
82 minutes for four runs on a laptop CPU). Both Touchstone files go through `noburf pair` with the
same 100 Ω and 25 Ω references, so the comparison tests the solvers, not the post-processing.

| Lossless pair | NobuRF | openEMS, 1/3-2/3 edge rule | openEMS, lines on the edges |
| --- | --- | --- | --- |
| Differential impedance, middle of the line | 97.1 Ω | 97.25 Ω | 93.3 Ω |
| Common-mode impedance | 25.6 Ω | 25.64 Ω | 24.7 Ω |
| Differential delay | 114.7 ps | 114.7 ps | 115.2 ps |
| Sdd21 phase at 5 GHz | 154.61° | 154.63° | |

With openEMS's own meshing advice for zero-thickness metal (a line a third of a cell inside each strip
edge, one two thirds outside) the line impedances agree to 0.2 % and the delay to the picosecond.
Mesh lines exactly on the edges make a zero-thickness strip act wider in openEMS and read 4 % low, the
same edge effect NobuRF's graded mesh corrects ([validation.md](validation.md)). Sdd21 and Scc21 agree
within 0.08 dB across the band (0.02 dB at 5 GHz). The return losses differ by up to 0.04 in |S| (about 2 dB at the
−20 dB level): the two solvers model the lumped port's own cell differently, and those parasitics sit
inside the reference planes. A port as wide as the strip instead of one edge (openEMS, lines on the
edges) leaves the line impedance where it was (93.0 against 93.3 Ω) and shortens the delay to 111.2 ps,
since the wide port's current enters the strip at once rather than spreading from its center. The data
is in `docs/validation/data/openems_diffpair_*`.

## Two solved pairs

Both are the Differential pair template at 5 GHz on 0.5 mm FR-4 (0.956 mm lines, 1.912 mm gap,
18 mm between the port pairs, band 0.05 to 10 GHz, GPU kernels, energy stop 60 dB, about 2 minutes
each for four runs in the cloud sandbox's software Vulkan). The FR-4 is the template's wideband model,
explained under [The substrate's loss model](#the-substrates-loss-model).

| | Symmetric pair | Negative line with a 1.5 mm detour ([`examples/diff-pair-detour.json`](../examples/diff-pair-detour.json)) |
| --- | --- | --- |
| Differential impedance, middle of the line | 96.4 Ω | 92.8 Ω |
| Common-mode impedance | 25.4 Ω | 24.3 Ω |
| Delay, D1 to D2 | 116.3 ps | 121.9 ps |
| Skew, TDT 50 % crossing | 0.00 ps | −10.96 ps |
| Skew from mode conversion (median) | 0.00 ps | −10.62 ps |
| Worst Scd21 | −119 dB (the solver's noise floor) | −10.1 dB |

Mode conversion on the symmetric pair sits at the noise floor, as symmetry requires. On the detour
pair the two skew figures agree to 0.3 ps; they match exactly only when the lines differ in delay alone,
and a detour also changes the negative line's impedance at its corners. The detour adds 3 mm to the
center line, which at the pair's εeff would be about 18 ps; the four right-angle corners shorten the
electrical path, so the smaller figure is expected, but no independent solver has checked the detour.

**The energy stop matters.** With the default 40 dB energy stop the detour pair read −6.5 ps TDT skew
against −10.3 ps from mode conversion, and the TDT figure moved from −6.5 to +4 ps as the band was cut
from 10 to 3 GHz. The group delay of the negative line at 50 MHz was 306 ps against 133 ps after a
60 dB run: the cut ring-down spoils the lowest frequencies, and the TDR level and TDT crossing rest on
them. After a 60 dB run the TDT skew stayed at −10.3 ps with the band cut at 10, 5 or 3 GHz (98 to
330 ps rise time). These runs predate the copper-edge correction and used the plain FR-4 loss model.
The pair template therefore stops at 60 dB, and the Differential tab and `noburf solve` warn when a
solve stopped below 55 dB.

### The substrate's loss model

This section compares the two loss models a time-domain solver can give a `tan_delta`. Since Nov 21, 2026, a
loss tangent alone is the wideband one (below); the constant conductivity is the opt-in
`"dispersion": { "model": "conductivity" }`.

A constant conductivity, σ = 2π f_ref ε0 εr tan δ, is exact at
`analysis.loss_reference_ghz` (openEMS models FR-4 the same way). It still conducts at DC, where real
FR-4 barely does. Along the 18 mm pair on 0.5 mm FR-4 referenced at 5 GHz that is about 1.25 mS to
ground per line (from the line's capacitance and the dielectric's filling factor, Hammerstad εeff
3.33), which predicts a single-ended S11 of about −0.030 at DC; the solve gave −0.028. A TDR's late level
is the DC impedance, so the far end reads about 94 Ω instead of 100 Ω, and the leak pulls the middle of
the line down too.

| Symmetric pair, same mesh and band, 60 dB stop | Far-end TDR level | Differential impedance, middle | Sdd21 at 5 GHz |
| --- | --- | --- | --- |
| Lossless (PEC, tan δ 0) | 100.0 Ω | 97.1 Ω | −0.06 dB |
| Copper loss only | 100.4 Ω | 97.6 Ω | −0.10 dB |
| FR-4, plain tan δ 0.02 (constant conductivity) | 94.4 Ω | 94.4 Ω | −0.37 dB |
| FR-4, Djordjevic-Sarkar, εr 4.4 and tan δ 0.02 at 5 GHz | 99.5 Ω | 96.4 Ω | −0.37 dB |
| The same, 100 dB stop | 100.0 Ω | 96.6 Ω | −0.37 dB |

The Djordjevic-Sarkar model keeps tan δ nearly flat across the band (0.0189 at 50 MHz), so its
equivalent conductivity ω ε0 ε'' falls with frequency to zero at DC, and the insertion loss at 5 GHz is
unchanged. The fair comparison is the copper-loss-only row, since both FR-4 rows keep the copper loss:
against it the plain model reads 6.0 Ω low at the far end and 3.2 Ω low in the middle, the wideband one
0.9 Ω and 1.2 Ω low.

Half of the wideband model's far-end gap is the run length. Its slowest Debye poles relax over about
100 ns and hold little energy, so even with their energy counted in the stop a 60 dB run ends while they
still move the lowest frequencies: |Sdd21| at 50 MHz is 0.9949 against 0.9984 for the copper-only line,
and at a 100 dB stop (16,000 steps per run instead of 2,700) it is 0.9990 and the far end reads
100.0 Ω. The 1.0 Ω left in the middle of the line is most likely the model's dispersion (εr rises from
4.40 at 5 GHz to 4.66 at 50 MHz), though that has not been separated out. At the template's 60 dB stop a
wideband laminate's TDR level is therefore about 0.5 % low.

A lossy substrate therefore gets this model by default, with the same εr and tan δ at the loss
reference, which the pair template sets to the design frequency. The Differential tab and `noburf solve`
say so when a pair's dielectric conducts at DC (the `conductivity` opt-in, or a pole model that leaves
part of its loss to a conductivity).

## Limits

- The ports are lumped. Their parasitics are inside the reference planes, which is why the TDR shows
  bumps at both ends; on the four-port Sheen branch-line coupler lumped ports read 8.6 to 9.4 % low
  ([validation.md](validation.md)).
- The openEMS check above is one lossless pair, solver against solver. Both model the copper as a
  zero-thickness sheet, which understates the coupling between trace sidewalls on real 35 µm copper,
  and neither has been compared with a measured board or a closed-form coupled-microstrip model yet.
- A USB 2.0 band (240 MHz fundamental) needs a long run at the cell sizes a tight pair needs, and lies
  below the 2 to 8 GHz range NobuRF's measured benchmarks cover.
- `noburf pair` reads Touchstone v1 with one real reference impedance; v2 files are refused rather than
  misread, and a two-port file's noise parameters are skipped. On an unevenly spaced band (a log or
  segmented sweep) it reports mixed-mode S only, with no TDR, delay or skew.
- The line impedance is not read when the TDR's rise time is longer than the line's delay: the port
  connections would blur over the whole window. Raise the top of the band or lengthen the line.
- The mode-conversion skew uses only frequencies where π f |skew| < π/3, so its tangent has not
  wrapped; the per-line delays in `differential.json` are each line's own step crossing with the
  other line loaded, not the odd-mode delay (`differential_delay_ns` is that).
