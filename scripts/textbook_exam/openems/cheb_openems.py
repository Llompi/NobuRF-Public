"""openEMS reference for Pozar Ex. 5.7 (three-section Chebyshev, 50 -> 100 ohm).

Blind reference: meshed by openEMS's own rules (lines a third of the edge cell
inside each strip edge, two thirds outside), lines running into the PML at both
ends, MSL ports with reference planes at the transformer ends (x = -/+22.97 mm).
Full 2-port S from two runs, converted to Z with each port's own computed
Z_ref, then Gamma_in with port 2 loaded by 100 ohm, referenced to 50 ohm.

  LD_LIBRARY_PATH=/opt/oems/lib /opt/oems/venv/bin/python cheb_openems.py --edge 0.1 --dcells 6
"""
import argparse, json, os, tempfile, time
import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS
from openEMS.physical_constants import C0

H = 0.813
EPS_R = 3.55
CASES = {  # half-width, x from, x to (mm), from the exam's project files
    'chebyshev': [(0.9093, -60.0, -22.9703), (0.7223, -22.9703, -7.8581), (0.4961, -7.8581, 7.4530),
                  (0.3215, 7.4530, 22.9703), (0.2297, 22.9703, 60.0)],
    'binomial': [(0.9093, -60.0, -22.9723), (0.7894, -22.9723, -7.9095), (0.4961, -7.9095, 7.4015),
                 (0.2844, 7.4015, 22.9723), (0.2297, 22.9723, 60.0)],
}
SECTIONS = CASES['chebyshev']
BOARD_Y = 6.909
COARSE = 0.5
PML = 8


def sized_lines(fixed, lo, hi, seeds, coarse, ratio=1.3):
    def h(x):
        return min([coarse] + [c + (ratio - 1) * abs(x - p) for p, c in seeds])
    stops = sorted(set(round(v, 9) for v in list(fixed) + [lo, hi] if lo <= v <= hi))
    lines = [stops[0]]
    for a, b in zip(stops[:-1], stops[1:]):
        xs = np.linspace(a, b, 4001)
        density = 1 / np.array([h(x) for x in xs])
        cum = np.concatenate([[0.0], np.cumsum((density[1:] + density[:-1]) / 2 * np.diff(xs))])
        n = max(1, int(np.ceil(cum[-1] - 1e-6)))
        lines += list(np.interp(np.linspace(0, cum[-1], n + 1), cum, xs)[1:])
    return np.array(lines)


def thirds(edge, inward, cell):
    return [edge + inward * cell / 3, edge - inward * 2 * cell / 3]


def solve(a, excite):
    x_lo, x_hi = SECTIONS[0][1], SECTIONS[-1][2]
    f = np.linspace(1e9, 5e9, 161)
    fdtd = openEMS(NrTS=600_000, EndCriteria=10 ** (-50 / 10))
    fdtd.SetGaussExcite(3e9, 2.5e9)
    fdtd.SetBoundaryCond(["PML_8"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)
    e = a.edge
    y_lo, y_hi = -BOARD_Y - 4 * COARSE - PML * COARSE, BOARD_Y + 4 * COARSE + PML * COARSE
    ys, yseeds = [y_lo, -BOARD_Y, 0.0, BOARD_Y, y_hi], []
    for w, _, _ in SECTIONS:
        ys += thirds(-w, +1, e) + thirds(w, -1, e)
        yseeds += [(-w, e), (w, e)]
    mesh.SetLines("y", sized_lines(ys, y_lo, y_hi, yseeds, COARSE))
    xs = [x_lo, x_hi] + [s[2] for s in SECTIONS[:-1]]
    mesh.SetLines("x", sized_lines(xs, x_lo, x_hi, [(s[2], e) for s in SECTIONS[:-1]], COARSE))
    dz = H / a.dcells
    z_lo, z_hi = -3 * COARSE - PML * COARSE, H + 12 * COARSE + PML * COARSE
    mesh.SetLines("z", sized_lines(list(np.linspace(0, H, a.dcells + 1)) + [z_lo, z_hi], z_lo, z_hi,
                                   [(0.0, dz), (H, dz)], COARSE))
    sub = csx.AddMaterial("sub", epsilon=EPS_R)
    sub.AddBox([x_lo, -BOARD_Y, 0], [x_hi, BOARD_Y, H], priority=0)
    pec = csx.AddMetal("pec")
    pec.AddBox([x_lo, -BOARD_Y, 0], [x_hi, BOARD_Y, 0], priority=10)
    feed = PML * COARSE + 1.0
    port_len = 30.0  # from the PML-side end; the measuring plane sits inside the uniform line
    meas = 20.0     # plane at x = -/+40 mm, de-embedded to the transformer ends with the port's beta
    w1, w5 = SECTIONS[0][0], SECTIONS[-1][0]
    p1 = fdtd.AddMSLPort(1, pec, [x_lo, -w1, H], [x_lo + port_len, w1, 0], "x", "z", excite=1 if excite == 1 else 0,
                         FeedShift=feed, MeasPlaneShift=meas, priority=10)
    p2 = fdtd.AddMSLPort(2, pec, [x_hi, -w5, H], [x_hi - port_len, w5, 0], "x", "z", excite=1 if excite == 2 else 0,
                         FeedShift=feed, MeasPlaneShift=meas, priority=10)
    pec.AddBox([x_lo + port_len, -w1, H], [SECTIONS[0][2], w1, H], priority=10)
    for w, x0, x1 in SECTIONS[1:-1]:
        pec.AddBox([x0, -w, H], [x1, w, H], priority=10)
    pec.AddBox([SECTIONS[-1][1], -w5, H], [x_hi - port_len, w5, H], priority=10)
    ncells = int(np.prod([len(mesh.GetLines(ax)) - 1 for ax in "xyz"]))
    path = tempfile.mkdtemp(prefix=f"oems_cheb_e{e}_x{excite}_")
    t0 = time.time()
    fdtd.Run(path, cleanup=True, verbose=0, numThreads=a.threads)
    wall = time.time() - t0
    for p in (p1, p2):
        p.CalcPort(path, f)
    return f, p1, p2, ncells, wall


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--edge", type=float, default=0.1)
    ap.add_argument("--dcells", type=int, default=6)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--case", default="chebyshev")
    a = ap.parse_args()
    global SECTIONS
    SECTIONS = CASES[a.case]
    f, a1, b1, ncells, w1 = solve(a, 1)
    _, a2, b2, _, w2 = solve(a, 2)
    # Both measuring planes sit 20 mm in from the PML-side line ends; move them to the transformer
    # ends with each line's measured beta, then load port 2 with an ideal 100 ohm, as the exam does.
    d1 = (SECTIONS[0][2] - (SECTIONS[0][1] + 20.0)) * 1e-3
    d2 = ((SECTIONS[-1][2] - 20.0) - SECTIONS[-1][1]) * 1e-3
    e1 = np.exp(1j * np.real(a1.beta) * d1); e2 = np.exp(1j * np.real(b2.beta) * d2)
    s11 = a1.uf_ref / a1.uf_inc * e1 * e1; s21 = b1.uf_ref / a1.uf_inc * e1 * e2
    s12 = a2.uf_ref / b2.uf_inc * e1 * e2; s22 = b2.uf_ref / b2.uf_inc * e2 * e2
    z1, z2 = a1.Z_ref, b2.Z_ref
    zin = np.empty(len(f), complex)
    for k in range(len(f)):
        S = np.array([[s11[k], s12[k]], [s21[k], s22[k]]])
        R = np.diag(np.sqrt([z1[k], z2[k]])); I = np.eye(2)
        Z = R @ (I + S) @ np.linalg.inv(I - S) @ R
        zin[k] = Z[0, 0] - Z[0, 1] * Z[1, 0] / (Z[1, 1] + 100.0)
    g = np.abs((zin - 50) / (zin + 50))
    ok = f[g <= 0.1]
    mins = [float(f[k] / 1e9) for k in range(1, len(f) - 1) if g[k] < g[k - 1] and g[k] < g[k + 1]]
    res = dict(edge_mm=a.edge, dielectric_cells=a.dcells, cells=ncells, wall_s=round(w1 + w2, 1),
               z_ref_port1_at3=round(float(np.interp(3e9, f, z1.real)), 3), z_ref_port2_at3=round(float(np.interp(3e9, f, z2.real)), 3),
               band_ghz=[round(float(ok.min() / 1e9), 4), round(float(ok.max() / 1e9), 4)] if len(ok) else None,
               centre_ghz=round(float((ok.min() + ok.max()) / 2e9), 4) if len(ok) else None,
               gamma_at_3=round(float(np.interp(3e9, f, g)), 4), minima_ghz=mins,
               centre_error_pct=round(float(((ok.min() + ok.max()) / 2e9 - 3) / 3 * 100), 3) if len(ok) else None)
    out = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(out, f"{a.case}_e{a.edge}_d{a.dcells}.json"), "w") as fh:
        json.dump(res, fh, indent=1)
    np.savetxt(os.path.join(out, f"{a.case}_e{a.edge}_d{a.dcells}_gamma.csv"), np.c_[f / 1e9, g], delimiter=",", header="f_ghz,gamma_in", comments="")
    print(json.dumps(res), flush=True)


if __name__ == "__main__":
    main()
