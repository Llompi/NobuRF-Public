"""openEMS references for the rebuilt exam stripline (Pozar Ex. 3.5) and WR-90 (Pozar 3.3) models
(examples/textbook/pozar-ex3.5-stripline-*.json, pozar-3.3-wr90-*.json), on the same geometry.

Same structures: PEC sheets, PEC via posts (drill, pitch and span as the project files), 50 ohm
lumped ports as one vertical line, open space (air, then PML 8). The mesh is openEMS's own:
thirds rule at strip edges, posts resolved by --post cells, uniform z in the dielectric.

Each run reads the line two ways:
 * probes: voltage (z line integral at y = 0) and, for the stripline, current (loop round the
   strip) at three planes a distance d apart inside the line. V1 + V3 = 2 V2 cosh(gamma d) holds for
   any mix of the two waves, and V^2 - Z0^2 I^2 is the same at every plane, so
   Z0^2 = (V1^2 - V3^2) / (I1^2 - I3^2). Neither needs the ports.
 * ports: S of the 2-port (the structure is mirror symmetric, so one excitation gives all four).
   --pair combines the short and long runs as the exam does: eigenvalues of T_long T_short^-1 are
   exp(-+gamma dL).

  LD_LIBRARY_PATH=/opt/oems/lib /opt/oems/venv/bin/python slwg_openems.py --case stripline --length 20
  ... --case wr90 --length 40 [--solid]     (--solid: plain PEC narrow walls instead of fences)
  ... --pair stripline | wr90 | wr90-solid  (after both lengths have run)
"""
import argparse, json, os, tempfile, time
import numpy as np
from CSXCAD import ContinuousStructure
from openEMS import openEMS
from openEMS.ports import UI_data
from cheb_openems import sized_lines, thirds

C0 = 299792458.0
OUT = os.path.dirname(os.path.abspath(__file__))


def geometry(case, length, solid):
    if case == "stripline":
        return dict(eps=2.2, layers=[1.6, 1.6], port_top=1.6, half_w=1.3277, half_y=7.1277, end=length / 2 + 10,
                    fence_y=6.1277, fence_x=length / 2 + 10 - 0.4, pitch=0.8, drill=0.5, coarse=0.5,
                    f=np.linspace(0.5e9, 8e9, 151), f0=4.25e9, fw=3.75e9, band=(1e9, 7e9))
    return dict(eps=1.0, layers=[10.16], port_top=10.16, half_w=None, half_y=12.43, end=length / 2 + 15,
                fence_y=11.43, fence_x=length / 2 + 15 - 0.5, pitch=1.0, drill=0.5, coarse=1.0, solid=solid,
                f=np.linspace(8e9, 12.5e9, 91), f0=10.25e9, fw=2.75e9, band=(8.5e9, 12e9))


def run(a):
    g = geometry(a.case, a.length, a.solid)
    L, e, co = a.length, a.edge, g["coarse"]
    h = sum(g["layers"])
    d = L / 4  # probe plane spacing, planes at -d, 0, d
    fdtd = openEMS(NrTS=400_000, EndCriteria=10 ** (-50 / 10))
    fdtd.SetGaussExcite(g["f0"], g["fw"])
    fdtd.SetBoundaryCond(["PML_8"] * 6)
    csx = ContinuousStructure(); fdtd.SetCSX(csx)
    mesh = csx.GetGrid(); mesh.SetDeltaUnit(1e-3)
    air = 4 * co
    # x: uniform a.post-sized cells over the board (the posts sit on it), then grow.
    xlo, xhi = -g["end"] - air - 8 * co, g["end"] + air + 8 * co
    xfixed = [-g["end"], g["end"], -L / 2, L / 2, -d, 0.0, d]
    board = list(np.round(np.arange(-g["end"], g["end"] + 1e-9, a.post), 9))
    mesh.SetLines("x", sized_lines(board + xfixed, xlo, xhi, [(-g["end"], a.post), (g["end"], a.post)], co))
    ylo, yhi = -g["half_y"] - air - 8 * co, g["half_y"] + air + 8 * co
    yfixed = [-g["half_y"], g["half_y"], 0.0]
    yseeds = [(0.0, a.post if g["half_w"] is None else e)]
    for s in (-1, 1):
        yc = s * g["fence_y"]
        r = g["drill"] / 2
        yfixed += [yc - r, yc, yc + r]; yseeds += [(yc, a.post)]
        if g["half_w"] is not None:
            yfixed += thirds(s * g["half_w"], -s, e); yseeds += [(s * g["half_w"], e)]
    mesh.SetLines("y", sized_lines(yfixed, ylo, yhi, yseeds, co))
    zs, z = [0.0], 0.0
    for t in g["layers"]:
        zs += list(np.linspace(z, z + t, a.dcells + 1)[1:]); z += t
    dz = g["layers"][0] / a.dcells
    zlo, zhi = -air - 8 * co, h + air + 8 * co
    mesh.SetLines("z", sized_lines(zs + [zlo, zhi], zlo, zhi, [(0.0, dz), (h, dz)], co))

    if g["eps"] != 1.0:
        csx.AddMaterial("sub", epsilon=g["eps"]).AddBox([-g["end"], -g["half_y"], 0], [g["end"], g["half_y"], h], priority=0)
    pec = csx.AddMetal("pec")
    for zz in (0.0, h):
        pec.AddBox([-g["end"], -g["half_y"], zz], [g["end"], g["half_y"], zz], priority=10)
    if g["half_w"] is not None:
        pec.AddBox([-L / 2, -g["half_w"], g["port_top"]], [L / 2, g["half_w"], g["port_top"]], priority=10)
    for s in (-1, 1):
        if g.get("solid"):
            pec.AddBox([-g["end"], s * g["fence_y"], 0], [g["end"], s * g["fence_y"], h], priority=10)
            continue
        for xc in np.arange(-g["fence_x"], g["fence_x"] + 1e-9, g["pitch"]):
            pec.AddCylinder([xc, s * g["fence_y"], 0], [xc, s * g["fence_y"], h], g["drill"] / 2, priority=10)
    ports = [fdtd.AddLumpedPort(n + 1, 50, [x, 0, 0], [x, 0, g["port_top"]], "z", excite=1.0 if n == 0 else 0.0, priority=5)
             for n, x in enumerate((-L / 2, L / 2))]
    planes = (-d, 0.0, d)
    for n, x in enumerate(planes):
        csx.AddProbe(f"v{n}", p_type=0).AddBox([x, 0, 0], [x, 0, g["port_top"]])
        if g["half_w"] is not None:
            m = 0.6
            csx.AddProbe(f"i{n}", p_type=1, norm_dir=0).AddBox([x, -g["half_w"] - m, g["port_top"] - m], [x, g["half_w"] + m, g["port_top"] + m])
    ncells = int(np.prod([len(mesh.GetLines(ax)) - 1 for ax in "xyz"]))
    path = tempfile.mkdtemp(prefix=f"oems_{a.case}_")
    t0 = time.time()
    fdtd.Run(path, cleanup=True, verbose=0, numThreads=a.threads)
    wall = time.time() - t0
    f = g["f"]
    for p in ports:
        p.CalcPort(path, f, ref_impedance=50)
    s11 = ports[0].uf_ref / ports[0].uf_inc
    s21 = ports[1].uf_ref / ports[0].uf_inc
    v = [UI_data([f"v{n}"], path, f).ui_f_val[0] for n in range(3)]
    gd = np.arccosh((v[0] + v[2]) / (2 * v[1]))
    beta = np.abs(gd.imag) / (d * 1e-3)
    k0 = 2 * np.pi * f / C0
    res = dict(case=a.case, length_mm=L, solid=bool(a.solid), edge_mm=e, post_cell_mm=a.post, dielectric_cells=a.dcells,
               cells=ncells, wall_s=round(wall, 1), probe_spacing_mm=d)
    band = (f >= g["band"][0]) & (f <= g["band"][1])
    if a.case == "stripline":
        i = [UI_data([f"i{n}"], path, f).ui_f_val[0] for n in range(3)]
        z0 = np.sqrt((v[0] ** 2 - v[2] ** 2) / (i[0] ** 2 - i[2] ** 2))
        res.update(eps_eff_probe_mean=round(float(np.mean((beta[band] / k0[band]) ** 2)), 4),
                   eps_eff_probe_range=[round(float(x), 4) for x in ((beta[band] / k0[band]) ** 2)[[0, -1]]],
                   z0_probe_mean=round(float(np.mean(np.abs(z0[band]))), 2),
                   z0_probe_at_1_4_7_ghz=[round(float(np.abs(z0[np.argmin(np.abs(f - x * 1e9))])), 2) for x in (1, 4, 7)])
        extra = np.c_[np.abs(z0)]
    else:
        kc2 = np.mean(k0[band] ** 2 - beta[band] ** 2)
        b10 = np.interp(10e9, f, beta)
        res.update(fc_probe_ghz=round(float(np.sqrt(kc2) * C0 / (2 * np.pi) / 1e9), 4),
                   lambda_g_10ghz_probe_mm=round(float(2 * np.pi / b10 * 1e3), 3))
        extra = np.c_[np.zeros_like(f)]
    tag = f"{a.case}{'_solid' if a.solid else ''}_L{L:g}_e{e}_p{a.post}_d{a.dcells}"
    with open(os.path.join(OUT, tag + ".json"), "w") as fh:
        json.dump(res, fh, indent=1)
    np.savetxt(os.path.join(OUT, tag + "_s.csv"), np.c_[f / 1e9, s11.real, s11.imag, s21.real, s21.imag, beta, extra],
               delimiter=",", header="f_ghz,re_s11,im_s11,re_s21,im_s21,beta_probe,z0_probe", comments="")
    print(json.dumps(res), flush=True)


def pair(a):
    """Two-line method on the two lengths' S, as the exam: eigenvalues of T_long T_short^-1."""
    case, solid = a.pair.replace("-solid", ""), a.pair.endswith("-solid")
    lengths = (20, 32) if case == "stripline" else (40, 52)
    data = [np.loadtxt(os.path.join(OUT, f"{case}{'_solid' if solid else ''}_L{L}_e{a.edge}_p{a.post}_d{a.dcells}_s.csv"), delimiter=",", skiprows=1) for L in lengths]
    f = data[0][:, 0] * 1e9

    def t_of(row):
        s11, s21 = row[1] + 1j * row[2], row[3] + 1j * row[4]
        s12, s22 = s21, s11
        return np.array([[-(s11 * s22 - s12 * s21) / s21, s11 / s21], [-s22 / s21, 1 / s21]])
    dl = (lengths[1] - lengths[0]) * 1e-3
    beta = []
    for r0, r1 in zip(data[0], data[1]):
        ev = np.linalg.eigvals(t_of(r1) @ np.linalg.inv(t_of(r0)))
        # exp(-+j beta dL): lossless, so pick by phase, not size; beta dL stays under pi in both bands.
        beta.append(np.mean(np.abs(np.angle(ev))))
    beta = np.array(beta) / dl
    k0 = 2 * np.pi * f / C0
    g = geometry(case, lengths[0], solid)
    band = (f >= g["band"][0]) & (f <= g["band"][1])
    res = dict(pair=a.pair, lengths_mm=lengths)
    if case == "stripline":
        res.update(eps_eff_two_line_mean=round(float(np.mean((beta[band] / k0[band]) ** 2)), 4))
    else:
        kc2 = np.mean(k0[band] ** 2 - beta[band] ** 2)
        res.update(fc_two_line_ghz=round(float(np.sqrt(kc2) * C0 / (2 * np.pi) / 1e9), 4),
                   lambda_g_10ghz_two_line_mm=round(float(2 * np.pi / np.interp(10e9, f, beta) * 1e3), 3))
    with open(os.path.join(OUT, f"pair_{a.pair}_e{a.edge}_p{a.post}_d{a.dcells}.json"), "w") as fh:
        json.dump(res, fh, indent=1)
    print(json.dumps(res), flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", choices=["stripline", "wr90"])
    ap.add_argument("--length", type=float)
    ap.add_argument("--solid", action="store_true")
    ap.add_argument("--pair")
    ap.add_argument("--edge", type=float, default=0.1, help="cell at the strip edges (thirds rule)")
    ap.add_argument("--post", type=float, default=0.2, help="cell over the board along x and at the posts")
    ap.add_argument("--dcells", type=int, default=16, help="z cells per dielectric layer")
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    pair(a) if a.pair else run(a)
