# openEMS references, rebuilt exam stripline and WR-90 (Nov 22, openEMS v0.37, cloud)

Same geometry as the project files: PEC sheets, PEC via posts (drill, pitch and span as given), 50 ohm
lumped ports as one vertical line, open space with PML 8. openEMS meshes it itself: 0.1 mm thirds rule at
the strip edges, 0.2 mm (stripline) / 0.25 mm (WR-90) cells along x over the board and at the posts, 16 z
cells per teflon layer and 20 in the guide. Script: slwg_openems.py (helpers in cheb_openems.py).
No result was compared with NobuRF or the book before these settings were fixed.

## Stripline, Pozar Ex. 3.5
| quantity | openEMS | book |
|---|---|---|
| eps_eff, two-line (20/32 mm, T_long T_short^-1 eigenvalues), mean 1-7 GHz | 2.195 (2.186 to 2.202 per frequency) | 2.2 |
| Z0, voltage and current probes on an 80 mm line, planes 20 mm from the ports, 0.5-2 GHz | 49.74 ohm | 50 (W from eq. 3.180) |
| Z0, same, mean 1-7 GHz | 50.15 ohm (49.3 to 52.5) | |

Notes: |S11| reaches 0.6-0.9 because the bottom-ground-to-strip lumped port also drives the
grounds against each other. That mode is cut off by the fences (8.25 GHz), but at 1 GHz it only
decays about 0.26 rad/mm, so probe planes 5-8 mm from a port read eps_eff 2.3-2.7. The two-line
method and the probes 20 mm away are clean. Z0 = sqrt((V1^2 - V3^2) / (I1^2 - I3^2)), which holds
for any mix of the two waves.

## WR-90, Pozar 3.3 (40/52 mm probe spacing)
| | fc (beta^2 = k0^2 - kc^2 fit, 8.5-12 GHz) | lambda_g at 10 GHz |
|---|---|---|
| fence walls (the project's geometry), two-line | 6.650 GHz | 40.27 mm |
| fence walls, probes in the guide (40 / 52 mm runs) | 6.658 / 6.649 GHz | 40.07 / 40.12 mm |
| solid PEC narrow walls at the same y, two-line | 6.566 GHz | 39.81 mm |
| solid walls, probes | 6.578 / 6.567 GHz | 39.69 / 39.73 mm |
| book (solid walls, a = 22.86 mm) | 6.557 GHz | 39.71 mm |

The solid-wall guide checks the method (+0.14 % on fc). The fenced guide is narrower electrically:
fc +1.4 % means a_eff of about 22.54 mm. The SIW rule a_eff = a - d^2 / (0.95 p) gives 22.60 mm
(fc 6.633 GHz) for d = 0.5, p = 1.0. So on this geometry the book's 6.557 GHz is not the right
target: the fences make the guide about 0.3 mm narrower than the book's walls. Either compare with the
fenced-guide reference above, or place the fences by the published SIW rule before solving
(centers at a + d^2 / (0.95 p)). Choosing which to do is up to the exam, and the choice should be
made before the run.

## How the exam uses these

- Stripline: compared with NobuRF's rebuilt rows directly (eps_eff 2.195 vs 2.195; Z0 49.74 vs 50.08 ohm,
  different Z0 methods, see docs/textbook-exam.md).
- WR-90: the like-for-like reference for NobuRF's fenced geometry is the fenced guide above (6.650 GHz,
  40.27 mm). NobuRF reads 2.0 % / 1.9 % below it, so its pass against the book is two errors cancelling.
  The exam's grading against the book was not changed.

## Files

- `slwg_openems.py`: the stripline and WR-90 runs above.
- `cheb_openems.py`: shared mesh helpers (`sized_lines`, `thirds`). It is also the solver thread's
  openEMS reference for the Pozar Ex. 5.7 Chebyshev and Ex. 5.6 binomial transformers; those results
  are not part of this exam's rows.
