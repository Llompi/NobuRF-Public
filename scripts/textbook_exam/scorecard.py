"""Prints the scorecard table of docs/textbook-exam.md from docs/textbook-exam/results/grades.json.

    python3 scripts/textbook_exam/scorecard.py
"""
from __future__ import annotations

import json
from pathlib import Path

GRADES = Path(__file__).resolve().parents[2] / 'docs' / 'textbook-exam' / 'results' / 'grades.json'
ORDER = ['line', 'stripline', 'waveguide', 'quarter-wave', 'binomial', 'chebyshev', 'stub-tuner',
         'stub-notch', 'resonator', 'stepped-lpf', 'branch-line', 'binomial-r2', 'chebyshev-r2', 'branch-line-r2', 'stepped-lpf-r2', 'dipole', 'monopole', 'patch-directivity']
VERDICT = {'pass': 'Pass', 'close': 'Close', 'fail': 'Fail', 'error': 'Could not run', 'inconclusive': 'Inconclusive'}


def number(v: float | None, unit: str) -> str:
    if v is None:
        return ''
    digits = 3 if abs(v) < 10 else 2 if abs(v) < 100 else 1
    text = f'{v:.{digits}f}'.rstrip('0').rstrip('.') if '.' in f'{v:.{digits}f}' else f'{v:.{digits}f}'
    return f'{text} {unit}'.strip()


def main() -> None:
    grades = json.loads(GRADES.read_text())
    print('| Problem | Quantity | Reference | NobuRF | Error | Verdict |')
    print('| --- | --- | --- | --- | --- | --- |')
    tally: dict[str, int] = {}
    for case in ORDER:
        for g in grades.get(case, []):
            if g['verdict'] == 'error':
                print(f"| {case} | | | | | Could not run: {g['note']} |")
                continue
            absolute = g.get('absolute', False)
            err = g['error_pct']
            err_text = (f'{err:+.2f} {g["unit"]}'.strip() if absolute else f'{err:+.1f} %') if err is not None else ''
            source = g['source'] + (' (refined mesh)' if case.endswith('-r2') else '')
            quantity = g['quantity'].replace('|', '\\|') + (' (chosen after the run, not counted)' if g.get('post_hoc') else '')
            print(f"| {source} | {quantity} | {number(g['book'], g['unit'])} | {number(g['nobu'], g['unit'])} "
                  f"| {err_text} | {VERDICT[g['verdict']]} |")
            if not case.endswith('-r2') and not g.get('post_hoc'):
                tally[g['verdict']] = tally.get(g['verdict'], 0) + 1
    print()
    print('Exam mesh, rows by verdict:', ', '.join(f'{VERDICT[v]} {n}' for v, n in tally.items()))


if __name__ == '__main__':
    main()
