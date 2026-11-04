// Build everything the page loads that is not code: web images from the rendered frames, the photo's edge overlay,
// the vendored three.js / Spark files, and assets/data.json (every number on the page comes from a file, not from here).
//   node demo/object-split/tools/make-assets.mjs
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import displacement from './displacement.mjs';
import { EYES, FEATHER, distToEyes, eyeMetrics, loadRGB } from './eye-metrics.mjs';

const ROOT = process.cwd();
const DEMO = `${ROOT}/demo/object-split`, PARTS = `${DEMO}/parts`, A = `${DEMO}/assets`, IMG = `${A}/img`, FR = `${ROOT}/.scratch/idol-split/demo/frames`;
const W = 1699, H = 926, FACE = { x: 480, y: 120, w: 600, h: 400 }, Z = 4;
fs.mkdirSync(IMG, { recursive: true });
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const size = (f) => fs.statSync(f).size;

// ---------- images ----------
const VARIANTS = { photo: 'Photo', one: 'One object', fit: 'Split, silhouette fit', aligned: 'Split, pixel-aligned', eyes: 'Split + eye corrector' };
const webp = (q = 84) => ({ quality: q, effort: 5 });
for (const v of ['one', 'fit', 'aligned', 'eyes']) await sharp(`${FR}/full-${v}.png`).webp(webp(86)).toFile(`${IMG}/full-${v}.webp`);
await sharp(`${PARTS}/photo/source.jpg`).webp(webp(88)).toFile(`${IMG}/full-photo.webp`);
// the face at 4x: renders from Spark, and the photo's own crop enlarged the same way
await sharp(`${PARTS}/photo/source.jpg`).extract({ left: FACE.x, top: FACE.y, width: FACE.w, height: FACE.h }).resize(FACE.w * Z, FACE.h * Z, { kernel: 'lanczos3' }).webp(webp(86)).toFile(`${IMG}/face-photo.webp`);
for (const v of ['one', 'fit', 'aligned', 'eyes']) await sharp(`${FR}/face-${v}.png`).webp(webp(84)).toFile(`${IMG}/face-${v}.webp`);
// one window per eye at 6x: Spark renders for the three versions, and the photo's own pixels enlarged the same way
const EYE_WIN = { w: 260, h: 190, zoom: 6 };
for (const e of EYES) {
  for (const v of ['one', 'aligned', 'eyes']) await sharp(`${FR}/eye-${e.id}-${v}.png`).webp(webp(88)).toFile(`${IMG}/eye-${e.id}-${v}.webp`);
  await sharp(`${PARTS}/photo/source.jpg`).extract({ left: e.cx - EYE_WIN.w / 2, top: e.cy - EYE_WIN.h / 2, width: EYE_WIN.w, height: EYE_WIN.h }).resize(EYE_WIN.w * EYE_WIN.zoom, EYE_WIN.h * EYE_WIN.zoom, { kernel: 'lanczos3' }).webp(webp(90)).toFile(`${IMG}/eye-${e.id}-photo.webp`);
}
// cutouts and the whole-figure cutout, as the 3D model received them
for (const [name, src] of [['head', 'split/head-cutout.png'], ['body', 'split/body-cutout.png'], ['one', 'one-object/cutout.png']]) await sharp(`${PARTS}/${src}`).webp({ quality: 88, alphaQuality: 95, effort: 5 }).toFile(`${IMG}/cutout-${name}.webp`);
// the saved 1,048,576-Gaussian comparison, for the aside in step 01: one strip of three panels, cut into three pictures so the page
// can caption them in HTML and lay them out for any screen. The strip is 2004x420: three 660 px panels, 12 px gutters, a 26 px label bar.
{
  const strip = `${PARTS}/tests/1m-gaussians-eye-comparison.jpg`, PANEL = 660, GAP = 12, BAR = 26;
  const { data, info } = await sharp(strip).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 3 * PANEL + 2 * GAP) throw new Error(`the 1M comparison is ${info.width} px wide, expected ${3 * PANEL + 2 * GAP}`);
  for (const gx of [PANEL, 2 * PANEL + GAP]) for (let x = gx; x < gx + GAP; x++) { // the gutters must be plain dark columns, or the cut is in the wrong place
    let s = 0, s2 = 0, n = 0;
    for (let y = BAR + 4; y < info.height; y++) { const i = (y * info.width + x) * 3, v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; s += v; s2 += v * v; n++; }
    if (Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) > 3) throw new Error(`column ${x} of the 1M comparison is not a gutter; the panels moved`);
  }
  for (const [i, name] of ['photo', '262k', '1m'].entries()) await sharp(strip).extract({ left: i * (PANEL + GAP), top: BAR, width: PANEL, height: info.height - BAR }).webp({ quality: 88, effort: 5 }).toFile(`${IMG}/test-1m-${name}.webp`);
  fs.rmSync(`${IMG}/test-1m-eye.webp`, { force: true }); // the old one-piece version
}
// the photo's edges, in cyan, for checking placement
{
  const g = await sharp(`${PARTS}/photo/source.jpg`).grayscale().blur(1).raw().toBuffer();
  const px = Buffer.alloc(W * H * 4);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, gx = g[i + 1] - g[i - 1], gy = g[i + W] - g[i - W], m = Math.hypot(gx, gy);
    if (m > 34) { px[i * 4] = 0; px[i * 4 + 1] = 255; px[i * 4 + 2] = 235; px[i * 4 + 3] = Math.min(255, Math.round(m * 3)); }
  }
  // only around her: the room behind is the Marble world's, which is not meant to match the photo line for line
  const near = await sharp(`${PARTS}/one-object/mask.png`).extractChannel(0).blur(10).threshold(6).raw().toBuffer();
  for (let i = 0; i < W * H; i++) if (!near[i]) px[i * 4 + 3] = 0;
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png({ palette: true, quality: 70, effort: 8 }).toFile(`${IMG}/photo-edges.png`);
}

// ---------- thumbnails: the photo, lit through each saved mask ----------
{
  const T = { left: 470, top: 0, width: 790, height: 700 };
  const TINT = { hair: '#f2b85b', face: '#ff8b78', neck: '#c792ea', ear: '#f7e86b', headband: '#ff5ea8', hand: '#4cc2bb', dress: '#5aa9ff', 'arm-left': '#63d49c', 'arm-right': '#a8e86b', 'head-mask': '#ff8b78', 'body-mask': '#4cc2bb', 'head-cutout-mask': '#ff8b78', 'seam-band': '#ffe066', 'jaw-fill': '#ff5555' };
  const base = await sharp(`${PARTS}/photo/source.jpg`).extract(T).removeAlpha().raw().toBuffer();
  fs.mkdirSync(`${IMG}/thumbs`, { recursive: true });
  const list = [...fs.readdirSync(`${PARTS}/sam-parts`).map((f) => `sam-parts/${f}`), ...fs.readdirSync(`${PARTS}/split`).filter((f) => /mask|band|fill/.test(f)).map((f) => `split/${f}`)];
  for (const rel of list) {
    const name = path.basename(rel, '.png'), tiny = /band|fill/.test(name);
    let m = sharp(`${PARTS}/${rel}`).extract(T).extractChannel(0);
    if (tiny) m = m.blur(7).threshold(4); // a 14 px band is invisible in a thumbnail; thicken it
    const mk = await m.raw().toBuffer(), hex = TINT[name] ?? '#ffffff', c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
    const out = Buffer.alloc(base.length);
    for (let i = 0; i < mk.length; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = mk[i] > 127 ? Math.round(base[i * 3 + k] * 0.62 + c[k] * 0.38) : Math.round(base[i * 3 + k] * 0.26);
    await sharp(out, { raw: { width: T.width, height: T.height, channels: 3 } }).resize(260).webp({ quality: 80 }).toFile(`${IMG}/thumbs/${name}.webp`);
  }
}

// ---------- vendored libraries ----------
const V = `${DEMO}/vendor`;
for (const [from, to] of [
  ['node_modules/three/build/three.module.js', 'three/three.module.js'], ['node_modules/three/build/three.core.js', 'three/three.core.js'],
  ['node_modules/three/examples/jsm/controls/OrbitControls.js', 'three/addons/controls/OrbitControls.js'],
  ['node_modules/three/examples/jsm/postprocessing/Pass.js', 'three/addons/postprocessing/Pass.js'],
  ['node_modules/@sparkjsdev/spark/dist/spark.module.min.js', 'spark/spark.module.min.js'],
  ['node_modules/three/LICENSE', 'three/LICENSE'], ['node_modules/@sparkjsdev/spark/LICENSE', 'spark/LICENSE'],
]) { if (!fs.existsSync(`${ROOT}/${from}`)) { console.log('skip (missing):', from); continue; } fs.mkdirSync(path.dirname(`${V}/${to}`), { recursive: true }); fs.copyFileSync(`${ROOT}/${from}`, `${V}/${to}`); }

// ---------- masks: areas and boxes, measured on the saved files ----------
async function maskInfo(file) {
  const d = await sharp(file).extractChannel(0).raw().toBuffer();
  let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[y * W + x] >= 128) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { area: n, box: [x0, y0, x1 + 1, y1 + 1] };
}
const samNames = ['hair', 'face', 'neck', 'ear', 'headband', 'hand', 'dress', 'arm-left', 'arm-right'];
const maskStats = { whole: await maskInfo(`${PARTS}/one-object/mask.png`), head: await maskInfo(`${PARTS}/split/head-mask.png`), body: await maskInfo(`${PARTS}/split/body-mask.png`), seam: await maskInfo(`${PARTS}/split/seam-band.png`), jaw: await maskInfo(`${PARTS}/split/jaw-fill.png`) };
for (const n of samNames) maskStats[n] = await maskInfo(`${PARTS}/sam-parts/${n}.png`);

// ---------- numbers ----------
const manifest = read(`${PARTS}/manifest.json`);
// Gaussian counts and costs come from the saved files (PLY headers, the ledger copy), not from this script.
const J = manifest.jobs, plyCount = (name) => { const f = manifest.files.find((x) => x.file === `splats/ply/${name}.ply`); if (!f?.gaussians) throw new Error(`no Gaussian count for ${name} in the manifest`); return f.gaussians; };
const gaussians = { oneObject: plyCount('one-object.idol'), head: plyCount('head.aligned'), body: plyCount('body.aligned'), headEyes: plyCount('head.aligned-eyes') };
const idolPrices = new Set([J.costUsd.oneObjectIdol, J.costUsd.headIdol, J.costUsd.bodyIdol]);
if (idolPrices.size !== 1) throw new Error('the IDOL jobs did not cost the same; the page says "one more 3D job"');
const m2 = read(`${PARTS}/placement/measurements/m2-feature-shifts.json`), m5 = read(`${PARTS}/placement/measurements/m5-feature-shifts.json`);
const placement = { one: m2['old single woman'], fit: m2['split, compose fitter'], aligned: m5['v3 outline + seams'] };
const FEATURES = [
  ['right-eye', 'Right eye', 'right eye (viewer right)', 830, 246], ['left-eye', 'Left eye', 'left eye', 712, 289], ['right-brow', 'Right brow', 'right brow', 835, 205], ['left-brow', 'Left brow', 'left brow', 705, 252],
  ['mouth', 'Mouth', 'mouth', 805, 378], ['nose', 'Nose', 'nose', 792, 335], ['pearl', 'Pearl earring', 'pearl earring', 953, 297], ['hand', 'Hand', 'hand and knuckles', 740, 420],
  ['collar', 'Collar', 'collar (right)', 1030, 520], ['brooch', 'Brooch', 'brooch', 1085, 655],
];
const features = FEATURES.map(([id, label, key, x, y]) => ({ id, label, x, y, shift: Object.fromEntries(Object.entries(placement).map(([k, v]) => [k, [+v.shifts[key].dx.toFixed(2), +v.shifts[key].dy.toFixed(2)]])) }));
const photo = await loadRGB(`${PARTS}/photo/source.jpg`);
const figureError = {};
{
  const mask = await sharp(`${PARTS}/one-object/mask.png`).extractChannel(0).raw().toBuffer();
  for (const v of ['one', 'fit', 'aligned', 'eyes']) {
    const img = await loadRGB(`${FR}/full-${v}.png`); let sum = 0, n = 0;
    for (let i = 0; i < W * H; i++) if (mask[i] >= 128) { sum += (Math.abs(img[i * 3] - photo[i * 3]) + Math.abs(img[i * 3 + 1] - photo[i * 3 + 1]) + Math.abs(img[i * 3 + 2] - photo[i * 3 + 2])) / 3; n++; }
    figureError[v] = +(sum / n).toFixed(2);
  }
}
let sideGaps = null;
{ // the orbit test: see-through pixels inside her outline, one object vs the split (a 640x512 view, camera swung around her)
  const f = `${PARTS}/placement/measurements/side-gaps.txt`;
  if (fs.existsSync(f)) {
    const row = /^\s*-40°\s+(\d+)\s+(\d+)/m.exec(fs.readFileSync(f, 'utf8'));
    if (row) sideGaps = { angle: 40, one: +row[1], split: +row[2], of: 640 * 512 };
  }
}
const eyeM = {}, eyeCache = {};
for (const v of ['one', 'fit', 'aligned', 'eyes']) eyeM[v] = Object.fromEntries(eyeMetrics(await loadRGB(`${FR}/full-${v}.png`), photo, eyeCache).map((m) => [m.id, m]));

// where each part sits, for the 3D labels and the camera target (mean of the solid Gaussians, in scene coordinates)
const layout = Object.fromEntries(read(`${PARTS}/placement/layout.json`).objects.map((o) => [o.id, o]));
function centroid(file, pose) {
  const buf = fs.readFileSync(file), end = buf.indexOf('end_header\n') + 11, hdr = buf.subarray(0, end).toString('latin1');
  const n = Number(/element vertex (\d+)/.exec(hdr)[1]), props = [...hdr.matchAll(/property float (\w+)/g)].map((m) => m[1]), F = props.length, iOp = props.indexOf('opacity');
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset + end, buf.byteOffset + end + n * F * 4));
  const [x, y, z, w] = pose.quaternion;
  const rot = (p) => { const cx = y * p[2] - z * p[1], cy = z * p[0] - x * p[2], cz = x * p[1] - y * p[0]; return [p[0] + 2 * (w * cx + y * cz - z * cy), p[1] + 2 * (w * cy + z * cx - x * cz), p[2] + 2 * (w * cz + x * cy - y * cx)]; };
  let sx = 0, sy = 0, sz = 0, c = 0, top = -1e9, bottom = 1e9;
  for (let i = 0; i < n; i++) {
    if (1 / (1 + Math.exp(-f[i * F + iOp])) < 0.5) continue;
    const r = rot([f[i * F], f[i * F + 1], f[i * F + 2]]), P = [pose.position[0] + pose.scale * r[0], pose.position[1] + pose.scale * r[1], pose.position[2] + pose.scale * r[2]];
    sx += P[0]; sy += P[1]; sz += P[2]; c++; if (P[1] > top) top = P[1]; if (P[1] < bottom) bottom = P[1];
  }
  return { center: [sx / c, sy / c, sz / c].map((v) => +v.toFixed(4)), top: +top.toFixed(4), bottom: +bottom.toFixed(4) };
}
// the eye corrector's own log: how much of each eye was see-through before and after (at the viewer's 2x pixel ratio)
const corrLog = fs.readFileSync(`${PARTS}/placement/measurements/eye-corrector.txt`, 'utf8'); // saved by build-parts
const seeThrough = {};
for (const m of corrLog.matchAll(/2x (right|left) eye:.*see-through ([\d.]+)% -> ([\d.]+)%/g)) seeThrough[m[1]] = { before: +m[2], after: +m[3] };
if (!seeThrough.right || !seeThrough.left) throw new Error('could not read the see-through figures from the corrector log');
// the layer and the colour fit, as the corrector logged them; the counts are cross-checked against the PLY headers (via the manifest)
const layerM = /layer: (\d+) Gaussians .*?(-?[\d.]+) mm (?:in front of|behind) the eye surface; head now (\d+) Gaussians/.exec(corrLog);
const fitM = /fit at \d+x: (\d+) Gaussians \((\d+) of them new\)/.exec(corrLog);
if (!layerM || !fitM) throw new Error('could not read the layer and fit figures from the corrector log');
if (+layerM[3] !== gaussians.headEyes || gaussians.headEyes - gaussians.head !== +layerM[1]) throw new Error('the corrector log and the PLY headers disagree about the Gaussian counts');
// "nothing outside the eyes changes": checked over the whole frame, between the render with and without the corrector
const outside = { pixels: 0, maxChange: 0, over1: 0, featherPx: FEATHER };
{
  const a = await loadRGB(`${FR}/full-aligned.png`), b = await loadRGB(`${FR}/full-eyes.png`);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (distToEyes(x + 0.5, y + 0.5) < FEATHER) continue; // inside an eye region or its fade
    const i = (y * W + x) * 3, d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    outside.pixels++; if (d > outside.maxChange) outside.maxChange = d; if (d > 1) outside.over1++;
  }
}
const spzFidelity = read(`${PARTS}/placement/measurements/spz-fidelity.json`); // from tools/spz-fidelity.mjs
const eyeCorrector = { addedGaussians: +layerM[1], refitGaussians: +fitM[1], offsetMm: Math.abs(+layerM[2]), headGaussians: +layerM[3], seeThrough, outside };
const onePose = read(`${PARTS}/placement/silhouette-fit-poses.json`)['old single woman'][0];
const anchors = { head: centroid(`${PARTS}/splats/ply/head.aligned-eyes.ply`, layout['woman-head']), body: centroid(`${PARTS}/splats/ply/body.aligned.ply`, layout['woman-body']) };
const scene = read(`${PARTS}/placement/scene.json`);
const boxes = { whole: maskStats.whole.box, head: maskStats.head.box, face: maskStats.face.box };
const splatBytes = Object.fromEntries(fs.readdirSync(`${A}/splats`).map((f) => [f.replace('.spz', ''), size(`${A}/splats/${f}`)]));
const data = {
  made: new Date().toISOString(),
  photo: { w: W, h: H, face: { ...FACE, zoom: Z }, eyeWindow: EYE_WIN },
  variants: VARIANTS,
  eyes: EYES,
  eyeMetrics: eyeM,
  figureError,
  sideGaps,
  features,
  placement: Object.fromEntries(Object.entries(placement).map(([k, v]) => [k, { colorError: v.colorErr255, silhouetteIoU: v.silhouetteIoU }])),
  split: { ...manifest.masks, sam: J.sam },
  seamBandPx: manifest.seamBandPx,
  test1m: J.test1m,
  masks: maskStats,
  modelInput: {
    wholeFigureBox: boxes.whole, headBox: boxes.head, faceBox: boxes.face,
    heightRatio: +((boxes.whole[3] - boxes.whole[1]) / (boxes.head[3] - boxes.head[1])).toFixed(2), widthRatio: +((boxes.whole[2] - boxes.whole[0]) / (boxes.head[2] - boxes.head[0])).toFixed(2),
    faceShareWhole: +((boxes.face[2] - boxes.face[0]) / (boxes.whole[2] - boxes.whole[0])).toFixed(3), faceShareHead: +((boxes.face[2] - boxes.face[0]) / (boxes.head[2] - boxes.head[0])).toFixed(3),
  },
  // splitUsd is the two IDOL jobs plus SAM; extraUsd is what it adds to the one-object price
  cost: { idolJobUsd: J.costUsd.headIdol, oneObjectUsd: J.costUsd.oneObjectIdol, splitUsd: J.costUsd.splitTotal, samUsd: J.costUsd.sam, extraUsd: +(J.costUsd.splitTotal - J.costUsd.oneObjectIdol).toFixed(4), test1mUsd: J.test1m.usd },
  alignment: { head: displacement.head, body: displacement.body },
  eyeCorrector,
  spzFidelity,
  gaussians,
  bytes: { spz: splatBytes, partsTotal: manifest.files.reduce((a, f) => a + f.bytes, 0), plyTotal: manifest.files.filter((f) => f.file.startsWith('splats/ply/')).reduce((a, f) => a + f.bytes, 0) },
  viewer: { fovY: scene.camera.fovY, anchors, layout: { head: layout['woman-head'], body: layout['woman-body'], one: { position: onePose.position, quaternion: onePose.quaternion, scale: onePose.scale } } },
};
fs.writeFileSync(`${A}/data.json`, JSON.stringify(data, null, 1));
const total = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? total(`${dir}/${e.name}`) : size(`${dir}/${e.name}`)), 0);
console.log(`images ${(total(IMG) / 1e6).toFixed(1)} MB, splats ${(total(`${A}/splats`) / 1e6).toFixed(1)} MB, vendor ${(total(V) / 1e6).toFixed(1)} MB`);
console.log('eye metrics (Spark, photo camera; shift undone before comparing):');
for (const v of ['one', 'fit', 'aligned', 'eyes']) console.log(`  ${v.padEnd(8)}`, ['right', 'left'].map((id) => { const m = eyeM[v][id]; return `${id}: lands ${m.shiftPx.toFixed(1)} px off, detail ${m.detailMatch.toFixed(2)}, colour err ${m.colorError.toFixed(1)}, sharp ${m.sharpness.toFixed(0)}/${m.photoSharpness.toFixed(0)} (${(100 * m.sharpness / m.photoSharpness).toFixed(0)}%)`; }).join(' | '));
console.log('placement:', JSON.stringify(data.placement));
console.log('model input ratio:', JSON.stringify(data.modelInput));
console.log('anchors:', JSON.stringify(anchors));
