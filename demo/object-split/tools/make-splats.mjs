// Convert the saved PLY parts to SPZ for the web, with Spark's own encoder (transcodeSpz) run in headless Chromium.
//   node demo/object-split/tools/make-splats.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { loadChromium } from './playwright.mjs'; // Playwright only runs Spark in a headless browser; see playwright.mjs for how it is found
const chromium = await loadChromium();

const ROOT = process.cwd();
const PLY = `${ROOT}/demo/object-split/parts/splats/ply`, OUT = `${ROOT}/demo/object-split/assets/splats`;
const JOBS = [
  ['one-object', 'one-object.idol.ply'], ['head', 'head.aligned.ply'], ['head-eyes', 'head.aligned-eyes.ply'], ['body', 'body.aligned.ply'],
];
const FRACTIONAL_BITS = Number(process.env.FRACTIONAL_BITS ?? 14);
const VERSION = Number(process.env.SPZ_VERSION ?? 3);
fs.mkdirSync(OUT, { recursive: true });

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/three/three.module.js","three/addons/":"/three-addons/"}}</script>
<script type="module">
import { transcodeSpz } from '/spark/spark.module.js';
window.__spz = async (url, fractionalBits, version) => {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const out = await transcodeSpz({ inputs: [{ fileBytes: bytes, fileType: 'ply' }], maxSh: 0, fractionalBits, version });
  let s = ''; const b = out.fileBytes;
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
window.__ready = true;
</script>`;
const DIRS = { '/three/': `${ROOT}/node_modules/three/build/`, '/three-addons/': `${ROOT}/node_modules/three/examples/jsm/`, '/spark/': `${ROOT}/node_modules/@sparkjsdev/spark/dist/`, '/ply/': `${PLY}/` };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(PAGE); }
  for (const [prefix, dir] of Object.entries(DIRS)) if (url.pathname.startsWith(prefix)) {
    const file = path.resolve(dir, '.' + url.pathname.slice(prefix.length - 1));
    if (file.startsWith(dir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', 'Content-Length': fs.statSync(file).size });
      return fs.createReadStream(file).pipe(res);
    }
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.__ready, null, { timeout: 60_000 });
  for (const [name, ply] of JOBS) {
    const t0 = Date.now();
    const b64 = await page.evaluate(([u, fb, v]) => window.__spz(u, fb, v), [`/ply/${ply}`, FRACTIONAL_BITS, VERSION]);
    const bytes = Buffer.from(b64, 'base64');
    fs.writeFileSync(`${OUT}/${name}.spz`, bytes);
    const raw = gunzipSync(bytes), dv = new DataView(raw.buffer, raw.byteOffset);
    console.log(`${name}.spz: ${(bytes.length / 1e6).toFixed(2)} MB from ${(fs.statSync(`${PLY}/${ply}`).size / 1e6).toFixed(1)} MB; SPZ v${dv.getUint32(4, true)}, ${dv.getUint32(8, true)} Gaussians, ${dv.getUint8(13)} fractional bits (${Date.now() - t0} ms)`);
  }
} finally {
  await browser.close();
  server.close();
}
