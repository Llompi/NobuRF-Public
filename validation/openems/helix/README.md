# Gonzaga open helix: NobuRF vs openEMS

Pre-registration, committed before either solver runs. The quantities, pass
limits, meshes and settings below are fixed here; none is changed after a
result is seen. Results go in `results.md`, raw data in `results/`.

This is the first cross-check of NobuRF on a curved 3D conductor. The
antenna and NobuRF's results are in
[docs/benchmarks/gonzaga.md](../../../docs/benchmarks/gonzaga.md); the
geometry is built by
[scripts/validate/open_helix_model.ts](../../../scripts/validate/open_helix_model.ts).

## The model, the same in both codes

Every dimension is taken from the defaults in
[scripts/validate/gonzaga_helix.ts](../../../scripts/validate/gonzaga_helix.ts):

| Item | Value |
| --- | --- |
| Helix radius R | 23.6 mm |
| Pitch angle | 10.5° |
| Arm width (across the strip) | 14.6 mm, so 14.85 mm along z |
| Arm wrap | 170° per arm |
| Disk trace width | 4.0 mm, across the full diameter on both faces |
| Disk | radius R, 1.6 mm thick, εr 4.4 |
| Feed | 50 Ω lumped port on the axis between the two traces |

**PEC copper and a lossless disk in both codes** (NobuRF `--copper 0
--disk-tand 0`). Loss is left out so the comparison tests the fields and the
geometry, not two loss models.

Arm outline, as `onUpperArmA` in the NobuRF builder: upper arm A starts at
φ = −(w/2)/R. Over its first w/R radians (the trace end) its lower edge stays
on the disk face; after that it climbs at the pitch angle. Its ends are cut
along the axis. The other three arms are A turned 180° about x, about z and
about y.

## How openEMS draws the arms

openEMS's FDTD grid here is Cartesian. Before writing this file the arms were
tried four ways, each checked with openEMS's own PEC dump
(`helix_openems.py --check`, setup only, `debug_PEC`):

| Drawing | Result on the 1 mm mesh |
| --- | --- |
| Polygon in cylindrical coordinates at r = R, zero thickness (the preferred route) | No metal at all. CSXCAD: "CSPrimPolygon can not be defined in non Cartesian coordinate systems", then "Unused primitive" for every arm |
| Zero-thickness boxes in cylindrical coordinates (one per thin φ slice) | No metal: "Unused primitive" |
| The polygon extruded across r from R − 0.05 to R + 0.05 mm (a closed 0.1 mm shell, the fallback) | 3 % of the arm area gets metal. openEMS marks an edge as metal when its midpoint is inside a solid, and a 0.1 mm shell catches almost no midpoints of a 1 mm grid. The arms would be mostly holes |
| A grid of curves on each arm (`AddCurve`), no more than half a cell apart, lines along z and arcs at constant z, plus the outline | 100 % of the arm area covered; metal edges within 0.6 mm of r = R at 1 mm (0.3 mm at 0.5 mm) |

The 0.1 mm shell is not usable on any mesh that fits this machine, so the
**arms are drawn as a curve grid**. openEMS snaps every curve onto the mesh and
marks the edges along the snapped path as metal (the way openEMS's
helical-antenna tutorial draws its wire). With curves at most half
a cell apart, every mesh node near the cylinder within the arm outline is on
a curve, so the metal is a closed staircase sheet of zero thickness that
follows r = R to within half a cell. The coverage check and
`results/structure_check.png` (every arm metal edge, unrolled to (φ, z),
coloured by its distance from r = R) show the four arms with no holes and the
feet on the traces. Each of the four arm-to-trace joints shares 5 mesh nodes
with its trace on the 1 mm mesh.

This is a staircase, not a conformal sheet. It is the same kind of model as
NobuRF's `staircase` arms (whole cell faces between inside and outside
cells), built by a different rule. It is not like NobuRF's `sheet` arms
(conformal thin sheets). gonzaga.md reports that the two NobuRF modes differ
by 1.7 % in f0 (925 vs 941 MHz at 1 mm, PEC), so the staircase alone can move
f0 by more than the 1 % limit below. The openEMS mesh study (1 mm and 0.5 mm)
shows how far its staircase moves.

The disk traces are drawn as polygons on the disk faces, |y| ≤ w/2, reaching
half a cell past the cylinder so they meet the arm's metal on the grid (as
NobuRF's sheet arms do). The trace edges at y = ±w/2 get openEMS's
1/3–2/3 rule (a line a third of a cell inside the copper, one two thirds
outside). The disk is an openEMS cylinder of εr 4.4.

## Settings

openEMS v0.37 ([`helix_openems.py`](helix_openems.py)):

- Cartesian mesh, `--res` cells over the antenna (the cylinder plus two
  cells, z to the arm tips plus two cells), 0.4 mm cells through the disk
  (four across), graded by at most 1.2 per cell to 5 mm cells, 100 mm of air
  to an 8-cell PML on all six sides.
- Gaussian excitation 0.7 to 1.1 GHz, 401 points; stop at −50 dB energy
  (`EndCriteria 1e-5`).
- Mesh study: **1 mm and 0.5 mm** (1.15 M and 4.2 M cells).
- Far field: openEMS NF2FF box 10 mm outside the antenna, 915 MHz, θ and φ
  every 2°. RHCP and LHCP are openEMS's own `E_cprh` and `E_cplh`
  ((E_θ ± jE_φ)/√2, the IEEE sense NobuRF uses). Partial gain of a hand =
  D_max × (P_rad / P_acc) × |E_hand|² / |E|²_max.

NobuRF (`scripts/validate/gonzaga_helix.ts`, current code on this branch,
which is main plus docs), CPU reference solver (the script has no GPU path):

```bash
npx tsx scripts/validate/gonzaga_helix.ts --copper 0 --disk-tand 0 --decay 50 --max-steps 150000 --cell 1.0 --out noburf_staircase_c1.json
npx tsx scripts/validate/gonzaga_helix.ts --copper 0 --disk-tand 0 --decay 50 --max-steps 150000 --cell 1.0 --sheet 1 --courant 0.3333 --out noburf_sheet_c1.json
```

and the same two at `--cell 0.7`, reported for NobuRF's own convergence but
not graded. All other options are the script's defaults (padding 100 mm,
10-cell CPML, coarse 4 mm, growth 1.2, 0.7 to 1.1 GHz, 401 points). The
energy stop is set to −50 dB to match openEMS (the benchmark page used −40).

## Quantities and pass limits

Reference: openEMS at 0.5 mm. Graded: NobuRF at 1 mm (the mesh the benchmark
page reports), staircase and sheet arms separately. All quantities are
computed by [`compare.py`](compare.py) from each code's S11/Z sweep and its
915 MHz azimuth cut (θ = 90°, φ every 2°).

| Quantity | Definition | Pass limit |
| --- | --- | --- |
| S11-minimum frequency f0 | argmin of S11 (50 Ω) on the 1 MHz grid | within 1 % |
| −10 dB bandwidth | highest minus lowest frequency with S11 ≤ −10 dB | within 10 % (relative) |
| S11 minimum | depth of the dip | within 3 dB |
| Z_in at 915 MHz | complex input impedance at the port | \|ΔZ\| within 10 % of \|Z_openEMS\| |
| Azimuth RHCP gain at 915 MHz | 10 log10 of the mean of the linear RHCP partial gain over φ | within 0.5 dB |
| Azimuth axial ratio at 915 MHz | mean over φ of the axial ratio in dB | within 1 dB |
| Dominant sense | the hand with the larger azimuth-mean gain | the same |

The S11 minimum limit is loose on purpose: gonzaga.md shows the dip depth
moving by 4 dB between NobuRF meshes, so it is graded only to catch a gross
disagreement.

Convergence of the reference: if openEMS's f0 moves by more than 1 % from
1 mm to 0.5 mm, the reference is reported as not converged, and every f0 and
bandwidth verdict is stated with that caveat. No third openEMS mesh is added
after seeing that result.
