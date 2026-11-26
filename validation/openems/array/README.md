# Array far field against openEMS

This compares NobuRF's array far field (`outputs.array_excitation`, see
[docs/project-file.md](../../../docs/project-file.md)) with openEMS on the same two
arrays. The cases, the quantities and the pass limits below were written and
committed before either solver was run on these files.

## How the two solvers differ here

NobuRF solves one run per port, each with the other ports as matched loads, and
sums the runs' near fields weighted by the drives. openEMS drives both ports at
once in a single run, so its result does not rely on superposition. Its far
field comes from its own near-to-far transform (`CreateNF2FFBox`,
`CalcNF2FF`), and its active reflection from its own port waves
(`uf_ref / uf_inc` on each port with both excited).

Both solvers read the same project files in this folder. openEMS draws them
with `validation/openems/refset/project_to_openems.py` (its structure, mesh
ladder level 1 and lumped ports), with two changes for the far field: a wider
air margin (30 mm on every side) so the near-to-far box sits clear of the
PML, and the box itself 10 mm outside the board.

## Cases

| Array | File | Frequency | Drives |
| --- | --- | --- | --- |
| Two short dipoles (10 mm, 8 x 8 mm end plates), 50 mm apart along x | `dipole_pair.json` | 3 GHz | in phase (1, 0°; 1, 0°) and in antiphase (1, 0°; 1, 180°) |
| Two inset-fed patches on 1.5 mm lossless FR-4 (eps_r 4.4), 26 mm apart along x | `patch_pair.json` | 5.8 GHz | the same two |

In openEMS, antiphase is the second port excited at amplitude −1.

## Quantities and pass limits

For each array and each drive set:

1. **Peak directivity:** within 0.5 dB.
2. **Peak direction:** within 10° (both on a 5° theta and phi grid).
3. **Pattern:** in the phi 0° and phi 90° cuts, over the directions where both
   solvers are within 15 dB of their own peak, the largest difference in
   directivity is at most 1.5 dB.
4. **Radiation efficiency** (radiated over accepted power; both arrays are
   lossless): within 0.03.
5. **Active reflection magnitude** |b/a| at each port: within 0.1 (linear).

A miss on 5 alone is first compared with the two solvers' one-port reflection
on the same element, since their lumped port models are known to differ
(docs/validation.md section 3); that is reported with the result, not used to
change the limit. No solver setting is changed after the first comparison,
with one exception, described under Results: the energy stop was raised
from 50 to 70 dB for the second run.

## Files

- `dipole_pair.json`, `patch_pair.json`: the arrays.
- `noburf_array.ts`: solves each file once with NobuRF (CPU) and writes
  `results/<name>_noburf.json` for every drive set.
- `array_openems.py`: one openEMS run per drive set, writes
  `results/<name>_openems.json`.
- `compare.py`: applies the limits above and writes `results/summary.md`.

## Results

### Second run: NobuRF stopped at 70 dB (Nov 24 2026)

The full table of this run is in [results/summary.md](results/summary.md);
the first run's table is in git history.

After the first run, a check of NobuRF's own power balance, independent of
openEMS, showed that its 50 dB energy stop leaves the radiation efficiency
rippling across frequency (0.945 to 1.038 on the dipole pair from 2.2 to
3.8 GHz) and that it settles when the run goes on longer (0.990 to 0.998 at
70 dB, 0.996 to 0.997 at 90 dB). Both projects now stop at 70 dB
(`analysis.stop.energy_decay_db`; the patch pair's `max_steps` went from
20000 to 50000, since it needs about 38000 steps). No limit, no solver code
and no openEMS input changed. openEMS keeps its 60 dB stop; a dipole pair
openEMS run at 80 dB gave 1.075 and 1.082, the same efficiencies as at
60 dB, so its results were not rerun.

- **Patch pair:** all 12 checks still pass. Efficiency 1.0005 in phase and
  1.0002 in antiphase. A lossless patch should read 1; NobuRF's
  efficiency is good to about ±0.5 % (docs/project-file.md, Far field), so
  these are within its error.
- **Dipole pair:** 8 of 12 pass. Directivity, the cuts and |b/a| pass as
  before. Four checks fail:
  - Radiation efficiency, both drive sets (0.997 / 1.076 and 0.995 / 1.082).
    NobuRF now reads within 0.5 % of 1; the miss is openEMS's reading over 1.
  - Peak direction, in phase: (90, 270) / (90, 90), 180°. NobuRF's two
    broadside lobes at phi 90° and 270° are equal to 0.0001 dB, and with the
    longer run its maximum landed on the other one. openEMS's two lobes are
    equal too.
  - Peak direction, antiphase: (90, 180) / (90, 190), 10°. The two
    directions are one grid step apart, exactly the limit, but the angle
    computes as 10.000000000000012° and the check reads it as over. That is
    floating-point rounding in `compare.py`, left as written so the check
    is not changed after seeing a result.

### First run: NobuRF stopped at 50 dB (Nov 24 2026)

openEMS v0.37.

- **Patch pair:** all 12 checks pass in both drive sets. Peak directivity
  agrees within 0.03 dB, the antiphase beam points to theta 40° in both, the
  cuts agree within 0.18 dB, and |b/a| within 0.03.
- **Dipole pair:** 9 of 12 pass. Directivity (within 0.30 dB), the cuts
  (within 0.37 dB) and |b/a| (within 0.005) pass. Three checks fail:
  - Radiation efficiency, both drive sets (0.977 / 1.076 and 0.998 / 1.082).
    openEMS reads more than 1 for a lossless antenna, so the miss is not
    NobuRF's alone. These short dipoles reflect most of the incident power
    (|b/a| about 0.9), so accepted power is the small difference of two large
    ones: an error of 0.005 in |b/a| moves it by about 6 %.
  - Peak direction, antiphase. Both solvers give two equal endfire lobes, at
    phi 0° and 180°, equal within 0.01 dB in each solver. NobuRF's maximum
    falls on phi 0°, openEMS's on phi 190°, the other lobe. openEMS's lobe at
    phi 10° is within 0.004 dB of its maximum and 10° from NobuRF's. The rule
    compares the two maxima, so this stays a fail as written.
