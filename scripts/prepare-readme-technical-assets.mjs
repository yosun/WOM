// Export an explicit, reproducible selection of retained demo evidence for the README.
// No directory discovery, provider calls, environment loading, or network requests.
// Run from any directory: node scripts/prepare-readme-technical-assets.mjs
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { FloatType } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/images/wom-technical-assets');
const MAX_WIDTH = 1200;
const WORLD = 'data/worlds/mvxixlbz34cbfb22';
const BENCH = `${WORLD}/objects/wooden-garden-bench`;
const COURSE = 'data/par-courses/wompar-0.1-pilot/reference/sunny-garden';
const REPAIR = 'data/checks/womagent-cleanup-yjfkdrxx/worlds/mvxixlbz34cbfb22/womagent/amw2v11ff2583cc4f';

// These are the only local inputs this script reads. In particular, no manifest,
// provider receipt, signed URL, credential, or environment file is copied out.
const INPUTS = {
  source: `${WORLD}/source.jpg`,
  dogMask: `${WORLD}/objects/golden-retriever/mask.png`,
  bicycleMask: `${WORLD}/objects/red-vintage-bicycle/mask.png`,
  benchMask: `${BENCH}/mask.png`,
  treeMask: `${WORLD}/objects/potted-lemon-tree/mask.png`,
  cutoutRaw: `${BENCH}/cutout_raw.png`,
  cutoutCompleted: `${BENCH}/cutout.png`,
  cleanPlate: `${WORLD}/clean.jpg`,
  depth: `${WORLD}/depth/moge3/original/depth.exr`,
  mesh: `${BENCH}/preview.png`,
  gaussian: `${BENCH}/splat-preview.png`,
  world: `${WORLD}/world/thumbnail.webp`,
  fit: 'data/bench/placement/20261101-215829/overlays/mvxixlbz34cbfb22__wooden-garden-bench__tripo-v31__moge3.jpg',
  sourceView: `${COURSE}/frames/0000.jpg`,
  novelView: `${COURSE}/frames/0009.jpg`,
  trajectory: `${COURSE}/trajectory.json`,
  repairBefore: `${REPAIR}/baseline/006.jpg`,
  repairAfter: `${REPAIR}/repair-002/after-006.jpg`,
  repairRecord: `${REPAIR}/run.json`,
};
const buffers = new Map();
const inputRecords = new Map();
const assets = [];
const anomalies = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function input(key) {
  if (!Object.hasOwn(INPUTS, key)) throw new Error(`Input is not allowlisted: ${key}`);
  if (!buffers.has(key)) {
    const bytes = await readFile(path.join(ROOT, INPUTS[key]));
    buffers.set(key, bytes);
    inputRecords.set(key, { path: INPUTS[key], sha256: sha256(bytes) });
  }
  return buffers.get(key);
}

async function save(name, bytes, keys, label, models, transforms, details = {}) {
  const metadata = await sharp(bytes).metadata();
  if (metadata.width > MAX_WIDTH) throw new Error(`${name} exceeds ${MAX_WIDTH}px width`);
  if (metadata.exif || metadata.iptc || metadata.xmp) throw new Error(`${name} retained private image metadata`);
  await writeFile(path.join(OUT, name), bytes);
  assets.push({
    file: name, sha256: sha256(bytes), bytes: bytes.length,
    width: metadata.width, height: metadata.height, alpha: metadata.hasAlpha,
    label, models,
    inputs: keys.map(key => inputRecords.get(key)),
    transforms: [...transforms, 'Re-encoded with sharp default metadata stripping; no EXIF, IPTC, or XMP retained'],
    ...details,
  });
}

async function exportJpeg(key, name, label, models, details = {}) {
  const bytes = await sharp(await input(key))
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .flatten({ background: '#080c11' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  await save(name, bytes, [key], label, models, ['Preserved full image framing', `Downsampled only if wider than ${MAX_WIDTH}px; no enlargement`], details);
}

async function exportAlpha(key, name, label, models) {
  const bytes = await input(key);
  const metadata = await sharp(bytes).metadata();
  let image = sharp(bytes);
  const transforms = [];
  if (metadata.hasAlpha) {
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      if (!data[(y * info.width + x) * info.channels + info.channels - 1]) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    if (x1 < x0) throw new Error(`${key} has no visible alpha pixels`);
    const crop = { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
    image = image.extract(crop);
    transforms.push(`Trimmed fully transparent margin only: ${JSON.stringify(crop)}`, 'Preserved all pixels with alpha > 0, including semitransparent edges');
  } else {
    transforms.push('Input has no alpha; retained full image and its existing white background without inventing a segmentation mask');
    anomalies.push({ file: name, issue: 'Retained completed bench image is RGB, not RGBA', handling: 'Preserved existing pixels and white background; no white-to-alpha removal or inferred mask' });
  }
  const output = await image.resize({ width: MAX_WIDTH, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  transforms.push(`Downsampled only if wider than ${MAX_WIDTH}px; no enlargement`);
  await save(name, output, [key], label, models, transforms);
}

async function exportMasks() {
  const { data, info } = await sharp(await input('source')).resize({ width: MAX_WIDTH, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const masks = [
    { key: 'dogMask', object: 'golden retriever', rgb: [255, 195, 76], hex: '#ffc34c' },
    { key: 'bicycleMask', object: 'red vintage bicycle', rgb: [74, 220, 245], hex: '#4adcf5' },
    { key: 'benchMask', object: 'wooden garden bench', rgb: [243, 104, 203], hex: '#f368cb' },
    { key: 'treeMask', object: 'potted lemon tree', rgb: [136, 228, 120], hex: '#88e478' },
  ];
  const output = Buffer.from(data);
  for (const mask of masks) {
    const mk = await sharp(await input(mask.key)).extractChannel(0)
      .resize(info.width, info.height, { kernel: 'nearest' }).raw().toBuffer();
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = y * info.width + x;
      if (mk[i] < 128) continue;
      const boundary = x === 0 || x === info.width - 1 || y === 0 || y === info.height - 1
        || mk[i - 1] < 128 || mk[i + 1] < 128 || mk[i - info.width] < 128 || mk[i + info.width] < 128;
      const alpha = boundary ? .95 : .36;
      for (let c = 0; c < 3; c++) output[i * 3 + c] = Math.round(output[i * 3 + c] * (1 - alpha) + mask.rgb[c] * alpha);
    }
  }
  const bytes = await sharp(output, { raw: { width: info.width, height: info.height, channels: 3 } }).jpeg({ quality: 94, chromaSubsampling: '4:4:4' }).toBuffer();
  await save('masks.jpg', bytes, ['source', ...masks.map(m => m.key)], 'Four retained SAM 3.1 masks over the original photograph', ['SAM 3.1'], [
    'Original photograph downsampled to 1200px width with preserved framing',
    'Actual binary masks thresholded at 128 and resized with nearest-neighbor interpolation',
    'Colored interiors use opacity 0.36; one-pixel inside boundaries use opacity 0.95; no invented mask geometry',
  ], { legend: masks.map(({ object, hex }) => ({ object, color: hex })) });
}

async function exportDepth() {
  const bytes = await input('depth');
  const parsed = new EXRLoader().setDataType(FloatType).parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const { width, height, data } = parsed;
  const stride = data.length / (width * height);
  const finite = [];
  for (let i = 0; i < width * height; i++) {
    const z = data[i * stride];
    if (Number.isFinite(z) && z > 1e-4 && z < 1e5) finite.push(z);
  }
  finite.sort((a, b) => a - b);
  if (!finite.length) throw new Error('Saved depth contains no valid positive values');
  const near = finite[Math.floor((finite.length - 1) * .02)];
  const far = finite[Math.floor((finite.length - 1) * .98)];
  const lo = Math.log(near), span = Math.log(far) - lo;
  const palette = [[248, 195, 93], [60, 130, 149], [25, 39, 74]];
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // EXRLoader rows are bottom-up for WebGL; align them to source-image top-down order.
    const z = data[((height - 1 - y) * width + x) * stride];
    const i = (y * width + x) * 3;
    if (!(Number.isFinite(z) && z > 1e-4 && z < 1e5)) {
      rgb[i] = 8; rgb[i + 1] = 12; rgb[i + 2] = 17;
      continue;
    }
    const t = Math.max(0, Math.min(1, (Math.log(z) - lo) / span));
    const a = t < .5 ? 0 : 1, mix = t < .5 ? t * 2 : (t - .5) * 2;
    for (let c = 0; c < 3; c++) rgb[i + c] = Math.round(palette[a][c] * (1 - mix) + palette[a + 1][c] * mix);
  }
  const output = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize({ width: MAX_WIDTH, withoutEnlargement: true }).png({ compressionLevel: 9 }).toBuffer();
  await save('depth.png', output, ['depth'], 'Saved MoGe-3 depth; warm colors are nearer, dark blue is farther', ['MoGe-3'], [
    'Decoded retained depth.exr as Float32; used first scalar depth channel',
    'Flipped EXRLoader bottom-up rows to match the source photograph',
    'Displayed log(depth) normalized between the 2nd and 98th percentiles; clipped values outside that range',
    'Near = #f8c35d, midpoint = #3c8295, far = #19274a; invalid depth = #080c11',
    'Color is a visualization of predicted depth, not a depth-error or accuracy measurement',
  ], { normalization: { kind: 'log depth, percentiles 2–98', nearM: near, farM: far, validPixels: finite.length, totalPixels: width * height, minimumValidM: finite[0], maximumValidM: finite.at(-1) } });
}

await mkdir(OUT, { recursive: true });
await exportJpeg('source', 'source.jpg', 'Original Sunny Garden photograph', []);
await exportMasks();
await exportAlpha('cutoutRaw', 'cutout-raw.png', 'Bench cutout from the original source and mask; occluded region remains missing', ['SAM 3.1']);
await exportAlpha('cutoutCompleted', 'cutout-completed.png', 'Retained Muse Image completed bench input; generated white background preserved', ['Muse Image']);
await exportJpeg('cleanPlate', 'clean-plate.jpg', 'Retained clean plate with selected foreground objects removed', ['Muse Image']);
await exportDepth();
await exportAlpha('mesh', 'mesh.png', 'Retained textured-mesh model preview', ['Tripo H3.1 / tripo-v31']);
await exportJpeg('gaussian', 'gaussian.jpg', 'Retained Gaussian-splat model preview', ['TripoSplat']);
await exportJpeg('world', 'world.jpg', 'Retained Marble world thumbnail; not a newly rendered scene', ['World Labs Marble']);
await exportJpeg('fit', 'fit-overlay.jpg', 'Saved two-panel bench placement overlay: fitter and grounded', ['Tripo H3.1 / tripo-v31', 'MoGe-3', 'Local fitter'], {
  metricsVisibleInOriginal: { fitterSilhouetteIouRounded: .80, groundedSilhouetteIouRounded: .82 },
  scope: 'One saved bench pair with both halves and whole framing preserved; independent of aggregate model-study results',
});

const trajectory = JSON.parse(await input('trajectory'));
for (const [key, filename, frame, label] of [
  ['sourceView', 'source-view.jpg', 0, 'Saved reconstruction at the source camera'],
  ['novelView', 'novel-view.jpg', 9, 'Saved reconstruction at the right patrol camera'],
]) {
  const endpoint = trajectory.endpointFrames.indexOf(frame);
  await exportJpeg(key, filename, label, ['WOMPar: IDOL objects + Marble surroundings + MoGe-3'], {
    camera: { view: trajectory.endpointIds[endpoint], frame: String(frame).padStart(4, '0'), ...trajectory.samples[frame], fovY: trajectory.fovY, aspect: trajectory.aspect },
    cameraProvenance: inputRecords.get('trajectory'),
  });
}

const run = JSON.parse(await input('repairRecord'));
const repair = run.repairs.find(candidate => candidate.id === 'repair-002');
if (repair?.status !== 'accepted' || repair.action !== 'use:tripo-v31') throw new Error('Expected accepted bicycle asset replacement is missing');
if (run.options.allowGeneration !== false || run.repairs.some(candidate => candidate.action.startsWith('generate:'))) throw new Error('Repair generation assumptions changed');
const viewId = 'object:golden-retriever:left';
for (const [key, filename, records, label] of [
  ['repairBefore', 'repair-before.jpg', repair.before, 'Before: IDOL bicycle has an attached green sheet'],
  ['repairAfter', 'repair-after.jpg', repair.after, 'After: retained Tripo H3.1 bicycle replaces the affected asset'],
]) {
  const evidence = records.find(view => view.id === viewId);
  if (!evidence || sha256(await input(key)) !== evidence.sha256) throw new Error(`Repair evidence hash mismatch: ${key}`);
  await exportJpeg(key, filename, label, [key === 'repairBefore' ? 'IDOL' : 'Tripo H3.1 / tripo-v31'], {
    camera: { view: evidence.id, pose: evidence.pose, fovY: evidence.fovY, aspect: evidence.aspect },
    recordProvenance: inputRecords.get('repairRecord'),
    evidenceInputHashVerified: true,
  });
}

const provenance = {
  schema: 'wom-readme-technical-assets/1',
  title: 'One retained Sunny Garden reconstruction and a separately recorded guarded repair',
  generator: 'scripts/prepare-readme-technical-assets.mjs',
  generation: 'Deterministic export of explicitly allowlisted local files; no network, paid APIs, or image-generation calls',
  sanitization: 'Only the images and this explicitly selected numerical/camera evidence are exported; EXIF/IPTC/XMP stripped; no raw manifests, receipts, URLs, account IDs, or credentials',
  maxWidth: MAX_WIDTH,
  inputs: [...inputRecords.values()], assets, anomalies,
  repairEvidence: {
    record: inputRecords.get('repairRecord'), run: run.id,
    object: repair.object, acceptedAction: repair.action, from: repair.from, to: repair.to,
    acceptedRepair: repair.id, priorCleanupStatus: run.repairs.find(candidate => candidate.id === 'repair-001')?.status,
    requiredViews: repair.before.length, afterViews: repair.after.length, verifiedViews: repair.reviews.length,
    allRequiredViewsReviewed: repair.before.every(view => repair.reviews.some(review => review.view === view.id)),
    minimumReviewerConfidence: Math.min(...repair.reviews.map(review => review.confidence)),
    new3dGenerations: 0, generationAllowed: run.options.allowGeneration,
    fixedSightings: run.issues.filter(issue => issue.status === 'fixed').length,
    remainingOpenSightings: run.issues.filter(issue => issue.status === 'open').length,
    status: run.status, liveModelCalls: run.calls, cachedModelCalls: run.cachedCalls, totalRunModelCostUsd: run.costUsd,
    scope: 'Local bicycle defect repair in a regression copy. Other issues remain. No Global WOMPar ballots or whole-world superiority result.',
  },
};
await writeFile(path.join(OUT, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(JSON.stringify({ output: path.relative(ROOT, OUT), images: assets.map(asset => ({ file: asset.file, width: asset.width, height: asset.height })), anomalies, repair: provenance.repairEvidence }, null, 2));
