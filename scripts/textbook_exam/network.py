"""Network algebra for the textbook exam: Touchstone reading, S <-> ABCD,
2x-thru de-embedding, renormalisation and terminations.

Everything here is standard microwave network theory (Pozar, Microwave
Engineering, 4th ed., ch. 4). NobuRF supplies the S-parameters; this file only
does the arithmetic a student would do by hand or in a spreadsheet.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np


def read_touchstone(path: Path) -> tuple[np.ndarray, np.ndarray, float]:
    """Return (f_ghz[F], S[F, N, N], z0) from a NobuRF Touchstone v1 file (# GHz S RI R z0)."""
    n_ports = int(path.suffix[2:-1])
    numbers: list[float] = []
    z0 = 50.0
    for line in path.read_text().splitlines():
        line = line.split('!', 1)[0].strip()
        if not line:
            continue
        if line.startswith('#'):
            tokens = line.split()
            if tokens[1:4] != ['GHz', 'S', 'RI']:
                raise ValueError(f'{path}: expected "# GHz S RI R z0", got {line!r}')
            z0 = float(tokens[5])
            continue
        numbers.extend(float(t) for t in line.split())
    per_freq = 1 + 2 * n_ports * n_ports
    if len(numbers) % per_freq:
        raise ValueError(f'{path}: {len(numbers)} numbers is not a whole number of {per_freq}-number rows')
    rows = np.array(numbers).reshape(-1, per_freq)
    f_ghz = rows[:, 0]
    pairs = rows[:, 1:].reshape(-1, n_ports * n_ports, 2)
    s = (pairs[..., 0] + 1j * pairs[..., 1]).reshape(-1, n_ports, n_ports)
    if n_ports == 2:
        # Touchstone v1 two-port order is S11 S21 S12 S22 (column-major).
        s = np.transpose(s, (0, 2, 1))
    return f_ghz, s, z0


def s_to_abcd(s: np.ndarray, z0: float) -> np.ndarray:
    s11, s12, s21, s22 = s[:, 0, 0], s[:, 0, 1], s[:, 1, 0], s[:, 1, 1]
    d = 2 * s21
    a = ((1 + s11) * (1 - s22) + s12 * s21) / d
    b = z0 * ((1 + s11) * (1 + s22) - s12 * s21) / d
    c = ((1 - s11) * (1 - s22) - s12 * s21) / (z0 * d)
    dd = ((1 - s11) * (1 + s22) + s12 * s21) / d
    return np.stack([np.stack([a, b], -1), np.stack([c, dd], -1)], -2)


def abcd_to_s(m: np.ndarray, z0: float) -> np.ndarray:
    a, b, c, d = m[:, 0, 0], m[:, 0, 1], m[:, 1, 0], m[:, 1, 1]
    den = a + b / z0 + c * z0 + d
    s11 = (a + b / z0 - c * z0 - d) / den
    s12 = 2 * (a * d - b * c) / den
    s21 = 2 / den
    s22 = (-a + b / z0 - c * z0 + d) / den
    return np.stack([np.stack([s11, s12], -1), np.stack([s21, s22], -1)], -2)


def half_thru_phase(thru_s: np.ndarray) -> np.ndarray:
    """Electrical length of half the thru, theta = -unwrap(angle S21) / 2 (radians, per frequency).

    Assumes the sweep starts where the thru is electrically short (theta < pi/2) and that S21's phase
    moves by less than pi per frequency step; unwrap has no other anchor.
    """
    return -np.unwrap(np.angle(thru_s[:, 1, 0])) / 2


def error_box_sign(a: np.ndarray, b: np.ndarray, theta: np.ndarray, z0: float) -> np.ndarray:
    """+1 or -1 per frequency: the sign of (a, b) nearer an ideal line, a = cos theta, b = jZ sin theta.

    A sqrt fixes the box only up to sign. Following a by continuity fails where a passes near zero
    (a feed near a quarter wavelength), which flips the de-embedded S21 by 180 degrees. For an ideal
    line the projection is cos^2 theta + (Z/z0) sin^2 theta, positive for any Z. A measured half-thru
    can still give a projection near 0 near a quarter wavelength, where the symmetric-half model is
    poor (a^2 slightly negative); half_thru_abcd's only caller reads below 1.5 GHz, away from that.
    """
    projection = (a * np.cos(theta) + b / (1j * z0) * np.sin(theta)).real
    return np.where(projection < 0, -1.0, 1.0)


def half_thru_abcd(thru_s: np.ndarray, z0: float) -> np.ndarray:
    """ABCD of one half of a symmetric 2x-thru (port, feed line), taken as symmetric itself.

    thru = H . flip(H) with H = [[a, b], [c, a]] gives a^2 = (T11 + 1) / 2,
    b = T12 / 2a, c = T21 / 2a. The sign of (a, b) is the one nearer an ideal
    line of half the thru's electrical length (see error_box_sign).
    """
    t = s_to_abcd(thru_s, z0)
    t11 = (t[:, 0, 0] + t[:, 1, 1]) / 2
    a = np.sqrt((t11 + 1) / 2)
    a = a * error_box_sign(a, t[:, 0, 1] / (2 * a), half_thru_phase(thru_s), z0)
    b = t[:, 0, 1] / (2 * a)
    c = t[:, 1, 0] / (2 * a)
    return np.stack([np.stack([a, b], -1), np.stack([c, a], -1)], -2)


def deembed(measured_s: np.ndarray, half_abcd: np.ndarray, z0: float) -> np.ndarray:
    """Remove the same fixture half (external port -> DUT side) from every port of an N-port.

    With the fixture's own S-matrix F (port 1 external, port 2 toward the DUT)
    and M = (S_m - F11) F21^-1, the DUT is S = (F12 + M F22)^-1 M.
    """
    f = abcd_to_s(half_abcd, z0)
    n = measured_s.shape[1]
    eye = np.eye(n)
    out = np.empty_like(measured_s)
    for k in range(measured_s.shape[0]):
        f11, f12, f21, f22 = (f[k, i, j] * eye for i, j in ((0, 0), (0, 1), (1, 0), (1, 1)))
        m = (measured_s[k] - f11) @ np.linalg.inv(f21)
        out[k] = np.linalg.solve(f12 + m @ f22, m)
    return out


def gamma_in_terminated(s: np.ndarray, gamma_load: np.ndarray | complex) -> np.ndarray:
    """Input reflection of a 2-port whose port 2 is terminated in gamma_load (same reference)."""
    s11, s12, s21, s22 = s[:, 0, 0], s[:, 0, 1], s[:, 1, 0], s[:, 1, 1]
    return s11 + s12 * s21 * gamma_load / (1 - s22 * gamma_load)


def gamma_of(z: np.ndarray | complex, z_ref: float) -> np.ndarray | complex:
    return (z - z_ref) / (z + z_ref)


def z_of(gamma: np.ndarray, z_ref: float) -> np.ndarray:
    return z_ref * (1 + gamma) / (1 - gamma)



def db(x: np.ndarray) -> np.ndarray:
    return 20 * np.log10(np.abs(x))


def band_below(f: np.ndarray, value: np.ndarray, limit: float, around: float) -> tuple[float, float] | None:
    """The contiguous band containing `around` where value <= limit, edges interpolated; None if value(around) > limit."""
    k = int(np.argmin(np.abs(f - around)))
    if value[k] > limit:
        return None
    lo = k
    while lo > 0 and value[lo - 1] <= limit:
        lo -= 1
    hi = k
    while hi < len(f) - 1 and value[hi + 1] <= limit:
        hi += 1
    def cross(i: int, j: int) -> float:
        return float(f[i] + (limit - value[i]) * (f[j] - f[i]) / (value[j] - value[i]))
    f_lo = cross(lo - 1, lo) if lo > 0 else float(f[0])
    f_hi = cross(hi, hi + 1) if hi < len(f) - 1 else float(f[-1])
    return f_lo, f_hi


def first_crossing(f: np.ndarray, value: np.ndarray, level: float, start_ghz: float = 0.0) -> float | None:
    """First frequency above start_ghz where value falls through level, interpolated."""
    for i in range(len(f) - 1):
        if f[i] >= start_ghz and value[i] >= level > value[i + 1]:
            return float(f[i] + (level - value[i]) * (f[i + 1] - f[i]) / (value[i + 1] - value[i]))
    return None


def refine_minimum(f: np.ndarray, value: np.ndarray, lo: float, hi: float) -> float:
    """Frequency of the minimum of value inside [lo, hi], refined by a parabola through three samples."""
    idx = np.where((f >= lo) & (f <= hi))[0]
    k = idx[int(np.argmin(value[idx]))]
    if 0 < k < len(f) - 1:
        y0, y1, y2 = value[k - 1], value[k], value[k + 1]
        den = y0 - 2 * y1 + y2
        if den > 0:
            return float(f[k] + 0.5 * (y0 - y2) / den * (f[k + 1] - f[k]))
    return float(f[k])


def line_eigen_phase(thru_s: np.ndarray, line_s: np.ndarray, z0: float) -> tuple[np.ndarray, np.ndarray]:
    """Eigenvalues and eigenvectors of M_line M_thru^-1, whose eigenvalues are exp(+-gamma dL) of the
    extra line alone, whatever the ports and feeds do (the two-line method, Marks 1991)."""
    p = s_to_abcd(line_s, z0) @ np.linalg.inv(s_to_abcd(thru_s, z0))
    values, vectors = np.linalg.eig(p)
    return values, vectors


def thru_line_calibration(f_ghz: np.ndarray, thru_s: np.ndarray, lines: list[tuple[np.ndarray, float]],
                          eps_eff_guess: float, z_line: float, z0: float) -> tuple[np.ndarray, np.ndarray]:
    """Error box of one port (port -> feed -> mid-thru plane) from a mirror-symmetric thru and extra lines.

    The thru is A . flip(A); a line adds dL of uniform line between the halves, so M_line M_thru^-1 =
    A L A^-1 and its eigenvector for exp(+gamma dL) is A [Z_line, 1]^T. With det A = 1 that fixes A up
    to the line impedance, which no thru-line set can measure (Engen and Hoer 1979); it is passed in.
    Per frequency the line whose phase is nearest 90 degrees is used. Returns (A[F, 2, 2], gamma[F] per mm).
    """
    t = s_to_abcd(thru_s, z0)
    t11 = (t[:, 0, 0] + t[:, 1, 1]) / 2
    t12, t21 = t[:, 0, 1], t[:, 1, 0]
    k0_per_mm = 2 * np.pi * f_ghz * 1e9 / 299_792_458.0 * 1e-3
    out = np.empty((len(f_ghz), 2, 2), complex)
    gamma = np.empty(len(f_ghz), complex)
    theta = half_thru_phase(thru_s)
    for k in range(len(f_ghz)):
        expected = [k0_per_mm[k] * np.sqrt(eps_eff_guess) * dl for _, dl in lines]
        pick = int(np.argmin([abs((e % np.pi) - np.pi / 2) for e in expected]))
        line_s, dl = lines[pick]
        values, vectors = line_eigen_phase(thru_s[k:k + 1], line_s[k:k + 1], z0)
        values, vectors = values[0], vectors[0]
        # The exp(+gamma dL) eigenvalue is the one whose phase is nearest the expected +beta dL.
        miss = [abs(np.angle(np.exp(1j * (np.angle(v) - expected[pick])))) for v in values]
        plus = int(np.argmin(miss))
        rho = vectors[0, plus] / vectors[1, plus]
        a2 = (t11[k] + 1) * (t12[k] - rho * (t11[k] + 1)) / (2 * z_line * (rho * t21[k] - (t11[k] + 1)))
        a = np.sqrt(a2)
        a = a * error_box_sign(np.array([a]), np.array([t12[k] / (2 * a)]), theta[k:k + 1], z0)[0]
        d = (t11[k] + 1) / (2 * a)
        out[k] = [[a, t12[k] / (2 * a)], [t21[k] / (2 * d), d]]
        log_v = np.log(values[plus])
        turns = np.round((expected[pick] - log_v.imag) / (2 * np.pi))
        gamma[k] = (log_v + 2j * np.pi * turns) / dl
    return out, gamma


def low_frequency_line_impedance(f_ghz: np.ndarray, thru_s: np.ndarray, line_s: np.ndarray, z0: float,
                                 f_max_ghz: float) -> float:
    """Line impedance in the limit f -> 0, where the port's parasitics vanish: sqrt(B/C) of the line
    de-embedded with a symmetric half-thru, fitted as Z0 + c f^2 below f_max_ghz."""
    s = deembed(line_s, half_thru_abcd(thru_s, z0), z0)
    m = s_to_abcd(s, z0)
    z = np.sqrt(m[:, 0, 1] / m[:, 1, 0]).real
    sel = f_ghz <= f_max_ghz
    coeff = np.polyfit(f_ghz[sel] ** 2, z[sel], 1)
    return float(coeff[1])


def deembed_per_port(measured_s: np.ndarray, half_abcd_per_port: list[np.ndarray], z0: float) -> np.ndarray:
    """deembed() with its own fixture half (external port -> DUT side) at each port."""
    fixtures = [abcd_to_s(h, z0) for h in half_abcd_per_port]
    out = np.empty_like(measured_s)
    for k in range(measured_s.shape[0]):
        f11, f12, f21, f22 = (np.diag([fx[k, i, j] for fx in fixtures]) for i, j in ((0, 0), (0, 1), (1, 0), (1, 1)))
        m = (measured_s[k] - f11) @ np.linalg.inv(f21)
        out[k] = np.linalg.solve(f12 + m @ f22, m)
    return out
