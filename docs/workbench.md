# The NobuRF workbench

The workbench is the desktop-style app in `workbench.html`. You build or import a board, set its
materials, stackup and ports, solve it, and read |S|, the Smith chart, input impedance, the far
field and field maps. Everything runs in the browser tab: the solve uses your GPU through WebGPU,
or the processor when there is no GPU.

A workbench project is the same JSON file the `noburf` command solves, so a board saved here can be
solved from a script and the other way round. The file format is in [project-file.md](project-file.md).

## Start it

```bash
npm install
npm run dev:web
```

Open <http://localhost:5173/workbench.html> in Chrome or Edge. On first start it opens the example
patch antenna. after that it reopens whatever you had open last; add `?fresh` to the address to start
from the example again (it asks first if the last session had unsaved changes).

WebGPU needs Chrome or Edge 113 or later, and a page served from `localhost` or `https`. On a Windows
laptop with two GPUs, set Edge or Chrome to "High performance" under Settings, System, Display,
Graphics, or the browser solves on the integrated GPU.

## The window

The top bar holds the file commands (New, Open, Examples, Import, Save), Undo and Redo, a status line that
says whether the project can be solved, the solver choice and the Solve button.

On the left, the project tree lists variables, materials, the stackup, copper shapes per layer,
ports, and the solve settings. Click an item to edit it in the panel on the right. Each group ends
with an Add entry.

The middle shows the 3D model, and after a solve the result tabs. The console at the bottom lists
messages, newest first, and shows a progress bar while a solve runs.

## Start a project

New offers four starting points. Each one is an ordinary project, so you can change any of it
afterwards.

- Patch antenna: a rectangular patch for your design frequency, laminate and thickness, with one
  port. W and L come from the transmission-line model, and the edge resistance from the same model with
  mutual coupling (Balanis, Antenna Theory, 14.2). A 50 Ω line feeds the patch through an inset cut to
  the depth that model gives for 50 Ω, with notches 1 mm wide, or narrower on a small patch. When the
  patch is too narrow for an inset, the feed meets the edge instead and the patch is not matched. A
  board you set smaller than the patch the formulas ask for shrinks the patch, and the console says so.
  The console lists the numbers. The model ignores the feed line and the
  finite ground, so treat the sizes and the inset as starting points. For Balanis Example 14.1, NobuRF
  and openEMS both put the inset patch at about 10.4 GHz, but with a shallow dip: R at the port is
  near 30 Ω, not 50, so the inset needs adjusting. In NobuRF about 1.75 mm matches to −23 dB, but the
  notches move the resonance to near 11.8 GHz, so 10 GHz also needs a longer patch. With a plain edge
  feed both solvers put it near 8.5 GHz.
  Solve, then adjust patch_l and inset_d.
- Microstrip line: a 50 Ω line between two ports, the usual first check of a laminate and a mesh.
  After a solve, the Line tab reports its Z0 and εeff.
- Differential pair: two of those 50 Ω lines side by side, a gap of two line widths apart, with
  four ports already paired at each end. After a solve, the Differential tab reports the pair. The
  gap is a variable, so you can tighten it toward an impedance target. A lossy laminate is a
  wideband (Djordjevic-Sarkar) material with its εr and tan δ at the design frequency, as every lossy
  material is by default, so the TDR level is right down to DC ([differential-pairs.md](differential-pairs.md#the-substrates-loss-model)).
- Blank board: ground, the laminate and an empty top layer. Draw or import copper, then add ports.

Leave the board size empty to have it sized from the design. If the open project has unsaved
changes, New asks before it replaces them.

## Build a board

Lengths take units and may use variables: `12.4 mm`, `62 mil`, `patch_w / 2`. A plain number where a
length is expected is refused, so a missing unit never slips through as metres or millimetres.

"Add material" opens a library of laminates (Rogers and AGC, formerly Taconic, among them), ceramics and
metals. Type to search, or add a custom dielectric or metal. Laminate values are the maker's design
Dk and Df near 10 GHz, so check your datasheet when the frequency or thickness is far from that.

The board outline is listed under Stackup. Edit its points in the panel; it needs at least three.
Dielectric exists only inside it.

Variables can have a minimum, a maximum and a lock. The design agent and scripts cannot change a
locked variable. The status line turns to "Needs a fix before it can be solved" while any value is
out of range or does not parse, and the field with the problem shows the message underneath. The
model view keeps drawing the last valid version meanwhile.

The stackup is listed bottom to top. Copper layers are zero-thickness sheets between dielectric
layers. "Add layer pair on top" adds a dielectric and a copper layer above the current top.

Copper shapes are painted in list order. A shape set to "Cut copper" removes copper painted before
it, which is how you make slots and notches. "Add rectangle" adds a rectangle to that layer; edit
its points in the panel.

You can also draw in the model view with the tools under it: Rectangle (drag), Polygon (click each
corner) and Port (click on copper), on the layer chosen beside them. Points snap to a 0.1 mm grid,
and a shape's edges line up with the straight edges of nearby copper and the board outline (within
8 pixels, and never more than 0.5 mm), so a feed you draw meets the patch edge exactly. Hold Shift
to turn that off for a fine feature. Edges a hair
apart would otherwise put mesh lines 0.1 mm apart, and that one cell sets the time step for the
whole solve.

A port is a lumped source between two copper layers at an (x, y) point, with a reference impedance.
It has to touch copper on both layers. If an edit or an import leaves a port in bare laminate, the
status line says "A port is not on copper" and the console names the port and layer. The project
still solves, but that port drives nothing.
With two or more ports, the Solve settings choose which ports to excite. Each excited port is one
solver run, and exciting all of them gives the full S-matrix.

Under Solve settings you set the band, the mesh, when to stop, and the outputs. A graded mesh puts
mesh lines on every copper edge, the port and the layer interfaces, so nothing snaps to the grid.
A far field needs a PML on every face and at least 4 cells of air on every side; the panel says so
if a setting is missing. With several ports, the far field is the whole array's with every excited
port driven in phase, or as Array drive under Excite sets it: an amplitude (relative to the other
ports) and a phase in degrees for each excited port. A positive phase leads, and the beam turns
toward the port that lags. An amplitude of 0 turns a port off, leaving it a load of its reference
impedance. The drives are `outputs.array_excitation` in the project file
([project-file.md](project-file.md#far-field-of-an-array)). They only weight the solved runs, so
changing one steers the beam without a new solve: the Far field and Emissions tabs, the lobe and
the field views (Ez, Current, Cut and the near-field map) update at once, and the results do not go
stale. The field legend names the drives it shows. Cuts keep the whole-grid field of every port's
run, which slows each run and shares the cuts' memory among the ports, so a large array may keep
cuts at fewer frequencies, or none (the Cut legend says so). The Far field tab lists each port's
drive and its active reflection. Renaming a port keeps its drive. Removing the port, unticking it
under Excite, or emptying the Far field at box drops it. Once no driven port is left, every excited
port is driven in phase.

Turn on Mesh in the model view to see the mesh lines the solver will use, and Solve box to see the
air and PML around the board.

## Import copper or an outline

Import reads Gerber (RS-274X), DXF and STEP files into the open project. It replaces the shapes on
one copper layer, or the board outline, and leaves the stackup, ports and other layers alone.

- Gerber: choose the copper layer to replace. For an outline, import the board-edge file as the
  outline.
- DXF: pick the drawing layer after you choose the file.
- STEP: name the bodies to import, by name (`*_PCB`) or by height (`@1.6mm..1.635mm`), as KiCad's
  copper export writes them. Once you choose the file, the dialog lists its bodies by height, with
  the selector for each height that picks exactly those bodies.

"Position" keeps the file's coordinates, centers what you import on the origin, or puts its
lower-left corner there. Layers of one board only line up if each is imported with its own
coordinates kept. If imported copper lands wholly outside the board outline, a warning says so: a
solve would leave it out. After an outline import the warning also names copper drawn for the old
outline, such as the ground plane of a new blank board, which stays where it was. After an import, check that the ports still sit on copper. Undo puts the
old geometry back. A file that is not Gerber, DXF or STEP is refused with a plain message; for a
project file, the message says to use Open.

## Solve

Press Solve, or Ctrl+Enter. "GPU, else CPU" uses WebGPU when the browser offers it; "CPU only" uses
the reference solver, which gives the same answer and takes much longer (about 2 minutes for the
default example with its far field, against about 4 s for the time loop on a laptop GTX 1660 Ti).

The solve runs in the background, so you can keep editing. The progress bar follows the field
energy: the run stops once the energy has fallen by the amount set in Solve settings, or at the step
limit. If it hits the step limit first, a warning says the results are approximate and suggests
raising the limit.

Mesh check sets whether the solve measures its own mesh error ([self-check.md](self-check.md)). It
is off by default. "One finer mesh" also solves a mesh with cells 1/√2 the size, about 3 times one
solve in all, and then shows that finer mesh's results, with an error bar on the resonance and the
dip depth and how far S moved between meshes. The error bar covers the mesh only, not the port or
material model. "Two finer meshes" solves both finer meshes, about 10 times one solve, and says
whether S and the resonance settled; use it on the GPU. The passivity and reciprocity checks and
the validated range show on every solve. The mesh check needs a graded mesh without SMA or
coax-probe feeds; otherwise the
tab says why there is no error bar, and the physics and range checks still run.

Press Stop to end a solve. Opening another project also stops it, so no results land on the wrong
board.

If the GPU resets during a solve, which Windows does when one GPU job runs too long, the solve ends
with a message saying so. Solve again, or switch to "CPU only". If WebGPU cannot fit a large grid,
the message says so and suggests "CPU only".

## Results

After a solve the result tabs open.

- S-parameters: |S| in dB across the band, with the deepest S11 and the bandwidth below −10 dB. With
  several ports, transmission terms are dashed.
- Smith chart: the input impedance at each excited port, with a dashed circle at |S11| = −10 dB.
- Impedance: the real and imaginary parts of Z_in, and their values at the frequencies listed under
  "Report Z at".
- Far field: E-plane and H-plane cuts, peak directivity and gain, realised gain, radiation
  efficiency, beamwidth, front-to-back ratio and cross-polar level.
- Emissions: a near-field scan and the field at a distance, as a first look at where a design radiates. The map shows
  |H|, |E| or one component on a plane at each height listed under "Near-field scan at" (above the
  top copper), in dBµA/m or dBµV/m RMS with 40 dB of colour range, the top copper outlined and the
  peak ringed. With a far field, it also lists E at 3 m and 10 m in the direction of peak gain,
  with the FCC Part 15.109 Class B (3 m) and Class A (10 m) limits as reference values only (no
  CISPR limits), and the EIRP. Every figure scales with the drive power set in the tab, so changing
  it needs no new solve. The source is the port drive, not a board's unintentional emission, and
  cables, enclosures and real noise sources are not modelled, so none of this is a compliance
  verdict.
- Line: for two ports at the ends of one straight strip. When both ports sit on the top copper and
  nothing there joins them (neither copper nor a lumped part placed on the layer), as on two
  separate patches, the tab stays off. It shows Z0 and εeff, fitted to the field
  along the middle of the strip, away from the ports, so the port connections do not enter them. It
  also shows a step TDR from each port. The TDR comes from S11 and S22, so the steps at either end are
  the port connections. A trace that reaches 19 times the reference impedance stops there, marked
  open. If the field does not look like a single uniform line, the tab says so rather than showing a
  fit.
- Differential: for four or more ports that form pairs of lines. It shows the differential
  insertion loss Sdd21, return loss Sdd11 and mode conversion Scd21, the differential TDR from each
  end, the line's differential and common-mode impedance, the delay and the intra-pair skew. If the
  project has no pairing yet, the tab proposes one from which ports transmit to which and where they
  sit, and shows its results at once; Use this pairing writes it into the project. Swap + and −
  flips polarity at every end, and the reference fields set the differential and common-mode
  reference impedances (empty means twice and half the ports' own). The pairing is post-processing,
  so changing it does not make the results stale. See [differential-pairs.md](differential-pairs.md).

Each tab also lists the solver, the mesh, how many steps ran and how far the energy fell. With a
mesh check, the S-parameters tab lists its results above those.

Below the facts, the S-parameters tab exports a Touchstone file, a CSV or an image. The Impedance
tab exports a CSV or an image, the Smith chart, Emissions and Line tabs an image, and the
Differential tab its figures as JSON (the same file `noburf solve` writes) or either chart as an image.

In the model view, Ez shows the vertical field in the substrate under the top copper, and Current
shows the surface current on the top copper in dB. Pick the frequency next to the legend. With
several ports, the legend says which ports drive the field: the array's drives with a far field,
else the first excited port with the others loaded. Radiation
lobe draws the 3D pattern over the board.

Ez is drawn at one instant, Re{Ez e^(j phase)}, and plays through a cycle every two seconds. Pause
stops it, and the Phase slider sets the instant (0 to 359 degrees); dragging it also pauses. With
reduced motion turned on in the system, the field starts paused. Image saves the view as PNG with
the field and phase written in the corner. Video saves one full cycle (2 s, 30 frames per second)
as WebM, which loops without a jump; it is encoded frame by frame, so a slow computer takes longer
to make it but the clip still plays at the right speed.

If you edit the project after a solve, a note says the results are from the earlier version. The
plots stay until you solve again. Undoing back to the solved version clears the note.

## Files

Save downloads the project as JSON. While there are unsaved changes, the Save button shows a dot and
the tab title says "(edited)".

The workbench also keeps a copy of the open project in the browser, so a reload or a crash brings
it back, with unsaved changes still marked as unsaved. Opening a file, an example, or dropping a
file on the window asks first when there are unsaved changes. If the browser refuses to keep the
copy (a private window or full storage), a warning says so, and closing the tab asks first.

Open reads a project file, or you can drop one anywhere on the window. A file with a problem still
opens, with the problem shown, so you can fix it.

## Keys

| Keys | Does |
| --- | --- |
| Ctrl+Z, Ctrl+Shift+Z or Ctrl+Y | Undo, redo (outside text fields) |
| Ctrl+S | Save |
| Ctrl+Enter | Solve |
| Left and right arrows | Move between result tabs when a tab has focus |

On a Mac, use Cmd instead of Ctrl.

## Limits today

- Planar boards only: copper sheets on a stackup, no vias or 3D bodies yet.
- Lumped ports only. The modelled SMA connector is validated in the solver
  ([validation.md](validation.md#32-a-modelled-sma-connector-instead-of-a-lumped-port)) but cannot be
  placed in the workbench yet.
- See [validation.md](validation.md) for how the results compare with openEMS and published
  measurements, and what still disagrees.
