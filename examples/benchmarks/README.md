# Published benchmarks

Project files for solved problems from the literature, with the numbers to
compare against. `scripts/validate/benchmarks.ts` runs every runnable case
through the same solve path as `noburf solve` and writes
[`docs/validation/data/benchmarks.json`](../../docs/validation/data/benchmarks.json);
the results are summarised in [docs/validation.md](../../docs/validation.md#7-published-benchmarks).

```bash
npx tsx scripts/validate/benchmarks.ts --plan            # grids and worst-case run times, no solves
npx tsx scripts/validate/benchmarks.ts                   # everything under 20 min per solve
npx tsx scripts/validate/benchmarks.ts --only sheen1990-patch --max-minutes 40
npm run noburf -- solve examples/benchmarks/sheen1990-patch.json   # any single case, as a user would
```

Every file uses the published geometry on NobuRF's uniform cubic grid. No
dimension was adjusted to move a result toward its reference. Where the
published geometry does not fall on the grid, the rasteriser snaps it and the
snap is listed in the solve's warnings.

## Runnable today

| File(s) | Case | Reference value | Kind | Source |
| --- | --- | --- | --- | --- |
| `balanis-ex14-edge-probe.json` | Rectangular patch, W 11.86 mm, L 9.06 mm, h 1.588 mm, εr 2.2, probe at the radiating edge | f0 = 10 GHz, R_in(edge) = 228.35 Ω | Textbook model (transmission-line + cavity) | Balanis, *Antenna Theory*, Examples 14.1 and 14.2 |
| `balanis-ex14-inset-probe.json` | Same patch, probe 3.126 mm in from the edge | f0 = 10 GHz, R_in = 50 Ω | Textbook model | Balanis, Example 14.2 (y0 = 0.3126 cm) |
| `chang1986-57x38.json` | Probe-fed patch W 57 mm, L 38 mm, h 3.175 mm, εr 2.33 | f_r = 2.310 GHz | **Measured** | Chang, Long, Richards, IEEE T-AP 34(6), 1986, Table I |
| `chang1986-45.5x30.5.json` | Same substrate, 45.5 × 30.5 mm | f_r = 2.890 GHz | **Measured** | same |
| `chang1986-29.5x19.5.json` | Same substrate, 29.5 × 19.5 mm | f_r = 4.240 GHz | **Measured** | same |
| `graded/chang1986-*.json` (8 more) | The rest of Chang's Table I: 19.5 × 13 down to 9 × 6 mm on 3.175 mm, and 17 × 11 mm on 1.524 and 9.525 mm (h/λd 0.06 to 0.23) | f_r = 4.73 to 10.25 GHz | **Measured** | Chang et al. 1986, Table I |
| `graded/sheen1990-lowpass-filter.json` | Stub low-pass filter, 0.794 mm, εr 2.2, two ports | S21 −3 dB at 5.45 GHz, −10 dB at 5.98 GHz; S11 dips 5.0 and 10.8 GHz | **Measured**, read from Figs. 9 and 10 | Sheen et al. 1990 |
| `graded/sheen1990-branch-line-coupler.json` | Branch-line coupler, same substrate, four ports | Operating point (S31 = S41, S11 and S21 nulls) 6.5 GHz | **Measured** (text) | Sheen et al. 1990 |
| `graded/sheen1990-branch-line-coupler-sma.json` | Same coupler with SMA edge launches, board trimmed to the feed-line ends | Same | **Measured** (text) | Sheen et al. 1990 |
| `sheen1990-patch.json` | Line-fed patch 12.45 × 16 mm, h 0.794 mm, εr 2.2, feed 2.46 mm wide, offset 2.09 mm | Resonance at 7.5 GHz | **Measured** and FDTD (text) | Sheen, Ali, Abouzahra, Kong, IEEE T-MTT 38(7), 1990 |
| `pozar-ex3.7-z0-lossy-line.json` | 50 Ω microstrip on 0.5 mm alumina (εr 9.9), deliberately lossy, 25 mm long | Re(Z0) from Hammerstad–Jensen (≈ 49 Ω lossless at W/h = 1) | Closed form | Pozar, *Microwave Engineering* 4th ed., Example 3.7; Hammerstad & Jensen 1980 |
| `pozar-ex3.7-eeff-line-a.json`, `-line-b.json` | Same line, open-ended, 5.8 and 11.6 mm | εeff from Hammerstad–Jensen + Kirschning–Jansen dispersion (Pozar: 6.665 quasi-static at W = 0.483 mm) | Closed form | same, plus Kirschning & Jansen 1982 |

Notes on each case:

- **Balanis Examples 14.1 and 14.2** are design equations, not measurements. The
  10 GHz is the frequency the patch was *designed* for with the
  transmission-line model, which the existing validation (section 4.1 of
  validation.md) already shows reads a few percent high on real boards. The
  R_in values come from the cavity model with an infinite ground; the
  benchmark uses a 31.8 × 29 mm ground. NobuRF's port is a vertical column
  (a probe), which matches the model's "feed at distance y0" better than an
  inset microstrip would. The edge probe sits on the first grid node inside
  the edge (0.35 mm in).
- **Chang, Long and Richards 1986** measured resonant frequencies of
  probe-fed patches on thick substrates (εr 2.33). The uniform files are the
  first three rows of their Table I (h 3.175 mm); `graded/` has all eleven,
  nine sizes on 3.175 mm and the 17 × 11 mm patch on 1.524 and 9.525 mm as
  well. From the paper's section II: the probe is on the center line 1.5 mm
  in from the radiating edge, and the ground is 10 × 10 cm. f_r is the
  frequency of maximum input resistance (section III-B), read here as the
  lowest Re(Z_in) maximum in the band; the S11 minimum is reported too, but
  is not the paper's quantity. The files feed the patch with a lumped port
  column, which stops working on the electrically thick rows;
  `scripts/validate/chang_probe_pin.ts <file> --coax` solves the same file
  with a `coax_probe` port instead (validation.md section 7.4).
- **Sheen et al. 1990** is the classic FDTD-plus-measurement paper. Patch,
  feed width and feed offset are from its Fig. 3; the paper's text gives the
  operating resonance as 7.5 GHz. Its grid was non-uniform (0.389 × 0.400 ×
  0.265 mm, so the 12.45 mm and 16 mm sides are 32 and 40 cells); the
  uniform file uses 0.2647 mm cubes (3 cells across the substrate), so the
  feed width and offset snap by up to half a cell, and the graded file puts
  mesh lines at the patch and feed edges, a third of a cell inside the
  copper where the mesh allows it. Sheen ran the feed line into the
  absorbing wall; NobuRF puts the lumped port at the end of an 8 mm feed line, which changes
  the S11 phase but not its magnitude for a matched, lossless line.
- **Sheen 1990 low-pass filter and branch-line coupler** (`graded/` only,
  two and four lumped ports, port 1 excited). Filter (Fig. 7): a 20.32 ×
  2.54 mm stub with 2.413 mm lines 5.65 mm in from each end, on opposite
  sides. Coupler (Fig. 11): 9.75 mm center to center, 3.96 mm wide through
  arms, 2.413 mm branches and port lines. References: the filter's measured
  S21 at −3 and −10 dB, read off Fig. 10 by pixel; the S11 dips read off
  Fig. 9; the coupler's 6.5 GHz operating point, from the text.
- **Pozar Example 3.7** designs a 50 Ω line on 0.5 mm alumina (W = 0.483 mm,
  εe = 6.665). The benchmarks draw the strip at 0.5 mm (5 cells of 0.1 mm)
  and compare against the Hammerstad–Jensen closed form *at the drawn width*
  (W/h = 1: εe = 6.64, Z0 = 49.05 Ω), computed inside the script. NobuRF has
  one lumped port and no matched load, so the line quantities are extracted
  indirectly:
  - **Z0**: a 25 mm line with tan δ = 0.3 (at 10 GHz) so the echo from the
    open far end comes back attenuated by about 30 dB. Then Re(Z_in) ≈ Re(Z0)
    of the lossy line; the port's series inductance only adds reactance. The
    closed-form reference includes the same loss (Pozar eq. 3.198, Z0 / √(1 −
    j tan δe)) and NobuRF's constant-conductivity loss (tan δ ∝ 1/f).
  - **εeff**: two open-ended lines, 5.8 and 11.6 mm, fed at one end, tan δ
    0.05 to shorten the ring-down. The half-wave resonance of the short line
    and the full-wave resonance of the long line fall at nearly the same
    frequency, so the end corrections at both ends cancel:
    √εe = c (2/f_b − 1/f_a) / (2 (L_b − L_a)).

## Not built yet

| Case | Reference | What is missing |
| --- | --- | --- |
| Quarter-wave transformer | Pozar 4th ed. §2.5: \|Γ\| = 0 at f0 (bandwidth: ch. 5) | Possible with two ports; not built |
| Half-wave dipole | Z_in = 73 + j42.5 Ω for an infinitely thin λ/2 dipole (Balanis, *Antenna Theory*, eq. 4-93) | Thin-wire model or a horizontal gap port in free space; ports are vertical columns between copper layers |
| openEMS "Simple Patch Antenna" tutorial | Script is published (32 × 40 mm on 1.524 mm, εr 3.38, probe at x = −6 mm), but the tutorial page gives no numbers, only plots | A local openEMS run, as done for the demo patch in `validation/openems/` |

Microstrip attenuation (Pozar Example 3.7) and a coax probe for Chang's thick
patches were on this list; they are now in docs/validation.md sections 7.3
and 7.4 (`scripts/validate/microstrip_beta.ts --copper`,
`scripts/validate/chang_probe_pin.ts --coax`).

## Graded-mesh versions

`graded/` holds the same projects with `mesh.graded`, so mesh lines sit on
every copper edge, the probe and the board outline instead of the nearest
cubic-grid node. Geometry, materials, ports and band are identical to the
uniform files; the mesh, the air margins (now in graded cells of up to 2 mm,
4 beside the board), the name and the step cap differ. Each case runs twice,
the second time with half the edge cell and twice the cells across the
substrate, and both runs are reported. The largest cell does not change, so
this measures sensitivity to edge resolution, not full convergence:

```bash
npx tsx scripts/validate/benchmarks.ts --mesh graded --max-minutes 60             # -> benchmarks-graded-r1.json
npx tsx scripts/validate/benchmarks.ts --mesh graded --refine 2 --max-minutes 60  # -> benchmarks-graded-r2.json
```

| Case | Edge cell (r1 / r2) | Cells across substrate | Largest cell |
| --- | --- | --- | --- |
| `chang1986-*` | 0.4 / 0.2 mm (0.25 / 0.13 on the 1.524 mm board) | 6 / 12 | 2 mm or λ/20, whichever is smaller |
| `balanis-ex14-*` | 0.2 / 0.1 mm | 6 / 12 | 1 mm |
| `sheen1990-patch` | 0.2 / 0.1 mm | 4 / 8 | 1 mm |
| `sheen1990-lowpass-filter`, `-branch-line-coupler` | 0.2 / 0.1 mm | 4 / 8 | 0.75 mm |
| `pozar-ex3.7-*` | 0.05 / 0.025 mm | 6 / 12 | 0.5 mm |

The uniform files mostly read the patches low: zero-thickness copper on a
cubic grid behaves as if it reached a little past its drawn edge, and the
edges snap. Balanis' patch moves from 8.99 GHz (uniform 0.397 mm) to 9.44 GHz
(graded, 0.1 mm edge cells). The Pozar Example 3.7 lines keep the 0.5 mm
strip width so the closed-form comparison is unchanged; their εeff gap to
Hammerstad–Jensen is +1.6 % uniform and +0.7 % on both graded meshes, with
the resonator runs stopped at 70 dB of energy decay (validation.md section
7.3).

## Pozar Example 6.3: copper cavity

Not a project file: [`scripts/validate/pozar_cavity.ts`](../../scripts/validate/pozar_cavity.ts)
builds the cavity directly on the solver's update coefficients, because a
project's side walls are PML or lossless PEC. A WR-187 cavity (a = 4.755 cm,
b = 2.215 cm) filled with polyethylene (εr 2.25, tan δ 0.0004), with copper
walls (σ = 5.813e7 S/m), cut to resonate at 5 GHz. The book gives d, Q_c,
Q_d = 1/tan δ and Q for TE101 and TE102. The script recomputes those numbers
from Pozar's eq. 6.46 (they agree with the printed ones to about 0.1 %) and reads f0
and Q from the ring-down. Copper is applied with the solver's own sheet model
(`sheetEdge`) on the three walls at the low faces only; the kernel makes the
three high walls perfect. In a TE10l mode each pair of opposite walls carries
the same surface current, so those three walls dissipate exactly half the
book's wall loss and the expected Q_c is twice the book's. The comparison is
made against that figure.
