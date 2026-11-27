# SMA connector vs lumped port: openEMS with its 1/3–2/3 edge rule

Pre-registration, committed before any of the runs below. Nothing here
(reference, tolerance, mesh or NobuRF setting) is changed after a result is
seen. Results go in `results.md` in this folder.

## Why

[docs/validation.md](../../../docs/validation.md) section 3.2 compares NobuRF's
modelled SMA against openEMS's `CoaxialPort` on the inset patch with its feed
run to the board edge. Those openEMS runs (Nov 19) put mesh lines on the drawn
copper edges, and section 3.1 shows that rule reads about 1 % low on this
patch. This rerun meshes openEMS by its own advice for zero-thickness metal: a
line a third of a cell inside each copper edge and one two thirds outside.

## What runs

openEMS v0.37, [`coax_feed_openems.py`](../coax_feed_openems.py) with the new
`--edges thirds` option, which reuses `copper_edge_lines()` from
[`patch_openems.py`](../patch_openems.py) (the same helper section 3.1 used).
Everything else is unchanged from the Nov 19 runs: PEC copper, lossless FR-4
(εr 4.4, 1.5 mm), 20 mm of air, 8-cell PML, −50 dB energy stop, 4 to 8 GHz,
401 points.

```bash
python coax_feed_openems.py --feed lumped --res 0.25 --edges thirds
python coax_feed_openems.py --feed coax   --res 0.25 --edges thirds
python coax_feed_openems.py --feed lumped --res 0.125 --edges thirds
python coax_feed_openems.py --feed coax   --res 0.125 --edges thirds
```

Output: `docs/validation/data/openems_coaxfeed_<feed>_r<res>_thirds.csv/.json`.

NobuRF is not rerun. Its data is already on the branch
(`docs/validation/data/coax_feed/inset4_e0.25_d6_*.json` and
`inset4_e0.5_d3_*.json`, rerun Nov 27 on main 3d830a7).

## Quantities

Computed by [`compare.py`](compare.py), the same way as the section 3.2 table
(it reproduces that table from the Nov 19 files exactly):

1. f0 (S11 minimum frequency) and S11 minimum, each feed, each run.
2. Im Z_in(SMA) − Im Z_in(lumped) over 5.0 to 5.5 GHz on a 0.01 GHz grid
   (linear interpolation): its minimum, maximum and mean.

## Pass limits

Reference: openEMS at 0.125 mm with the 1/3–2/3 rule. Device under test:
NobuRF at 0.25 mm with 6 substrate cells (the finer NobuRF mesh). The 0.5 mm
NobuRF mesh and openEMS at 0.25 mm are reported alongside, not graded.

| Quantity | Limit |
| --- | --- |
| f0, lumped port | within 1 % |
| f0, SMA at the flange | within 1 % |
| Mean Im Z_in shift (SMA minus lumped), 5.0–5.5 GHz | within 5 Ω |
| S11 minimum | reported, not graded: section 3.2 shows the dip depth swings by 4 dB between openEMS meshes |

Convergence of the reference is reported as the change from 0.25 to 0.125 mm.
If openEMS's f0 moves by more than 1 % between the two, the reference is
flagged as not converged and the f0 verdicts are stated with that caveat.
