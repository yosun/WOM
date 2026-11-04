// Zoom, staged lateral extraction, and the existing keyhole handoff, using the production component.
// Requires Vite and the browser setup in browser.mjs; no API, saved worlds, or data writes are needed.
//
//   node scripts/slides/spatial.mjs [tag]
//   Screenshots: data/checks/slides/<tag> (default spatial).
import { BASE, launch, outDir, reporter, slowClock, sleep } from './browser.mjs';

const [tag = 'spatial'] = process.argv.slice(2);
const out = outDir(tag);
const { check, done } = reporter();
const near = (a, b, eps = 1e-5) => a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) < eps);
const sameRotation = (a, b) => near(a, b) || near(a, b.map((n) => -n));
const keyOf = (slide) => `${slide.world}.${slide.id}`;

const sizes = [[1600, 900], [900, 1600], [1000, 1000], [2100, 900], [1200, 900], [900, 1200], [1800, 1000], [1400, 900]];
function fixture([width, height], i, count) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${i * 43} 55% 38%)"/><stop offset="1" stop-color="hsl(${i * 43 + 70} 45% 12%)"/></linearGradient></defs><path fill="url(#g)" d="M0 0H${width}V${height}H0z"/><circle cx="${width * 0.72}" cy="${height * 0.3}" r="${height * 0.16}" fill="#ffd8a0" opacity=".6"/><path d="M0 ${height * 0.8}L${width * 0.35} ${height * 0.4}L${width * 0.65} ${height * 0.75}L${width} ${height * 0.5}V${height}H0" fill="#102d30"/><text x="${width * 0.08}" y="${height * 0.2}" font-family="sans-serif" font-size="${height * 0.1}" fill="white">Memory ${i + 1}</text></svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  return {
    id: 'photo', world: `fixture${i}`, worldTitle: `Memory ${i + 1}`, kind: 'photo', title: 'The photo',
    // Equal timestamps exercise stable sorting; creation chronology deliberately runs the other way.
    takenAt: new Date(Date.UTC(2025, 0, (i === 3 ? 2 : i) + 1)).toISOString(),
    createdAt: new Date(Date.UTC(2026, 0, count - i)).toISOString(),
    image: { url, thumb: url, width, height },
    entry: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: 50, aspect: width / height },
  };
}
const ordered = sizes.map((size, i) => fixture(size, i, sizes.length));
const slides = [5, 2, 7, 0, 4, 1, 6, 3].map((i) => ordered[i]);
const keys = ordered.map(keyOf);
const longSlides = Array.from({ length: 32 }, (_, i) => fixture([1600, 900], i, 32));
const longKeys = longSlides.map(keyOf);
const harness = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#mount{position:absolute;inset:0;width:100%;height:100%}</style></head><body><main id="mount" class="space-page"></main><script type="module">
import { createSlideSpace } from '/src/slides/space.ts';
let space;
window.__fixture = {
  mount(options) {
    space?.dispose();
    document.querySelector('#mount').replaceChildren();
    window.__played = null;
    window.__selected = [];
    space = createSlideSpace(document.querySelector('#mount'), { title: 'A spatial archive', ...options,
      onSelect(doc) { window.__selected.push(doc.world + '.' + doc.id); },
      onPlay(doc, cover) { window.__played = { key: doc.world + '.' + doc.id, cover }; },
    });
  },
  returnFrom(key, cover) { return space.returnFrom(key, cover); },
};
window.__fixtureReady = true;
</script></body></html>`;

const browser = await launch();
let stopped;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(slowClock);
  await page.route('**/__spatial-check.html*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: harness }));
  await page.goto(`${BASE}/__spatial-check.html?debug`);
  await page.waitForFunction(() => window.__fixtureReady, null, { timeout: 30000 });

  const rest = () => page.waitForFunction(() => {
    const s = window.__wom?.space?.state();
    return s?.mode === 'browse' && Math.abs(s.focus - s.target) < 0.0001 &&
      s.zoom === s.zoomTarget && s.extraction === s.extractionTarget &&
      (s.extractionTarget !== 0 || s.extracted === null);
  }, null, { timeout: 20000 });
  const snapshot = () => page.evaluate(() => ({ state: window.__wom.space.state(), geometry: window.__wom.space.geometry(), keys: window.__wom.space.keys() }));
  const mount = async (options = {}) => {
    await page.evaluate((opts) => window.__fixture.mount(opts), { slides, time: 'taken', selected: keys[3], ...options });
    await rest();
    await sleep(70); // ResizeObserver and the first rendered frame follow the synchronous API installation.
    return snapshot();
  };
  const zoom = async (amount) => {
    await page.evaluate((amount) => window.__wom.space.zoom(amount), amount);
    await rest();
    return snapshot();
  };
  const archiveRect = () => page.locator('.space-archive').evaluate((el) => el.getBoundingClientRect().toJSON());
  const planeRect = () => page.evaluate(() => document.querySelector('.slide.is-extracted .slide-img')?.getBoundingClientRect().toJSON());
  const assertLayout = (name, snap) => {
    const { frames, spacing } = snap.geometry;
    const resting = frames.filter((f) => f.key !== snap.state.extracted);
    check(`${name}: every image plane remains parallel`, frames.every((f) => sameRotation(f.quaternion, frames[0].quaternion)));
    check(`${name}: resting images occupy a uniform straight temporal axis`, resting.every((f) => {
      const i = snap.keys.indexOf(f.key);
      return near(f.position, [i * spacing, resting[0].position[1], resting[0].position[2]]);
    }), JSON.stringify(resting.map((f) => f.position)));
    const q = frames[0]?.quaternion;
    if (q) {
      const [x, y, z, w] = q;
      const normal = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
      check(`${name}: image planes are perpendicular to X`, Math.abs(Math.abs(normal[0]) - 1) < 1e-5 && Math.abs(normal[1]) < 1e-5 && Math.abs(normal[2]) < 1e-5);
    }
  };
  const assertUnchanged = (name, before, after) => {
    check(`${name}: navigation preserves image poses`, before.geometry.frames.every((f, i) => near(f.position, after.geometry.frames[i].position) && sameRotation(f.quaternion, after.geometry.frames[i].quaternion)));
    check(`${name}: camera keeps its orientation`, sameRotation(before.geometry.camera.quaternion, after.geometry.camera.quaternion));
  };
  const findHit = async (selector, avoidMark = false) => page.evaluate(({ selector, avoidMark }) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    for (const fx of [0.5, 0.35, 0.65, 0.2, 0.8]) for (const fy of [0.5, 0.3, 0.7]) {
      const x = r.x + r.width * fx, y = r.y + r.height * fy;
      if (x < 1 || y < 1 || x >= innerWidth - 1 || y >= innerHeight - 1) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit)) && (!avoidMark || !hit.closest('.slide-mark'))) return { x, y };
    }
    return null;
  }, { selector, avoidMark });
  const extractByPointer = async (name) => {
    const hit = await findHit('.slide.is-front .slide-face', true);
    check(`${name}: focused plane has an exposed pointer target`, !!hit, JSON.stringify(hit));
    if (!hit) throw new Error(`${name}: no focused plane pointer target`);
    await page.evaluate(() => {
      window.__sampleExtraction = true;
      window.__extractionSamples = [];
      const sample = () => {
        if (!window.__sampleExtraction) return;
        const api = window.__wom.space;
        window.__extractionSamples.push({ state: api.state(), geometry: api.geometry() });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.mouse.click(hit.x, hit.y);
    await rest();
    const snap = await snapshot();
    const intermediate = await page.evaluate(() => {
      window.__sampleExtraction = false;
      return window.__extractionSamples.filter((s) => s.state.extraction > 0.01 && s.state.extraction < 0.99);
    });
    check(`${name}: first plane click stages selection without entering a world`, snap.state.extracted === snap.state.key && snap.state.extraction > 0.999 && snap.state.mode === 'browse' && await page.evaluate(() => window.__played === null), JSON.stringify(snap.state));
    check(`${name}: extraction animates smoothly through intermediate poses`, intermediate.length >= 3, `${intermediate.length} rendered intermediate poses`);
    check(`${name}: intermediate extraction poses keep planes parallel`, intermediate.every((s) => s.geometry.frames.every((f) => sameRotation(f.quaternion, s.geometry.frames[0].quaternion))));
    return snap;
  };
  const assertExtracted = async (name, before, after) => {
    const i = after.keys.indexOf(after.state.extracted);
    const a = before.geometry.frames[i], b = after.geometry.frames[i];
    check(`${name}: selected image slides only along positive Z`, Math.abs(a.position[0] - b.position[0]) < 1e-5 && Math.abs(a.position[1] - b.position[1]) < 1e-5 && b.position[2] > a.position[2] && sameRotation(a.quaternion, b.quaternion), JSON.stringify({ before: a.position, after: b.position }));
    check(`${name}: other planes retain their resting positions`, before.geometry.frames.every((f, n) => n === i || near(f.position, after.geometry.frames[n].position)));
    const stage = await planeRect();
    check(`${name}: staged plane is large and centered in the available screen`, !!stage && stage.width > 144 && stage.height > 120 && stage.x + stage.width / 2 > 144 && stage.x + stage.width / 2 < 1296 && stage.y + stage.height / 2 > 100 && stage.y + stage.height / 2 < 810, JSON.stringify(stage));
    assertLayout(name, after);
  };
  const assertWorldEntry = async (name, key) => {
    await page.evaluate(() => window.__setSpeed(0.1));
    const hit = await findHit('.slide.is-extracted .keyhole-mark-hit');
    check(`${name}: staged keyhole receives a real pointer click`, !!hit, JSON.stringify(hit));
    if (!hit) throw new Error(`${name}: no staged keyhole pointer target`);
    await page.mouse.click(hit.x, hit.y);
    check(`${name}: second click starts the existing world-entry flight`, (await snapshot()).state.mode === 'flying');
    await page.waitForFunction(() => (window.__wom.space.flight()?.u ?? 0) > 0.992, null, { timeout: 20000, polling: 'raf' });
    const landing = await page.evaluate(() => window.__wom.space.flight());
    const off = Math.max(Math.abs(landing.box.x - landing.rect.x), Math.abs(landing.box.y - landing.rect.y), Math.abs(landing.box.width - landing.rect.w), Math.abs(landing.box.height - landing.rect.h));
    check(`${name}: flight lands exactly on the viewer photo frame`, off < 0.75, `${off.toFixed(4)} px`);
    await page.screenshot({ path: `${out}/${name.replaceAll(' ', '_')}_flight.png` });
    await page.evaluate(() => window.__setSpeed(1));
    await page.waitForFunction(() => window.__played, null, { timeout: 10000 });
    check(`${name}: entry callback preserves frame identity and cover`, await page.evaluate((key) => window.__played.key === key && window.__played.cover instanceof HTMLElement, key));
  };

  let initial = await mount();
  check('memory chronology stably sorts its timestamps', JSON.stringify(initial.keys) === JSON.stringify(keys));
  assertLayout('focused archive', initial);
  await page.screenshot({ path: `${out}/1_focused.png` });
  const close = await zoom(0);
  await page.evaluate(() => {
    window.__sampleZoom = true;
    window.__zoomSamples = [];
    const sample = () => {
      if (!window.__sampleZoom) return;
      window.__zoomSamples.push(window.__wom.space.state().zoom);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const overview = await zoom(1);
  const zoomSamples = await page.evaluate(() => {
    window.__sampleZoom = false;
    return window.__zoomSamples.filter((z) => z > 0.01 && z < 0.99);
  });
  check('zoom smoothly contracts through intermediate prism scales', zoomSamples.length >= 3 && zoomSamples.every((z, i) => i === 0 || z >= zoomSamples[i - 1]), `${zoomSamples.length} rendered intermediate scales`);
  check('zoom contracts the uniform plane spacing for overview', overview.geometry.spacing < close.geometry.spacing && overview.geometry.spacing > 0, JSON.stringify({ close: close.geometry.spacing, overview: overview.geometry.spacing }));
  check('zoom does not rotate any image planes', close.geometry.frames.every((f, i) => sameRotation(f.quaternion, overview.geometry.frames[i].quaternion)));
  assertLayout('overview archive', overview);
  await page.screenshot({ path: `${out}/2_overview.png` });
  await zoom(0.5);
  const beforeWheel = await snapshot();
  await page.mouse.move(700, 400);
  await page.mouse.wheel(0, 220);
  await rest();
  const afterWheel = await snapshot();
  check('vertical wheel zooms the prism without changing chronology focus', afterWheel.state.zoom > beforeWheel.state.zoom && afterWheel.state.current === beforeWheel.state.current, JSON.stringify({ before: beforeWheel.state, after: afterWheel.state }));
  await page.evaluate(() => document.querySelector('.space').dispatchEvent(new WheelEvent('wheel', { deltaY: -160, ctrlKey: true, bubbles: true, cancelable: true })));
  await rest();
  const ctrlWheel = await snapshot();
  check('trackpad pinch wheel zooms toward the focused view', ctrlWheel.state.zoom < afterWheel.state.zoom && ctrlWheel.state.current === afterWheel.state.current);
  await page.mouse.wheel(110, 0);
  await sleep(200);
  await rest();
  const traversed = await snapshot();
  check('horizontal wheel retains chronological navigation', traversed.state.current === ctrlWheel.state.current + 1, JSON.stringify(traversed.state));
  assertUnchanged('horizontal wheel', ctrlWheel, traversed);
  await page.keyboard.press('ArrowLeft');
  await rest();
  const keyed = await snapshot();
  check('arrow key retains chronological navigation', keyed.state.current === ctrlWheel.state.current);
  assertUnchanged('arrow key', traversed, keyed);

  initial = await zoom(0);
  const fullArchive = await archiveRect();
  const extracted = await extractByPointer('desktop selection');
  await assertExtracted('desktop selection', initial, extracted);
  const smallArchive = await archiveRect();
  check('selection smoothly shrinks the archive into the upper left', smallArchive.width < fullArchive.width * 0.8 && smallArchive.height < fullArchive.height * 0.8 && smallArchive.x + smallArchive.width / 2 < fullArchive.x + fullArchive.width / 2 && smallArchive.y + smallArchive.height / 2 < fullArchive.y + fullArchive.height / 2, JSON.stringify({ full: fullArchive, small: smallArchive }));
  await page.screenshot({ path: `${out}/3_extracted.png` });
  await page.keyboard.press('Escape');
  await rest();
  const dismissed = await snapshot();
  check('Escape returns the staged plane without triggering navigation', dismissed.state.extracted === null && dismissed.state.extraction < 0.001 && dismissed.state.mode === 'browse');
  assertUnchanged('dismiss selection', initial, dismissed);

  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  check('repeated activation waits for the extraction to settle', (await snapshot()).state.mode === 'browse' && await page.evaluate(() => window.__played === null));
  await rest();
  await assertWorldEntry('desktop', keys[3]);
  const returned = await page.evaluate((options) => {
    const { key, cover } = window.__played;
    window.__fixture.mount(options);
    return window.__fixture.returnFrom(key, cover);
  }, { slides, time: 'taken', selected: keys[3] });
  check('world return accepts the existing selected-image cover handoff', returned);
  await rest();
  const back = await snapshot();
  check('world return restores the staged selection', back.state.key === keys[3] && back.state.extracted === keys[3] && back.state.extraction > 0.999 && back.state.isolate === 0, JSON.stringify(back.state));
  check('world return clears the temporary flyer and cover', await page.evaluate(() => document.querySelectorAll('.slide.flying,.slide-cover').length === 0));
  await page.screenshot({ path: `${out}/4_returned.png` });

  const created = await mount({ time: 'created' });
  const taken = await mount({ time: 'taken' });
  check('movie-keyframe chronology uses its creation timestamps', JSON.stringify(created.keys) === JSON.stringify([...keys].reverse()));
  check('movie and memory chronology share the same geometry', near(created.geometry.frames.flatMap((f) => f.position), taken.geometry.frames.flatMap((f) => f.position)) && created.geometry.frames.every((f, i) => sameRotation(f.quaternion, taken.geometry.frames[i].quaternion)));

  for (const [name, size] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]]) {
    await page.setViewportSize(size);
    await mount({ slides: longSlides, selected: longKeys[0] });
    const all = await zoom(1);
    assertLayout(`${name} 32-plane overview`, all);
    const envelope = await page.evaluate(() => {
      const planes = [...document.querySelectorAll('.slide:not(.flying)')];
      const boxes = planes.map((el) => el.querySelector('.slide-img').getBoundingClientRect());
      return { count: planes.length, visible: planes.filter((el) => getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.005).length,
        fits: boxes.every((r) => r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1),
        box: { x: Math.min(...boxes.map((r) => r.x)), y: Math.min(...boxes.map((r) => r.y)), right: Math.max(...boxes.map((r) => r.right)), bottom: Math.max(...boxes.map((r) => r.bottom)) } };
    });
    check(`${name}: overview fits the complete finite collection`, envelope.count === 32 && envelope.visible === 32 && envelope.fits, JSON.stringify(envelope));
    await page.screenshot({ path: `${out}/5_${name}_all.png` });
    await zoom(0);
    for (const [position, index] of [['first', 0], ['middle', 15], ['last', 31]]) {
      await page.evaluate((key) => window.__wom.space.select(key), longKeys[index]);
      await rest();
      const at = await snapshot();
      check(`${name}: ${position} navigation selects its exact finite index`, at.state.current === index && at.state.extracted === null);
      assertLayout(`${name} ${position}`, at);
      await page.screenshot({ path: `${out}/6_${name}_${position}.png` });
    }
    await page.keyboard.press('ArrowRight');
    await rest();
    check(`${name}: chronology stops at the last frame`, (await snapshot()).state.current === 31);
    await page.keyboard.press('Home');
    await rest();
    await page.keyboard.press('ArrowLeft');
    await rest();
    check(`${name}: chronology stops at the first frame`, (await snapshot()).state.current === 0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await mount({ slides: longSlides, selected: longKeys[15] });
  await zoom(0.5);
  const cdp = await context.newCDPSession(page);
  const points = (span) => [{ x: 195 - span / 2, y: 390, id: 1, radiusX: 3, radiusY: 3, force: 1 }, { x: 195 + span / 2, y: 390, id: 2, radiusX: 3, radiusY: 3, force: 1 }];
  const beforePinch = await snapshot();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(160) });
  for (const span of [145, 125, 105, 85]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(span) });
    await sleep(30);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await rest();
  const afterPinch = await snapshot();
  check('two-finger pinch contracts the prism toward overview', afterPinch.state.zoom > beforePinch.state.zoom && afterPinch.state.current === beforePinch.state.current, JSON.stringify({ before: beforePinch.state, after: afterPinch.state }));
  assertLayout('mobile pinch', afterPinch);
  await page.screenshot({ path: `${out}/7_mobile_pinch.png` });

  await zoom(0.3);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 285, y: 500, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 205, y: 500, id: 1 }] });
  const beforeCancel = await snapshot();
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await rest();
  const cancelled = await snapshot();
  check('pointer cancellation snaps without applying flick momentum', cancelled.state.target === Math.max(0, Math.min(31, Math.round(beforeCancel.state.target))), JSON.stringify({ before: beforeCancel.state, after: cancelled.state }));
  check('pointer cancellation clears dragging presentation', await page.locator('.space.dragging').count() === 0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await mount();
  await page.evaluate((key) => window.__wom.space.extract(key), keys[3]);
  await rest();
  const resizedSource = await snapshot();
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(160);
  await rest();
  const resized = await snapshot();
  check('resize preserves selected frame identity and lateral pose', resized.state.extracted === keys[3] && resizedSource.geometry.frames.every((f, i) => near(f.position, resized.geometry.frames[i].position) && sameRotation(f.quaternion, resized.geometry.frames[i].quaternion)));
  const resizedBox = await planeRect();
  check('resize keeps staged image inside the mobile viewport', !!resizedBox && resizedBox.left >= -1 && resizedBox.top >= -1 && resizedBox.right <= 391 && resizedBox.bottom <= 845, JSON.stringify(resizedBox));
  await page.screenshot({ path: `${out}/8_mobile_selected.png` });
  await assertWorldEntry('mobile', keys[3]);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mount();
  await page.keyboard.press('Enter');
  await rest();
  const calm = await snapshot();
  check('reduced-motion Enter stages the same selected image', calm.state.extracted === keys[3] && calm.state.mode === 'browse' && await page.evaluate(() => window.__played === null));
  await assertWorldEntry('reduced motion', keys[3]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await page.setViewportSize({ width: 390, height: 844 });
  await mount({ slides: [ordered[1]], selected: keys[1] });
  const single = await zoom(1);
  assertLayout('single portrait frame', single);
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await rest();
  check('single-frame archive remains finite through zoom and navigation', (await snapshot()).state.current === 0);
  await page.evaluate((key) => window.__wom.space.extract(key), keys[1]);
  await rest();
  const portrait = await planeRect();
  check('portrait selection preserves its image aspect ratio', !!portrait && Math.abs(portrait.width / portrait.height - 900 / 1600) < 0.04, JSON.stringify(portrait));
  await page.evaluate(() => window.__wom.space.dismiss());
  await rest();
  const empty = await mount({ slides: [] });
  check('empty archive preserves its empty state', empty.state.count === 0 && empty.geometry.frames.length === 0 && await page.locator('.space-empty').isVisible());
  await page.evaluate(() => { window.__wom.space.zoom(1); window.__wom.space.play(); window.__wom.space.dismiss(); });
  check('empty archive ignores selection and zoom safely', await page.evaluate(() => window.__played === null));
  check('browser reports no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  stopped = err;
  throw err;
} finally {
  await browser.close();
  done(stopped);
}
