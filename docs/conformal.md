# Conformal copper

A staircase mesh turns a slanted or curved copper edge into steps of whole
cells: an Ex or Ey edge is copper when its midpoint is. With
`"mesh": { ..., "conformal": true }`, each edge and face of a copper plane
instead takes the exact fraction of it the copper covers, so a circular patch
is a circle and a trace at 30 degrees is straight. Copper edges that lie on
mesh lines mesh exactly as before (a test checks the arrays are identical),
so the switch only changes slanted and curved edges and, on a uniform mesh,
axis-parallel edges that fall between mesh lines.

Code: [`src/project/coverage.ts`](../src/project/coverage.ts) (covered
fractions), [`src/engine/conformal.ts`](../src/engine/conformal.ts) (face
rule and the CPU pass), [`src/engine/shaders/conformal.wgsl`](../src/engine/shaders/conformal.wgsl)
(GPU pass), and the copper-plane part of [`src/project/rasterise.ts`](../src/project/rasterise.ts).

## Method

Dey and Mittra's conformal PEC scheme [1], [2, section 10.6], in the finite
integration form of partially filled cells [3]. Tangential E is zero on the
metal, so Faraday's law on a face sees only its free area, and only the free
length of each edge:

    mu * a_f * A * dH/dt = - sum over edges of (free length * E on the free part)

With `lambda` the free fraction of an edge and `a` the free fraction of a face,
and E stored as the edge voltage over the full edge length (as everywhere in
the solver), this is two changes:

1. **Edges.** A partly covered edge keeps its E update with its curl
   coefficient multiplied by `lambda` (it reads as permittivity eps/lambda).
   A wholly covered edge is PEC as before, and only those carry the copper
   surface resistance.
2. **Faces.** The H update of a face the copper cuts is divided by its free
   area. The main kernel is unchanged; a sparse pass after it adds
   `(1/a - 1)` times the same curl again, `h += sum(coef * e)` over the face's
   four edges.

The face pass runs after the CPML H pass and before the magnetic dispersion
update, on the CPU and the GPU alike: copper face loss, main H update, CPML,
conformal faces, then the dispersion update of magnetic faces. A cut face in a
magnetic material therefore divides its correction by mu like the rest of its
update. On a frequency-dependent substrate a partly covered edge is listed in
the dispersion pass with its medium scaled by `1/lambda`, eps(omega)/lambda,
because that pass recovers the full curl from the edge's (lambda-scaled)
curl coefficient; without the scaling a sliver patch on Djordjevic-Sarkar
FR-4 blows up within a few hundred steps (`tests/conformal.test.ts`).
Lumped components and ports need wholly covered copper at their pads and fail
on copper that only partly covers an edge across their gap or column.

Coverage is exact, not sampled. Along an edge the painted copper (shapes in
order, add and cut, clipped to the board) can change only where a polygon
segment crosses it, so the edge is cut at every crossing and the midpoint of
each piece is tested with the staircase rasteriser's own point test. A face's
covered area is the integral of the covered length of vertical lines across
it; cut at every vertex, every crossing with its top and bottom, and every
crossing of two segments, that length is linear on each piece and the midpoint
rule is exact. Faces no segment reaches are decided by their center.

## Stability

Dividing by a small `a` makes a face fast. Dey and Mittra reduce the time step
for it [1]; Benkler, Chavannes and Kuster enlarge the area used in the update
instead [4]. NobuRF does both, by a bounded amount: a model whose copper
partly covers any edge runs at Courant number 0.5 instead of 0.572 (14 % more
steps; copper wholly on mesh lines keeps 0.572 and identical arrays), and
each cut face uses an effective area `a_eff >= a` chosen so that a proof, not
a test, says the update is stable for any copper shape.

Write the update as the leapfrog of `A = M_eps^-1 C^T M_mu^-1 C` (C the curl
incidence, M the diagonal material matrices). Leapfrog is stable while
`Sc^2 * lambda_max(A) < 4` in units of the smallest cell. The uncut Yee
operator has `lambda_max <= 12` (graded cells and dielectrics only lower it),
which is where the 3D limit `Sc < 1/sqrt(3)` comes from and what the solver
already relies on. Take the budget `L = 0.98 * 4 / Sc^2` (12.0 at the default
Courant number, 15.7 at 0.5).

Conformal copper scales `M_eps` by `1/lambda` on partly covered edges and
`M_mu` by `a_eff` on cut faces. In symmetric form, with `y = Lambda^(1/2) x`
and B the uncut normalised curl,

    x^T A x = y^T B^T B y + sum_f Delta_f (B y)_f^2,             Delta_f = 1/a_eff - 1,
    L x^T x = 12 |y|^2 + (L - 12) |y|^2 + L sum_e y_e^2 (1/lambda_e - 1).

The first terms compare directly (`y^T B^T B y <= 12 |y|^2`). Give each free
edge its slack `s_e = (L - 12) + L (1/lambda_e - 1)`. By Cauchy-Schwarz with
weights `s_e`,

    (B y)_f^2 <= G_f * sum over the free edges e of f of s_e y_e^2,    G_f = sum of B_fe^2 / s_e,

where `B_fe^2` is 1 per edge in air on a uniform mesh and `1/eps_r` on a
dielectric interface. An edge borders at most two cut faces (the two in its
plane), so `lambda_max(A) <= L` whenever every cut face has

    2 * Delta_f * G_f <= 1.

`effectiveFreeArea` takes the smallest `a_eff >= a` that satisfies this. At the
default Courant number `L = 12`, a wholly free edge has no slack, and a face
with one could get no correction at all; that is why such models run at
0.5. There, the worst face, a sliver of 2 % free area along a whole edge with
air on both sides, is floored at an effective area of 0.35; faces cut more
evenly keep their true area.

Edges a later step repaints (a coax anti-pad cut through slanted copper) drop
their faces back to the plain update, which is always stable
(`activeConformalFaces`).

Checked by power iteration on the update itself (`tests/conformal.test.ts`):
the largest `Sc^2 lambda` stays below 4 for circles, turned strips and copper
edges 0.01 mm past mesh lines, on FR-4 and with air on both sides of the
copper. As a control, plain Dey-Mittra with a 10 % area floor reaches 5.9 on
the air sliver at the same Courant number, so the test does catch an unstable
rule.

## Validation

`scripts/validate/conformal_patch.ts`, CPU reference engine, probe-fed patches
on 1.5 mm of lossless eps_r 2.2 with PEC copper, resonance at the peak of
Re(Z_in). Raw results: [`docs/validation/data/conformal.json`](validation/data/conformal.json).

**Turned rectangle.** A 12 x 9 mm patch (TM01 near 9.4 GHz), turned about
its center. Turning changes nothing physical, so every angle should give the
unturned patch, whose edges lie on mesh lines. The graded mesh (lines on every
edge, half-size cells at the copper) is the reference.

| cell | unturned, uniform | unturned, graded | staircase 15 / 30 / 45 deg | conformal 15 / 30 / 45 deg |
|---|---|---|---|---|
| 0.5 mm | 9.240 GHz | 9.375 GHz | 9.087 / 9.043 / 9.032 | 9.403 / 9.393 / 9.389 |
| 0.25 mm | 9.406 GHz | 9.468 GHz | 9.342 (30 deg) | 9.473 (30 deg) |

Staircased, the turned patch reads 2.2 % low at 0.5 mm and 1.3 % low at
0.25 mm against the graded reference, and moves 0.6 % between angles.
Conformal, it is within 0.3 % of the graded reference at 0.5 mm and 0.05 % at
0.25 mm, and the three angles agree within 0.15 %.

**Circular patch.** Radius 8 mm (TM11), its center at (0, 0) and moved by
(0.21, 0.37) mm against the mesh, probe on the node at (3, 0) mm. Closed form
(Balanis eqs. 14-67 and 14-69): 6.726 GHz.

| cell | staircase (0,0) / moved | conformal (0,0) / moved |
|---|---|---|
| 0.75 mm | 6.406 / 6.415 | 6.568 / 6.562 |
| 0.5 mm | 6.493 / 6.492 | 6.599 / 6.607 |
| 0.375 mm | 6.561 / 6.507 | 6.625 / 6.634 |
| 0.25 mm | 6.584 / 6.579 | 6.645 / 6.650 |

Fitting f(h) = f_inf - C h^p to the four cells gives f_inf = 6.699 GHz,
p = 0.89 conformal and 6.700 GHz, p = 0.81 staircase: both converge to the
same answer, 0.4 % below the closed form (which Balanis gives as an
approximation). Conformal copper halves the error at every cell (0.8 % against
1.8 % at 0.25 mm, 1.5 % against 3.1 % at 0.5 mm), and moving the patch against
the mesh moves its result by at most 0.13 %, where the staircase moved 0.8 %
at 0.375 mm.

The order stays near 1, not 2. What is left is the error the patch has even
with its edges on mesh lines: the field is singular at the edge of a
zero-thickness sheet, and the substrate is only 2 to 6 cells thick here. The
turned rectangle shows that conformal copper removes the staircase error and
lands on the aligned result; it does not remove that one. Finer cells at the
copper are the lever for it.

## 3D solids

Copper planes cover only edges and faces in their own plane. A wire, a
sphere, a cylinder turned against the mesh or an imported 3D body cuts edges
and faces of all three orientations.
[`src/project/conformal_solids.ts`](../src/project/conformal_solids.ts) takes
such a body as a closed triangle surface and applies the same rule to it:
partly covered edges scale their curl by their free fraction, cut faces divide
their H update by their (effective) free area, and covered edges are PEC. The
CPU and GPU face passes already take any H component, so the engine is
unchanged.

**Coverage.** Every Yee edge and face lies in a mesh plane. The solid's section
in a plane is a set of polygons (each triangle the plane crosses gives a
segment, and a closed surface's segments close into loops), and
[`coverage.ts`](../src/project/coverage.ts) already integrates polygons
exactly over a plane's edges and faces. So `solidCoverage` slices the surface
at every mesh plane and hands the sections over: Ey, Ez and Hx from the x
planes, Ex and Hy from the y planes, Hz from the z planes. The result is exact
for the triangle surface (a test checks a sphere's sections against pi (R^2 -
z^2) to 1e-5 and a turned cylinder's volume to 1e-4; the rest is
tessellation, set by `segmentsForSag`). Two details matter:

- The surface counts as copper. Vertices on a plane are sliced twice, just
  below and just above it, and the two sections are unioned, so a face of the
  solid lying on a mesh plane makes that plane's edges PEC, as the staircase
  does, and a box on mesh lines meshes as the staircase box.
- A row through the point where two triangles share an edge must count that
  point once. Both triangles interpolate it from the edge's lower vertex
  index, so the two copies are bitwise equal. (Before that, a box's quad
  diagonal crossing a row turned the whole row inside out.)

Inside is decided by crossing parity per solid, so `joinMeshes` of a box and a
sphere is a box with a spherical hole (the cavities below), and several
solids are unioned.

**Stability: four faces per edge, not two.** The bound above shares each
free edge's slack between the cut faces that border it, and copper planes cut
at most two of an edge's four faces (the two in their plane), hence the 2 in
`2 * Delta_f * G_f <= 1`. A 3D solid can cut all four. Summing the
Cauchy-Schwarz bounds over faces, the requirement for edge e is

    sum over cut faces f containing e of Delta_f * G_f <= 1,

so a face now uses `m * Delta_f * G_f <= 1`, with m the most cut faces any of
its free edges borders (`effectiveFreeArea`'s `sharing`; the copper planes
keep 2). This is not academic: with the two-face rule a cylinder turned
against the mesh reaches `Sc^2 lambda = 4.72` by power iteration at Courant
0.5, past the limit of 4; with the counted rule it stays at 2.91 (one-off
runs; the test checks the counted rule stays below 4).

**Courant number.** Splitting the slack four ways raises many effective
areas, and a raised area moves the wall. At Courant 0.5 a sphere cavity reads
1.5 % low at 10 cells per radius; the error falls to 0.41 % at 0.4, 0.20 % at
1/3 and 0.14 % at 1/4 (a one-off sweep; the validation set runs 1/3) (where the floors no longer bind and what remains is
the mesh). Models with solids therefore run at `CONFORMAL_SOLID_COURANT`
= 1/3, 1.7 times the steps of the default, and `addConformalSolids` refuses a
faster model. The update is stable at any Courant number; only the accuracy
needs the slack.

**Validation.** `scripts/validate/conformal_solids.ts`, CPU engine, air
cavities with PEC walls, resonance from the ring-down (the pulse is centered
on the closed form only to pick the mode; the frequency comes from the phase
slope). Staircase: a cell is metal when its center is, the usual rule. Both
at the same Courant number. Raw results:
[`docs/validation/data/conformal_solids.json`](validation/data/conformal_solids.json).

Sphere, radius 10 mm, center off the nodes by (0.23, -0.31, 0.17) mm. TM101,
k a = 2.743707 (first root of [x j1(x)]' = 0): 13.0912 GHz.

| cell | cells per radius | staircase | conformal |
|---|---|---|---|
| 2 mm | 5 | 13.344 GHz (+1.93 %) | 13.011 GHz (-0.61 %) |
| 1.5 mm | 6.7 | 13.373 GHz (+2.15 %) | 13.042 GHz (-0.38 %) |
| 1 mm | 10 | 13.276 GHz (+1.41 %) | 13.065 GHz (-0.20 %) |
| 0.75 mm | 13.3 | 13.227 GHz (+1.04 %) | 13.075 GHz (-0.12 %) |
| 0.5 mm | 20 | 13.187 GHz (+0.73 %) | 13.082 GHz (-0.07 %) |

Cylinder, radius 6 mm, length 5 mm, axis along (1, 0.6, 0.8), turned against
all three mesh axes, center off the nodes. TM010, k a = 2.404826 (first zero
of J0), for any length: 19.1238 GHz.

| cell | cells per radius | staircase | conformal |
|---|---|---|---|
| 1 mm | 6 | 18.366 GHz (-3.96 %) | 19.058 GHz (-0.35 %) |
| 0.75 mm | 8 | 18.621 GHz (-2.63 %) | 19.080 GHz (-0.23 %) |
| 0.5 mm | 12 | 18.838 GHz (-1.50 %) | 19.098 GHz (-0.14 %) |
| 0.375 mm | 16 | 18.914 GHz (-1.10 %) | 19.105 GHz (-0.10 %) |

Conformal solids are 3 to 12 times closer to the closed form than the
staircase at every cell size, and their error falls steadily: about h^1.5 on
the sphere (0.20 % to 0.07 % from 1 mm to 0.5 mm) and h^1.3 on the cylinder.
The staircase wanders (the sphere gets worse from 2 mm to 1.5 mm) and
converges at about first order. Conformal reads slightly low on both, as the
raised effective areas predict; it is not second order, for the same reason
the planar results are not (above), plus those floors.

## Thin curved sheets

A zero-thickness sheet off the mesh planes (the Gonzaga helix arms, a bent
flex strip) crosses Yee edges at single points: it covers no length and no
area, so the coverage rule above cannot see it. What it does is separate.
[`src/project/conformal_sheets.ts`](../src/project/conformal_sheets.ts) takes
the sheet as a triangle mesh, open or closed, and keeps a field on each side
(the finite integration of the cut cell; Yu and Mittra's thin-PEC scheme [5]
keeps one H per side the same way):

- each face the sheet's trace splits becomes regions, one H unknown each,
  with its own area; its Faraday law sums the voltages on its own boundary
  (the sheet has no tangential E, so it adds nothing);
- each edge the sheet crosses becomes pieces, one E unknown each, with its
  length fraction as the curl coefficient (as a partly covered edge above);
  its Ampere law reads, on each of its four faces, the region it borders.

A face's own H slot holds its largest region and an edge's own E slot its
longest piece; the rest are ghost unknowns in extra arrays. The main kernels
run unchanged and two sparse passes ([`thin_sheets.ts`](../src/engine/thin_sheets.ts),
`sparse_rows.wgsl`) correct the own slots and update the ghosts, after the H
update and after the E update. Both laws use the same incidence, so the update
is symmetric and the bound of the section above applies: faces the sheet does
not touch keep `12 |y|^2`, and each region gets the Cauchy-Schwarz bound with
slack `L - 12` on whole edges and `L` on pieces, shared among the `m` regions
an unknown borders. A region's effective area is
`max(a_R, m * sum hs es (eCurl_q / Sc) / s_q)`: a small region bounded by
short pieces keeps its small area, only a sliver along a whole edge is
raised. Power iteration stays below 4 on closed and turned open sheets
(`tests/conformal_sheets.test.ts`). Sheets run at `CONFORMAL_SOLID_COURANT`,
for the same reason as solids; at 0.5 the floors pulled a sphere sheet's mode
2.4 % low (a one-off run, not in the validation set).

Two checks pin the update to the cut-cell physics. Inside a closed sheet it
is the conformal cavity of the same surface: a sphere sheet and the solid
"box minus sphere" give the same E inside to 1e-4 after 300 steps (a test;
an earlier bug that dropped the length fraction on ghost pieces split the
sphere's TM101 triplet by 0.4 % and is caught by it). And a closed sheet
isolates: field started inside stays inside to 1e-12 in energy.

**Validation.** `scripts/validate/conformal_sheets.ts`, CPU engine, Courant
1/3, ring-down as above, default `rims: 'subcell'`. Closed sheets have no
rims, so the only difference from `'snap'` here is the lowering of raised
areas described under Rims below. Raw results:
[`docs/validation/data/conformal_sheets.json`](validation/data/conformal_sheets.json).
The staircase it is compared with makes every edge the sheet crosses PEC: a
simple way to put a zero-thickness surface on a grid that closes it, but a
pessimistic one, since it turns the sheet into a wall about a cell thick.
(The helix model's staircase paints cell faces instead.)

A sphere sheet of radius 6 mm inside a PEC sphere cavity of radius 11 mm
(center off the nodes). The sheet has a cavity on each side: inside, TM101 at
21.8186 GHz; between the spheres, TM11 at 8.2683 GHz, the first root of
`jh1'(ka) yh1'(kb) - jh1'(kb) yh1'(ka) = 0` with `jh1 = x j1(x)`,
`yh1 = x y1(x)` (Harrington 6-4; the script checks the thin-gap limit
`k = sqrt(2) / r`).

| cell | inner TM101, staircase | inner TM101, sheet | shell TM11, staircase | shell TM11, sheet |
|---|---|---|---|---|
| 1.5 mm | 21.649 GHz (-0.78 %) | 21.628 GHz (-0.87 %) | 8.196 GHz (-0.88 %) | 8.255 GHz (-0.16 %) |
| 1 mm | 22.184 GHz (+1.67 %) | 21.734 GHz (-0.39 %) | 8.295 GHz (+0.33 %) | 8.263 GHz (-0.06 %) |
| 0.75 mm | 22.044 GHz (+1.03 %) | 21.766 GHz (-0.24 %) | 8.536 GHz (+3.23 %) | 8.262 GHz (-0.07 %) |
| 0.5 mm | 22.339 GHz (+2.38 %) | 21.792 GHz (-0.12 %) | 8.186 GHz (-0.99 %) | 8.264 GHz (-0.05 %) |

The sheet is within 0.1 % of the closed form on the outside from 1 mm down
and converges on the inside like the solid sphere above (the inner sphere has
only 4 to 12 cells per radius). The staircase moves by up to 3 % with the
cell size and does not converge: where the surface falls in each cell decides
which edges close, and the sheet thickens to a cell.

**On a mesh plane.** Sheets are nudged by 1e-7 mm so no vertex lies on a
plane. A sheet on a mesh plane (or a rim on a mesh line) then leaves slivers
of area 1e-7 along the edges under it. Those edges are shorted, as covered
edges are (a region or piece within `COVERAGE_SNAP` makes its edges PEC), so
a sheet on a plane is the copper plane: a box of sheets on mesh planes rings
at the conformal solid box's 26.365 GHz to 1e-5 (a test). (Before this rule the
floored slivers left those edges half open and the box read 3 % low; the
review found it.) Meshes are welded by position first, so a surface given as
one vertex per triangle (an STL) still closes.

**Rims.** A sheet's free edge (a strip's end or side) that falls inside a
face splits nothing there, so the plain update sees the sheet only up to the
last edge it crosses: a rim anywhere inside a cell gives the same fields to
four digits, and the rim snaps by up to a cell, as on a staircase. On the two-cell-wide
strip below that is a 5 % jump in its resonance as an end crosses an edge. The fix
(`rims: 'subcell'`, the default; `'snap'` keeps the plain update) works from
the discrete problem at the rim rather than from a fitted constant.

Near a rim the quasi-static field is that of a half-plane, `Re sqrt(z)`.
In the cross-section a crossed column ties its two nodes to the sheet through
the edge's two pieces (conductances `1/s` and `1/(1 - s)` for a sheet at
fraction `s` across the cell). [`sheet_rim.ts`](../src/engine/sheet_rim.ts)
solves that 5-point problem with the ties of the last column scaled by
`beta` and reads off where the discrete rim sits in the continuum: with
`beta = 1` it is 0.146 cell past the last crossed edge at `s = 0.5` and
0.270 at `s = 0.1`, tending to the Yee edge's 0.354 as `s -> 0`; `beta`
moves it monotonically over about a cell. The table
(`sheet_rim_table.json`, `s` by `beta`, regenerated by
`scripts/validate/sheet_rim_table.ts` and checked by a test) is inverted per
rim face for the `beta` that puts the discrete rim on the true one. Scaling a
column's ties by `beta` is the pieces' capacitance times `beta` and the tie
faces' area over `beta`: a local `eps = beta`, `mu = 1 / beta`, so the update
stays a FIT scheme with positive masses and the stability bound above still
holds (power iteration below 4 with sub-cell rims anywhere in their cells, a
test). The range of `beta` a rim may use is derived, not set: as the true
rim moves through a cell its distance past the last crossed edge sweeps one
cell, so the range must reach exactly one cell, and of those ranges the one
symmetric in `ln beta` changes the material least. That is 0.25 to 4 for a
sheet mid-cell and 0.045 to 22 at `s = 0.01`, where ties of `1/s` are stiff
(`rimBetaRange`; the table spans `beta` 0.01 to 100 to cover it). Each sheet
is first grown past its rims by 0.17 to 0.41 cell (depending on `s`) to center
that window on the true rim; the grown sheet is what must clear other
objects. The window is exactly one cell only for a rim along a mesh axis: the
growth reads `s` at each boundary vertex across the axis nearest the sheet's
normal, the tie range reads it from the crossed edge, and on a tilted or
curved sheet the two differ, so a rim can land just outside its window. Its
`beta` is then clamped and the rim sits short; `thinSheets.clampedRims`
counts such rim faces (in the turned-strip test below: none for the two
axis-aligned turns, 3 and 9 for the other two at 1 mm, 13 and 22 at 0.5 mm). The approach follows Railton's modified material parameters for
small structures [6] and the use of static edge solutions in FDTD by
Shorthouse and Railton [7]; here the static solution is that of the discrete
update itself, so the correction moves the discrete rim rather than imposing
a field shape. After the area rule above, each raised region is lowered as far as
the slack its unknowns have left allows, which keeps the bound and undoes
fewer ties.

`scripts/validate/sheet_rims.ts` checks it two ways (CPU, Courant 1/3,
broadband pulse, strongest spectral peak; raw results in
[`validation/data/sheet_rims_1mm.json`](validation/data/sheet_rims_1mm.json)
and [`sheet_rims_0.5mm.json`](validation/data/sheet_rims_0.5mm.json)).

A 12.5 x 2.17 mm strip 1.37 mm over the floor of a 40 x 8 x 8 mm PEC channel,
slid along its length through one cell in ten steps, should barely move. The
reference is the same strip with `rims: 'snap'` on a graded mesh whose lines
sit the plain rim shift inside each rim. That puts its rims where the
half-plane model says they are, so it is built from the same model as the
correction: a check that the tie scaling reproduces what mesh lines would
do, not an independent reference. The turned strip below is the independent
test.

| rims | 1 mm cells, over the slide | 0.5 mm cells, over the slide |
|---|---|---|
| reference (rim lines) | 8.429 GHz | 8.692 GHz |
| snap | 8.721 to 9.154 GHz (+3.5 to +8.6 %) | 8.954 to 8.957 GHz (+3.0 %) |
| subcell | 8.236 to 8.413 GHz (-2.3 to -0.2 %) | 8.640 to 8.712 GHz (-0.6 to +0.2 %) |

Snapped, the strip jumps by 5 % as an end crosses an edge at 1 mm; at 0.5 mm
both ends cross at the same shift, so the length stays put and the error is a
steady +3 %. With sub-cell rims every position stays within 2.3 % of the
reference at 1 mm and 0.6 % at 0.5 mm. The dip at 1 mm (shifts 0.4 to
0.6 mm) is not explained yet: it is not the range of `beta` (it did not move
when that range was widened to a full cell), and the end rims there are only
three edges long.

A 12 x 2 mm strip at the center of a PEC sphere cavity (radius 12 mm) turned
four ways should not move at all:

| turn | snap, 1 mm | subcell, 1 mm | snap, 0.5 mm | subcell, 0.5 mm |
|---|---|---|---|---|
| along x | 8.900 GHz | 8.431 GHz | 8.838 GHz | 8.641 GHz |
| along y, normal x | 8.964 GHz | 8.467 GHz | 8.849 GHz | 8.586 GHz |
| turned 30 deg about z | 8.554 GHz | 8.380 GHz | 8.702 GHz | 8.536 GHz |
| along (1, 0.6, 0.8) | 8.407 GHz | 8.272 GHz | 8.563 GHz | 8.498 GHz |
| spread (max - min) / mean | 6.4 % | 2.3 % | 3.3 % | 1.7 % |

Sub-cell rims cut the spread from 6.4 % to 2.3 % at 1 mm and from 3.3 % to
1.7 % at 0.5 mm, but do not remove it. The
correction is two-dimensional: it treats each rim as a long straight edge
along a mesh axis on its own. This strip is only two to four cells wide, so
its side rims are close together, its ends are two to four edges long, and
two of the turns put every rim at an angle to the axes; there the correction
is only partly right. The table also assumes uniform cells around the rim,
so on a mesh graded right at a rim it is approximate.

What remains of the "5 % low at 1 mm" reading is the coarse mesh, not the
rims: the rim-line reference itself moves from 8.429 to 8.692 GHz (+3.1 %)
from 1 to 0.5 mm, as a two-cell-wide strip does on any Yee grid.

**Gonzaga helix with sheet arms.** The open helix of
[`benchmarks/gonzaga.md`](benchmarks/gonzaga.md) has four wide arms wrapped on
a 23.6 mm cylinder; its model staircases them on cell faces. With
`--sheet 1` (`open_helix_model.ts`) the arms are thin sheets that follow the
cylinder, with mesh lines through their free ends and a foot half a disk cell
into the trace plane so they meet the trace. Both models below are PEC (sheets
carry no copper loss yet) at Courant 1/3; raw results:
[`validation/data/gonzaga_sheet_arms.json`](validation/data/gonzaga_sheet_arms.json).

| arms | cell | f0 | -10 dB band | RHCP azimuth gain (915 MHz) | axial ratio 915 / 930 / 950 MHz |
|---|---|---|---|---|---|
| staircase | 1 mm | 925 MHz | 898 to 954 MHz | 1.41 dBi | 3.10 / 2.85 / 2.52 dB |
| staircase | 0.7 mm | 930 MHz | 902 to 958 MHz | 1.41 dBi | 3.13 / 2.89 / 2.56 dB |
| sheet, rims snapped | 1 mm | 941 MHz | 914 to 969 MHz | 1.45 dBi | 3.54 / 3.29 / 2.96 dB |
| sheet, rims snapped | 0.7 mm | 944 MHz | 917 to 973 MHz | 1.45 dBi | 3.48 / 3.24 / 2.92 dB |
| sheet, sub-cell rims | 1 mm | 939 MHz | 911 to 968 MHz | 1.43 dBi | 3.31 / 3.08 / 2.76 dB |

From 1 to 0.7 mm f0 moves +0.3 % with sheets and +0.5 % with the staircase
(two cell sizes only, so no convergence order). The two agree on bandwidth
(55 to 56 MHz), gain and ripple. They differ by 1.6 % in f0, and the sheets'
axial ratio is 0.4 dB higher at the same frequency, most of which the
16 MHz shift accounts for (the axial ratio falls by about 0.3 dB per 20 MHz). Neither is the reference: the
staircase grows the copper by up to half a cell at every outline, which
lengthens the arms, and with snapped rims the sheet's helical side rims sit
at the last crossed edge (the rim rule above), which narrows them. The sheet
model also carries its trace up to a cell past the arm's foot. So the true
resonance most likely lies between the two. Sub-cell rims place the side rims
where they really are and move f0 2 MHz towards the staircase, to 939 MHz
(-10 dB band 911 to 968 MHz against 914 to 969, gain 0.02 dB lower), with an axial
ratio 0.2 dB lower. The arm ends sit on mesh lines, so they move little, but
they are re-tied too. (One run at 1 mm.) Neither model brings the axial ratio
near 0 dB at 10.5 degrees (the paper's optimum): with smooth arms it stays
about 3 dB, so that open question does not come from the staircase.

## Limits

- Copper planes, closed 3D solids and thin sheets are conformal. Board
  outlines, dielectrics and coax connectors still staircase, and solids and
  sheets are engine APIs (`addConformalSolids`, `addConformalSheets`), not yet
  project-file shapes. Sheets are PEC (no copper loss), need lossless media
  on the edges they cross, may not meet, cross or branch, and stay clear of
  the PML, ports, lumped components and conformal copper or solids (a cell
  apart: the bound takes the faces a sheet leaves alone as uncut); each of
  these throws. With sub-cell rims (the default) a sheet is grown up to 0.41
  cell past its free edges, and that grown sheet is what must keep clear; a
  hole, slot or gap narrower than the growth of its two rims throws too
  (refine, or pass `rims: 'snap'`). Add solids before sheets. The energy stop does not count the ghost fields. Solids are PEC, must stay clear of the PML, ports and lumped
  components, may not share a cut face or a free edge of a cut face with
  conformal copper planes, and do not yet combine with frequency-dependent or
  magnetic materials; each of these throws. Pass all solids in one
  `addConformalSolids` call.
- A solid thinner than about a cell may cover no edge at all: a wire of
  0.3 mm radius between mesh lines only slows the faces it cuts and carries
  no current. Wires need a radius of a cell or more (or a thin-wire model,
  which NobuRF does not have yet).
- Partly covered edges carry no copper loss: on a lossy slanted trace the
  copper area in the cut cells is lossless, about half a cell along each edge.
- The energy stop counts each cut face's H energy over its whole area, a small
  error in when a run stops, not in the fields.

## References

1. S. Dey and R. Mittra, "A locally conformal finite-difference time-domain
   (FDTD) algorithm for modeling three-dimensional perfectly conducting
   objects," IEEE Microwave and Guided Wave Letters, 7(9), pp. 273-275, 1997.
2. A. Taflove and S. C. Hagness, Computational Electrodynamics: The
   Finite-Difference Time-Domain Method, 3rd ed., Artech House, 2005, ch. 10.
3. B. Krietenstein, R. Schuhmann, P. Thoma and T. Weiland, "The perfect
   boundary approximation technique facing the big challenge of high
   precision field computation," Proc. LINAC, 1998.
4. E. Benkler, N. Chavannes and N. Kuster, "A new 3-D conformal PEC FDTD
   scheme with user-defined geometric precision and derived stability
   criterion," IEEE Trans. Antennas Propag., 54(6), pp. 1843-1849, 2006.
5. W. Yu and R. Mittra, "A conformal FDTD algorithm for modeling perfectly
   conducting objects with curve-shaped surfaces and edges," Microwave and
   Optical Technology Letters, 27(2), pp. 136-138, 2000.
6. C. J. Railton, "The treatment of geometrically small structures in FDTD by
   the modification of assigned material parameters," IEEE Trans. Antennas
   Propag., 53(12), 2005.
7. D. B. Shorthouse and C. J. Railton, "The incorporation of static field
   solutions into the finite difference time domain algorithm," IEEE Trans.
   Microwave Theory Tech., 40(5), 1992.
