export {};
/**
 * Environment check: does the Cerebras API answer this machine's key? Reads
 * the key from the environment or .env and lists the models it can see. It
 * sends no completion: the Cerebras key is spent only inside OpenClaw, under
 * the spend guard (docs/design-agent.md).
 *   npm run cerebras:ping
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const key = process.env.CEREBRAS_API_KEY;
const baseUrl = process.env.CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai/v1';
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
console.log(`Kimi K3.1 Pro listed: ${ids.includes('moonshotai-kimi-k3.1-pro-trial') ? 'yes' : 'no'}`);
