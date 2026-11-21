"""The textbooks' own design formulas, so every reference value is recomputed
here rather than copied from memory.

Pozar = D. M. Pozar, Microwave Engineering, 4th ed., Wiley, 2012.
Balanis = C. A. Balanis, Antenna Theory: Analysis and Design, 4th ed., Wiley, 2016.
"""
from __future__ import annotations

import math

import numpy as np

C0 = 299_792_458.0
ETA0 = 376.730313668


# --- Microstrip, Pozar section 3.8 (eqs. 3.195 to 3.197) -------------------

def microstrip_eps_eff(eps_r: float, w_over_h: float) -> float:
    return (eps_r + 1) / 2 + (eps_r - 1) / 2 / math.sqrt(1 + 12 / w_over_h)


def microstrip_z0(eps_r: float, w_over_h: float) -> float:
    ee = microstrip_eps_eff(eps_r, w_over_h)
    if w_over_h <= 1:
        return 60 / math.sqrt(ee) * math.log(8 / w_over_h + w_over_h / 4)
    return 120 * math.pi / (math.sqrt(ee) * (w_over_h + 1.393 + 0.667 * math.log(w_over_h + 1.444)))


def microstrip_w_over_h(eps_r: float, z0: float) -> float:
    """Pozar eq. 3.197: the width a student would draw for a given Z0."""
    a = z0 / 60 * math.sqrt((eps_r + 1) / 2) + (eps_r - 1) / (eps_r + 1) * (0.23 + 0.11 / eps_r)
    b = 377 * math.pi / (2 * z0 * math.sqrt(eps_r))
    narrow = 8 * math.exp(a) / (math.exp(2 * a) - 2)
    if narrow < 2:
        return narrow
    return 2 / math.pi * (b - 1 - math.log(2 * b - 1) + (eps_r - 1) / (2 * eps_r) * (math.log(b - 1) + 0.39 - 0.61 / eps_r))


def guided_length_mm(eps_eff: float, f_ghz: float, electrical_deg: float) -> float:
    """Physical length for an electrical length at f: l = theta / (k0 sqrt(eps_eff))."""
    k0 = 2 * math.pi * f_ghz * 1e9 / C0
    return math.radians(electrical_deg) / (k0 * math.sqrt(eps_eff)) * 1e3


def open_end_extension_mm(eps_eff: float, w_over_h: float, h_mm: float) -> float:
    """Hammerstad's open-end length extension (Hammerstad 1975, as given in Gupta et al., Microstrip Lines and Slotlines).

    dl / h = 0.412 (ee + 0.3)(W/h + 0.264) / ((ee - 0.258)(W/h + 0.8)).
    Not in Pozar's worked examples, which treat an open stub as ideal.
    """
    return h_mm * 0.412 * (eps_eff + 0.3) * (w_over_h + 0.264) / ((eps_eff - 0.258) * (w_over_h + 0.8))


# --- Ideal transmission-line circuits (Pozar ch. 2, 4) ----------------------

def line_abcd(z0: float, beta_l: np.ndarray) -> np.ndarray:
    c, s = np.cos(beta_l), np.sin(beta_l)
    return np.stack([np.stack([c + 0j, 1j * z0 * s], -1), np.stack([1j * s / z0, c + 0j], -1)], -2)



def cascade(*mats: np.ndarray) -> np.ndarray:
    out = mats[0]
    for m in mats[1:]:
        out = out @ m
    return out



# --- Matching, Pozar ch. 5 ---------------------------------------------------

def quarter_wave_bandwidth(z0: float, zl: float, gamma_max: float) -> float:
    """Pozar eq. 5.48: fractional bandwidth of a single quarter-wave transformer (TEM)."""
    arg = gamma_max / math.sqrt(1 - gamma_max ** 2) * 2 * math.sqrt(z0 * zl) / abs(zl - z0)
    return 2 - 4 / math.pi * math.acos(arg)


def binomial_impedances(z0: float, zl: float, n: int) -> list[float]:
    """Pozar eq. 5.58 (the ln approximation the book uses): ln Z(k+1)/Z(k) = 2^-N C(N,k) ln ZL/Z0."""
    zs = [z0]
    for k in range(n):
        zs.append(zs[-1] * math.exp(2 ** -n * math.comb(n, k) * math.log(zl / z0)))
    return zs[1:]


def binomial_bandwidth(z0: float, zl: float, n: int, gamma_max: float) -> float:
    """Pozar eq. 5.60."""
    a = 2 ** -n * (zl - z0) / (zl + z0)
    return 2 - 4 / math.pi * math.acos(0.5 * (gamma_max / abs(a)) ** (1 / n))


def chebyshev3_impedances(z0: float, zl: float, gamma_max: float) -> tuple[list[float], float]:
    """Pozar section 5.7 for N = 3: returns ([Z1, Z2, Z3], theta_m in rad).

    sec(theta_m) = cosh(acosh(|ln(ZL/Z0)| / (2 Gm)) / N); Gamma_0 = A sec^3 / 2,
    Gamma_1 = 3 A (sec^3 - sec) / 2, and small reflections ln(Z(n+1)/Z(n)) = 2 Gamma_n.
    """
    a_coeff = gamma_max
    sec = math.cosh(math.acosh(abs(math.log(zl / z0) / (2 * gamma_max))) / 3)
    g0 = a_coeff * sec ** 3 / 2
    g1 = 3 * a_coeff * (sec ** 3 - sec) / 2
    sign = 1 if zl > z0 else -1
    z1 = z0 * math.exp(2 * g0 * sign)
    z2 = z1 * math.exp(2 * g1 * sign)
    z3 = z2 * math.exp(2 * g1 * sign)
    return [z1, z2, z3], math.acos(1 / sec)


def single_stub_shunt_open(z0: float, zl: complex) -> list[tuple[float, float]]:
    """Pozar eqs. 5.9 to 5.13: [(d/lambda, l/lambda)] for an open-circuited shunt stub."""
    rl, xl = zl.real, zl.imag
    if abs(rl - z0) < 1e-12:
        ts = [-xl / (2 * z0)]
    else:
        root = math.sqrt(rl * ((z0 - rl) ** 2 + xl ** 2) / z0)
        ts = [(xl + root) / (rl - z0), (xl - root) / (rl - z0)]
    out = []
    for t in ts:
        d = math.atan(t) / (2 * math.pi)
        if d < 0:
            d += 0.5
        g = rl * (1 + t * t) / (rl ** 2 + (xl + z0 * t) ** 2)
        b = (rl ** 2 * t - (z0 - xl * t) * (xl + z0 * t)) / (z0 * (rl ** 2 + (xl + z0 * t) ** 2))
        # Open stub: B_stub = -B, Y0 tan(beta l) = -B.
        l_open = math.atan(-b * z0) / (2 * math.pi)
        if l_open < 0:
            l_open += 0.5
        out.append((d, l_open))
        assert abs(g * z0 - 1) < 1e-9, 'stub position does not give G = Y0'
    return out


# --- Filters, Pozar ch. 8 ----------------------------------------------------

def maximally_flat_g(n: int) -> list[float]:
    """Pozar eq. 8.62 / table 8.3: g_k = 2 sin((2k - 1) pi / 2N)."""
    return [2 * math.sin((2 * k - 1) * math.pi / (2 * n)) for k in range(1, n + 1)]


# --- Waveguide, Pozar section 3.3 -------------------------------------------

def te10_cutoff_ghz(a_mm: float, eps_r: float = 1.0) -> float:
    return C0 / (2 * a_mm * 1e-3 * math.sqrt(eps_r)) / 1e9


def guide_wavelength_mm(f_ghz: float, fc_ghz: float) -> float:
    lam0 = C0 / (f_ghz * 1e9) * 1e3
    return lam0 / math.sqrt(1 - (fc_ghz / f_ghz) ** 2)


# --- Dipole, Balanis ch. 4 and 8 --------------------------------------------

def _si(x: float, steps: int = 20000) -> float:
    t = np.linspace(1e-12, x, steps)
    return float(np.trapezoid(np.sin(t) / t, t))


def _cin(x: float, steps: int = 20000) -> float:
    t = np.linspace(1e-12, x, steps)
    return float(np.trapezoid((1 - np.cos(t)) / t, t))


def _ci(x: float) -> float:
    return 0.5772156649 + math.log(x) - _cin(x)


def dipole_induced_emf_z(l_over_lambda: float, a_over_lambda: float) -> complex:
    """Balanis eqs. 8-60a and 8-60b: input impedance of a centre-fed dipole, referred to the input
    (R_in = R_r / sin^2(kl/2), Balanis eq. 4-102). l is the total length."""
    kl = 2 * math.pi * l_over_lambda
    ka = 2 * math.pi * a_over_lambda
    eta = ETA0
    rr = eta / (2 * math.pi) * (
        0.5772156649 + math.log(kl) - _ci(kl)
        + 0.5 * math.sin(kl) * (_si(2 * kl) - 2 * _si(kl))
        + 0.5 * math.cos(kl) * (0.5772156649 + math.log(kl / 2) + _ci(2 * kl) - 2 * _ci(kl)))
    xm = eta / (4 * math.pi) * (
        2 * _si(kl) + math.cos(kl) * (2 * _si(kl) - _si(2 * kl))
        - math.sin(kl) * (2 * _ci(kl) - _ci(2 * kl) - _ci(2 * ka * ka / kl)))
    scale = 1 / math.sin(kl / 2) ** 2
    return complex(rr * scale, xm * scale)


def half_wave_dipole_pattern_directivity() -> tuple[float, float]:
    """(directivity dBi, half-power beamwidth deg) of the sinusoidal-current lambda/2 dipole, Balanis eq. 4-84."""
    theta = np.linspace(1e-6, np.pi - 1e-6, 200001)
    u = (np.cos(np.pi / 2 * np.cos(theta)) / np.sin(theta)) ** 2
    p = 2 * np.pi * np.trapezoid(u * np.sin(theta), theta)
    d = 4 * np.pi * u.max() / p
    above = theta[u >= u.max() / 2]
    return 10 * math.log10(d), math.degrees(above[-1] - above[0])


# --- Patch, Balanis section 14.2 --------------------------------------------

def patch_two_slot_directivity(w_mm: float, l_eff_mm: float, f_ghz: float) -> tuple[float, float, float]:
    """Directivity (dBi) and E/H-plane half-power beamwidths (deg) of Balanis's two-slot cavity model
    over an infinite ground: E_phi ~ sin(X)/X sin(theta) cos(k Le/2 sin(theta) sin(phi)) with
    X = k W/2 cos(theta) (Balanis eq. 14-43, slots along x of length W, separated along y by L_e)."""
    k = 2 * math.pi * f_ghz * 1e9 / C0
    w, le = w_mm * 1e-3, l_eff_mm * 1e-3
    theta = np.linspace(1e-6, np.pi / 2, 721)
    phi = np.linspace(0, 2 * np.pi, 1441)
    th, ph = np.meshgrid(theta, phi, indexing='ij')
    # Slots along x; theta from z, phi from x. Use the slot-coordinate form directly.
    x = k * w / 2 * np.sin(th) * np.cos(ph)
    sinc = np.where(np.abs(x) < 1e-9, 1.0, np.sin(x) / np.where(np.abs(x) < 1e-9, 1, x))
    # Element (magnetic line source along x over ground): field ~ sinc * sqrt(1 - sin^2 th cos^2 ph).
    element = sinc * np.sqrt(np.clip(1 - (np.sin(th) * np.cos(ph)) ** 2, 0, None))
    af = np.cos(k * le / 2 * np.sin(th) * np.sin(ph))
    u = (element * af) ** 2
    p = np.trapezoid(np.trapezoid(u * np.sin(th), phi, axis=1), theta)
    d = 4 * math.pi * u.max() / p
    # Principal planes: E-plane is the plane of the slot separation (phi = 90 deg, yz), H-plane xz.
    def beamwidth(phi_index: int) -> float:
        cut = u[:, phi_index]
        half = theta[cut >= cut.max() / 2]
        return 2 * math.degrees(half[-1])
    return 10 * math.log10(d), beamwidth(360), beamwidth(0)


def patch_tl_design(eps_r: float, h_mm: float, f_ghz: float) -> dict[str, float]:
    """Balanis eqs. 14-6, 14-1, 14-2, 14-7: W, eps_reff, delta L, L for a resonant patch."""
    lam0 = C0 / (f_ghz * 1e9) * 1e3
    w = lam0 / 2 * math.sqrt(2 / (eps_r + 1))
    ee = (eps_r + 1) / 2 + (eps_r - 1) / 2 / math.sqrt(1 + 12 * h_mm / w)
    dl = 0.412 * h_mm * (ee + 0.3) * (w / h_mm + 0.264) / ((ee - 0.258) * (w / h_mm + 0.8))
    l = lam0 / (2 * math.sqrt(ee)) - 2 * dl
    return {'w_mm': w, 'eps_reff': ee, 'delta_l_mm': dl, 'l_mm': l, 'l_eff_mm': l + 2 * dl}
