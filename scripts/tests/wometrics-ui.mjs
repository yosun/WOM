// Isolated browser checks: no live worlds, app startup/resume, provider calls or mutations over HTTP.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '../..');
const data = await mkdtemp(path.join(os.tmpdir(), 'wometrics-ui-'));
process.env.WOM_DATA_DIR = data;
process.env.WOM_STORE = 'fs';
process.env.WOM_AUTH = 'off';
const { app } = await import('../../server/src/index.ts');
const { createWorld } = await import('../../server/src/store.ts');
const { setResolverForTests } = await import('../../server/src/access.ts');
const { DEFAULT_OPTIONS } = await import('../../server/src/config.ts');
const { chromium } = await import(pathToFileURL(path.resolve(root, process.env.PLAYWRIGHT_CORE ?? 'node_modules/playwright-core/index.mjs')).href);
const server = await new Promise((resolve) => {
  const instance = serve({ fetch: (request) => request.method === 'GET' ? app.fetch(request) : new Response('Read-only test', { status: 405 }), hostname: '127.0.0.1', port: 0 }, () => resolve(instance));
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const photo = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#ad8663' } }).jpeg().toBuffer();
  const worlds = [];
  for (const status of ['done', 'queued', 'partial', 'failed']) {
    const world = await createWorld({ options: { ...DEFAULT_OPTIONS, placementAgents: [] }, width: 640, height: 400, owner: { id: 'local' } });
    const scene = { version: 1, title: 'UI fixture', image: { url: `/files/${world.id}/source.jpg`, width: 640, height: 400 },
      camera: { fovY: 60, aspect: 1.6, up: [0, 1, 0], target: [0, 0, -3], source: 'moge' }, objects: [],
      lighting: { sky: '#fff', ground: '#888', sun: [0, 1, 0] }, diagnostics: [] };
    await writeFile(world.file('source.jpg'), photo);
    if (status === 'done' || status === 'partial') {
      await writeFile(world.file('scene.json'), JSON.stringify(scene));
      await writeFile(world.file('reprojection.jpg'), photo);
    }
    await world.update((m) => {
      m.title = `UI fixture · ${status}`;
      m.status = status;
      m.costs = [{ label: 'RAW_PRIVATE_COST_LABEL', usd: 1, provider: 'fixture' }];
      if (status === 'done' || status === 'partial') m.scene = { file: 'scene.json', version: 1 };
    });
    worlds.push(world);
  }
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const errors = [], mutations = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', (route) => {
    const request = route.request();
    if (request.method() !== 'GET') mutations.push(request.method());
    return request.method() === 'GET' && request.url().startsWith(origin + '/') ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const url = (world, suffix = '') => `${origin}/u/local/${world.id}/build${suffix}`;
  const selected = (label) => page.getByRole('tab', { name: label, exact: true }).getAttribute('aria-selected');
  for (const world of worlds) {
    await page.goto(url(world));
    await page.getByRole('region', { name: 'Current WOMPar score' }).waitFor();
    assert.equal(await selected('WOMetrics'), 'true', `${world.manifest.status} defaults to WOMetrics`);
    assert.equal(await page.getByRole('tabpanel', { name: 'WOMetrics', exact: true }).isVisible(), true);
    assert.equal(await page.locator(`#details-${world.id}`).isVisible(), false);
    assert.equal(await page.locator('.wm-par-number strong').innerText(), '0');
    assert.equal(await page.locator('.wm-par-entry strong').innerText(), 'Not ranked');
  }
  const world = worlds[0];
  await page.goto(url(world));
  await page.getByRole('region', { name: 'Current WOMPar score' }).waitFor();
  await mkdir(path.join(root, '.scratch'), { recursive: true });
  await page.screenshot({ path: path.join(root, '.scratch/wometrics-default.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Build Details', exact: true }).click();
  assert.equal(await page.locator(`#details-${world.id}`).isVisible(), true);
  assert.equal(await page.locator(`#metrics-${world.id}`).isVisible(), false);
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'build-details');
  await page.reload();
  await page.getByRole('tab', { name: 'Build Details', exact: true }).waitFor();
  assert.equal(await selected('Build Details'), 'true');
  await page.getByRole('tab', { name: 'Build Details', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await selected('WOMetrics'), 'true');
  assert.equal(new URL(page.url()).searchParams.has('tab'), false);
  await page.goto(url(world, '?refine=1'));
  await page.getByRole('tab', { name: 'Build Details', exact: true }).waitFor();
  assert.equal(await selected('Build Details'), 'true');
  await page.getByRole('tab', { name: 'WOMetrics', exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.has('refine'), false);
  await page.close();

  setResolverForTests(async () => ({ user: null, cookies: [] }));
  const shared = await context.newPage();
  shared.on('pageerror', (error) => errors.push(error.message));
  const privateRequests = [];
  shared.on('request', (request) => { if (/\/api\/worlds\/[^/]+\/(?:events|camera)$/.test(new URL(request.url()).pathname)) privateRequests.push(request.url()); });
  await shared.setViewportSize({ width: 390, height: 844 });
  await shared.goto(url(world));
  await shared.getByRole('region', { name: 'Current WOMPar score' }).waitFor();
  assert.equal(await shared.getByRole('tab', { name: 'Build Details', exact: true }).count(), 0);
  assert.equal(await shared.locator('.wm-par-number strong').innerText(), '0');
  assert.doesNotMatch(await shared.locator('body').innerText(), /RAW_PRIVATE_COST_LABEL/);
  assert.equal(await shared.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile has no horizontal page overflow');
  assert.deepEqual(privateRequests, []);
  assert.equal((await shared.request.get(`${origin}/api/wometrics/setup-schema`)).status(), 200);
  await shared.screenshot({ path: path.join(root, '.scratch/wometrics-mobile.png'), fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(mutations, []);
  console.log('Passed: default WOMetrics + Par, all generation states, separate/reloadable/keyboard tabs, Refine links, shared privacy, mobile layout and schema discovery. No provider calls.');
} finally {
  setResolverForTests(null);
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(data, { recursive: true, force: true });
}
