"""
Builds every figure in docs/validation/img/ from the JSON/CSV in docs/validation/data/.

    pip install matplotlib numpy scipy
    python docs/validation/plot.py

Figures are 1600 x 900 px (16:9, post-ready for X / Reddit), dark theme, with
the claim written on the image itself so a screenshot stands on its own.
Textbook figures are recreated from the published equations (cited on the
image), not scanned.
"""
import glob
import json
import os

import matplotlib
import matplotlib.ticker

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.patches import FancyArrowPatch, Rectangle
from scipy.integrate import quad
from scipy.special import j0

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
IMG = os.path.join(HERE, "img")
os.makedirs(IMG, exist_ok=True)

# ---------------------------------------------------------------- theme
SURF = "#1a1a19"
PANEL = "#222221"
INK = "#f0efec"
INK2 = "#c3c2b7"
MUTED = "#8a897f"
GRID = "#3a3936"
S_NOBU = "#3987e5"  # NobuRF (slot 1)
S_REF = "#d95926"  # independent reference: openEMS (slot 2)
S_BOOK = "#199e70"  # textbook / analytic (slot 3)
S_ALT = "#c98500"  # extra NobuRF variant (slot 4)
S_ALT2 = "#9085e9"  # (slot 7)

for f in glob.glob("/usr/share/fonts/opentype/inter/*.otf"):
    font_manager.fontManager.addfont(f)
plt.rcParams.update({
    "font.family": ["Inter", "DejaVu Sans"],
    "font.size": 15,
    "figure.facecolor": SURF,
    "axes.facecolor": SURF,
    "axes.edgecolor": GRID,
    "axes.labelcolor": INK2,
    "axes.titlecolor": INK,
    "axes.grid": True,
    "grid.color": GRID,
    "grid.linewidth": 0.8,
    "xtick.color": INK2,
    "ytick.color": INK2,
    "text.color": INK,
    "legend.frameon": False,
    "legend.labelcolor": INK,
    "lines.linewidth": 2.2,
    "savefig.facecolor": SURF,
    "mathtext.fontset": "dejavusans",
})

W_IN, H_IN, DPI = 16, 9, 100  # 1600 x 900


def fig_frame(title, subtitle, footer="NobuRF validation · github.com/Llompi/NobuRF-Public · docs/validation.md"):
    fig = plt.figure(figsize=(W_IN, H_IN), dpi=DPI)
    fig.text(0.04, 0.945, title, fontsize=30, fontweight="bold", color=INK, va="top")
    fig.text(0.04, 0.875, subtitle, fontsize=16, color=INK2, va="top")
    fig.text(0.04, 0.025, footer, fontsize=11.5, color=MUTED)
    return fig


def save(fig, name):
    path = os.path.join(IMG, name)
    fig.savefig(path, dpi=DPI)
    plt.close(fig)
    print("wrote", os.path.relpath(path, HERE))


def load(name, required=True):
    """Load a data file. Missing inputs fail loudly unless the figure is explicitly optional."""
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        if required:
            raise SystemExit(f"missing {os.path.relpath(p, HERE)}: run the matching scripts/validate job first")
        return None
    with open(p) as fh:
        return json.load(fh)


def load_openems(case, port, res=0.25):
    p = os.path.join(DATA, f"openems_{case}_{port}_r{res:g}.csv")
    if not os.path.exists(p):
        raise SystemExit(f"missing {os.path.relpath(p, HERE)}: run validation/openems/patch_openems.py first")
    a = np.genfromtxt(p, delimiter=",", names=True)
    return dict(f=a["f_ghz"], s11=a["s11_db"], zr=a["zin_re"], zi=a["zin_im"])


def badge(ax, text, xy=(0.02, 0.04), color=INK2, ha="left", va="bottom", size=13):
    ax.text(*xy, text, transform=ax.transAxes, ha=ha, va=va, fontsize=size, color=color,
            bbox=dict(boxstyle="round,pad=0.45", fc=PANEL, ec=GRID))


# ---------------------------------------------------------------- textbook models (Balanis, Antenna Theory, 4th ed., ch. 14)
C0 = 299_792_458.0


def balanis_eeff(er, h, W):
    return (er + 1) / 2 + (er - 1) / 2 / np.sqrt(1 + 12 * h / W)


def balanis_f0(er, h, W, L):
    """Eqs. 14-1, 14-2, 14-3: TM010 with fringing extension dL (mm in, GHz out)."""
    ee = balanis_eeff(er, h, W)
    dL = 0.412 * h * (ee + 0.3) * (W / h + 0.264) / ((ee - 0.258) * (W / h + 0.8))
    return C0 / (2 * (L + 2 * dL) * 1e-3 * np.sqrt(ee)) / 1e9


def balanis_rin_edge(f_ghz, W, L):
    """Eqs. 14-12a, 14-17, 14-18a: R_in at the radiating edge = 1 / (2 (G1 + G12))."""
    k0 = 2 * np.pi * f_ghz * 1e9 / C0
    Wm, Lm = W * 1e-3, L * 1e-3

    def core(t):
        c = np.cos(t)
        return 0.0 if abs(c) < 1e-12 else (np.sin(k0 * Wm / 2 * c) / c) ** 2 * np.sin(t) ** 3

    g1 = quad(core, 0, np.pi, limit=200)[0] / (120 * np.pi ** 2)
    g12 = quad(lambda t: core(t) * j0(k0 * Lm * np.sin(t)), 0, np.pi, limit=200)[0] / (120 * np.pi ** 2)
    return 1 / (2 * (g1 + g12)), g1, g12


# ================================================================ figures

def fig_yee_cell():
    """Recreation of the Yee (1966) unit cell, as drawn in Taflove & Hagness fig. 3.1."""
    fig = fig_frame("The Yee cell: what NobuRF updates 196k times per step",
                    "E on cell edges, H on face centres, half a step apart in time: second-order accurate in space and time.")
    ax = fig.add_axes([0.03, 0.08, 0.55, 0.78], projection="3d")
    ax.set_facecolor(SURF)
    ax.set_axis_off()
    ax.view_init(elev=20, azim=-58)
    # cube
    for s, e in [((0, 0, 0), (1, 0, 0)), ((0, 0, 0), (0, 1, 0)), ((0, 0, 0), (0, 0, 1)),
                 ((1, 0, 0), (1, 1, 0)), ((1, 0, 0), (1, 0, 1)), ((0, 1, 0), (1, 1, 0)),
                 ((0, 1, 0), (0, 1, 1)), ((0, 0, 1), (1, 0, 1)), ((0, 0, 1), (0, 1, 1)),
                 ((1, 1, 0), (1, 1, 1)), ((1, 0, 1), (1, 1, 1)), ((0, 1, 1), (1, 1, 1))]:
        ax.plot(*zip(s, e), color=MUTED, lw=1.2)

    def arrow(p, d, col, lab):
        ax.quiver(p[0] - d[0] * 0.18, p[1] - d[1] * 0.18, p[2] - d[2] * 0.18, d[0] * 0.36, d[1] * 0.36, d[2] * 0.36,
                  color=col, lw=3, arrow_length_ratio=0.35)
        if lab:
            off = np.array([0.0, 0.0, 0.09]) if d[2] == 0 else np.array([0.13, -0.13, 0.0])
            ax.text(p[0] + off[0], p[1] + off[1], p[2] + off[2], lab, color=col, fontsize=18, fontweight="bold",
                    ha="center")

    E, H = S_REF, S_NOBU
    for y in (0, 1):
        for z in (0, 1):
            arrow((0.5, y, z), (1, 0, 0), E, "Ex" if (y, z) == (0, 0) else "")
    for x in (0, 1):
        for z in (0, 1):
            arrow((x, 0.5, z), (0, 1, 0), E, "Ey" if (x, z) == (0, 0) else "")
    for x in (0, 1):
        for y in (0, 1):
            arrow((x, y, 0.5), (0, 0, 1), E, "Ez" if (x, y) == (0, 0) else "")
    arrow((0, 0.5, 0.5), (1, 0, 0), H, "Hx")
    arrow((0.5, 0, 0.5), (0, 1, 0), H, "Hy")
    arrow((0.5, 0.5, 0), (0, 0, 1), H, "Hz")
    ax.text(-0.05, -0.05, -0.12, "(i, j, k)", color=INK2, fontsize=14)
    ax.set_box_aspect((1, 1, 1))

    tx = fig.add_axes([0.58, 0.1, 0.39, 0.74])
    tx.set_axis_off()
    items = [
        ("Update equations (normalised, cubic cells)", INK, 17, "bold", 0.075),
        (r"$h^{n+1/2} = h^{n-1/2} - S_c\,\nabla\times e^{n}$", S_NOBU, 19, "normal", 0.085),
        (r"$e^{n+1} = d\,e^{n} + c\,\nabla\times h^{n+1/2}$,  $c = S_c/\varepsilon_r$ when lossless", S_REF, 19, "normal", 0.085),
        (r"$S_c = c\,\Delta t/\Delta x = 0.99/\sqrt{3}$  (3D limit $1/\sqrt{3}$)", INK2, 15, "normal", 0.065),
        (r"CPML at the box edge: $\partial_u \to \partial_u/\kappa_u + \psi_u$", INK2, 15, "normal", 0.12),
        ("Why it is trustworthy", INK, 17, "bold", 0.07),
        ("Exact discrete eigenfrequencies are known in closed\nform, so the kernel can be checked to ppm, not just %.", INK2, 15, "normal", 0.12),
        ("Copper = tangential E set to 0 on its plane (zero\nthickness). Dielectric interfaces use the mean εr.", INK2, 15, "normal", 0.1),
    ]
    y = 0.98
    for t, c, sz, w, step in items:
        tx.text(0, y, t, color=c, fontsize=sz, fontweight=w, va="top", linespacing=1.5)
        y -= step
    tx.text(0, 0.0, "After K. S. Yee, IEEE Trans. AP-14, 1966; A. Taflove & S. Hagness,\n"
                    "Computational Electrodynamics, 3rd ed., fig. 3.1. Redrawn.", color=MUTED, fontsize=11.5, va="bottom")
    save(fig, "01_yee_cell.png")


def fig_cavity(an):
    runs = [r for r in an["cavity"]["runs"] if r["eps_r"] == 1]
    diel = [r for r in an["cavity"]["runs"] if r["eps_r"] != 1]
    fig = fig_frame("Closed PEC cavity: error falls 4x per 2x refinement",
                    "20 x 30 x 10 mm box, four modes. Lines: analytic error. Rings: what Yee theory predicts the error should be.")
    ax = fig.add_axes([0.08, 0.16, 0.5, 0.64])
    cols = [S_NOBU, S_REF, S_BOOK, S_ALT]
    dxs = np.array([r["dx_mm"] for r in runs])
    for q, m in enumerate(runs[0]["modes"]):
        err = np.array([abs(r["modes"][q]["err_vs_analytic"]) for r in runs]) * 100
        pred = np.array([abs(r["modes"][q]["f_yee_ghz"] / r["modes"][q]["f_analytic_ghz"] - 1) for r in runs]) * 100
        ax.loglog(dxs, err, "-o", color=cols[q], ms=9, label=f"{m['mode']}  {m['f_analytic_ghz']:.2f} GHz")
        ax.loglog(dxs, pred, "o", mfc="none", mec=INK, ms=16, mew=1.2)
    ref = 0.9 * max(abs(runs[0]["modes"][q]["err_vs_analytic"]) for q in range(4)) * 100
    ax.loglog(dxs, ref * (dxs / dxs[0]) ** 2, "--", color=MUTED, lw=1.5)
    ax.text(dxs[1] * 1.05, ref * (dxs[1] / dxs[0]) ** 2 * 1.25, "slope 2", color=MUTED, fontsize=14, rotation=26)
    ax.set_xlabel("cell size Δx (mm)")
    ax.set_ylabel("|f_FDTD − f_analytic| / f_analytic  (%)")
    ax.set_xticks(dxs)
    ax.set_xticklabels([f"{d:g}" for d in dxs])
    ax.xaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
    ax.invert_xaxis()
    ax.legend(loc="lower left", fontsize=13)

    worst_ppm = max(abs(m["err_vs_yee"]) for r in an["cavity"]["runs"] for m in r["modes"]) * 1e6
    tx = fig.add_axes([0.62, 0.12, 0.35, 0.68])
    tx.set_axis_off()
    tx.text(0, 0.95, f"{worst_ppm:.0f} ppm", fontsize=54, fontweight="bold", color=S_BOOK, va="top")
    tx.text(0, 0.75, "worst gap between NobuRF and the exact\ndiscrete Yee eigenfrequency, all modes,\nall grids, vacuum and εr 4.4",
            fontsize=15, color=INK2, va="top")
    r5 = [r for r in runs if r["dx_mm"] == 0.5][0]
    worst5 = max(abs(m["err_vs_analytic"]) for m in r5["modes"]) * 100
    tx.text(0, 0.45, f"{worst5:.2f} %", fontsize=40, fontweight="bold", color=S_NOBU, va="top")
    tx.text(0, 0.3, "worst error vs the continuous answer at\nthe demo cell size (0.5 mm). Pure grid\ndispersion; it shrinks as Δx².",
            fontsize=15, color=INK2, va="top")
    if diel:
        d = diel[0]
        we = max(abs(m["err_vs_analytic"]) for m in d["modes"]) * 100
        tx.text(0, 0.02, f"εr 4.4 filled, Δx 0.5 mm: worst {we:.2f} %", fontsize=14, color=MUTED)
    fig.text(0.08, 0.06, "Analytic: f = c/(2√εr)·√((m/a)²+(n/b)²+(p/d)²), Pozar, Microwave Engineering, eq. 6.46. "
                          "Yee prediction: Taflove & Hagness eq. 4.47.", fontsize=11.5, color=MUTED)
    save(fig, "02_cavity_convergence.png")


def fig_dispersion_pec(an):
    disp = an["line"]["dispersion"]
    pec = an["line"]["pec"]
    fig = fig_frame("Plane wave and PEC short: speed and reflection are right",
                    "A 1D TEM line built from the same 3D kernel (PEC plates + PMC walls), 0.5 mm cells, 2-10 GHz.")
    ax = fig.add_axes([0.1, 0.13, 0.38, 0.66])
    cpl = np.array([d["cells_per_lambda"] for d in disp])
    ax.plot(cpl, [d["vp_over_c_yee"] for d in disp], color=S_BOOK, lw=3, label="Yee dispersion relation (theory)")
    ax.plot(cpl, [d["vp_over_c"] for d in disp], "o", color=S_NOBU, ms=8, label="NobuRF measured")
    ax.axhline(1, color=MUTED, lw=1.2, ls="--")
    ax.set_xscale("log")
    ax.set_xlabel("cells per wavelength")
    ax.set_ylabel("phase velocity / c")
    ax.set_title("Phase velocity", loc="left", fontsize=17)
    ax.legend(loc="lower right", fontsize=13)
    k = int(np.argmin(np.abs(np.array([d["f_ghz"] for d in disp]) - 5.75)))
    ax.plot([cpl[k]], [disp[k]["vp_over_c"]], "o", mfc="none", mec=INK, ms=16, mew=1.5)
    ax.annotate(f"5.8 GHz: {cpl[k]:.0f} cells/λ\nv/c = {disp[k]['vp_over_c']:.5f}\n(theory {disp[k]['vp_over_c_yee']:.5f})",
                (cpl[k], disp[k]["vp_over_c"]), xytext=(0.42, 0.42), textcoords="axes fraction", color=INK, fontsize=13,
                arrowprops=dict(arrowstyle="->", color=INK2))
    worst = max(abs(d["vp_over_c"] - d["vp_over_c_yee"]) for d in disp)
    badge(ax, f"worst |measured − theory| = {worst:.1e}", xy=(0.03, 0.9), va="top")

    ax2 = fig.add_axes([0.56, 0.13, 0.4, 0.66])
    f = np.array([p["f_ghz"] for p in pec])
    mag_db = 20 * np.log10(np.array([p["mag"] for p in pec]))
    ax2.plot(f, mag_db, "o-", color=S_NOBU, ms=6, label="|Γ| of PEC short (dB)")
    ax2.set_ylim(-0.05, 0.05)
    ax2.set_xlabel("frequency (GHz)")
    ax2.set_ylabel("|Γ| (dB), ideal 0")
    ax2.set_title("PEC short circuit", loc="left", fontsize=17)
    ph = np.array([p["phase_err_deg"] for p in pec])
    badge(ax2, f"worst |Γ| error {np.max(np.abs(mag_db)):.1e} dB\nworst phase error {np.max(np.abs(ph)):.1e}°  (ideal Γ = −1·e^(−j2kd))",
          xy=(0.03, 0.05))
    save(fig, "03_planewave_pec.png")


def fig_boundary(an, old):
    pml = an["line"]["pml"]
    fig = fig_frame("The absorbing boundary",
                    "Normal-incidence reflection of the CPML vs thickness, against the graded sponge it replaced. The demo uses 8 cells (4 mm).")
    ax = fig.add_axes([0.07, 0.12, 0.62, 0.68])
    cols = {4: S_ALT2, 6: MUTED, 8: S_NOBU, 10: S_BOOK, 16: INK2}
    for s in pml:
        f = [d["f_ghz"] for d in s["db"]]
        g = [d["gamma_db"] for d in s["db"]]
        ax.plot(f, g, color=cols.get(s["cells"], INK), lw=3.4 if s["cells"] == 8 else 2,
                label=f"CPML {s['cells']} cells ({s['thickness_mm']:g} mm)" + ("  ← demo" if s["cells"] == 8 else ""))
    if old:
        s8 = [s for s in old["sponge"] if s["cells"] == 8][0]
        ax.plot([d["f_ghz"] for d in s8["db"]], [d["gamma_db"] for d in s8["db"]], color=S_REF, lw=2.4, ls="--",
                label="old sponge, 8 cells")
    ax.axvspan(4.5, 7.5, color=INK, alpha=0.05)
    ax.text(6.0, 1, "patch band", color=INK2, fontsize=12, ha="center", va="bottom")
    ax.set_ylim(-115, 3)
    ax.set_xlabel("frequency (GHz)")
    ax.set_ylabel("reflection |Γ| (dB)")
    ax.legend(loc="upper right", bbox_to_anchor=(1.0, 0.77), fontsize=12, ncol=2)
    c8 = [s for s in pml if s["cells"] == 8][0]
    band = [d["gamma_db"] for d in c8["db"] if 4.5 <= d["f_ghz"] <= 7.5]
    tx = fig.add_axes([0.73, 0.12, 0.25, 0.68])
    tx.set_axis_off()
    tx.text(0, 0.95, f"{max(band):.0f} dB".replace("-", "−"), fontsize=48, fontweight="bold", color=S_NOBU, va="top")
    tx.text(0, 0.78, "worst reflection of the demo\nCPML in the patch band\n(normal incidence)",
            fontsize=14, color=INK2, va="top")
    if old:
        sb = max(d["gamma_db"] for d in s8["db"] if 4.5 <= d["f_ghz"] <= 7.5)
        tx.text(0, 0.50, f"The sponge it replaced\nreflected {sb:.0f} dB at the\nsame thickness.".replace("-", "−"),
                fontsize=14, color=INK2, va="top")
    save(fig, "04_boundary_reflection.png")


def nobu_curve(runs, label):
    r = [x for x in runs if x["label"] == label]
    return r[0] if r else None


def dip(f, s):
    k = int(np.argmin(s))
    return float(f[k]), float(s[k])


def fig_s11_overlay(demo, fine, big):
    oems = {(c, p): load_openems(c, p) for c in ("baseline", "inset4") for p in ("line", "strip")}
    fine_pairs = []
    for case in ("baseline", "inset4"):
        fn, o = nobu_curve(fine or [], f"{case} fine"), oems.get((case, "line"))
        if fn and o is not None:
            fine_pairs.append(abs(dip(fn["f_ghz"], fn["s11_db"])[0] / dip(o["f"], o["s11"])[0] - 1) * 100)
    worst = max(fine_pairs) if fine_pairs else None
    fig = fig_frame("Same patch, two independent FDTD codes" + (f": f0 within {worst:.1f} %" if worst is not None else ""),
                    "5.8 GHz patch on 1.5 mm FR-4 (εr 4.4, lossless), 24 mm ground. openEMS v0.37 with PML; same mesh pitch, same port.")
    for q, (case, title) in enumerate((("baseline", "Edge-fed (inset 0)"), ("inset4", "Inset 4 mm"))):
        ax = fig.add_axes([0.06 + q * 0.475, 0.13, 0.42, 0.62])
        d12 = nobu_curve(demo, f"{case} 12000")
        fn = nobu_curve(fine or [], f"{case} fine")
        o, os_ = oems.get((case, "line")), oems.get((case, "strip"))
        if o is not None:
            ax.plot(o["f"], o["s11"], color=S_REF, lw=3.2, label="openEMS 0.25 mm")
        if fn:
            ax.plot(fn["f_ghz"], fn["s11_db"], color=S_NOBU, lw=2.4, label="NobuRF 0.25 mm")
        if d12:
            ax.plot(d12["f_ghz"], d12["s11_db"], color=S_ALT, lw=1.8, ls="--", label="NobuRF 0.5 mm (live demo grid)")
        if os_ is not None:
            ax.plot(os_["f"], os_["s11"], color=S_REF, lw=1.4, ls=":", label="openEMS, feed-wide port instead")
        ax.set_xlim(4.5, 7.5)
        ax.set_ylim(-35 if case == "inset4" else -12, 0.5)
        ax.set_xlabel("frequency (GHz)")
        if q == 0:
            ax.set_ylabel("S11 (dB)")
        ax.set_title(title, loc="left", fontsize=18)
        if q == 0:
            fig.legend(*ax.get_legend_handles_labels(), loc="upper left", bbox_to_anchor=(0.05, 0.835), ncol=4, fontsize=13)
        lines = []
        if fn and o is not None:
            fa, sa = dip(fn["f_ghz"], fn["s11_db"])
            fb, sb = dip(o["f"], o["s11"])
            lines.append(f"0.25 mm: NobuRF {fa:.2f} GHz / openEMS {fb:.2f} GHz  (Δ {100 * (fa / fb - 1):+.1f} %)")
        if d12 and fn:
            fc_, _ = dip(d12["f_ghz"], d12["s11_db"])
            lines.append(f"demo grid 0.5 mm reads {100 * (fc_ / dip(fn['f_ghz'], fn['s11_db'])[0] - 1):+.1f} % high")
        if lines:
            badge(ax, "\n".join(lines), xy=(0.97, 0.04), ha="right", size=12.5)
        if case == "inset4":
            ax.annotate("a −15 dB vs −30 dB dip is |Γ| 0.17 vs 0.03:\nboth near-perfect matches; depth this deep\n"
                        "swings with 1 % of resistance", (5.40, -16), xytext=(5.7, -20), color=INK2, fontsize=12,
                        arrowprops=dict(arrowstyle="->", color=INK2))
    save(fig, "05_s11_vs_reference.png")


def fig_smith(fine):
    o = load_openems("inset4", "line")
    ob = load_openems("baseline", "line")
    d = nobu_curve(fine or [], "inset4 fine")
    db = nobu_curve(fine or [], "baseline fine")
    if d is None or o is None:
        return
    fig = fig_frame("Input impedance on the Smith chart, 0.25 mm mesh",
                    "S11 hides phase. Same port, same mesh pitch, 5.0 to 6.0 GHz. Solid: inset 4 mm. Thin: edge-fed.")
    ax = fig.add_axes([0.04, 0.06, 0.5, 0.78])
    ax.set_aspect("equal")
    ax.grid(False)
    ax.set_axis_off()
    t = np.linspace(0, 2 * np.pi, 400)
    ax.plot(np.cos(t), np.sin(t), color=INK2, lw=1.2)
    for r in (0.2, 0.5, 1, 2, 5):
        c, rad = r / (1 + r), 1 / (1 + r)
        ax.plot(c + rad * np.cos(t), rad * np.sin(t), color=GRID, lw=0.9)
    for x in (0.2, 0.5, 1, 2, 5):
        for sg in (1, -1):
            zz = 1j * sg * x + np.linspace(0, 60, 2000)
            g = (zz - 1) / (zz + 1)
            ax.plot(g.real, g.imag, color=GRID, lw=0.9)
    ax.plot([-1, 1], [0, 0], color=GRID, lw=0.9)

    def gam(zr, zi):
        z = (np.asarray(zr) + 1j * np.asarray(zi)) / 50
        return (z - 1) / (z + 1)

    def locus(f, zr, zi, lo=5.0, hi=6.0):
        f = np.asarray(f)
        sel = (f >= lo) & (f <= hi)
        return gam(np.asarray(zr)[sel], np.asarray(zi)[sel])

    g = locus(d["f_ghz"], d["zin_re"], d["zin_im"])
    go = locus(o["f"], o["zr"], o["zi"])
    if db is not None and ob is not None:
        gb = locus(db["f_ghz"], db["zin_re"], db["zin_im"])
        gob = locus(ob["f"], ob["zr"], ob["zi"])
        ax.plot(gob.real, gob.imag, color=S_REF, lw=1.4)
        ax.plot(gb.real, gb.imag, color=S_NOBU, lw=1.2, ls="--")
    ax.plot(go.real, go.imag, color=S_REF, lw=3.2, label="openEMS")
    ax.plot(g.real, g.imag, color=S_NOBU, lw=2.4, label="NobuRF")
    ax.plot([0], [0], "+", color=INK, ms=14, mew=2)
    ax.text(0.03, 0.04, "50 Ω", color=INK, fontsize=13)
    ax.legend(loc="upper left", fontsize=14, bbox_to_anchor=(0.0, 1.0))
    for gg, lab, off in ((g, "5.0 GHz", -0.09), ):
        ax.text(gg.real[0], gg.imag[0] + off, lab, color=INK2, fontsize=12, ha="center")
    tx = fig.add_axes([0.58, 0.1, 0.39, 0.72])
    tx.set_axis_off()
    tx.text(0, 0.98, "How to read it", fontsize=18, fontweight="bold", color=INK, va="top")
    tx.text(0, 0.9, "Centre = perfect 50 Ω match. The loop is the\nTM010 resonance; the closer it passes the centre,\n"
                    "the deeper the S11 dip.", fontsize=15, color=INK2, va="top", linespacing=1.4)

    def z_at(f, zr, zi, x):
        return np.interp(x, f, zr) + 1j * np.interp(x, f, zi)

    y = 0.62
    tx.text(0, y, "Z_in (Ω)          NobuRF            openEMS", fontsize=14, color=MUTED, va="top", family="DejaVu Sans Mono")
    for nm, nn, oo in (("edge 5.3", db, ob), ("edge 5.5", db, ob), ("inset 5.3", d, o), ("inset 5.5", d, o)):
        if nn is None or oo is None:
            continue
        fx = float(nm.split()[1])
        zn = z_at(nn["f_ghz"], nn["zin_re"], nn["zin_im"], fx)
        zo = z_at(oo["f"], oo["zr"], oo["zi"], fx)
        y -= 0.065
        tx.text(0, y, f"{nm:<10s} {zn.real:6.1f}{zn.imag:+6.1f}j   {zo.real:6.1f}{zo.imag:+6.1f}j", fontsize=14, color=INK,
                va="top", family="DejaVu Sans Mono")
    tx.text(0, 0.18, "Edge-fed: the loops nearly coincide.\nInset: the two codes' inset responses differ\n"
                     "(notch meshing, not the port).\nSee docs/validation.md §3.", fontsize=14, color=INK2, va="top", linespacing=1.4)
    save(fig, "06_smith.png")


def fig_inset(ins):
    fig = fig_frame("Inset feed: where the 50 Ω match lands",
                    "Edge-fed patches present a few hundred ohms; cutting the feed into the patch walks R_in down a cos² curve.")
    ax = fig.add_axes([0.07, 0.16, 0.55, 0.62])
    d = np.array([r["geometry"]["inset"] for r in ins])
    f0 = np.array([r["f_cavity_ghz"] for r in ins])
    smin = np.array([r["s11_min_db"] for r in ins])
    L, W = 12.4, 16.0
    redge, g1, g12 = balanis_rin_edge(f0[0], W, L)
    y50 = L / np.pi * np.arccos(np.sqrt(min(1, 50 / redge)))
    ax.plot(d, smin, "o-", color=S_NOBU, ms=10, label="NobuRF deepest S11 (0.5 mm grid)")
    ax.axvline(y50, color=S_BOOK, lw=3, label=f"textbook 50 Ω inset: {y50:.1f} mm")
    o = load_openems("inset4", "line")
    if o is not None:
        ax.plot([4.0], [o["s11"].min()], "D", color=S_REF, ms=11, label="openEMS at 4 mm (0.25 mm mesh)")
    kbest = int(np.argmin(smin))
    ax.annotate(f"best match {d[kbest]:g} mm, {smin[kbest]:.0f} dB", (d[kbest], smin[kbest]),
                xytext=(1.0, -22), color=INK, fontsize=14, arrowprops=dict(arrowstyle="->", color=INK))
    ax.set_xlabel("inset depth y0 (mm)")
    ax.set_ylabel("S11 minimum (dB)")
    ax.legend(loc="lower left", fontsize=13)
    tx = fig.add_axes([0.66, 0.16, 0.32, 0.62])
    tx.set_axis_off()
    tx.text(0, 1.0, r"$R_{in}(y_0) = \frac{1}{2(G_1+G_{12})}\cos^2\!\left(\frac{\pi y_0}{L}\right)$", fontsize=21,
            color=S_BOOK, va="top")
    tx.text(0, 0.8, f"G1 = {g1 * 1e3:.2f} mS, G12 = {g12 * 1e3:.2f} mS\nR_edge = {redge:.0f} Ω at {f0[0]:.2f} GHz",
            fontsize=15, color=INK2, va="top", linespacing=1.4)
    tx.text(0, 0.56, f"Full-wave lands the match {y50 - d[kbest]:.1f} mm\nshallower than the cavity model. The model\n"
                     "has no notch, no feed-line reactance and\nno finite ground, so it is a starting point;\n"
                     "designers finish the inset in a full-wave\nsolver, which is the job NobuRF is for.",
            fontsize=14, color=INK2, va="top", linespacing=1.4)
    fig.text(0.07, 0.06, "C. A. Balanis, Antenna Theory, 4th ed., §14.2, eqs. 14-12a, 14-18a, 14-20a (recomputed here, not scanned).",
             fontsize=11.5, color=MUTED)
    save(fig, "07_inset_vs_textbook.png")


def fig_length(lens):
    fig = fig_frame("Resonance vs patch length: full-wave vs transmission-line model",
                    "Edge-fed, lengths on grid nodes. Textbook: Hammerstad εeff + fringing extension ΔL (Balanis eqs. 14-1 to 14-3).")
    ax = fig.add_axes([0.07, 0.12, 0.55, 0.68])
    L = np.array([r["geometry"]["L"] for r in lens])
    f = np.array([r["f_cavity_ghz"] for r in lens])
    LL = np.linspace(L.min() - 0.2, L.max() + 0.2, 100)
    ax.plot(LL, balanis_f0(4.4, 1.5, 16, LL), color=S_BOOK, lw=3, label="transmission-line model")
    ax.plot(L, f, "o", color=S_NOBU, ms=11, label="NobuRF (cavity resonance)")
    ax.set_xlabel("patch length L (mm)")
    ax.set_ylabel("TM010 resonance (GHz)")
    ax.legend(loc="upper right", fontsize=13)
    err = 100 * (f - balanis_f0(4.4, 1.5, 16, L)) / balanis_f0(4.4, 1.5, 16, L)
    tx = fig.add_axes([0.66, 0.12, 0.32, 0.68])
    tx.set_axis_off()
    tx.text(0, 0.95, f"{np.mean(err):+.1f} %", fontsize=50, fontweight="bold", color=S_NOBU, va="top")
    tx.text(0, 0.76, f"mean offset from the model\n(range {err.min():+.1f} to {err.max():+.1f} %)", fontsize=15, color=INK2, va="top")
    tx.text(0, 0.55, "The slope matches: the solver tracks length\nedits the way physics says.\n\n"
                     "The offset is the textbook's, not the solver's:\nat L = 12.4 mm openEMS puts the dip at\n"
                     "5.27 GHz and NobuRF at 0.25 mm at 5.25 GHz,\nwhile the model says 5.54 GHz. The TL model\n"
                     "is known to drift on thick, high-εr boards\n(h/λd ≈ 0.06 here).",
            fontsize=14, color=INK2, va="top", linespacing=1.35)
    save(fig, "08_length_sweep.png")


def fig_snapping(li):
    fig = fig_frame("Honest limit: edits smaller than a cell snap to the grid",
                    "Inset-4 patch, requested length vs resonance, 0.5 mm cells. Copper is sampled on Yee edges, so length moves in 0.5 mm steps.")
    ax = fig.add_axes([0.07, 0.12, 0.55, 0.68])
    L = np.array([r["geometry"]["L"] for r in li])
    f = np.array([r["f_cavity_ghz"] for r in li])
    LL = np.linspace(10.8, 13.7, 100)
    ax.plot(LL, balanis_f0(4.4, 1.5, 16, LL), color=S_BOOK, lw=2, ls="--", label="smooth textbook trend")
    ax.plot(L, f, "o-", color=S_NOBU, ms=11, drawstyle="steps-mid", label="NobuRF, 0.5 mm grid")
    for x, y in zip(L, f):
        ax.text(x, y + 0.05, f"{x:g}", color=INK2, fontsize=12, ha="center")
    sel = (L >= 11.4) & (L <= 12.5)
    ax.annotate("11.5, 12 and 12.4 mm all voxelise\nto (almost) the same copper", (12.0, f[sel].mean()),
                xytext=(12.35, 5.85), color=INK, fontsize=13, arrowprops=dict(arrowstyle="->", color=INK))
    ax.set_xlabel("requested patch length L (mm)")
    ax.set_ylabel("resonance (GHz)")
    ax.legend(loc="lower left", fontsize=13)
    tx = fig.add_axes([0.66, 0.12, 0.32, 0.68])
    tx.set_axis_off()
    tx.text(0, 0.95, "Why it matters", fontsize=18, fontweight="bold", va="top")
    tx.text(0, 0.86, "A 0.5 mm cell is 4 % of this patch's length,\nso f0 can only move in ~4 % jumps. An agent\n"
                     "nudging L by 0.2 mm sees nothing, then a jump.\n\nThe bridge already warns when an edit does not\n"
                     "change the voxels. The real fix is sub-cell\n(conformal) edges or a non-uniform mesh, which\n"
                     "is how openEMS and commercial tools avoid it.",
            fontsize=14, color=INK2, va="top", linespacing=1.4)
    save(fig, "10_grid_snapping.png")


def fig_fields(fl):
    m = fl["maps"]
    nx, ny, nz = m["nx"], m["ny"], m["nz"]
    dx = m["dx_mm"]
    ez = np.array(m["ez_mid_substrate_signed"]).reshape(ny, nx)
    cu = np.array(m["topCopper"]).reshape(ny, nx)
    yz = np.array(m["eyz_cut_mag"]).reshape(nz, ny)
    fig = fig_frame(f"Inside the substrate at resonance ({m['f_ghz']:.2f} GHz)",
                    "Ez phasor from the time-domain run. Left: the field flips sign across the patch, half a wavelength (TM010). "
                    "Right: side cut.")
    ax = fig.add_axes([0.04, 0.13, 0.42, 0.65])
    ext = [-nx / 2 * dx, nx / 2 * dx, -ny / 2 * dx, ny / 2 * dx]
    v = np.max(np.abs(ez))
    ax.imshow(ez, origin="lower", extent=ext, cmap="berlin", vmin=-v, vmax=v, interpolation="bilinear")
    ax.contour(np.linspace(ext[0], ext[1], nx), np.linspace(ext[2], ext[3], ny), cu, levels=[0.5], colors=[INK], linewidths=1.4)
    ax.grid(False)
    ax.set_xlabel("x (mm)")
    ax.set_ylabel("y (mm)")
    ax.set_title("Ez, mid-substrate (red +, blue −)", loc="left", fontsize=16)
    ax.annotate("radiating edge", (-4, 6.2), xytext=(-7, 9.5), color=INK, fontsize=13, arrowprops=dict(arrowstyle="->", color=INK))
    ax.annotate("radiating edge", (-5, -6.2), xytext=(-7.5, -10.5), color=INK, fontsize=13, arrowprops=dict(arrowstyle="->", color=INK))
    ax.annotate("feed + port", (0.5, -10), xytext=(4, -10.8), color=INK, fontsize=13, arrowprops=dict(arrowstyle="->", color=INK))
    ax.axvline((m["iCut"] - nx / 2) * dx, color=S_ALT, lw=1.2, ls="--")
    ax.set_xlim(ext[0] + 4, ext[1] - 4)
    ax.set_ylim(ext[2] + 4, ext[3] - 4)

    ax2 = fig.add_axes([0.52, 0.13, 0.45, 0.65])
    ext2 = [-ny / 2 * dx, ny / 2 * dx, 0, nz * dx]
    img = np.log10(yz / yz.max() + 1e-4) * 20
    ax2.imshow(img, origin="lower", extent=ext2, cmap="magma", vmin=-40, vmax=0, aspect="auto", interpolation="bilinear")
    zg, zp = m["groundK"] * dx, m["patchK"] * dx
    ax2.plot([-12, 12], [zg, zg], color=INK, lw=2)
    ax2.plot([-6.2, 6.2], [zp, zp], color=INK, lw=2)
    ax2.grid(False)
    ax2.set_xlabel("y (mm)")
    ax2.set_ylabel("z (mm)")
    ax2.set_title("|Ez| side cut at the dashed line (dB, 40 dB range)", loc="left", fontsize=16)
    ax2.annotate("fringing field\nat the open ends", (6.4, zp + 0.3), xytext=(9, zp + 6), color=INK, fontsize=13,
                 arrowprops=dict(arrowstyle="->", color=INK))
    ax2.text(-11.5, zg - 1.2, "ground", color=INK, fontsize=12, va="top")
    ax2.text(-6, zp + 0.5, "patch", color=INK, fontsize=12)
    sp = 8 * dx
    for xx in (ext2[0] + sp, ext2[1] - sp):
        ax2.axvline(xx, color=S_REF, lw=1, ls=":")
    ax2.axhline(ext2[3] - sp, color=S_REF, lw=1, ls=":")
    ax2.text(ext2[1] - sp - 0.3, ext2[3] - sp - 0.4, "PML starts", color=S_REF, fontsize=11, ha="right", va="top")
    save(fig, "09_field_maps.png")


def fig_summary(an, fine):
    """The one image to share: the evidence itself, two curves that agree, plus the honest caveats."""
    base_n, base_o = nobu_curve(fine, "baseline fine"), load_openems("baseline", "line")
    ins_n, ins_o = nobu_curve(fine, "inset4 fine"), load_openems("inset4", "line")
    fn, _ = dip(base_n["f_ghz"], base_n["s11_db"])
    fo, _ = dip(base_o["f"], base_o["s11"])

    fig = plt.figure(figsize=(W_IN, H_IN), dpi=DPI)
    fig.text(0.05, 0.93, "Same antenna, two independent solvers", fontsize=32, fontweight="bold", va="top")
    fig.text(0.05, 0.86, "NobuRF runs in a browser on WebGPU. openEMS is an established open-source FDTD code.\n"
                          "Same 5.8 GHz patch, same 0.25 mm mesh, same port.", fontsize=16, color=INK2, va="top", linespacing=1.45)

    ax = fig.add_axes([0.06, 0.16, 0.55, 0.55])
    ax.plot(base_o["f"], base_o["s11"], color=S_REF, lw=7, alpha=0.9, solid_capstyle="round")
    ax.plot(base_n["f_ghz"], base_n["s11_db"], color=S_NOBU, lw=2.4)
    ax.set_xlim(4.5, 7.5)
    ax.set_ylim(-9, 0.5)
    ax.set_xlabel("frequency (GHz)")
    ax.set_ylabel("reflection S11 (dB)")
    ax.set_title("Edge-fed patch", loc="left", fontsize=17, color=INK2)
    # Direct labels instead of a legend.
    ax.text(7.45, -0.05, "openEMS", color=S_REF, fontsize=17, fontweight="bold", ha="right", va="bottom")
    ax.text(7.45, -0.95, "NobuRF", color=S_NOBU, fontsize=17, fontweight="bold", ha="right", va="top")
    ax.annotate(f"both dip at {fn:.2f} GHz" if abs(fn - fo) < 0.005 else f"{fn:.2f} vs {fo:.2f} GHz",
                (fn, dip(base_n["f_ghz"], base_n["s11_db"])[1]), xytext=(5.6, -8.3), color=INK, fontsize=16,
                arrowprops=dict(arrowstyle="->", color=INK2, lw=1.2))

    ax2 = fig.add_axes([0.69, 0.43, 0.27, 0.28])
    ax2.plot(ins_o["f"], ins_o["s11"], color=S_REF, lw=4.5, alpha=0.9)
    ax2.plot(ins_n["f_ghz"], ins_n["s11_db"], color=S_NOBU, lw=1.8)
    ax2.set_xlim(4.9, 6.0)
    ax2.set_ylim(-40, 1)
    ax2.tick_params(labelsize=12)
    ax2.set_title("With a 4 mm inset feed", loc="left", fontsize=15, color=INK2)
    fa, sa = dip(ins_n["f_ghz"], ins_n["s11_db"])
    fb, sb = dip(ins_o["f"], ins_o["s11"])
    fig.text(0.69, 0.36, f"Resonance agrees to {abs(100 * (fa / fb - 1)):.1f} %.\n"
                        f"Dip depth differs ({sa:.0f} vs {sb:.0f} dB)".replace("-", "−") + ",\nan open item: how the feed notch\nis meshed (validation.md §3).",
             fontsize=14, color=INK2, va="top", linespacing=1.45)

    c8 = [x for x in an["line"]["pml"] if x["cells"] == 8][0]
    worst = max(d["gamma_db"] for d in c8["db"] if 4.5 <= d["f_ghz"] <= 7.5)
    fig.text(0.69, 0.19, f"Also checked against theory: cavity\nresonances, wave speed, metal reflection.\n"
                         f"The box edge reflects {worst:.0f} dB (CPML, 8 cells).".replace("-", "−"),
             fontsize=14, color=INK2, va="top", linespacing=1.45)
    fig.text(0.05, 0.03, "Data, scripts and every caveat: github.com/Llompi/NobuRF-Public · docs/validation.md",
             fontsize=12.5, color=MUTED)
    save(fig, "00_summary.png")


if __name__ == "__main__":
    an = load("analytic.json")
    demo = load("patch_demo.json")
    fine = load("patch_fine_baseline.json") + load("patch_fine_inset4.json")
    big = load("patch_bigbox.json")
    ins = load("patch_inset.json")
    lens = load("patch_length.json")
    fl = load("patch_fields.json")
    li4 = load("patch_length_inset4.json")
    fig_yee_cell()
    if an:
        fig_cavity(an)
        fig_dispersion_pec(an)
        fig_boundary(an, load("boundary_sponge.json"))
    if demo:
        fig_s11_overlay(demo, fine, big)
        fig_smith(fine)
    if ins:
        fig_inset(ins)
    if lens:
        fig_length(lens)
    if fl:
        fig_fields(fl)
    if li4:
        fig_snapping(li4)
    if an and demo:
        fig_summary(an, fine)
