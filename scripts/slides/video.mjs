// Capture-to-video UI smoke test. It loads the real capture card and video studio with their real CSS,
// while mocking every video API request. No provider calls, credit use, or saved captures are involved.
// The tiny local clips share a red first frame but have different middle frames, so the check can catch
// accidentally reusing the source capture as every generated video's thumbnail.
//
//   PLAYWRIGHT_CORE=/path/to/playwright-core BROWSER_CHANNEL=chrome node scripts/slides/video.mjs
//   Needs Vite running (BASE in browser.mjs), Playwright, and ffmpeg on PATH.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { BASE, launch, outDir, reporter } from './browser.mjs';

const { check, done, log } = reporter();
const out = outDir(process.argv[2] ?? 'video');
const temp = mkdtempSync(path.join(os.tmpdir(), 'wom-video-smoke-'));
const WORLD = 'video-smoke';
const SLIDE = 'capture-smoke';
const PROMPT = 'The camera gently moves closer while the leaves sway.';
const sourcePath = '/__video-fixtures/source.png';
const source = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#d02020' } }).png().toBuffer();
const clips = new Map();
for (const [name, color] of [['green', '0x20d040'], ['blue', '0x2040d0']]) {
  const file = path.join(temp, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0xd02020:s=320x180:r=12:d=0.5',
    '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=12:d=1.5`,
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]',
    '-map', '[v]', '-c:v', 'libx264', '-movflags', '+faststart', file,
  ]);
  clips.set(`/__video-fixtures/${name}.mp4`, readFileSync(file));
}

const fixtureSlide = {
  id: SLIDE, world: WORLD, worldTitle: 'Video smoke world', kind: 'view', title: 'Captured garden',
  caption: '', createdAt: '2026-11-04T12:00:00.000Z', takenAt: '2026-11-04T12:00:00.000Z',
  image: { url: sourcePath, thumb: sourcePath, width: 320, height: 180 },
  entry: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: 50, focus: 2 },
};

async function setup(browser, mobile = false) {
  const slide = structuredClone(fixtureSlide);
  let availableSlides = [slide];
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requests = [], records = [];
  let gets = 0;
  await page.route('**/__video-smoke', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"></head><body class="page-viewer"><main class="viewer inside" id="fixture"><button type="button" class="capture-button" aria-label="Capture this view">◎</button></main></body></html>',
  }));
  await page.route('**/__video-fixtures/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === sourcePath ? source : clips.get(pathname);
    if (!body) return route.fulfill({ status: 404 });
    if (!pathname.endsWith('.mp4')) return route.fulfill({ contentType: 'image/png', body });
    // Native players seek with byte ranges. Match the real file server so seeking is available even when
    // Chromium only buffers metadata initially; a plain 200 mock can report a zero-length seekable range.
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({
      status: range ? 206 : 200, contentType: 'video/mp4',
      headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}) },
      body: body.subarray(start, end + 1),
    });
  });
  await page.route(`**/api/worlds/${WORLD}/videos**`, async (route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      requests.push(body);
      const now = new Date(Date.now() + records.length * 1000).toISOString();
      const record = {
        id: `smoke-${records.length + 1}`, world: WORLD, slideId: body.slideId,
        title: body.title, prompt: body.prompt, status: 'queued',
        createdAt: now, updatedAt: now, sourceImageUrl: sourcePath,
      };
      records.push(record);
      return route.fulfill({ status: 202, json: record });
    }
    if (req.method() === 'GET') {
      gets++;
      const id = new URL(req.url()).pathname.split('/').at(-1);
      return route.fulfill({ json: id === 'videos' ? records : records.find((r) => r.id === id) });
    }
    throw new Error(`Unexpected video API method: ${req.method()}`);
  });
  await page.route(`**/api/worlds/${WORLD}/slides/${SLIDE}`, async (route) => {
    const req = route.request();
    if (req.method() === 'PATCH') Object.assign(slide, req.postDataJSON());
    return route.fulfill({ json: slide });
  });
  await page.route(`**/api/worlds/${WORLD}/slides`, (route) => route.fulfill({ json: availableSlides }));
  await page.goto(`${BASE}/__video-smoke`);
  await page.evaluate(async (slide) => {
    const [{ createVideoStudio }, { createCaptureCard }] = await Promise.all([import('/src/videos.ts'), import('/src/capture.ts')]);
    const mount = document.querySelector('#fixture');
    const studio = createVideoStudio(mount, slide.world, { editable: true });
    const card = createCaptureCard(mount, studio);
    card.show(slide);
    window.__videoSmoke = { studio, card, slide };
  }, slide);
  await page.waitForSelector('.capture-card .video-editor');
  return {
    context, page, errors, requests, records, getCount: () => gets,
    complete(i, color) { Object.assign(records[i], { status: 'succeeded', videoUrl: `/__video-fixtures/${color}.mp4`, updatedAt: new Date().toISOString() }); },
    fail(i) { Object.assign(records[i], { status: 'failed', error: 'The provider could not generate this clip.', updatedAt: new Date().toISOString() }); },
    deleteSource() { availableSlides = []; },
  };
}

// Sample the center of a thumbnail after it loads; a source-frame thumbnail would be red in both variants.
async function thumbnailColors(page, selector) {
  return page.locator(selector).evaluateAll(async (images) => Promise.all(images.map(async (image) => {
    if (!image.complete) await new Promise((resolve) => { image.onload = resolve; image.onerror = resolve; });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d').drawImage(image, image.naturalWidth / 2, image.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
    return [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data].slice(0, 3);
  })));
}

let browser, stopped = null;
try {
  browser = await launch();
  // The remaining checks intentionally go through the UI rather than calling generation methods directly.
  const d = await setup(browser);
  const { page } = d;
  await page.locator('.video-prompt').fill(PROMPT);
  const name = page.locator('.capture-card .video-name');
  const motion = page.locator('.capture-card .video-prompt');
  const action = page.locator('.capture-card .video-action');
  await name.fill('🌧'.repeat(120));
  check('a 120-character Unicode title is accepted', await name.getAttribute('aria-invalid') === 'false' && await action.isEnabled());
  await name.fill('T'.repeat(121));
  check('an overlong title blocks Action with a visible explanation', await name.getAttribute('aria-invalid') === 'true' && await action.isDisabled() && await page.locator('.capture-card .video-editor-status').textContent().then((text) => text.includes('120 characters')));
  await name.fill(fixtureSlide.title);
  await motion.fill('x'.repeat(16000));
  check('a 16,000-character motion prompt is accepted', await motion.getAttribute('aria-invalid') === 'false' && await action.isEnabled());
  await motion.fill('x'.repeat(16001));
  check('a prompt above 16,000 characters blocks Action', await motion.getAttribute('aria-invalid') === 'true' && await action.isDisabled());
  const atByteLimit = 'é'.repeat(2712) + 'xxxx';
  await motion.fill(atByteLimit);
  check('a Unicode prompt at AI3D’s input byte limit is accepted', await motion.getAttribute('aria-invalid') === 'false' && await action.isEnabled());
  await motion.fill(atByteLimit + 'x');
  check('a Unicode prompt one byte beyond AI3D’s input limit blocks Action', await motion.getAttribute('aria-invalid') === 'true' && await action.isDisabled());
  await motion.fill('🌧'.repeat(6000));
  check('a multibyte prompt exceeding the input byte limit blocks Action', await motion.getAttribute('aria-invalid') === 'true' && await action.isDisabled() && await page.locator('.capture-card .video-editor-status').textContent().then((text) => text.includes('16 KiB')));
  await motion.fill(PROMPT);
  const before = await page.locator('.video-prompt').boundingBox();
  await page.locator('.video-expand').click();
  const after = await page.locator('.video-prompt').boundingBox();
  check('the prompt expands without losing its text', after.height > before.height + 30 && await page.locator('.video-prompt').inputValue() === PROMPT);
  const submitted = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/worlds/${WORLD}/videos`));
  await page.locator('.video-action').click();
  await submitted;
  await page.waitForFunction(() => document.querySelector('.video-dock-status')?.textContent);
  check('Action sends the capture and its prompt with a request ID', d.requests.length === 1 && d.requests[0].slideId === SLIDE && d.requests[0].prompt === PROMPT && Boolean(d.requests[0].requestId), JSON.stringify(d.requests[0]));
  check('desktop shows the video status bar', await page.locator('.video-dock').isVisible() && !await page.locator('.video-bubble').isVisible());
  const getsBefore = d.getCount();
  d.complete(0, 'green');
  await page.waitForSelector('.capture-card .video-play:not([hidden])', { timeout: 20000 });
  check('polling notices completion and adds a play overlay', d.getCount() > getsBefore && await page.locator('.capture-card .video-play').isVisible());
  check('the play overlay has an accessible label without redundant visible text', (await page.locator('.capture-card .video-play').textContent()).trim() === '▶' && (await page.locator('.capture-card .video-play').getAttribute('aria-label')).includes('Play video'));
  await page.locator('.capture-card .video-play').click();
  await page.waitForFunction(() => {
    const video = document.querySelector('.capture-card video');
    return video && !video.paused && video.currentTime > 0;
  }, null, { timeout: 10000 });
  check('the play overlay starts an inline video with controls', await page.locator('.capture-card video').evaluate((video) => video.controls));

  await name.fill('Sunset garden');
  const renamed = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/worlds/${WORLD}/slides/${SLIDE}`));
  await name.blur();
  await renamed;
  await page.waitForFunction(() => document.querySelector('.capture-card .video-original .video-thumb-title')?.textContent === 'Sunset garden');
  const second = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/worlds/${WORLD}/videos`));
  await page.locator('.capture-card .video-action').click();
  await second;
  check('a repeated prompt creates a separate take', d.requests.length === 2 && d.requests[1].prompt === PROMPT && d.requests[1].requestId !== d.requests[0].requestId);
  d.complete(1, 'blue');
  await page.waitForFunction(() => document.querySelectorAll('.capture-card .video-variant img[src^="data:"]').length === 2, null, { timeout: 20000 });
  const variantTitles = await page.locator('.capture-card .video-variant .video-thumb-title').allTextContents();
  const dockTitles = await page.locator('.video-dock-thumb .video-thumb-title').allTextContents();
  check('the original and each video thumbnail show their own titles', await page.locator('.capture-card .video-original .video-thumb-title').textContent() === 'Sunset garden' && JSON.stringify(variantTitles) === JSON.stringify(['Sunset garden', 'Captured garden']) && JSON.stringify(dockTitles) === JSON.stringify(variantTitles), JSON.stringify({ variantTitles, dockTitles }));
  const colors = await thumbnailColors(page, '.capture-card .video-variant img');
  check('variant thumbnails use distinct middle frames, not the shared red first frame', colors.length === 2 && colors.some(([r, g, b]) => g > r * 2 && g > b * 2) && colors.some(([r, g, b]) => b > r * 2 && b > g * 2), JSON.stringify(colors));
  check('video variants use a horizontal scroll container', await page.locator('.capture-card .video-variants').evaluate((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)));
  await page.screenshot({ path: path.join(out, 'desktop-complete.png') });

  await page.locator('.capture-close').click();
  await page.locator('.video-dock-thumbs button').first().click();
  await page.waitForSelector('.video-dialog .video-play:not([hidden])');
  check('a completed video button reopens its capture with a play overlay', await page.locator('.video-dialog .video-preview img').evaluate((img) => new URL(img.src).pathname === '/__video-fixtures/source.png'));
  await page.locator('.video-dialog-close').click();

  // A provider failure remains visible and lets the person edit or make another explicit attempt.
  await page.evaluate(() => window.__videoSmoke.card.show(window.__videoSmoke.slide));
  await page.locator('.capture-card .video-prompt').fill('A second motion prompt that will fail.');
  const third = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/worlds/${WORLD}/videos`));
  await page.locator('.capture-card .video-action').click();
  await third;
  d.fail(2);
  await page.waitForFunction(() => document.body.textContent.includes('The provider could not generate this clip.'), null, { timeout: 20000 });
  check('generation failures show the error and preserve the prompt', await page.locator('.capture-card .video-prompt').inputValue() === 'A second motion prompt that will fail.' && await page.locator('.capture-card .video-action').isEnabled());
  await page.locator('.capture-close').click();
  d.deleteSource();
  await page.locator('.video-dock-thumbs button').first().click();
  await page.waitForSelector('.video-dialog .video-play:not([hidden])');
  check('deleted captures retain their first frame and playable video', await page.locator('.video-dialog .video-source').evaluate((img) => new URL(img.src).pathname === '/__video-fixtures/source.png') && !await page.locator('.video-dialog .video-action').isVisible());
  check('archived playback shows the selected video prompt instead of a private draft', await page.locator('.video-dialog .video-prompt').inputValue() === PROMPT);
  await page.locator('.video-dialog-close').click();
  check('desktop has no uncaught page errors', d.errors.length === 0, d.errors.join(' | '));
  await d.context.close();

  const empty = await setup(browser);
  await empty.page.locator('.video-prompt').fill('A motion prompt without any completed clips.');
  const emptySubmitted = empty.page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/worlds/${WORLD}/videos`));
  await empty.page.locator('.video-action').click();
  await emptySubmitted;
  empty.fail(0);
  await empty.page.waitForFunction(() => document.querySelector('.capture-card .video-editor-status')?.textContent.includes('The provider could not generate this clip.'), null, { timeout: 20000 });
  check('a failed first attempt shows its error without completed videos', await empty.page.locator('.video-action').isEnabled() && await empty.page.locator('.video-play').count() === 0);
  await empty.context.close();

  const m = await setup(browser, true);
  const phone = m.page;
  await phone.locator('.video-prompt').fill(PROMPT);
  const mobileSubmitted = phone.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/worlds/${WORLD}/videos`));
  await phone.locator('.video-action').click();
  await mobileSubmitted;
  await phone.waitForSelector('.video-bubble:not([hidden])');
  const bubble = await phone.locator('.video-bubble').boundingBox();
  const capture = await phone.locator('.capture-button').boundingBox();
  check('mobile shows a compact bubble above Capture', !await phone.locator('.video-dock').isVisible() && bubble.width < 260 && bubble.y + bubble.height <= capture.y - 2, JSON.stringify({ bubble, capture }));
  await phone.screenshot({ path: path.join(out, 'mobile-generating.png') });
  await phone.locator('.video-bubble-dismiss').click();
  const mobileGets = m.getCount();
  m.complete(0, 'green');
  await phone.waitForSelector('.capture-card .video-play:not([hidden])', { timeout: 20000 });
  check('dismissing the bubble leaves generation and polling running', m.getCount() > mobileGets && !await phone.locator('.video-bubble').isVisible() && m.requests.length === 1);
  const again = phone.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/api/worlds/${WORLD}/videos`));
  await phone.locator('.capture-card .video-action').click();
  await again;
  check('starting another generation restores the mobile bubble', await phone.locator('.video-bubble').isVisible());
  m.complete(1, 'blue');
  await phone.waitForFunction(() => document.querySelectorAll('.capture-card .video-variant img[src^="data:"]').length === 2, null, { timeout: 20000 });
  for (let i = 0; i < 5; i++) m.records.push({ ...m.records[i % 2], id: `extra-${i}`, createdAt: new Date(Date.now() + i * 1000).toISOString() });
  await phone.evaluate(() => window.__videoSmoke.studio.refresh());
  await phone.waitForFunction(() => document.querySelectorAll('.capture-card .video-variant').length === 7);
  check('many takes scroll horizontally on mobile', await phone.locator('.capture-card .video-variants').evaluate((el) => el.scrollWidth > el.clientWidth + 20));
  await phone.locator('.capture-close').click();
  await phone.locator('.video-bubble-open').click();
  await phone.waitForSelector('.video-dialog .video-play:not([hidden])');
  check('the mobile bubble opens a playable completed take', await phone.locator('.video-dialog .video-play').isVisible());
  await phone.screenshot({ path: path.join(out, 'mobile-complete.png') });
  await phone.evaluate(() => window.__videoSmoke.studio.setEditable(false));
  check('shared viewers can play history while generation controls are read-only', !await phone.locator('.video-dialog .video-action').isVisible() && await phone.locator('.video-dialog .video-prompt').evaluate((el) => el.readOnly) && await phone.locator('.video-dialog .video-play').isVisible());
  check('shared viewers see the selected video prompt', await phone.locator('.video-dialog .video-prompt').inputValue() === PROMPT);
  await phone.locator('.video-dialog-close').click();
  check('mobile has no uncaught page errors', m.errors.length === 0, m.errors.join(' | '));
  await m.context.close();
  log('mocked capture-to-video desktop and mobile flows completed without provider calls');
} catch (err) {
  stopped = err;
} finally {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
  done(stopped);
}
