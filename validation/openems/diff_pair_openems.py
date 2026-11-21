"""
openEMS reference for the Differential pair template (src/workbench/new_project.ts,
pairProject) at 5 GHz on 0.5 mm FR-4: two 0.956 mm lines with a 1.912 mm gap,
18 mm between the port pairs, a 10 x 20 mm board and ground.

Writes a four-port Touchstone file (ports P1, N1, P2, N2, as the template
orders them) into ../../docs/validation/data/, so the same post-processing reads
both solvers:
  npm run noburf -- pair docs/validation/data/openems_diffpair_<tag>.s4p --pair 1,2 --pair 3,4

Two material cases:
  lossless : PEC copper, eps_r 4.4, no dielectric loss. The line impedance
             compared on its own, without any loss model.
  fr4      : eps_r 4.4, tan delta 0.02 as a constant conductivity exact at
             5 GHz (what NobuRF does with a plain tan_delta, and openEMS's usual
             FR-4), copper still PEC. Compare it with a NobuRF solve on plain FR-4:
             the pair template now uses a Djordjevic-Sarkar substrate instead.

Two port models, as in patch_openems.py:
  line  : a zero-width lumped port one edge wide at the line centre (NobuRF's port),
  strip : a lumped port as wide as the line (the usual openEMS practice).

Usage (openEMS + CSXCAD Python bindings):
  python diff_pair_openems.py --material lossless --port line
  python diff_pair_openems.py --material lossless --port strip --res 0.05
"""
import argparse
import json
import os
import tempfile
import time

import numpy as np

from CSXCAD import ContinuousStructure
from openEMS import openEMS

from patch_openems import copper_edge_lines, graded

C0 = 299_792_458.0
EPS0 = 8.8541878128e-12

EPS_R, TAN_D, H = 4.4, 0.02, 0.5
LINE_W, GAP = 0.956, 1.912
BOARD_W, BOARD_L = 10.0, 20.0
PORT_Y = BOARD_L / 2 - 1.0
F_LO, F_HI, NF = 0.05, 10.0, 201  # the template's band, evenly spaced as noburf pair needs
LOSS_REF_HZ = 5e9


def build(material, port_kind, res, margin, driven, edges):
    """One openEMS run with port `driven` excited and the other three as 50 ohm loads."""
    fdtd = openEMS(NrTS=400_000, EndCriteria=1e-6)  # stop at -60 dB energy, as the pair template does
    fdtd.SetGaussExcite(F_HI / 2 * 1e9, F_HI / 2 * 1e9)
    fdtd.SetBoundaryCond(["PML_8"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    x_centre = (GAP + LINE_W) / 2
    lines = [(-GAP / 2 - LINE_W, -GAP / 2), (GAP / 2, GAP / 2 + LINE_W)]
    boxes = [(x0, -PORT_Y, x1, PORT_Y) for x0, x1 in lines]
    xs = [-BOARD_W / 2, BOARD_W / 2, -x_centre, x_centre] + copper_edge_lines(boxes, 0, res, edges)
    ys = [-BOARD_L / 2, BOARD_L / 2, -PORT_Y, PORT_Y]
    coarse = C0 / (F_HI * 1e9) * 1e3 / 20
    mesh.SetLines("x", graded(xs, -BOARD_W / 2 - margin, BOARD_W / 2 + margin, res, coarse))
    mesh.SetLines("y", graded(ys, -BOARD_L / 2 - margin, BOARD_L / 2 + margin, max(res, 0.25), coarse))
    nz = max(4, int(round(H / res)))
    mesh.SetLines("z", graded(list(np.linspace(0, H, nz + 1)), -margin, H + margin, H / nz, coarse))

    gnd = csx.AddMetal("gnd")
    gnd.AddBox([-BOARD_W / 2, -BOARD_L / 2, 0], [BOARD_W / 2, BOARD_L / 2, 0], priority=10)
    kappa = 2 * np.pi * LOSS_REF_HZ * EPS0 * EPS_R * TAN_D if material == "fr4" else 0.0
    sub = csx.AddMaterial("fr4", epsilon=EPS_R, kappa=kappa)
    sub.AddBox([-BOARD_W / 2, -BOARD_L / 2, 0], [BOARD_W / 2, BOARD_L / 2, H], priority=0)
    cu = csx.AddMetal("top")
    for x0, x1 in lines:
        cu.AddBox([x0, -PORT_Y, H], [x1, PORT_Y, H], priority=10)

    # P1, N1 at y = -PORT_Y; P2, N2 at +PORT_Y; P on the -x line.
    places = [(-x_centre, -PORT_Y), (x_centre, -PORT_Y), (-x_centre, PORT_Y), (x_centre, PORT_Y)]
    half = 0.0 if port_kind == "line" else LINE_W / 2
    ports = [fdtd.AddLumpedPort(k + 1, 50, [x - half, y, 0], [x + half, y, H], "z",
                                1.0 if k == driven else 0.0, priority=5)
             for k, (x, y) in enumerate(places)]
    ncells = (len(mesh.GetLines("x")) - 1) * (len(mesh.GetLines("y")) - 1) * (len(mesh.GetLines("z")) - 1)
    return fdtd, ports, ncells


def run(material, port_kind, res, margin, threads, edges):
    f = np.linspace(F_LO, F_HI, NF) * 1e9
    s = np.zeros((NF, 4, 4), dtype=complex)
    wall = 0.0
    for driven in range(4):
        fdtd, ports, ncells = build(material, port_kind, res, margin, driven, edges)
        sim_path = tempfile.mkdtemp(prefix=f"oems_pair_{material}_{port_kind}_{driven}_")
        t0 = time.time()
        fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=threads)
        wall += time.time() - t0
        for p in ports:
            p.CalcPort(sim_path, f, ref_impedance=50)
        for k, p in enumerate(ports):
            s[:, k, driven] = p.uf_ref / ports[driven].uf_inc
        print(f"run {driven + 1}/4 done, {wall:.0f} s so far", flush=True)

    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "..", "docs", "validation", "data"))
    os.makedirs(out, exist_ok=True)
    tag = f"openems_diffpair_{material}_{port_kind}_r{res:g}" + ("_thirds" if edges == "thirds" else "")
    with open(os.path.join(out, tag + ".s4p"), "w") as fh:
        fh.write(f"! openEMS, {tag}, {ncells} cells, ports P1 N1 P2 N2\n# GHz S RI R 50\n")
        for i in range(NF):
            vals = [f"{s[i, r, c].real:.8e} {s[i, r, c].imag:.8e}" for r in range(4) for c in range(4)]
            # one matrix row (four complex values) per line, as Touchstone v1 writes 4-port data
            fh.write(f"{f[i] / 1e9:.6f} " + " ".join(vals[0:4]) + "\n")
            for r in range(1, 4):
                fh.write("  " + " ".join(vals[4 * r:4 * r + 4]) + "\n")
    meta = dict(material=material, port=port_kind, res_mm=res, edges=edges, margin_mm=margin, cells=ncells, wall_s=round(wall, 1))
    with open(os.path.join(out, tag + ".json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps(meta), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--material", choices=["lossless", "fr4"], default="lossless")
    ap.add_argument("--port", choices=["line", "strip"], default="line")
    ap.add_argument("--res", type=float, default=0.1, help="fine mesh pitch across the lines, mm")
    ap.add_argument("--margin", type=float, default=10.0, help="air from the board edge to the PML, mm")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--edges", choices=["on", "thirds"], default="on",
                    help="mesh lines on the strips' long edges, or openEMS's rule: a third of a cell inside, two thirds outside")
    a = ap.parse_args()
    run(a.material, a.port, a.res, a.margin, a.threads, a.edges)
