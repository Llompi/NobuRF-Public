import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCITATION, DEFAULT_GRID, FIXED_RUN } from '../src/engine/config';
import { CpuFdtd } from '../src/engine/fdtd_cpu';
import { applyEdit, baselineGeometry, textbookPatchF0GHz } from '../src/engine/geometry';
import { portSpectrum } from '../src/engine/port_dft';
import { buildTelemetry } from '../src/engine/telemetry';
import { voxelize } from '../src/engine/voxelize';

// Full 196k-cell solves on the CPU reference: ~15 s each. Skip with SKIP_SLOW=1.
const slow = process.env.SKIP_SLOW ? it.skip : it;

function solve(edit: object | null) {
  const g = edit ? applyEdit(baselineGeometry(), edit) : baselineGeometry();
  const m = voxelize(g, DEFAULT_GRID);
  const spec = portSpectrum(new CpuFdtd(m).run(DEFAULT_EXCITATION, FIXED_RUN), DEFAULT_EXCITATION);
  return { g, t: buildTelemetry({ spec, targetGHz: g.target_ghz, it: 0, solveMs: 0, steps: DEFAULT_GRID.stepsPerRun }) };
}

describe('patch physics (CPU reference, demo grid)', () => {
  slow('inset feed matches the patch and lands within 5 % of the textbook resonance', () => {
    const base = solve(null);
    const tuned = solve({ inset_depth_mm: 4 });
    // Baseline is deliberately mismatched; the inset is the textbook fix.
    expect(base.t.s11_min_db).toBeGreaterThan(-8);
    expect(tuned.t.s11_min_db).toBeLessThan(-15);
    const f0 = textbookPatchF0GHz(tuned.g);
    expect(Math.abs(tuned.t.f0_ghz - f0) / f0).toBeLessThan(0.05);
    expect(tuned.t.warn).toEqual([]); // ring-down completes within the step budget
  }, 120_000);
});
