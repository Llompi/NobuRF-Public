# Gonzaga open helix, NobuRF vs openEMS: results

Graded against the limits in [README.md](README.md), committed before either
solver ran (1b12e4f). Computed by [`compare.py`](compare.py); raw data in
[`results/`](results/) (`compare.json` holds every number below). Runs
Nov 27, 2026: openEMS v0.37, NobuRF on this branch at 1b12e4f (main plus docs),
CPU reference solver. PEC copper and a lossless disk in both codes.

## Verdict

- **Pattern quantities pass for both NobuRF arm models.** Azimuth RHCP gain
  agrees within 0.03 dB, mean axial ratio within 0.3 dB, and both codes say
  RHCP.
- **Sheet arms:** f0 (−0.3 %) and bandwidth (+8 %) pass. Z_in at 915 MHz
  (17.8 % of |Z|) and the dip depth (6.1 dB) fail.
- **Staircase arms:** f0 fails (−2.2 %), bandwidth passes (+6 %), and Z_in at
  915 MHz (47 %) and the dip depth (5.7 dB) fail.
- **The reference is not converged.** openEMS's f0 moved +2.2 % from 1 mm to
  0.5 mm, past the 1 % the README set, so every f0 and bandwidth verdict
  carries that caveat. Its Z_in at 915 MHz moved by 27 Ω between the two meshes,
  more than any NobuRF-to-openEMS difference graded here. No third openEMS mesh
  was added after seeing this, as the README requires.

## All runs

| Quantity | openEMS 1 mm | openEMS 0.5 mm (reference) | NobuRF staircase 1 mm | NobuRF sheet 1 mm | NobuRF staircase 0.7 mm | NobuRF sheet 0.7 mm |
| --- | --- | --- | --- | --- | --- | --- |
| f0 (S11 minimum) | 921 MHz | 941 MHz | 920 MHz | 938 MHz | 928 MHz | 943 MHz |
| S11 minimum | −12.6 dB | −13.4 dB | −19.2 dB | −19.6 dB | −16.5 dB | −17.8 dB |
| −10 dB band | 900–943 MHz | 917–966 MHz | 895–947 MHz | 912–965 MHz | 902–954 MHz | 916–971 MHz |
| −10 dB bandwidth | 43 MHz | 49 MHz | 52 MHz | 53 MHz | 52 MHz | 55 MHz |
| Z_in at 915 MHz | 68.6 + j22.6 Ω | 42.2 + j31.2 Ω | 57.1 + j11.7 Ω | 38.6 + j22.6 Ω | 53.0 + j21.3 Ω | 35.7 + j24.8 Ω |
| Azimuth RHCP gain, 915 MHz | 1.59 dBi | 1.56 dBi | 1.59 dBi | 1.57 dBi | 1.59 dBi | 1.57 dBi |
| Azimuth LHCP gain, 915 MHz | −13.8 dBi | −13.0 dBi | −13.6 dBi | −12.9 dBi | −13.4 dBi | −12.8 dBi |
| Mean axial ratio, 915 MHz | 2.98 dB | 3.30 dB | 3.04 dB | 3.32 dB | 3.11 dB | 3.37 dB |
| Radiation efficiency | 0.996 | 0.997 | 0.996 | 0.997 | 0.996 | 0.998 |
| Cells | 1.12 M | 4.13 M | 1.49 M | 1.54 M | 2.67 M | 2.79 M |
| Wall time | 14 min | 35 min | 50 min | 1 h 54 min | 2 h 37 min | 4 h 1 min |

## Graded: NobuRF 1 mm against openEMS 0.5 mm

| Quantity | Limit | Staircase arms | | Sheet arms | |
| --- | --- | --- | --- | --- | --- |
| S11-minimum frequency | 1 % | −2.23 % | **fail** | −0.32 % | pass |
| −10 dB bandwidth | 10 % | +6.1 % | pass | +8.2 % | pass |
| S11 minimum | 3 dB | −5.7 dB | **fail** | −6.1 dB | **fail** |
| Z_in at 915 MHz | 10 % of \|Z\| | 24.5 Ω = 46.7 % | **fail** | 9.3 Ω = 17.8 % | **fail** |
| Azimuth RHCP gain, 915 MHz | 0.5 dB | +0.03 dB | pass | +0.01 dB | pass |
| Mean axial ratio, 915 MHz | 1 dB | −0.26 dB | pass | +0.02 dB | pass |
| Dominant sense | same | RHCP, RHCP | pass | RHCP, RHCP | pass |
| Reference converged (openEMS f0, 1 → 0.5 mm) | 1 % | +2.17 % | **not converged** | | |

The 0.7 mm NobuRF runs were reported, not graded. Against the same reference
they read f0 −1.4 % (staircase) and +0.2 % (sheet).

## What it shows

- **The staircase moves with the mesh in both codes, and the sheet does
  not.** openEMS's snapped-curve arms go 921 → 941 MHz from 1 to 0.5 mm, and
  NobuRF's staircase goes 920 → 928 MHz from 1 to 0.7 mm. NobuRF's conformal
  sheet arms read 938 → 943 MHz, and the openEMS staircase climbs towards
  them as its cells shrink. At 1 mm the two staircases agree (920 against
  921 MHz) even though they are built by different rules. A staircased curve
  acts larger than drawn, and both shrink towards the drawn cylinder as the
  cells shrink.
- **The far field is insensitive to all of this.** Gain and axial ratio agree
  within 0.3 dB across all six runs. Both codes confirm the benchmark page's
  reading: at this radius 10.5° gives about 3 dB axial ratio, not the 0 dB the
  paper designed for. This was the open question in gonzaga.md ("an independent
  solver ... would tell a NobuRF error apart from a geometry or physics
  difference"). openEMS agrees with NobuRF, so the 3 dB is not a NobuRF error.
- **Z_in at 915 MHz is not a stable figure here.** 915 MHz sits on the lower
  skirt of the resonance, where Z changes fast with f0: openEMS's own value
  moves by 27 Ω between its meshes. The sheet-arm Z at 915 MHz differs from
  openEMS 0.5 mm mostly in R (38.6 against 42.2 Ω) and X (22.6 against
  31.2 Ω). Both are within the change openEMS shows between its own meshes.
  The pre-registered limit stays a fail.
- **Dip depth: openEMS is shallower on both meshes** (−12.6 and −13.4 dB
  against −16 to −20 dB). This exceeds the loose 3 dB limit for every NobuRF
  run. One candidate is the feed. NobuRF's port carries mesh and loop
  corrections (`portMeshFactors`) for the column between the two traces,
  while openEMS's lumped port is a plain edge source over four 0.4 mm cells.
  At these impedances (40 to 70 Ω) a few ohms of port reactance moves the
  depth by several dB. Not tested here.

## Limits of this comparison

- openEMS draws the arms as a staircase (README, "How openEMS draws the
  arms"): a zero-thickness curved sheet cannot be given to openEMS on a
  Cartesian grid. The reference therefore carries a staircase error, which
  its mesh study shows to be at least 2 % in f0 at 1 mm.
- Only two openEMS meshes. A 0.35 mm run (about 11 M cells) would show
  whether openEMS settles at the sheet arms' 940 MHz. It would be a new
  pre-registration, not a change to this one.
- All runs shared a 4-core laptop. openEMS ran on 4 threads, and NobuRF ran
  four single-thread processes at once, so wall times are not a speed
  comparison.
