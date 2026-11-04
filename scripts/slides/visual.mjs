// The look of a full stack: /api/slides is replaced, in the browser only, by a made-up collection of 26 slides
// (the pictures of the slides you have, dated across 2025 and 2026) so the row, the timeline and the floor can be
// judged with more than a few slides. Nothing is written anywhere but the screenshots, and the slides cannot be
// played (their worlds do not exist).
//
//   npm run slides:visual -- [WxH] [tag]
//     WxH   the browser window (default 1440x900)
//     tag   screenshots go to data/checks/slides/<tag> (default visual)
//   Needs the app running with at least one slide (see BASE in browser.mjs) and Playwright (see PLAYWRIGHT_CORE there).
import { BASE, getJson, launch, outDir, parseSize, sleep } from './browser.mjs';

const [size = '1440x900', tag = 'visual'] = process.argv.slice(2);
const [W, H] = parseSize(size);
const out = outDir(tag);

// One picture per distinct image the app already serves.
const images = [...new Map((await getJson('/api/slides')).map((s) => [s.image.url, s.image])).values()];
if (!images.length) throw new Error('No slides to take pictures from. Build a world first.');
const titles = ['Sunny Garden with Buddy', 'Sunlit Cloister Garden', 'Beauty Counter Smile', 'Quiet Morning Yard', 'Stone Court, Empty', 'Counter at Closing', 'Garden from Above', 'The Shop Window', 'Afternoon Shadows', 'Cloister Walk'];
const slides = [];
const t0 = Date.parse('2025-03-02T10:00:00Z'), t1 = Date.parse('2026-11-01T10:00:00Z');
for (let i = 0; i < 26; i++) {
  const img = images[(i * 7) % images.length];
  const at = new Date(t0 + ((t1 - t0) * i) / 25).toISOString();
  slides.push({
    id: i % 4 === 3 ? `sfake${i}aaaa` : 'photo',
    world: `mock${String(i).padStart(4, '0')}aa`,
    worldTitle: titles[(i * 3) % titles.length],
    kind: i % 4 === 3 ? 'view' : 'photo',
    title: i % 4 === 3 ? 'View 1' : 'The photo',
    takenAt: at,
    createdAt: at,
    image: { url: img.url, thumb: img.thumb ?? img.url, width: img.width, height: img.height },
    entry: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: 50, aspect: img.width / img.height },
  });
}

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/slides', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(slides) }));
  await page.goto(`${BASE}/?debug#/space?slide=${slides[12].world}.${slides[12].id}`);
  await page.waitForFunction(() => window.__wom?.space?.state().mode === 'browse', null, { timeout: 30000 });
  await sleep(2500);
  await page.screenshot({ path: `${out}/1_middle.png` });
  await page.keyboard.press('ArrowRight');
  await sleep(250);
  await page.screenshot({ path: `${out}/2_moving.png` });
  await sleep(1500);
  await page.screenshot({ path: `${out}/3_next.png` });
  await page.keyboard.press('Home');
  await sleep(2200);
  await page.screenshot({ path: `${out}/4_first.png` });
  await page.keyboard.press('End');
  await sleep(2500);
  await page.screenshot({ path: `${out}/5_last.png` });
  console.log(JSON.stringify(await page.evaluate(() => window.__wom.space.state())));
  console.log(errors.length ? `ERRORS ${errors.join(' | ')}` : 'no page errors');
  if (errors.length) process.exitCode = 1;
} finally {
  await browser.close();
}
