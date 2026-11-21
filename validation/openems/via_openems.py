"""
openEMS as an arbiter for NobuRF's vias (docs/vias.md): a 50 ohm microstrip
shorted to ground by one via at its end.

The line (RO4003C-like, eps_r 3.55 lossless, h 0.813 mm, strip 1.8 mm, PEC)
runs from the PML into an MSL port and on to a via of diameter --drill at
y = 0, the strip ending --pad mm past the via center. The MSL port measures
V/I at a plane --plane mm before the via and the line's own Z0 and beta, so
the load at the via is

    Z_load = Z0 (Z_in - j Z0 t) / (Z0 - j Z_in t),   t = tan(beta d),

independent of how the port launches. Writes the via's reactance as an
inductance L(f) = Im(Z_load) / w; NobuRF's scripts/validate/vias.ts reads
the same quantity from its de-embedded S11 at the same plane.

  python via_openems.py --drill 0.4 --fine 0.025
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
H_MM = 0.813
EPS_R = 3.55
W_MM = 1.8
SIDE_MM = 8.0  # board edge from the strip center
COARSE_MM = 0.5
PML_CELLS = 8


def sized_lines(fixed, lo, hi, seeds, coarse, ratio=1.3):
    """Mesh lines through every fixed line, with cells no larger than
    h(x) = min(coarse, c + (ratio - 1) |x - p|) over the (p, c) seeds."""
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


def out_dir():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "..", "docs", "validation", "data"))
    os.makedirs(out, exist_ok=True)
    return out


def run(a):
    r = a.drill / 2
    e = a.edge
    pml = PML_CELLS * COARSE_MM
    f_lo, f_hi, nf = 0.5, 8.0, 151
    fdtd = openEMS(NrTS=600_000, EndCriteria=10 ** (-a.stop_db / 10))
    fdtd.SetGaussExcite((f_lo + f_hi) / 2 * 1e9, (f_hi - f_lo) / 2 * 1e9)
    fdtd.SetBoundaryCond(["PML_8"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    # x: strip edges a third of the edge cell inside, two thirds outside (openEMS's rule); the via resolved at --fine.
    x_lo, x_hi = -SIDE_MM - 4 * COARSE_MM - pml, SIDE_MM + 4 * COARSE_MM + pml
    strip_x = [-W_MM / 2 + e / 3, -W_MM / 2 - 2 * e / 3, W_MM / 2 - e / 3, W_MM / 2 + 2 * e / 3]
    via_xy = [-r, 0.0, r]
    mesh.SetLines("x", sized_lines([x_lo, -SIDE_MM, SIDE_MM, x_hi] + strip_x + via_xy, x_lo, x_hi,
                                   [(-W_MM / 2, e), (W_MM / 2, e), (-SIDE_MM, e), (SIDE_MM, e), (0.0, a.fine)], COARSE_MM))
    # y: from inside the PML (the MSL port's feed) to the board end past the via.
    board_end = a.pad + 2.0
    y_lo, y_hi = -a.plane - 12.0 - pml, board_end + 4 * COARSE_MM + pml
    strip_end = a.pad
    mesh.SetLines("y", sized_lines([y_lo, -a.plane, strip_end - e / 3, strip_end + 2 * e / 3, board_end, y_hi] + via_xy, y_lo, y_hi,
                                   [(strip_end, e), (board_end, e), (0.0, a.fine), (-a.plane, e)], COARSE_MM))
    dz = H_MM / a.dcells
    z_lo, z_hi = -3 * COARSE_MM - pml, H_MM + 10 * COARSE_MM + pml
    mesh.SetLines("z", sized_lines(list(np.linspace(0, H_MM, a.dcells + 1)) + [z_lo, z_hi], z_lo, z_hi,
                                   [(0.0, dz), (H_MM, dz)], COARSE_MM))

    sub = csx.AddMaterial("ro4003c", epsilon=EPS_R)
    sub.AddBox([-SIDE_MM, y_lo, 0], [SIDE_MM, board_end, H_MM], priority=0)
    pec = csx.AddMetal("pec")
    pec.AddBox([-SIDE_MM, y_lo, 0], [SIDE_MM, board_end, 0], priority=10)
    # The MSL port draws its strip up to the measurement plane; the strip continues to its end past the via.
    port_len = 12.0
    port_start = -a.plane - port_len
    port = fdtd.AddMSLPort(1, pec, [-W_MM / 2, port_start, H_MM], [W_MM / 2, -a.plane, 0], "y", "z", excite=-1,
                           FeedShift=1.0, MeasPlaneShift=port_len, priority=10)
    pec.AddBox([-W_MM / 2, y_lo, H_MM], [W_MM / 2, port_start, H_MM], priority=10)
    pec.AddBox([-W_MM / 2, -a.plane, H_MM], [W_MM / 2, strip_end, H_MM], priority=10)
    if a.drill > 0:
        pec.AddCylinder([0, 0, 0], [0, 0, H_MM], r, priority=10)

    f = np.linspace(f_lo, f_hi, nf) * 1e9
    ncells = int(np.prod([len(mesh.GetLines(ax)) - 1 for ax in "xyz"]))
    sim_path = tempfile.mkdtemp(prefix="oems_via_")
    t0 = time.time()
    fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=a.threads)
    wall = time.time() - t0
    # No ref_impedance: it would replace Z_ref, the line impedance the load transform needs.
    port.CalcPort(sim_path, f)

    z_in = port.uf_tot / port.if_tot
    z0 = port.Z_ref
    t = np.tan(port.beta * a.plane * 1e-3)
    z_load = z0 * (z_in - 1j * z0 * t) / (z0 - 1j * z_in * t)
    w = 2 * np.pi * f
    l_nh = z_load.imag / w * 1e9
    tag = f"openems_via_d{a.drill:g}_f{a.fine:g}_e{e:g}_z{a.dcells}_p{a.plane:g}"
    with open(os.path.join(out_dir(), tag + ".csv"), "w") as fh:
        fh.write("f_ghz,z_load_re,z_load_im,l_nh,z0_re,eps_eff\n")
        eps_eff = (port.beta / (w / C0)) ** 2
        for k in range(nf):
            fh.write(f"{f[k] / 1e9:.4f},{z_load[k].real:.5f},{z_load[k].imag:.5f},{l_nh[k]:.5f},{z0[k].real:.4f},{eps_eff[k].real:.5f}\n")
    at = lambda g, v: round(float(np.interp(g * 1e9, f, v)), 5)
    meta = dict(case="via_short", drill_mm=a.drill, fine_mm=a.fine, edge_mm=e, dielectric_cells=a.dcells, plane_mm=a.plane, pad_mm=a.pad,
                cells=ncells, wall_s=round(wall, 1),
                l_nh_at={str(g): at(g, l_nh) for g in (1, 2, 4, 6, 8)},
                z0_at_2=at(2, z0.real), eps_eff_at_2=at(2, eps_eff.real))
    with open(os.path.join(out_dir(), tag + ".json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps(meta), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--drill", type=float, default=0.4, help="via diameter, mm (0: an open end, the control)")
    ap.add_argument("--fine", type=float, default=0.025, help="cell at the via, mm")
    ap.add_argument("--edge", type=float, default=0.1, help="cell at the strip edges, mm")
    ap.add_argument("--dcells", type=int, default=6, help="cells across the substrate")
    ap.add_argument("--plane", type=float, default=3.0, help="measurement plane before the via center, mm")
    ap.add_argument("--pad", type=float, default=0.6, help="strip end past the via center, mm")
    ap.add_argument("--stop-db", type=float, default=50.0)
    ap.add_argument("--threads", type=int, default=0)
    run(ap.parse_args())
