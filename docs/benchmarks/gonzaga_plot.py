"""
Figures for docs/benchmarks/gonzaga.md from docs/benchmarks/data/gonzaga/.

    python docs/benchmarks/gonzaga_plot.py --collect <dir of gonzaga_helix.ts --out files>
    python docs/benchmarks/gonzaga_plot.py

--collect copies the solves into data/gonzaga/runs.json, keeping the S11 curve
and the far-field figures at 915 MHz (the azimuth samples are dropped).
fig3_digitised.json holds the paper's Fig. 3 curves, read off the figure by
pixel colour (every 6th sample; simulation dashed in "sim", measured in "meas").
"""
import glob
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data", "gonzaga")
IMG = os.path.join(HERE, "img")

SURF, INK, INK2, MUTED, GRID = "#1a1a19", "#f0efec", "#c3c2b7", "#8a897f", "#3a3936"
S_NOBU, S_SIM, S_MEAS = "#3987e5", "#d95926", "#199e70"
plt.rcParams.update({
    "font.family": ["Inter", "DejaVu Sans"], "font.size": 15,
    "figure.facecolor": SURF, "axes.facecolor": SURF, "axes.edgecolor": GRID,
    "axes.labelcolor": INK2, "axes.grid": True, "grid.color": GRID, "xtick.color": INK2,
    "ytick.color": INK2, "text.color": INK, "legend.frameon": False, "legend.labelcolor": INK,
    "lines.linewidth": 2.2, "savefig.facecolor": SURF,
})


def collect(source_dir):
    runs = []
    for path in sorted(glob.glob(os.path.join(source_dir, "**", "*.json"), recursive=True)):
        r = json.load(open(path))
        if "geometry" not in r:
            continue
        far = next((f for f in r["far_field"] if abs(f["f_ghz"] - 0.915) < 1e-9), None)
        if far is None:
            raise SystemExit(f"{path}: no far field at 0.915 GHz; solve it with --far including 0.915")
        far = {k: v for k, v in far.items() if k != "azimuth"}
        keep = {k: r[k] for k in ("geometry", "mesh", "grid", "height_mm", "arm_length_mm", "steps", "energy_decay_db",
                                  "stopped_on_energy", "solve_s", "f0_ghz", "s11_min_db", "band_10db_ghz", "zin_at_f0")}
        runs.append({"file": os.path.relpath(path, source_dir), **keep, "s11": [row[:2] for row in r["s11"]], "far_field_915": far})
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "runs.json"), "w") as fh:
        json.dump(runs, fh, separators=(",", ":"))
    print(f"collected {len(runs)} runs")


def frame(title, subtitle):
    fig = plt.figure(figsize=(16, 9), dpi=100)
    fig.text(0.04, 0.945, title, fontsize=28, fontweight="bold", va="top")
    fig.text(0.04, 0.875, subtitle, fontsize=15, color=INK2, va="top")
    fig.text(0.04, 0.025, "NobuRF benchmark · docs/benchmarks/gonzaga.md · paper: Krukovich et al., IEEE AP-S 2019, pp. 307-308",
             fontsize=11.5, color=MUTED)
    return fig


def baseline(runs, cell=1.0):
    """The reference solve: Table I optimum (pitch 10.5, disk trace 4.0) on the 1 mm mesh."""
    return next(r for r in runs if r["geometry"]["pitchDeg"] == 10.5 and r["geometry"]["diskTraceWidthMm"] == 4
                and r["geometry"]["radiusMm"] == 23.6 and r["mesh"]["cellMm"] == cell)


def plot_s11(runs, fig3):
    r = baseline(runs)
    s11 = np.array(r["s11"])
    fig = frame("Open helix S11: NobuRF, the paper's simulation, and the prototype",
                "Pitch 10.5°, arm width 14.6 mm, disk trace 4.0 mm (Table I). Helix radius reconstructed (23.6 mm): the paper does not give it.")
    ax = fig.add_axes([0.07, 0.12, 0.88, 0.7])
    ax.plot(s11[:, 0] * 1000, s11[:, 1], color=S_NOBU, label=f"NobuRF (f0 {r['f0_ghz'] * 1000:.0f} MHz, {r['s11_min_db']:.1f} dB)")
    for key, color, style, label in (("sim", S_SIM, "--", "Simulated, paper Fig. 3"), ("meas", S_MEAS, "-", "Measured prototype, paper Fig. 3")):
        pts = np.array(fig3[key])
        ax.plot(pts[:, 0], pts[:, 1], color=color, linestyle=style, label=label)
    ax.set_xlim(800, 1000)
    ax.set_ylim(-45, 0)
    ax.set_xlabel("Frequency (MHz)")
    ax.set_ylabel("S11 (dB)")
    ax.legend(loc="lower left")
    fig.savefig(os.path.join(IMG, "gonzaga_s11.png"))
    plt.close(fig)


def plot_pitch_sweep(runs):
    sweep = sorted((r for r in runs if r["geometry"]["diskTraceWidthMm"] == 4 and r["geometry"]["radiusMm"] == 23.6
                    and r["mesh"]["cellMm"] == 1.0), key=lambda r: r["geometry"]["pitchDeg"])
    pitch = [r["geometry"]["pitchDeg"] for r in sweep]
    ar = [r["far_field_915"]["azimuth_axial_ratio_db"]["mean"] for r in sweep]
    s11 = [r["s11_min_db"] for r in sweep]
    fig = frame("Pitch sweep: axial ratio in the azimuth plane at 915 MHz",
                "The paper swept 9.5° to 14° and chose 10.5° for the best axial ratio in simulation. Same sweep in NobuRF, extended down to 6°.")
    ax = fig.add_axes([0.07, 0.12, 0.40, 0.68])
    ax.plot(pitch, ar, "o-", color=S_NOBU)
    ax.axvline(10.5, color=S_SIM, linestyle="--")
    ax.text(10.6, max(ar), "paper's optimum 10.5°", color=S_SIM, fontsize=13, va="top")
    ax.set_xlabel("Pitch angle (°)")
    ax.set_ylabel("Mean axial ratio, θ = 90° (dB)")
    ax2 = fig.add_axes([0.56, 0.12, 0.40, 0.68])
    ax2.plot(pitch, s11, "o-", color=S_NOBU)
    ax2.set_xlabel("Pitch angle (°)")
    ax2.set_ylabel("Deepest S11 (dB)")
    fig.savefig(os.path.join(IMG, "gonzaga_pitch_sweep.png"))
    plt.close(fig)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--collect":
        collect(sys.argv[2])
        return
    os.makedirs(IMG, exist_ok=True)
    runs = json.load(open(os.path.join(DATA, "runs.json")))
    fig3 = json.load(open(os.path.join(DATA, "fig3_digitised.json")))
    plot_s11(runs, fig3)
    plot_pitch_sweep(runs)
    print("wrote img/gonzaga_s11.png, img/gonzaga_pitch_sweep.png")


main()
