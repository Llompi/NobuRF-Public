# NobuRF self-verification, quick tier

Seed `c60001001e10850132c6f89058232480c6c8780a`. 16 checks: 11 pass, 4 fail, 1 inconclusive.

## pec-box (2 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| box 13x17x18 cells of 0.688 mm, eps_r 4.476 | TM/TE 011 frequency vs exact Yee eigenfrequency | pass | -5.928e-6 | 0.00000 | 0.00122500 | relative error; record 6000 steps (bin 127.08 MHz at 8.3243 GHz); estimator bias bound + roundoff |
| box 13x17x18 cells of 0.688 mm, eps_r 4.476 | TM/TE 111 frequency vs exact Yee eigenfrequency | pass | 4.645e-7 | 0.00000 | 0.00101508 | relative error; record 6000 steps (bin 127.08 MHz at 11.4820 GHz); estimator bias bound + roundoff |
| box 13x12x19 cells of 0.563 mm, eps_r 4.387 | TM/TE 110 frequency vs exact Yee eigenfrequency | pass | 3.066e-6 | 0.00000 | 0.00100146 | relative error; record 6000 steps (bin 155.21 MHz at 14.3773 GHz); estimator bias bound + roundoff |

## conserved-energy (17 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| energy-0: 43x42x14 graded cells, 1 dielectric layer(s) | drift of the conserved discrete energy | pass | 8.952e-9 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |
| energy-1: 52x145x19 graded cells, 2 dielectric layer(s) | drift of the conserved discrete energy | pass | 5.485e-9 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |

## stripline (13 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | beta vs 1D Yee dispersion, level 1 | **FAIL** | 0.00367443 | 0.00000 | 2.602e-4 | largest relative error over the band; exact discrete truth |
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | beta vs 1D Yee dispersion, level 1.5 | **FAIL** | 0.00386647 | 0.00000 | 2.980e-4 | largest relative error over the band; exact discrete truth |
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | beta vs 1D Yee dispersion, level 2 | **FAIL** | 0.0232502 | 0.00000 | 3.300e-4 | largest relative error over the band; exact discrete truth |
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | observed order of the Z0 error | **FAIL** | 0.896483 | 2.00000 |  | needs 1.5 to 3; slope of ln/error/ over 3 levels; Z0 by level 28.5014 / 29.3399 / 29.9168 ohm vs Cohn 31.5424 ohm; strip edge lines on the drawn edge, on the drawn edge, on the drawn edge |
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 extrapolated vs Cohn (exact) | pass | 30.6586 | 31.5424 | 0.930581 | Richardson at order 2 from the two finest levels; band = GCI (Fs 1.25) + Cohn's wall error + extraction error |
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 under a sub-cell translation | pass | 28.5014 | 28.5014 | 0.00741486 | mesh maps onto the original: same discrete problem, roundoff only |
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 under a mirror in x | pass | 28.5012 | 28.5014 | 0.00741486 | mesh maps onto the original: same discrete problem, roundoff only |
| stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 under scaling with the mesh | pass | 28.5014 | 28.5014 | 0.00741486 | mesh maps onto the original: same discrete problem, roundoff only |

## two-port (120 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| two-port-0 (closed, lossless, 1 dielectric layer(s)) | ring-down | *inconclusive* | 24.7285 |  |  | energy fell only 24.7 dB in 40000 steps |
| two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00439537 | excess over 1, worst over the band (largest 0.97099) |
| two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 4.996e-4 | 0.00000 | 0.00439537 | worst /S21 - S12/ over the band |
