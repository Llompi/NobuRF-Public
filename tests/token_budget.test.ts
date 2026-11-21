import { describe, expect, it } from 'vitest';
import { applyEdit, baselineGeometry } from '../src/engine/geometry';
import type { PortSpectrum } from '../src/engine/port_dft';
import { buildTelemetry } from '../src/engine/telemetry';

function fakeSpectrum(): PortSpectrum {
  const n = 121;
  const f = new Float64Array(n), s = new Float64Array(n), zr = new Float64Array(n), zi = new Float64Array(n);
  for (let m = 0; m < n; m++) {
    f[m] = 4.5 + (3 * m) / (n - 1);
    s[m] = -1 - 24 * Math.exp(-(((f[m] - 5.62) / 0.08) ** 2));
    zr[m] = 50 + 10 * Math.sin(m);
    zi[m] = -20 + m;
  }
  return { fGHz: f, s11Db: s, zRe: zr, zIm: zi, residual: 0.05 };
}

describe('prompt token budget (plan test 4)', () => {
  it('telemetry + a busy geometry stay under 1,600 characters', () => {
    let g = baselineGeometry();
    g = applyEdit(g, { inset_depth_mm: 3.75, corner_chamfer_mm: 1.25 });
    g = applyEdit(g, { upsert_feature: { id: 'uslot1', kind: 'u_slot', x_mm: 0, y_mm: 1.5, w_mm: 6.5, h_mm: 5, t_mm: 0.5 } });
    g = applyEdit(g, { upsert_feature: { id: 'stub1', kind: 'stub', x_mm: 8.5, y_mm: 0, w_mm: 1, h_mm: 3 } });
    const t = buildTelemetry({ spec: fakeSpectrum(), targetGHz: 5.8, it: 17, solveMs: 182.4, steps: 3000 });
    const payload = JSON.stringify({ geometry: g, telemetry: t });
    expect(t.warn.length).toBeGreaterThan(0); // ringdown warning included in the budget
    expect(payload.length).toBeLessThan(1600);
  });

  it('telemetry is JSON-safe (no NaN/Infinity that would serialize as null)', () => {
    const t = buildTelemetry({ spec: fakeSpectrum(), targetGHz: 5.8, it: 1, solveMs: 1, steps: 1 });
    const back = JSON.parse(JSON.stringify(t));
    expect(back).toEqual(t);
  });
});
