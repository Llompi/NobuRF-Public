# Mesh check, physics checks and validated range

A field solver can be wrong in two separate ways, and they need different
evidence:

1. **The equations were solved too coarsely.** Every grid gives a slightly
   different answer. This error can be measured on any design, with no
   reference to compare against, by solving the same design on more than
   one mesh. Verification and validation practice calls this *solution
   verification*.
2. **The equations leave out something real**, such as surface roughness, a
   material whose ε changes with frequency, or a feed modelled more simply
   than the hardware. This can only be found by comparing against
   measurements, and it is only known where measurements exist. That is
   *validation*.

The mesh check measures the first kind and nothing else: how far the answer
could still move on a finer grid of the same model. A design can pass it and
still be wrong by the second kind. For that, NobuRF can only say whether the
design's features match benchmarks that agree with measurement, which today
means one-port, lumped-fed patches on low-ε substrates.

## What a solve reports

`noburf solve` and the workbench run three checks after the solve:

| Check | What it measures | Cost |
| --- | --- | --- |
| Mesh check (opt-in) | Error bar on the resonance and on \|S11\| at the dip, and how far S moved between the two finest meshes | about 3 times one solve with one finer mesh |
| Physics | Passivity (largest singular value of S), reciprocity (\|S_ij − S_ji\|), and whether the field rang down | free, always on |
| Validated range | Whether each feature of the design (substrate, ports, copper model, edges, band) matches a benchmark that agrees with measurement | free, always on |

The error bar is **mesh discretization uncertainty only**. It does not
include port or material model error. Every printed bar and the `scope`
field in `result.json` say so.

In `result.json` this is the `self_check` entry. With a mesh check the
console prints a summary line like this:

```
mesh check over 2 meshes (mesh discretization uncertainty only; it excludes port and material model error): f_res 5.2758 GHz +/- 3.76 % (the resonance is measured on two meshes, so the band assumes first-order convergence with a safety factor of 3), |S11| at the dip 0.379 +/- 0.264, still moving: Delta S 0.0756 (tolerance 0.02), resonance shift 0.39 % (tolerance 0.5 %)
```

Modes (`--mesh-check` on the command line, **Mesh check** in the workbench
toolbar):

- **off** (default): one solve on the project's mesh. The physics and
  validated-range checks still run.
- **check** ("One finer mesh"): also solves a mesh with every cell 1/√2 the
  size. **The reported numbers are then the finer mesh's**, and the bar comes
  from the two. On a uniform grid a finer mesh would take r⁴ = 4 times the
  cell-steps (r³ cells, a time step r times shorter). A graded mesh refines
  less than that, because lines fixed at copper edges and layers stay put:
  on the example patch the finer mesh had 1.6 times the cells and took 2.1
  times as long, so check cost about 3 times one solve in all.
- **refine** ("Two finer meshes"): always solves both finer meshes, cells
  1/√2 and ½ the size, and reports the finest. Three levels give the band an
  observed order. It does not stop after one quiet pass, because one pass
  can settle by chance. It then reports "settled" when the last pass moved S
  less than the ΔS tolerance (`--delta-s`, default 0.02) and the resonance
  less than 0.5 %. It costs about 10 times one solve, so use the GPU.

The study only refines, never coarsens. A coarser mesh than the project's
resolves less than the user asked for: an edge cell can grow past a strip
width, or a substrate can drop to one or two cells, so the coarse level is
outside the range where error falls as a power of h, and an error bar built
on it says more about the coarse mesh than about the result.

The mesh study runs on graded meshes without coax feeds. A uniform mesh
rounds each layer to whole cells, so a finer one is a different board. A coax
feed (`sma_edge`, `coax_probe`) is meshed with fixed-size cells that do not
scale with the rest. In both cases the result says why it has no error bar.
The physics and envelope checks still run. Each level must ring down to the
requested energy level, the project's own mesh included, or the study stops
and says which mesh did not. If
the first finer mesh fails to solve, there is no error bar; in refine mode a
later finer mesh that fails ends the refining, and the finest mesh that
solved is the result, with a warning.

## The method

**Mesh levels.** A level multiplies every mesh length by the same factor:
`mesh.cell`, and `mesh.graded.edge_cell` on a graded mesh. Counts measured in
cells (cells across a dielectric, the air margin) are divided by it so the
physical sizes stay the same, rounded to whole cells. The PML keeps its cell
count, because its reflection depends on cells, not millimetres. Each level
is rasterised from scratch, so the check measures every discretisation error
at once: numerical dispersion, how edges and layers land on the grid, the
port, and the boundary distance in cells. This is the systematic refinement
that Roache's method assumes. Every level gets twice the step cap, and 1/scale
more on top, because the time step follows the smallest cell. The cap is only
a limit; the energy stop ends the run.

**Cell size h.** Celik's representative size, h = (V/N)^(1/3), counted on the
board region: inside the outline's bounding box and through the stackup. It
is measured, not taken from the scale factor. Whole-cell rounding and lines
fixed at copper edges keep the real ratio from being the nominal √2: on the
example patch the board cells are 0.415, 0.317 and 0.242 mm at scales 1,
1/√2 and ½, ratios of 1.31. The ratio sets the size of the bar, so a nominal
one would misstate it. Two levels less than 5 % apart in h count as the same
mesh, and the study stops.

**Error bar.** The Grid Convergence Index (GCI) of Roache [1], computed with
the procedure in Celik et al. [2], which ASME V&V 20 [3] also adopts:

- **Two meshes** (check mode). GCI = 3 · |φ₁ − φ₂| / (r − 1): Roache's
  two-grid form, with safety factor 3 because no order was observed, and
  order 1 assumed. First order is the honest assumption: the Yee scheme is
  second order in a homogeneous medium [4], but staircased metal edges
  converge more slowly, as O(√h) in the worst case shown by Häggblad and
  Runborg [5]. Assuming order 2 would make the bar 2.4 times smaller with
  nothing to show for it.
- **Three meshes** (refine mode). The observed order *p* comes from the three
  finest levels by fixed-point iteration, which allows unequal refinement
  ratios (Celik eqs. 3a to 3c). GCI = Fs · |φ₁ − φ₂| / (r₂₁^p − 1). Following
  Eça and Hoekstra [6], an observed order inside [0.8, 2] uses Fs = 1.25; an
  order outside it is clamped into that range and uses Fs = 3. An order above
  2 comes from noise between levels and would shrink the bar for no reason;
  one below 0.8 means the levels are not yet converging cleanly.
- The Richardson extrapolation (r^p φ₁ − φ₂)/(r^p − 1) estimates the answer on
  an infinitely fine mesh. It is reported, not used as the result.
- Two levels can agree by chance where their curves cross. With three levels
  the finest change used is never less than what the order and the coarser
  change predict, e₂₁ ≥ e₃₂ (r₂₁^p − 1) / (r₂₁^p (r₃₂^p − 1)), so a
  coincidence cannot zero the bar. An exact tie shows no order at all, so it
  is treated like an order out of range: order 2, Fs = 3.
- The bar applies to scalar features, the resonance and the dip depth, not
  to S at each frequency. Near a sharp dip S at a fixed frequency does not
  converge smoothly, so a per-frequency GCI means little there.

**Behaviour.** With three levels, the ratio R = ε₂₁/ε₃₂ of successive changes
classifies them, following Stern et al. [7]:

- 0 < R < 1: monotone convergence. The GCI applies.
- R < 0: oscillation.
- R > 1: divergence.

Oscillating or diverging levels are not in the asymptotic range, where error
falls as hᵖ, and the GCI does not apply. The result is flagged as a rough
bound, and the bar becomes 3× the largest change seen, in the spirit of
Roache's Fs = 3.

**Resonance and depth.** f_res and |S11| are taken at the dip, refined
between frequency samples by a parabola in dB. The sample spacing (0.5 % of
the band center on the examples) is larger than the mesh error being
measured, so the nearest sample would hide it. On every level the dip used is
the one nearest the finest level's deepest, so two different modes are never
compared. The depth's bar is on linear |S11|, not dB. In dB a deep dip moves
by tens of dB for a tiny change in |S11|, and its GCI would explode.

**ΔS and "settled".** ΔS is the largest complex difference
|S_ij(f) − S'_ij(f)| between consecutive levels, over every measured entry
and every frequency in the band. That is stricter than a ΔS taken at one
adaptive frequency, as adaptive finite-element meshing does. A resonance that moves by 0.5 % moves S
near the dip by a lot, so a high-Q design can show ΔS above 0.02 while its
resonance is known to a fraction of a percent. The last pass counts as
settled when both hold: ΔS ≤ 0.02 and the resonance moved less than 0.5 %.
ΔS is reported, but it
warns only when there is no resonance estimate to look at instead. A
resonance bar above 1 % warns (wider than the benchmarks' agreement with
measurement).

## On the example patch

`examples/patch-5g8-graded.json` (5.25 GHz edge-fed patch on 1.5 mm FR-4,
graded 0.25 mm edge cells), CPU reference solver:

| Mesh (scale) | Board cell h | f_res (GHz) | ΔS to the previous mesh |
| --- | --- | --- | --- |
| 1, the project's | 0.415 mm | 5.2553 | |
| 1/√2 | 0.317 mm | 5.2758 | 0.076 |
| ½ | 0.242 mm | 5.2798 | 0.052 |

- **Check mode** reports 5.2758 GHz ± 3.76 % (5.08 to 5.47 GHz) and warns
  that the bar is above 1 %. The bar is wide on purpose: with two meshes no
  order is observed, so it assumes first order with a safety factor of 3.
  The next finer mesh lands at 5.2798 GHz and openEMS at 5.27, both well
  inside it. The time on four CPU cores was 5 minutes (one solve is about
  100 s).
- **Refine mode** adds the ½ mesh and reports 5.2798 GHz ± 0.95 % (5.23 to
  5.33 GHz). The three levels give an observed order of 6.1, far above the
  formal 2, which says the levels carry noise as well as convergence; the
  order is clamped to 2 and the safety factor stays at 3. openEMS on its own
  0.25 mm mesh reads 5.27 GHz for this patch ([validation.md](validation.md)).
- ΔS over the band stays above 0.02 even at the finest mesh. The dip is sharp
  enough that a 0.08 % shift moved S by 0.05 near it. Refine stops only when
  both ΔS and the resonance move little, which a sharp dip makes hard.

## Physics checks

Passive, isotropic structures have two properties whatever their shape or
material [8]. Both are tested at every frequency:

- **Passivity.** The board cannot return more power than it receives, so the
  largest singular value of S is at most 1. IEEE 370-2020 [9] uses the same
  test in its S-parameter quality checks. When only some ports were excited,
  the full S is unknown, so the test is that each measured column's power sum
  Σᵢ|S_ij|² is at most 1.
- **Reciprocity.** NobuRF has only isotropic materials, so S = Sᵀ exactly,
  and any |S_ij − S_ji| is numerical error. It needs every port excited, so
  it does not run with matched loads.
- **Ring-down.** A run cut off before the field decays leaves energy out of
  the Fourier transform.

| Check | Warns above | Fails above |
| --- | --- | --- |
| Passivity, largest singular value | 1.005 | 1.02 |
| Reciprocity, largest \|S_ij − S_ji\| | 0.005 | 0.01 |

A run that stops at 50 dB of energy decay leaves about 0.003 in every S
entry, so values below the warning level are within that floor. Between the
two levels the result carries a "marginal" warning; above the fail level
the check fails.

## Validated range

The range is gated by feature, not only by number. A range of ε_r means
little if the feed or the copper model in the design was never compared with
a measurement. Each entry is the span of the measured benchmarks in
[validation.md section 7](validation.md#7-published-benchmarks) that agree
with their reference, nothing wider. Design equations (Balanis 14.1 and
14.2) and solver-to-solver comparisons (openEMS) do not count.

| Feature | Validated | Bounded by |
| --- | --- | --- |
| Substrate layers | one | every measured benchmark has one substrate |
| ε_r | 2.2 to 2.33 | Sheen 1990 patch (2.2, −0.3 %), Chang 1986 patches (2.33, −0.5 to +1.9 % on the three in §7.1, −1.8 to +4.0 % on all six up to h/λd 0.11) |
| Substrate thickness / λ_d at f_max | up to 0.10 | Chang 1986: within 4.0 % up to 0.11 (1.8 % with the coax probe). Above that NobuRF reads high with a lumped feed: +7.1 % at 0.125 and +10 to +16 % from 0.134 to 0.23 |
| Band | 2 to 8 GHz | measured resonances from 2.31 GHz (Chang) to 7.5 GHz (Sheen) |
| Ports | one, lumped | the agreeing benchmarks are one-port patches; SMA edge launch and coax probe are checked against openEMS only |
| Copper | perfect conductor | copper loss matches the Pozar 6.3 cavity wall Q within 0.3 %, but has no measured strip-loss benchmark yet |
| Copper edges | axis-aligned | slanted or curved edges are staircased; the mesh bar measures that, but no benchmark has checked it |

The known misses fall outside by construction: the Sheen branch-line
coupler (four ports: 7 to 9 % low with lumped ports, 0.8 to 3.2 % low with
SMA edge ports), the alumina microstrip (ε_r 9.9, ε_eff
0.7 to 1.6 % high), and strip loss. FR-4 (ε_r 4.4) is outside too: it agrees
with openEMS, but no measured FR-4 benchmark has been run. A design outside
the range is not wrong, only unproven. The warning names the benchmark that
bounds the feature and what NobuRF read there.

## What this does not cover yet

- **Edges that merge on one mesh and not the next.** The rasteriser merges
  mesh lines closer than a quarter edge cell, and that radius shrinks with
  the mesh, so two copper edges that merge on the project's mesh can split
  on a finer one. The levels are then not quite the same board. The band
  does not detect this.
- **Local, error-driven refinement.** Each level refines the whole mesh. FEM
  tools refine only where an error indicator is largest, which converges in
  far fewer cells. The graded mesh already puts small cells at copper edges,
  where the field is singular. Refinement driven by a residual or by field
  gradients is the next step.
- **Sub-cell (conformal) edges.** A slanted or curved edge is a staircase on a
  Cartesian grid. Conformal FDTD [12] removes that error at the source. The
  mesh check measures the staircasing error but does not remove it.
- **Frequency-dependent and anisotropic materials.** ε and tan δ are constant
  over the band (exact at `analysis.loss_reference_ghz`). Wideband FR-4, or
  anything above about 20 GHz, needs a Djordjevic–Sarkar or Debye model. The
  envelope warning is the reminder until then.
- **Comparisons with a reference.** Comparing a whole curve against
  measurement or another solver, beyond a few numbers, belongs to the Feature
  Selective Validation method of IEEE 1597.1 [10] and 1597.2 [11]. It is not
  in the per-solve check, because a solve has no reference curve. The
  benchmark scripts quote plain percentage differences, not FSV grades.

## References

1. P. J. Roache, "Perspective: a method for uniform reporting of grid refinement studies," *J. Fluids Eng.*, vol. 116, no. 3, pp. 405–413, 1994.
2. I. B. Celik, U. Ghia, P. J. Roache, C. J. Freitas, H. Coleman, P. E. Raad, "Procedure for estimation and reporting of uncertainty due to discretization in CFD applications," *J. Fluids Eng.*, vol. 130, no. 7, 078001, 2008.
3. ASME V&V 20-2009, *Standard for Verification and Validation in Computational Fluid Dynamics and Heat Transfer*.
4. A. Taflove, S. C. Hagness, *Computational Electrodynamics: The Finite-Difference Time-Domain Method*, 3rd ed., Artech House, 2005, ch. 4 (numerical dispersion).
5. J. Häggblad, O. Runborg, "Accuracy of staircase approximations in finite-difference methods for wave propagation," *Numer. Math.*, vol. 128, no. 4, pp. 741–771, 2014.
6. L. Eça, M. Hoekstra, "A procedure for the estimation of the numerical uncertainty of CFD calculations based on grid refinement studies," *J. Comput. Phys.*, vol. 262, pp. 104–130, 2014.
7. F. Stern, R. V. Wilson, H. W. Coleman, E. G. Paterson, "Comprehensive approach to verification and validation of CFD simulations, Part 1," *J. Fluids Eng.*, vol. 123, no. 4, pp. 793–802, 2001.
8. D. M. Pozar, *Microwave Engineering*, 4th ed., Wiley, 2012, section 4.3.
9. IEEE Std 370-2020, *Standard for Electrical Characterization of Printed Circuit Board and Related Interconnects at Frequencies up to 50 GHz*.
10. IEEE Std 1597.1-2008, *Standard for Validation of Computational Electromagnetics Computer Modeling and Simulations*.
11. IEEE Std 1597.2-2010, *Recommended Practice for Validation of Computational Electromagnetics Computer Modeling and Simulations*.
12. S. Dey, R. Mittra, "A locally conformal finite-difference time-domain (FDTD) algorithm for modeling three-dimensional perfectly conducting objects," *IEEE Microw. Guided Wave Lett.*, vol. 7, no. 9, pp. 273–275, 1997.
