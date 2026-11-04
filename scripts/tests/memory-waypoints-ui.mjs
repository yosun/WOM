// Local browser regression: real camera projection, capture persistence, and one-shot video playback.
// Run after npm run build. PLAYWRIGHT_CORE and BROWSER_CHANNEL work like scripts/slides/browser.mjs.
// Disposable fixtures only; the server refuses provider/generation requests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import sharp from 'sharp';
import { launch, ROOT } from '../slides/browser.mjs';

const runFile = promisify(execFile);
const data = await mkdtemp(path.join(os.tmpdir(), 'wom-waypoints-'));
process.env.WOM_DATA_DIR = data;
process.env.WOM_STORE = 'fs';
process.env.WOM_AUTH = 'off';
const { app } = await import('../../server/src/index.ts');
const { initialSteps } = await import('../../server/src/store.ts');
const { setResolverForTests } = await import('../../server/src/access.ts');
const { DEFAULT_OPTIONS } = await import('../../server/src/config.ts');
setResolverForTests(null);

const id = 'mwaypointfixture';
const dir = path.join(data, 'worlds', id);
const out = path.join(ROOT, '.scratch/memory-waypoints');
await Promise.all([mkdir(path.join(dir, 'videos'), { recursive: true }), mkdir(out, { recursive: true })]);
const at = new Date().toISOString();
const photo = await sharp(path.join(ROOT, 'web/public/home/sunny-garden.webp')).jpeg().toBuffer();
const thumb = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#539bcc' } }).jpeg().toBuffer();
const manifest = {
  id, title: 'Waypoint fixture', status: 'done', options: DEFAULT_OPTIONS, createdAt: at, updatedAt: at,
  image: { file: 'source.jpg', thumb: 'source.jpg', width: 1200, height: 800 },
  steps: initialSteps(), objects: [], depth: {}, costs: [], scene: { file: 'scene.json', version: 1 },
};
const positions = new Float32Array([-5, -3, -5, 5, -3, -5, 0, 5, -5]);
const mesh = {
  asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength: positions.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(positions.buffer).toString('base64')}` }],
  bufferViews: [{ buffer: 0, byteLength: positions.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-5, -3, -5], max: [5, 5, -5] }],
};
const scene = {
  version: 1, title: manifest.title, image: { url: `/files/${id}/source.jpg`, width: 1200, height: 800 },
  camera: { fovY: 60, aspect: 1.5, up: [0, 1, 0], target: [0, 0, -5], source: 'moge' },
  objects: [], relief: { url: `/files/${id}/relief.glb` },
  lighting: { sky: '#fff', ground: '#888', sun: [0, 1, 0] }, diagnostics: [],
};
const captures = [
  { id: 'scaptureone', title: 'At the garden gate', entry: { position: [0, 0, -2], quaternion: [0, 0, 0, 1], fovY: 60, aspect: 16 / 9 } },
  { id: 'scapturetwo', title: 'A quiet corner', entry: { position: [-1, .2, -3], quaternion: [0, Math.sin(.3), 0, Math.cos(.3)], fovY: 45, aspect: .75 } },
].map((capture) => ({ ...capture, createdAt: at, image: { file: 'source.jpg', thumb: 'source.jpg', width: 1200, height: 800 } }));
const jobs = ['vwaypointone123', 'vwaypointtwo123'].map((videoId, index) => ({
  id: videoId, world: id, slideId: captures[0].id, title: `Garden memory ${index + 1}`, prompt: 'A breeze passes through the garden.',
  status: 'succeeded', createdAt: at, updatedAt: at,
  sourceImageUrl: `/files/${id}/videos/${videoId}-source.jpg`, videoUrl: `/files/${id}/videos/${videoId}.mp4`, thumbnailUrl: `/files/${id}/videos/${videoId}-thumb.jpg`,
  sourceFile: `videos/${videoId}-source.jpg`, videoFile: `videos/${videoId}.mp4`, thumbnailFile: `videos/${videoId}-thumb.jpg`,
}));
await Promise.all([
  writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest)),
  writeFile(path.join(dir, 'scene.json'), JSON.stringify(scene)),
  writeFile(path.join(dir, 'relief.glb'), JSON.stringify(mesh)),
  writeFile(path.join(dir, 'slides.json'), JSON.stringify({ slides: captures })),
  writeFile(path.join(dir, 'videos.json'), JSON.stringify({ videos: jobs })),
  writeFile(path.join(dir, 'source.jpg'), photo),
  ...jobs.flatMap((job) => [writeFile(path.join(dir, job.sourceFile), photo), writeFile(path.join(dir, job.thumbnailFile), thumb)]),
]);
await runFile(process.env.WOM_FFMPEG || 'ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24',
  '-t', '2.4', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(dir, jobs[0].videoFile),
]);
await copyFile(path.join(dir, jobs[0].videoFile), path.join(dir, jobs[1].videoFile));
const forbidden = [], errors = [];
const server = await new Promise((resolve) => {
  const instance = serve({ fetch: (request) => {
    const pathname = new URL(request.url).pathname;
    if (request.method !== 'GET' && !(/^\/api\/worlds\/[^/]+\/slides(?:\/[^/]+)?$/.test(pathname) && ['POST', 'DELETE'].includes(request.method))) {
      forbidden.push(`${request.method} ${pathname}`);
      return new Response('Only capture changes are allowed in this fixture', { status: 405 });
    }
    return app.fetch(request);
  }, hostname: '127.0.0.1', port: 0 }, () => resolve(instance));
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await launch();
  const open = async (options = {}) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    await context.route('**/*', (route) => {
      if (!route.request().url().startsWith(origin + '/')) {
        forbidden.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/u/-/${id}?debug&view=0,0,0,0,0,0,1`);
    await page.waitForSelector('.viewer.inside');
    await page.waitForFunction(() => document.querySelectorAll('.memory-waypoint').length === 3);
    return { context, page };
  };
  const marker = (page, index = 0) => page.locator(`[data-memory-id="${jobs[index].id}"]`);
  const pose = (page) => page.evaluate(() => window.__wom.viewer.state().pose);
  const inspect = async (page, index = 0) => {
    await marker(page, index).click();
    await page.waitForSelector('.memory-frame.is-open');
  };

  {
    const { context, page } = await open();
    const a = await marker(page).boundingBox(), b = await marker(page, 1).boundingBox();
    assert.ok(a && b && Math.hypot(a.x - b.x, a.y - b.y) > 44, 'sibling clips must have separate touch targets');
    assert.equal(await marker(page).locator('image').getAttribute('href'), jobs[0].thumbnailUrl);
    await page.screenshot({ path: path.join(out, 'desktop-waypoints.png') });
    await inspect(page);
    assert.equal(await page.locator('.memory-frame-image').evaluate((image) => image.complete && image.naturalWidth > 0), true);
    const transform = await page.locator('.memory-frame').evaluate((el) => ({
      matrix: el.style.transform.match(/matrix3d\(([^)]+)\)/)[1].split(',').map(Number),
      aspect: parseFloat(el.style.width) / parseFloat(el.style.height),
    }));
    assert.deepEqual(transform.matrix.slice(12, 15), captures[0].entry.position, 'frame must be centred at the saved camera tip');
    assert.ok(Math.abs(transform.aspect - 16 / 9) < .0001);
    await page.screenshot({ path: path.join(out, 'desktop-expanded.png') });
    const before = await pose(page);
    await page.getByRole('button', { name: `Play memory: ${jobs[0].title}`, exact: true }).click();
    await page.waitForSelector('.memory-premiere[open]');
    assert.equal(await page.evaluate(() => window.__wom.viewer.state().frozen), true);
    assert.equal(await page.locator('.memory-premiere-video').evaluate((video) => video.loop), false);
    await page.keyboard.down('w');
    await page.waitForTimeout(250);
    await page.keyboard.up('w');
    assert.deepEqual(await pose(page), before, 'premiere must hold the visitor camera still');
    await page.waitForSelector('.memory-premiere', { state: 'detached', timeout: 15000 });
    assert.deepEqual(await pose(page), before, 'natural end must return to the same scene view');
    assert.equal(await page.evaluate(() => window.__wom.viewer.state().frozen), false);
    assert.equal(await page.locator('.memory-inspection').isVisible(), false);

    // Escape, explicit return, and native fullscreen exit all release the player and the controls.
    for (const exit of ['escape', 'return', 'fullscreen']) {
      await inspect(page, 1);
      if (exit === 'return') await page.keyboard.down('w');
      await page.getByRole('button', { name: 'Watch memory', exact: true }).click();
      await page.waitForSelector('.memory-premiere[open]');
      const heldPose = await pose(page);
      if (exit === 'return') await page.keyboard.up('w');
      if (exit === 'escape') await page.keyboard.press('Escape');
      else if (exit === 'return') await page.getByRole('button', { name: 'Return to world' }).click();
      else {
        await page.waitForFunction(() => document.fullscreenElement?.classList.contains('viewer'));
        await page.evaluate(() => document.exitFullscreen());
      }
      await page.waitForSelector('.memory-premiere', { state: 'detached' });
      assert.equal(await page.evaluate(() => window.__wom.viewer.state().frozen), false);
      await page.waitForTimeout(100);
      assert.deepEqual(await pose(page), heldPose, 'keys held before playback must not stay held on return');
    }

    // A portrait capture uses its saved orientation and aspect; stills have no misleading play button.
    await page.locator('[data-memory-id="capture:scapturetwo"]').click();
    await page.waitForSelector('.memory-frame.is-open');
    const portrait = await page.locator('.memory-frame').evaluate((el) => ({
      matrix: el.style.transform.match(/matrix3d\(([^)]+)\)/)[1].split(',').map(Number),
      aspect: parseFloat(el.style.width) / parseFloat(el.style.height),
    }));
    assert.deepEqual(portrait.matrix.slice(12, 15), captures[1].entry.position);
    assert.ok(Math.abs(portrait.matrix[2] / portrait.matrix[0] + Math.tan(.6)) < .0001, 'frame should retain the capture yaw');
    assert.ok(Math.abs(portrait.aspect - .75) < .0001);
    assert.equal(await page.locator('.memory-play').count(), 0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Layers', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Memory waypoints (3)', exact: true }).uncheck();
    await marker(page).waitFor({ state: 'hidden' });
    await page.getByRole('checkbox', { name: 'Memory waypoints (3)', exact: true }).check();
    await page.getByRole('button', { name: 'Layers', exact: true }).click();

    // A newly saved capture appears immediately; Undo removes its spatial marker without waiting for a poll.
    await page.getByRole('button', { name: 'Capture this view', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-waypoint').length === 4);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.memory-waypoint').length === 3);
    await context.close();
  }

  {
    setResolverForTests(async () => ({ user: null, cookies: [] }));
    const { context, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await page.evaluate(() => { Element.prototype.requestFullscreen = undefined; });
    await marker(page).tap();
    await page.waitForSelector('.memory-frame.is-open');
    assert.equal(await page.locator('.memory-play-spark').first().evaluate((el) => getComputedStyle(el).animationName), 'none');
    const playDisc = await page.locator('.memory-play-disc').boundingBox();
    assert.ok(playDisc && playDisc.width >= 52 && playDisc.height >= 52, 'the in-world play disc should remain easy to tap');
    assert.equal(await page.getByRole('button', { name: 'Capture this view', exact: true }).isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(out, 'mobile-expanded.png') });
    await page.getByRole('button', { name: `Play memory: ${jobs[0].title}`, exact: true }).tap();
    await page.waitForSelector('.memory-premiere[open]');
    const rect = await page.locator('.memory-premiere').boundingBox();
    assert.ok(rect && rect.width >= 389 && rect.height >= 843, 'fallback premiere should fill the mobile viewport');
    await page.waitForSelector('.memory-premiere', { state: 'detached', timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__wom.viewer.state().frozen), false);
    await context.close();
  }

  {
    const { context, page } = await open();
    await inspect(page);
    await page.getByRole('button', { name: 'Watch memory', exact: true }).click();
    await page.waitForSelector('.memory-premiere[open]');
    await page.evaluate(() => { location.href = '/#/'; });
    await page.waitForSelector('.home');
    assert.equal(await page.locator('.memory-premiere, .memory-waypoints, .memory-frame-layer').count(), 0);
    assert.equal(await page.evaluate(() => document.fullscreenElement === null), true);
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(forbidden, []);
  console.log('Passed: spatial keyholes, middle thumbnails, sibling selection, saved image-plane orientation/aspect, one-shot premiere, exact camera return, all exits, capture/undo, layer toggle, mobile/reduced motion, and navigation cleanup. No provider calls.');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(data, { recursive: true, force: true });
}
