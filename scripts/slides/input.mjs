// The ways of moving through a stack and stepping in, on the real slides: wheel, drag, a click on a slide
// behind, Esc out of a sub space, and playing with reduced motion (quicker flight, no lean). Writes nothing.
//
//   npm run slides:input
//   Needs the app running with at least two slides (see BASE in browser.mjs) and Playwright (see PLAYWRIGHT_CORE there).
import { BASE, getJson, launch, reporter, sleep } from './browser.mjs';

const { check, done } = reporter();
if ((await getJson('/api/slides')).length < 2) throw new Error('These checks move through a stack, so they need at least two slides (two built worlds).');

const browser = await launch();
let stopped = null;
try {
  for (const reduced of [false, true]) {
    const tag = reduced ? 'reduced motion: ' : '';
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const state = () => page.evaluate(() => window.__wom.space.state());
    const rest = () => page.waitForFunction(() => { const s = window.__wom?.space?.state(); return s && s.mode === 'browse' && Math.abs(s.focus - s.target) < 0.001; }, null, { timeout: 20000, polling: 100 });
    await page.goto(`${BASE}/?debug#/space`);
    await page.waitForFunction(() => window.__wom?.space, null, { timeout: 30000 });
    await page.keyboard.press('Home');
    await rest();
    const keys = await page.evaluate(() => window.__wom.space.keys());
    if (!reduced) {
      await page.mouse.move(640, 400);
      // One notch of a mouse wheel is 100 px: about one slide, and the row snaps to it when the wheel stops.
      await page.mouse.wheel(0, 100);
      await sleep(400);
      await rest();
      check('one wheel notch moves to the next slide and snaps', (await state()).current === 1, JSON.stringify(await state()));
      await page.mouse.move(900, 300);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(900 + i * 20, 300); await sleep(16); }
      await page.mouse.up();
      await rest();
      check('dragging right goes back', (await state()).current === 0, JSON.stringify(await state()));
      // A click on the slide behind brings it to the front (and does not play it).
      // The first point across the slide behind that is not covered by the one in front.
      const box = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.space-3d .slide:not(.flying)')][1];
        const r = el.getBoundingClientRect();
        for (let fx = 0.98; fx > 0; fx -= 0.04) {
          const x = r.x + r.width * fx, y = r.y + r.height * 0.5;
          if (document.elementFromPoint(x, y)?.closest('.slide') === el) return { x, y };
        }
        return null;
      });
      check('the slide behind shows beside the one in front', box !== null);
      if (box) await page.mouse.click(box.x, box.y);
      await rest();
      const s = await state();
      check('a click on the slide behind brings it to the front', s.current === 1 && s.mode === 'browse', JSON.stringify(s));
      // Esc from a sub space goes back to the whole stack.
      const world = keys[0].split('.')[0];
      await page.goto(`${BASE}/?debug#/space/world/${world}`);
      await page.waitForFunction(() => document.querySelector('.space-crumb'), null, { timeout: 30000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => location.hash.startsWith('#/space') && !location.hash.startsWith('#/space/'), null, { timeout: 10000 });
      check('Esc leaves a sub space for the whole stack', true, await page.evaluate(() => location.hash));
      await page.waitForFunction(() => document.querySelector('.space-titles h1')?.textContent === 'Memories', null, { timeout: 30000 });
      await rest();
    } else {
      await page.mouse.move(1200, 100);
      await sleep(600);
      const q = await page.evaluate(() => document.querySelector('.space-3d .slide.is-front')?.style.transform ?? '');
      await page.mouse.move(100, 700);
      await sleep(600);
      const q2 = await page.evaluate(() => document.querySelector('.space-3d .slide.is-front')?.style.transform ?? '');
      check(`${tag}the pointer does not swing the camera`, q === q2);
    }
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    await page.waitForURL((u) => u.pathname.startsWith('/u/'), { timeout: 20000, waitUntil: 'commit' });
    const ms = Date.now() - t0;
    check(`${tag}Enter plays the slide into its world`, reduced ? ms < 1100 : ms > 1000 && ms < 3000, `${ms} ms to the viewer`);
    await page.waitForFunction(() => !document.querySelector('.slide-cover'), null, { timeout: 30000 });
    check(`${tag}the cover is gone in the viewer`, true);
    check(`${tag}no page errors`, errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
} catch (err) {
  stopped = err;
  throw err;
} finally {
  await browser.close();
  done(stopped);
}
