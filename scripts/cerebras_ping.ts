export {};
/**
 * Pre-kickoff environment check: does the Cerebras API answer from this machine?
 * Reads the key from the environment only. Before Saturday 10:00 AM PT only
 * public free-tier models work; the trial model is enabled at kickoff.
 *   CEREBRAS_API_KEY=... npm run cerebras:ping
 *   CEREBRAS_MODEL=moonshotai-kimi-k3.1-pro-trial npm run cerebras:ping   # from kickoff
 */
const key = process.env.CEREBRAS_API_KEY;
const baseUrl = process.env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai/v1';
const model = process.env.CEREBRAS_MODEL ?? 'llama3.1-8b';
if (!key) {
  console.error('Set CEREBRAS_API_KEY in your shell or .env (never commit it).');
  process.exit(2);
}

const models = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
if (!models.ok) {
  console.error(`GET /models -> ${models.status}: ${(await models.text()).slice(0, 300)}`);
  process.exit(1);
}
const ids: string[] = ((await models.json()).data ?? []).map((m: { id: string }) => m.id);
console.log(`models visible to this key: ${ids.join(', ') || '(none)'}`);
console.log(`trial model listed: ${ids.includes('moonshotai-kimi-k3.1-pro-trial') ? 'yes' : 'not yet (expected before kickoff)'}`);

const t0 = performance.now();
const r = await fetch(`${baseUrl}/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
    // Kimi K3.1 Pro always reasons (effort defaults to max); reasoning tokens count
    // against max_tokens, so a tiny budget returns empty content.
    max_tokens: 2000,
    ...(model.includes('kimi') ? { reasoning_effort: 'low' } : {}),
  }),
});
const ms = performance.now() - t0;
const body = await r.json();
if (!r.ok) {
  console.error(`chat/completions (${model}) -> ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  process.exit(1);
}
console.log(`${model}: "${body.choices?.[0]?.message?.content?.trim()}" in ${ms.toFixed(0)} ms, usage ${JSON.stringify(body.usage)}`);
