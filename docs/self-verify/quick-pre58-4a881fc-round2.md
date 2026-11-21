# NobuRF self-verification, quick tier

Seed `review-round-2` plus regression seeds `stripline-st`, `c60001001e10`. 72 checks: 61 pass, 11 fail, 0 inconclusive.

## pec-box (9 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| box 17x22x10 cells of 0.409 mm, eps_r 9.066 | TM/TE 110 frequency vs exact Yee eigenfrequency | pass | -1.716e-7 | 0.00000 | 6.565e-4 | relative error; record 12000 steps (bin 106.99 MHz at 9.0491 GHz); estimator bias bound + roundoff |
| box 11x19x14 cells of 0.973 mm, eps_r 1.514 | TM/TE 011 frequency vs exact Yee eigenfrequency | pass | 1.197e-8 | 0.00000 | 2.677e-4 | relative error; record 12000 steps (bin 44.91 MHz at 11.0954 GHz); estimator bias bound + roundoff |
| box 11x19x14 cells of 0.973 mm, eps_r 1.514 | TM/TE 110 frequency vs exact Yee eigenfrequency | pass | -1.680e-8 | 0.00000 | 2.364e-4 | relative error; record 12000 steps (bin 44.91 MHz at 13.1259 GHz); estimator bias bound + roundoff |
| box 11x19x14 cells of 0.973 mm, eps_r 1.514 | TM/TE 101 frequency vs exact Yee eigenfrequency | pass | -1.568e-7 | 0.00000 | 2.207e-4 | relative error; record 12000 steps (bin 44.91 MHz at 14.4484 GHz); estimator bias bound + roundoff |
| box 11x19x14 cells of 0.973 mm, eps_r 1.514 | TM/TE 120 frequency vs exact Yee eigenfrequency | pass | 3.218e-8 | 0.00000 | 1.946e-4 | relative error; record 12000 steps (bin 44.91 MHz at 17.3707 GHz); estimator bias bound + roundoff |
| [seed stripline-st] box 10x16x12 cells of 0.612 mm, eps_r 4.769 | TM/TE 011 frequency vs exact Yee eigenfrequency | pass | 5.299e-8 | 0.00000 | 3.716e-4 | relative error; record 12000 steps (bin 71.38 MHz at 11.6527 GHz); estimator bias bound + roundoff |
| [seed stripline-st] box 10x16x12 cells of 0.612 mm, eps_r 4.769 | TM/TE 110 frequency vs exact Yee eigenfrequency | pass | 1.676e-6 | 0.00000 | 3.361e-4 | relative error; record 12000 steps (bin 71.38 MHz at 13.1797 GHz); estimator bias bound + roundoff |
| [seed stripline-st] box 10x16x12 cells of 0.612 mm, eps_r 4.769 | TM/TE 101 frequency vs exact Yee eigenfrequency | pass | 5.495e-10 | 0.00000 | 3.107e-4 | relative error; record 12000 steps (bin 71.38 MHz at 14.5468 GHz); estimator bias bound + roundoff |
| [seed stripline-st] box 18x25x14 cells of 0.331 mm, eps_r 1.987 | TM/TE 110 frequency vs exact Yee eigenfrequency | pass | -2.213e-8 | 0.00000 | 3.657e-4 | relative error; record 12000 steps (bin 131.86 MHz at 21.9452 GHz); estimator bias bound + roundoff |
| [seed stripline-st] box 18x25x14 cells of 0.331 mm, eps_r 1.987 | TM/TE 011 frequency vs exact Yee eigenfrequency | pass | -2.074e-7 | 0.00000 | 3.167e-4 | relative error; record 12000 steps (bin 131.86 MHz at 26.2289 GHz); estimator bias bound + roundoff |
| [seed stripline-st] box 18x25x14 cells of 0.331 mm, eps_r 1.987 | TM/TE 101 frequency vs exact Yee eigenfrequency | pass | 5.404e-7 | 0.00000 | 2.927e-4 | relative error; record 12000 steps (bin 131.86 MHz at 28.9939 GHz); estimator bias bound + roundoff |
| [seed stripline-st] box 18x25x14 cells of 0.331 mm, eps_r 1.987 | TM/TE 021 frequency vs exact Yee eigenfrequency | pass | -5.117e-9 | 0.00000 | 2.572e-4 | relative error; record 12000 steps (bin 131.86 MHz at 34.3499 GHz); estimator bias bound + roundoff |
| [seed c60001001e10] box 13x17x18 cells of 0.688 mm, eps_r 4.476 | TM/TE 011 frequency vs exact Yee eigenfrequency | pass | 4.259e-8 | 0.00000 | 4.469e-4 | relative error; record 12000 steps (bin 63.54 MHz at 8.3243 GHz); estimator bias bound + roundoff |
| [seed c60001001e10] box 13x17x18 cells of 0.688 mm, eps_r 4.476 | TM/TE 111 frequency vs exact Yee eigenfrequency | pass | 2.935e-8 | 0.00000 | 3.420e-4 | relative error; record 12000 steps (bin 63.54 MHz at 11.4820 GHz); estimator bias bound + roundoff |
| [seed c60001001e10] box 13x12x19 cells of 0.563 mm, eps_r 4.387 | TM/TE 110 frequency vs exact Yee eigenfrequency | pass | -6.936e-7 | 0.00000 | 3.352e-4 | relative error; record 12000 steps (bin 77.60 MHz at 14.3773 GHz); estimator bias bound + roundoff |

## conserved-energy (39 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| energy-0: 38x38x13 graded cells, 1 dielectric layer(s) | drift of the conserved discrete energy | pass | 2.194e-8 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |
| energy-1: 64x92x19 graded cells, 2 dielectric layer(s) | drift of the conserved discrete energy | pass | 5.716e-9 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |
| [seed stripline-st] energy-0: 40x41x13 graded cells, 1 dielectric layer(s) | drift of the conserved discrete energy | pass | 1.182e-8 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |
| [seed stripline-st] energy-1: 63x60x22 graded cells, 2 dielectric layer(s) | drift of the conserved discrete energy | pass | 6.611e-9 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |
| [seed c60001001e10] energy-0: 43x42x14 graded cells, 1 dielectric layer(s) | drift of the conserved discrete energy | pass | 1.188e-8 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |
| [seed c60001001e10] energy-1: 53x131x19 graded cells, 2 dielectric layer(s) | drift of the conserved discrete energy | pass | 1.485e-8 | 0.00000 | 2.666e-5 | largest /W^n / W^0 - 1/ over 2000 steps from random fields; float32 random-walk bound |

## stripline (185 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | beta vs 1D Yee dispersion, level 1 | pass | 3.052e-5 | 0.00000 | 1.140e-4 | band-mean signed relative error (largest at one frequency 1.97e-4); exact discrete truth |
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | beta vs 1D Yee dispersion, level 2 | pass | 2.365e-5 | 0.00000 | 1.194e-4 | band-mean signed relative error (largest at one frequency 1.58e-4); exact discrete truth |
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | beta vs 1D Yee dispersion, level 3 | pass | 2.208e-5 | 0.00000 | 1.237e-4 | band-mean signed relative error (largest at one frequency 1.58e-4); exact discrete truth |
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | observed order of the Z0 error | **FAIL** | 0.909723 | 2.00000 |  | needs 1.5 to 3; slope of ln/error/ over 3 levels; Z0 by level 44.5968 / 46.4556 / 47.1790 ohm vs Cohn 48.6733 ohm; strip edge lines on the drawn edge, on the drawn edge, on the drawn edge |
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | Z0 extrapolated vs Cohn (exact) | **FAIL** | 47.7578 | 48.6733 | 0.728363 | Richardson at order 2 from the two finest levels; band = GCI (Fs 1.25) + Cohn's wall error + extraction error |
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | Z0 under a sub-cell translation | pass | 44.5968 | 44.5968 | 0.00508194 | mesh maps onto the original: same discrete problem, roundoff only |
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | Z0 under a mirror in x | **FAIL** | 44.4407 | 44.5968 |  | the transformed mesh does not map onto the original (mesher not equivariant) |
| stripline-0: W 1.505 mm, b 1.838 mm, eps_r 2.358, edge cell 0.2826 mm, 4 cells per half | Z0 under scaling with the mesh | pass | 44.5968 | 44.5968 | 0.00508194 | mesh maps onto the original: same discrete problem, roundoff only |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | beta vs 1D Yee dispersion, level 1 | pass | 9.707e-6 | 0.00000 | 1.215e-4 | band-mean signed relative error (largest at one frequency 6.01e-5); exact discrete truth |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | beta vs 1D Yee dispersion, level 2 | pass | 1.159e-6 | 0.00000 | 1.308e-4 | band-mean signed relative error (largest at one frequency 1.23e-5); exact discrete truth |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | beta vs 1D Yee dispersion, level 3 | pass | 1.480e-6 | 0.00000 | 1.379e-4 | band-mean signed relative error (largest at one frequency 1.47e-5); exact discrete truth |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | observed order of the Z0 error | **FAIL** | 0.863420 | 2.00000 |  | needs 1.5 to 3; slope of ln/error/ over 3 levels; Z0 by level 38.2498 / 39.4834 / 39.9137 ohm vs Cohn 40.9677 ohm; strip edge lines on the drawn edge, on the drawn edge, on the drawn edge |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | Z0 extrapolated vs Cohn (exact) | **FAIL** | 40.2580 | 40.9677 | 0.434446 | Richardson at order 2 from the two finest levels; band = GCI (Fs 1.25) + Cohn's wall error + extraction error |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | Z0 under a sub-cell translation | pass | 38.2498 | 38.2498 | 0.00464699 | mesh maps onto the original: same discrete problem, roundoff only |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | Z0 under a mirror in x | pass | 38.2498 | 38.2498 | 0.00464699 | mesh maps onto the original: same discrete problem, roundoff only |
| [seed stripline-st] stripline-0: W 1.419 mm, b 2.681 mm, eps_r 5.642, edge cell 0.1989 mm, 2 cells per half | Z0 under scaling with the mesh | pass | 38.2498 | 38.2498 | 0.00464699 | mesh maps onto the original: same discrete problem, roundoff only |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | beta vs 1D Yee dispersion, level 1 | **FAIL** | -2.458e-4 | 0.00000 | 1.153e-4 | band-mean signed relative error (largest at one frequency 1.69e-3); exact discrete truth |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | beta vs 1D Yee dispersion, level 2 | pass | -4.074e-5 | 0.00000 | 1.217e-4 | band-mean signed relative error (largest at one frequency 3.26e-4); exact discrete truth |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | beta vs 1D Yee dispersion, level 3 | pass | -1.858e-5 | 0.00000 | 1.265e-4 | band-mean signed relative error (largest at one frequency 1.74e-4); exact discrete truth |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | observed order of the Z0 error | **FAIL** | 0.938222 | 2.00000 |  | needs 1.5 to 3; slope of ln/error/ over 3 levels; Z0 by level 28.5024 / 29.9597 / 30.4575 ohm vs Cohn 31.5424 ohm; strip edge lines on the drawn edge, on the drawn edge, on the drawn edge |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 extrapolated vs Cohn (exact) | **FAIL** | 30.8557 | 31.5424 | 0.501103 | Richardson at order 2 from the two finest levels; band = GCI (Fs 1.25) + Cohn's wall error + extraction error |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 under a sub-cell translation | pass | 28.5024 | 28.5024 | 0.00328669 | mesh maps onto the original: same discrete problem, roundoff only |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 under a mirror in x | pass | 28.5024 | 28.5024 | 0.00328669 | mesh maps onto the original: same discrete problem, roundoff only |
| [seed c60001001e10] stripline-0: W 2.920 mm, b 2.630 mm, eps_r 3.704, edge cell 0.6683 mm, 4 cells per half | Z0 under scaling with the mesh | pass | 28.5024 | 28.5024 | 0.00328669 | mesh maps onto the original: same discrete problem, roundoff only |

## two-port (1113 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00404257 | excess over 1, worst over the band (largest 0.99975); truncation at 60.0 dB + roundoff |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 1.410e-4 | 0.00000 | 0.00404257 | worst /S21 - S12/ over the band |
| two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00404086 | excess over 1, worst over the band (largest 0.99754); truncation at 60.0 dB + roundoff |
| two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 3.704e-4 | 0.00000 | 0.00404086 | worst /S21 - S12/ over the band |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a mirror in x | pass | 1.781e-6 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a 90 degree rotation | **FAIL** |  |  |  | the transformed mesh does not map onto the original (mesher not equivariant) |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a sub-cell translation | pass | 0.00000 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under scaling with the mesh | pass | 7.293e-7 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under reversed port order | pass | 3.334e-16 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed stripline-st] two-port-0 (PML, lossless, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00403372 | excess over 1, worst over the band (largest 0.99999); truncation at 60.0 dB + roundoff |
| [seed stripline-st] two-port-0 (PML, lossless, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 1.666e-4 | 0.00000 | 0.00403372 | worst /S21 - S12/ over the band |
| [seed stripline-st] two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00404768 | excess over 1, worst over the band (largest 0.99702); truncation at 60.0 dB + roundoff |
| [seed stripline-st] two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 2.516e-4 | 0.00000 | 0.00404768 | worst /S21 - S12/ over the band |
| [seed stripline-st] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a mirror in x | pass | 1.881e-6 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed stripline-st] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a 90 degree rotation | **FAIL** |  |  |  | the transformed mesh does not map onto the original (mesher not equivariant) |
| [seed stripline-st] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a sub-cell translation | pass | 0.00000 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed stripline-st] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under scaling with the mesh | pass | 2.080e-6 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed stripline-st] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under reversed port order | pass | 3.511e-16 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed c60001001e10] two-port-0 (PML, lossless, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00402796 | excess over 1, worst over the band (largest 0.99839); truncation at 60.0 dB + roundoff |
| [seed c60001001e10] two-port-0 (PML, lossless, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 0.00222947 | 0.00000 | 0.00402796 | worst /S21 - S12/ over the band |
| [seed c60001001e10] two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00404043 | excess over 1, worst over the band (largest 0.97025); truncation at 60.0 dB + roundoff |
| [seed c60001001e10] two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 5.196e-4 | 0.00000 | 0.00404043 | worst /S21 - S12/ over the band |
| [seed c60001001e10] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a mirror in x | pass | 4.016e-6 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed c60001001e10] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a 90 degree rotation | **FAIL** |  |  |  | the transformed mesh does not map onto the original (mesher not equivariant) |
| [seed c60001001e10] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a sub-cell translation | pass | 4.927e-14 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed c60001001e10] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under scaling with the mesh | pass | 4.552e-6 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| [seed c60001001e10] two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under reversed port order | pass | 3.511e-16 | 0.00000 | 3.265e-5 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
