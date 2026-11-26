"""Applies the pass limits in README.md to results/<name>_noburf.json and results/<name>_openems.json,
and writes results/summary.md.

    python3 validation/openems/array/compare.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ARRAYS = ['dipole_pair', 'patch_pair']
PEAK_DIRECTIVITY_LIMIT_DB = 0.5
PEAK_DIRECTION_LIMIT_DEG = 10.0
PATTERN_WINDOW_DB = 15.0
PATTERN_LIMIT_DB = 1.5
EFFICIENCY_LIMIT = 0.03
ACTIVE_REFLECTION_LIMIT = 0.1
CUT_PHI_DEG = [0.0, 90.0]


def unit_vector(theta_deg: float, phi_deg: float) -> np.ndarray:
    theta, phi = np.radians(theta_deg), np.radians(phi_deg)
    return np.array([np.sin(theta) * np.cos(phi), np.sin(theta) * np.sin(phi), np.cos(theta)])


def angle_between_deg(first: dict, second: dict) -> float:
    cosine = unit_vector(first['peak_theta_deg'], first['peak_phi_deg']) @ unit_vector(second['peak_theta_deg'], second['peak_phi_deg'])
    return float(np.degrees(np.arccos(np.clip(cosine, -1.0, 1.0))))


def pattern_grid(result: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    theta, phi = np.asarray(result['theta_deg']), np.asarray(result['phi_deg'])
    return theta, phi, np.asarray(result['directivity_dbi']).reshape(len(theta), len(phi))


def worst_cut_difference_db(noburf: dict, openems: dict) -> float:
    """Largest |D_noburf - D_openems| in the phi 0 and 90 cuts (each with its phi + 180 half), where both are within
    PATTERN_WINDOW_DB of their own peak."""
    theta_n, phi_n, d_n = pattern_grid(noburf)
    theta_o, phi_o, d_o = pattern_grid(openems)
    if not (np.allclose(theta_n, theta_o) and np.allclose(phi_n, phi_o)):
        raise ValueError('the two solvers wrote different angle grids')
    worst = 0.0
    for cut in CUT_PHI_DEG:
        for phi in (cut, cut + 180.0):
            q = int(np.argmin(np.abs(phi_n - phi)))
            if abs(phi_n[q] - phi) > 1e-9:
                raise ValueError(f'phi {phi} is not on the grid')
            keep = (d_n[:, q] >= noburf['peak_directivity_dbi'] - PATTERN_WINDOW_DB) & (d_o[:, q] >= openems['peak_directivity_dbi'] - PATTERN_WINDOW_DB)
            if keep.any():
                worst = max(worst, float(np.max(np.abs(d_n[keep, q] - d_o[keep, q]))))
    return worst


def reflection_magnitudes(result: dict) -> list[float]:
    return [abs(complex(port['re'], port['im'])) for port in result['active_reflection']]


def compare(name: str) -> list[str]:
    noburf = json.loads((HERE / 'results' / f'{name}_noburf.json').read_text())
    openems = json.loads((HERE / 'results' / f'{name}_openems.json').read_text())
    rows = []
    for noburf_result, openems_result in zip(noburf['results'], openems['results'], strict=True):
        if noburf_result['drive_set'] != openems_result['drive_set']:
            raise ValueError(f'{name}: drive sets out of order')
        checks = []
        difference = noburf_result['peak_directivity_dbi'] - openems_result['peak_directivity_dbi']
        checks.append(('Peak directivity', f"{noburf_result['peak_directivity_dbi']:.2f} / {openems_result['peak_directivity_dbi']:.2f} dBi",
                       f'{difference:+.2f} dB', abs(difference) <= PEAK_DIRECTIVITY_LIMIT_DB))
        angle = angle_between_deg(noburf_result, openems_result)
        checks.append(('Peak direction (theta, phi)',
                       f"({noburf_result['peak_theta_deg']:g}, {noburf_result['peak_phi_deg']:g}) / ({openems_result['peak_theta_deg']:g}, {openems_result['peak_phi_deg']:g})",
                       f'{angle:.1f}°', angle <= PEAK_DIRECTION_LIMIT_DEG))
        worst = worst_cut_difference_db(noburf_result, openems_result)
        checks.append(('Pattern, phi 0° and 90° cuts', 'largest difference within 15 dB of peak', f'{worst:.2f} dB', worst <= PATTERN_LIMIT_DB))
        difference = noburf_result['radiation_efficiency'] - openems_result['radiation_efficiency']
        checks.append(('Radiation efficiency', f"{noburf_result['radiation_efficiency']:.3f} / {openems_result['radiation_efficiency']:.3f}",
                       f'{difference:+.3f}', abs(difference) <= EFFICIENCY_LIMIT))
        for k, (gamma_n, gamma_o) in enumerate(zip(reflection_magnitudes(noburf_result), reflection_magnitudes(openems_result), strict=True)):
            port = noburf_result['active_reflection'][k]['port']
            checks.append((f'Active reflection |b/a|, port {port}', f'{gamma_n:.3f} / {gamma_o:.3f}', f'{gamma_n - gamma_o:+.3f}',
                           abs(gamma_n - gamma_o) <= ACTIVE_REFLECTION_LIMIT))
        for quantity, values, difference_text, passed in checks:
            rows.append(f"| {name} | {noburf_result['drive_set'].replace('_', ' ')} | {quantity} | {values} | {difference_text} | {'pass' if passed else 'fail'} |")
    return rows


def main() -> None:
    lines = ['# Array far field against openEMS: results', '',
             'Values are NobuRF / openEMS. Limits are in README.md, set before the runs.', '',
             '| Array | Drives | Quantity | NobuRF / openEMS | Difference | Result |', '| --- | --- | --- | --- | --- | --- |']
    for name in ARRAYS:
        lines += compare(name)
    text = '\n'.join(lines) + '\n'
    (HERE / 'results' / 'summary.md').write_text(text)
    print(text)


if __name__ == '__main__':
    main()
