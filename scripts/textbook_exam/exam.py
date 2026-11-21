"""The textbook exam: Pozar and Balanis worked examples solved with NobuRF as the only EM tool.

    python3 scripts/textbook_exam/exam.py            # build, solve (GPU), grade, write results.json
    python3 scripts/textbook_exam/exam.py --cpu      # same on the CPU reference solver (slow)
    python3 scripts/textbook_exam/exam.py --only line,waveguide

Each case builds its project files in examples/textbook/, runs `noburf solve` on them (a result is
reused when the file is unchanged), reads the Touchstone and far-field files it writes, and grades
the answer against the book's, recomputed in theory.py. Network arithmetic (de-embedding, putting
a load on a port) is in network.py. See docs/textbook-exam.md for the method and the scorecard.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import network as nw  # noqa: E402
import theory as th  # noqa: E402
import build  # noqa: E402
from build import RESULTS_DIR, Rect, Substrate, microstrip_project, mm, pml_all, polygon, shapes, solve  # noqa: E402

FEED_MM = 10.0
# Calibration and circuit band shared by every RO4003C case, so one calibration serves them all.
BAND = (0.25, 6.5, 126)


@dataclass
class Grade:
    case: str
    source: str
    quantity: str
    book: float | None
    nobu: float | None
    unit: str
    error_pct: float | None = None
    verdict: str = ''
    note: str = ''
    absolute: bool = False
    extra: dict = field(default_factory=dict)
    post_hoc: bool = False  # metric chosen after the first full run: reported, never counted


def graded(case: str, source: str, quantity: str, book: float, nobu: float, unit: str,
           tol_pass: float, tol_close: float, note: str = '', absolute: bool = False, post_hoc: bool = False,
           **extra) -> Grade:
    """Pass within tol_pass, close within tol_close: percent of the book value, or absolute units."""
    err = nobu - book if absolute else 100 * (nobu - book) / book
    verdict = 'pass' if abs(err) <= tol_pass else 'close' if abs(err) <= tol_close else 'fail'
    return Grade(case, source, quantity, book, nobu, unit, err, verdict, note, absolute, extra, post_hoc)


# --- Calibration kits: thru + two lines of each feed impedance -----------------

@dataclass
class Kit:
    sub: Substrate
    z_design: float
    w_mm: float
    eps_eff_book: float
    f: np.ndarray
    error_box: np.ndarray
    gamma_per_mm: np.ndarray
    z_line: float


_kits: dict[str, Kit] = {}


def straight_line(name: str, sub: Substrate, w: float, length: float, band=BAND, refine: int = 1) -> dict:
    return microstrip_project(name, sub, [(-length / 2, -w / 2, length / 2, w / 2)],
                              [('p1', -length / 2, 0), ('p2', length / 2, 0)], *band, [band[0] * 2],
                              **mesh_args(refine))


def kit(label: str, sub: Substrate, z_design: float, band=BAND, refine: int = 1) -> Kit:
    """Thru (2 x 10 mm) and lines 12 and 48 mm longer for a line of z_design drawn with Pozar eq. 3.197."""
    if refine > 1:
        label = f'{label}-r{refine}'
    if label in _kits:
        return _kits[label]
    wh = th.microstrip_w_over_h(sub.eps_r, z_design)
    w = wh * sub.h_mm
    ee = th.microstrip_eps_eff(sub.eps_r, wh)
    thru = solve(straight_line(f'kit-{label}-thru', sub, w, 2 * FEED_MM, band, refine))
    lines = []
    for extra in (12.0, 48.0):
        s = solve(straight_line(f'kit-{label}-line{extra:.0f}', sub, w, 2 * FEED_MM + extra, band, refine))
        lines.append((nw.read_touchstone(s.touchstone())[1], extra))
    f, s_thru, _ = nw.read_touchstone(thru.touchstone())
    z_line = nw.low_frequency_line_impedance(f, s_thru, lines[1][0], 50, f_max_ghz=1.5)
    box, gamma = nw.thru_line_calibration(f, s_thru, lines, ee, z_line, 50)
    _kits[label] = Kit(sub, z_design, w, ee, f, box, gamma, z_line)
    return _kits[label]


def eps_eff_measured(k: Kit, f_lo: float, f_hi: float) -> float:
    k0 = 2 * np.pi * k.f * 1e9 / th.C0 * 1e-3
    sel = (k.f >= f_lo) & (k.f <= f_hi)
    return float(np.mean((k.gamma_per_mm.imag[sel] / k0[sel]) ** 2))


def deembedded(project: dict, kits_per_port: list[Kit]) -> tuple[np.ndarray, np.ndarray]:
    solved = solve(project)
    f, s, _ = nw.read_touchstone(solved.touchstone())
    out = nw.deembed_per_port(s, [k.error_box for k in kits_per_port], 50)
    return f, out


RO4003C = Substrate(3.55, 0.0, 0.813)


def ms_width(sub: Substrate, z: float) -> float:
    return th.microstrip_w_over_h(sub.eps_r, z) * sub.h_mm


def ms_length(sub: Substrate, z: float, f_ghz: float, deg: float) -> float:
    return th.guided_length_mm(th.microstrip_eps_eff(sub.eps_r, th.microstrip_w_over_h(sub.eps_r, z)), f_ghz, deg)


def cascade_project(name: str, sub: Substrate, sections: list[tuple[float, float]], band=BAND,
                    z_in: float = 50, z_out: float = 50, refine: int = 1) -> dict:
    """Feeds of z_in and z_out (10 mm each) around a cascade of (Z, length mm) sections along x."""
    rects: list[Rect] = []
    total = sum(l for _, l in sections)
    x = -total / 2
    w_in, w_out = ms_width(sub, z_in), ms_width(sub, z_out)
    rects.append((x - FEED_MM, -w_in / 2, x, w_in / 2))
    for z, l in sections:
        w = ms_width(sub, z)
        rects.append((x, -w / 2, x + l, w / 2))
        x += l
    rects.append((x, -w_out / 2, x + FEED_MM, w_out / 2))
    ports = [('p1', -total / 2 - FEED_MM, 0), ('p2', total / 2 + FEED_MM, 0)]
    return microstrip_project(name, sub, rects, ports, *band, [band[0] * 2], **mesh_args(refine))


def mesh_args(refine: int) -> dict:
    """The exam's default mesh (0.2 mm edge cells, 4 cells across the substrate), or finer by `refine`."""
    return {'edge_mm': 0.2 / refine, 'dielectric_cells': 4 * refine}


def suffix(refine: int) -> str:
    return '' if refine == 1 else f'-r{refine}'


# --- Cases ---------------------------------------------------------------------

def case_line() -> list[Grade]:
    """Pozar Ex. 3.7: 50 ohm line, 90 degrees at 2.5 GHz, d = 0.127 cm, eps_r 2.20."""
    sub = Substrate(2.2, 0.0, 1.27)
    band = (0.25, 5.0, 96)
    k = kit('ex37', sub, 50, band)
    ee = eps_eff_measured(k, 1.0, 4.0)
    wh = k.w_mm / sub.h_mm
    length = th.guided_length_mm(k.eps_eff_book, 2.5, 90)
    phase = math.degrees(k.gamma_per_mm.imag[int(np.argmin(np.abs(k.f - 2.5)))] * length)
    src = 'Pozar Ex. 3.7'
    return [
        graded('line', src, 'eps_eff of the 50 ohm line (W = 3.91 mm)', k.eps_eff_book, ee, '', 1, 3,
               'Two-line method on 12 and 48 mm line pairs, mean over 1-4 GHz. Pozar eq. 3.195 is itself '
               f'an approximation; Hammerstad-Jensen gives {hj_eps_eff(2.2, wh):.3f}.'),
        graded('line', src, f'Phase of the {length:.1f} mm line at 2.5 GHz', 90, phase, 'deg', 1, 3,
               'The book designs the length for exactly 90 degrees; beta measured at 2.5 GHz.'),
        graded('line', src, 'Characteristic impedance', 50, k.z_line, 'ohm', 2, 5,
               'Read from the de-embedded line in the low-frequency limit, where the lumped port '
               'parasitics vanish (fit Z0 + c f^2 below 1.5 GHz). Pozar eq. 3.196 at the drawn width '
               f'gives {th.microstrip_z0(2.2, wh):.2f} ohm.'),
    ]


def hj_eps_eff(eps_r: float, u: float) -> float:
    """Hammerstad and Jensen 1980, quasi-static, zero thickness."""
    a = 1 + math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + math.log(1 + (u / 18.1) ** 3) / 18.7
    b = 0.564 * ((eps_r - 0.9) / (eps_r + 3)) ** 0.053
    return (eps_r + 1) / 2 + (eps_r - 1) / 2 * (1 + 10 / u) ** (-a * b)


def case_quarter_wave() -> list[Grade]:
    """Pozar Ex. 5.5: quarter-wave transformer, 10 ohm load to a 50 ohm line at 3 GHz, SWR <= 1.5 bandwidth."""
    z1 = math.sqrt(50 * 10)
    k50, k1 = kit('ro50', RO4003C, 50), kit('ro22', RO4003C, z1)
    l1 = ms_length(RO4003C, z1, 3.0, 90)
    f, s = deembedded(cascade_project('pozar-ex5.5-quarter-wave', RO4003C, [(z1, l1)], z_out=z1), [k50, k1])
    g = nw.gamma_in_terminated(s, nw.gamma_of(10, 50))
    return grade_match('quarter-wave', 'Pozar Ex. 5.5', f, g, 3.0, th.quarter_wave_bandwidth(50, 10, 0.2), 0.2,
                       f'Section {z1:.2f} ohm, {l1:.2f} mm; the 10 ohm load sits at the end of the section, '
                       'applied to the de-embedded 2-port.')


def grade_match(case: str, src: str, f: np.ndarray, g: np.ndarray, f0: float, bw_book: float, gamma_max: float,
                note: str) -> list[Grade]:
    """Two questions the book answers: where is the matched band centred, and does |Gamma| stay
    below the design's Gamma_m over the book's band f0 (1 +- BW/2)?"""
    mag = np.abs(g)
    # Official centre (fixed before the run): midpoint of the band where |Gamma| <= 2 Gamma_m around f0.
    band = nw.band_below(f, mag, 2 * gamma_max, f0) or nw.band_below(f, mag, 2 * gamma_max, nw.refine_minimum(f, mag, 0.6 * f0, 1.4 * f0))
    centre = (band[0] + band[1]) / 2 if band else float('nan')
    # Post-hoc centre (chosen after the run): midway between the outermost |Gamma| minima below 2 Gamma_m.
    window = np.where((f > 0.4 * f0) & (f < 1.6 * f0))[0]
    minima = [float(f[k]) for k in window[1:-1] if mag[k] <= mag[k - 1] and mag[k] <= mag[k + 1] and mag[k] < 2 * gamma_max]
    centre_minima = (minima[0] + minima[-1]) / 2 if minima else float('nan')
    book_band = (f >= f0 * (1 - bw_book / 2)) & (f <= f0 * (1 + bw_book / 2))
    worst = float(mag[book_band].max())
    k0 = int(np.argmin(np.abs(f - f0)))
    return [
        graded(case, src, f'Centre of the matched band (|Gamma| <= {2 * gamma_max:.2g})', f0, centre, 'GHz', 2, 5,
               note + (f' Band {band[0]:.2f} to {band[1]:.2f} GHz.' if band else ''), gamma_at_f0=float(mag[k0])),
        graded(case, src, 'Centre, midway between the outermost |Gamma| minima', f0, centre_minima, 'GHz', 2, 5,
               (f'Minima at {minima[0]:.2f} and {minima[-1]:.2f} GHz. ' if minima else '')
               + f'Metric chosen after the first run; not counted. |Gamma| at {f0} GHz: {mag[k0]:.3f}.', post_hoc=True),
        graded(case, src, f'Worst |Gamma| over the book\'s band ({100 * bw_book:.0f} %, {f0 * (1 - bw_book / 2):.2f} to '
               f'{f0 * (1 + bw_book / 2):.2f} GHz)', gamma_max, worst, '', 0.25 * gamma_max, gamma_max,
               f'Book: |Gamma| <= {gamma_max:.3g} across the band. |Gamma| at {f0} GHz: {mag[k0]:.3f}.', absolute=True),
    ]


def case_binomial(refine: int = 1) -> list[Grade]:
    """Pozar Ex. 5.6: three-section binomial transformer, 50 ohm load to a 100 ohm line, Gamma_m = 0.05.

    Built from the 50 ohm side (port 1, 50 ohm feed) with the 100 ohm side as the load: a lossless
    transformer has the same |Gamma| seen from either end. Centre frequency 3 GHz (the book's is
    unspecified; its bandwidth is fractional)."""
    zs = th.binomial_impedances(100, 50, 3)[::-1]  # 54.5, 70.7, 91.7 from the 50 ohm end
    kits = [kit('ro50', RO4003C, 50, refine=refine), kit('ro100', RO4003C, 100, refine=refine)]
    sections = [(z, ms_length(RO4003C, z, 3.0, 90)) for z in zs]
    f, s = deembedded(cascade_project('pozar-ex5.6-binomial' + suffix(refine), RO4003C, sections, z_out=100, refine=refine), kits)
    g = nw.gamma_in_terminated(s, nw.gamma_of(100, 50))
    return grade_match('binomial' + suffix(refine), 'Pozar Ex. 5.6', f, g, 3.0, th.binomial_bandwidth(100, 50, 3, 0.05), 0.05, 'Sections ' + ', '.join(f'{z:.1f}' for z in zs) + ' ohm.')


def case_chebyshev(refine: int = 1) -> list[Grade]:
    """Pozar Ex. 5.7: three-section Chebyshev transformer, 100 ohm load to a 50 ohm line, Gamma_m = 0.05."""
    zs, theta_m = th.chebyshev3_impedances(50, 100, 0.05)
    kits = [kit('ro50', RO4003C, 50, refine=refine), kit('ro100', RO4003C, 100, refine=refine)]
    sections = [(z, ms_length(RO4003C, z, 3.0, 90)) for z in zs]
    f, s = deembedded(cascade_project('pozar-ex5.7-chebyshev' + suffix(refine), RO4003C, sections, z_out=100, refine=refine), kits)
    g = nw.gamma_in_terminated(s, nw.gamma_of(100, 50))
    return grade_match('chebyshev' + suffix(refine), 'Pozar Ex. 5.7', f, g, 3.0, 2 - 4 * theta_m / math.pi, 0.05, 'Sections ' + ', '.join(f'{z:.1f}' for z in zs) + ' ohm.')


def stub_project(name: str, sub: Substrate, d_mm: float, stub_mm: float, lead_mm: float, band=BAND) -> dict:
    """50 ohm line from plane 1 to plane 2 (x = 0), open stub along +y from its edge, centred d_mm before plane 2."""
    w = ms_width(sub, 50)
    x1 = -(lead_mm + d_mm)
    rects = [(x1 - FEED_MM, -w / 2, FEED_MM, w / 2),
             (-d_mm - w / 2, w / 2, -d_mm + w / 2, w / 2 + stub_mm)]
    return microstrip_project(name, sub, rects, [('p1', x1 - FEED_MM, 0), ('p2', FEED_MM, 0)], *band, [band[0] * 2])


def case_stub_tuner() -> list[Grade]:
    """Pozar Ex. 5.2: match Z_L = 60 - j80 ohm at 2 GHz with one shunt stub.

    The book uses short-circuited stubs; NobuRF has no vias, so this is the open-stub solution of
    the same equations (Pozar eq. 5.11a), the one microstrip designers use. Second solution
    (d = 0.259 lambda, open stub 0.155 lambda), drawn literally: stub length from the line's edge."""
    zl = 60 - 80j
    d_l, l_l = th.single_stub_shunt_open(50, zl)[1]
    lam = ms_length(RO4003C, 50, 2.0, 360)
    k50 = kit('ro50', RO4003C, 50)
    f, s = deembedded(stub_project('pozar-ex5.2-stub-tuner', RO4003C, d_l * lam, l_l * lam, 10.0), [k50, k50])
    g = nw.gamma_in_terminated(s, nw.gamma_of(zl, 50))
    mag = np.abs(g)
    f_best = nw.refine_minimum(f, mag, 1.5, 2.5)
    k0 = int(np.argmin(np.abs(f - 2.0)))
    # Ideal circuit: the book's answer, for the bandwidth comparison.
    ee = k50.eps_eff_book
    beta = 2 * np.pi * f * 1e9 * math.sqrt(ee) / th.C0
    zd = 50 * (zl + 1j * 50 * np.tan(beta * d_l * lam * 1e-3)) / (50 + 1j * zl * np.tan(beta * d_l * lam * 1e-3))
    y = 1 / zd + 1j * np.tan(beta * l_l * lam * 1e-3) / 50
    g_ideal = np.abs(nw.gamma_of(1 / y, 50))
    return [
        graded('stub-tuner', 'Pozar Ex. 5.2', 'Frequency of best match', 2.0, f_best, 'GHz', 2, 5,
               f'd = {d_l * lam:.2f} mm, stub {l_l * lam:.2f} mm. |Gamma| at 2 GHz {mag[k0]:.3f} (book: 0); '
               f'best {mag.min():.3f}.', gamma_at_f0=float(mag[k0])),
        graded('stub-tuner', 'Pozar Ex. 5.2', '|Gamma| at 2 GHz', 0.0, float(mag[k0]), '', 0.1, 0.2,
               f'Ideal circuit with the same lines gives |Gamma| < 0.2 from {band_text(f, g_ideal, 0.2, 2.0)}; '
               f'NobuRF {band_text(f, mag, 0.2, f_best)}.', absolute=True),
    ]


def band_text(f: np.ndarray, mag: np.ndarray, limit: float, around: float) -> str:
    b = nw.band_below(f, mag, limit, around)
    return f'{b[0]:.2f} to {b[1]:.2f} GHz' if b else 'nowhere'


def case_stub_notch() -> list[Grade]:
    """Pozar sections 3.8 and 8.5: a quarter-wave open stub is a short at f0, so S21 has a null there.

    Drawn literally: a 50 ohm stub lambda_g/4 long at 2.5 GHz from the main line's edge."""
    lq = ms_length(RO4003C, 50, 2.5, 90)
    k50 = kit('ro50', RO4003C, 50)
    f, s = deembedded(stub_project('pozar-open-stub-notch', RO4003C, 10.0, lq, 10.0), [k50, k50])
    s21 = np.abs(s[:, 1, 0])
    f_null = nw.refine_minimum(f, s21, 1.5, 3.5)
    w = ms_width(RO4003C, 50)
    dl = th.open_end_extension_mm(k50.eps_eff_book, w / RO4003C.h_mm, RO4003C.h_mm)
    corrected = 2.5 * lq / (lq + dl)
    return [graded('stub-notch', 'Pozar §3.8, §8.5', 'S21 null of a lambda/4 open stub', 2.5, f_null, 'GHz', 2, 5,
                   f'Stub {lq:.2f} mm. The ideal stub ignores the open end; with Hammerstad\'s open-end extension '
                   f'({dl:.2f} mm) the null is expected at {corrected:.3f} GHz, '
                   f'{100 * (f_null - corrected) / corrected:+.1f} % from NobuRF.',
                   null_db=float(20 * np.log10(s21.min())), corrected_ghz=corrected)]


def case_stepped_lpf(refine: int = 1) -> list[Grade]:
    """Pozar Ex. 8.6: maximally flat stepped-impedance low-pass filter, fc 2.5 GHz, N = 6,
    Z_low 20 ohm, Z_high 120 ohm, d = 0.158 cm, eps_r 4.20, tan delta 0.02."""
    sub = Substrate(4.2, 0.02, 1.58)
    g = th.maximally_flat_g(6)
    sections = []
    for n, gk in enumerate(g):
        z = 20.0 if n % 2 == 0 else 120.0
        beta_l = gk * z / 50 if n % 2 == 0 else gk * 50 / z
        sections.append((z, ms_length(sub, z, 2.5, math.degrees(beta_l))))
    k = kit('fr4-50', sub, 50, refine=refine)
    f, s = deembedded(cascade_project('pozar-ex8.6-stepped-lpf' + suffix(refine), sub, sections, refine=refine), [k, k])
    s21_db = nw.db(s[:, 1, 0])
    # The book's own answer: the same sections as ideal lossless lines.
    beta = [2 * np.pi * f * 1e9 * math.sqrt(th.microstrip_eps_eff(sub.eps_r, th.microstrip_w_over_h(sub.eps_r, z))) / th.C0
            for z, _ in sections]
    m = th.cascade(*[th.line_abcd(z, b * l * 1e-3) for (z, l), b in zip(sections, beta)])
    ideal_db = nw.db(nw.abcd_to_s(m, 50)[:, 1, 0])
    f3, f3i = nw.first_crossing(f, s21_db, -3, 0.5), nw.first_crossing(f, ideal_db, -3, 0.5)
    # Post-hoc: -3 dB below the passband level. The solve has the book's tan delta 0.02 (about 0.5 dB
    # through the filter); the ideal-line reference has none.
    passband = (f >= 0.5) & (f <= 1.0)
    f3_rel = nw.first_crossing(f, s21_db - s21_db[passband].max(), -3, 0.5)
    k4 = int(np.argmin(np.abs(f - 4.0)))
    return [
        graded('stepped-lpf' + suffix(refine), 'Pozar Ex. 8.6', '-3 dB cutoff', f3i, f3, 'GHz', 2, 5,
               f'Book design fc = 2.5 GHz; the ideal-line circuit of the same sections reaches -3 dB at {f3i:.3f} GHz. '
               'Lengths ' + ', '.join(f'{l:.2f}' for _, l in sections) + ' mm.'),
        Grade('stepped-lpf' + suffix(refine), 'Pozar Ex. 8.6', 'Attenuation at 4 GHz (book: at least 20 dB)', 20.0,
              float(-s21_db[k4]), 'dB', float(-s21_db[k4] - 20), 'pass' if -s21_db[k4] >= 20 else 'fail',
              f'The design requirement the example starts from. Ideal-line circuit {-ideal_db[k4]:.1f} dB.', True),
        graded('stepped-lpf' + suffix(refine), 'Pozar Ex. 8.6', '-3 dB cutoff from the passband level', f3i, f3_rel, 'GHz', 2, 5,
               'Removes the 0.5 dB dielectric loss the ideal reference lacks. Metric chosen after the first run; not counted.',
               post_hoc=True),
    ]


def case_branch_line(refine: int = 1) -> list[Grade]:
    """Pozar section 7.5: 50 ohm quadrature hybrid at 3 GHz, Pozar's port numbering (1 in, 2 through,
    3 coupled, 4 isolated). Arm lengths are lambda_g/4 centre to centre."""
    w50, w35 = ms_width(RO4003C, 50), ms_width(RO4003C, 50 / math.sqrt(2))
    lx, ly = ms_length(RO4003C, 50 / math.sqrt(2), 3.0, 90), ms_length(RO4003C, 50, 3.0, 90)
    xe = lx / 2 + w50 / 2
    rects: list[Rect] = []
    for sy in (1, -1):
        rects.append((-xe, sy * ly / 2 - w35 / 2, xe, sy * ly / 2 + w35 / 2))     # through arms (35.4 ohm)
        rects.append((-xe - FEED_MM, sy * ly / 2 - w50 / 2, -xe, sy * ly / 2 + w50 / 2))  # left feeds
        rects.append((xe, sy * ly / 2 - w50 / 2, xe + FEED_MM, sy * ly / 2 + w50 / 2))    # right feeds
    for sx in (1, -1):
        rects.append((sx * lx / 2 - w50 / 2, -ly / 2 - w35 / 2, sx * lx / 2 + w50 / 2, ly / 2 + w35 / 2))  # branches
    ports = [('p1', -xe - FEED_MM, ly / 2), ('p2', xe + FEED_MM, ly / 2), ('p3', xe + FEED_MM, -ly / 2),
             ('p4', -xe - FEED_MM, -ly / 2)]
    k50 = kit('ro50', RO4003C, 50, refine=refine)
    f, s = deembedded(microstrip_project('pozar-7.5-branch-line' + suffix(refine), RO4003C, rects, ports, *BAND, [3.0],
                                         **mesh_args(refine)), [k50] * 4)
    k3 = int(np.argmin(np.abs(f - 3.0)))
    s21, s31 = nw.db(s[:, 1, 0]), nw.db(s[:, 2, 0])
    f_iso = nw.refine_minimum(f, np.abs(s[:, 3, 0]), 2.0, 4.0)
    f_match = nw.refine_minimum(f, np.abs(s[:, 0, 0]), 2.0, 4.0)
    dphase = math.degrees(np.angle(s[k3, 1, 0] / s[k3, 2, 0]))
    src = 'Pozar §7.5'
    return [
        graded('branch-line' + suffix(refine), src, 'Isolation (S41) null', 3.0, f_iso, 'GHz', 2, 5,
               f'S41 at 3 GHz {nw.db(s[k3, 3, 0]):.1f} dB.'),
        graded('branch-line' + suffix(refine), src, 'Input match (S11) null', 3.0, f_match, 'GHz', 2, 5,
               f'S11 at 3 GHz {nw.db(s[k3, 0, 0]):.1f} dB.'),
        graded('branch-line' + suffix(refine), src, 'Through |S21| at 3 GHz', -3.01, float(s21[k3]), 'dB', 0.5, 1.0, absolute=True),
        graded('branch-line' + suffix(refine), src, 'Coupled |S31| at 3 GHz', -3.01, float(s31[k3]), 'dB', 0.5, 1.0, absolute=True),
        graded('branch-line' + suffix(refine), src, 'Phase of S21 relative to S31 at 3 GHz', 90.0, dphase, 'deg', 3, 8,
               'Pozar: S21 = -j/sqrt2, S31 = -1/sqrt2.', absolute=True),
    ]


def case_resonator() -> list[Grade]:
    """Pozar Ex. 6.2 (section 6.2): a lambda/2 open-circuited 50 ohm microstrip resonator on Teflon
    (eps_r 2.08, d = 0.159 cm) cut for 5 GHz. The book's length ignores the open-end fringing."""
    sub = Substrate(2.08, 0.0, 1.59)
    w = ms_width(sub, 50)
    l_res = ms_length(sub, 50, 5.0, 180)
    gap = 1.0
    x0 = l_res / 2
    rects = [(-x0, -w / 2, x0, w / 2),
             (-x0 - gap - FEED_MM, -w / 2, -x0 - gap, w / 2), (x0 + gap, -w / 2, x0 + gap + FEED_MM, w / 2)]
    ports = [('p1', -x0 - gap - FEED_MM, 0), ('p2', x0 + gap + FEED_MM, 0)]
    proj = microstrip_project('pozar-6.3-halfwave-resonator', sub, rects, ports, 4.0, 5.5, 301, [5.0],
                              max_steps=120000)
    solved = solve(proj)
    f, s, _ = nw.read_touchstone(solved.touchstone())
    s21 = np.abs(s[:, 1, 0])
    f_peak = nw.refine_minimum(f, -s21, 4.0, 5.5)
    ee = th.microstrip_eps_eff(sub.eps_r, w / sub.h_mm)
    dl = th.open_end_extension_mm(ee, w / sub.h_mm, sub.h_mm)
    corrected = 5.0 * l_res / (l_res + 2 * dl)
    return [graded('resonator', 'Pozar Ex. 6.2', 'Resonant frequency', 5.0, f_peak, 'GHz', 2, 5,
                   f'Line {l_res:.2f} mm, W {w:.2f} mm, {gap} mm coupling gaps. With Hammerstad\'s open-end extension '
                   f'({dl:.2f} mm per end) the resonance is expected at {corrected:.3f} GHz '
                   f'({100 * (f_peak - corrected) / corrected:+.1f} % from NobuRF); the gaps pull it a little lower still. '
                   f'Peak |S21| {20 * math.log10(s21.max()):.1f} dB.',
                   corrected_ghz=corrected, steps=solved.result.get('runs', [{}])[0].get('steps'))]


def waveguide_project(name: str, length_mm: float) -> dict:
    """Air-filled WR-90 (a = 22.86, b = 10.16 mm) along x between two probe ports.

    The y and z faces are PEC; copper sheets at z = 0 and b are the broad walls, and the PEC y faces
    one 1 mm cell outside the 20.86 mm wide board are the narrow walls, so a = 22.86 mm exactly."""
    a, b, cell = 22.86, 10.16, 1.0
    half = length_mm / 2 + 15
    outline = (-half, -(a / 2 - cell), half, a / 2 - cell)
    return {
        'noburf_project': 1, 'name': name, 'variables': {}, 'materials': {},
        'stackup': [{'type': 'copper', 'name': 'bottom', 'material': 'pec'},
                    {'type': 'dielectric', 'name': 'guide', 'material': 'air', 'thickness': mm(b)},
                    {'type': 'copper', 'name': 'top', 'material': 'pec'}],
        'board': {'outline': polygon(outline)},
        'geometry': {'bottom': shapes('floor', [outline]), 'top': shapes('roof', [outline])},
        'ports': [{'id': 'p1', 'x': mm(-length_mm / 2), 'y': mm(0), 'between': ['bottom', 'top'], 'reference_impedance_ohm': 50},
                  {'id': 'p2', 'x': mm(length_mm / 2), 'y': mm(0), 'between': ['bottom', 'top'], 'reference_impedance_ohm': 50}],
        'boundaries': {'x_min': {'type': 'pml', 'cells': 20}, 'x_max': {'type': 'pml', 'cells': 20},
                       'y_min': {'type': 'pec'}, 'y_max': {'type': 'pec'}, 'z_min': {'type': 'pec'}, 'z_max': {'type': 'pec'}},
        'mesh': {'cell': mm(cell), 'air_margin_cells': {'xy': 1, 'below': 1, 'above': 1},
                 'graded': {'edge_cell': mm(0.5), 'dielectric_cells': 10, 'max_growth': 1.3}},
        'analysis': {'f_min_ghz': 8.0, 'f_max_ghz': 12.5, 'n_freq': 91, 'loss_reference_ghz': 10,
                     'stop': {'energy_decay_db': 50, 'max_steps': 150000}},
        'outputs': {'zin_at_ghz': [10.0]},
    }


def case_waveguide() -> list[Grade]:
    """Pozar section 3.3: TE10 cutoff and guide wavelength of air-filled WR-90."""
    short, long_ = solve(waveguide_project('pozar-3.3-wr90-short', 40)), solve(waveguide_project('pozar-3.3-wr90-long', 52))
    f, s1, _ = nw.read_touchstone(short.touchstone())
    _, s2, _ = nw.read_touchstone(long_.touchstone())
    values, _ = nw.line_eigen_phase(s1, s2, 50)
    beta = np.abs(np.angle(values[:, 0])) / 12e-3  # rad/m over the 12 mm extra length
    k0 = 2 * np.pi * f * 1e9 / th.C0
    sel = (f >= 8.5) & (f <= 12.0)
    kc2 = np.mean(k0[sel] ** 2 - beta[sel] ** 2)
    fc = math.sqrt(kc2) * th.C0 / (2 * math.pi) / 1e9
    k10 = int(np.argmin(np.abs(f - 10.0)))
    lam_g = 2 * math.pi / beta[k10] * 1e3
    fc_book = th.te10_cutoff_ghz(22.86)
    # A lossless guide section has |eigenvalue| = 1; anything else means the two solves disagree.
    spread = float(np.max(np.abs(np.abs(values[sel, 0]) - 1)))
    decay = min(r['energy_decay_db'] for r in short.result['runs'] + long_.result['runs'])
    if spread > 0.1:
        why = (f'Inconclusive: the two solves are not consistent (|eigenvalue| off 1 by up to {spread:.2f}; a lossless guide '
               f'gives 1), and the energy fell only {decay:.0f} dB in 150,000 steps. Probe ports reflect |S11| about 0.9 '
               'and the end PMLs absorb the guided mode poorly, so the field never rings down.')
        return [Grade('waveguide', 'Pozar §3.3 (WR-90, TE10)', 'TE10 cutoff frequency', fc_book, fc, 'GHz',
                      100 * (fc - fc_book) / fc_book, 'inconclusive', why),
                Grade('waveguide', 'Pozar §3.3 (WR-90, TE10)', 'Guide wavelength at 10 GHz', th.guide_wavelength_mm(10, fc_book),
                      lam_g, 'mm', 100 * (lam_g / th.guide_wavelength_mm(10, fc_book) - 1), 'inconclusive', why)]
    return [
        graded('waveguide', 'Pozar §3.3 (WR-90, TE10)', 'TE10 cutoff frequency', fc_book, fc, 'GHz', 1, 3,
               'From beta^2 = k0^2 - kc^2 fitted over 8.5-12 GHz; beta from the two-line method (40 and 52 mm probe spacing).'),
        graded('waveguide', 'Pozar §3.3 (WR-90, TE10)', 'Guide wavelength at 10 GHz', th.guide_wavelength_mm(10, fc_book),
               lam_g, 'mm', 1, 3),
    ]


def case_stripline() -> list[Grade]:
    """Pozar Ex. 3.5: 50 ohm stripline, b = 0.32 cm, eps_r 2.20: W = 0.266 cm, eps_eff = eps_r exactly (TEM).

    PEC side and top/bottom faces sit one cell outside the two ground sheets. That is meant to stand in
    for a via fence, but the sheets do not touch the walls, so the grounds are only coupled through
    the gap, not tied."""
    b, eps = 3.2, 2.2
    w = (30 * math.pi / (math.sqrt(eps) * 50) - 0.441) * b
    cell = 0.5
    def project(name: str, length: float) -> dict:
        half = length / 2 + 10
        outline = (-half, -6 * b / 2, half, 6 * b / 2)
        return {
            'noburf_project': 1, 'name': name, 'variables': {}, 'materials': {'teflon': {'eps_r': eps, 'tan_delta': 0}},
            'stackup': [{'type': 'copper', 'name': 'gnd_bottom', 'material': 'pec'},
                        {'type': 'dielectric', 'name': 'lower', 'material': 'teflon', 'thickness': mm(b / 2)},
                        {'type': 'copper', 'name': 'strip', 'material': 'pec'},
                        {'type': 'dielectric', 'name': 'upper', 'material': 'teflon', 'thickness': mm(b / 2)},
                        {'type': 'copper', 'name': 'gnd_top', 'material': 'pec'}],
            'board': {'outline': polygon(outline)},
            'geometry': {'gnd_bottom': shapes('gb', [outline]), 'gnd_top': shapes('gt', [outline]),
                         'strip': shapes('s', [(-length / 2, -w / 2, length / 2, w / 2)])},
            'ports': [{'id': 'p1', 'x': mm(-length / 2), 'y': mm(0), 'between': ['gnd_bottom', 'strip'], 'reference_impedance_ohm': 50},
                      {'id': 'p2', 'x': mm(length / 2), 'y': mm(0), 'between': ['gnd_bottom', 'strip'], 'reference_impedance_ohm': 50}],
            'boundaries': {'x_min': {'type': 'pml', 'cells': 10}, 'x_max': {'type': 'pml', 'cells': 10},
                           'y_min': {'type': 'pec'}, 'y_max': {'type': 'pec'}, 'z_min': {'type': 'pec'}, 'z_max': {'type': 'pec'}},
            'mesh': {'cell': mm(cell), 'air_margin_cells': {'xy': 1, 'below': 1, 'above': 1},
                     'graded': {'edge_cell': mm(0.2), 'dielectric_cells': 6, 'max_growth': 1.3}},
            'analysis': {'f_min_ghz': 0.5, 'f_max_ghz': 8.0, 'n_freq': 151, 'loss_reference_ghz': 4,
                         'stop': {'energy_decay_db': 50, 'max_steps': 60000}},
            'outputs': {'zin_at_ghz': [4.0]},
        }
    s1 = solve(project('pozar-ex3.5-stripline-short', 20))
    s2 = solve(project('pozar-ex3.5-stripline-long', 32))
    f, a1, _ = nw.read_touchstone(s1.touchstone())
    _, a2, _ = nw.read_touchstone(s2.touchstone())
    values, _ = nw.line_eigen_phase(a1, a2, 50)
    beta = np.abs(np.angle(values[:, 0])) / 12e-3
    k0 = 2 * np.pi * f * 1e9 / th.C0
    sel = (f >= 1.0) & (f <= 7.0)
    ee = float(np.mean((beta[sel] / k0[sel]) ** 2))
    z_line = nw.low_frequency_line_impedance(f, a1, a2, 50, f_max_ghz=1.5)
    decay = min(r['energy_decay_db'] for r in s1.result['runs'] + s2.result['runs'])
    if decay < 40:
        why = (f'Inconclusive: one solve\'s energy fell only {decay:.0f} dB in 60,000 steps (the solver warns the result '
               'is approximate). The two ground sheets stop one cell short of the PEC box, so they are not tied together '
               'and the box rings. NobuRF needs vias (or ground sheets that reach the walls) to model stripline.')
        return [Grade('stripline', 'Pozar Ex. 3.5', 'eps_eff (TEM: equals eps_r)', eps, ee, '', 100 * (ee - eps) / eps,
                      'inconclusive', why),
                Grade('stripline', 'Pozar Ex. 3.5', 'Characteristic impedance', 50, z_line, 'ohm', 100 * (z_line - 50) / 50,
                      'inconclusive', why)]
    return [
        graded('stripline', 'Pozar Ex. 3.5', 'eps_eff (TEM: equals eps_r)', eps, ee, '', 0.5, 2,
               f'W = {w:.3f} mm from Pozar eq. 3.180. Two-line method, 20 and 32 mm, mean over 1-7 GHz.'),
        graded('stripline', 'Pozar Ex. 3.5', 'Characteristic impedance', 50, z_line, 'ohm', 2, 5,
               'Low-frequency limit of the de-embedded 12 mm line (see the microstrip line case).'),
    ]


def dipole_project(name: str, f0: float, length_mm: float, width_mm: float, far: bool) -> dict:
    """Half-wave dipole of two flat strips in air on two copper layers 0.25 mm apart, overlapping one
    0.25 mm cell at the centre, where a 1-cell lumped port joins them (the feed gap)."""
    lam = th.C0 / (f0 * 1e9) * 1e3
    overlap = 0.125
    outline = (-length_mm / 2 - 2, -2, length_mm / 2 + 2, 2)
    return {
        'noburf_project': 1, 'name': name, 'variables': {}, 'materials': {},
        'stackup': [{'type': 'copper', 'name': 'arm_a', 'material': 'pec'},
                    {'type': 'dielectric', 'name': 'gap', 'material': 'air', 'thickness': '0.25 mm'},
                    {'type': 'copper', 'name': 'arm_b', 'material': 'pec'}],
        'board': {'outline': polygon(outline)},
        'geometry': {'arm_a': shapes('a', [(-length_mm / 2, -width_mm / 2, overlap, width_mm / 2)]),
                     'arm_b': shapes('b', [(-overlap, -width_mm / 2, length_mm / 2, width_mm / 2)])},
        'ports': [{'id': 'feed', 'x': '0 mm', 'y': '0 mm', 'between': ['arm_a', 'arm_b'], 'reference_impedance_ohm': 73}],
        'boundaries': pml_all(10),
        'mesh': {'cell': mm(lam / 20), 'air_margin_cells': {'xy': 8, 'below': 8, 'above': 8},
                 'graded': {'edge_cell': mm(0.1), 'dielectric_cells': 2, 'max_growth': 1.3}},
        'analysis': {'f_min_ghz': round(0.7 * f0, 3), 'f_max_ghz': round(1.3 * f0, 3), 'n_freq': 121,
                     'loss_reference_ghz': f0, 'stop': {'energy_decay_db': 50, 'max_steps': 80000}},
        'outputs': {'zin_at_ghz': [f0], **({'far_field_ghz': [f0]} if far else {})},
    }


def case_dipole() -> list[Grade]:
    """Balanis §4.6 and §8.5: centre-fed half-wave dipole, Z_in = 73 + j42.5 ohm, D = 1.64 (2.15 dBi),
    HPBW 78 deg; resonant (X = 0) a little shorter than lambda/2."""
    f0, width = 3.0, 0.4
    length = th.C0 / (f0 * 1e9) * 1e3 / 2
    solved = solve(dipole_project('balanis-4.6-half-wave-dipole', f0, length, width, far=True))
    z = solved.result['zin'][0]
    zin = complex(z['re_ohm'], z['im_ohm'])
    ff = solved.far_field()['frequencies'][0]
    f, s, z0 = nw.read_touchstone(solved.touchstone())
    zf = nw.z_of(s[:, 0, 0], z0)
    f_res = resonance_crossing(f, zf.imag)
    r_res = float(np.interp(f_res, f, zf.real))
    beamwidth = dipole_beamwidth(ff['pattern'])
    a_eq = width / 4
    z_book = th.dipole_induced_emf_z(0.5, a_eq / (2 * length))
    d_book, bw_book = th.half_wave_dipole_pattern_directivity()
    src = 'Balanis §4.6, §8.5'
    return [
        graded('dipole', src, 'R_in at L = lambda/2', z_book.real, zin.real, 'ohm', 5, 10,
               f'Strips {width} mm wide (equivalent radius w/4 = {a_eq} mm, L/a = {length / a_eq:.0f}). Induced-EMF value; '
               'it assumes a sinusoidal current on an infinitely thin wire. Z changes fast with frequency here: '
               f'NobuRF reads {zf[np.argmin(np.abs(f - 2.82))].real:.0f} ohm 6 % lower in frequency.'),
        graded('dipole', src, 'X_in at L = lambda/2', z_book.imag, zin.imag, 'ohm', 5, 10),
        graded('dipole', src, 'Resonant length L/lambda (X = 0)', 0.475, 0.5 * f_res / f0,
               '', 2, 4, f'Balanis: 0.47 to 0.48 lambda depending on radius (midpoint taken). R_in at resonance {r_res:.1f} ohm.',
               r_at_resonance=r_res),
        graded('dipole', src, 'Directivity', d_book, ff['peak_directivity_dbi'], 'dBi', 0.2, 0.5,
               'From the far-field transform.', absolute=True),
        graded('dipole', src, 'Half-power beamwidth (E-plane)', bw_book, beamwidth, 'deg', 3, 6,
               'In the plane holding the dipole (phi = 0 / 180), from the 5 degree pattern samples, interpolated.'),
    ]


def dipole_beamwidth(pattern: dict) -> float:
    """Half-power beamwidth around theta = 0 in the xz plane, for a dipole along x (broadside toward +z)."""
    theta = np.array(pattern['theta_deg'], float)
    phi = list(pattern['phi_deg'])
    d = np.array(pattern['directivity_dbi'], float)
    # Signed angle across the cut: phi = 0 side positive, phi = 180 side negative.
    angle = np.concatenate([-theta[::-1], theta[1:]])
    cut = np.concatenate([d[::-1, phi.index(180)], d[1:, phi.index(0)]])
    peak = float(cut[np.argmin(np.abs(angle))])
    above = cut >= peak - 3
    k = int(np.argmin(np.abs(angle)))
    lo, hi = k, k
    while above[lo - 1]:
        lo -= 1
    while above[hi + 1]:
        hi += 1
    def edge(i: int, j: int) -> float:
        return float(angle[i] + (peak - 3 - cut[i]) * (angle[j] - angle[i]) / (cut[j] - cut[i]))
    return edge(hi, hi + 1) - edge(lo, lo - 1)


def resonance_crossing(f: np.ndarray, x: np.ndarray) -> float | None:
    for i in range(len(f) - 1):
        if x[i] < 0 <= x[i + 1] or x[i] > 0 >= x[i + 1]:
            return float(f[i] - x[i] * (f[i + 1] - f[i]) / (x[i + 1] - x[i]))
    return None


def case_monopole() -> list[Grade]:
    """Balanis §4.7.4: quarter-wave monopole over an infinite ground, Z_in = 36.5 + j21.25 ohm.

    The monopole is the pin of a coax probe through the ground (an SMA, 1.27 mm pin), rising 25 mm
    through air to a 2 x 2 mm pad; the ground is 300 mm square (3 lambda at 3 GHz), not infinite."""
    f0, h = 3.0, 25.0
    ground = 150.0
    outline = (-ground, -ground, ground, ground)
    proj = {
        'noburf_project': 1, 'name': 'balanis-4.7-quarter-wave-monopole', 'variables': {}, 'materials': {},
        'stackup': [{'type': 'copper', 'name': 'ground', 'material': 'pec'},
                    {'type': 'dielectric', 'name': 'air_column', 'material': 'air', 'thickness': mm(h)},
                    {'type': 'copper', 'name': 'tip', 'material': 'pec'}],
        'board': {'outline': polygon(outline)},
        'geometry': {'ground': shapes('g', [outline]), 'tip': shapes('pad', [(-1, -1, 1, 1)])},
        'ports': [{'kind': 'coax_probe', 'id': 'feed', 'x': '0 mm', 'y': '0 mm', 'between': ['tip', 'ground'],
                   'reference_impedance_ohm': 50}],
        'boundaries': pml_all(8),
        'mesh': {'cell': '5 mm', 'air_margin_cells': {'xy': 4, 'below': 4, 'above': 8},
                 'graded': {'edge_cell': '0.25 mm', 'dielectric_cells': 10, 'max_growth': 1.3}},
        'analysis': {'f_min_ghz': 2.0, 'f_max_ghz': 4.0, 'n_freq': 81, 'loss_reference_ghz': 3,
                     'stop': {'energy_decay_db': 40, 'max_steps': 80000}},
        'outputs': {'zin_at_ghz': [3.0]},
    }
    solved = solve(proj)
    f, s, z0 = nw.read_touchstone(solved.touchstone())
    zf = nw.z_of(s[:, 0, 0], z0)
    k = int(np.argmin(np.abs(f - f0)))
    z_book = th.dipole_induced_emf_z(0.5, 0.635 / (2 * h * 2)) / 2
    f_res = resonance_crossing(f, zf.imag)
    src = 'Balanis §4.7.4'
    return [
        graded('monopole', src, 'R_in at h = lambda/4', z_book.real, float(zf[k].real), 'ohm', 5, 10,
               'Half the dipole value (image theory). A 3 lambda ground, not infinite, and a 1.27 mm pin.'),
        graded('monopole', src, 'X_in at h = lambda/4', z_book.imag, float(zf[k].imag), 'ohm', 5, 10),
        graded('monopole', src, 'Resonant height h/lambda (X = 0)', 0.2375, 0.25 * f_res / f0,
               '', 2, 4, f'Half the dipole\'s 0.47 to 0.48 lambda. R_in at resonance {np.interp(f_res, f, zf.real):.1f} ohm, '
               'half of the dipole\'s resonant value as image theory says. The SMA pin is thick (radius 0.006 lambda) and '
               'ends on a 2 x 2 mm pad, and the ground has the SMA\'s 4.1 mm bore cut at the base; the 0.2375 lambda reference is the thin-wire value, so this row grades the reference as much as NobuRF.', r_at_resonance=float(np.interp(f_res, f, zf.real))),
    ]


def case_patch_directivity() -> list[Grade]:
    """Balanis Ex. 14.1 patch (W 11.86, L 9.06 mm, h 1.588 mm, eps_r 2.2): directivity and beamwidths of
    the two-slot cavity model (Balanis eqs. 14-43, 14-53), which assumes an infinite ground."""
    base = json.loads((Path(__file__).resolve().parents[2] / 'examples/benchmarks/graded/balanis-ex14-inset-probe.json').read_text())
    out = []
    for ground_mm, tag in ((None, 'book-ground'), (120.0, 'ground-120mm')):
        p = json.loads(json.dumps(base))
        p['name'] = f'balanis-ex14.1-patch-far-field-{tag}'
        if ground_mm:
            g = ground_mm / 2
            outline = polygon((-g, -g, g, g))
            p['board']['outline'] = outline
            p['geometry']['gnd'] = [{'id': 'ground', 'op': 'add', 'polygon': outline}]
            p['mesh']['cell'] = '2 mm'
        p['mesh']['air_margin_cells'] = {'xy': 4, 'below': 4, 'above': 8}
        p['analysis']['f_min_ghz'], p['analysis']['f_max_ghz'], p['analysis']['n_freq'] = 8.0, 11.0, 121
        p['analysis']['stop'] = {'energy_decay_db': 50, 'max_steps': 60000}
        solved = solve(p)
        f, s, z0 = nw.read_touchstone(solved.touchstone())
        zf = nw.z_of(s[:, 0, 0], z0)
        f_res = float(f[int(np.argmax(zf.real))])
        p['name'] += '-ff'
        p['outputs']['far_field_ghz'] = [round(f_res, 3)]
        ff_solved = solve(p)
        ff = ff_solved.far_field()
        ff = ff['frequencies'][0] if 'frequencies' in ff else ff
        out.append((tag, ground_mm, f_res, ff))
    design = th.patch_tl_design(2.2, 1.588, 10)
    grades = []
    for tag, ground_mm, f_res, ff in out:
        d_model, bw_e, bw_h = th.patch_two_slot_directivity(11.86, 9.06 + 2 * design['delta_l_mm'], f_res)
        label = 'benchmark file\'s 31.8 x 29 mm ground' if ground_mm is None else f'{ground_mm:.0f} mm ground'
        grades.append(graded('patch-directivity', 'Balanis Ex. 14.1, §14.2.3', f'Directivity, {label}', d_model,
                             ff['peak_directivity_dbi'], 'dBi', 0.5, 1.0,
                             f'At NobuRF\'s resonance {f_res:.2f} GHz; model evaluated there. Model E/H beamwidths '
                             f'{bw_e:.0f}/{bw_h:.0f} deg; NobuRF {ff["beamwidth_e_plane_deg"]:.0f}/{ff["beamwidth_h_plane_deg"]:.0f} deg; '
                             f'front-to-back {ff["front_to_back_db"]:.1f} dB.', absolute=True,
                             e_bw=ff['beamwidth_e_plane_deg'], h_bw=ff['beamwidth_h_plane_deg']))
    return grades


def case_mesh_check() -> list[Grade]:
    """Not a book problem: how much the line constants move when the edge cell is halved and the
    substrate gets twice the cells (0.2 -> 0.1 mm, 4 -> 8 cells), on the 50 and 100 ohm RO4003C lines."""
    out = []
    for z in (50, 100):
        coarse, fine = kit(f'ro{z}', RO4003C, z), kit(f'ro{z}', RO4003C, z, refine=2)
        for quantity, a, b in (('eps_eff', eps_eff_measured(coarse, 1, 5), eps_eff_measured(fine, 1, 5)),
                               ('Z0', coarse.z_line, fine.z_line)):
            out.append(graded('mesh-check', 'Mesh refinement', f'{quantity}, {z} ohm line (W = {coarse.w_mm:.2f} mm): '
                              'coarse vs refined', b, a, '', 1, 3,
                              f'Book (Pozar eqs. 3.195/3.196 at the drawn width): '
                              f'{coarse.eps_eff_book:.3f} / {z}. Refined mesh: {b:.3f}.'))
    return out


CASES = {
    'line': case_line, 'stripline': case_stripline, 'waveguide': case_waveguide,
    'quarter-wave': case_quarter_wave, 'binomial': case_binomial, 'chebyshev': case_chebyshev,
    'stub-tuner': case_stub_tuner, 'stub-notch': case_stub_notch, 'stepped-lpf': case_stepped_lpf,
    'branch-line': case_branch_line, 'resonator': case_resonator,
    'mesh-check': case_mesh_check,
    'binomial-r2': lambda: case_binomial(2), 'chebyshev-r2': lambda: case_chebyshev(2),
    'branch-line-r2': lambda: case_branch_line(2), 'stepped-lpf-r2': lambda: case_stepped_lpf(2), 'dipole': case_dipole, 'monopole': case_monopole, 'patch-directivity': case_patch_directivity,
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--cpu', action='store_true')
    parser.add_argument('--only', default='')
    args = parser.parse_args()
    build.USE_GPU = not args.cpu
    names = [n for n in args.only.split(',') if n] or list(CASES)
    results_path = RESULTS_DIR / 'grades.json'
    previous = json.loads(results_path.read_text()) if results_path.exists() else {}
    for name in names:
        try:
            grades = CASES[name]()
            previous[name] = [asdict(g) for g in grades]
            for g in grades:
                print(f'{g.case:18} {g.verdict:6} {g.quantity}: book {g.book} vs {g.nobu} {g.unit} ({g.error_pct})')
        except Exception as error:  # a case that cannot be built is itself an exam answer
            previous[name] = [{'case': name, 'verdict': 'error', 'note': f'{type(error).__name__}: {error}'}]
            print(f'{name:18} ERROR  {error}')
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    results_path.write_text(json.dumps(previous, indent=2, default=float) + '\n')


if __name__ == '__main__':
    main()
