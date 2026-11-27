# SMA connector vs lumped port, openEMS 1/3–2/3 rule: results

Graded against the limits in [README.md](README.md), committed before the runs
(1b12e4f). Computed by [`compare.py`](compare.py); raw data in
`docs/validation/data/openems_coaxfeed_<feed>_r<res>_thirds.csv/.json`, the
table in [`compare.json`](compare.json). Runs Nov 27, 2026, openEMS v0.37.

**Verdict: all three graded quantities pass.** With openEMS meshed by its own
1/3–2/3 rule, NobuRF (0.25 mm, 6 substrate cells) lands on the same f0 for
both feeds, and the connector's capacitive shift agrees within 1.3 Ω.

| Quantity | NobuRF 0.25 mm, 6 cells | NobuRF 0.5 mm, 3 cells | openEMS 0.25 mm, thirds | openEMS 0.125 mm, thirds | openEMS 0.25 mm, on edges (Nov 19) | openEMS 0.125 mm, on edges (Nov 19) |
| --- | --- | --- | --- | --- | --- | --- |
| Lumped port: f0, S11 min | 5.57 GHz, −9.1 dB | 5.56 GHz, −9.2 dB | 5.53 GHz, −10.6 dB | 5.57 GHz, −9.0 dB | 5.46 GHz, −9.4 dB | 5.52 GHz, −8.7 dB |
| SMA at the flange: f0, S11 min | 5.52 GHz, −28.2 dB | 5.51 GHz, −29.5 dB | 5.52 GHz, −28.6 dB | 5.52 GHz, −30.0 dB | 5.46 GHz, −18.5 dB | 5.49 GHz, −22.6 dB |
| Im Z_in SMA minus lumped, 5.0–5.5 GHz: range (mean) | −32 to −27 Ω (−30.7) | −32 to −28 Ω (−30.7) | −26 to −21 Ω (−24.7) | −33 to −29 Ω (−32.0) | −23 to −19 Ω (−21.7) | −31 to −26 Ω (−29.5) |

## Graded (NobuRF 0.25 mm against openEMS 0.125 mm, thirds)

| Quantity | Difference | Limit | Verdict |
| --- | --- | --- | --- |
| f0, lumped port | 0.0 % (5.57 vs 5.57 GHz) | 1 % | pass |
| f0, SMA at the flange | 0.0 % (5.52 vs 5.52 GHz) | 1 % | pass |
| Mean Im Z_in shift, 5.0–5.5 GHz | +1.3 Ω (−30.7 vs −32.0 Ω) | 5 Ω | pass |
| S11 minimum | −28.2 vs −30.0 dB (SMA), −9.1 vs −9.0 dB (lumped) | not graded | — |

The frequency grid is 0.01 GHz in both codes, so "0.0 %" means the same grid
point (agreement within about ±0.1 %).

## Convergence of the reference

openEMS from 0.25 to 0.125 mm with the thirds rule: lumped f0 5.53 → 5.57 GHz
(+0.7 %), SMA f0 5.52 → 5.52 GHz (0.0 %). Both are inside the pre-registered
1 %, so the reference counts as converged. The Im Z shift moves from −24.7 to
−32.0 Ω mean, so the shift is the least converged quantity; at 0.125 mm it
sits 1.3 Ω beyond NobuRF.

## What changed from the section 3.2 table

- Meshing openEMS by its own rule moves its resonances up by 0.03 to
  0.05 GHz (0.5 to 0.9 %) at 0.125 mm, the same direction and size as
  section 3.1 found on the patch. The section 3.2 gap (NobuRF 0.9 % and
  0.5 % above openEMS at 0.125 mm) was openEMS's edge rule, not NobuRF.
- The connector still moves the dip down by 0.05 GHz in both codes at their
  finest meshes (5.57 → 5.52 GHz).
- The dip depths now agree too (−28 to −30 dB with the SMA), but the
  README did not grade depth and the 0.25 mm openEMS lumped run shows it
  still moves by 1.6 dB with the mesh.

## Run times

openEMS on 4 threads, sharing the 4-core laptop with four single-thread
NobuRF helix solves, so these are about 7 to 16 times the Nov 19 wall times:

| Run | Cells | Wall time |
| --- | --- | --- |
| Lumped, 0.25 mm | 0.60 M | 9 min |
| SMA, 0.25 mm | 1.36 M | 22 min |
| Lumped, 0.125 mm | 2.42 M | 41 min |
| SMA, 0.125 mm | 7.16 M | 2 h 25 min |
