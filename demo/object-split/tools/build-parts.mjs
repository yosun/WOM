// Save the parts: copy everything the object split produced into demo/object-split/parts/ (so it no longer lives only in
// .scratch/ and the two world folders), derive the few masks that were never written out, and write a manifest with sizes,
// checksums and where each file came from.
//   node demo/object-split/tools/build-parts.mjs
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'demo/object-split/parts');
const WEB = path.join(ROOT, 'demo/object-split/assets/img/masks');
const CLONE = 'data/worlds/mw16xplr29532e14', ORIG = 'data/worlds/mvzp2tur93987dde', SCR = '.scratch/idol-split';
const W = 1699, H = 926, N = W * H;
const files = []; // { file, from, what }

function put(rel, from, what) {
  const dest = path.join(OUT, rel);
  if (!fs.existsSync(path.join(ROOT, from))) throw new Error(`missing source: ${from}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, from), dest);
  files.push({ file: rel, from, what });
}
const fmt = (v) => v.toLocaleString('en-US');
/** Gaussian count from a PLY header. */
function plyN(file) {
  const b = Buffer.alloc(8192), fd = fs.openSync(file, 'r');
  fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
  const m = /element vertex (\d+)/.exec(b.toString('latin1'));
  if (!m) throw new Error(`no vertex count in ${file}`);
  return Number(m[1]);
}
/** put() for a PLY: the description is a function of the Gaussian count read from the file's own header, and the count is kept on the entry. */
function putPly(rel, from, what) {
  const n = plyN(path.join(ROOT, from));
  put(rel, from, what(n));
  files.at(-1).gaussians = n;
  return n;
}
const readMask = async (f) => Uint8Array.from(await sharp(f).extractChannel(0).raw().toBuffer(), (v) => (v >= 128 ? 255 : 0));
async function putMask(rel, data, what, from = 'derived') {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await sharp(Buffer.from(data), { raw: { width: W, height: H, channels: 1 } }).png({ compressionLevel: 9 }).toFile(dest);
  files.push({ file: rel, from, what });
}

// ---------- the photo ----------
put('photo/source.jpg', `${ORIG}/source.jpg`, 'The original photo (1699x926).');

// ---------- SAM 3.1 part masks on the photo ----------
const SAM = [
  ['hair', 'c1-0', 'hair, from the concept prompt "head"'], ['face', 'part-face-0', 'face'], ['neck', 'part-neck-0', 'neck'],
  ['ear', 'part-ear-0', 'ear'], ['headband', 'part-headband-0', 'pink bow headband'], ['hand', 'part-hand-1', 'the hand resting on her cheek'],
  ['dress', 'part-dress-0', 'dress'], ['arm-left', 'part-arm-0', 'the arm raised to her cheek (viewer\'s left)'], ['arm-right', 'part-arm-1', 'the arm along the counter'],
];
for (const [name, src, what] of SAM) put(`sam-parts/${name}.png`, `${SCR}/masks/${src}.png`, `SAM 3.1 mask: ${what}.`);

// ---------- the split ----------
put('split/head-mask.png', `${CLONE}/objects/woman-head/mask.png`, 'Head as visible in the photo, including the overlap band below the neck cut. The placement is fitted to this.');
put('split/body-mask.png', `${CLONE}/objects/woman-body/mask.png`, 'Body as visible in the photo (torso, arms, the hand in front of the jaw), including the overlap band above the neck cut. The placement is fitted to this.');
put('split/head-cutout-mask.png', `${SCR}/parts/head/mask-cutout.png`, 'Head mask plus the patch of jaw the hand hides; the head cutout was built from this.');
put('split/head-cutout.png', `${CLONE}/objects/woman-head/cutout.png`, 'What the 3D model received for the head (641x641, transparent background, native photo pixels).');
put('split/body-cutout.png', `${CLONE}/objects/woman-body/cutout.png`, 'What the 3D model received for the body (1024x1024, transparent background).');
put('one-object/cutout.png', `${ORIG}/objects/smiling-woman-in-pink-un/cutout.png`, 'What the 3D model received for the whole figure in the original pipeline (1024x1024, completed on white).');
put('one-object/mask.png', `${ORIG}/objects/smiling-woman-in-pink-un/mask.png`, 'The whole-figure mask (the union the head and body masks partition).');
const head = await readMask(path.join(OUT, 'split/head-mask.png')), body = await readMask(path.join(OUT, 'split/body-mask.png')), cut = await readMask(path.join(OUT, 'split/head-cutout-mask.png'));
const seam = new Uint8Array(N), jaw = new Uint8Array(N);
for (let i = 0; i < N; i++) { seam[i] = head[i] && body[i] ? 255 : 0; jaw[i] = cut[i] && !head[i] ? 255 : 0; }
// the band's height is measured from the mask, not typed: the tallest run of overlap in any column
let bandRows = 0, seamPx = 0;
for (let x = 0; x < W; x++) { let run = 0; for (let y = 0; y < H; y++) { if (seam[y * W + x]) { run++; seamPx++; } else run = 0; if (run > bandRows) bandRows = run; } }
await putMask('split/seam-band.png', seam, `Where the head and body masks overlap: a band across the neck up to ${bandRows} px tall (${fmt(seamPx)} px in all).`);
await putMask('split/jaw-fill.png', jaw, 'The patch of jaw hidden by the hand, filled with skin from the visible face in the head cutout.');

// ---------- 3D parts (PLY, full quality; the web copies are SPZ in assets/splats) ----------
// The Gaussian counts in the descriptions are read from each file's own header.
putPly('splats/ply/one-object.idol.ply', `${ORIG}/objects/smiling-woman-in-pink-un/idol/model.ply`, (n) => `IDOL output for the whole figure (${fmt(n)} Gaussians). The original pipeline's result.`);
const nHeadRaw = putPly('splats/ply/head.idol-raw.ply', `${CLONE}/objects/woman-head/idol/model.raw.ply`, (n) => `IDOL output for the head, untouched (${fmt(n)} Gaussians).`);
const nBodyRaw = putPly('splats/ply/body.idol-raw.ply', `${CLONE}/objects/woman-body/idol/model.raw.ply`, (n) => `IDOL output for the body, untouched (${fmt(n)} Gaussians).`);
const nHead = putPly('splats/ply/head.aligned.ply', `${CLONE}/objects/woman-head/idol/model.ply`, () => 'Head after the pixel alignment (Gaussians moved sideways in the photo\'s view, depth unchanged).');
const nBody = putPly('splats/ply/body.aligned.ply', `${CLONE}/objects/woman-body/idol/model.ply`, () => 'Body after the pixel alignment.');
if (nHead !== nHeadRaw || nBody !== nBodyRaw) throw new Error('the alignment changed a Gaussian count (it only moves Gaussians)');
putPly('splats/ply/head.aligned-eyes.ply', `${CLONE}/objects/woman-head/idol/model-eyes.ply`, (n) => `Aligned head with the eye corrector: a layer of ${fmt(n - nHead)} Gaussians on the eye surface and refitted colours around the eyes (${fmt(n)} Gaussians).`);

// ---------- what it cost: the ledger entries behind every dollar figure on the page ----------
const CLONE_ID = path.basename(CLONE), ORIG_ID = path.basename(ORIG);
const JOB = { oneObject: '2a8a9922-4c71-5bd1-eb5b-bab21a92ee71', head: 'bb6072dc-8274-6952-35bd-e811f127e347', body: 'd9d3422a-0268-cc8d-0bb3-a99c6d0060e0' };
const ledger = fs.readFileSync(path.join(ROOT, 'data/ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const entryFor = (id) => { const e = ledger.filter((x) => x.jobId === id); if (e.length !== 1) throw new Error(`expected one ledger entry for job ${id}, found ${e.length}`); return e[0]; };
const idol = Object.fromEntries(Object.entries(JOB).map(([k, id]) => [k, entryFor(id)]));
const samEntries = ledger.filter((x) => x.model === 'sam-3.1' && x.worldId === CLONE_ID);
const test1m = ledger.filter((x) => x.model === 'idol' && x.worldId === ORIG_ID && /1M Gaussians test/.test(x.label));
if (!samEntries.length) throw new Error('no SAM 3.1 entries in the ledger for the head+body world');
if (test1m.length !== 1) throw new Error(`expected one 1M-Gaussian test entry, found ${test1m.length}`);
const samRequests = samEntries.reduce((a, x) => a + Number(/\((\d+) requests?\)/.exec(x.label)?.[1] ?? NaN), 0);
if (!Number.isFinite(samRequests) || samRequests <= 0) throw new Error('could not read the SAM request count from the ledger labels');
const usd = (v) => +v.toFixed(4);
const samUsd = usd(samEntries.reduce((a, x) => a + x.usd, 0));
{
  const rel = 'cost/ledger-entries.json', dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const role = (r, e) => ({ role: r, ...e });
  fs.writeFileSync(dest, JSON.stringify({
    note: 'Lines copied from data/ledger.jsonl: the three IDOL jobs the page compares, the SAM calls that found the parts, and the 1,048,576-Gaussian test. Nothing else the app spent is included.',
    entries: [role('one object (the original pipeline)', idol.oneObject), role('head', idol.head), role('body', idol.body), ...samEntries.map((e) => role('part masks', e)), role('1,048,576-Gaussian test', test1m[0])],
  }, null, 2));
  files.push({ file: rel, from: 'data/ledger.jsonl (selected lines)', what: 'The ledger entries behind every dollar figure on the page: the three IDOL jobs, the SAM calls and the 1M-Gaussian test.' });
}
put('tests/1m-gaussians-eye-comparison.jpg', '.scratch/idol-1m/compare-right-eye-6x.jpg', 'The 1,048,576-Gaussian test, right eye at 6x: the photo, the 262,144-Gaussian render and the 1,048,576-Gaussian render. The eye stays smeared.');

// ---------- placement ----------
put('placement/fit-result.json', `${SCR}/fit-result.json`, 'Photometric fit: pose of the head and body (the alignment is applied on top of these).');
put('placement/layout.json', `${CLONE}/layout.json`, 'Final poses used by the viewer (three.js coordinates, camera at the origin looking down -Z).');
put('placement/silhouette-fit-poses.json', `${SCR}/sets-baseline.json`, 'Poses the pipeline\'s own silhouette fitter chose (old single woman, and the head and body before alignment).');
put('placement/scene.json', `${CLONE}/scene.json`, 'The head+body world\'s scene (camera, Marble world, the other objects).');

// ---------- measurements ----------
// saved as .txt because the repo's .gitignore drops *.log
put('placement/measurements/eye-corrector.txt', `${SCR}/eyes/decal-s05.log`, 'The eye corrector\'s own log: Gaussians added and refitted, see-through before and after, change outside the eyes.');
{ // the others were written by the measuring scripts straight into parts/placement/measurements
  const dir = path.join(OUT, 'placement/measurements');
  const WHAT = {
    'm2-feature-shifts.json': 'How far each feature lands from the photo\'s (px), for the one object, the head and body with the silhouette fit, and the photometric fit with and without the alignment.',
    'm5-feature-shifts.json': 'The same for the final alignment, with and without the seam term.',
    'spz-fidelity.txt': 'How much the SPZ conversion changes what you see: Spark renders of the PLY parts against the SPZ files, from three cameras, over the whole frame and the eye regions.',
    'spz-fidelity.json': 'The same figures as spz-fidelity.txt, for the page to read.',
    'side-gaps.txt': 'See-through pixels inside her outline from camera angles around her: one object against the aligned split (640x512 views).',
  };
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
    const rel = `placement/measurements/${f}`;
    if (!files.some((x) => x.file === rel)) files.push({ file: rel, from: 'measurement', what: WHAT[f] ?? 'A measurement.' });
  }
}

// ---------- web-sized masks for the explorer ----------
fs.mkdirSync(WEB, { recursive: true });
const webMask = async (rel, name) => sharp(path.join(OUT, rel)).resize(Math.round(W / 2), Math.round(H / 2), { kernel: 'lanczos3' }).extractChannel(0).png({ compressionLevel: 9 }).toFile(path.join(WEB, `${name}.png`));
for (const [name] of SAM) await webMask(`sam-parts/${name}.png`, name);
for (const [rel, name] of [['split/head-mask.png', 'head'], ['split/body-mask.png', 'body'], ['split/seam-band.png', 'seam'], ['split/jaw-fill.png', 'jaw']]) await webMask(rel, name);

// ---------- manifest ----------
const sha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const area = async (rel) => { const d = await readMask(path.join(OUT, rel)); let n = 0; for (let i = 0; i < d.length; i++) n += d[i] ? 1 : 0; return n; };
const stats = {
  headPx: await area('split/head-mask.png'), bodyPx: await area('split/body-mask.png'), seamPx: await area('split/seam-band.png'), jawPx: await area('split/jaw-fill.png'),
  womanPx: await area('one-object/mask.png'),
};
const union = new Uint8Array(N); let gap = 0;
for (let i = 0; i < N; i++) { union[i] = head[i] || body[i] ? 255 : 0; }
const womanM = await readMask(path.join(OUT, 'one-object/mask.png'));
for (let i = 0; i < N; i++) if (womanM[i] && !union[i]) gap++;
stats.leftOverPx = gap;
for (const f of files) { const p = path.join(OUT, f.file); f.bytes = fs.statSync(p).size; f.sha256 = sha(p); }
const manifest = {
  what: 'The woman from the "Beauty Counter Smile" photo, split into a head and a body that were built, placed and corrected on their own.',
  made: new Date().toISOString(),
  worlds: { original: 'mvzp2tur93987dde', headAndBody: 'mw16xplr29532e14' },
  jobs: {
    note: `Costs are read from the app's ledger (see cost/ledger-entries.json): IDOL jobs $${idol.oneObject.usd.toFixed(2)} / $${idol.head.usd.toFixed(2)} / $${idol.body.usd.toFixed(2)} (whole figure / head / body), SAM 3.1 $${samUsd.toFixed(3)} for ${samRequests} requests.`,
    oneObject: JOB.oneObject, head: JOB.head, body: JOB.body,
    sam: { requests: samRequests, usd: samUsd, usdEach: usd(samUsd / samRequests) },
    costUsd: { oneObjectIdol: idol.oneObject.usd, headIdol: idol.head.usd, bodyIdol: idol.body.usd, sam: samUsd, splitTotal: usd(idol.head.usd + idol.body.usd + samUsd) },
    // the "just ask for more Gaussians" test on the whole figure; its 71 MB PLY stays out of the bundle, the comparison image is in tests/
    test1m: { jobId: test1m[0].jobId, usd: test1m[0].usd, gaussians: plyN(path.join(ROOT, '.scratch/idol-1m/woman-1m.ply')), plyBytes: fs.statSync(path.join(ROOT, '.scratch/idol-1m/woman-1m.ply')).size },
  },
  seamBandPx: bandRows,
  coordinates: 'Splat files are in IDOL\'s own frame. Apply the pose in placement/layout.json (position, quaternion [x y z w], uniform scale) to put a part where the photo has it, in a scene with the camera at the origin looking down -Z.',
  masks: stats,
  files,
};
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
const total = files.reduce((a, f) => a + f.bytes, 0);
console.log(`${files.length} files, ${(total / 1e6).toFixed(1)} MB in demo/object-split/parts/`);
console.log('mask stats:', JSON.stringify(stats));
