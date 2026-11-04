// Production-bundle checks with an isolated, tiny 3D fixture. Only local GET requests are permitted.
// Run after npm run build; use PLAYWRIGHT_CORE to point to an external playwright-core installation.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '../..');
await mkdir(path.join(root, '.scratch/home-demo'), { recursive: true });
const data = await mkdtemp(path.join(os.tmpdir(), 'wom-home-demo-'));
process.env.WOM_DATA_DIR = data;
process.env.WOM_STORE = 'fs';
process.env.WOM_AUTH = 'off';
const { app } = await import('../../server/src/index.ts');
const { initialSteps } = await import('../../server/src/store.ts');
const { setResolverForTests } = await import('../../server/src/access.ts');
const { DEFAULT_OPTIONS } = await import('../../server/src/config.ts');
const { chromium } = await import(pathToFileURL(path.resolve(root, process.env.PLAYWRIGHT_CORE ?? 'node_modules/playwright-core/index.mjs')).href);
setResolverForTests(async () => ({ user: null, cookies: [] }));

const id = 'mvxixlbz34cbfb22';
const dir = path.join(data, 'worlds', id);
await mkdir(dir, { recursive: true });
const photo = await sharp(path.join(root, 'web/public/home/sunny-garden.webp')).jpeg().toBuffer();
const manifest = {
  id, title: 'Demo fixture', status: 'done', options: DEFAULT_OPTIONS, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  image: { file: 'source.jpg', thumb: 'source.jpg', width: 1200, height: 800 },
  steps: initialSteps(), objects: [], depth: {}, costs: [], scene: { file: 'scene.json', version: 1 },
};
// A real triangle mesh exercises asset loading and rendering without any model/provider calls.
const positions = new Float32Array([-2, -1, -3, 2, -1, -3, 0, 2, -3]);
const mesh = {
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength: positions.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}` }],
  bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-2, -1, -3], max: [2, 2, -3] }],
};
const scene = {
  version: 1, title: manifest.title, image: { url: `/files/${id}/source.jpg`, width: 1200, height: 800 },
  camera: { fovY: 60, aspect: 1.5, up: [0, 1, 0], target: [0, 0, -3], source: 'moge' },
  objects: [], relief: { url: `/files/${id}/relief.glb` }, lighting: { sky: '#fff', ground: '#888', sun: [0, 1, 0] }, diagnostics: [],
};
await Promise.all([
  writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest)),
  writeFile(path.join(dir, 'scene.json'), JSON.stringify(scene)),
  writeFile(path.join(dir, 'relief.glb'), JSON.stringify(mesh)),
  writeFile(path.join(dir, 'source.jpg'), photo),
]);
const server = await new Promise((resolve) => {
  const instance = serve({ fetch: (request) => request.method === 'GET' ? app.fetch(request) : new Response('Read-only test', { status: 405 }), hostname: '127.0.0.1', port: 0 }, () => resolve(instance));
});
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [], forbidden = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const makePage = async (options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
    const requests = [];
    await context.route('**/*', (route) => {
      const request = route.request();
      requests.push(new URL(request.url()).pathname);
      if (request.method() !== 'GET' || !request.url().startsWith(origin + '/')) {
        forbidden.push(`${request.method()} ${request.url()}`);
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(() => {
      window.__demoWebGLCalls = 0;
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (/^webgl|experimental-webgl/.test(type)) window.__demoWebGLCalls++;
        return original.call(this, type, ...args);
      };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).waitFor();
    return { page, context, requests };
  };
  const idle = async (page, requests) => {
    assert.equal(await page.locator('video, .viewer, .slide-cover, .world-loading').count(), 0);
    assert.equal(await page.evaluate(() => window.__demoWebGLCalls), 0);
    assert.deepEqual(requests.filter((url) => /\/api\/worlds|\/files\/|\.(?:mp4|wasm|spz|ply|glb|gltf|splat)$|\/(?:viewer|home-demo|world-loading|build|page|wom|web)-[^/]+\.(?:js|css)$/.test(url)), []);
  };
  const enterReadyWorld = async (page) => {
    await page.locator('.aperture.ready').waitFor({ timeout: 20_000 });
    await page.locator('.world-loading.is-ready').waitFor();
    assert.equal(await page.locator('.viewer.inside').count(), 0, 'Readiness never enters automatically');
    assert.equal(await page.locator('.world-firefly').count(), 0, 'The game stops when the world is ready');
    assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.closest?.('.world-loading')).length), 0);
    await page.getByRole('button', { name: 'Enter the world', exact: true }).click();
    await page.locator('.viewer.inside').waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('.world-loading').count(), 0, 'Entering disposes the game and loading UI');
  };

  // Idle is static; opting in loads the world, then a separate keyhole tap enters it.
  {
    const { page, context, requests } = await makePage();
    await idle(page, requests);
    // Even an owner entering from the homepage gets an exploration-only demo.
    await page.route(`**/api/worlds/${id}`, (route) => route.fulfill({ json: {
      manifest, access: { visibility: 'link', handle: null, canEdit: true }, running: false,
    } }));
    await page.getByRole('region', { name: 'How WOM measures AI worlds' }).waitFor();
    await page.screenshot({ path: path.join(root, '.scratch/home-demo/desktop.png'), fullPage: true });
    let releaseViewer, releaseAsset;
    const viewerGate = new Promise((resolve) => { releaseViewer = resolve; });
    const assetGate = new Promise((resolve) => { releaseAsset = resolve; });
    await page.route(/\/assets\/viewer-[^/]+\.js$/, async (route) => { await viewerGate; await route.continue(); });
    await page.route(`**/files/${id}/relief.glb`, async (route) => { await assetGate; await route.continue(); });
    const viewerRequest = page.waitForRequest((request) => /\/assets\/viewer-[^/]+\.js$/.test(new URL(request.url()).pathname));
    const assetRequest = page.waitForRequest((request) => request.url().endsWith('/relief.glb'));
    await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).click();
    await viewerRequest;
    await page.getByRole('button', { name: 'Catch firefly 1', exact: true }).press('Enter');
    assert.equal(await page.locator('.world-loading-count').innerText(), '1');
    assert.equal(await page.evaluate(() => window.__demoWebGLCalls), 0, 'The game does not create a GPU context');
    assert.equal(await page.getByRole('progressbar', { name: 'Loading the 3D world', exact: true }).getAttribute('value'), null);
    releaseViewer();
    await assetRequest;
    await page.locator('.viewer').waitFor();
    assert.equal(await page.locator('.world-loading').count(), 1, 'One game survives the homepage/viewer handoff');
    assert.equal(await page.locator('.world-loading-count').innerText(), '1');
    assert.ok(Number(await page.getByRole('progressbar', { name: 'Loading the 3D world', exact: true }).getAttribute('value')) < 100);
    await page.getByRole('button', { name: 'Catch firefly 2', exact: true }).press('Enter');
    assert.equal(await page.locator('.world-loading-count').innerText(), '2');
    await page.getByRole('button', { name: 'Hide fireflies', exact: true }).click();
    assert.equal(await page.getByRole('group', { name: 'Catch the fireflies' }).isVisible(), false);
    await page.getByRole('button', { name: 'Show fireflies', exact: true }).click();
    await page.screenshot({ path: path.join(root, '.scratch/home-demo/fireflies-desktop.png') });
    releaseAsset();
    await page.locator('.world-loading.is-ready').waitFor();
    assert.equal(await page.locator('.world-loading-bar').getAttribute('value'), '100');
    await page.waitForTimeout(2400); // Pass the former auto-entry deadline; the keyhole must still await a tap.
    assert.equal(await page.locator('.aperture.ready').count(), 1);
    assert.equal(await page.locator('.viewer.inside').count(), 0);
    await page.screenshot({ path: path.join(root, '.scratch/home-demo/portal-ready.png') });
    await enterReadyWorld(page);
    assert.equal(new URL(page.url()).searchParams.get('demo'), '1');
    assert.ok((await viewerRequest).url().includes('/assets/viewer-'));
    assert.ok(requests.includes(`/api/worlds/${id}/scene`));
    assert.equal(await page.locator('.slide-cover').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Capture this view', exact: true }).isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Open by link', exact: true }).isVisible(), false);
    await page.locator('.viewer-top a.back').click();
    await page.locator('.home').waitFor();
    assert.equal(await page.locator('.viewer, .slide-cover, .world-loading').count(), 0);
    await context.close();
  }

  // Failed on-demand code and unavailable WebGL both leave an accessible route home.
  for (const mode of ['module', 'webgl']) {
    const { page, context } = await makePage();
    if (mode === 'module') await page.route(/\/assets\/home-demo-[^/]+\.js$/, (route) => route.abort());
    else await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return /webgl/.test(type) ? null : original.call(this, type, ...args);
      };
    });
    await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).click();
    if (mode === 'module') await page.locator('.memory-error:not([hidden])').waitFor();
    else {
      await page.getByRole('heading', { name: 'This page could not open.' }).waitFor();
      assert.equal(await page.locator('.slide-cover').count(), 0);
      await page.getByRole('link', { name: 'Back to home', exact: true }).click();
      await page.locator('.home').waitFor();
    }
    await context.close();
  }

  // Leaving while a newly lazy route downloads must not let it replace the homepage later.
  {
    const { page, context } = await makePage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chunk = /\/assets\/build-[^/]+\.js$/;
    await page.route(chunk, async (route) => { await gate; await route.continue().catch(() => undefined); });
    const pending = page.waitForRequest((request) => chunk.test(new URL(request.url()).pathname));
    await page.getByRole('link', { name: 'Read the sample’s WOMetrics' }).click();
    await pending;
    await page.goBack();
    await page.locator('.home').waitFor();
    const arrived = page.waitForResponse((response) => chunk.test(new URL(response.url()).pathname));
    release();
    await arrived;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.home').count(), 1);
    assert.equal(await page.locator('.wometrics').count(), 0);
    await context.close();
  }

  // Cancel pending metadata, then retry with another click. No scene loads after cancellation.
  {
    const { page, context, requests } = await makePage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const endpoint = `**/api/worlds/${id}`;
    await page.route(endpoint, async (route) => { await gate; await route.continue().catch(() => undefined); });
    const pending = page.waitForRequest((request) => request.url().endsWith(`/api/worlds/${id}`));
    await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).click();
    await pending;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    release();
    await page.unroute(endpoint);
    assert.equal(await page.locator('.memory-stage').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('.viewer, .slide-cover, .world-loading').count(), 0);
    assert.equal(await page.evaluate(() => window.__demoWebGLCalls), 0);
    assert.equal(requests.some((url) => /\/scene$/.test(url)), false);
    await page.getByRole('button', { name: 'Try the interactive world', exact: true }).click();
    await enterReadyWorld(page);
    await context.close();
  }

  // Cancel after the viewer mounts too; a late asset must not restore the game or enter the world.
  {
    const { page, context } = await makePage();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route(`**/files/${id}/relief.glb`, async (route) => { await gate; await route.continue().catch(() => undefined); });
    const pending = page.waitForRequest((request) => request.url().endsWith('/relief.glb'));
    await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).click();
    await pending;
    await page.locator('.viewer').waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.home').waitFor();
    release();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.viewer, .world-loading, .world-firefly, .slide-cover').count(), 0);
    await context.close();
  }

  // Missing, private and unfinished worlds keep the photograph and an operable retry button.
  for (const mode of ['missing', 'private', 'running']) {
    const { page, context } = await makePage();
    await page.route(`**/api/worlds/${id}`, (route) => route.fulfill(mode === 'missing'
      ? { status: 404, json: { error: 'Not found' } }
      : { json: { manifest, access: { visibility: mode === 'private' ? 'private' : 'link', canEdit: true }, running: mode === 'running' } }));
    await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).click();
    await page.locator('.memory-error:not([hidden])').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__demoWebGLCalls), 0);
    assert.equal(new URL(page.url()).pathname, '/');
    await context.close();
  }

  // A failed asset never reveals an empty world, and offers recovery.
  {
    const { page, context } = await makePage();
    await page.route(`**/files/${id}/relief.glb`, (route) => route.abort());
    await page.getByRole('button', { name: 'Load the sample 3D world', exact: true }).click();
    await page.locator('.viewer-load-error:not([hidden])').waitFor({ timeout: 20_000 });
    assert.equal(await page.locator('.viewer.inside').count(), 0);
    await page.getByRole('link', { name: 'Back to home', exact: true }).click();
    await page.locator('.home').waitFor();
    await context.close();
  }

  // Mobile and reduced motion keep an explicit keyhole entry, without horizontal overflow.
  {
    const { page, context, requests } = await makePage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
    await idle(page, requests);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(root, '.scratch/home-demo/mobile.png'), fullPage: true });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route(`**/files/${id}/relief.glb`, async (route) => { await gate; await route.continue(); });
    await page.getByRole('button', { name: 'Try the interactive world', exact: true }).click();
    await page.getByRole('button', { name: 'Catch firefly 1', exact: true }).waitFor();
    const targets = await page.locator('.world-firefly').evaluateAll((buttons) => buttons.map((button) => {
      const r = button.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    }));
    assert.equal(targets.length, 7);
    for (let i = 0; i < targets.length; i++) for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i], b = targets[j];
      assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top,
        'reduced-motion fireflies must have separate touch targets');
    }
    await page.getByRole('button', { name: 'Catch firefly 1', exact: true }).tap();
    assert.equal(await page.locator('.world-loading-count').innerText(), '1');
    assert.equal(await page.locator('.world-firefly').evaluateAll((buttons) => buttons.reduce((n, b) => n + b.getAnimations().length, 0)), 0, 'Reduced motion keeps catch targets still');
    await page.locator('.viewer').waitFor();
    await page.screenshot({ path: path.join(root, '.scratch/home-demo/fireflies-mobile.png') });
    release();
    await enterReadyWorld(page);
    await page.locator('.viewer-top a.back').click();
    await page.getByRole('link', { name: 'Read the sample’s WOMetrics' }).click();
    await page.getByRole('region', { name: 'Current WOMPar score' }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'WOMetrics', exact: true }).getAttribute('aria-selected'), 'true');
    await context.close();
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  console.log('Passed: idle network/GPU isolation, opt-in loading + explicit keyhole entry, firefly play, cancellation/retry, shared-only samples, failed-asset recovery, cleanup, mobile, reduced motion and WOMetrics. Only local GET requests; no provider calls.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(data, { recursive: true, force: true });
}
