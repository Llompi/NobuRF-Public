"""
openEMS as an arbiter for the two open microstrip gaps in docs/validation.md
section 7.3, on the Pozar Example 3.7 line (0.5 mm alumina, eps_r 9.9,
0.5 mm strip, W/h 1).

z0   Re(Z0) of the lossy line (tan delta 0.3, as a constant conductivity
     exact at 10 GHz, like NobuRF), mean over 8 to 12 GHz. NobuRF reads
     49.2 to 49.3 ohm; the closed form gives 46.67 ohm. Two readings:
       --port lumped  the benchmark file exactly
                      (examples/benchmarks/graded/pozar-ex3.7-z0-lossy-line.json):
                      a 25 mm line from the board edge, a one-edge lumped
                      port under its end, Re(Z_in), what NobuRF reports;
       --port msl     the same cross-section running through the PML at both
                      ends, Z0 from openEMS's MSL port probes
                      (sqrt(V dV / (I dI)), independent of reflections).
     --side sets the ground beyond each strip edge (2.5 mm in the benchmark).
     --edges on puts mesh lines on the strip edges; --edges thirds puts
     them a third of the edge cell inside and two thirds outside (openEMS's
     usual rule).

q    Copper loss from the Q of the half-wave resonator of section 7.3.1: the
     same line, 5.5 mm long, open at both ends, in a closed PEC box, strip
     and ground copper (5.8e7 S/m, 35 um), lossless substrate. A quarter of
     the box is solved: a magnetic wall on the strip's centre line (x = 0)
     and an electric wall half way along it (y = 0) hold the fundamental's
     symmetry. Copper is openEMS's conducting sheet.
       --strip-model sheet  a zero-thickness strip (what NobuRF meshes),
       --strip-model thick  a 35 um strip: sheets on its four faces round a
                            PEC core.
     A Gaussian around the resonance drives Ez under the open end; the
     ring-down gives f0 and Q (the method of scripts/validate/ring_down.ts).

cavity  The conducting sheet on an air-filled copper cavity (20 x 10 x 20 mm
        by default), TE101, against the textbook Q: the check behind
        --sigma-scale (see sheet()), not a microstrip result.

Writes <tag>.json (and a CSV for z0) into ../../docs/validation/data/.

  python microstrip_openems.py z0 --port lumped --edge 0.05 --dcells 6
  python microstrip_openems.py z0 --port msl --side 10
  python microstrip_openems.py q --strip 0.5 --strip-model thick --fine 0.01
  python microstrip_openems.py cavity
"""
import argparse
import json
import os
import tempfile
import time

import numpy as np

from CSXCAD import ContinuousStructure
from openEMS import openEMS

C0 = 299_792_458.0
EPS0 = 8.8541878128e-12
H_MM = 0.5
EPS_R = 9.9
COPPER_S_PER_M = 5.8e7
COPPER_T_M = 35e-6
COARSE_MM = 0.5  # the benchmark's largest cell
PML_CELLS = 8


def sized_lines(fixed, lo, hi, seeds, coarse, ratio=1.3):
    """Mesh lines through every fixed line, with cells no larger than
    h(x) = min(coarse, c + (ratio - 1) |x - p|) over the (p, c) seeds: cell c at
    p, growing by about `ratio` per cell away from it."""
    def h(x):
        return min([coarse] + [c + (ratio - 1) * abs(x - p) for p, c in seeds])

    stops = sorted(set(round(v, 9) for v in list(fixed) + [lo, hi] if lo <= v <= hi))
    lines = [stops[0]]
    for a, b in zip(stops[:-1], stops[1:]):
        xs = np.linspace(a, b, 2001)
        density = 1 / np.array([h(x) for x in xs])
        cum = np.concatenate([[0.0], np.cumsum((density[1:] + density[:-1]) / 2 * np.diff(xs))])
        n = max(1, int(np.ceil(cum[-1] - 1e-6)))
        lines += list(np.interp(np.linspace(0, cum[-1], n + 1), cum, xs)[1:])
    return np.array(lines)


def smallest_timestep(mesh):
    """The Courant step of the smallest cell, close to the step openEMS takes."""
    d = [np.min(np.diff(mesh.GetLines(a))) * 1e-3 for a in "xyz"]
    return 1 / (C0 * np.sqrt(sum(1 / v ** 2 for v in d)))


def out_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "..", "docs", "validation", "data"))
    os.makedirs(out, exist_ok=True)
    return out


def write_meta(tag, meta):
    with open(os.path.join(out_dir(), tag + ".json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps(meta), flush=True)


def edge_lines(edge, inward, cell, rule):
    """Mesh lines for a sheet edge at `edge` whose copper lies towards `inward` (+1 or -1)."""
    if rule == "on":
        return [edge]
    return [edge + inward * cell / 3, edge - inward * 2 * cell / 3]


# ---------------------------------------------------------------- z0

def run_z0(a):
    W, side, e = 0.5, a.side, a.edge
    half_board = W / 2 + side
    line_len = 25.0
    sigma = 2 * np.pi * 10e9 * EPS0 * EPS_R * a.tan_delta
    f_lo, f_hi, nf = 6.0, 14.0, 161

    fdtd = openEMS(NrTS=400_000, EndCriteria=10 ** (-a.stop_db / 10))
    fdtd.SetGaussExcite((f_lo + f_hi) / 2 * 1e9, (f_hi - f_lo) / 2 * 1e9)
    fdtd.SetBoundaryCond(["PML_8"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    # Air to the PML as in the benchmark: 4 coarse cells beside, 3 below, 10 above.
    pml = PML_CELLS * COARSE_MM
    x_lo, x_hi = -half_board - 4 * COARSE_MM - pml, half_board + 4 * COARSE_MM + pml
    z_lo, z_hi = -3 * COARSE_MM - pml, H_MM + 10 * COARSE_MM + pml
    strip_x = edge_lines(-W / 2, +1, e, a.edges) + edge_lines(W / 2, -1, e, a.edges)
    xs = [x_lo, -half_board, 0.0, half_board, x_hi] + strip_x
    x_seeds = [(-half_board, e), (half_board, e), (-W / 2, e), (W / 2, e), (0.0, e)]
    mesh.SetLines("x", sized_lines(xs, x_lo, x_hi, x_seeds, COARSE_MM))
    dz = H_MM / a.dcells
    mesh.SetLines("z", sized_lines(list(np.linspace(0, H_MM, a.dcells + 1)) + [z_lo, z_hi], z_lo, z_hi,
                                   [(0.0, dz), (H_MM, dz)], COARSE_MM))

    if a.port == "lumped":
        # The benchmark: board, ground and strip from y = 0 to 25 mm, air beyond.
        y0, y1 = 0.0, line_len
        y_lo, y_hi = y0 - 4 * COARSE_MM - pml, y1 + 4 * COARSE_MM + pml
        mesh.SetLines("y", sized_lines([y_lo, y0, y1, y_hi], y_lo, y_hi, [(y0, e), (y1, e)], COARSE_MM))
    else:
        # Through line: everything runs into the PML at both ends.
        y_lo, y_hi = -pml - 2.0, line_len + pml
        y0, y1 = y_lo, y_hi
        mesh.SetLines("y", sized_lines([y_lo, y_hi], y_lo, y_hi, [], a.msl_cell))

    sub = csx.AddMaterial("alumina", epsilon=EPS_R, kappa=sigma)
    sub.AddBox([-half_board, y0, 0], [half_board, y1, H_MM], priority=0)
    pec = csx.AddMetal("pec")
    pec.AddBox([-half_board, y0, 0], [half_board, y1, 0], priority=10)

    f = np.linspace(f_lo, f_hi, nf) * 1e9
    if a.port == "lumped":
        pec.AddBox([-W / 2, y0, H_MM], [W / 2, y1, H_MM], priority=10)
        port = fdtd.AddLumpedPort(1, 50, [0, 0, 0], [0, 0, H_MM], "z", 1.0, priority=5)
    else:
        # The port draws its own strip; the rest of the strip runs on to the far PML.
        port_len = a.msl_port_len
        port = fdtd.AddMSLPort(1, pec, [-W / 2, y_lo, H_MM], [W / 2, y_lo + port_len, 0], "y", "z", excite=-1,
                               FeedShift=pml + 1.0, MeasPlaneShift=port_len - 1.0, priority=10)
        pec.AddBox([-W / 2, y_lo + port_len, H_MM], [W / 2, y1, H_MM], priority=10)

    ncells = int(np.prod([len(mesh.GetLines(ax)) - 1 for ax in "xyz"]))
    sim_path = tempfile.mkdtemp(prefix=f"oems_z0_{a.port}_")
    t0 = time.time()
    fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=a.threads)
    wall = time.time() - t0

    port.CalcPort(sim_path, f)
    z = port.Z_ref if a.port == "msl" else port.uf_tot / port.if_tot
    band = (f >= 8e9) & (f <= 12e9)
    tag = (f"openems_msline_{a.port}_side{a.side:g}_e{e:g}_d{a.dcells}_{a.edges}"
           + (f"_tand{a.tan_delta:g}" if a.tan_delta != 0.3 else ""))
    with open(os.path.join(out_dir(), tag + ".csv"), "w") as fh:
        fh.write("f_ghz,z_re,z_im\n")
        for k in range(nf):
            fh.write(f"{f[k] / 1e9:.4f},{z[k].real:.4f},{z[k].imag:.4f}\n")
    meta = dict(case="z0", port=a.port, side_mm=a.side, edge_mm=e, dielectric_cells=a.dcells, edges=a.edges,
                tan_delta=a.tan_delta, cells=ncells, wall_s=round(wall, 1),
                re_z_mean_8_12_ohm=round(float(np.mean(z[band].real)), 3),
                im_z_mean_8_12_ohm=round(float(np.mean(z[band].imag)), 3),
                re_z_at_10_ohm=round(float(np.interp(10e9, f, z.real)), 3))
    if a.port == "msl":
        eps_eff = (port.beta / (2 * np.pi * f / C0)) ** 2
        meta["eps_eff_at_10"] = round(float(np.interp(10e9, f, eps_eff.real)), 4)
    write_meta(tag, meta)


# ---------------------------------------------------------------- ring-down Q

def ring_down(rec, dt, start, f_guess):
    """f0 and Q from a recorded ring-down: windowed DFTs at f_guess, f0 from the
    phase advance between windows, Q from the slope of ln|A| (as ring_down.ts)."""
    length = int(round(20 / (f_guess * dt)))
    hop = length // 2
    w = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(length) / (length - 1))
    t, ln_a, phase = [], [], []
    for frm in range(start, len(rec) - length + 1, hop):
        n = frm + np.arange(length)
        c = np.sum(rec[n] * w * np.exp(-2j * np.pi * f_guess * n * dt))
        t.append((frm + length / 2) * dt)
        ln_a.append(np.log(abs(c)))
        phase.append(np.angle(c))
    t, ln_a, phase = np.array(t), np.array(ln_a), np.unwrap(phase)
    slope = lambda y: np.polyfit(t, y, 1)[0]
    f0 = f_guess + slope(phase) / (2 * np.pi)
    decay = -slope(ln_a)
    return dict(f0_ghz=f0 / 1e9, q=float(np.pi * f0 / decay) if decay > 0 else float("inf"), windows=len(t))


def run_probe(fdtd, csx, mesh, probe_box, f_guess, f_width, cycles, threads, prefix):
    """Run a Gaussian around f_guess, record a voltage probe and analyse its ring-down."""
    probe = csx.AddProbe("ut", 0)
    probe.AddBox(*probe_box)
    fdtd.SetGaussExcite(f_guess, f_width)
    t_end = 9 / (np.pi * f_width)  # the end of openEMS's Gaussian
    dt = smallest_timestep(mesh)
    # openEMS may take a slightly shorter step than this estimate; the margin keeps the cycles.
    fdtd.SetNumberOfTimeSteps(int(np.ceil(1.3 * (t_end + cycles / f_guess) / dt)))
    sim_path = tempfile.mkdtemp(prefix=prefix)
    t0 = time.time()
    fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=threads)
    wall = time.time() - t0
    data = np.loadtxt(os.path.join(sim_path, "ut"), comments="%")
    t, v = data[:, 0], data[:, 1]
    step = float(np.mean(np.diff(t)))
    start = int(np.searchsorted(t, t_end + 2 / f_guess))
    # Refine the carrier on the spectrum of the ring-down before the windowed fit.
    spec = np.abs(np.fft.rfft(v[start:] * np.hanning(len(v) - start), 16 * len(v)))
    freqs = np.fft.rfftfreq(16 * len(v), step)
    near = np.abs(freqs - f_guess) < f_width
    f_peak = float(freqs[near][np.argmax(spec[near])])
    result = ring_down(v, step, start, f_peak)
    ncells = int(np.prod([len(mesh.GetLines(ax)) - 1 for ax in "xyz"]))
    return dict(result, cells=ncells, probe_samples=len(t), sample_s=step, wall_s=round(wall, 1))


def sheet(csx, name, conductivity_scale):
    """openEMS's conducting sheet. With the field on one side of a thick sheet
    (a cavity wall, a ground plane, a face of the thick strip) it dissipates
    half of R_s |H|^2 (the copper cavity below reads Q twice the textbook
    value), as if the current split over both faces. A quarter of the
    conductivity doubles R_s and restores R_s |H|^2; the skin depth stays far
    below 35 um. `conductivity_scale` 0.25 applies that, 1 leaves the sheet
    as openEMS defines it."""
    return csx.AddConductingSheet(name, conductivity=COPPER_S_PER_M * conductivity_scale, thickness=COPPER_T_M)


def run_q(a):
    """Quarter of the section 7.3.1 resonator: x >= 0, y >= 0."""
    W, L, t = a.strip, a.length, COPPER_T_M * 1e3
    cell = a.cell
    side = 2.5 + W / 2
    wall_x = side + cell  # one cell of air from the board edge to the wall
    board_y = L / 2 + 2.5
    wall_y = board_y + cell
    z_lo, z_hi = -2 * cell, H_MM + 2.5
    fine = a.fine

    fdtd = openEMS(NrTS=10, EndCriteria=1e-20)
    fdtd.SetBoundaryCond(["PMC", "PEC", "PEC", "PEC", "PEC", "PEC"])
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    thick = a.strip_model == "thick"
    # The source and probe lines (y = L/2 - 0.3 and L/2 - 0.1) need mesh lines, or openEMS drops the source.
    xs, ys, zs = [0.0, W / 4, W / 2, side, wall_x], [0.0, L / 2 - 0.3, L / 2 - 0.1, L / 2, board_y, wall_y], [z_lo, 0.0, H_MM, z_hi]
    if thick:
        zs.append(H_MM + t)
    seeds_x = [(W / 2, fine), (side, cell)]
    seeds_y = [(L / 2, fine)]
    seeds_z = [(H_MM, fine), (0.0, H_MM / a.dcells)] + ([(H_MM + t, fine)] if thick else [])
    mesh.SetLines("x", sized_lines(xs, 0.0, wall_x, seeds_x, cell))
    mesh.SetLines("y", sized_lines(ys, 0.0, wall_y, seeds_y, cell))
    mesh.SetLines("z", sized_lines(zs, z_lo, z_hi, seeds_z, cell))

    sub = csx.AddMaterial("alumina", epsilon=EPS_R)
    sub.AddBox([0, 0, 0], [side, board_y, H_MM], priority=0)
    gnd = sheet(csx, "ground", a.sigma_scale)
    gnd.AddBox([0, 0, 0], [side, board_y, 0], priority=10)
    cu = sheet(csx, "strip", a.sigma_scale)
    if thick:
        core = csx.AddMetal("strip_core")
        core.AddBox([0, 0, H_MM], [W / 2, L / 2, H_MM + t], priority=5)
        cu.AddBox([0, 0, H_MM], [W / 2, L / 2, H_MM], priority=10)  # underside
        cu.AddBox([0, 0, H_MM + t], [W / 2, L / 2, H_MM + t], priority=10)  # top
        cu.AddBox([W / 2, 0, H_MM], [W / 2, L / 2, H_MM + t], priority=10)  # side
        cu.AddBox([0, L / 2, H_MM], [W / 2, L / 2, H_MM + t], priority=10)  # open end
    else:
        cu.AddBox([0, 0, H_MM], [W / 2, L / 2, H_MM], priority=10)

    # Soft Ez source and the probe under the open end, a quarter strip width off the centre line:
    # on the PMC wall itself (x = 0) openEMS excites nothing and the run ends with zero energy.
    exc = csx.AddExcitation("exc", 0, [0, 0, 1])
    exc.AddBox([W / 4, L / 2 - 0.3, 0], [W / 4, L / 2 - 0.3, H_MM])
    eps_guess = (EPS_R + 1) / 2 + (EPS_R - 1) / 2 / np.sqrt(1 + 12 * H_MM / W)
    f_guess = C0 / (2 * (L + 0.8 * H_MM) * 1e-3 * np.sqrt(eps_guess))
    probe_box = ([W / 4, L / 2 - 0.1, 0], [W / 4, L / 2 - 0.1, H_MM])
    r = run_probe(fdtd, csx, mesh, probe_box, f_guess, 1.5e9, a.cycles, a.threads, "oems_q_")
    tag = f"openems_msq_w{W:g}_l{L:g}_{a.strip_model}_c{cell:g}_f{fine:g}_d{a.dcells}_sigma{a.sigma_scale:g}"
    write_meta(tag, dict(case="q", strip_mm=W, length_mm=L, strip_model=a.strip_model, cell_mm=cell, fine_mm=fine,
                         dielectric_cells=a.dcells, sigma_scale=a.sigma_scale, box_width_mm=2 * wall_x, box_height_mm=z_hi,
                         copper_s_per_m=COPPER_S_PER_M, thickness_m=COPPER_T_M, **r))


def run_cavity(a):
    """TE101 of an A x B x D air cavity with copper-sheet walls one cell inside a PEC box."""
    (A, B, D), cell = a.cavity, 0.5
    fdtd = openEMS(NrTS=10, EndCriteria=1e-20)
    fdtd.SetBoundaryCond(["PEC"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)
    for ax, size in zip("xyz", (A, B, D)):
        mesh.SetLines(ax, np.arange(-cell, size + cell + 1e-9, cell))
    walls = sheet(csx, "walls", a.sigma_scale)
    for lo, hi in (([0, 0, 0], [A, B, 0]), ([0, 0, D], [A, B, D]), ([0, 0, 0], [0, B, D]),
                   ([A, 0, 0], [A, B, D]), ([0, 0, 0], [A, 0, D]), ([0, B, 0], [A, B, D])):
        walls.AddBox(lo, hi, priority=10)
    exc = csx.AddExcitation("exc", 0, [0, 1, 0])
    xe, ze = round(A / 3 / cell) * cell, round(D / 3 / cell) * cell  # on mesh lines, or openEMS drops it
    exc.AddBox([xe, 0, ze], [xe, B, ze])
    f_guess = C0 / 2 * np.sqrt((1 / (A * 1e-3)) ** 2 + (1 / (D * 1e-3)) ** 2)
    r = run_probe(fdtd, csx, mesh, ([A / 2, 0, D / 2], [A / 2, B, D / 2]), f_guess, 1.0e9, a.cycles, a.threads,
                  "oems_cav_")
    # Pozar eq. 6.46 for TE10l with l = 1, Rs at the measured f0.
    f0 = r["f0_ghz"] * 1e9
    rs = np.sqrt(np.pi * f0 * 4e-7 * np.pi / COPPER_S_PER_M)
    k = 2 * np.pi * f0 / C0
    a_m, b_m, d_m = A * 1e-3, B * 1e-3, D * 1e-3
    eta = 376.730313
    q_c = (k * a_m * d_m) ** 3 * b_m * eta / (2 * np.pi ** 2 * rs) / (
        2 * a_m ** 3 * b_m + 2 * b_m * d_m ** 3 + a_m ** 3 * d_m + a_m * d_m ** 3)
    tag = f"openems_cavity_te101_{A:g}x{B:g}x{D:g}_sigma{a.sigma_scale:g}"
    write_meta(tag, dict(case="cavity", size_mm=[A, B, D], sigma_scale=a.sigma_scale, **r, q_textbook=round(float(q_c), 1),
                                                  q_error_pct=round(100 * (r["q"] / q_c - 1), 2)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("case", choices=["z0", "q", "cavity"])
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--port", choices=["lumped", "msl"], default="lumped")
    ap.add_argument("--side", type=float, default=2.5, help="ground beyond each strip edge, mm")
    ap.add_argument("--edge", type=float, default=0.05, help="z0: cell at copper edges, mm")
    ap.add_argument("--dcells", type=int, default=6, help="cells across the substrate")
    ap.add_argument("--edges", choices=["on", "thirds"], default="on")
    ap.add_argument("--tan-delta", type=float, default=0.3)
    ap.add_argument("--stop-db", type=float, default=50.0, help="z0: energy decay to stop at")
    ap.add_argument("--msl-cell", type=float, default=0.25, help="z0 msl: cell along the line, mm")
    ap.add_argument("--msl-port-len", type=float, default=12.0, help="z0 msl: port length from the domain edge, mm")
    ap.add_argument("--strip", type=float, default=0.5, help="q: strip width, mm")
    ap.add_argument("--length", type=float, default=5.5, help="q: resonator length, mm")
    ap.add_argument("--strip-model", choices=["sheet", "thick"], default="thick")
    ap.add_argument("--cell", type=float, default=0.1, help="q: largest cell, mm")
    ap.add_argument("--fine", type=float, default=0.01, help="q: cell at the strip's edges and faces, mm")
    ap.add_argument("--cycles", type=float, default=60, help="q, cavity: ring-down length in periods")
    ap.add_argument("--sigma-scale", type=float, default=0.25, help="q, cavity: conductivity factor on every sheet (see sheet())")
    ap.add_argument("--cavity", type=float, nargs=3, default=[20.0, 10.0, 20.0], help="cavity: a b d in mm")
    args = ap.parse_args()
    {"z0": run_z0, "q": run_q, "cavity": run_cavity}[args.case](args)
