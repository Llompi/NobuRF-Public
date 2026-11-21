"""
Figures for the modelled SMA feed (scripts/coax_feed.ts, docs/validation.md
"Modelled SMA feed"), from docs/validation/data/coax_feed/ and the openEMS CSVs.

    python docs/validation/coax_feed_plot.py
"""
import csv
import json
import os

import numpy as np
from matplotlib.patches import Rectangle

from plot import DATA, GRID, INK, INK2, MUTED, PANEL, S_ALT, S_NOBU, S_REF, fig_frame, plt, save

FEED = os.path.join(DATA, "coax_feed")
METAL = "#9b9a92"
PTFE = "#e8e4d4"
FR4 = "#5b7a52"


def load_run(name):
    with open(os.path.join(FEED, name)) as fh:
        return json.load(fh)


def load_openems(feed, res=0.125):
    path = os.path.join(DATA, f"openems_coaxfeed_{feed}_r{res:g}.csv")
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        rows = list(csv.DictReader(fh))
    return {k: np.array([float(r[c]) for r in rows]) for k, c in (("f", "f_ghz"), ("s11", "s11_db"), ("zr", "zin_re"), ("zi", "zin_im"))}


def dip(f, s):
    k = int(np.argmin(s))
    return f[k], s[k]


def fig_s11(lumped, coax, oems_lumped, oems_coax, title, subtitle):
    fig = fig_frame(title, subtitle)
    curves = [
        (lumped["fGHz"], lumped["s11Db"], lumped["zIm"], S_NOBU, "--", "NobuRF, 50 Ω lumped port at the board edge"),
        (coax["fGHz"], coax["s11Db"], coax["zIm"], S_NOBU, "-", "NobuRF, SMA modelled, read at the flange"),
    ]
    if oems_lumped is not None:
        curves.append((oems_lumped["f"], oems_lumped["s11"], oems_lumped["zi"], S_REF, "--", "openEMS 0.125 mm, lumped port"))
    if oems_coax is not None:
        curves.append((oems_coax["f"], oems_coax["s11"], oems_coax["zi"], S_REF, "-", "openEMS 0.125 mm, SMA with its coax port"))
    ax = fig.add_axes([0.07, 0.44, 0.6, 0.36])
    ax_x = fig.add_axes([0.07, 0.13, 0.6, 0.25], sharex=ax)
    for f, s, x, color, style, label in curves:
        ax.plot(f, s, color=color, linestyle=style)
        ax_x.plot(f, x, color=color, linestyle=style)
    ax.set_xlim(4.8, 6.2)
    ax.set_ylim(-30, 0)
    ax.set_ylabel("S11 (dB, 50 Ω)")
    ax.tick_params(labelbottom=False)
    ax_x.set_ylim(-140, 60)
    ax_x.set_ylabel("Im Z_in (Ω)")
    ax_x.set_xlabel("Frequency (GHz)")

    # Numbers beside the plot: dip frequency and depth per curve.
    tx = fig.add_axes([0.70, 0.11, 0.27, 0.69])
    tx.axis("off")
    tx.set_xlim(0, 1)
    tx.set_ylim(0, 1)
    y = 0.98
    tx.text(0, y, "S11 minimum", fontsize=15, color=INK, fontweight="bold", va="top")
    y -= 0.09
    for f, s, x, color, style, label in curves:
        f0, s0 = dip(np.asarray(f), np.asarray(s))
        tx.plot([0, 0.08], [y - 0.02, y - 0.02], color=color, linestyle=style)
        tx.text(0.11, y, f"{f0:.2f} GHz   {s0:.1f} dB", fontsize=15, color=INK, va="top")
        tx.text(0.11, y - 0.045, label, fontsize=11.5, color=MUTED, va="top")
        y -= 0.13
    tx.text(0, y - 0.02, "Both tools: the connector makes Z_in about\n30 Ω more capacitive across the band.\nThe resonance moves 0.03 GHz at most.",
            fontsize=12.5, color=INK2, va="top", linespacing=1.4)
    save(fig, "11_coax_feed_s11.png")


def field_db(run):
    fld = run["field"]
    y, z = np.array(fld["yMm"]), np.array(fld["zMm"])
    ny, nz = len(y), len(z)
    ey = np.hypot(np.array(fld["eyRe"]), np.array(fld["eyIm"])).reshape(nz, ny)
    ez = np.hypot(np.array(fld["ezRe"]), np.array(fld["ezIm"])).reshape(nz, ny)
    # Ey sits at (j + 1/2, k), Ez at (j, k + 1/2): average both onto cell centres.
    mag = np.hypot(0.5 * (ey[:-1, :-1] + ey[1:, :-1]), 0.5 * (ez[:-1, :-1] + ez[:-1, 1:]))
    return y, z, mag


def draw_board(ax, run, with_connector):
    spec = run["spec"]
    az, flange = spec["axisZMm"], spec["flangeYMm"]
    top = run["topCopperZMm"]
    ax.add_patch(Rectangle((flange, 0), -2 * flange, top, facecolor="none", edgecolor=FR4, linewidth=1))
    ax.plot([flange, -flange], [0, 0], color=METAL, linewidth=2.5, solid_capstyle="butt")
    ax.plot([flange, run["topCopperEndYMm"]], [top, top], color=METAL, linewidth=2.5, solid_capstyle="butt")
    if not with_connector:
        ax.plot([flange, flange], [0, top], color=S_ALT, linewidth=3)
        return
    body, bore, pin = spec["bodyHalfWidthMm"], spec["boreRadiusMm"], spec["pinRadiusMm"]
    y_lo = -100
    for z0, z1 in ((az + bore, az + body), (az - body, az - bore)):
        ax.add_patch(Rectangle((y_lo, z0), flange - y_lo, z1 - z0, facecolor=METAL, edgecolor="none"))
    ax.add_patch(Rectangle((y_lo, az - pin), flange + spec["pinOverhangMm"] - y_lo, 2 * pin, facecolor=METAL, edgecolor="none"))


def fig_field(lumped, coax, title, subtitle):
    fig = fig_frame(title, subtitle)
    spec = coax["spec"]
    az, flange = spec["axisZMm"], spec["flangeYMm"]
    ref = max(field_db(r)[2].max() for r in (lumped, coax))
    panels = [(lumped, False, "50 Ω lumped port at the board edge", 0.50), (coax, True, "SMA connector modelled", 0.14)]
    for run, with_connector, label, bottom in panels:
        y, z, mag = field_db(run)
        db = 20 * np.log10(np.maximum(mag / mag.max(), 1e-6))
        ax = fig.add_axes([0.06, bottom, 0.82, 0.33])
        im = ax.pcolormesh(y, z, db, cmap="magma", vmin=-40, vmax=0, shading="flat", rasterized=True)
        draw_board(ax, run, with_connector)
        ax.set_xlim(flange - 10, -flange + 2)
        ax.set_ylim(az - spec["bodyHalfWidthMm"] - 1.5, az + spec["bodyHalfWidthMm"] + 3)
        ax.set_aspect("equal")
        ax.grid(False)
        ax.set_ylabel("z (mm)")
        ax.text(0.01, 0.95, label, transform=ax.transAxes, color=INK, fontsize=15, va="top")
        if with_connector:
            ax.set_xlabel("y (mm), cut through the centre of the feed")
        else:
            ax.tick_params(labelbottom=False)
    cb = fig.add_axes([0.9, 0.18, 0.012, 0.55])
    fig.colorbar(im, cax=cb, label="|E|, dB below each panel's peak")
    save(fig, "12_coax_feed_field.png")


if __name__ == "__main__":
    def with_field(name):
        run = load_run(name + ".json")
        run["field"] = load_run(name + "_field.json")
        return run

    lumped = load_run("inset4_e0.25_d6_lumped.json")
    coax = load_run("inset4_e0.25_d6_coax.json")
    fig_s11(lumped, coax, load_openems("lumped"), load_openems("coax"),
            "Modelling the SMA moves the match, not the resonance",
            "Inset patch, feed trace run to the board edge. Same board, same mesh; only the feed differs.")
    fig_field(with_field("inset4_e0.25_d6_lumped"), with_field("inset4_e0.25_d6_coax"),
              "The wave comes in through the connector",
              f"|E| at {coax['f0GHz']:.2f} GHz on the cut through the feed centre")
