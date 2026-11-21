/**
 * Dry run of the race view with scripted edits and simulated model latency.
 * No model is called. The page shows a DRY RUN watermark and the lanes are
 * named "simulated", so a screenshot of this can't pass for a real result.
 *
 *   npm run dev            # then open http://localhost:5173/race.html
 *   npx tsx scripts/race_dry_run.ts [fastMs=600] [slowMs=4000]
 */
const BRIDGE = process.env.BRIDGE_URL ?? 'http://127.0.0.1:8787';
const fastMs = Number(process.argv[2] ?? 600);
const slowMs = Number(process.argv[3] ?? 4000);

const post = async (path: string, body: unknown) => {
  const r = await fetch(BRIDGE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error}`);
  return j;
};

const EDITS = [
  { inset_depth_mm: 2.5, reason: 'Edge-fed Re(Zin) far above 50 Ω: cut an inset notch' },
  { inset_depth_mm: 3.5, reason: 'Still resistive: deepen the inset' },
  { patch_l_mm: 11.6, reason: 'Dip sits 250 MHz low: shorten the patch' },
  { inset_depth_mm: 3, reason: 'Re-centre the match after the length change' },
  { upsert_feature: { id: 'trim', kind: 'rect_slot', x_mm: 0, y_mm: 5.75, w_mm: 16, h_mm: 0.3 }, reason: 'Fine-tune f0 with a 0.3 mm edge trim' },
];

async function lane(id: string, thinkMs: number, targetDb: number): Promise<void> {
  let last = 0;
  for (const e of EDITS) {
    await new Promise((r) => setTimeout(r, thinkMs));
    const t = await post(`/api/apply_edit?lane=${id}`, { ...e, llm_ms: thinkMs, tokens: Math.round(thinkMs / 4) });
    last = t.s11_at_target_db;
    console.log(`[${id}] #${t.it} S11@target ${last} dB (queue ${t.queue_ms} ms)`);
    if (last <= targetDb) break;
  }
  await post(`/api/race/finish?lane=${id}`, { status: last <= targetDb ? 'matched' : 'gave_up' });
}

const race = await post('/api/race/start', {
  lanes: [
    { id: 'fast', label: 'Scripted agent', provider: `Fast lane (simulated ${fastMs} ms)` },
    { id: 'slow', label: 'Scripted agent', provider: `Slow lane (simulated ${slowMs} ms)` },
  ],
  target_db: -15,
  dry_run: true,
});
console.log(`race started, baseline S11@target ${race.baseline.s11_at_target_db} dB`);
await Promise.all([lane('fast', fastMs, race.target_db), lane('slow', slowMs, race.target_db)]);
console.log('done');
export {};
