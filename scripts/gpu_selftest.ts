/**
 * Headless WebGPU self-test: starts Vite, opens /selftest.html in Chromium and
 * prints the results. In CI/cloud there is no GPU, so this uses SwiftShader
 * (a CPU Vulkan implementation): it proves the kernels are CORRECT, not fast.
 * Timing numbers from SwiftShader are meaningless; run `npm run dev` on a real
 * GPU and open /selftest.html for those.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';

const server = await createServer({ server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'],
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
});
let failed = true;
try {
  const page = await browser.newPage();
  page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
  await page.goto('http://localhost:5199/selftest.html');
  await page.waitForFunction(() => (window as unknown as { __selftest?: { done: boolean } }).__selftest?.done, null, {
    timeout: 15 * 60_000,
    polling: 1000,
  });
  const r = (await page.evaluate(() => (window as unknown as { __selftest: unknown }).__selftest)) as {
    checks: Array<{ name: string; pass: boolean; detail: string }>;
  };
  for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  failed = r.checks.some((c) => !c.pass);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
