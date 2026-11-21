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
rule is exact. Faces no segment reaches are decided by their centre.

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
its centre. Turning changes nothing physical, so every angle should give the
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

**Circular patch.** Radius 8 mm (TM11), its centre at (0, 0) and moved by
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
cavities with PEC walls, resonance from the ring-down (the pulse is centred
on the closed form only to pick the mode; the frequency comes from the phase
slope). Staircase: a cell is metal when its centre is, the usual rule. Both
at the same Courant number. Raw results:
[`docs/validation/data/conformal_solids.json`](validation/data/conformal_solids.json).

Sphere, radius 10 mm, centre off the nodes by (0.23, -0.31, 0.17) mm. TM101,
k a = 2.743707 (first root of [x j1(x)]' = 0): 13.0912 GHz.

| cell | cells per radius | staircase | conformal |
|---|---|---|---|
| 2 mm | 5 | 13.344 GHz (+1.93 %) | 13.011 GHz (-0.61 %) |
| 1.5 mm | 6.7 | 13.373 GHz (+2.15 %) | 13.042 GHz (-0.38 %) |
| 1 mm | 10 | 13.276 GHz (+1.41 %) | 13.065 GHz (-0.20 %) |
| 0.75 mm | 13.3 | 13.227 GHz (+1.04 %) | 13.075 GHz (-0.12 %) |
| 0.5 mm | 20 | 13.187 GHz (+0.73 %) | 13.082 GHz (-0.07 %) |

Cylinder, radius 6 mm, length 5 mm, axis along (1, 0.6, 0.8), turned against
all three mesh axes, centre off the nodes. TM010, k a = 2.404826 (first zero
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
1/3, ring-down as above. Raw results:
[`docs/validation/data/conformal_sheets.json`](validation/data/conformal_sheets.json).
The staircase it is compared with makes every edge the sheet crosses PEC: a
simple way to put a zero-thickness surface on a grid that closes it, but a
pessimistic one, since it turns the sheet into a wall about a cell thick.
(The helix model's staircase paints cell faces instead.)

A sphere sheet of radius 6 mm inside a PEC sphere cavity of radius 11 mm
(centre off the nodes). The sheet has a cavity on each side: inside, TM101 at
21.8186 GHz; between the spheres, TM11 at 8.2683 GHz, the first root of
`jh1'(ka) yh1'(kb) - jh1'(kb) yh1'(ka) = 0` with `jh1 = x j1(x)`,
`yh1 = x y1(x)` (Harrington 6-4; the script checks the thin-gap limit
`k = sqrt(2) / r`).

| cell | inner TM101, staircase | inner TM101, sheet | shell TM11, staircase | shell TM11, sheet |
|---|---|---|---|---|
| 1.5 mm | 21.649 GHz (-0.78 %) | 21.612 GHz (-0.95 %) | 8.196 GHz (-0.88 %) | 8.250 GHz (-0.22 %) |
| 1 mm | 22.184 GHz (+1.67 %) | 21.723 GHz (-0.44 %) | 8.295 GHz (+0.33 %) | 8.264 GHz (-0.05 %) |
| 0.75 mm | 22.044 GHz (+1.03 %) | 21.757 GHz (-0.28 %) | 8.536 GHz (+3.23 %) | 8.262 GHz (-0.08 %) |
| 0.5 mm | 22.339 GHz (+2.38 %) | 21.785 GHz (-0.15 %) | 8.186 GHz (-0.99 %) | 8.263 GHz (-0.07 %) |

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
face splits nothing there and is seen only at the last edge the sheet
crosses, so a rim between mesh lines snaps by up to a cell, as on a
staircase. Where a mesh line runs through the rim it is exact (the rule
above). Curved surfaces and the surface's position between planes
are what sheets get right; rims need mesh lines (the helix model puts lines
through the arm ends). How much this matters: a 12 x 2 mm strip centred in a
PEC sphere cavity (radius 12 mm), turned four ways at 1 mm cells, gives its
lowest strip mode between 8.27 and 8.90 GHz (one-off runs), a 7.4 % spread that rotating a
strip in a sphere should not make at all. That spread is the rims: the
strip's ends and sides land differently against the edges in each
orientation. (The script for this was dropped from the validation set: no
closed form, and its staircase runs locked onto a sphere mode instead.)

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
| sheet | 1 mm | 941 MHz | 914 to 969 MHz | 1.45 dBi | 3.54 / 3.29 / 2.96 dB |
| sheet | 0.7 mm | 944 MHz | 917 to 973 MHz | 1.45 dBi | 3.48 / 3.24 / 2.92 dB |

From 1 to 0.7 mm f0 moves +0.3 % with sheets and +0.5 % with the staircase
(two cell sizes only, so no convergence order). The two agree on bandwidth
(55 to 56 MHz), gain and ripple. They differ by 1.6 % in f0, and the sheets'
axial ratio is 0.4 dB higher at the same frequency, most of which the
16 MHz shift accounts for (the axial ratio falls by about 0.3 dB per 20 MHz). Neither is the reference: the
staircase grows the copper by up to half a cell at every outline, which
lengthens the arms, and the sheet's helical side rims snap inwards to the
last crossed edge (the rim rule above), which narrows them. The sheet model
also carries its trace up to a cell past the arm's foot. So the true
resonance most likely lies between the two. Neither model brings the axial ratio
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
  these throws. Add solids before sheets. The energy stop does not count the ghost fields. Solids are PEC, must stay clear of the PML, ports and lumped
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
