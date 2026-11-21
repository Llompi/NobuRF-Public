"""
openEMS reference for scripts/coax_feed.ts: the inset patch with its feed
trace run to the board edge, fed either by a lumped port at the board edge or
by an edge-launch SMA (openEMS CoaxialPort along y into the PML, a square
metal body and a pin reaching 1.5 mm over the trace), with the same
dimensions as edgeLaunchSma() in src/engine/coax_feed.ts.

The coax result is moved to the flange (ref_plane_shift) and given as Z_in
there and S11 re 50 ohm, which is how coax_feed.ts reports it.

  python coax_feed_openems.py --feed coax --res 0.25
  python coax_feed_openems.py --feed lumped --res 0.25
Writes docs/validation/data/openems_coaxfeed_<feed>_r<res>.csv and .json.
"""
import argparse
import json
import os
import tempfile
import time

import numpy as np

from CSXCAD import ContinuousStructure
from openEMS import openEMS
from openEMS.ports import CoaxialPort

from patch_openems import BASE, graded

INSET = 4.0
PIN_R, BORE_R, BODY_HALF, PTFE_EPS, OVERHANG = 0.635, 2.05, 3.175, 2.08, 1.5
COAX_LEN = 20.0  # flange to the end of the box, through the PML
FEED_SHIFT, MEAS_SHIFT = 6.0, 14.0  # from the far end: source 14 mm and probe 6 mm before the flange


def top_copper(W, L, fw, d, gap, y_edge):
    """Top copper boxes (x0, y0, x1, y1): inset patch, feed trace from the board edge."""
    notch = fw / 2 + gap
    y_notch = -L / 2 + d
    return [
        (-W / 2, y_notch, W / 2, L / 2),
        (-W / 2, -L / 2, -notch, y_notch),
        (notch, -L / 2, W / 2, y_notch),
        (-fw / 2, y_edge, fw / 2, y_notch),
    ]


def run(feed, res, f_lo=4.0, f_hi=8.0, nf=401, threads=0):
    p = dict(BASE)
    h, eps = p["h"], p["eps_r"]
    half = p["gnd"] / 2
    y_edge = -half
    margin = 20.0
    az = h + PIN_R

    fdtd = openEMS(NrTS=300_000, EndCriteria=1e-5)  # -50 dB energy
    fdtd.SetGaussExcite((f_lo + f_hi) / 2 * 1e9, (f_hi - f_lo) / 2 * 1e9)
    fdtd.SetBoundaryCond(["PML_8"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    boxes = top_copper(p["W"], p["L"], p["fw"], INSET, p["gap"], y_edge)
    coarse = 299_792_458.0 / (f_hi * 1e9) * 1e3 / 20
    xs = [-half, half, 0.0] + [v for b in boxes for v in (b[0], b[2])]
    ys = [-half, half] + [v for b in boxes for v in (b[1], b[3])]
    zs = list(np.linspace(0, h, max(1, int(round(h / res))) + 1))
    if feed == "coax":
        xs += [-BODY_HALF, BODY_HALF]
        ys += [y_edge - COAX_LEN, y_edge + OVERHANG]
        zs += [az - BODY_HALF, az + BODY_HALF]
    mesh.SetLines("x", graded(xs, -half - margin, half + margin, res, coarse))
    mesh.SetLines("y", graded(ys, -half - margin, half + margin, res, coarse))
    mesh.SetLines("z", graded(zs, -margin, h + margin, res, coarse))

    gnd = csx.AddMetal("gnd")
    gnd.AddBox([-half, -half, 0], [half, half, 0], priority=10)
    csx.AddMaterial("fr4", epsilon=eps).AddBox([-half, -half, 0], [half, half, h], priority=0)
    cu = csx.AddMetal("top")
    for x0, y0, x1, y1 in boxes:
        cu.AddBox([x0, y0, h], [x1, y1, h], priority=10)

    if feed == "lumped":
        port = fdtd.AddLumpedPort(1, 50, [0, y_edge, 0], [0, y_edge, h], "z", 1.0, priority=5)
    else:
        metal = csx.AddMetal("connector")
        ptfe = csx.AddMaterial("ptfe", epsilon=PTFE_EPS)
        y0 = y_edge - COAX_LEN
        # Square body; the port's PTFE (priority 4) and pin/shell (5) win inside it.
        metal.AddBox([-BODY_HALF, y0, az - BODY_HALF], [BODY_HALF, y_edge, az + BODY_HALF], priority=3)
        metal.AddCylinder([0, y_edge, az], [0, y_edge + OVERHANG, az], PIN_R, priority=5)
        port = CoaxialPort(csx, 1, metal, ptfe, [0, y0, az], [0, y_edge, az], "y", PIN_R, BORE_R, BODY_HALF,
                           excite=1.0, FeedShift=FEED_SHIFT, MeasPlaneShift=MEAS_SHIFT, priority=5)

    ncells = int(np.prod([len(mesh.GetLines(a)) - 1 for a in "xyz"]))
    sim_path = tempfile.mkdtemp(prefix=f"oems_coaxfeed_{feed}_")
    t0 = time.time()
    fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=threads)
    wall = time.time() - t0

    f = np.linspace(f_lo, f_hi, nf) * 1e9
    if feed == "lumped":
        port.CalcPort(sim_path, f)
        z_line = None
    else:
        port.CalcPort(sim_path, f, ref_plane_shift=COAX_LEN)
        z_line = float(np.mean(np.real(port.Z_ref)))
    zin = port.uf_tot / port.if_tot
    s11_db = 20 * np.log10(np.abs((zin - 50) / (zin + 50)))

    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "..", "docs", "validation", "data"))
    os.makedirs(out, exist_ok=True)
    tag = f"openems_coaxfeed_{feed}_r{res:g}"
    with open(os.path.join(out, tag + ".csv"), "w") as fh:
        fh.write("f_ghz,s11_db,zin_re,zin_im\n")
        for k in range(nf):
            fh.write(f"{f[k] / 1e9:.5f},{s11_db[k]:.4f},{zin[k].real:.4f},{zin[k].imag:.4f}\n")
    k = int(np.argmin(s11_db))
    meta = dict(feed=feed, res_mm=res, cells=ncells, wall_s=round(wall, 1), f0_ghz=round(f[k] / 1e9, 4),
                s11_min_db=round(float(s11_db[k]), 2), line_impedance_ohm=z_line)
    with open(os.path.join(out, tag + ".json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps(meta), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--feed", choices=["lumped", "coax"], required=True)
    ap.add_argument("--res", type=float, default=0.25)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()
    run(a.feed, a.res, threads=a.threads)
