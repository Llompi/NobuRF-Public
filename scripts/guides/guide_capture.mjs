// Screenshots for the site's guide pages, one per step, page-only (never the desktop).
// Each shot gets a JSON file beside it with the on-page boxes of the controls the guide points at,
// so the annotation step can draw arrows and numbered callouts without guessing coordinates.
// usage: node guide_capture.mjs <out dir> [app url] [only: patch,line,pair,emissions,farfield]
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = process.argv[2] ?? 'shots';
const URL = process.argv[3] ?? 'https://noburf.com/app/';
const ONLY = process.argv[4] ? process.argv[4].split(',') : null;
const VIEW = { width: 1440, height: 1000 };
const SOLVE_TIMEOUT_MS = Number(process.env.SOLVE_TIMEOUT_MS ?? 30 * 60 * 1000);
mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(new Date().toISOString().slice(11, 19), s);

const useEdge = process.env.CHANNEL !== 'chromium';
const browser = await chromium.launch({
  ...(useEdge ? { channel: 'msedge' } : {}),
  headless: process.env.HEADED !== '1',
  args: ['--window-position=-4000,0', `--window-size=${VIEW.width + 40},${VIEW.height + 160}`, '--enable-unsafe-webgpu',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion'],
});
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 2, acceptDownloads: true, colorScheme: 'dark' });
const page = await context.newPage();
page.on('pageerror', (e) => log(`page error: ${e.message}`));
page.on('dialog', (d) => d.accept().catch(() => {})); // "discard unsaved changes?" when a new project replaces the last

/** Boxes of the named targets (first visible match of each selector), in CSS pixels of the viewport. */
async function boxes(targets) {
  const out = {};
  for (const [name, selector] of Object.entries(targets)) {
    const loc = page.locator(selector).locator('visible=true').first();
    const box = await loc.boundingBox({ timeout: 2000 }).catch(() => null);
    if (!box) log(`  no box for ${name}: ${selector}`);
    else out[name] = box;
  }
  return out;
}

const texts = {};
async function shot(name, targets = {}, textSelectors = {}) {
  await page.mouse.move(VIEW.width - 2, VIEW.height - 2); // no hover states, no pointer
  await page.evaluate(() => (document.activeElement)?.blur?.()).catch(() => {});
  await sleep(400);
  const rects = await boxes(targets);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  const t = {};
  for (const [k, sel] of Object.entries(textSelectors)) t[k] = await page.locator(sel).first().innerText({ timeout: 2000 }).catch(() => null);
  texts[name] = t;
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ viewport: VIEW, scale: 2, rects, texts: t }, null, 2));
  log(`shot ${name}`);
}

async function open() {
  await page.goto(URL);
  await page.waitForSelector('#new');
  await sleep(2000);
}

async function newProject(template, name, ghz, mm, substrateLabel) {
  await page.click('#new');
  await page.check(`input[name="new-template"][value="${template}"]`);
  await page.fill('#new-name', name);
  await page.fill('#new-frequency', String(ghz));
  await page.fill('#new-thickness', String(mm));
  const options = await page.$$eval('#new-substrate option', (os) => os.map((o) => ({ v: o.value, t: o.textContent })));
  const pick = options.find((o) => o.t.toLowerCase().startsWith(substrateLabel.toLowerCase()));
  if (!pick) throw new Error(`no substrate like ${substrateLabel}: ${options.map((o) => o.t).join(', ')}`);
  await page.selectOption('#new-substrate', pick.v);
  await sleep(300);
}

async function createFromDialog() {
  await page.click('#new-form button[type=submit]');
  await page.waitForSelector('#new-dialog:not([open])', { state: 'attached' });
  await sleep(1500);
}

async function openExample(file) {
  const value = await page.$eval('#examples', (s, f) => [...s.options].find((o) => o.textContent === f)?.value, file);
  if (!value) throw new Error(`no example ${file}`);
  await page.selectOption('#examples', value);
  await sleep(2000);
}

async function selectTree(key) {
  const group = page.locator('#tree details:has(button[data-key="' + key + '"])');
  if (await group.count()) await group.first().evaluate((d) => { d.open = true; });
  await page.click(`#tree button[data-key="${key}"]`);
  await sleep(600);
}

async function setField(label, value) {
  const input = page.locator(`#inspector [aria-label="${label}"]`).first();
  await input.fill(value);
  await input.press('Enter');
  await sleep(600);
}

/** Starts a solve, takes one shot partway through, and waits for it to finish. */
async function solve(progressShot) {
  if (process.env.SKIP_SOLVE === '1') return [];
  const t0 = Date.now();
  await page.click('#solve');
  let shotTaken = !progressShot;
  for (;;) {
    await sleep(1000);
    const solving = await page.evaluate(() => document.getElementById('validity')?.textContent === 'Solving');
    if (solving && !shotTaken && Date.now() - t0 > 4000) {
      await shot(progressShot, { progress: '#progress', stop: '#solve', status: '#validity' }, { progress: '#progress' });
      shotTaken = true;
    }
    if (!solving && Date.now() - t0 > 3000) break;
    if (Date.now() - t0 > SOLVE_TIMEOUT_MS) throw new Error('solve did not finish');
  }
  const first = await page.$$eval('#messages li', (items) => items.slice(0, 3).map((li) => li.textContent));
  log(`solved in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${first[0]}`);
  return first;
}

const SKIP = process.env.SKIP_SOLVE === '1';
async function openTab(name) {
  await page.click(`#tab-${name}`, SKIP ? { force: true, timeout: 2000 } : {}).catch((e) => { if (!SKIP) throw e; });
}

const facts = (id) => ({ facts: `#${id}` });
const want = (k) => !ONLY || ONLY.includes(k);

await open();

// ---------------------------------------------------------------- 2.4 GHz patch
if (want('patch')) {
  await newProject('patch', 'patch-2g4', 2.4, 1.6, 'FR-4');
  await shot('patch-01-new', {
    template: 'label:has(input[value="patch"])', frequency: '#new-frequency', thickness: '#new-thickness',
    substrate: '#new-substrate', size: '#new-board-w', create: '#new-form button[type=submit]', dialog: '#new-form',
  });
  await createFromDialog();
  await page.click('[data-camera="iso"]');
  await sleep(1500);
  await shot('patch-02-created', {
    canvas: '#model-canvas', variables: '#tree details:has(button[data-key^="variable"])', messages: '#messages', solve: '#solve', tree: '#tree',
  }, { messages: '#messages' });
  const m = await solve('patch-03-solving');
  await openTab('sparams');
  await sleep(2500);
  await shot('patch-04-s11', {
    tab: '#tab-sparams', chart: '#sparams-chart', facts: '#sparams-facts', touchstone: '[data-export="touchstone"]',
  }, { ...facts('sparams-facts'), messages: '#messages' });
  await selectTree('analysis');
  await setField('Far field at', '2.4');
  await shot('patch-05-farfield-setup', { field: '#inspector [aria-label="Far field at"]', inspector: '#inspector', tree: '#tree button[data-key="analysis"]' }, { inspector: '#inspector' });
  await selectTree('mesh');
  await setField('Air below', '4');
  await shot('patch-06-air-below', { field: '#inspector [aria-label="Air below"]', inspector: '#inspector', tree: '#tree button[data-key="mesh"]' }, { inspector: '#inspector' });
  await solve();
  await openTab('farfield');
  await sleep(3000);
  await shot('patch-07-farfield', { tab: '#tab-farfield', plot: '#farfield-plot', facts: '#farfield-facts' }, { ...facts('farfield-facts'), messages: '#messages' });
  await page.selectOption('#mesh-check-choice', { index: 1 });
  await sleep(500);
  await shot('patch-08-mesh-check', { meshcheck: '#mesh-check-choice', solve: '#solve' });
  await page.selectOption('#mesh-check-choice', { index: 0 });
  writeFileSync(`${OUT}/patch-messages.json`, JSON.stringify(m));
}

// ---------------------------------------------------------------- 50 ohm microstrip line, then its near-field scan
if (want('line')) {
  await newProject('line', 'line-5g', 5, 1.6, 'FR-4');
  await shot('line-01-new', {
    template: 'label:has(input[value="line"])', frequency: '#new-frequency', thickness: '#new-thickness',
    substrate: '#new-substrate', create: '#new-form button[type=submit]', dialog: '#new-form',
  });
  await createFromDialog();
  await page.click('[data-camera="iso"]');
  await sleep(1500);
  await shot('line-02-created', { canvas: '#model-canvas', ports: '#tree details:has(button[data-key^="port"])', solve: '#solve' }, { messages: '#messages' });
  await solve('line-03-solving');
  await openTab('line');
  await sleep(2500);
  await shot('line-04-line-tab', { tab: '#tab-line', chart: '#line-chart', facts: '#line-facts', notes: '#line-notes' }, { ...facts('line-facts'), notes: '#line-notes', messages: '#messages' });

  if (want('emissions')) {
    await selectTree('analysis');
    await setField('Near-field scan at', '1, 3');
    await shot('emis-01-setup', { field: '#inspector [aria-label="Near-field scan at"]', inspector: '#inspector', tree: '#tree button[data-key="analysis"]' }, { inspector: '#inspector' });
    await solve();
    await openTab('emissions');
    await sleep(3000);
    await shot('emis-02-near-field', {
      tab: '#tab-emissions', height: '#nf-height', frequency: '#nf-frequency', quantity: '#nf-quantity', drive: '#nf-drive',
      map: '#nf-map', facts: '#emissions-facts', notes: '#emissions-notes',
    }, { ...facts('emissions-facts'), notes: '#emissions-notes' });
  }
}

// ---------------------------------------------------------------- differential pair example
if (want('pair')) {
  await openExample('diff-pair-detour.json');
  await page.click('[data-camera="top"]');
  await sleep(1500);
  await shot('pair-01-example', { examples: '#examples', canvas: '#model-canvas', ports: '#tree details:has(button[data-key^="port"])' }, { messages: '#messages' });
  await solve('pair-02-solving');
  await openTab('pair');
  await sleep(3000);
  await shot('pair-03-differential', { tab: '#tab-pair', bar: '#pair-bar', schart: '#pair-s-chart', tdr: '#pair-tdr-chart', facts: '#pair-facts' }, { ...facts('pair-facts'), bar: '#pair-bar', notes: '#pair-notes', messages: '#messages' });
}

// ---------------------------------------------------------------- 5.8 GHz patch: field at a distance
if (want('farfield')) {
  await openExample('patch-5g8-far-field.json');
  await solve();
  await openTab('emissions');
  await sleep(3000);
  await shot('dist-01-emissions', { tab: '#tab-emissions', map: '#nf-map', facts: '#emissions-facts', notes: '#emissions-notes' }, { ...facts('emissions-facts'), notes: '#emissions-notes', messages: '#messages' });
}

writeFileSync(`${OUT}/texts.json`, JSON.stringify(texts, null, 2));
await browser.close();
log('done');
