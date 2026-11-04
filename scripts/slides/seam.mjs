// Is the hand-off from the slide space to the viewer seamless? Plays a slide with the network throttled (so
// the world stays loading) and grabs:
//   1 the end of the flight: the slide flat in its frame, its mark dormant (slow motion)
//   2 the viewer with the slide's cover still up under its aperture
//   3 the viewer once the cover is gone
// then reports where the slide landed against its frame, and how much each step changed on screen
// (outside the top bar and the aperture's label). Nothing is written but the screenshots.
//
//   npm run slides:seam -- [slide key] [WxH] [tag]
//     slide key  <world>.<slide>, for example <world id>.photo (default: the first photo slide)
//     WxH        the browser window (default 1440x900)
//     tag        screenshots go to data/checks/slides/<tag> (default seam)
//   Needs the app running (see BASE in browser.mjs) and Playwright (see PLAYWRIGHT_CORE there).
import sharp from 'sharp';
import { BASE, getJson, launch, outDir, parseSize, slowClock, sleep } from './browser.mjs';

const [keyArg, size = '1440x900', tag = 'seam'] = process.argv.slice(2);
const [W, H] = parseSize(size);
const key = keyArg ?? (await getJson('/api/slides').then((all) => {
  const first = all.find((s) => s.kind === 'photo');
  if (!first) throw new Error('No slides to play. Build a world first, or name a slide key.');
  return `${first.world}.${first.id}`;
}));
const out = outDir(tag);

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(slowClock);
  // Hold the viewer's photo "decoding" until released, so the cover stays up while we look.
  await page.addInitScript(() => {
    const realDecode = HTMLImageElement.prototype.decode;
    window.__hold = true;
    HTMLImageElement.prototype.decode = function () {
      const p = realDecode.call(this);
      if (!this.classList.contains('memory-photo')) return p;
      return p.then(() => new Promise((r) => { const t = setInterval(() => { if (!window.__hold) { clearInterval(t); r(); } }, 20); }));
    };
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/?debug#/space?slide=${encodeURIComponent(key)}`);
  await page.waitForFunction(() => window.__wom?.space?.state().mode === 'browse', null, { timeout: 30000 });
  await sleep(2500);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 200, downloadThroughput: 200 * 1024, uploadThroughput: -1 });

  await page.evaluate(() => window.__setSpeed(0.04));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window.__wom.space.flight()?.u ?? 0) > 0.992, null, { timeout: 60000, polling: 'raf' });
  const landed = await page.evaluate(() => window.__wom.space.flight());
  await page.screenshot({ path: `${out}/1_flight_end.png` });
  await page.evaluate(() => window.__setSpeed(1));
  console.log('flyer box', JSON.stringify(landed.box), 'frame', JSON.stringify(landed.rect), 'u', landed.u.toFixed(4));

  await page.waitForFunction(() => document.querySelector('.slide-cover.in-viewer') && !document.querySelector('.slide-cover-mark'), null, { timeout: 30000, polling: 50 });
  await sleep(250);
  await page.screenshot({ path: `${out}/2_viewer_with_cover.png` });
  await page.evaluate(() => { window.__hold = false; });
  await page.waitForFunction(() => !document.querySelector('.slide-cover'), null, { timeout: 30000, polling: 50 });
  await sleep(60);
  await page.screenshot({ path: `${out}/3_viewer.png` });
  const state = await page.evaluate(() => ({
    hash: location.hash,
    photo: document.querySelector('.memory-photo')?.getBoundingClientRect().toJSON(),
    label: document.querySelector('.aperture-status')?.textContent,
    labelBox: document.querySelector('.aperture-status')?.getBoundingClientRect().toJSON(),
  }));
  console.log(JSON.stringify(state));

  const raw = async (f) => sharp(`${out}/${f}.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const [a, b, c] = await Promise.all(['1_flight_end', '2_viewer_with_cover', '3_viewer'].map(raw));
  const lb = state.labelBox;
  const skip = (x, y) => y < 70 || (lb && y > lb.top - 14 && y < lb.bottom + 14 && x > lb.left - 40 && x < lb.right + 40);
  const diff = (x, y) => {
    let sum = 0, n = 0, big = 0;
    for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
      if (skip(xx, yy)) continue;
      const i = (yy * W + xx) * 3;
      const d = (Math.abs(x.data[i] - y.data[i]) + Math.abs(x.data[i + 1] - y.data[i + 1]) + Math.abs(x.data[i + 2] - y.data[i + 2])) / 3;
      sum += d; n++; if (d > 24) big++;
    }
    return { mean: +(sum / n).toFixed(2), over24: `${((100 * big) / n).toFixed(2)}%` };
  };
  console.log('flight end -> viewer with cover', JSON.stringify(diff(a, b)));
  console.log('viewer with cover -> viewer    ', JSON.stringify(diff(b, c)));
  console.log('flight end -> viewer           ', JSON.stringify(diff(a, c)));
  // A strip across the keyhole at 1:1, for a look.
  const tiles = await Promise.all(['1_flight_end', '2_viewer_with_cover', '3_viewer'].map((f) => sharp(`${out}/${f}.png`).extract({ left: Math.round(W * 0.36), top: Math.round(H * 0.18), width: Math.round(W * 0.3), height: Math.round(H * 0.5) }).toBuffer()));
  const tw = Math.round(W * 0.3), th = Math.round(H * 0.5);
  await sharp({ create: { width: tw * 3, height: th, channels: 3, background: '#000000' } }).composite(tiles.map((t, i) => ({ input: t, left: i * tw, top: 0 }))).png().toFile(`${out}/zoom.png`);
  console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
