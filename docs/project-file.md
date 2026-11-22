# The NobuRF project file

A project is one JSON document that fully describes a planar antenna
simulation: variables, materials, stackup, copper, ports, boundaries, mesh
and analysis. The `noburf` command solves it:

```bash
npm run noburf -- solve examples/patch-5g8.json [--gpu | --cpu] [--out out/] [--mesh-check off|check|refine] [--delta-s 0.02]
```

The solve runs on the GPU (WebGPU through Dawn) when an adapter is found,
and otherwise prints a notice and runs the CPU reference. `--cpu` chooses
the CPU reference; `--gpu` fails when there is no GPU instead of falling
back.

Every solve runs the passivity, reciprocity and validated-range checks.
`--mesh-check check` also solves one finer mesh and reports that mesh's
result with a mesh error bar, at about 3 times the cost; `--mesh-check
refine` solves two finer meshes. The default is off. See
[self-check.md](self-check.md).

It writes two files to the output directory (default: `<project>.results/` next to the project file),
and a third when the project asks for a far field:

- `s11.s1p`, a Touchstone v1 file (`# GHz S RI R <z0>`).
- `result.json`: f0, minimum S11, Z_in at the requested frequencies, steps run,
  energy decay, and a `provenance` record (project SHA-256, mesh and per-face
  PML, excitation, run control, solver and device, git commit, whether tracked
  files differed from it, and any warnings), and a `self_check` record: the
  mesh levels with f_res, dip depth and ΔS on each, the error bars with the
  order and behaviour behind them and a `scope` note (mesh error only), the
  physics checks with `passed` and `marginal`, and the validated-envelope
  findings, each with `parameter`, `value` and `validated` as text, `inside`
  and `evidence` ([self-check.md](self-check.md)).
- `far_field.json`, only with `outputs.far_field_ghz`: per frequency, the peak
  directivity and its direction, peak gain and realised gain, radiated and
  accepted power, radiation efficiency, and the pattern on a 5 degree
  theta/phi grid (directivity in dBi and the complex far-field components
  r·E_theta, r·E_phi). With it, per frequency, `pattern_<f>ghz.svg` (the
  E-plane and H-plane cuts) and `pattern_<f>ghz.glb` (the 3D lobe). See
  [Far field](#far-field) below.

A project with two or more ports writes `sparams.s<N>p` and `result.json`
instead; see [Several ports](#several-ports).

The schema lives in [`src/project/schema.ts`](../src/project/schema.ts); every
field is documented there. [`examples/patch-5g8.json`](../examples/patch-5g8.json)
is a complete project.

## Conventions

- **Lengths are strings with units**: `"1.5 mm"`, `"62 mil"`, `"patch_l / 2"`,
  `"-(board_l / 2)"`. Units: `mm`, `um`, `cm`, `m`, `mil`, `in`. A bare number
  where a length is expected is an error, and so is adding a length to a plain
  number. Expressions allow `+ - * /` and parentheses; there is no `eval`.
- **Frequencies, counts and material constants are plain numbers**, with the
  unit in the key name (`f_min_ghz`, `reference_impedance_ohm`).
- **Unknown keys are errors**, so a typo never silently does nothing. Every
  error names the JSON path, e.g. `$.mesh.cell: bare number 1 is not a length`.
- x and y are board coordinates. z is the stackup, listed **bottom to top**;
  copper layers are zero-thickness sheets between dielectric layers.

## Sections

| Key | What it holds |
| --- | --- |
| `variables` | Named expressions, each with optional `min`, `max` and `locked`. Variables may use other variables. An edit that breaks a range or touches a locked variable is refused. |
| `materials` | Dielectrics as `{ eps_r, tan_delta }` and conductors as `{ conductivity_s_per_m }`, added to the built-ins `FR-4`, `RO4003C`, `air`, `pec` and `copper` (5.8e7 S/m). A dielectric may also be magnetic and frequency-dependent: see [Materials that vary with frequency, and magnetic materials](#materials-that-vary-with-frequency-and-magnetic-materials). |
| `stackup` | Layers bottom to top: `{ type: "copper", name, material, thickness? }` or `{ type: "dielectric", name, material, thickness }`. A copper layer's `thickness` (default 35 µm, 1 oz) only sets its edge loss; the copper is still drawn as a sheet. |
| `board.outline` | Polygon; dielectric exists only inside it. |
| `geometry` | Per copper layer, shapes painted in order: `op: "add"` makes copper, `op: "cut"` removes it (slots, notches). A cut removes the copper strictly inside it, plus any part of its outline that lies on the outline of an earlier add. A notch or chamfer drawn from a patch edge therefore opens that edge, while a slot inside the patch keeps copper along its rim. |
| `ports` | One or more lumped ports with unique ids: `{ id, x, y, between: [layer, layer], reference_impedance_ohm }` (optionally `kind: "lumped"`), SMA connectors on board edges, or coax probes through the ground plane, mixed freely: see [Coax feeds](#coax-feeds-sma-connector-and-probe-through-the-ground). A lumped port may add `deembed: { length }` to remove itself and that much of its feed line from the results: see [De-embedding](#de-embedding-a-port). |
| `components` | Optional lumped resistors, inductors and capacitors (SMD parts, matching networks): see [Lumped components](#lumped-components). |
| `boundaries` | Per face (`x_min` … `z_max`): `{ type: "pml", cells }` or `{ type: "pec" }`. |
| `mesh` | `cell` and `air_margin_cells: { xy, below, above }` (each at least 1, in multiples of `cell`). Without `graded` the cells are uniform cubes of `cell`. With `graded: { edge_cell, dielectric_cells, max_growth }`, see below. `conformal: true` models slanted and curved copper edges by the part of each cell they cover ([conformal.md](conformal.md)). |
| `analysis` | Band (`f_min_ghz`, `f_max_ghz`, `n_freq`), `loss_reference_ghz` (where `eps_r` and `tan_delta` hold exactly for a material without its own `at_ghz`), `stop: { energy_decay_db, max_steps }`, and optional `excite`: the ids of the ports to excite (default: every port). |
| `outputs` | `zin_at_ghz`: frequencies at which `result.json` reports Z_in. Optional `far_field_ghz`: 1 to 16 frequencies inside the band at which to compute the far field (writes `far_field.json`). Optional `near_field_mm`: 1 to 4 heights above the top copper for a near-field scan (workbench only, see below). Optional `differential_pairs`: ports read as differential pairs, `{ id, positive, negative, differential_ohm?, common_ohm? }` per pair end (writes `differential.json`; see [differential-pairs.md](differential-pairs.md)). |

## Several ports

Each port is a vertical column at the grid node nearest its `(x, y)`, with
the same checks as a single port: copper at least one cell wide on both of
its layers, no copper on a layer in between, one dielectric along it. Two
ports may not land on the same grid node.

The solver runs once per excited port. In each run the excited port carries
the source and every other port is a resistor of its
`reference_impedance_ohm`; V and I are recorded at every port. With V the
voltage across a port (top minus bottom) and I the current into the
structure at its top, the power waves of port i are
a = (V + Z0 I) / (2 √Z0) and b = (V − Z0 I) / (2 √Z0), and B = S A, where
column j of A and B comes from the run exciting port j.

- **Every port excited** (the default): S = B A⁻¹. An unexcited port is not
  quite a matched load, because the current measured around its column also
  includes its cell's own displacement current (a few % of the incident wave
  at 1 mm cells and 10 GHz); solving with A removes that. The result is
  reciprocal to float rounding (|S21 − S12| below 1e-5 on the test line).
  `sparams.s<N>p` is written as Touchstone v1, `# GHz S RI R <z0>`: for two
  ports one line per frequency in the order S11 S21 S12 S22; for three or
  more, one matrix row per line (S_i1 … S_iN), at most four pairs per line.
  All ports must share one `reference_impedance_ohm`. Differential pairs can
  still be read on other references: see [differential-pairs.md](differential-pairs.md).
- **Some ports excited** (`analysis.excite`): only those columns are known,
  S_ij = b_i / a_j, which takes a = 0 at the unexcited ports. No Touchstone
  file is written; `result.json` has the columns and a warning gives the
  largest neglected |a| as a fraction of the incident wave.

`result.json` for several ports holds `ports` (id, Z0, grid node, whether
excited), `s_parameters` (`file`, `method` `"full"` or `"matched_loads"`,
`max_passive_incident_ratio`, and for every computed S_ij its minimum and
maximum |S| in dB over the band and where they occur), `runs` (per excited
port: Z_in at `outputs.zin_at_ghz` with the other ports loaded, steps, energy
decay) and the `provenance` record, whose `excited_ports` lists the runs.
A one-port project writes `s11.s1p` and the fields listed at the top, plus
`ports` and `provenance.excited_ports`.

The GPU solver takes at most 8 ports with at most 64 port cells together
(a port is one cell per mesh cell between its two layers). The far field is
computed for one-port projects only.

## De-embedding a port

A lumped port at the end of a straight feed can be removed from the results
together with a length of the feed:

```json
{ "id": "in", "x": "-17.16 mm", "y": "0 mm", "between": ["gnd", "top"],
  "reference_impedance_ohm": 50, "deembed": { "length": "10 mm" } }
```

`noburf solve` then reads the feed from the project, builds and solves a
thru-line calibration kit on the same stackup and mesh, and writes the
S-matrix (and S11 dip, Z_in, run spectra) at the reference plane `length`
along the line, keeping the raw result as `s11.raw.s1p` or
`sparams.raw.s<N>p`. Every port must be excited. `result.json` gains a
`deembedding` record with the feed, the kit and the line it measured
(impedance, effective permittivity, loss). What the feed must look like,
the method and its limits: [deembedding.md](deembedding.md).

## Coax feeds: SMA connector and probe through the ground

A lumped port is a 50 Ω source in one column of the grid. A real board is fed
through a connector or a coax probe, and the transition changes Z_in (about
30 Ω more capacitive on the validation patch; [validation.md](validation.md)
section 3.2). Two port kinds model the coax in the grid instead, as metal and
PTFE, with the wave launched and read on the coax line itself:

```json
"ports": [
  { "id": "in", "kind": "sma_edge", "edge": "y_min", "x": "0 mm",
    "between": ["top", "gnd"], "reference_impedance_ohm": 50 },
  { "id": "feed", "kind": "coax_probe", "x": "0 mm", "y": "-2.5 mm",
    "between": ["top", "gnd"], "reference_impedance_ohm": 50 }
]
```

- `sma_edge` is an edge-launch SMA on the board edge `edge` (`x_min`,
  `x_max`, `y_min` or `y_max`), centered on `x` along a y edge or on `y` along
  an x edge. Its pin rests 1.5 mm onto the trace on the first layer of
  `between` (the top copper layer), and its body bonds to the second, the
  ground. The trace must reach the board edge there. Boards up to 2.54 mm
  thick: the body must reach below the ground plane.
- `coax_probe` is an SMA line coming up through the ground plane at (`x`,
  `y`), as in a probe-fed patch. Its pin rises through the board to the first
  layer of `between`; the second, the bottom copper layer, is the shield. The
  ground copper inside the 4.10 mm bore is cut away automatically; copper on
  any layer in between needs its own anti-pad cut.
- The line is a standard SMA: 1.27 mm pin, 4.10 mm PTFE bore, 6.35 mm square
  body. The coax runs about 16 mm out (from the edge, or down from the ground)
  into the PML of that face, which must be a PML. Wherever a connector reaches
  past the board, the air is widened to fit it with whole cells to spare;
  `air_margin_cells` sets the rest.
- Both need `mesh.graded`: the coax is meshed with 0.125 mm cells across it,
  fitted to the trace edges, and lines at the flange, pin end, source and
  probe planes.
- Waves are referred to the flange (the board edge, or the underside of the
  ground plane), as a VNA calibrated at the connector reads them. Any number
  of coax feeds can share a board with each other and with lumped ports; the
  S-matrix is formed on each coax line's own impedance and renormalised to
  `reference_impedance_ohm`, so with more than one port every port must be
  excited. `s11.s1p`, `sparams.sNp` and `result.json` are written as for
  lumped ports.
- Runs on the WebGPU kernels (the same solvePorts, with the GPU engine) or,
  with `--cpu` or without a GPU, on the CPU reference. No far field yet.

## Lumped components

A component is an R, an L, a C, or two or three of them in series or in
parallel, placed on the grid edges between two copper areas. It has an `id`
(unique across ports and components), its values, and one of two placements.

```json
"components": [
  { "id": "R1", "layer": "top", "from": ["0 mm", "-1 mm"], "to": ["0 mm", "1 mm"], "width": "2 mm", "r_ohm": 50 },
  { "id": "C1", "x": "0 mm", "y": "5 mm", "between": ["top", "gnd"], "l_nh": 0.5, "c_pf": 1, "connection": "series" }
]
```

- **On a layer** (`layer`, `from`, `to`, optional `width`): a part bridging a
  gap in the copper of one layer, like an 0603 across a cut in a trace.
  `from` and `to` must differ along exactly one axis and land on copper at
  both ends, with bare laminate between. With `width`, the part fills every
  grid line across that width as parallel columns, each holding its share of
  the value, so the total is still the value given; without it the part is
  one grid line wide.
- **Between layers** (`x`, `y`, `between`): a vertical part from one copper
  layer to another, like a shunt part to ground with its via. It takes the
  grid column at that point, which must touch copper on both layers and no
  copper on the layers in between.

Values are `r_ohm` (1 mΩ to 1 GΩ), `l_nh` (1 fH to 1 mH) and `c_pf` (1 aF to
1 µF). One value needs nothing else; two or three need
`connection: "series"` or `"parallel"`. A part cannot share grid edges with a
port, another part or a coax connector. A part on a layer is refused when
copper of that layer joins its two ends, under it or around it; a short
through other layers (vias, ground) is not checked.

The part is solved with an implicit (trapezoidal) update, so it stays stable
at any value and costs no extra time steps. What the grid adds around it is
real and is not removed: a between-layers part has the inductance of its
column (about 0.3 nH for a 1 mm post on 1 mm cells) and the capacitance of
the cell it replaces, and a layer part has the fringing capacitance of its
gap. On a dispersive substrate (any lossy one, unless it is `conductivity` or too lossy for the wideband model), the cells a
part occupies keep the substrate's single-frequency stand-in: its ε_r and
loss at `analysis.loss_reference_ghz`. The rest of the substrate stays
dispersive. See [validation.md](validation.md#76-lumped-components) for how close
the parts come to circuit theory.

## Vias

A via is a plated hole from one copper layer to another. It has an `id`
(unique across ports, components and vias), a center, a `drill` diameter and
the two layers it joins:

```json
"vias": [
  { "id": "V1", "x": "0 mm", "y": "5 mm", "drill": "0.3 mm", "between": ["top", "gnd"] },
  { "id": "fence", "x": "-10 mm", "y": "2 mm", "to": ["10 mm", "2 mm"], "pitch": "1.5 mm",
    "drill": "0.3 mm", "between": ["top", "gnd"] },
  { "id": "V2", "x": "4 mm", "y": "0 mm", "drill": "0.3 mm", "between": ["top", "gnd"], "antipad": "0.8 mm" }
]
```

(V2's antipad needs a copper layer between `top` and `gnd`, such as an inner
ground.)

- The barrel is solid metal of the drill's diameter, the finished hole of a
  plated via. It must touch copper on both of its layers (a pad, a trace or
  a plane) and joins any copper it passes through on the layers in between.
- **`antipad`** cuts a clearance of that diameter around the via in every
  copper layer in between, so it passes through them unconnected, as a
  signal via through an inner ground does. The clearance must also clear the
  grid: an antipad too small for the cells around it is refused, since the
  via would still touch the plane on the grid.
- **A fence** (`to` and `pitch`) is a row of vias, the first at (x, y), one
  every `pitch` towards `to`, the last being the one that still fits. Its
  vias are named `fence#1`, `fence#2` and so on in messages. Fences stitch
  grounds, wall in a grounded coplanar line or a cavity, and are capped at
  2000 vias each.

On the grid, every mesh node inside the drill is a column of metal edges
between the two layers, joined to its neighbours. A graded mesh puts lines
on the via's center, on its rim when the drill is at least one
`edge_cell` wide (so the barrel's width is exact along x and y), and on its
antipad's rim; a fence's vias get center lines only. A drill
that holds only one mesh node is that one column, whose width follows the
cells around it, not the drill (on a graded 0.2 mm mesh it read like a post
0.6 of a cell wide). The solve warns whenever a via is one column; a smaller
`edge_cell` resolves it. Barrels are
lossless (perfect conductor) for now, and a project with an SMA connector
or a coax probe cannot have vias yet. See [vias.md](vias.md) for how close
vias come to exact references.

## Far field

With `"far_field_ghz": [5.8]` in `outputs`, the solver keeps a running
Fourier transform, at each listed frequency, of the tangential E and H on a
closed box in the air around the board (the Huygens box), two clean cells
inside the PML. After the run the equivalent surface currents J = n × H and
M = −n × E on that box are transformed to the far field (Taflove & Hagness
ch. 8, Balanis ch. 12). This covers the whole sphere, the finite ground and
the radiation below the board included, unlike the aperture estimate the
viewer shows.

What `far_field.json` reports, per frequency:

| Key | Meaning |
| --- | --- |
| `peak_directivity_dbi`, `peak_theta_deg`, `peak_phi_deg` | 4π U / P_rad at the strongest direction (theta from +z, phi from +x). |
| `radiated_power_w` | Poynting flux out of the box. |
| `accepted_power_w` | ½ Re(V I*) at the port. |
| `efficiency` | radiated / accepted power. Close to 1 for a lossless model; below 1 with dielectric loss. A lossless model far from 1 means the run did not ring down, or the box is too close to the PML. |
| `peak_gain_dbi` | 4π U / P_accepted (IEEE gain). |
| `peak_realised_gain_dbi` | Gain × (1 − \|S11\|²): it includes the port mismatch. |
| `sphere_to_box_power_ratio` | U integrated over the sphere over the box flux; a check of the transform, expected within a percent or two of 1. |
| `pattern` | `theta_deg` (0 to 180) × `phi_deg` (0 to 355) grid: `directivity_dbi` rows per theta, and `r_e_theta_v`, `r_e_phi_v` as `re` and `im` rows. |
| `boresight_polarisation`, `e_plane_phi_deg` | `x` or `y`, whichever E component is stronger toward +z, and the azimuth of the plane that holds it (0 for x, 90 for y). The figures below assume a broadside antenna. |
| `beamwidth_e_plane_deg`, `beamwidth_h_plane_deg` | Half-power (−3 dB) beamwidth in each principal plane, interpolated between the 5 degree samples; `null` if the cut never falls 3 dB. |
| `front_to_back_db` | Directivity toward +z over directivity toward −z. |
| `boresight_cross_polar_db` | Cross-polar over co-polar toward +z (Ludwig's third definition). |
| `caveat` | Present only when the run stopped before the field rang down: efficiency and gain are then approximate. |

The two pattern files per frequency:

- `pattern_<f>ghz.svg`: polar plots of the E-plane and H-plane cuts in dBi,
  co-polar solid and cross-polar dashed (Ludwig 3), theta = 0 (+z) at the top
  and negative theta for the half plane at phi + 180°. It follows the
  viewer's light or dark setting.
- `pattern_<f>ghz.glb`: the directivity lobe as a glTF 2.0 mesh, 30 dB of
  pattern with the peak at 0.1 m, coloured blue (−30 dB) to red (peak). It
  opens in Blender, Windows 3D Viewer and three.js.

Powers and fields are for a 1 V peak sinusoidal source behind the port's
reference resistance; only ratios matter for directivity and gain.

The box must enclose all copper and dielectric with air on its faces, so a
far field needs:

- a PML on all six faces (`pec` faces are refused), and
- `air_margin_cells` of at least 4 on every side (`xy`, `below`, `above`).

Graded meshes work: the box takes its patch sizes from the mesh lines and
interpolates H to its faces across cells of unequal width.

Each listed frequency adds work every step on the box surface: three
frequencies on the example patch (with `xy` margin 4) add about 10 % to a CPU
solve, and the transform afterwards takes about 2 s per frequency. Since the transform is a
Fourier transform of the whole run, let the run ring down (the energy stop):
a truncated run leaves the efficiency off 1, and `far_field.json` then
carries a `caveat` and the CLI prints a warning.

## Near field

`"near_field_mm": [2, 5]` in `outputs` scans E and H on a plane at each
height above the top copper layer, like an EMC probe over the board, at the
field-plot frequencies (the far-field and Z_in frequencies, up to four). Each
height snaps to the nearest plane of mesh nodes, and the Emissions view
shows the snapped height. On a graded mesh the snap can be a fraction of a
millimetre (2 mm can become 1.75 mm), which near a source falling as 1/r³
moves the field by about 1 dB, so read the snapped height, not the one asked
for. The plane has to lie in the free air between the copper and the PML
on top, so raise `mesh.air_margin_cells.above` to scan higher.

The values are the solver's own fields, each component interpolated to the
plane's nodes; |E| and |H| combine the three components at each node, whereas
a real probe averages one component over its loop. Hz is not recorded; it follows from Faraday's law on E in the
form the solver steps, and matches the solver's own Hz to 1e-4. With a far
field as well, the field at 3 m and 10 m comes from the same Huygens box,
with the full free-space Green's function rather than its far-field limit.
`src/engine/near_field.ts` has the formulas and `docs/validation.md` 4.5
the checks. The CLI accepts the key and warns that it writes nothing for
it yet. Not available with an SMA or coax probe port.

## Graded mesh

```json
"mesh": {
  "cell": "1 mm",
  "air_margin_cells": { "xy": 4, "below": 4, "above": 12 },
  "graded": { "edge_cell": "0.25 mm", "dielectric_cells": 6, "max_growth": 1.3 }
}
```

Mesh lines go on the board outline, at every copper edge parallel to x or y,
on the port, and on every layer interface, so nothing snaps: a 12.4 mm patch is
12.4 mm. A zero-thickness copper edge on the Yee grid acts some way past
its last copper node: 0.3535 of a cell when the z cells either side of the
copper are as wide as the cell along it, more for taller z cells (0.372 at
1.1), from a discrete half-plane solve (`src/engine/yee_edge.ts`). A strip
with its edges on lines therefore acts about 0.7 cell wider than drawn and
reads low in Z0. The line at each copper edge is therefore placed that
offset inside the copper, computed for the layer's own z cells, which puts
the grid's edge where the edge is drawn; a port drawn on such an edge moves
with it. On the textbook exam's thru-line-calibrated microstrip lines
([textbook-exam.md](textbook-exam.md)), 0.2 mm edge cells and 0.1 mm refined:

| Line | Lines on drawn edges, 0.2 → 0.1 mm | Edges placed inside, 0.2 → 0.1 mm |
| --- | --- | --- |
| Pozar Ex 3.7, 50 Ω design | 48.94 Ω | 50.12 Ω |
| RO4003C, 50 Ω design | 47.5 → 48.70 Ω (+2.5 %) | 49.60 → 49.84 Ω (+0.5 %) |
| RO4003C, 100 Ω design | 89.7 → 93.94 Ω (+4.7 %) | 99.95 → 99.10 Ω (−0.9 %) |

`python3 scripts/textbook_exam/exam.py --only line,mesh-check` reproduces
them (GPU; it writes into `docs/textbook-exam/results/`, whose committed
grades stay those of the original exam run). Not every line moved closer to
its reference: the lossy alumina line of docs/validation.md section 7.3,
read through Re(Z_in) on its 25 mm length with no calibration, went from
47.5 / 48.4 Ω to 49.2 / 49.3 Ω against a closed form of 46.67 Ω (+5.3 to
+5.6 %, no longer moving with the mesh); that gap is open and under check
with openEMS. The offset is the one of a uniform lattice, so cells stay
`edge_cell` (uniform) around each corrected line, along the board and in z at
its copper layer, for the distance to the nearest other copper layer but at
most 20 edge cells. Growth right at the edge leaves a first-order Z0 error
(about 1.4 % low at the coarsest mesh of a stripline, converging only slowly);
the hold brings that to about 0.1 to 0.3 % (scripts/lab/edge_hold_2d.ts). It
costs cells: over the repository's 66 graded projects about 1.7 times the
cells (geometric mean; up to 5.3 times on a fine-edge filter). The offset is
solved for the cell actually beside each line, and each line is settled on
that cell to 1e-3 edge cell; an edge where the grading makes that cell under
0.5 or over 1.2 `edge_cell` keeps its drawn line, with a warning. Two
approximations remain: the offset is measured on a 40-cell lattice (within
2.5e-3 cell of a 120-cell one over the z cells it is used for,
scripts/lab/edge_offset_accuracy.ts), and it is solved without the
substrate's permittivity, which
matters only when the z cells above and below the copper differ. The
settled lines are not at round positions, so the cell beside one can come out
a few % under `edge_cell`, which sets the time step. Edges keep their drawn position on the board outline (a ground
plane's rim), where the copper behind them is under two edge cells wide,
where copper lies on both sides, where the copper changes side along the
edge, where the layer's z cells are under 0.25 or over 2 times the cell
beside the edge, where another edge, a port, a component or a
refinement lies outside the copper within 1.5 edge cells (a narrow gap or a
port beside the edge) or inside it within half an edge cell of the moved
line, where another edge at the same place cannot move, where the settled
cell outside the moved line is outside 0.5 to 1.2 edge cells or no more than
twice the line's depth inside the drawn edge (the copper would then reach a
cell past the drawn edge), where the cell inside it is under half an edge
cell, and with `mesh.conformal`. A step in width (an edge on another line with
its copper on the same side, whose span lies wholly beside this edge's span)
only bounds the cell the offset is solved for, so its line needs only 0.5
edge cell outside the moved line instead of the 1.5-cell clearance. Uniform meshes are
unchanged. Cells are `edge_cell` at copper edges and copper layers, at most a
dielectric's thickness over `dielectric_cells` inside it, and grow by at most
`max_growth` per cell up to `cell`. Every edge that keeps its drawn line is
named in a warning with its reason. Fixed lines closer than `edge_cell / 4`
merge (with a warning): a close group becomes one line at the board end it
holds (board ends stay exact), else at the middle of the ports it holds (so a
lone port stays on its copper, and two close ports share a line between
them), else at its middle. A longer chain of close lines (a staircase) keeps
its board ends, ports, first and last line, and evenly spaced lines between
them at least `edge_cell / 4` apart. The rules give the same mesh under a
mirror, a 90 degree turn and a shift of the board. The time step follows the smallest cell,
so a 0.05 mm gap costs steps; `result.json` records the smallest and largest cell.
Slanted and curved edges staircase on the lines around them unless
`mesh.conformal` is true ([conformal.md](conformal.md)); the two combine.

## Conductor loss

A copper layer made of `pec` is lossless. `copper` or any material with
`conductivity_s_per_m` is a zero-thickness sheet, perfectly conducting
inside. Each of its two faces has the skin-effect surface impedance of a
good conductor much thicker than the skin depth,
Zs(f) = (1 + j) Rs(f), Rs(f) = √(π f μ0 / σ)
(Ramo, Whinnery and Van Duzer, sec. 3.17), across the whole analysis band:
Rs grows as √f (0.020 Ω for copper at 5.8 GHz), and the surface reactance
is there too. The solver fits Zs on the band as a resistance plus resistor
and inductor branches in parallel, all non-negative, so the result is
causal and passive; it is within 1e-4 of Rs and 0.3 % of the reactance
across the band. A layer thinner than three skin depths at `f_min_ghz`
gets a warning, since its loss reads low there.

Rough foil loses more. A conductor can carry a `roughness`:

```json
"materials": {
  "ED copper": { "conductivity_s_per_m": 5.8e7, "roughness": { "model": "huray", "radius_um": 0.5, "surface_ratio": 2 } },
  "RTF copper": { "conductivity_s_per_m": 5.8e7, "roughness": { "model": "groisse", "rms_um": 1.2 } }
}
```

- **`hammerstad`** `{ rms_um }`: Hammerstad and Jensen (IEEE MTT-S 1980),
  K = 1 + (2/π) atan(1.4 (Δ/δ)²), Δ the rms height and δ the skin depth.
- **`groisse`** `{ rms_um }`: Groisse et al. (IEEE Trans. Magn. 32(3), 1996),
  K = 1 + exp(−(δ / 2Δ)^1.6).
- **`huray`** `{ radius_um, surface_ratio }`: Huray's snowball model with one
  sphere size (DesignCon 2010; the "cannonball" form of Simonovich, 2015),
  K = 1 + 1.5 SR / (1 + δ/a + δ²/2a²), a the sphere radius and SR the
  spheres' surface over the flat area under them.

The resistance becomes K(f) Rs(f), fitted the same way (within 1e-3, or about
6e-3 for a very rough Huray foil; a fit worse than 1 % gets a warning). Hammerstad
and Groisse saturate at K = 2; Huray keeps growing for rough foil. The models
give only a resistance; the reactance is what the causal fit makes of it,
which can differ from the resistance several times over for rough foil (up to
about 5 times); next to a line's own inductance it is small (X / ωL is about
the skin depth over the substrate height).
The face update is explicit: a face that would take more than all of its H
field in one step at the grid's highest frequency is refused with the reason
(the update grows past twice that, measured on a 1D line). The fit's
impedance there is about 6 to 10 times Rs at the loss reference, so this
takes a conductor far poorer than copper (around 1e3 S/m on fine cells);
copper takes about 0.1 %.
Foil makers quote rms roughness (Hammerstad, Groisse) or nodule radius and
surface ratio (Huray) on their datasheets.

The current on a zero-thickness strip grows as 1/√x towards its edge, so
its loss would grow without limit as the mesh is refined. Real copper
stops this at a distance set by its thickness: for a rectangular edge of
thickness t the loss equals that of a sheet cut off t / (4π e^π) ≈ t / 291
from the edge (Schwarz–Christoffel map of the edge), which reproduces the
Lewin and Holloway–Kuester strip resistance. The Yee grid cuts the sheet
off at 0.272 of the cell across the edge, and the edge node carries 1.302
times a²/2 of the loss (a the strength of the 1/√x current); both come from
a discrete half-plane solve (`scripts/validate/yee_edge_constants.ts`). So
each outermost copper edge along a boundary (an Ex edge with no copper next
to it in y, an Ey edge with none next to it in x) has its Rs multiplied by
1 + ln(0.272 d / (t / 291)) / 1.302, d the mean of the two cells either
side of the edge, which adds
the loss between the two cutoffs. It is 5.2 for 35 µm copper on 0.1 mm
cells and falls by 0.53 each time the edge cell halves, so the corrected
loss converges as the mesh is refined while the uncorrected one keeps
rising. Three cases fall outside what the factor was derived for. A strip
one or two cells wide has both edges in one cell. A slanted or curved edge
takes the factor on the outermost whole edges of its x and y steps alike
(with `conformal` too: partly covered edges carry no loss), about 1.4 times
the edge's length at 45°, so it overstates that edge's loss. The rim of a coax
anti-pad keeps the plain Rs.

## Materials that vary with frequency, and magnetic materials

A dielectric given only `eps_r` and `tan_delta` is lossless and constant when
`tan_delta` is 0. When it is lossy, it gets the Djordjevic-Sarkar wideband
model below with those values at `analysis.loss_reference_ghz`: the loss stays
nearly flat across the band and vanishes at DC, and εr′ falls about
1.5 × tan δ × εr per decade (for FR-4, 0.13 per decade, 3 %), which is
how a real laminate's loss and permittivity are tied (Kramers-Kronig). A
constant εr′ with a constant loss tangent is not causal, so a time-domain
solver has to pick one of these two models. The other, the opt-in
`"dispersion": { "model": "conductivity" }`, keeps εr′ constant and makes the
loss a conductivity exact at the loss reference, as openEMS does; its loss
tangent grows as 1/f below the reference and it still conducts at DC, which a
TDR level reads as a leak ([differential-pairs.md](differential-pairs.md#the-substrates-loss-model)).
Use it to compare with a tool or a closed form that assumes a constant εr. A
loss too high for the wideband model (its high-frequency εr would fall
below 1, for example tan δ 0.2 on εr 1.2) keeps the constant conductivity,
and rasterise says so. The wideband model costs about 9 to 16 Debye poles (two per decade of the band plus three guard decades) on every
substrate edge, about 110 bytes of pole state per edge against 16 bytes of
field arrays: Pozar's stepped filter on its refined mesh (5.8 M cells) holds
337 MB of pole state beside 279 MB of fields, and an FR-4 patch solve took
17 % longer per step on the software GPU. A GPU whose buffer limit the pole
state exceeds refuses the model with the reason. Three
optional keys go further:

```json
"materials": {
  "FR-4 wideband": { "eps_r": 4.4, "tan_delta": 0.02,
                     "dispersion": { "model": "djordjevic_sarkar", "at_ghz": 1 } },
  "absorber":      { "eps_r": 6, "tan_delta": 0.3,
                     "dispersion": { "model": "poles", "at_ghz": 5,
                                     "poles": [{ "type": "debye", "delta": 4, "f_relax_ghz": 2 }] } },
  "ferrite":       { "eps_r": 12, "tan_delta": 0.002, "mu_r": 4, "mu_tan_delta": 0.2,
                     "mu_dispersion": { "model": "poles", "at_ghz": 2,
                                        "poles": [{ "type": "lorentz", "delta": 3, "f_res_ghz": 3, "damping_ghz": 1.5 }] } }
}
```

- **`dispersion: { model: "djordjevic_sarkar", at_ghz, f_low_hz?, f_high_hz? }`**:
  the wideband model EM tools use for FR-4 and other glass-epoxy laminates
  (Djordjevic et al., IEEE Trans. EMC 43(4), 2001). `eps_r` and `tan_delta`
  are the values at `at_ghz`, as a datasheet gives them. The loss stays nearly
  flat between `f_low_hz` and `f_high_hz` (default 1 kHz and 1 THz) and εr′
  falls about 3 % per decade, which is what these laminates do and is causal.
  The solver runs it as a sum of Debye poles fitted to the analysis band (to
  1e-4 in εr′ and 0.3 % in εr″, with the default corners or with a corner
  near the band).
- **`dispersion: { model: "poles", at_ghz, poles }`**: Debye relaxations
  `{ type: "debye", delta, f_relax_ghz }`, χ = Δ / (1 + j f / f_relax), and
  Lorentz resonances `{ type: "lorentz", delta, f_res_ghz, damping_ghz }`,
  χ = Δ f_res² / (f_res² − f² + j f · damping), up to 8. The constant part and
  a conductivity are set so the material has its `eps_r` and `tan_delta` at
  `at_ghz`; a pole set that needs a constant part below 1, or more loss than
  `tan_delta`, is refused with the reason.
- **`dispersion: { model: "table", points }`**: a measured table, as a
  laminate datasheet gives Dk and Df against frequency:
  `points: [{ "f_ghz": 1, "eps_r": 3.50, "tan_delta": 0.0040 }, ...]`, 2 to
  200 rows in increasing frequency. `eps_r` and `tan_delta` may be left out
  of the material; they then take the row nearest the table's middle (in log
  frequency) and serve only lists and exports. The solver fits Debye poles at
  three relaxation frequencies per decade, from a decade below the table to
  a decade above, with non-negative weights and a constant part of at least
  1 (non-negative least squares), so the fit is causal and passive whatever
  the table says. A smooth table such as a laminate's comes back within 1e-5
  in εr′ and 1e-4 in εr″, rows and between them. A table that no causal
  material passes through (εr′ flat while the loss is not, or noise), or a
  single sharp relaxation the fixed frequencies cannot place (up to 7 %; use
  `poles` for it), is fitted as near as it can be, and rasterise warns when
  that is worse than 2 % or when the analysis band runs past the table.
  Given `eps_r` and `tan_delta` are not checked against the table.
- **`dispersion: { model: "conductivity" }`**: constant `eps_r`, the loss a
  conductivity exact at `analysis.loss_reference_ghz` (above).
- **`mu_r`, `mu_tan_delta`**: relative permeability and magnetic loss tangent
  (μ″/μ′), constant across the band with the loss exact at the loss
  reference, like `eps_r` and `tan_delta`. **`mu_dispersion`** takes the same
  `poles` model for the permeability (needs `mu_r`, its value at `at_ghz`).

How it is solved: each dispersive or magnetic Yee edge gets an
auxiliary-differential-equation update (Taflove and Hagness, ch. 9) after the
main E or H pass, on the CPU and the GPU alike. E edges on a layer interface
mix the two sides by height, which is exact for any poles. Hz on an interface
between two magnetic materials sees them in series (B is continuous), so it
takes the series mean, as a constant at the loss reference; inside one
material it keeps the full model. Ports keep the substrate's εr at the loss
reference, as before, and a material whose εr′ is below 1 at the loss
reference (just above a resonance) is refused, since the port needs a plain
εr there. A Lorentz resonance must be resolved by the time step: with ∞ the
material's high-frequency value, 2π f_res dt √(1 + Δ / ∞) ≤ 1, which on
0.5 mm cells is about 170 GHz for a weak pole and 17 GHz for Δ / ∞ = 100.
The energy stop counts the energy stored in the poles and weights H by μ
on magnetic edges. A coax probe's pin through a magnetic board sees the board's
μ, as a real one would. Its PTFE bore runs below the ground plane, and is
painted for E only, so a magnetic layer under the ground keeps its μ inside
the bore. Rasterise warns about each of these when it applies, and when a
layer has fewer than about 10 cells per wavelength inside the material
anywhere in the band (λ0 / Re √(εr μr), which for εr 12 and μr 4 is a
seventh of the vacuum wavelength, and shorter still near a resonance).
Low-frequency magnetics such
as 13.56 MHz NFC ferrite sheets are valid input, but a time-domain solve
there needs millions of steps; that is a solver limit, not a material one.
The checks are in [validation.md, section 2.4](validation.md#24-frequency-dependent-and-magnetic-materials).

## Importing copper from Gerber, DXF or STEP

Instead of typing polygons, bring real copper in from PCB or CAD files. A
template project supplies everything that is not geometry (stackup,
materials, port, boundaries, mesh, analysis, outputs); the import fills
`board.outline` and the `geometry` of each imported copper layer:

```bash
npm run noburf -- import --stackup template.json \
  --layer top=board-F_Cu.gbr --layer gnd=board-B_Cu.gbr \
  --outline board-Edge_Cuts.gbr --out project.json
# DXF: name the drawing layer after a colon; --units for files without $INSUNITS
npm run noburf -- import --stackup template.json \
  --layer top=board.dxf:TOP --layer gnd=board.dxf:GND --outline board.dxf:OUTLINE --out project.json
# STEP: choose bodies by name or by height (KiCad 8 copper export, 1.6 mm board)
npm run noburf -- import --stackup template.json \
  --layer top=board.step:@1.6mm..1.635mm --layer gnd=board.step:@-0.035mm..0mm \
  --outline 'board.step:*_PCB' --origin outline-center --out project.json
```

Each `--layer` maps a file (a DXF layer, or STEP bodies) to a copper layer of the
template's stackup; copper layers not named keep the template's shapes, and
without `--outline` the template's outline stays. Gerber, DXF and STEP can be mixed.
The template's port is in the same coordinates as the imported files, and
must land on imported copper. KiCad and most CAD tools export page or model
coordinates, so a board can sit at (150 mm, -80 mm); `--origin` moves the
files so that one point becomes (0, 0): `--origin "150 mm, -80 mm"` names
the point (lengths with units), `--origin outline-min` uses the lower-left
corner of the imported outline's bounding box and `--origin outline-center`
its center. Copper and outline move together; the template does not, so type
the port in the moved coordinates. The command prints which file point became
(0, 0). Coordinates are written as `"<mm> mm"` strings
rounded to 1 nm; shapes are named `<layer>-1`, `<layer>-2`, ... Every
unsupported construct is an error naming the file and line, never skipped.

- **Gerber (RS-274X)**: `%FS` (absolute), `%MO` mm and inch, `%AD` circle,
  rectangle, obround and polygon apertures, `%AM` macros (primitives 1, 4,
  5, 20, 21; KiCad's `RoundRect` works), D01/D02/D03, G01, G02/G03 with
  G75, G36/G37 regions, and `%LP` dark/clear: clear objects become `cut`
  shapes painted in file order. Flashes and strokes become polygons
  (a round-pen arc is a ring band plus two round caps). Attributes are read
  past. Not supported: step and repeat, block apertures, `%LM`/`%LR`/`%LS`,
  aperture holes, thermal macro primitives, G74 single-quadrant arcs.
- **DXF (ASCII)**: closed LWPOLYLINE / POLYLINE with bulge arcs, CIRCLE, and
  LINE / ARC chains that close. Nested contours alternate copper and hole.
  Other entities (TEXT, SPLINE, HATCH, INSERT, ...) are refused on the layers
  you import and ignored on the others. Units from `$INSUNITS`, else `--units`.
- **STEP (AP203, AP214, AP242 text files)**: B-rep bodies from the
  assembly, each placed by the transformations above it (assembly links and
  MAPPED_ITEM; a part used twice is two bodies) and named after its product,
  with the body's own name after a slash when it has one
  (`patch_antenna/Cut-Extrude1`). After the colon comes a
  selector: comma-separated name globs (`*_track_*,*_pad_*`, any case),
  a height band (`@1.6mm..1.635mm` keeps bodies lying inside it), or both
  (`*_pad_*@1.6mm..1.635mm`). KiCad names copper `track` and `pad` without
  the side, so choose its layers by height. A selector that matches nothing
  lists the bodies grouped by height, with a height band for each group
  that the band picks out on its own.
  A chosen body must be flat: a sheet (all faces horizontal at one height)
  or a solid extruded along z (horizontal faces, vertical planes and
  cylinders, every upward face at the top). Its copper is its top face, or
  the sheet's faces; holes in that face (drills, slots) cut the copper.
  Bodies with holes are painted first, largest first, so a pour's
  clearances do not erase the pads inside them. Face edges may be lines and
  circular arcs; ellipses, splines and anything not flat are errors naming
  the body and line. Boards modelled with another axis up (SolidWorks uses
  y) need `--step-up y` (also `x`, `-x`, `-y`, `-z`); each is a rotation,
  never a mirror. Units come from the file (mm, inch, m, ...). The heights
  in the file are not used by the solve: the template's stackup is, and
  the command warns when the gap between two STEP copper layers differs
  from the dielectric between them in the stackup.
- **Outline**: the drawn lines and arcs of an outline Gerber, or one DXF
  layer, chained into exactly one closed loop (no cut-outs inside the board);
  or the top face of one STEP body, whose holes are left out (the command
  says how many).
- **Curves** become chords that stay within 0.01 mm of the true arc
  (`ARC_CHORD_TOLERANCE_MM` in [`src/import/geometry.ts`](../src/import/geometry.ts)),
  so a circle imports as a slightly smaller inscribed polygon.

Out of scope: IGES and other 3D formats, compressed STEP (.stpz),
drill files (vias), solder mask and silkscreen. The importers are in [`src/import/`](../src/import/).

## Limits today

Lumped ports, SMA edge connectors and coax probes (the last two on the CPU); the S-matrix file needs one reference impedance for all
ports; the far field needs a one-port project. On a uniform mesh, shapes and ports snap to the
cell grid, so on the example's 0.5 mm cells a length moves in 0.5 mm steps;
use `mesh.graded` to put lines on the edges instead, or `mesh.conformal` to
model edges between lines (and slanted or curved ones) by the part of each
cell they cover.
See [validation.md](validation.md) for what that costs in accuracy.
