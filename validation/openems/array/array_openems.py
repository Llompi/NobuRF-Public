"""openEMS's side of the array cross-check (README.md): one run per drive set with both
ports excited at once, writing results/<name>_openems.json.

The structure, mesh (ladder level 1) and lumped ports are refset/project_to_openems.py's.
Only the air margin (30 mm, so the near-to-far box clears the PML), the box itself
(10 mm outside the board) and the port amplitudes differ.

    /opt/oems/venv/bin/python validation/openems/array/array_openems.py validation/openems/array/dipole_pair.json
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'refset'))
from project_to_openems import END_CRITERIA_DB, PML_CELLS, level, mesh_lines, openems_version, read_structure  # noqa: E402

AIR_MARGIN_MM = 30.0
BOX_GAP_MM = 10.0
DRIVE_SETS = {'in_phase': [1.0, 1.0], 'antiphase': [1.0, -1.0]}
THETA_DEG = np.arange(0.0, 181.0, 5.0)
PHI_DEG = np.arange(0.0, 360.0, 5.0)


def run_drive_set(structure, far_field_hz: float, amplitudes: list[float], threads: int) -> dict:
    from CSXCAD import ContinuousStructure
    from openEMS import openEMS

    f_max = structure.f_ghz[-1] * 1e9
    fdtd = openEMS(NrTS=2_000_000, EndCriteria=10 ** (-END_CRITERIA_DB / 10))
    fdtd.SetGaussExcite(f_max / 2, f_max / 2)
    fdtd.SetBoundaryCond([f'PML_{PML_CELLS}'] * 6)
    csx = ContinuousStructure()
    fdtd.SetCSX(csx)
    grid = csx.GetGrid()
    grid.SetDeltaUnit(1e-3)
    lines = mesh_lines(structure, level(structure, 1))
    for axis in 'xyz':
        grid.SetLines(axis, lines[axis])

    for layer in structure.layers:
        if layer.kind != 'dielectric':
            continue
        if layer.tan_delta:
            raise ValueError(f'layer {layer.name}: the cross-check arrays are lossless')
        material = csx.AddMaterial(layer.name, epsilon=layer.eps_r)
        material.AddLinPoly(points=structure.outline.T, norm_dir='z', elevation=layer.z0, length=layer.z1 - layer.z0, priority=1)
    pec = csx.AddMetal('pec')
    layer_by_name = {layer.name: layer for layer in structure.layers}
    for layer_name, polygons in structure.copper.items():
        for polygon in polygons:
            pec.AddPolygon(points=polygon.T, norm_dir='z', elevation=layer_by_name[layer_name].z0, priority=10)
    ports = [fdtd.AddLumpedPort(n + 1, port.r_ohm, [port.x, port.y, port.z0], [port.x, port.y, port.z1], 'z', excite=amplitudes[n], priority=5)
             for n, port in enumerate(structure.ports)]

    board_lo = structure.outline.min(axis=0)
    board_hi = structure.outline.max(axis=0)
    z_bottom, z_top = structure.layers[0].z0, structure.layers[-1].z1
    nf2ff = fdtd.CreateNF2FFBox(start=[board_lo[0] - BOX_GAP_MM, board_lo[1] - BOX_GAP_MM, z_bottom - BOX_GAP_MM],
                                stop=[board_hi[0] + BOX_GAP_MM, board_hi[1] + BOX_GAP_MM, z_top + BOX_GAP_MM],
                                frequency=[far_field_hz])

    sim_path = tempfile.mkdtemp(prefix=f'oems_array_{structure.name}_')
    try:
        started = time.time()
        fdtd.Run(sim_path, cleanup=True, verbose=0, numThreads=threads)
        wall_s = time.time() - started
        active_reflection = []
        accepted_power_w = 0.0
        for port, spec in zip(ports, structure.ports):
            port.CalcPort(sim_path, [far_field_hz])
            gamma = complex(port.uf_ref[0] / port.uf_inc[0])
            active_reflection.append({'port': spec.pid, 're': gamma.real, 'im': gamma.imag})
            accepted_power_w += float(port.P_acc[0])
        center_m = [(board_lo[0] + board_hi[0]) / 2e3, (board_lo[1] + board_hi[1]) / 2e3, (z_bottom + z_top) / 2e3]
        far_field = nf2ff.CalcNF2FF(sim_path, far_field_hz, THETA_DEG, PHI_DEG, center=center_m)
    finally:
        shutil.rmtree(sim_path, ignore_errors=True)

    peak_directivity = float(far_field.Dmax[0])
    field_magnitude = np.asarray(far_field.E_norm[0])
    directivity_dbi = 10 * np.log10(peak_directivity) + 20 * np.log10(np.maximum(field_magnitude / field_magnitude.max(), 1e-15))
    peak_theta_index, peak_phi_index = np.unravel_index(np.argmax(field_magnitude), field_magnitude.shape)
    cells = int(np.prod([len(lines[axis]) - 1 for axis in 'xyz']))
    return {
        'peak_directivity_dbi': 10 * np.log10(peak_directivity),
        'peak_theta_deg': float(THETA_DEG[peak_theta_index]),
        'peak_phi_deg': float(PHI_DEG[peak_phi_index]),
        'radiation_efficiency': float(far_field.Prad[0]) / accepted_power_w,
        'active_reflection': active_reflection,
        'theta_deg': THETA_DEG.tolist(),
        'phi_deg': PHI_DEG.tolist(),
        'directivity_dbi': directivity_dbi.reshape(-1).tolist(),  # theta-major, as NobuRF's
        'cells': cells,
        'wall_s': round(wall_s, 1),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('project', type=Path)
    parser.add_argument('--threads', type=int, default=0)
    arguments = parser.parse_args()
    # openEMS runs in its simulation folder and then deletes it, so a relative path would not resolve after a run.
    project_path = arguments.project.resolve()
    project = json.loads(project_path.read_text())
    structure = read_structure(project)
    structure = dataclasses.replace(structure, margin_mm={'xy': AIR_MARGIN_MM, 'below': AIR_MARGIN_MM, 'above': AIR_MARGIN_MM})
    (far_field_ghz,) = project['outputs']['far_field_ghz']
    if len(structure.ports) != 2:
        raise ValueError(f'{project_path} has {len(structure.ports)} ports; the cross-check drives two')
    results = []
    for drive_set_name, amplitudes in DRIVE_SETS.items():
        result = run_drive_set(structure, far_field_ghz * 1e9, amplitudes, arguments.threads)
        results.append({'drive_set': drive_set_name, 'amplitudes': amplitudes, 'frequency_ghz': far_field_ghz, **result})
        print(drive_set_name, {k: v for k, v in result.items() if not isinstance(v, list)}, flush=True)
    output_directory = project_path.parent / 'results'
    output_directory.mkdir(exist_ok=True)
    output_path = output_directory / f'{project_path.stem}_openems.json'
    output_path.write_text(json.dumps({'solver': 'openEMS', 'openems_version': openems_version(), 'project': structure.name,
                                       'level': 1, 'air_margin_mm': AIR_MARGIN_MM, 'box_gap_mm': BOX_GAP_MM, 'results': results}, indent=1) + '\n')
    print(f'wrote {output_path}')


if __name__ == '__main__':
    main()
