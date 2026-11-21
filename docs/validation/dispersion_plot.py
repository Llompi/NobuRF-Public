"""
Figure for the frequency-dependent and magnetic materials (docs/validation.md
section 2.4), from docs/validation/data/dispersion.json.

    npx tsx scripts/validate/dispersion.ts
    python docs/validation/dispersion_plot.py
"""
import numpy as np

from plot import GRID, INK2, MUTED, S_ALT, S_BOOK, S_NOBU, fig_frame, load, save

d = load("dispersion.json")
fig = fig_frame(
    "Frequency-dependent and magnetic materials",
    "Left: Djordjevic-Sarkar FR-4, closed form and the Debye poles the solver runs. "
    "Right: slabs on a 1D line, FDTD against the closed-form slab.",
)

# Left: eps' and tan delta of the D-S model, exact line, fit dots, band shaded.
ds = d["ds"]
f = np.array(ds["f_ghz"])
exact = np.array(ds["exact"])
fit = np.array(ds["fit"])
lo, hi = ds["band_ghz"]
ax_re = fig.add_axes([0.06, 0.46, 0.38, 0.32])
ax_tan = fig.add_axes([0.06, 0.12, 0.38, 0.28], sharex=ax_re)
for ax in (ax_re, ax_tan):
    ax.set_xscale("log")
    ax.axvspan(lo, hi, color=GRID, alpha=0.6, lw=0)
ax_re.plot(f, exact[:, 0], color=S_BOOK, label="closed form (Djordjevic et al. 2001)")
ax_re.plot(f, fit[:, 0], "o", ms=4, color=S_NOBU, label=f"solver: {ds['poles']} Debye poles fitted for {lo:g}-{hi:g} GHz")
ax_tan.plot(f, -exact[:, 1] / exact[:, 0], color=S_BOOK)
ax_tan.plot(f, -fit[:, 1] / fit[:, 0], "o", ms=4, color=S_NOBU)
ax_re.set_ylabel("εr′")
ax_tan.set_ylabel("tan δ")
ax_tan.set_xlabel("frequency (GHz)")
ax_re.tick_params(labelbottom=False)
ax_re.set_ylim(3.6, 4.8)
ax_tan.set_ylim(0, 0.04)
ax_re.legend(loc="lower left", fontsize=12.5)
ax_re.text(np.sqrt(lo * hi), 4.7, "fitted band", ha="center", color=INK2, fontsize=12.5)

# Right: |Gamma| for the three slabs, FDTD dots on closed-form lines.
ax = fig.add_axes([0.55, 0.12, 0.41, 0.66])
colors = [S_NOBU, S_ALT, S_BOOK]
worst = 0.0
for slab, color in zip(d["slab"], colors):
    runs = slab["runs"]
    ff = np.array([r["f_ghz"] for r in runs])
    g = np.array([np.hypot(*r["gamma"]) for r in runs])
    ge = np.array([np.hypot(*r["exact_gamma"]) for r in runs])
    ax.plot(ff, ge, color=color, lw=2)
    ax.plot(ff, g, "o", ms=5, color=color, mfc="none", mew=1.6, label=slab["name"])
    worst = max(worst, slab["worst"])
ax.set_xlabel("frequency (GHz)")
ax.set_ylabel("|Γ| of a 10 mm slab")
ax.set_ylim(0, 1.05)
ax.set_xlim(1, 11)
ax.legend(loc="upper right", fontsize=12)
fig.text(0.55, 0.80, f"Lines: closed form. Circles: FDTD, 0.25 mm cells. Worst error in Γ, T: {worst:.1e}", color=MUTED, fontsize=14)
fig.text(0.06, 0.80, "FR-4, εr 4.4 and tan δ 0.02 at 1 GHz", color=MUTED, fontsize=14)
save(fig, "13_dispersive_materials.png")
