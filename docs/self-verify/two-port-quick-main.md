# NobuRF self-verification, quick tier

> Run before harness change 7 (docs/self-verify.md). Under the current rules the 90 degree rotation check below is a fail, not inconclusive, because a mesh that does not map now fails.

Seed `c60001001e10850132c6f89058232480c6c8780a`. 9 checks: 8 pass, 0 fail, 1 inconclusive.

## two-port (326 s)

| Case | Check | Verdict | Measured | Expected | Tolerance | Note |
|---|---|---|---|---|---|---|
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00431540 | excess over 1, worst over the band (largest 0.99865); truncation at 60.0 dB + roundoff |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 0.00238260 | 0.00000 | 0.00431540 | worst /S21 - S12/ over the band |
| two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | passivity: largest singular value of S <= 1 | pass | 0.00000 | 0.00000 | 0.00439537 | excess over 1, worst over the band (largest 0.97099); truncation at 60.0 dB + roundoff |
| two-port-lossy-0 (PML, lossy, 1 dielectric layer(s)) | reciprocity S21 = S12 | pass | 4.996e-4 | 0.00000 | 0.00439537 | worst /S21 - S12/ over the band |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a mirror in x | pass | 3.654e-6 | 0.00000 | 3.265e-4 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a 90 degree rotation | *inconclusive* |  |  |  | the transformed mesh does not map onto the original, so the discrete problems differ and no band is available to judge them |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under a sub-cell translation | pass | 0.00000 | 0.00000 | 3.265e-4 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under scaling with the mesh | pass | 3.872e-6 | 0.00000 | 3.265e-4 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
| two-port-0 (PML, lossless, 1 dielectric layer(s)) | S under reversed port order | pass | 3.366e-16 | 0.00000 | 3.265e-4 | worst /dS/ over the band and all entries, both runs 3000 steps; same discrete problem, roundoff only |
