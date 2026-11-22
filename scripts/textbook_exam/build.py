"""Builds NobuRF project files for the textbook exam and runs `noburf solve` on them.

Every problem is solved the way a user would: one project JSON per structure,
`npm run noburf -- solve <file> --gpu`, then the Touchstone / result.json it writes.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PROJECT_DIR = REPO / 'examples' / 'textbook'
RESULTS_DIR = REPO / 'docs' / 'textbook-exam' / 'results'

Rect = tuple[float, float, float, float]  # x0, y0, x1, y1 in mm


def mm(v: float) -> str:
    return f'{v:.4f} mm'


def polygon(r: Rect) -> list[list[str]]:
    x0, y0, x1, y1 = r
    return [[mm(x0), mm(y0)], [mm(x1), mm(y0)], [mm(x1), mm(y1)], [mm(x0), mm(y1)]]


def shapes(prefix: str, rects: list[Rect]) -> list[dict]:
    return [{'id': f'{prefix}{n + 1}', 'op': 'add', 'polygon': polygon(r)} for n, r in enumerate(rects)]


def pml_all(cells: int = 8) -> dict:
    return {face: {'type': 'pml', 'cells': cells} for face in ('x_min', 'x_max', 'y_min', 'y_max', 'z_min', 'z_max')}


@dataclass
class Substrate:
    eps_r: float
    tan_delta: float
    h_mm: float


def microstrip_project(name: str, sub: Substrate, traces: list[Rect], ports: list[tuple[str, float, float]],
                       f_min: float, f_max: float, n_freq: int, zin_at: list[float],
                       cell_mm: float = 1.0, edge_mm: float = 0.2, board_margin_mm: float = 6.0, dielectric_cells: int = 4,
                       far_field_ghz: list[float] | None = None, max_steps: int = 60000) -> dict:
    """Top copper `traces` over a full ground plane on one dielectric layer, lumped ports at (x, y)."""
    xs = [v for r in traces for v in (r[0], r[2])] + [p[1] for p in ports]
    ys = [v for r in traces for v in (r[1], r[3])] + [p[2] for p in ports]
    outline: Rect = (min(xs) - 2, min(ys) - board_margin_mm, max(xs) + 2, max(ys) + board_margin_mm)
    project = {
        'noburf_project': 1,
        'name': name,
        'variables': {},
        'materials': {'substrate': {'eps_r': sub.eps_r, 'tan_delta': sub.tan_delta}},
        'stackup': [
            {'type': 'copper', 'name': 'gnd', 'material': 'pec'},
            {'type': 'dielectric', 'name': 'core', 'material': 'substrate', 'thickness': mm(sub.h_mm)},
            {'type': 'copper', 'name': 'top', 'material': 'pec'},
        ],
        'board': {'outline': polygon(outline)},
        'geometry': {'gnd': shapes('ground', [outline]), 'top': shapes('trace', traces)},
        'ports': [{'id': pid, 'x': mm(x), 'y': mm(y), 'between': ['gnd', 'top'], 'reference_impedance_ohm': 50}
                  for pid, x, y in ports],
        'boundaries': pml_all(),
        'mesh': {
            'cell': mm(cell_mm),
            'air_margin_cells': {'xy': 4, 'below': 3, 'above': 12} if far_field_ghz is None
            else {'xy': 4, 'below': 4, 'above': 12},
            'graded': {'edge_cell': mm(edge_mm), 'dielectric_cells': dielectric_cells, 'max_growth': 1.3},
        },
        'analysis': {
            'f_min_ghz': f_min, 'f_max_ghz': f_max, 'n_freq': n_freq,
            'loss_reference_ghz': round((f_min + f_max) / 2, 3),
            'stop': {'energy_decay_db': 50, 'max_steps': max_steps},
        },
        'outputs': {'zin_at_ghz': zin_at},
    }
    if far_field_ghz:
        project['outputs']['far_field_ghz'] = far_field_ghz
    return project


@dataclass
class Solved:
    name: str
    out_dir: Path
    result: dict
    seconds: float

    def touchstone(self) -> Path:
        files = sorted(self.out_dir.glob('*.s*p'))
        if len(files) != 1:
            raise FileNotFoundError(f'{self.out_dir}: expected one Touchstone file, found {files}')
        return files[0]

    def far_field(self) -> dict:
        return json.loads((self.out_dir / 'far_field.json').read_text())


USE_GPU = True


def solve(project: dict) -> Solved:
    """Write examples/textbook/<name>.json and solve it, reusing a previous result for an identical file."""
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    name = project['name']
    path = PROJECT_DIR / f'{name}.json'
    text = json.dumps(project, indent=2) + '\n'
    path.write_text(text, newline='\n')  # LF on Windows too, so the file noburf hashes matches `sha`
    sha = hashlib.sha256(text.encode()).hexdigest()
    out_dir = RESULTS_DIR / name
    result_path = out_dir / 'result.json'
    if result_path.exists():
        previous = json.loads(result_path.read_text())
        if previous['provenance']['project_sha256'] == sha:
            return Solved(name, out_dir, previous, previous.get('solve_ms', 0) / 1e3)
    env = dict(os.environ, VK_ICD_FILENAMES='/opt/lavapipe/lvp_icd.json')
    env.pop('VK_DRIVER_FILES', None)
    # On Windows npm is npm.cmd, which subprocess does not find by its bare name.
    args = [shutil.which('npm') or 'npm', 'run', '-s', 'noburf', '--', 'solve', str(path), '--out', str(out_dir)] + (['--gpu'] if USE_GPU else ['--cpu'])
    start = time.time()
    run = subprocess.run(args, cwd=REPO, env=env, capture_output=True, text=True)
    if run.returncode:
        raise RuntimeError(f'{name}: noburf solve failed\n{run.stdout}\n{run.stderr}')
    result = json.loads(result_path.read_text())
    if result['provenance']['project_sha256'] != sha:
        raise RuntimeError(f'{name}: result.json hash does not match the project file just written')
    return Solved(name, out_dir, result, time.time() - start)
