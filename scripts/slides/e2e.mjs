// End to end, on the running app: save a view inside a world as a slide, find it in the world's sub space,
// play it (the flight must land on the viewer's frame, and the viewer must open at the slide's entry and see
// what its image shows), come back to the space (the return flight), open the year spaces, and remove the
// slide again from the space.
//
// It WRITES one slide into the world (through the real API) and removes it at the end, or on failure. If the
// process is killed in between, the slide stays: remove it with "Remove slide" in the world's space.
//
//   npm run slides:e2e -- [world id] [WxH] [tag]
//     world id  default: the first built world
//     WxH       the browser window (default 1440x900); the slide image takes its shape
//     tag       screenshots go to data/checks/slides/<tag> (default e2e)
//   Needs the app running (see BASE in browser.mjs) and Playwright (see PLAYWRIGHT_CORE there).
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { BASE, DATA_DIR, firstBuiltWorld, getJson, launch, outDir, parseSize, reporter, slowClock, sleep } from './browser.mjs';

const [worldArg, size = '1440x900', tag = 'e2e'] = process.argv.slice(2);
const [W, H] = parseSize(size);
const WORLD = worldArg ?? (await firstBuiltWorld());
const out = outDir(tag);
const { log, check, done } = reporter();
// The server's files, when it runs from this machine's data folder.
const local = existsSync(path.join(DATA_DIR, 'worlds', WORLD));
const slideFile = (id, suffix = '') => path.join(DATA_DIR, 'worlds', WORLD, 'slides', `${id}${suffix}.jpg`);

/**
 * Mean difference (0-255) and share of pixels off by more than 24, over the middle of two images at 720 wide.
 * With `dimmed`, `a` is first scaled to `b`'s brightness: the aperture darkens the photo while the world loads.
 * With `hole`, the keyhole and its label are left out.
 */
async function compare(a, b, dimmed = false, hole = null) {
  const w = 720, hh = Math.round((720 * H) / W);
  const load = (x) => sharp(x).resize(w, hh, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const [pa, pb] = await Promise.all([load(a), load(b)]);
  const ys = [Math.round(hh * 0.1), Math.round(hh * 0.86)], xs = [Math.round(w * 0.04), Math.round(w * 0.96)];
  const k = w / W;
  const skipped = (x, y) => hole && x >= hole.x0 * k && x <= hole.x1 * k && y >= hole.y0 * k && y <= hole.y1 * k;
  let gain = 1;
  if (dimmed) {
    let sa = 0, sb = 0;
    for (let y = ys[0]; y < ys[1]; y++) for (let x = xs[0]; x < xs[1]; x++) { if (skipped(x, y)) continue; for (let c = 0; c < 3; c++) { const i = (y * w + x) * 3 + c; sa += pa[i]; sb += pb[i]; } }
    gain = sb / sa;
  }
  let sum = 0, n = 0, big = 0;
  for (let y = ys[0]; y < ys[1]; y++) for (let x = xs[0]; x < xs[1]; x++) {
    if (skipped(x, y)) continue;
    const i = (y * w + x) * 3;
    const d = (Math.abs(pa[i] * gain - pb[i]) + Math.abs(pa[i + 1] * gain - pb[i + 1]) + Math.abs(pa[i + 2] * gain - pb[i + 2])) / 3;
    sum += d; n++; if (d > 24) big++;
  }
  return { mean: +(sum / n).toFixed(2), over24: +((100 * big) / n).toFixed(2), ...(dimmed ? { gain: +gain.toFixed(3) } : {}) };
}

const waysBefore = (await getJson(`/api/worlds/${WORLD}/slides`)).length;
log(`world ${WORLD} has ${waysBefore} way${waysBefore === 1 ? '' : 's'} in; ${BASE}`);
let made = null, stopped = null;
const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.addInitScript(slowClock);
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); log('[pageerror]', e.message); });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); log('[console.error]', m.text().slice(0, 240)); } });
  page.on('dialog', (d) => { log('[dialog]', d.message()); void d.accept(); });
  const grab = async (file) => {
    const b64 = await page.evaluate(async () => {
      const blob = await window.__wom.viewer.frame({ type: 'png' });
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const buf = Buffer.from(b64, 'base64');
    writeFileSync(`${out}/${file}.png`, buf);
    return buf;
  };
  // A hash change keeps the page (and the last space's window.__wom.space): wait for the new space's title.
  const openSpace = async (hash, title) => {
    await page.goto(`${BASE}/?debug${hash}`);
    await page.waitForFunction((t) => window.__wom?.space && document.querySelector('.space-titles h1')?.textContent === t, title, { timeout: 30000 });
  };
  const waitBrowse = (key) => page.waitForFunction((k) => {
    const s = window.__wom?.space?.state();
    return s && s.mode === 'browse' && (!k || s.key === k) && Math.abs(s.focus - s.target) < 0.001;
  }, key ?? null, { timeout: 30000, polling: 100 });

  // ---------- A. Inside the world: turn and step aside, then save the view as a slide ----------
  await page.goto(`${BASE}/u/-/${WORLD}?debug`);
  await page.waitForFunction(() => window.__wom?.viewer, null, { timeout: 60000 });
  check('the world opens to the portal', (await page.evaluate(() => window.__wom.viewer.ready(180000))) === 'portal');
  await page.evaluate(() => window.__wom.viewer.enter());
  await sleep(800);
  const pose = await page.evaluate(() => {
    const { THREE, camera } = window.__wom;
    const up = camera.up.clone().normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(up, THREE.MathUtils.degToRad(24)).multiply(camera.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const p = camera.position.clone().addScaledVector(fwd, 0.5);
    return { position: p.toArray(), quaternion: q.toArray() };
  });
  await page.evaluate((p) => { window.__wom.viewer.setPose(p); window.__wom.viewer.unfreeze(); }, pose);
  await sleep(1500);
  made = await page.evaluate(() => window.__wom.viewer.saveSlide());
  check('Save as slide made a view slide', Boolean(made?.id && made.kind === 'view'), made ? `${made.id} "${made.title}" ${made.image.width}x${made.image.height} focus=${made.entry.focus}` : 'null');
  if (!made) throw new Error('no slide');
  const key = `${WORLD}.${made.id}`;
  const ways = waysBefore + 1;
  const slideImg = Buffer.from(await (await fetch(`${BASE}${made.image.url}`)).arrayBuffer());
  writeFileSync(`${out}/a_slide_image.jpg`, slideImg);
  check('the slide image has the viewport shape', Math.abs(made.image.width / made.image.height - W / H) < 0.01, `${made.image.width}x${made.image.height}`);
  if (local) check('the files are on disk', existsSync(slideFile(made.id)) && existsSync(slideFile(made.id, '-thumb')));
  else log('skipped: the files on disk (the server does not run from this checkout)');

  // ---------- B. The spaces list it ----------
  await openSpace(`#/space?slide=${encodeURIComponent(key)}`, 'Memories');
  await waitBrowse(key);
  const allKeys = await page.evaluate(() => window.__wom.space.keys());
  check('the whole space shows the new slide', allKeys.includes(key), allKeys.join(' '));
  const waysIn = await page.evaluate(() => [...document.querySelectorAll('.space-actions a')].map((a) => [a.textContent, a.getAttribute('href')]));
  check('the slide in front offers its world\'s sub space', waysIn.some(([t, href]) => t === `All ${ways} ways in` && href === `#/space/world/${WORLD}`), JSON.stringify(waysIn));
  await openSpace(`#/space/world/${WORLD}?slide=${encodeURIComponent(key)}`, made.worldTitle);
  await waitBrowse(key);
  const sub = await page.evaluate(() => ({ keys: window.__wom.space.keys(), title: document.querySelector('.space-titles h1')?.textContent, trail: [...document.querySelectorAll('.space-crumb')].map((a) => [a.textContent, a.getAttribute('href')]) }));
  check('the world space has its photo first and the new view last', sub.keys.length === ways && sub.keys[0] === `${WORLD}.photo` && sub.keys.at(-1) === key, JSON.stringify(sub));
  check('the world space leads back to all memories', sub.trail.length === 1 && sub.trail[0][1] === '#/space', JSON.stringify(sub.trail));
  await sleep(600);
  await page.screenshot({ path: `${out}/b_world_space.png` });

  // ---------- C. Play the view: the flight lands on the frame; the viewer opens at the slide's entry ----------
  await page.evaluate(() => { window.__setSpeed(0.05); window.__samePage = true; });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window.__wom.space?.flight()?.u ?? 0) > 0.992, null, { timeout: 60000, polling: 'raf' });
  const landed = await page.evaluate(() => window.__wom.space.flight());
  await page.screenshot({ path: `${out}/c1_flight_end.png` });
  await page.evaluate(() => window.__setSpeed(1));
  const off = Math.max(Math.abs(landed.box.x - landed.rect.x), Math.abs(landed.box.y - landed.rect.y), Math.abs(landed.box.width - landed.rect.w), Math.abs(landed.box.height - landed.rect.h));
  check('the flight lands on the viewer\'s frame', off < 0.5, `off by ${off.toFixed(3)} px; ${JSON.stringify(landed.rect)}`);
  await page.waitForURL((u) => u.pathname.startsWith('/u/'), { timeout: 20000, waitUntil: 'commit' });
  await page.waitForSelector('header.viewer-top', { timeout: 60000 });
  const opened = await page.evaluate(() => ({ at: location.pathname + location.search, samePage: window.__samePage === true }));
  // The handle in the path is "-" until the viewer knows the owner's. ?debug, which this run has on, stays on the address.
  const wanted = new RegExp(`^/u/[a-z0-9-]+/${WORLD}\\?slide=${made.id}&from=world%2F${WORLD}&debug=?$`);
  check('the viewer is opened for the slide, from the world space', wanted.test(opened.at), opened.at);
  // A page load would drop the cover the slide flew up with (and ?debug): the play must stay on the page.
  check('playing keeps the page, so the slide\'s cover reaches the viewer', opened.samePage);
  await page.waitForFunction(() => window.__wom?.viewer, null, { timeout: 60000 });
  await sleep(300);
  await page.screenshot({ path: `${out}/c2_viewer_loading.png` });
  // While the world loads the opening is an opaque dark pane with a glowing outline, a dot under it and a label
  // under that: leave those out (the pane's box with a margin for the glow and the dot, and the label) and
  // compare the rest of the picture.
  const hole = await page.evaluate(() => {
    const plate = [...document.querySelectorAll('.aperture path')].find((p) => (p.getAttribute('fill') ?? '').endsWith('-plate)'));
    const label = document.querySelector('.aperture-status')?.getBoundingClientRect();
    if (!plate || !label) return null;
    const b = plate.getBBox(), o = plate.ownerSVGElement.getBoundingClientRect(), pad = 0.3 * b.height;
    return { x0: Math.min(o.left + b.x - pad, label.left - 12), y0: o.top + b.y - pad, x1: Math.max(o.left + b.x + b.width + pad, label.right + 12), y1: Math.max(o.top + b.y + b.height + pad, label.bottom + 12) };
  });
  check('the opening shows as a plate with a label while loading', hole !== null, JSON.stringify(hole));
  const loadingVsSlide = await compare(slideImg, `${out}/c2_viewer_loading.png`, true, hole);
  check('while loading, the viewer shows the slide\'s image around the opening (darkened by the loading veil)', loadingVsSlide.mean < 6 && loadingVsSlide.gain > 0.6, JSON.stringify(loadingVsSlide));
  check('the viewer opens to the portal', (await page.evaluate(() => window.__wom.viewer.ready(180000))) === 'portal');
  const v = await page.evaluate(() => ({ entry: window.__wom.viewer.entry(), home: window.__wom.viewer.home(), photo: document.querySelector('.memory-photo')?.getAttribute('src') }));
  const near = (a, b, eps) => a.every((x, i) => Math.abs(x - b[i]) < eps);
  check('its entry is the slide\'s', near(v.entry.position, made.entry.position, 1e-6) && near(v.entry.quaternion, made.entry.quaternion, 1e-6) && v.entry.fovY === made.entry.fovY, JSON.stringify(v.entry));
  check('its home pose is the entry', near(v.home.position, made.entry.position, 1e-5) && (near(v.home.quaternion, made.entry.quaternion, 1e-5) || near(v.home.quaternion, made.entry.quaternion.map((x) => -x), 1e-5)), JSON.stringify(v.home));
  check('its memory is the slide\'s image', v.photo === made.image.url, v.photo);
  // What the camera sees from the entry, against the slide's image; and from the photo's entry, for contrast.
  await page.evaluate(() => window.__wom.viewer.enter());
  await page.evaluate((p) => window.__wom.viewer.setPose(p), { position: v.home.position, quaternion: v.home.quaternion });
  await sleep(1800);
  const atEntry = await grab('c3_render_at_entry');
  await page.evaluate(() => window.__wom.viewer.setPose({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }));
  await sleep(1800);
  const atPhoto = await grab('c4_render_at_photo_entry');
  const dEntry = await compare(atEntry, slideImg), dPhoto = await compare(atPhoto, slideImg);
  check('from the entry the world looks like the slide', dEntry.mean < 6 && dEntry.mean * 3 < dPhoto.mean, `entry ${JSON.stringify(dEntry)} vs photo's entry ${JSON.stringify(dPhoto)}`);
  await page.evaluate((p) => { window.__wom.viewer.setPose(p); window.__wom.viewer.unfreeze(); }, { position: v.home.position, quaternion: v.home.quaternion });

  // ---------- D. Back to the space: the slide flies home ----------
  await page.evaluate(() => window.__setSpeed(0.1));
  // The link names the app's own address (the root), so it also leads home from a world's path.
  const backHref = await page.evaluate(() => document.querySelector('.viewer-top a.back')?.href);
  check('the back arrow goes to the world space, on the slide', backHref === `${BASE}/#/space/world/${WORLD}?slide=${encodeURIComponent(key)}`, backHref);
  await page.click('.viewer-top a.back');
  await page.waitForFunction(() => window.__wom?.space?.flight()?.dir === -1, null, { timeout: 20000, polling: 'raf' });
  for (let i = 0; i < 4; i++) {
    await sleep(2400);
    await page.screenshot({ path: `${out}/d_return_${i}.png` });
  }
  await page.evaluate(() => window.__setSpeed(1));
  await waitBrowse(key);
  await sleep(400);
  const after = await page.evaluate(() => ({ s: window.__wom.space.state(), covers: document.querySelectorAll('.slide-cover').length, flyers: document.querySelectorAll('.slide.flying').length }));
  check('the space comes back to rest on the slide', after.s.key === key && after.s.isolate === 0, JSON.stringify(after.s));
  check('no cover or flying slide is left', after.covers === 0 && after.flyers === 0, JSON.stringify(after));
  await page.screenshot({ path: `${out}/d_back.png` });

  // ---------- E. Year spaces ----------
  const year = new Date(made.takenAt).getFullYear();
  await openSpace(`#/space/year/${year}`, String(year));
  const yearKeys = await page.evaluate(() => window.__wom.space.keys());
  const expected = (await getJson('/api/slides')).filter((s) => new Date(s.takenAt).getFullYear() === year).length;
  check(`the ${year} space holds that year's slides`, yearKeys.length === expected && yearKeys.includes(key), `${yearKeys.length} of ${expected}`);
  await page.goto(`${BASE}/?debug#/space/year/1999`);
  await page.waitForSelector('.space-empty', { timeout: 30000 });
  check('an empty year shows the empty state', true);
  await page.goto(`${BASE}/?debug#/space/nowhere`);
  await page.waitForFunction(() => location.hash === '#/space', null, { timeout: 30000 });
  check('an unknown space goes to all memories', true);

  // ---------- F. Remove the view from its world space ----------
  await openSpace(`#/space/world/${WORLD}?slide=${encodeURIComponent(key)}`, made.worldTitle);
  await waitBrowse(key);
  await page.click('.space-actions button:has-text("Remove slide")');
  await page.waitForFunction((n) => window.__wom.space.keys().length === n, ways - 1, { timeout: 20000 });
  const left = await getJson(`/api/worlds/${WORLD}/slides`);
  check('the slide is gone from the world', !left.some((s) => s.id === made.id) && left.length === waysBefore, left.map((s) => s.id).join(' '));
  if (local) check('and its files are gone', !existsSync(slideFile(made.id)) && !existsSync(slideFile(made.id, '-thumb')));
  made = null;
  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  stopped = err;
  throw err;
} finally {
  if (made) {
    const r = await fetch(`${BASE}/api/worlds/${WORLD}/slides/${made.id}`, { method: 'DELETE' }).catch((e) => e);
    log('cleanup: removed the test slide', r.status ?? r.message);
  }
  await browser.close();
  done(stopped);
}
