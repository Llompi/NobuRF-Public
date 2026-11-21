export {};
/**
 * Plan test 3: POST /api/apply_edit from Node and check the browser returns
 * valid SimTelemetry fast enough. Needs `npm run dev` running and the page open
 * in a WebGPU browser.
 *   npm run roundtrip              # default edit, 500 ms budget
 *   npm run roundtrip -- 800       # custom budget in ms
 */
const base = process.env.BRIDGE_URL ?? `http://127.0.0.1:${process.env.BRIDGE_PORT ?? 8787}`;
const budgetMs = Number(process.argv[2] ?? 500);

async function post(path: string, body: unknown) {
  const t0 = performance.now();
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  return { status: r.status, body: j, ms: performance.now() - t0 };
}

const health = await (await fetch(base + '/api/health')).json();
if (!health.browser) {
  console.error('No browser connected. Start `npm run dev` and open http://localhost:5173 in Chrome/Edge.');
  process.exit(2);
}
console.log(`adapter: ${health.adapter}`);
await post('/api/reset', {}); // warm-up (shader compile, first allocations)
const edits = [{ inset_depth_mm: 3 }, { inset_depth_mm: 4 }, { patch_l_mm: 11.2 }];
let worst = 0;
for (const e of edits) {
  const r = await post('/api/apply_edit', e);
  const t = r.body;
  const valid = r.status === 200 && typeof t.s11_min_db === 'number' && Array.isArray(t.curve) && t.curve.length > 0;
  console.log(`${JSON.stringify(e)} -> ${r.status} in ${r.ms.toFixed(0)} ms (solver ${t.solve_ms} ms): S11min ${t.s11_min_db} dB @ ${t.f0_ghz} GHz${valid ? '' : '  INVALID'}`);
  if (!valid) process.exit(1);
  worst = Math.max(worst, r.ms);
}
await post('/api/reset', {});
console.log(worst < budgetMs ? `PASS worst ${worst.toFixed(0)} ms < ${budgetMs} ms` : `FAIL worst ${worst.toFixed(0)} ms >= ${budgetMs} ms`);
process.exit(worst < budgetMs ? 0 : 1);
