"""
Independent reference for the NobuRF patch: the same antenna in openEMS
(open-source EC-FDTD, https://openems.de), with a PML boundary and a fine,
graded mesh. Writes one CSV per case into ../../docs/validation/data/.

Geometry is copied from src/engine/geometry.ts (baselineGeometry) and the
voxeliser conventions in src/engine/voxelize.ts:
  - patch centred at the origin, W along x, L along y, feed from -y,
  - zero-thickness PEC copper, lossless FR-4 (eps_r 4.4, h 1.5 mm),
  - finite 24 x 24 mm ground and substrate,
  - port at the open end of the feed, at the grid node NobuRF uses (y = -10.0 mm).

Two port models are run, because the port is the least standard part of any
FDTD S11 and it is honest to show how much it matters:
  line  : a zero-width lumped port, one edge wide (what NobuRF does today),
  strip : a lumped port as wide as the feed line (the usual openEMS practice).

Usage (needs openEMS + CSXCAD Python bindings; on Windows use the prebuilt
release and run with its python, or set OPENEMS_INSTALL_PATH):
  python patch_openems.py                 # all four cases, 0.25 mm mesh
  python patch_openems.py --res 0.5       # same mesh pitch as NobuRF
  python patch_openems.py --case inset4 --port strip
  python patch_openems.py --case inset4 --port line --nf2ff
                                          # adds the radiation pattern at the S11 dip

With --nf2ff the air margin grows to 30 mm and a Huygens box 8 mm outside the
board records the near field. The far field is written for the full sphere
(2 degree steps) as <tag>_farfield.csv (theta, phi, D_theta, D_phi in dBi:
partial directivity of each polarisation) and the peak directivity, radiated
power and radiation efficiency (radiated / accepted power) into <tag>.json.
The board has W along x and L along y, so the E-plane is phi = 90 deg (yz)
and the H-plane is phi = 0 deg (xz).
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
import time

import numpy as np

from CSXCAD import ContinuousStructure
from openEMS import openEMS

C0 = 299_792_458.0

BASE = dict(eps_r=4.4, h=1.5, gnd=24.0, W=16.0, L=12.4, fw=2.5, flen=4.0, gap=1.0)
CASES = {"baseline": 0.0, "inset4": 4.0}
PORT_Y = -10.0  # NobuRF port node for the baseline feed at dx = 0.5 mm


def patch_boxes(W, L, fw, d, gap):
    """Top copper as axis-aligned boxes (x0, y0, x1, y1), same predicate as isTopCopper."""
    boxes = []
    if d <= 0:
        boxes.append((-W / 2, -L / 2, W / 2, L / 2))
    else:
        notch = fw / 2 + gap
        y_notch = -L / 2 + d
        boxes.append((-W / 2, y_notch, W / 2, L / 2))  # body above the notch
        boxes.append((-W / 2, -L / 2, -notch, y_notch))  # left leg
        boxes.append((notch, -L / 2, W / 2, y_notch))  # right leg
    # feed line, from the port end up to the bottom of the notch (or the patch edge)
    boxes.append((-fw / 2, -L / 2 - BASE["flen"], fw / 2, -L / 2 + d))
    return boxes


def copper_edge_lines(boxes, axis, res, rule):
    """Mesh lines for the copper's edges along one axis (0: x, 1: y).

    rule "on": a line on every drawn edge. rule "thirds": openEMS's own advice
    for zero-thickness metal, a line res/3 inside the copper and one 2 res/3
    outside it. An edge with copper on both sides at different places along
    it (or a seam between two boxes) keeps its drawn line."""
    lo, hi = (0, 2) if axis == 0 else (1, 3)
    other = (1, 3) if axis == 0 else (0, 2)
    covers = lambda u, w: any(b[lo] < u < b[hi] and b[other[0]] < w < b[other[1]] for b in boxes)
    lines = []
    for v in sorted(set(c for b in boxes for c in (b[lo], b[hi]))):
        if rule == "on":
            lines.append(v)
            continue
        eps = 1e-6
        inward = set()
        for b in boxes:
            if v not in (b[lo], b[hi]):
                continue
            for w in np.linspace(b[other[0]], b[other[1]], 11)[1:-1]:
                before, after = covers(v - eps, w), covers(v + eps, w)
                if before != after:
                    inward.add(-1 if before else 1)
        if len(inward) == 1:
            d = inward.pop()
            lines += [v + d * res / 3, v - d * 2 * res / 3]
        else:
            lines.append(v)
    return lines


def graded(fixed, lo, hi, fine, coarse, ratio=1.3):
    """Mesh lines: `fine` pitch between the outermost fixed lines, graded to `coarse` outside."""
    fixed = sorted(set(round(v, 6) for v in fixed))
    a, b = fixed[0], fixed[-1]
    lines = list(fixed)
    # fill the fine region
    allp = sorted(fixed)
    for p, q in zip(allp[:-1], allp[1:]):
        n = int(np.ceil((q - p) / fine - 1e-9))
        lines += list(np.linspace(p, q, n + 1))
    # grade outwards
    for start, end, sgn in ((a, lo, -1), (b, hi, 1)):
        x, step = start, fine
        while (end - x) * sgn > 0:
            step = min(step * ratio, coarse)
            x = x + sgn * step
            if (end - x) * sgn < step * 0.5:
                x = end
            lines.append(x)
    return np.unique(np.round(lines, 6))


def run(case, port_kind, res, f_lo=4.0, f_hi=8.0, nf=401, keep=False, threads=0, far_field=False, edges="on"):
    p = dict(BASE)
    d = CASES[case]
    h, eps = p["h"], p["eps_r"]
    half = p["gnd"] / 2
    # mm of air to the PML on every side (~lambda/4 at 4 GHz is 19 mm); the
    # Huygens box needs room between the board and the PML.
    margin = 30.0 if far_field else 20.0

    fdtd = openEMS(NrTS=200_000, EndCriteria=1e-5)  # stop at -50 dB energy
    f0, fc = (f_lo + f_hi) / 2 * 1e9, (f_hi - f_lo) / 2 * 1e9
    fdtd.SetGaussExcite(f0, fc)
    fdtd.SetBoundaryCond(["PML_8"] * 6)

    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    boxes = patch_boxes(p["W"], p["L"], p["fw"], d, p["gap"])
    xs = [-half, half, 0.0] + copper_edge_lines(boxes, 0, res, edges)
    ys = [-half, half, PORT_Y] + copper_edge_lines(boxes, 1, res, edges)
    lam_min = C0 / (f_hi * 1e9) * 1e3
    coarse = lam_min / 20
    mesh.SetLines("x", graded(xs, -half - margin, half + margin, res, coarse))
    mesh.SetLines("y", graded(ys, -half - margin, half + margin, res, coarse))
    nz_sub = max(1, int(round(h / res)))
    zs = list(np.linspace(0, h, nz_sub + 1))
    mesh.SetLines("z", graded(zs, -margin, h + margin, res, coarse))

    gnd = csx.AddMetal("gnd")
    gnd.AddBox([-half, -half, 0], [half, half, 0], priority=10)
    sub = csx.AddMaterial("fr4", epsilon=eps)
    sub.AddBox([-half, -half, 0], [half, half, h], priority=0)
    cu = csx.AddMetal("patch")
    for x0, y0, x1, y1 in boxes:
        cu.AddBox([x0, y0, h], [x1, y1, h], priority=10)

    if port_kind == "line":
        start, stop = [0, PORT_Y, 0], [0, PORT_Y, h]
    else:
        start, stop = [-p["fw"] / 2, PORT_Y, 0], [p["fw"] / 2, PORT_Y, h]
    port = fdtd.AddLumpedPort(1, 50, start, stop, "z", 1.0, priority=5)

    nf2ff = None
    if far_field:
        gap_mm = 8.0
        nf2ff = fdtd.CreateNF2FFBox(start=[-half - gap_mm, -half - gap_mm, -gap_mm],
                                    stop=[half + gap_mm, half + gap_mm, h + gap_mm])

    ncells = (len(mesh.GetLines("x")) - 1) * (len(mesh.GetLines("y")) - 1) * (len(mesh.GetLines("z")) - 1)
    sim_path = tempfile.mkdtemp(prefix=f"oems_{case}_{port_kind}_")
    t0 = time.time()
    fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=threads)
    wall = time.time() - t0

    f = np.linspace(f_lo, f_hi, nf) * 1e9
    port.CalcPort(sim_path, f)
    s11 = port.uf_ref / port.uf_inc
    zin = port.uf_tot / port.if_tot
    s11_db = 20 * np.log10(np.abs(s11))

    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "..", "docs", "validation", "data"))
    os.makedirs(out, exist_ok=True)
    tag = f"openems_{case}_{port_kind}_r{res:g}" + ("_thirds" if edges == "thirds" else "") + ("_nf2ff" if far_field else "")
    with open(os.path.join(out, tag + ".csv"), "w") as fh:
        fh.write("f_ghz,s11_db,zin_re,zin_im\n")
        for k in range(nf):
            fh.write(f"{f[k] / 1e9:.5f},{s11_db[k]:.4f},{zin[k].real:.4f},{zin[k].imag:.4f}\n")
    k = int(np.argmin(s11_db))
    meta = dict(case=case, port=port_kind, res_mm=res, edges=edges, cells=ncells, wall_s=round(wall, 1),
                f0_ghz=round(f[k] / 1e9, 4), s11_min_db=round(float(s11_db[k]), 2))
    if nf2ff is not None:
        meta.update(far_field_at(nf2ff, port, sim_path, f[k], h, os.path.join(out, tag + "_farfield.csv")))
        shutil.rmtree(sim_path, ignore_errors=True)  # the near-field dumps are large; done with them
    with open(os.path.join(out, tag + ".json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps(meta), flush=True)
    return meta


def far_field_at(nf2ff, port, sim_path, f_hz, h, csv_path):
    """Full-sphere pattern at f_hz; returns the summary numbers for the JSON."""
    theta = np.arange(0.0, 181.0, 2.0)
    phi = np.arange(0.0, 360.0, 2.0)
    # center is in metres (openEMS units), not the mesh's mm.
    res = nf2ff.CalcNF2FF(sim_path, f_hz, theta, phi, center=[0, 0, h * 1e-3])
    d_max = float(res.Dmax[0])
    e_max = float(np.max(res.E_norm[0]))
    # Each polarisation's share of the directivity, in dBi.
    floor = 1e-15
    d_theta = 20 * np.log10(np.maximum(np.abs(res.E_theta[0]) / e_max, floor)) + 10 * np.log10(d_max)
    d_phi = 20 * np.log10(np.maximum(np.abs(res.E_phi[0]) / e_max, floor)) + 10 * np.log10(d_max)
    with open(csv_path, "w") as fh:
        fh.write("theta_deg,phi_deg,d_theta_dbi,d_phi_dbi\n")
        for t in range(len(theta)):
            for q in range(len(phi)):
                fh.write(f"{theta[t]:g},{phi[q]:g},{d_theta[t, q]:.3f},{d_phi[t, q]:.3f}\n")
    port.CalcPort(sim_path, [f_hz])
    p_acc = float(port.P_acc[0])
    p_rad = float(res.Prad[0])
    t_peak, q_peak = np.unravel_index(np.argmax(res.E_norm[0]), res.E_norm[0].shape)
    return dict(far_field_f_ghz=round(f_hz / 1e9, 4), directivity_dbi=round(10 * np.log10(d_max), 3),
                peak_theta_deg=float(theta[t_peak]), peak_phi_deg=float(phi[q_peak]),
                radiated_w=p_rad, accepted_w=p_acc, radiation_efficiency=round(p_rad / p_acc, 4))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", choices=list(CASES) + ["all"], default="all")
    ap.add_argument("--port", choices=["line", "strip", "all"], default="all")
    ap.add_argument("--res", type=float, default=0.25, help="mesh pitch on the board (mm)")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--nf2ff", action="store_true", help="also compute the radiation pattern at the S11 dip")
    ap.add_argument("--edges", choices=["on", "thirds"], default="on",
                    help="mesh lines on the copper edges, or a third of a cell inside and two thirds outside")
    a = ap.parse_args()
    cases = list(CASES) if a.case == "all" else [a.case]
    ports = ["line", "strip"] if a.port == "all" else [a.port]
    for c in cases:
        for pk in ports:
            run(c, pk, a.res, threads=a.threads, far_field=a.nf2ff, edges=a.edges)
    sys.exit(0)
