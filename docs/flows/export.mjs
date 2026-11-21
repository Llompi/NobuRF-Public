// Renders each flow map to exports/<flow id>.png at 2x, for docs and launch posts.
//   node docs/flows/export.mjs
// Needs the playwright dev dependency (npm install at the repo root) and its Chromium.
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const FLOWS_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp' };

const server = createServer((request, response) => {
  const requestedPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filePath = path.join(FLOWS_DIRECTORY, requestedPath === '/' ? 'index.html' : requestedPath);
  if (!filePath.startsWith(FLOWS_DIRECTORY + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('open', () => response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream' }));
  stream.on('error', () => response.writeHead(404).end());
  stream.pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/`;

const { flows } = JSON.parse(await readFile(path.join(FLOWS_DIRECTORY, 'flows.json'), 'utf8'));
const browser = await chromium.launch();
try {
  for (const flow of flows) {
    const page = await browser.newPage({ deviceScaleFactor: 2, colorScheme: 'light' });
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.goto(`${baseUrl}?export=${flow.id}`);
    await page.waitForSelector('body[data-export-ready="true"], .fatal', { timeout: 20_000 });
    if (pageErrors.length) throw pageErrors[0];
    const size = await page.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
    await page.setViewportSize(size);
    const outputPath = path.join(FLOWS_DIRECTORY, 'exports', `${flow.id}.png`);
    await page.screenshot({ path: outputPath, fullPage: true });
    console.log(`${path.relative(process.cwd(), outputPath)}  ${size.width}×${size.height} at 2x`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
