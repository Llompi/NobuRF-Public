import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID } from '../src/engine/config';
import { applyEdit, baselineGeometry, EditError, isTopCopper } from '../src/engine/geometry';
import { voxelize } from '../src/engine/voxelize';

describe('geometry DSL', () => {
  it('applies a surgical edit without mutating the input', () => {
    const g = baselineGeometry();
    const n = applyEdit(g, { inset_depth_mm: 3.5 });
    expect(n.feed.inset_depth_mm).toBe(3.5);
    expect(g.feed.inset_depth_mm).toBe(0);
  });

  it('upserts and removes features by id', () => {
    let g = applyEdit(baselineGeometry(), { upsert_feature: { id: 'u1', kind: 'u_slot', x_mm: 0, y_mm: 1, w_mm: 6, h_mm: 5, t_mm: 0.5 } });
    expect(g.features).toHaveLength(1);
    g = applyEdit(g, { upsert_feature: { id: 'u1', kind: 'u_slot', x_mm: 0, y_mm: 1.5, w_mm: 6, h_mm: 5, t_mm: 0.5 } });
    expect(g.features).toHaveLength(1);
    expect(g.features[0].y_mm).toBe(1.5);
    g = applyEdit(g, { remove_feature_id: 'u1' });
    expect(g.features).toHaveLength(0);
  });

  it.each([
    [{}, /empty/],
    [{ inset_depth_mm: -1 }, /out of range/],
    [{ inset_depth_mm: Number.NaN }, /finite/],
    [{ inset_depth_mm: '3' }, /finite/],
    [{ inset_depth_mm: 9 }, /out of range/], // > 0.45 * L would split the patch
    [{ patch_l_mm: 30 }, /out of range/],
    [{ remove_feature_id: 'nope' }, /no feature/],
    [{ upsert_feature: { id: 'bad id!', kind: 'stub', x_mm: 0, y_mm: 0, w_mm: 1, h_mm: 1 } }, /feature.id/],
    [{ upsert_feature: { id: 'x', kind: 'circle', x_mm: 0, y_mm: 0, w_mm: 1, h_mm: 1 } }, /kind/],
    [{ drop_table: true }, /unknown field/],
  ])('rejects %j', (edit, re) => {
    expect(() => applyEdit(baselineGeometry(), edit as never)).toThrow(EditError);
    expect(() => applyEdit(baselineGeometry(), edit as never)).toThrow(re);
  });

  it('feed line stays connected even through a slot', () => {
    const g = applyEdit(baselineGeometry(), { inset_depth_mm: 3, upsert_feature: { id: 's', kind: 'rect_slot', x_mm: 0, y_mm: -4, w_mm: 6, h_mm: 1 } });
    // Slot covers the feed path; the feed must still be copper there.
    expect(isTopCopper(g, 0, -4)).toBe(true);
    expect(isTopCopper(g, 2.5, -4)).toBe(false);
  });

  it('chamfer removes two opposite corners only', () => {
    const g = applyEdit(baselineGeometry(), { corner_chamfer_mm: 2 });
    const W = g.patch.w_mm / 2 - 0.2, L = g.patch.l_mm / 2 - 0.2;
    expect(isTopCopper(g, W, L)).toBe(false);
    expect(isTopCopper(g, -W, -L)).toBe(false);
    expect(isTopCopper(g, -W, L)).toBe(true);
    expect(isTopCopper(g, W, -L)).toBe(true);
  });
});

describe('voxelizer', () => {
  const N = DEFAULT_GRID.nx * DEFAULT_GRID.ny * DEFAULT_GRID.nz;

  it('builds a port column across the substrate on the feed copper', () => {
    const m = voxelize(baselineGeometry(), DEFAULT_GRID);
    expect(m.ports[0].cells).toBe(3); // 1.5 mm / 0.5 mm
    expect(m.patchK).toBe(DEFAULT_GRID.groundK + 3);
    for (const ez of m.ports[0].ezIndex) expect(m.eCurl[ez]).toBe(0);
    expect(m.ports[0].ca).toBeGreaterThan(-1);
    expect(m.ports[0].ca).toBeLessThan(1);
  });

  it('copper zeroes only tangential E (zero-thickness sheets)', () => {
    const g = DEFAULT_GRID;
    const m = voxelize(baselineGeometry(), g);
    const c = g.nx / 2 + g.nx * (g.ny / 2 + g.ny * m.patchK); // patch centre, top layer
    expect(m.eCurl[c]).toBe(0);
    expect(m.eCurl[N + c]).toBe(0);
    expect(m.eCurl[2 * N + c]).toBeGreaterThan(0); // Ez above the patch is free
    const cg = g.nx / 2 + g.nx * (g.ny / 2 + g.ny * g.groundK);
    expect(m.eCurl[2 * N + cg]).toBeCloseTo(g.courant / 4.4, 6); // Ez just above ground is in FR-4
  });

  it('signature detects sub-cell edits as no-ops and real edits as changes', () => {
    const a = voxelize(baselineGeometry(), DEFAULT_GRID);
    const b = voxelize(applyEdit(baselineGeometry(), { patch_w_mm: 16.1 }), DEFAULT_GRID);
    const c = voxelize(applyEdit(baselineGeometry(), { inset_depth_mm: 3 }), DEFAULT_GRID);
    expect(b.signature).toBe(a.signature);
    expect(c.signature).not.toBe(a.signature);
  });

  it('refuses a ground plane that runs into the PML', () => {
    const g = baselineGeometry();
    g.ground.w_mm = 30;
    expect(() => voxelize(g, DEFAULT_GRID)).toThrow(/PML/);
  });

  it('refuses a feed narrower than one cell', () => {
    const g = baselineGeometry();
    g.feed.w_mm = 0.3;
    expect(() => voxelize(g, DEFAULT_GRID)).toThrow(/feed width/);
  });
});
