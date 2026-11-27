"""
openEMS reference for the Gonzaga open helix (scripts/validate/open_helix_model.ts,
docs/benchmarks/gonzaga.md): the same center-fed element, PEC copper and a
lossless disk, on openEMS's Cartesian FDTD grid. README.md in this folder
gives the quantities and pass limits, fixed before any run.

Geometry, from the NobuRF builder (mm, helix axis along z, disk centred on z = 0):
  - disk: radius R, thickness T, eps_r 4.4, lossless;
  - traces: |y| <= w/2 across the disk on both faces (z = +-T/2);
  - arms: four strips on the cylinder r = R. Upper arm A starts at
    phi = -(w/2)/R and wraps `wrap` degrees; over the trace end (the first
    w/R radians) its lower edge stays on the disk face, after that it climbs
    at the pitch angle; its vertical span is W / cos(pitch). The other three
    arms are A turned 180 degrees about x, about z, and about y.
  - port: 50 ohm lumped port on the axis between the two traces.

The arms are drawn in CSXCAD's cylindrical coordinates: each arm is a polygon
in the unrolled (alpha, z) plane at r = R (--arms sheet, zero thickness), or
the same polygon extruded across r from R - t/2 to R + t/2 (--arms shell).
--check builds the structure, runs openEMS's setup only with its PEC dump and
reports how many metal edges each arm got and where they sit, so it can be
seen whether openEMS meshes the arms at all.

  python helix_openems.py --res 1.0
  python helix_openems.py --res 0.5
  python helix_openems.py --res 1.0 --check
"""
import argparse
import base64
import glob
import struct
import zlib
import json
import os
import re
import tempfile
import time
import xml.etree.ElementTree as ET

import numpy as np

from CSXCAD import ContinuousStructure
from openEMS import openEMS

C0 = 299_792_458.0
DEG = np.pi / 180

# scripts/validate/gonzaga_helix.ts DEFAULTS (paper Table I plus the reconstructed radius and wrap).
GEOM = dict(radius=23.6, pitch=10.5, arm_width=14.6, disk_width=4.0, wrap=170.0, disk_thickness=1.6, disk_eps=4.4)
F_LO, F_HI, NF = 0.7, 1.1, 401
FAR_GHZ = 0.915
# The four 180 degree turns of open_helix_model.ts ARM_TURNS: (x, y, z) -> (sx x, sy y, sz z).
ARM_TURNS = [(1, 1, 1), (1, -1, -1), (-1, -1, 1), (-1, 1, -1)]


def upper_arm_top(g):
    return g["disk_thickness"] / 2 + g["radius"] * g["wrap"] * DEG * np.tan(g["pitch"] * DEG) + g["arm_width"] / np.cos(g["pitch"] * DEG)


def arm_outline(g):
    """Upper arm A as (phi, z) vertices, phi in radians, same outline as onUpperArmA."""
    R, halfT = g["radius"], g["disk_thickness"] / 2
    start = -(g["disk_width"] / 2) / R
    flat = 2 * -start
    wrap = g["wrap"] * DEG
    tanp = np.tan(g["pitch"] * DEG)
    span = g["arm_width"] / np.cos(g["pitch"] * DEG)
    climb0 = halfT + R * flat * tanp
    climb1 = halfT + R * wrap * tanp
    rel = [(0, halfT), (flat, halfT), (flat, climb0), (wrap, climb1),
           (wrap, climb1 + span), (flat, climb0 + span), (flat, halfT + span), (0, halfT + span)]
    return [(p + start, z) for p, z in rel]


def turned(outline, sx, sy, sz):
    """Apply (x, y, z) -> (sx x, sy y, sz z) to (phi, z) points."""
    out = []
    for phi, z in outline:
        x, y = sx * np.cos(phi), sy * np.sin(phi)
        out.append((np.arctan2(y, x), sz * z))
    return out


def split_at_pi(poly):
    """Split a (phi, z) polygon that crosses phi = +-pi into pieces inside (-pi, pi].

    The outline's phi runs continuously, so unwrap it first, then clip at the
    multiples of pi with a straight cut (z interpolated along each edge)."""
    phis = np.unwrap([p for p, _ in poly])
    pts = list(zip(phis, [z for _, z in poly]))
    lo, hi = min(phis), max(phis)
    pieces = []
    k0 = int(np.floor((lo + np.pi) / (2 * np.pi)))
    k1 = int(np.floor((hi + np.pi) / (2 * np.pi)))
    for k in range(k0, k1 + 1):
        a, b = -np.pi + 2 * np.pi * k, np.pi + 2 * np.pi * k
        clipped = clip(clip(pts, a, keep_above=True), b, keep_above=False)
        if len(clipped) >= 3:
            pieces.append([(p - 2 * np.pi * k, z) for p, z in clipped])
    return pieces


def clip(pts, cut, keep_above):
    """Sutherland-Hodgman clip of a polygon by the line phi = cut."""
    inside = (lambda p: p >= cut - 1e-12) if keep_above else (lambda p: p <= cut + 1e-12)
    out = []
    for n in range(len(pts)):
        cur, nxt = pts[n], pts[(n + 1) % len(pts)]
        if inside(cur[0]):
            out.append(cur)
        if inside(cur[0]) != inside(nxt[0]):
            t = (cut - cur[0]) / (nxt[0] - cur[0])
            out.append((cut, cur[1] + t * (nxt[1] - cur[1])))
    return out


def phi_slices(piece, dphi):
    """Cut a (phi, z) polygon into slices dphi wide: (phi0, phi1, zlo, zhi) at each slice's centre."""
    phis = [p for p, _ in piece]
    lo, hi = min(phis), max(phis)
    n = max(1, int(np.ceil((hi - lo) / dphi)))
    edges = list(zip(piece, piece[1:] + piece[:1]))
    out = []
    for m in range(n):
        a0, a1 = lo + (hi - lo) * m / n, lo + (hi - lo) * (m + 1) / n
        c = (a0 + a1) / 2
        zs = [z0 + (c - p0) / (p1 - p0) * (z1 - z0) for (p0, z0), (p1, z1) in edges if min(p0, p1) <= c <= max(p0, p1) and p1 != p0]
        if zs:
            out.append((a0, a1, min(zs), max(zs)))
    return out


def wire_grid(g, sx, sy, sz, step):
    """One arm as a grid of curves (x, y, z rows) no more than `step` apart: lines along z at
    every phi sample, arcs at every z level, and the outline. openEMS snaps each curve
    onto the mesh, so the grid becomes a closed staircase of metal edges at r ~ R."""
    R, halfT = g["radius"], g["disk_thickness"] / 2
    start = -(g["disk_width"] / 2) / R
    flat = 2 * -start
    wrap = g["wrap"] * DEG
    tanp = np.tan(g["pitch"] * DEG)
    span = g["arm_width"] / np.cos(g["pitch"] * DEG)
    lower = lambda p: halfT if p <= flat else halfT + R * p * tanp
    xyz = lambda p, z: (sx * R * np.cos(p + start), sy * R * np.sin(p + start), sz * z)
    curves = []

    def arc(p0, p1, z):
        n = max(1, int(np.ceil(R * (p1 - p0) / step)))
        return [xyz(p, z) for p in np.linspace(p0, p1, n + 1)]

    # Lines along z.
    n = int(np.ceil(R * wrap / step))
    for p in sorted(set(np.linspace(0, wrap, n + 1)) | {flat, flat + 1e-4}):
        z0 = lower(p)
        curves.append([xyz(p, z0), xyz(p, z0 + span)])
    # Arcs at constant z.
    z_top = halfT + R * wrap * tanp + span
    for z in np.linspace(halfT, z_top, int(np.ceil((z_top - halfT) / step)) + 1):
        segs = []
        if z <= halfT + span:
            segs.append([0.0, flat])
        a = max(flat + 1e-4, (z - span - halfT) / (R * tanp))
        b = min(wrap, (z - halfT) / (R * tanp))
        if a <= b:
            if segs and a <= flat + 1e-3:
                segs[-1][1] = b
            else:
                segs.append([a, b])
        for p0, p1 in segs:
            if p1 > p0:
                curves.append(arc(p0, p1, z))
    # The outline itself: the slanted lower and upper edges.
    for edge in (lambda p: lower(p), lambda p: lower(p) + span):
        m = max(1, int(np.ceil(R * (wrap - flat) / step)))
        curves.append([xyz(p, edge(p)) for p in np.linspace(flat + 1e-4, wrap, m + 1)])
    curves.append(arc(0.0, flat, halfT))
    curves.append(arc(0.0, flat, halfT + span))
    return [np.array(c).T for c in curves]


def trace_outline(g, reach):
    """Disk trace |y| <= w/2, its two ends on arcs of radius `reach`, as (x, y) points."""
    half = g["disk_width"] / 2
    a = np.arcsin(half / reach)
    t = np.linspace(-a, a, 9)
    right = [(reach * np.cos(u), reach * np.sin(u)) for u in t]
    left = [(-reach * np.cos(u), -reach * np.sin(u)) for u in t]
    return right + left


def graded_lines(fixed, lo, hi, fine, coarse, ratio=1.2):
    """Lines at `fixed`, `fine` pitch between them, graded by `ratio` out to lo and hi (coarse at most)."""
    fixed = sorted(set(round(v, 6) for v in fixed))
    lines = list(fixed)
    for p, q in zip(fixed[:-1], fixed[1:]):
        n = int(np.ceil((q - p) / fine - 1e-9))
        lines += list(np.linspace(p, q, n + 1))
    for start, end, sgn in ((fixed[0], lo, -1), (fixed[-1], hi, 1)):
        x, step = start, fine
        while (end - x) * sgn > 0:
            step = min(step * ratio, coarse)
            x += sgn * step
            if (end - x) * sgn < step * 0.5:
                x = end
            lines.append(x)
    return np.unique(np.round(lines, 6))


def merge_close(lines, tol):
    """Drop lines closer than tol to the previous kept one (keeps the first)."""
    out = [lines[0]]
    for v in lines[1:]:
        if v - out[-1] >= tol:
            out.append(v)
    return np.array(out)


def build(g, res, arms, shell_mm, padding, coarse, nf2ff_gap):
    R, halfT, half_w = g["radius"], g["disk_thickness"] / 2, g["disk_width"] / 2
    top = upper_arm_top(g)

    fdtd = openEMS(NrTS=400_000, EndCriteria=1e-5)  # stop at -50 dB energy
    fdtd.SetGaussExcite((F_LO + F_HI) / 2 * 1e9, (F_HI - F_LO) / 2 * 1e9)
    fdtd.SetBoundaryCond(["PML_8"] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    mesh = csx.GetGrid()
    mesh.SetDeltaUnit(1e-3)

    inner_xy = R + 2 * res
    inner_z = top + 2 * res
    # Trace edges: openEMS's 1/3-2/3 rule (a line res/3 inside the copper, one 2 res/3 outside).
    trace_y = [s * (half_w - res / 3) for s in (-1, 1)] + [s * (half_w + 2 * res / 3) for s in (-1, 1)]
    xs = graded_lines([-inner_xy, 0.0, inner_xy], -inner_xy - padding, inner_xy + padding, res, coarse)
    ys = graded_lines([-inner_xy, 0.0, inner_xy] + trace_y, -inner_xy - padding, inner_xy + padding, res, coarse)
    dz_disk = min(res, halfT / 2)
    zs_fixed = [-inner_z, inner_z] + list(np.linspace(-halfT, halfT, int(round(2 * halfT / dz_disk)) + 1))
    zs = graded_lines(zs_fixed, -inner_z - padding, inner_z + padding, res, coarse)
    mesh.SetLines("x", merge_close(xs, 0.2 * res))
    mesh.SetLines("y", merge_close(ys, 0.2 * res))
    mesh.SetLines("z", merge_close(zs, 0.2 * dz_disk))

    csx.AddMaterial("disk", epsilon=g["disk_eps"]).AddCylinder([0, 0, -halfT], [0, 0, halfT], R, priority=1)
    cu = csx.AddMetal("traces")
    # The trace reaches half a cell past the cylinder so it meets the arm's metal on the grid,
    # as NobuRF's sheet arms do (open_helix_model.ts paints every cell the cylinder cuts).
    tr = np.array(trace_outline(g, R + res / 2)).T
    for z in (-halfT, halfT):
        cu.AddPolygon(tr, norm_dir=2, elevation=z, priority=10)

    arm_metal = csx.AddMetal("arms")
    pieces = []
    for sx, sy, sz in ARM_TURNS:
        if arms == "curves":
            for pts in wire_grid(g, sx, sy, sz, res / 2):
                arm_metal.AddCurve(pts, priority=10)
            continue
        for piece in split_at_pi(turned(arm_outline(g), sx, sy, sz)):
            pts = np.array(piece).T  # (alpha, z)
            if arms == "sheet":
                prim = arm_metal.AddPolygon(pts, norm_dir=0, elevation=R, priority=10)
                prim.SetCoordinateSystem(1)
            elif arms == "shell":
                prim = arm_metal.AddLinPoly(pts, norm_dir=0, elevation=R - shell_mm / 2, length=shell_mm, priority=10)
                prim.SetCoordinateSystem(1)
            else:  # "boxes": zero-thickness cylindrical boxes, one per thin phi slice
                for a0, a1, z0, z1 in phi_slices(piece, res / 8 / R):
                    prim = arm_metal.AddBox([R, a0, z0], [R, a1, z1], priority=10)
                    prim.SetCoordinateSystem(1)
            pieces.append(piece)

    port = fdtd.AddLumpedPort(1, 50, [0, 0, -halfT], [0, 0, halfT], "z", 1.0, priority=5)
    box = None
    if nf2ff_gap is not None:
        b = nf2ff_gap
        box = fdtd.CreateNF2FFBox(start=[-R - b, -R - b, -top - b], stop=[R + b, R + b, top + b])
    return fdtd, csx, mesh, port, box, pieces


def _appended_array(stream, offset, dtype):
    """One array of a VTK XML file's base64, zlib-compressed appended section (UInt32 header)."""
    first = base64.b64decode(stream[offset:offset + 8])
    nblocks = struct.unpack("<I", first[:4])[0]
    hbytes = 4 * (3 + nblocks)
    hlen = 4 * ((hbytes + 2) // 3)
    header = struct.unpack(f"<{3 + nblocks}I", base64.b64decode(stream[offset:offset + hlen])[:hbytes])
    sizes = header[3:]
    dlen = 4 * ((sum(sizes) + 2) // 3)
    data = base64.b64decode(stream[offset + hlen:offset + hlen + dlen])
    out, pos = b"", 0
    for s in sizes:
        out += zlib.decompress(data[pos:pos + s])
        pos += s
    return np.frombuffer(out, dtype=dtype)


def read_pec_dump(path):
    """Edges of openEMS's PEC dump (VTK PolyData, appended base64 + zlib): list of (p0, p1) in metres."""
    text = open(path, "rb").read().decode("latin-1")
    stream = text[text.index("_", text.index("<AppendedData")) + 1:]
    piece = ET.fromstring(text[:text.index("<AppendedData")] + "</VTKFile>").find(".//Piece")
    arr = lambda el: _appended_array(stream, int(el.get("offset")), {"Float32": "<f4", "Float64": "<f8", "Int64": "<i8", "Int32": "<i4"}[el.get("type")])
    pts = arr(piece.find("Points/DataArray")).reshape(-1, 3)
    conn = arr(piece.find("Lines/DataArray[@Name='connectivity']"))
    offs = arr(piece.find("Lines/DataArray[@Name='offsets']"))
    edges, s = [], 0
    for o in offs:
        ids = conn[s:o]
        for a, b in zip(ids[:-1], ids[1:]):
            edges.append((pts[a], pts[b]))
        s = o
    return edges


def check(g, res, arms, shell_mm, padding, coarse):
    fdtd, csx, mesh, port, box, pieces = build(g, res, arms, shell_mm, padding, coarse, None)
    sim_path = tempfile.mkdtemp(prefix=f"oems_helix_check_{arms}_")
    fdtd.Run(sim_path, setup_only=True, debug_PEC=True, verbose=0)
    dumps = glob.glob(os.path.join(sim_path, "*PEC*.vtp"))
    print("PEC dumps:", [os.path.basename(d) for d in dumps])
    R, halfT = g["radius"], g["disk_thickness"] / 2
    report = dict(res_mm=res, arms=arms, shell_mm=shell_mm if arms == "shell" else None, sim_path=sim_path)
    edges = []
    for d in dumps:
        try:
            edges += read_pec_dump(d)
        except Exception as e:  # noqa: BLE001
            print("could not parse", d, e)
    mids = np.array([(a + b) / 2 for a, b in edges]) * 1e3 if edges else np.zeros((0, 3))  # metres -> mm
    if len(mids):
        r = np.hypot(mids[:, 0], mids[:, 1])
        on_cyl = mids[(np.abs(r - R) < 1.5 * res) & (np.abs(mids[:, 2]) > halfT + 1e-3)]
        report.update(pec_edges=len(edges), arm_edges=int(len(on_cyl)))
        if len(on_cyl):
            rr = np.hypot(on_cyl[:, 0], on_cyl[:, 1])
            report.update(arm_r_min=round(float(rr.min()), 3), arm_r_max=round(float(rr.max()), 3))
            # Coverage: fraction of the arm area's (phi, z) bins (res x res) that hold an arm edge.
            phi = np.arctan2(on_cyl[:, 1], on_cyl[:, 0])
            report["arm_edge_phi_span_deg"] = round(float(np.ptp(np.unwrap(np.sort(phi))) / DEG), 1)
            # Coverage: points every res/2 on the four drawn arms; a point is covered when a metal
            # edge's midpoint lies within one cell of it. Holes in the drawn metal show up here.
            keys = set(map(tuple, np.floor(on_cyl / res).astype(int)))
            samples = np.concatenate([np.concatenate([c.T for c in wire_grid(g, *t, res / 2)]) for t in ARM_TURNS])
            covered = 0
            for s in samples:
                k = np.floor(s / res).astype(int)
                near = [tuple(k + d) for d in np.array(np.meshgrid([-1, 0, 1], [-1, 0, 1], [-1, 0, 1])).T.reshape(-1, 3)]
                if any(n in keys for n in near):
                    ok = on_cyl[np.all(np.abs(np.floor(on_cyl / res) - k) <= 1, axis=1)]
                    covered += bool(len(ok)) and np.min(np.linalg.norm(ok - s, axis=1)) <= res
            report["arm_coverage"] = round(covered / len(samples), 4)
        np.save(os.path.join(sim_path, "arm_edge_mids.npy"), on_cyl)
    print(json.dumps(report, indent=1))
    return report


def run(g, res, arms, shell_mm, padding, coarse, threads, tag_extra=""):
    gap = 10.0
    fdtd, csx, mesh, port, box, _ = build(g, res, arms, shell_mm, padding, coarse, gap)
    ncells = int(np.prod([len(mesh.GetLines(a)) - 1 for a in "xyz"]))
    sim_path = tempfile.mkdtemp(prefix=f"oems_helix_{arms}_r{res:g}_")
    print(f"cells {ncells}, sim path {sim_path}", flush=True)
    t0 = time.time()
    fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=threads)
    wall = time.time() - t0

    f = np.linspace(F_LO, F_HI, NF) * 1e9
    port.CalcPort(sim_path, f)
    zin = port.uf_tot / port.if_tot
    s11 = (zin - 50) / (zin + 50)
    s11_db = 20 * np.log10(np.abs(s11))
    k = int(np.argmin(s11_db))
    below = f[s11_db <= -10]
    k915 = int(np.argmin(np.abs(f - FAR_GHZ * 1e9)))

    # Far field at 915 MHz: azimuth plane theta = 90, phi every 2 degrees, plus the full sphere for directivity.
    theta = np.arange(0.0, 181.0, 2.0)
    phi = np.arange(0.0, 360.0, 2.0)
    ff = box.CalcNF2FF(sim_path, FAR_GHZ * 1e9, theta, phi, center=[0, 0, 0])
    port.CalcPort(sim_path, [FAR_GHZ * 1e9])
    p_acc = float(port.P_acc[0])
    p_rad = float(ff.Prad[0])
    eff = p_rad / p_acc
    d_max = float(ff.Dmax[0])
    e_norm = ff.E_norm[0]
    e_max = float(np.max(e_norm))
    it = int(np.argmin(np.abs(theta - 90)))
    er = np.abs(ff.E_cprh[0][it, :])
    el = np.abs(ff.E_cplh[0][it, :])
    # Partial gain of each hand: G x (|E_hand| / |E|max)^2 x Dmax, |E|^2 = |E_R|^2 + |E_L|^2.
    g_r = d_max * eff * (er / e_max) ** 2
    g_l = d_max * eff * (el / e_max) ** 2
    co, cross = (g_r, g_l) if g_r.mean() >= g_l.mean() else (g_l, g_r)
    ar = 20 * np.log10((er + el) / np.maximum(np.abs(er - el), 1e-30))

    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "results")
    os.makedirs(out, exist_ok=True)
    tag = f"openems_helix_{arms}_r{res:g}{tag_extra}"
    with open(os.path.join(out, tag + "_s11.csv"), "w") as fh:
        fh.write("f_ghz,s11_db,zin_re,zin_im\n")
        for n in range(NF):
            fh.write(f"{f[n] / 1e9:.5f},{s11_db[n]:.4f},{zin[n].real:.4f},{zin[n].imag:.4f}\n")
    with open(os.path.join(out, tag + "_azimuth.csv"), "w") as fh:
        fh.write("phi_deg,rhcp_dbi,lhcp_dbi,axial_ratio_db\n")
        for q in range(len(phi)):
            fh.write(f"{phi[q]:g},{10 * np.log10(g_r[q]):.3f},{10 * np.log10(g_l[q]):.3f},{ar[q]:.3f}\n")
    meta = dict(
        arms=arms, shell_mm=shell_mm if arms == "shell" else None, res_mm=res, padding_mm=padding, coarse_mm=coarse,
        cells=ncells, wall_s=round(wall, 1), end_criteria_db=-50,
        f0_ghz=round(f[k] / 1e9, 5), s11_min_db=round(float(s11_db[k]), 3),
        band_10db_ghz=[round(below.min() / 1e9, 5), round(below.max() / 1e9, 5)] if len(below) else None,
        zin_915=[round(float(zin[k915].real), 2), round(float(zin[k915].imag), 2)],
        far_field_f_ghz=FAR_GHZ, efficiency=round(eff, 4), peak_directivity_dbi=round(10 * np.log10(d_max), 3),
        sense="RHCP" if g_r.mean() >= g_l.mean() else "LHCP",
        azimuth_co_gain_dbi=dict(mean=round(float(10 * np.log10(co.mean())), 3),
                                 min=round(float(10 * np.log10(co.min())), 3), max=round(float(10 * np.log10(co.max())), 3)),
        azimuth_rhcp_gain_dbi_mean=round(float(10 * np.log10(g_r.mean())), 3),
        azimuth_axial_ratio_db=dict(mean=round(float(ar.mean()), 3), min=round(float(ar.min()), 3), max=round(float(ar.max()), 3)),
        azimuth_cross_polar_rejection_db_min=round(float(np.min(10 * np.log10(co / cross))), 3),
    )
    with open(os.path.join(out, tag + ".json"), "w") as fh:
        json.dump(meta, fh, indent=1)
    print(json.dumps(meta), flush=True)
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", type=float, default=1.0, help="cell size over the antenna (mm)")
    ap.add_argument("--arms", choices=["sheet", "shell", "boxes", "curves"], default="curves")
    ap.add_argument("--shell", type=float, default=0.1, help="shell thickness for --arms shell (mm)")
    ap.add_argument("--padding", type=float, default=100.0, help="air from the antenna to the PML (mm)")
    ap.add_argument("--coarse", type=float, default=5.0, help="largest cell in the air (mm)")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--check", action="store_true", help="setup only: dump the PEC edges and report the arms' coverage")
    a = ap.parse_args()
    if a.check:
        check(GEOM, a.res, a.arms, a.shell, a.padding, a.coarse)
    else:
        run(GEOM, a.res, a.arms, a.shell, a.padding, a.coarse, a.threads)
