// Render the demo's images with Spark (the viewer's own splat renderer, same renderer settings as web/src/viewer.ts):
// the Marble world and the other four objects with the woman in each of four versions, from the photo's camera.
//   node demo/object-split/tools/render-frames.mjs [--check]
// --check renders one frame at the flagged camera and compares it with the capture taken in the real app.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { loadChromium } from './playwright.mjs'; // Playwright only runs Spark in a headless browser; see playwright.mjs for how it is found
const chromium = await loadChromium();

const ROOT = process.cwd();
const PARTS = `${ROOT}/demo/object-split/parts`, CLONE = `${ROOT}/data/worlds/mw16xplr29532e14`, ORIG = `${ROOT}/data/worlds/mvzp2tur93987dde`;
const OUT = `${ROOT}/.scratch/idol-split/demo/frames`;
const CHECK = process.argv.includes('--check');
fs.mkdirSync(OUT, { recursive: true });

const scene = JSON.parse(fs.readFileSync(`${CLONE}/scene.json`, 'utf8'));
const layout = JSON.parse(fs.readFileSync(`${PARTS}/placement/layout.json`, 'utf8')).objects;
const fitPoses = JSON.parse(fs.readFileSync(`${PARTS}/placement/silhouette-fit-poses.json`, 'utf8'));
const origScene = JSON.parse(fs.readFileSync(`${ORIG}/scene.json`, 'utf8'));
const pose = (o) => ({ position: o.position, quaternion: o.quaternion, scale: o.scale });
const L = (id) => pose(layout.find((o) => o.id === id));
const fitHead = fitPoses['split, compose fitter'].find((o) => o.name === 'woman-head'), fitBody = fitPoses['split, compose fitter'].find((o) => o.name === 'woman-body');
const oldWoman = origScene.objects.find((o) => o.id === 'smiling-woman-in-pink-un').placements.fitter;
const FOVY = scene.camera.fovY, W = 1699, H = 926;

// What stays the same in every picture: the Marble world and the other four objects.
const wsplat = scene.world.splats.find((s) => s.variant === '500k');
const shared = [{ file: `${CLONE}/${wsplat.url.replace(`/files/mw16xplr29532e14/`, '')}`, ...pose({ position: [0, 0, 0], quaternion: scene.world.quaternion, scale: scene.world.scale }) }];
for (const o of scene.objects) if (!o.id.startsWith('woman-')) shared.push({ file: `${CLONE}/${o.url.replace('/files/mw16xplr29532e14/', '')}`, ...pose(o) });
const P = (f) => `${PARTS}/splats/ply/${f}`;
const variants = {
  one: [{ file: P('one-object.idol.ply'), ...pose(oldWoman) }],
  fit: [{ file: P('head.idol-raw.ply'), ...pose(fitHead) }, { file: P('body.idol-raw.ply'), ...pose(fitBody) }],
  aligned: [{ file: P('head.aligned.ply'), ...L('woman-head') }, { file: P('body.aligned.ply'), ...L('woman-body') }],
  eyes: [{ file: P('head.aligned-eyes.ply'), ...L('woman-head') }, { file: P('body.aligned.ply'), ...L('woman-body') }],
};
const photoCam = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: FOVY, aspect: W / H, near: 0.02, far: 4000 };
const obs = JSON.parse(fs.readFileSync(`${ROOT}/data/bench/observations/mvzp2tur93987dde/omw1500c2cb7177/observation.json`, 'utf8'));
const FACE = { x: 480, y: 120, w: 600, h: 400 }, Z = 4; // the face crop the hero lens uses, at 4x
const EYES = [{ id: 'right', cx: 832, cy: 248 }, { id: 'left', cx: 711, cy: 289 }], EYE_WIN = { w: 260, h: 190 }, ZE = 6; // one window per eye, at 6x
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7);

const shots = [];
if (CHECK) {
  shots.push({ variant: 'eyes', name: 'check-flagged', camera: obs.camera, size: { w: obs.viewport.width, h: obs.viewport.height }, pixelRatio: obs.viewport.pixelRatio, captureWidth: 1600 });
} else {
  for (const v of Object.keys(variants)) {
    shots.push({ variant: v, name: `full-${v}`, camera: photoCam, size: { w: W, h: H }, pixelRatio: 2, captureWidth: W });
    shots.push({ variant: v, name: `face-${v}`, camera: photoCam, size: { w: FACE.w * Z, h: FACE.h * Z }, pixelRatio: 1, captureWidth: FACE.w * Z, viewOffset: { fullW: W * Z, fullH: H * Z, x: FACE.x * Z, y: FACE.y * Z, w: FACE.w * Z, h: FACE.h * Z } });
  }
  for (const v of ['one', 'aligned', 'eyes']) for (const e of EYES) {
    shots.push({ variant: v, name: `eye-${e.id}-${v}`, camera: photoCam, size: { w: EYE_WIN.w * ZE, h: EYE_WIN.h * ZE }, pixelRatio: 1, captureWidth: EYE_WIN.w * ZE, viewOffset: { fullW: W * ZE, fullH: H * ZE, x: (e.cx - EYE_WIN.w / 2) * ZE, y: (e.cy - EYE_WIN.h / 2) * ZE, w: EYE_WIN.w * ZE, h: EYE_WIN.h * ZE } });
  }
  if (ONLY) for (let i = shots.length - 1; i >= 0; i--) if (!shots[i].name.startsWith(ONLY)) shots.splice(i, 1);
}

// ---------- page ----------
const files = new Map(); const reg = (f) => { const ext = path.extname(f); const key = `/f/${files.size}${ext}`; files.set(key, f); return key; };
const cfg = {
  shared: shared.map((s) => ({ url: reg(s.file), ext: path.extname(s.file), position: s.position, quaternion: s.quaternion, scale: s.scale })),
  variants: Object.fromEntries(Object.entries(variants).map(([k, list]) => [k, list.map((s) => ({ url: reg(s.file), ext: path.extname(s.file), position: s.position, quaternion: s.quaternion, scale: s.scale }))])),
  shots,
};
const PAGE = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style>
<script type="importmap">{"imports":{"three":"/three/three.module.js","three/addons/":"/three-addons/"}}</script>
<script type="module">
import * as THREE from 'three';
import { SparkRenderer, SplatMesh } from '/spark/spark.module.js';
try {
  const cfg = await (await fetch('/cfg.json')).json();
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#050404');
  scene.add(new SparkRenderer({ renderer }));
  const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 4000);
  const make = (s) => { const g = new THREE.Group(); g.position.fromArray(s.position); g.quaternion.fromArray(s.quaternion); g.scale.setScalar(s.scale); const m = new SplatMesh({ url: s.url }); g.add(m); scene.add(g); return { g, m }; };
  const all = [];
  for (const s of cfg.shared) all.push(make(s));
  const byVariant = {};
  for (const [k, list] of Object.entries(cfg.variants)) { byVariant[k] = list.map(make); byVariant[k].forEach((x) => (x.g.visible = false)); all.push(...byVariant[k]); }
  await Promise.all(all.map((x) => x.m.initialized));
  (function loop() { renderer.render(scene, camera); requestAnimationFrame(loop); })();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  window.__shoot = async (i) => {
    const s = cfg.shots[i], c = s.camera;
    for (const [k, list] of Object.entries(byVariant)) list.forEach((x) => (x.g.visible = k === s.variant));
    renderer.setPixelRatio(s.pixelRatio);
    renderer.setSize(s.size.w, s.size.h);
    camera.fov = c.fovY; camera.aspect = c.aspect; camera.near = c.near; camera.far = c.far;
    camera.position.fromArray(c.position); camera.quaternion.fromArray(c.quaternion);
    if (s.viewOffset) camera.setViewOffset(s.viewOffset.fullW, s.viewOffset.fullH, s.viewOffset.x, s.viewOffset.y, s.viewOffset.w, s.viewOffset.h); else camera.clearViewOffset();
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    await sleep(6000); // Spark sorts the splats for this view
    await nextFrame();
    renderer.render(scene, camera);
    const src = renderer.domElement, width = Math.min(s.captureWidth, src.width), height = Math.round((src.height * width) / src.width);
    const copy = document.createElement('canvas'); copy.width = width; copy.height = height;
    copy.getContext('2d').drawImage(src, 0, 0, width, height);
    return copy.toDataURL('image/png');
  };
  window.__ready = true;
} catch (e) { window.__error = String((e && e.stack) || e); }
</script>`;
const DIRS = { '/three/': `${ROOT}/node_modules/three/build/`, '/three-addons/': `${ROOT}/node_modules/three/examples/jsm/`, '/spark/': `${ROOT}/node_modules/@sparkjsdev/spark/dist/` };
const MIME = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
  if (url.pathname === '/cfg.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(cfg)); }
  let file = files.get(url.pathname);
  if (!file) for (const [prefix, dir] of Object.entries(DIRS)) if (url.pathname.startsWith(prefix)) { const r = path.resolve(dir, '.' + url.pathname.slice(prefix.length - 1)); if (r.startsWith(dir)) file = r; }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { if (url.pathname !== '/favicon.ico') console.log('  404:', url.pathname); res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0)}s]`, ...a);
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => log('pageerror:', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) log('console.error:', m.text().slice(0, 200)); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__ready || window.__error, null, { timeout: 300_000, polling: 500 });
  const err = await page.evaluate(() => window.__error);
  if (err) throw new Error(`page failed: ${err}`);
  log(`loaded ${cfg.shared.length} shared and ${Object.values(cfg.variants).flat().length} woman splat files`);
  for (let i = 0; i < shots.length; i++) {
    const url = await page.evaluate((k) => window.__shoot(k), i);
    fs.writeFileSync(`${OUT}/${shots[i].name}.png`, Buffer.from(url.split(',')[1], 'base64'));
    log(`${shots[i].name}.png`);
  }
} finally {
  await browser.close();
  server.close();
}
if (CHECK) {
  const a = await sharp(`${OUT}/check-flagged.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(`${ROOT}/.scratch/idol-split/renders/app-eyes.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) throw new Error(`size mismatch ${a.info.width}x${a.info.height} vs ${b.info.width}x${b.info.height}`);
  let s = 0, big = 0; for (let i = 0; i < a.data.length; i++) { const d = Math.abs(a.data[i] - b.data[i]); s += d; if (d > 24) big++; }
  console.log(`harness vs the real app's frame (${a.info.width}x${a.info.height}): mean abs diff ${(s / a.data.length).toFixed(2)}/255; ${(100 * big / a.data.length).toFixed(3)}% of values differ by more than 24`);
}
