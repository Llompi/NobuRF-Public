# Vias

A via is a plated hole from one copper layer to another: a ground stitch,
the short at the end of a stub, a fence beside a grounded coplanar line, a
signal changing layers. The project file's format is in
[project-file.md](project-file.md#vias). This page covers how a via is
meshed and how close it comes to exact references.

## How a via is meshed

The barrel is solid metal of the drill's diameter. On the grid, every node
inside the drill (rim included) is a column of perfect-conductor Ez edges
from one layer to the other, and the x and y edges between two of those
nodes are metal too. The barrel joins any copper it touches on the way,
unless an `antipad` cuts a clearance in the layers in between. Both ends
must land on copper.

On a graded mesh the via asks for mesh lines on its center, on its rim
when the drill is at least one `edge_cell` wide, and on its antipad's rim.
A fence's vias take center lines only, so a long row does not grade the
whole board down to `edge_cell`. That makes the barrel's
width exact along x and y without shrinking the smallest cell below half an
`edge_cell`. A drill that holds only one mesh node (narrower than the cells around it,
or up to two cells wide when its rim falls between nodes, as on a uniform
mesh or in a fence) is that one column. Its width follows the cells, not
the drill: on a graded 0.2 mm mesh it behaved like a post 0.29 of a cell
in radius (measured below; on a uniform lattice a single node is often
quoted nearer 0.2 of a cell, which has not been measured here). The solve
warns and names the via whenever it is one column.

## Exact reference: two posts between parallel plates

Between two parallel plates the field of a vertical post is two-dimensional,
so a via and the port, d apart between plates h apart, form a loop of
inductance

    L = (μ0 h / 2π) acosh((d² − r1² − r2²) / (2 r1 r2)).

The port's own radius is not known, but it cancels: changing only the drill
from r_a to r_b changes L by (μ0 h / 2π) ln(((d² − r_b²) r_a) / ((d² − r_a²) r_b))
for a port much thinner than d. [`scripts/validate/vias.ts`](../scripts/validate/vias.ts)
`post` solves a 20 × 20 mm pair of PEC plates 1 mm apart, the port and the
via 5 mm apart, and reads L from the susceptance at 0.1 to 1 GHz (B ω =
−1/L + ω² C, which takes out the plates' capacitance). The reference drill
is 1.6 mm, 8 to 16 cells across. The closed form is for infinite plates;
the solved plates are finite and end in PML, which changes L itself, but
that change is nearly the same for both drills and largely cancels in ΔL.
The check covers single vias on a graded mesh, where the rim gets mesh
lines. A fence's vias and a via on a uniform mesh have no rim lines, so a
drill up to two cells wide can be one column (see above).

| Edge cell | Drill | Cells across | ΔL NobuRF | ΔL exact | Error |
|---|---|---|---|---|---|
| 0.2 mm | 0.8 mm | 4 | 0.137 nH | 0.143 nH | −0.006 nH |
| 0.2 mm | 0.4 mm | 2 | 0.261 nH | 0.282 nH | −0.021 nH |
| 0.2 mm | 0.2 mm | 2 half cells | 0.436 nH | 0.421 nH | +0.015 nH |
| 0.2 mm | 0.15 mm | one column | 0.531 nH | 0.479 nH | +0.053 nH |
| 0.2 mm | 0.1 mm | one column | 0.531 nH | 0.560 nH | −0.029 nH |
| 0.2 mm | 0.05 mm | one column | 0.531 nH | 0.698 nH | −0.167 nH |
| 0.1 mm | 0.4 mm | 4 | 0.287 nH | 0.282 nH | +0.005 nH |
| 0.1 mm | 0.2 mm | 2 | 0.402 nH | 0.421 nH | −0.019 nH |
| 0.1 mm | 0.1 mm | 2 half cells | 0.576 nH | 0.560 nH | +0.016 nH |

A drill at least one edge cell wide is within 0.021 nH of the exact change:
up to 8 % of the change, and about 1.5 % of the 1.4 nH loop. The three one-column rows all read the same
0.531 nH, which is the same post whatever the drill. Its radius is about
0.058 mm on 0.2 mm cells, 0.29 of a cell. Halving the cells on the
reference drill moves its absolute L by 0.130 nH, against 0.139 nH for a
port post that is 0.29 of the cell in radius. That is a check that the
port's own post scales the same way.

Data: [`docs/validation/data/vias.json`](validation/data/vias.json) (`post`).

## A via at the end of a microstrip

`short` solves a 50 Ω microstrip (ε_r 3.55, h 0.813 mm, strip 1.8 mm)
ended by one via to ground, the strip running 0.6 mm past the via center.
The port is de-embedded ([deembedding.md](deembedding.md)) to a plane 3 mm
before the via. The load is moved to the via center along the kit's own
line (its impedance and effective permittivity), and its reactance is read
as an inductance. [`validation/openems/via_openems.py`](../validation/openems/via_openems.py)
builds the same board in openEMS with an MSL port, a cylinder for the via
on 0.025 mm cells, and the same transform with the port's Z0 and β.

| Drill | Edge cell | L at 1 GHz | 2 GHz | 4 GHz | 8 GHz |
|---|---|---|---|---|---|
| 0.2 mm | 0.1 mm | 0.332 nH | 0.324 nH | 0.326 nH | 0.326 nH |
| 0.4 mm | 0.1 mm | 0.229 nH | 0.221 nH | 0.221 nH | 0.215 nH |
| 0.4 mm | 0.05 mm | 0.227 nH | 0.221 nH | 0.213 nH | 0.213 nH |
| 0.8 mm | 0.1 mm | 0.102 nH | 0.092 nH | 0.088 nH | 0.085 nH |

The via reads as a near-constant inductance across the band, as it should,
and halving the mesh moves the 0.4 mm via by under 0.01 nH.

openEMS (v0.37.0, the same board, 0.025 mm cells at the via, 0.1 mm at the
strip edges):

| Drill | L at 2 GHz, NobuRF | openEMS | Difference | openEMS line εeff at 2 GHz |
|---|---|---|---|---|
| 0.2 mm | 0.324 nH | 0.301 nH | +0.023 nH | 2.898 |
| 0.4 mm | 0.221 nH | 0.178 nH | +0.043 nH | 2.900 |
| 0.8 mm | 0.092 nH | 0.053 nH | +0.039 nH | 2.908 |

openEMS's own mesh checks on the 0.4 mm via: 0.0125 mm cells at the via
give 0.179 nH, 0.05 mm cells at the strip edges give 0.180 nH (εeff
2.903), and 12 cells across the substrate instead of 6 give 0.177 nH (εeff
2.898). Both codes are settled on their meshes, so the gap is not mesh
noise. The change between drills agrees better: 0.2 to 0.8 mm is −0.232 nH
in NobuRF and −0.248 nH in openEMS.

NobuRF reads 0.02 to 0.04 nH higher, which is 8 % on the thinnest via and
most of the value on the widest one. Three checks on NobuRF's side
(`short_checks` in the data):

| Change | Drill | L at 2 GHz | Against the base case |
|---|---|---|---|
| 0.05 mm cells at the via | 0.8 mm | 0.097 nH | +0.005 nH |
| 12 cells across the substrate | 0.4 mm | 0.221 nH | 0.000 nH |
| Plane 6 mm before the via | 0.4 mm | 0.221 nH | 0.000 nH |

The barrel's staircase is not the cause. Finer cells at the via give the
grid a rounder barrel, and the 0.8 mm via, where the gap is largest
against its value, moves 0.005 nH away from openEMS, not toward it. The
0.4 mm via does not move with finer cells at the via (the table above) or
across the substrate. openEMS's cylinder is itself drawn on its grid, at
0.025 mm cells, and halving those moves it by 0.001 nH. Neither the
strip's turn into the via nor the substrate's cells explain it either.

What remains is the line both codes move the load along. Moving the plane
from 3 mm to 6 mm leaves NobuRF's reading unchanged, so its kit line and
its load agree with each other. openEMS's port reads the line's εeff as
2.90 on every mesh tried, 4 % above Hammerstad–Jensen (2.78) and NobuRF's
kit (2.80). If its line is in fact the closed form's, its move takes about
0.017 nH too much off at 2 GHz. The rest, about 0.01 to 0.025 nH, is not
explained yet. The next test is openEMS with its plane at 6 mm: if its
reading moves, its port's β is the cause. Treat via inductance as good to
about 0.04 nH for now; improvements in progress.

The reading
includes the strip's turn into the via and the 0.6 mm of strip past it, so
it is larger than a formula for the barrel alone (Goldfarb and Pucel give
0.15 nH for the 0.4 mm drill).

Data: [`docs/validation/data/vias.json`](validation/data/vias.json) (`short`, `short_checks`, `short_openems`).

## Limits

- **Lossless barrels.** A via is a perfect conductor. Copper loss is on the
  layers only, so the loss of a long via chain is low.
- **Sub-cell drills** are one column of edges (above). Refine `edge_cell`
  to resolve the drill.
- **Antipads read slightly small.** The antipad's rim keeps its drawn mesh
  line, and copper is painted on the nodes up to it, so the clearance acts
  about a third of a cell narrower on each side than drawn. Refine
  `edge_cell` where that matters.
- **No pad check.** A drill wider than the pad or trace it lands on is
  accepted as long as both ends touch copper.
- **No SMA connector or coax probe** in a project with vias yet: the
  connector repaints the copper around it.
- **Back-drilling and stubs inside the board** are not modelled: a via runs
  from one named layer to the other. A via that stops at an inner layer is
  a via `between` that layer and an outer one.
