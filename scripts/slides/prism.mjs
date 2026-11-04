// The temporal prism's geometry and existing interaction handoffs, with browser-only fixture slides.
// Requires Vite (npm run dev:web) and the browser setup documented in browser.mjs. No API/server or
// real worlds are needed; the synthetic page imports the production component through Vite.
//
//   node scripts/slides/prism.mjs [tag]
//   Screenshots: data/checks/slides/<tag> (default prism). No application data is written.
import { BASE, launch, outDir, reporter, slowClock, sleep } from './browser.mjs';

const [tag = 'prism'] = process.argv.slice(2);
const out = outDir(tag);
const { check, done } = reporter();
const near = (a, b, eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps);
const sameRotation = (a, b) => near(a, b) || near(a, b.map((v) => -v));
const keyOf = (s) => `${s.world}.${s.id}`;

const aspects = [[1600, 900], [900, 1600], [1000, 1000], [2100, 900], [1200, 900], [900, 1200], [1800, 1000], [1400, 900]];
const makeFixture = ([width, height], i, count = aspects.length) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${i * 43} 55% 38%)"/><stop offset="1" stop-color="hsl(${i * 43 + 70} 45% 12%)"/></linearGradient></defs><path fill="url(#g)" d="M0 0H${width}V${height}H0z"/><circle cx="${width * 0.72}" cy="${height * 0.3}" r="${height * 0.16}" fill="#ffd8a0" opacity=".6"/><path d="M0 ${height * 0.8}L${width * 0.35} ${height * 0.4}L${width * 0.65} ${height * 0.75}L${width} ${height * 0.5}V${height}H0" fill="#102d30"/><text x="${width * 0.08}" y="${height * 0.2}" font-family="sans-serif" font-size="${height * 0.1}" fill="white">Memory ${i + 1}</text></svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return {
    id: 'photo', world: `fixture${i}`, worldTitle: `Memory ${i + 1}`, kind: 'photo', title: 'The photo',
    // Two equal taken dates exercise stable ordering without changing their spacing.
    takenAt: new Date(Date.UTC(2025, 0, (i === 3 ? 2 : i) + 1)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 0, count - i)).toISOString(),
    image: { url, thumb: url, width, height },
    entry: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: 50, aspect: width / height },
  };
};
const fixtures = aspects.map((size, i) => makeFixture(size, i));
const slides = [5, 2, 7, 0, 4, 1, 6, 3].map((i) => fixtures[i]);
const takenKeys = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => keyOf(fixtures[i]));
const createdKeys = [...takenKeys].reverse();
// A longer, uniform-ratio archive makes depth/occlusion legible, independently of the mixed-ratio checks.
const depthSlides = Array.from({ length: 32 }, (_, i) => makeFixture([1600, 900], i, 32));
const depthKeys = depthSlides.map(keyOf);
const harness = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#mount{position:absolute;inset:0;width:100%;height:100%}</style></head><body><main id="mount" class="space-page"></main><script type="module">
import { createSlideSpace } from '/src/slides/space.ts';
let space = null;
window.__fixture = {
  mount(options) {
    space?.dispose();
    document.querySelector('#mount').replaceChildren();
    window.__played = null;
    window.__selected = [];
    space = createSlideSpace(document.querySelector('#mount'), { title: 'Prism fixture', ...options,
      onSelect(doc) { window.__selected.push(doc.world + '.' + doc.id); },
      onPlay(doc, cover) { window.__played = { key: doc.world + '.' + doc.id, cover }; },
    });
  },
  returnFrom(key, cover) { return space.returnFrom(key, cover); },
};
window.__fixtureReady = true;
</script></body></html>`;

const browser = await launch();
let stopped = null;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(slowClock);
  await page.route('**/__prism-check.html*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: harness }));
  await page.goto(`${BASE}/__prism-check.html?debug`);
  await page.waitForFunction(() => window.__fixtureReady, null, { timeout: 30000 });
  const rest = () => page.waitForFunction(() => {
    const s = window.__wom?.space?.state();
    return s?.mode === 'browse' && Math.abs(s.focus - s.target) < 0.00001 &&
      s.zoom === s.zoomTarget && s.extraction === s.extractionTarget &&
      (s.extractionTarget !== 0 || s.extracted === null);
  }, null, { timeout: 20000 });
  const snapshot = () => page.evaluate(() => ({ state: window.__wom.space.state(), geometry: window.__wom.space.geometry(), keys: window.__wom.space.keys() }));
  const mount = async (options = {}) => {
    await page.evaluate((options) => window.__fixture.mount(options), { slides, selected: takenKeys[3], ...options });
    await rest();
    // The API is installed synchronously; allow the first animation/ResizeObserver render to finish.
    await sleep(100);
    return snapshot();
  };
  const assertLayout = (name, snap) => {
    const { frames, spacing } = snap.geometry;
    check(`${name}: every resting plane has one shared quaternion`, frames.every((f) => sameRotation(f.quaternion, frames[0].quaternion)));
    check(`${name}: chronology lies on a uniformly spaced straight X axis`, frames.every((f, i) => near(f.position, [i * spacing, frames[0].position[1], frames[0].position[2]])), JSON.stringify(frames.map((f) => f.position)));
    // The local image normal is +Z. A YZ plane must have its world normal along X.
    const q = frames[0]?.quaternion;
    if (q) {
      const [x, y, z, w] = q;
      const normal = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
      check(`${name}: image planes are perpendicular to the temporal axis`, Math.abs(Math.abs(normal[0]) - 1) < 1e-6 && Math.abs(normal[1]) < 1e-6 && Math.abs(normal[2]) < 1e-6, JSON.stringify(normal));
    }
  };
  const assertTraversal = (name, before, after) => {
    const a = before.geometry, b = after.geometry;
    check(`${name}: scrolling preserves every resting frame pose`, a.frames.every((f, i) => near(f.position, b.frames[i].position) && sameRotation(f.quaternion, b.frames[i].quaternion)));
    check(`${name}: camera translates only along X with focus`, Math.abs((b.camera.position[0] - a.camera.position[0]) - (after.state.focus - before.state.focus) * a.spacing) < 1e-5 && near(a.camera.position.slice(1), b.camera.position.slice(1)) && sameRotation(a.camera.quaternion, b.camera.quaternion), JSON.stringify({ before: a.camera, after: b.camera }));
  };
  const assertExtraction = (name, before, after, key) => {
    const index = after.keys.indexOf(key);
    const a = before.geometry.frames[index], b = after.geometry.frames[index];
    check(`${name}: selected plane slides only along positive Z`, near(a.position.slice(0, 2), b.position.slice(0, 2)) && b.position[2] > a.position[2] && sameRotation(a.quaternion, b.quaternion), JSON.stringify({ before: a.position, after: b.position }));
    check(`${name}: other resting frame poses stay fixed`, before.geometry.frames.every((f, i) => i === index || near(f.position, after.geometry.frames[i].position) && sameRotation(f.quaternion, after.geometry.frames[i].quaternion)));
  };
  const assertSelection = async (name, key) => {
    const selected = await page.evaluate(() => window.__selected);
    check(`${name}: selection callback receives the focused frame identity`, selected.at(-1) === key, JSON.stringify(selected));
  };
  const assertFront = async (name) => {
    const hit = await page.evaluate(() => {
      const front = document.querySelector('.slide.is-front');
      const img = front?.querySelector('.slide-img');
      if (!img) return { visible: false, unoccluded: false, reason: 'missing focused image' };
      const r = img.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { visible: r.width > 0 && r.height > 0 && x > 0 && y > 0 && x < innerWidth && y < innerHeight,
        unoccluded: !!top && top.closest('.slide') === front, x, y, top: top?.getAttribute('aria-label') ?? top?.className?.baseVal ?? top?.className };
    });
    check(`${name}: focused image center is onscreen and unoccluded`, hit.visible && hit.unoccluded, JSON.stringify(hit));
  };
  const clickKeyhole = async (name) => {
    // A real pointer click and elementFromPoint expose occlusion by nearer planes; dispatchEvent cannot.
    const hitKeyhole = () => page.evaluate(() => {
      const mark = document.querySelector('.slide.is-front .slide-mark');
      const button = mark?.querySelector('.keyhole-mark-hit');
      if (!button) return { clickable: false, reason: 'missing focused keyhole' };
      const r = button.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return { clickable: Number(getComputedStyle(mark).opacity) > 0 && x > 0 && y > 0 && x < innerWidth && y < innerHeight && (top === button || button.contains(top)),
        x, y, top: top?.getAttribute('aria-label') ?? top?.className?.baseVal ?? top?.className };
    });
    let hit = await hitKeyhole();
    check(`${name}: keyhole is visible and receives pointer input`, hit.clickable, JSON.stringify(hit));
    if (hit.clickable && !(await snapshot()).state.extracted) {
      await page.mouse.click(hit.x, hit.y);
      await rest();
      const staged = (await snapshot()).state;
      check(`${name}: first keyhole click stages the plane before world entry`, staged.mode === 'browse' && staged.extracted === staged.key && staged.extraction === 1, JSON.stringify(staged));
      hit = await hitKeyhole();
      check(`${name}: staged keyhole receives pointer input`, hit.clickable, JSON.stringify(hit));
    }
    if (hit.clickable) await page.mouse.click(hit.x, hit.y);
    check(`${name}: pointer click activates the existing world-entry flight`, hit.clickable && await page.evaluate(() => window.__wom.space.state().mode === 'flying'));
  };

  const initial = await mount({ time: 'taken' });
  check('taken chronology sorts unsorted inputs stably', nearKeys(initial.keys, takenKeys), initial.keys.join(' '));
  assertLayout('memory chronology', initial);
  await assertSelection('initial selection', takenKeys[3]);
  await assertFront('memory chronology');
  check('mixed image ratios fit one fixed prism cross-section', initial.geometry.crossSection.height >= 300 && initial.geometry.crossSection.width >= 700, JSON.stringify(initial.geometry.crossSection));
  await page.screenshot({ path: `${out}/1_middle.png` });

  await page.evaluate(() => {
    window.__traversalSamples = [];
    window.__sampleTraversal = true;
    const sample = () => {
      if (!window.__sampleTraversal) return;
      window.__traversalSamples.push({ state: window.__wom.space.state(), geometry: window.__wom.space.geometry(), keys: window.__wom.space.keys() });
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.keyboard.press('ArrowRight');
  await rest();
  const fractional = await page.evaluate(() => {
    window.__sampleTraversal = false;
    return window.__traversalSamples.filter((s) => Math.abs(s.state.focus - Math.round(s.state.focus)) > 0.001);
  });
  check('scroll transition samples include several fractional focus positions', fractional.length >= 3, `${fractional.length} samples`);
  for (const i of [...new Set([0, Math.floor(fractional.length / 2), fractional.length - 1])]) {
    if (fractional[i]) assertTraversal(`fractional focus ${fractional[i].state.focus.toFixed(3)}`, initial, fractional[i]);
  }
  const next = await snapshot();
  check('ArrowRight selects the next chronological frame', next.state.current === initial.state.current + 1);
  assertTraversal('keyboard traversal', initial, next);
  await assertSelection('keyboard traversal', next.state.key);
  await assertFront('keyboard traversal');
  await page.screenshot({ path: `${out}/2_next.png` });
  await page.mouse.move(640, 380);
  await page.mouse.wheel(110, 0);
  await sleep(250);
  await rest();
  const wheeled = await snapshot();
  check('one horizontal wheel step selects the next frame', wheeled.state.current === next.state.current + 1, JSON.stringify(wheeled.state));
  assertTraversal('wheel traversal', next, wheeled);
  await assertSelection('wheel traversal', wheeled.state.key);

  await page.mouse.move(1100, 120);
  await sleep(900);
  const pointed = await snapshot();
  check('pointer movement keeps the prism camera orientation fixed', sameRotation(wheeled.geometry.camera.quaternion, pointed.geometry.camera.quaternion));
  check('pointer movement preserves resting frame poses', wheeled.geometry.frames.every((f, i) => near(f.position, pointed.geometry.frames[i].position) && sameRotation(f.quaternion, pointed.geometry.frames[i].quaternion)));

  // A slow, real drag advances one frame without triggering the existing velocity-based flick.
  await page.mouse.move(1020, 150);
  await page.mouse.down();
  await sleep(120);
  await page.mouse.move(988, 150);
  await sleep(180);
  const held = await snapshot();
  check('drag traverses fractional focus while the pointer is held', held.state.focus > pointed.state.focus && held.state.focus < pointed.state.focus + 1);
  assertTraversal('drag while held', pointed, held);
  await page.mouse.move(956, 150);
  await sleep(180);
  await page.mouse.up();
  await rest();
  const dragged = await snapshot();
  check('drag release snaps to the next chronological frame', dragged.state.current === pointed.state.current + 1, JSON.stringify(dragged.state));
  assertTraversal('drag release', pointed, dragged);
  await assertSelection('drag release', dragged.state.key);

  // Find an actually exposed image pixel. This preserves the normal click path through CSS 3D hit testing.
  const exposed = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.slide:not(.flying)')];
    const current = window.__wom.space.state().current;
    const candidates = all.map((el, index) => ({ el, index })).filter(({ index }) => index !== current)
      .sort((a, b) => Math.abs(a.index - current) - Math.abs(b.index - current));
    for (const { el, index } of candidates) {
      if (Number(getComputedStyle(el).opacity) < 0.05 || getComputedStyle(el).visibility === 'hidden') continue;
      const r = el.querySelector('.slide-face').getBoundingClientRect();
      for (const fx of [0.15, 0.35, 0.5, 0.65, 0.85]) for (const fy of [0.25, 0.5, 0.75]) {
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        if (x < 1 || y < 1 || x >= innerWidth - 1 || y >= innerHeight - 1) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit?.closest('.slide') === el && !hit.closest('.slide-reflection')) {
          return { x, y, index, key: window.__wom.space.keys()[index] };
        }
      }
    }
    return null;
  });
  check('a nonfocused plane exposes a real pointer target', !!exposed, JSON.stringify(exposed));
  if (exposed) {
    await page.mouse.click(exposed.x, exposed.y);
    await rest();
    const clicked = await snapshot();
    check('clicking an exposed plane stages it without starting world entry', clicked.state.extracted === exposed.key && clicked.state.extraction === 1 && clicked.state.mode === 'browse' && await page.evaluate(() => window.__played === null), JSON.stringify(clicked.state));
    assertExtraction('plane click', dragged, clicked, exposed.key);
    await page.keyboard.press('Escape');
    await rest();
    assertTraversal('dismiss plane selection', dragged, await snapshot());
  }

  await page.keyboard.press('Home');
  await rest();
  const first = await snapshot();
  assertTraversal('traversal to first', initial, first);
  await assertFront('first frame');
  await page.screenshot({ path: `${out}/3_first.png` });
  await page.keyboard.press('ArrowLeft');
  await rest();
  check('chronology stops at its first frame', (await snapshot()).state.current === 0);
  await page.keyboard.press('End');
  await rest();
  const last = await snapshot();
  assertTraversal('traversal to last', first, last);
  await assertFront('last frame');
  await page.screenshot({ path: `${out}/4_last.png` });
  await page.keyboard.press('ArrowRight');
  await rest();
  check('chronology stops at its last frame without wrapping', (await snapshot()).state.current === fixtures.length - 1);

  const created = await mount({ time: 'created', title: 'Movie keyframes' });
  check('created chronology uses its own timestamp ordering', nearKeys(created.keys, createdKeys), created.keys.join(' '));
  assertLayout('keyframe chronology', created);
  check('memory and keyframe browsing share identical spatial geometry', initial.geometry.spacing === created.geometry.spacing && JSON.stringify(initial.geometry.crossSection) === JSON.stringify(created.geometry.crossSection) && initial.geometry.frames.every((f, i) => near(f.position, created.geometry.frames[i].position) && sameRotation(f.quaternion, created.geometry.frames[i].quaternion)));

  // The real production flight, without navigating to a world or writing a saved slide.
  await mount({ time: 'taken', selected: takenKeys[3] });
  await page.keyboard.press('Enter');
  await rest();
  check('first Enter stages the selected plane before world entry', (await snapshot()).state.extracted === takenKeys[3] && await page.evaluate(() => window.__played === null));
  await page.evaluate(() => window.__setSpeed(0.1));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window.__wom.space.flight()?.u ?? 0) > 0.992, null, { timeout: 20000, polling: 'raf' });
  const landing = await page.evaluate(() => window.__wom.space.flight());
  const off = Math.max(Math.abs(landing.box.x - landing.rect.x), Math.abs(landing.box.y - landing.rect.y), Math.abs(landing.box.width - landing.rect.w), Math.abs(landing.box.height - landing.rect.h));
  check('Enter extraction lands on the existing viewer photo frame', off < 0.75, `${off.toFixed(4)} px`);
  await page.screenshot({ path: `${out}/5_flight_landing.png` });
  await page.evaluate(() => window.__setSpeed(1));
  await page.waitForFunction(() => window.__played, null, { timeout: 10000 });
  check('world-entry callback receives the selected frame and cover', await page.evaluate((key) => window.__played.key === key && window.__played.cover instanceof HTMLElement, takenKeys[3]));
  const returned = await page.evaluate((options) => {
    const { key, cover } = window.__played;
    window.__fixture.mount(options);
    return window.__fixture.returnFrom(key, cover);
  }, { slides, time: 'taken', selected: takenKeys[3] });
  check('existing return handoff accepts the extracted frame', returned);
  await rest();
  const back = await snapshot();
  check('return flight restores the staged frame and clears isolation', back.state.key === takenKeys[3] && back.state.extracted === takenKeys[3] && back.state.extraction === 1 && back.state.isolate === 0);
  assertExtraction('return flight', initial, back, takenKeys[3]);
  check('return flight removes temporary flyer and cover', await page.evaluate(() => document.querySelectorAll('.slide.flying,.slide-cover').length === 0));
  await assertFront('returned frame');
  await clickKeyhole('returned frame');

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await mount({ time: 'taken' });
  assertLayout('mobile mixed ratios', mobile);
  await assertFront('mobile mixed ratios');
  await page.keyboard.press('End');
  await rest();
  assertTraversal('mobile traversal', mobile, await snapshot());
  await page.screenshot({ path: `${out}/6_mobile.png` });
  await assertFront('mobile last frame');
  await clickKeyhole('mobile last frame');

  for (const [sizeName, size] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
    ['landscape', { width: 844, height: 390 }],
  ]) {
    await page.setViewportSize(size);
    const depth = await mount({ slides: depthSlides, selected: depthKeys[0], time: 'taken', title: '32 parallel image planes' });
    assertLayout(`${sizeName} long chronology`, depth);
    check(`${sizeName}: depth fixture contains at least 26 real planes`, depth.geometry.frames.length >= 26);
    for (const [positionName, index] of [['first', 0], ['middle', 15], ['last', 31]]) {
      await page.evaluate((key) => window.__wom.space.select(key), depthKeys[index]);
      await rest();
      const at = await snapshot();
      assertTraversal(`${sizeName} long chronology ${positionName}`, depth, at);
      await assertFront(`${sizeName} long chronology ${positionName}`);
      await page.screenshot({ path: `${out}/7_depth_${sizeName}_${positionName}.png` });
    }
    await clickKeyhole(`${sizeName} long chronology last`);
  }

  // Reduced motion keeps the same extraction endpoint and return handoff, with its existing shorter flight.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const calm = await mount({ time: 'taken', selected: takenKeys[3] });
  await page.keyboard.press('Enter');
  await rest();
  await page.evaluate(() => window.__setSpeed(0.1));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window.__wom.space.flight()?.u ?? 0) > 0.992, null, { timeout: 20000, polling: 'raf' });
  const calmLanding = await page.evaluate(() => window.__wom.space.flight());
  const calmOff = Math.max(Math.abs(calmLanding.box.x - calmLanding.rect.x), Math.abs(calmLanding.box.y - calmLanding.rect.y), Math.abs(calmLanding.box.width - calmLanding.rect.w), Math.abs(calmLanding.box.height - calmLanding.rect.h));
  check('reduced-motion extraction lands on the existing viewer photo frame', calmOff < 0.75, `${calmOff.toFixed(4)} px`);
  await page.evaluate(() => window.__setSpeed(1));
  await page.waitForFunction(() => window.__played, null, { timeout: 10000 });
  check('reduced-motion entry hands off the selected frame and cover', await page.evaluate((key) => window.__played.key === key && window.__played.cover instanceof HTMLElement, takenKeys[3]));
  const calmReturned = await page.evaluate((options) => {
    const { key, cover } = window.__played;
    window.__fixture.mount(options);
    return window.__fixture.returnFrom(key, cover);
  }, { slides, time: 'taken', selected: takenKeys[3] });
  check('reduced-motion return accepts the existing cover handoff', calmReturned);
  await rest();
  const calmBack = await snapshot();
  check('reduced-motion return restores the same staged frame', calmBack.state.key === takenKeys[3] && calmBack.state.extracted === takenKeys[3] && calmBack.state.extraction === 1 && calmBack.state.isolate === 0);
  assertExtraction('reduced-motion return', calm, calmBack, takenKeys[3]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.setViewportSize({ width: 390, height: 844 });
  const single = await mount({ slides: [fixtures[1]], selected: keyOf(fixtures[1]) });
  assertLayout('single portrait frame', single);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await rest();
  check('single-frame chronology remains on its frame', (await snapshot()).state.current === 0);
  const empty = await mount({ slides: [] });
  check('empty chronology preserves its empty state', empty.state.count === 0 && empty.geometry.frames.length === 0 && await page.locator('.space-empty').isVisible());
  check('no browser page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  stopped = err;
  throw err;
} finally {
  await browser.close();
  done(stopped);
}

function nearKeys(actual, expected) {
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
