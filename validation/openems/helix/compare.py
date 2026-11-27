"""
Gonzaga open helix: NobuRF against openEMS on the same PEC, lossless model.
Quantities and pass limits: README.md here (fixed before any run).

  python validation/openems/helix/compare.py
Reads results/noburf_<arms>_c<cell>.json (scripts/validate/gonzaga_helix.ts --out)
and results/openems_helix_curves_r<res>.json/_s11.csv/_azimuth.csv, prints the
tables and writes results/compare.json.
"""
import csv
import glob
import json
import os
import re

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "results")
F_FAR = 0.915
LIMITS = dict(f0_pct=1.0, bandwidth_pct=10.0, s11_min_db=3.0, z915_pct_of_abs=10.0, rhcp_gain_db=0.5, axial_ratio_db=1.0)


def figures(f, s11_db, z, phi_rows):
    """The graded quantities from an S11/Z sweep and the 915 MHz azimuth cut.
    phi_rows: (phi_deg, rhcp_dbi, lhcp_dbi, axial_ratio_db)."""
    f, s11_db = np.asarray(f), np.asarray(s11_db)
    k = int(np.argmin(s11_db))
    below = f[s11_db <= -10]
    k915 = int(np.argmin(np.abs(f - F_FAR)))
    rows = np.asarray(phi_rows, float)
    lin = lambda db: 10 * np.log10(np.mean(10 ** (db / 10)))
    rh, lh = lin(rows[:, 1]), lin(rows[:, 2])
    return dict(
        f0_ghz=round(float(f[k]), 5), s11_min_db=round(float(s11_db[k]), 2),
        band_ghz=[round(float(below.min()), 5), round(float(below.max()), 5)] if len(below) else None,
        bandwidth_mhz=round(float(below.max() - below.min()) * 1e3, 1) if len(below) else None,
        z915=[round(float(z[k915].real), 2), round(float(z[k915].imag), 2)],
        rhcp_gain_dbi=round(float(rh), 3), lhcp_gain_dbi=round(float(lh), 3), sense="RHCP" if rh >= lh else "LHCP",
        axial_ratio_db=round(float(rows[:, 3].mean()), 3),
    )


def load_noburf(path):
    with open(path) as fh:
        j = json.load(fh)
    s = np.array(j["s11"])
    far = next(x for x in j["far_field"] if abs(x["f_ghz"] - F_FAR) < 1e-6)
    out = figures(s[:, 0], s[:, 1], s[:, 2] + 1j * s[:, 3], far["azimuth"])
    out.update(cells=j["grid"]["cells"], steps=j["steps"], solve_s=j["solve_s"], energy_decay_db=j["energy_decay_db"], efficiency=far["efficiency"])
    return out


def load_openems(stem):
    with open(stem + ".json") as fh:
        meta = json.load(fh)
    with open(stem + "_s11.csv") as fh:
        s = np.array([[float(r[c]) for c in ("f_ghz", "s11_db", "zin_re", "zin_im")] for r in csv.DictReader(fh)])
    with open(stem + "_azimuth.csv") as fh:
        az = [[float(r[c]) for c in ("phi_deg", "rhcp_dbi", "lhcp_dbi", "axial_ratio_db")] for r in csv.DictReader(fh)]
    out = figures(s[:, 0], s[:, 1], s[:, 2] + 1j * s[:, 3], az)
    out.update(cells=meta["cells"], solve_s=meta["wall_s"], efficiency=meta["efficiency"])
    return out


def grade(dut, ref):
    d_f0 = 100 * (dut["f0_ghz"] - ref["f0_ghz"]) / ref["f0_ghz"]
    d_bw = 100 * (dut["bandwidth_mhz"] - ref["bandwidth_mhz"]) / ref["bandwidth_mhz"] if dut["bandwidth_mhz"] and ref["bandwidth_mhz"] else None
    zd, zr = complex(*dut["z915"]), complex(*ref["z915"])
    d_z = 100 * abs(zd - zr) / abs(zr)
    rows = [
        ("S11-minimum frequency", f"{d_f0:+.2f} %", abs(d_f0) <= LIMITS["f0_pct"], f"1 %"),
        ("-10 dB bandwidth", "n/a" if d_bw is None else f"{d_bw:+.1f} %", d_bw is not None and abs(d_bw) <= LIMITS["bandwidth_pct"], "10 %"),
        ("S11 minimum", f"{dut['s11_min_db'] - ref['s11_min_db']:+.2f} dB", abs(dut["s11_min_db"] - ref["s11_min_db"]) <= LIMITS["s11_min_db"], "3 dB"),
        ("Z_in at 915 MHz", f"{abs(zd - zr):.1f} ohm = {d_z:.1f} % of |Z|", d_z <= LIMITS["z915_pct_of_abs"], "10 % of |Z|"),
        ("Azimuth RHCP gain, 915 MHz", f"{dut['rhcp_gain_dbi'] - ref['rhcp_gain_dbi']:+.2f} dB", abs(dut["rhcp_gain_dbi"] - ref["rhcp_gain_dbi"]) <= LIMITS["rhcp_gain_db"], "0.5 dB"),
        ("Azimuth mean axial ratio, 915 MHz", f"{dut['axial_ratio_db'] - ref['axial_ratio_db']:+.2f} dB", abs(dut["axial_ratio_db"] - ref["axial_ratio_db"]) <= LIMITS["axial_ratio_db"], "1 dB"),
        ("Dominant sense", f"{dut['sense']} vs {ref['sense']}", dut["sense"] == ref["sense"], "same"),
    ]
    return [dict(quantity=q, delta=d, limit=l, passed=bool(p)) for q, d, p, l in rows]


def main():
    runs = {}
    for path in sorted(glob.glob(os.path.join(RES, "noburf_*.json"))):
        runs["NobuRF " + os.path.basename(path)[7:-5]] = load_noburf(path)
    for path in sorted(glob.glob(os.path.join(RES, "openems_helix_*.json"))):
        if re.search(r"_r[\d.]+\.json$", path):
            runs["openEMS " + os.path.basename(path)[14:-5]] = load_openems(path[:-5])
    names = list(runs)
    keys = ["f0_ghz", "s11_min_db", "band_ghz", "bandwidth_mhz", "z915", "rhcp_gain_dbi", "lhcp_gain_dbi", "sense", "axial_ratio_db", "efficiency", "cells", "solve_s"]
    print("| Quantity | " + " | ".join(names) + " |")
    print("| --- |" + " --- |" * len(names))
    for k in keys:
        print(f"| {k} | " + " | ".join(str(runs[n].get(k)) for n in names) + " |")
    ref_name = "openEMS curves_r0.5"
    verdicts = {}
    if ref_name in runs:
        for n in names:
            if n.startswith("NobuRF"):
                verdicts[n] = grade(runs[n], runs[ref_name])
                print(f"\n{n} vs {ref_name}")
                for v in verdicts[n]:
                    print(f"  {v['quantity']}: {v['delta']} (limit {v['limit']}) {'PASS' if v['passed'] else 'FAIL'}")
    coarse = "openEMS curves_r1"
    if coarse in runs and ref_name in runs:
        mv = 100 * (runs[ref_name]["f0_ghz"] - runs[coarse]["f0_ghz"]) / runs[coarse]["f0_ghz"]
        print(f"\nopenEMS f0 change 1 mm -> 0.5 mm: {mv:+.2f} % ({'converged within 1 %' if abs(mv) <= 1 else 'NOT converged within 1 %'})")
        verdicts["openems_f0_change_pct"] = round(mv, 3)
    with open(os.path.join(RES, "compare.json"), "w") as fh:
        json.dump(dict(runs=runs, verdicts=verdicts, limits=LIMITS), fh, indent=1)


if __name__ == "__main__":
    main()
