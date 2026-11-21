"""Independent check of NobuRF's mixed-mode conversion against scikit-rf.

    pip install scikit-rf
    python scripts/validate/mixed_mode_skrf.py <file.s4p> [--zdiff 90 --zcomm 30]

Ports in the file must be ordered P1, N1, P2, N2 (scikit-rf's se2gmm pairs
ports 0,1 and 2,3). The script runs `noburf pair` on the same file with
--at every frequency, rebuilds each mixed-mode term from the dB and degree
values NobuRF prints (rounded to 0.001 dB and 0.01 degree), and compares it
with Network.se2gmm. A pass means the two agree to that rounding: about
3e-4 of the term's magnitude.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import skrf

parser = argparse.ArgumentParser()
parser.add_argument('file')
parser.add_argument('--zdiff', type=float)
parser.add_argument('--zcomm', type=float)
args = parser.parse_args()

network = skrf.Network(args.file)
if network.nports != 4:
    sys.exit('expects a 4-port file')
f_ghz = network.f / 1e9
command = ['npm', 'run', '-s', 'noburf', '--', 'pair', args.file, '--pair', '1,2', '--pair', '3,4']
if args.zdiff:
    command += ['--zdiff', str(args.zdiff)]
if args.zcomm:
    command += ['--zcomm', str(args.zcomm)]
for f in f_ghz:
    command += ['--at', repr(float(f))]
repo = Path(__file__).resolve().parents[2]
ours = json.loads(subprocess.run(command, cwd=repo, check=True, capture_output=True, text=True, shell=sys.platform == 'win32').stdout)

z0 = float(np.real(network.z0[0, 0]))
zd = args.zdiff or 2 * z0
zc = args.zcomm or z0 / 2
mixed = network.copy()
mixed.se2gmm(p=2, z0_mm=np.tile(np.array([zd, zd, zc, zc], dtype=complex), (len(f_ghz), 1)))

index = {'d': 0, 'c': 2}
worst = 0.0
for term in ours['terms']:
    name = term['name']  # e.g. Scd21: common-mode out at pair 2, differential in at pair 1
    row = index[name[1]] + int(name[3]) - 1
    column = index[name[2]] + int(name[4]) - 1
    theirs = mixed.s[:, row, column]
    rebuilt = np.array([10 ** (a['db'] / 20) * np.exp(1j * np.radians(a['deg'])) for a in term['at']])
    error = np.abs(rebuilt - theirs) / np.maximum(np.abs(theirs), 1e-6)
    worst = max(worst, float(error.max()))
    print(f'{name}: largest difference {error.max():.1e} of |S| (at {f_ghz[error.argmax()]:.3f} GHz)')
print(f'worst {worst:.1e}; reference impedances {zd} ohm differential, {zc} ohm common')
sys.exit(0 if worst < 1e-3 else 1)
