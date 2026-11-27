"""
SMA connector vs lumped port: openEMS with its 1/3-2/3 edge rule against the
NobuRF runs already on the branch. Quantities and limits: README.md here.

  python validation/openems/coax_thirds/compare.py
Prints a markdown table and writes compare.json next to this file.
"""
import csv
import json
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "..", "..", "docs", "validation", "data"))
BAND = (5.0, 5.5)  # GHz, for Im Z_in(SMA) - Im Z_in(lumped)


def openems(feed, res, suffix):
    path = os.path.join(DATA, f"openems_coaxfeed_{feed}_r{res:g}{suffix}.csv")
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        rows = list(csv.DictReader(fh))
    col = lambda c: np.array([float(r[c]) for r in rows])
    return dict(f=col("f_ghz"), s11=col("s11_db"), zi=col("zin_im"))


def noburf(feed, mesh):
    with open(os.path.join(DATA, "coax_feed", f"inset4_{mesh}_{feed}.json")) as fh:
        j = json.load(fh)
    return dict(f=np.array(j["fGHz"]), s11=np.array(j["s11Db"]), zi=np.array(j["zIm"]))


def summary(lumped, coax):
    """f0 and S11 min of each feed, and Im Z_in(SMA) - Im Z_in(lumped) over BAND (min, max, mean)."""
    out = {}
    for name, d in (("lumped", lumped), ("coax", coax)):
        k = int(np.argmin(d["s11"]))
        out[name] = dict(f0_ghz=round(float(d["f"][k]), 4), s11_min_db=round(float(d["s11"][k]), 2))
    grid = np.round(np.arange(BAND[0], BAND[1] + 1e-9, 0.01), 4)
    diff = np.interp(grid, coax["f"], coax["zi"]) - np.interp(grid, lumped["f"], lumped["zi"])
    out["dIm_ohm"] = dict(min=round(float(diff.min()), 2), max=round(float(diff.max()), 2), mean=round(float(diff.mean()), 2))
    return out


def main():
    cols = {}
    for mesh in ("e0.25_d6", "e0.5_d3"):
        cols[f"NobuRF {mesh}"] = summary(noburf("lumped", mesh), noburf("coax", mesh))
    for res in (0.25, 0.125):
        for suffix, label in (("", "on edges"), ("_thirds", "thirds")):
            lumped, coax = openems("lumped", res, suffix), openems("coax", res, suffix)
            if lumped is not None and coax is not None:
                cols[f"openEMS {res:g} mm {label}"] = summary(lumped, coax)
    names = list(cols)
    print("| Quantity | " + " | ".join(names) + " |")
    print("| --- |" + " --- |" * len(names))
    for feed, label in (("lumped", "Lumped port"), ("coax", "SMA at the flange")):
        print(f"| {label}: f0, S11 min | " + " | ".join(f"{cols[n][feed]['f0_ghz']:.2f} GHz, {cols[n][feed]['s11_min_db']:.1f} dB" for n in names) + " |")
    print("| Im Z_in SMA minus lumped, 5.0-5.5 GHz (mean) | " +
          " | ".join(f"{cols[n]['dIm_ohm']['min']:.0f} to {cols[n]['dIm_ohm']['max']:.0f} ohm ({cols[n]['dIm_ohm']['mean']:.1f})" for n in names) + " |")

    ref, dut = "openEMS 0.125 mm thirds", "NobuRF e0.25_d6"
    if ref in cols:
        checks = {}
        for feed in ("lumped", "coax"):
            d = (cols[dut][feed]["f0_ghz"] - cols[ref][feed]["f0_ghz"]) / cols[ref][feed]["f0_ghz"]
            checks[f"f0 {feed}"] = dict(delta_pct=round(100 * d, 2), limit_pct=1.0, passed=bool(abs(d) <= 0.01))
        d = cols[dut]["dIm_ohm"]["mean"] - cols[ref]["dIm_ohm"]["mean"]
        checks["Im Z shift mean"] = dict(delta_ohm=round(d, 2), limit_ohm=5.0, passed=bool(abs(d) <= 5.0))
        for name, c in checks.items():
            print(f"{name}: {c}")
        cols["checks"] = checks
    with open(os.path.join(HERE, "compare.json"), "w") as fh:
        json.dump(cols, fh, indent=1)


if __name__ == "__main__":
    main()
