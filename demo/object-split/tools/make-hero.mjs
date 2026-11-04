// Build the files the animated hero needs that are not already in assets/: a sample of the real Gaussians (assets/hero/cloud.*),
// and the photo cut into the two parts (assets/hero/layer-*.webp) plus the outlines of each part (assets/hero/part-*.webp).
//   node demo/object-split/tools/make-hero.mjs [--cloud-only]
// Reads only parts/ and assets/data.json, so it runs after build-parts.mjs and make-assets.mjs.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const DEMO = `${ROOT}/demo/object-split`, PARTS = `${DEMO}/parts`, OUT = `${DEMO}/assets/hero`;
const W = 1699, H = 926;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/* ------------------------------------------------------------------ PLY ----------------------------------------------------------------- */
export function readPly(file) {
  const buf = fs.readFileSync(file), end = buf.indexOf('end_header\n') + 11, hdr = buf.subarray(0, end).toString('latin1');
  const n = Number(/element vertex (\d+)/.exec(hdr)[1]), props = [...hdr.matchAll(/property float (\w+)/g)].map((m) => m[1]), F = props.length;
  const f = new Float32Array(buf.buffer.slice(buf.byteOffset + end, buf.byteOffset + end + n * F * 4));
  const at = Object.fromEntries(props.map((p, i) => [p, i]));
  return { n, F, f, at };
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));
const SH0 = 0.28209479177387814;

/** Rotate p by the quaternion [x, y, z, w]. */
function rotate(q, p) {
  const [x, y, z, w] = q;
  const cx = y * p[2] - z * p[1], cy = z * p[0] - x * p[2], cz = x * p[1] - y * p[0];
  return [p[0] + 2 * (w * cx + y * cz - z * cy), p[1] + 2 * (w * cy + z * cx - x * cz), p[2] + 2 * (w * cz + x * cy - y * cx)];
}

/**
 * Put every Gaussian of a part in the scene (metres, camera at the origin looking down -Z) and describe it:
 * centre, colour, opacity, size (mean of the three scales, in metres) and where it lands in the photo.
 * The same part can be placed twice (raw file with the silhouette-fit pose, aligned file with the final pose): the
 * alignment only moves Gaussians, so the two files list the same Gaussians in the same order.
 */
export function placeGaussians(plyFile, pose, fovY, firstN = Infinity) {
  const { n: nAll, F, f, at } = readPly(plyFile);
  const n = Math.min(nAll, firstN);
  const focal = (H / 2) / Math.tan((fovY * Math.PI) / 360);
  const out = { n, X: new Float32Array(n * 3), rgb: new Uint8Array(n * 3), op: new Float32Array(n), sigma: new Float32Array(n), u: new Float32Array(n), v: new Float32Array(n), d: new Float32Array(n), focal };
  for (let i = 0; i < n; i++) {
    const o = i * F;
    const r = rotate(pose.quaternion, [f[o + at.x], f[o + at.y], f[o + at.z]]);
    const X = pose.position[0] + pose.scale * r[0], Y = pose.position[1] + pose.scale * r[1], Z = pose.position[2] + pose.scale * r[2];
    out.X[i * 3] = X; out.X[i * 3 + 1] = Y; out.X[i * 3 + 2] = Z;
    for (let c = 0; c < 3; c++) out.rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round((0.5 + SH0 * f[o + at[`f_dc_${c}`]]) * 255)));
    out.op[i] = sigmoid(f[o + at.opacity]);
    out.sigma[i] = pose.scale * Math.cbrt(Math.exp(f[o + at.scale_0] + f[o + at.scale_1] + f[o + at.scale_2]));
    const d = -Z; out.d[i] = d;
    out.u[i] = W / 2 + (X / d) * focal; out.v[i] = H / 2 - (Y / d) * focal;
  }
  return out;
}

/**
 * One Gaussian per small cell of the picture: of the opaque ones at the front surface as the photo's camera sees it, the one
 * nearest the camera whose size is not far bigger than the cell. That gives an even spread of real Gaussians over the part.
 */
export function pickSample(g, { cell, surface = 0.012, minOpacity = 0.4, maxSizeCells = 3, inMask }) {
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const front = new Float32Array(gw * gh).fill(Infinity);
  const cellOf = (i) => { const cx = Math.floor(g.u[i] / cell), cy = Math.floor(g.v[i] / cell); return cx < 0 || cy < 0 || cx >= gw || cy >= gh ? -1 : cy * gw + cx; };
  for (let i = 0; i < g.n; i++) { if (g.op[i] < minOpacity) continue; const c = cellOf(i); if (c >= 0 && g.d[i] < front[c]) front[c] = g.d[i]; }
  const best = new Int32Array(gw * gh).fill(-1), bestKey = new Float32Array(gw * gh).fill(Infinity);
  for (let i = 0; i < g.n; i++) {
    if (g.op[i] < minOpacity) continue;
    if (inMask && !inMask(g.u[i], g.v[i])) continue;
    const c = cellOf(i); if (c < 0 || g.d[i] > front[c] + surface) continue;
    const sizeCells = (g.sigma[i] * g.focal / g.d[i]) / cell; // the Gaussian's size, in cells
    const key = g.d[i] + (sizeCells > maxSizeCells ? 1 : 0) + sizeCells * 1e-4; // front first; a huge blur loses to anything smaller
    if (key < bestKey[c]) { bestKey[c] = key; best[c] = i; }
  }
  return [...best].filter((i) => i >= 0);
}

/** Write the picked Gaussians for each part into one binary body and a JSON description (see cloud.js for the layout). */
export function packCloud(parts, fovY, radiusStep = 0.00005) {
  const meta = { version: 1, fovY, photo: { w: W, h: H }, radiusStep, parts: {} };
  const chunks = [];
  let off = 0;
  for (const [name, { g, g0, idx, radius, seed }] of Object.entries(parts)) {
    const n = idx.length;
    const origin = [0, 1, 2].map((a) => idx.reduce((s, i) => s + g.X[i * 3 + a], 0) / n);
    const step = 0.0001;
    const quant = (G, label) => {
      const q = new Int16Array(n * 3);
      idx.forEach((i, k) => {
        for (let a = 0; a < 3; a++) {
          const v = Math.round((G.X[i * 3 + a] - origin[a]) / step);
          if (v < -32768 || v > 32767) throw new Error(`${name} (${label}): a Gaussian is more than ${(32767 * step).toFixed(1)} m from the part's centre`);
          q[k * 3 + a] = v;
        }
      });
      return q;
    };
    const q = quant(g, 'aligned'), q0 = quant(g0, 'silhouette fit'), col = new Uint8Array(n * 3), rq = new Uint8Array(n);
    idx.forEach((i, k) => {
      col.set(g.rgb.subarray(i * 3, i * 3 + 3), k * 3);
      rq[k] = Math.max(1, Math.min(255, Math.round(radius(g, i) / radiusStep)));
    });
    for (const arr of [q, q0, col, rq]) { chunks.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)); off += arr.byteLength; }
    if (off % 2) { chunks.push(Buffer.alloc(1)); off += 1; }
    meta.parts[name] = { n, origin: origin.map((v) => +v.toFixed(5)), step, seed };
  }
  return { meta, body: Buffer.concat(chunks) };
}

/* ------------------------------------------------------------------ the sample --------------------------------------------------------- */
async function maskFn(file) {
  const m = await sharp(file).extractChannel(0).raw().toBuffer();
  return (u, v) => { const x = Math.floor(u), y = Math.floor(v); return x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] >= 128; };
}

export async function buildCloud({ cell = 2.2, quiet = false } = {}) {
  const layout = Object.fromEntries(read(`${PARTS}/placement/layout.json`).objects.map((o) => [o.id, o]));
  const fovY = read(`${PARTS}/placement/scene.json`).camera.fovY;
  const fitPoses = read(`${PARTS}/placement/silhouette-fit-poses.json`)['split, compose fitter']; // as render-frames.mjs places the "fit" version
  const fit = (name) => fitPoses.find((o) => o.name === name);
  const log = (...a) => { if (!quiet) console.log(...a); };
  const specs = [
    // each part as the 3D model returned it (raw) and after the pixel alignment (the eye layer is a later step in the story)
    { name: 'head', raw: `${PARTS}/splats/ply/head.idol-raw.ply`, ply: `${PARTS}/splats/ply/head.aligned.ply`, pose: layout['woman-head'], fitPose: fit('woman-head'), mask: `${PARTS}/split/head-mask.png`, seed: 11 },
    { name: 'body', raw: `${PARTS}/splats/ply/body.idol-raw.ply`, ply: `${PARTS}/splats/ply/body.aligned.ply`, pose: layout['woman-body'], fitPose: fit('woman-body'), mask: `${PARTS}/split/body-mask.png`, seed: 23 },
  ];
  const parts = {};
  for (const s of specs) {
    const g = placeGaussians(s.ply, s.pose, fovY), g0 = placeGaussians(s.raw, s.fitPose, fovY);
    if (g.n !== g0.n) throw new Error(`${s.name}: the raw and aligned files list different numbers of Gaussians`);
    const inMask = await maskFn(s.mask);
    const idx = pickSample(g, { cell, inMask });
    // size: the Gaussian's own, but never so small that neighbouring cells leave a hole
    const cellWorld = (i) => (cell * g.d[i]) / g.focal;
    parts[s.name] = { g, g0, idx, seed: s.seed, radius: (gg, i) => Math.max(1.6 * gg.sigma[i], 0.62 * cellWorld(i)) };
    log(`${s.name}: ${g.n.toLocaleString('en-US')} Gaussians placed, ${idx.length.toLocaleString('en-US')} picked (one per ${cell} px cell of the picture)`);
  }
  return { ...packCloud(parts, fovY), parts, fovY };
}

/* ------------------------------------------------------------------ layers and outlines ---------------------------------------------------- */
const TINT = { hair: '#f2b85b', face: '#ff8b78', neck: '#c792ea', ear: '#f7e86b', headband: '#ff5ea8', hand: '#4cc2bb', dress: '#5aa9ff', 'arm-left': '#63d49c', 'arm-right': '#a8e86b', head: '#ff8b78', body: '#4cc2bb', seam: '#ffe066', jaw: '#ff5555' };
const SAM = ['hair', 'face', 'neck', 'ear', 'headband', 'hand', 'dress', 'arm-left', 'arm-right'];
const MASK_FILE = { ...Object.fromEntries(SAM.map((n) => [n, `${PARTS}/sam-parts/${n}.png`])), head: `${PARTS}/split/head-mask.png`, body: `${PARTS}/split/body-mask.png`, seam: `${PARTS}/split/seam-band.png`, jaw: `${PARTS}/split/jaw-fill.png` };

/** Smallest box around the on-pixels of a mask, grown by `pad` and kept inside the photo. */
function bboxOf(m, pad) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x] >= 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A translucent tint over a mask with a crisp outline, as a transparent picture just big enough to hold it. */
async function outline(name, fillAlpha) {
  const m = await sharp(MASK_FILE[name]).extractChannel(0).raw().toBuffer();
  const r = bboxOf(m, 4), rgb = [1, 3, 5].map((k) => parseInt(TINT[name].slice(k, k + 2), 16));
  const px = Buffer.alloc(r.w * r.h * 4), on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x] >= 128;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const X = r.x + x, Y = r.y + y;
    if (!on(X, Y)) continue;
    let edge = false;
    for (let dy = -2; dy <= 2 && !edge; dy++) for (let dx = -2; dx <= 2; dx++) if (!on(X + dx, Y + dy)) { edge = true; break; }
    const o = (y * r.w + x) * 4; px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2]; px[o + 3] = edge ? 240 : fillAlpha;
  }
  await sharp(px, { raw: { width: r.w, height: r.h, channels: 4 } }).webp({ quality: 92, alphaQuality: 100, effort: 5 }).toFile(`${OUT}/part-${name}.webp`);
  return { src: `assets/hero/part-${name}.webp`, rect: r, color: TINT[name] };
}

export async function buildLayers() {
  const layers = { parts: {} };
  // the head: the pipeline's own head cutout (native photo pixels; the jaw the hand hides is filled with skin), so a lifted head has no hole in it
  const headRect = { x: 509, y: -53, w: 641, h: 641 }; // where that 641 px square sits in the photo (its opaque box starts at 57,53 and the head's box at 566,0)
  const hc = await sharp(`${PARTS}/split/head-cutout.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let ax0 = 641, ay0 = 641; for (let y = 0; y < 641; y++) for (let x = 0; x < 641; x++) if (hc.data[(y * 641 + x) * 4 + 3] > 127) { if (x < ax0) ax0 = x; if (y < ay0) ay0 = y; }
  if (headRect.x + ax0 !== read(`${DEMO}/assets/data.json`).masks.head.box[0] || headRect.y + ay0 !== read(`${DEMO}/assets/data.json`).masks.head.box[1]) throw new Error('the head cutout does not sit where the head mask says');
  await sharp(`${PARTS}/split/head-cutout.png`).webp({ quality: 92, alphaQuality: 100, effort: 5 }).toFile(`${OUT}/layer-head.webp`);
  layers.head = { src: 'assets/hero/layer-head.webp', rect: headRect };
  // the body: the photo through the body mask, edges softened by a pixel
  const bm = await sharp(MASK_FILE.body).extractChannel(0).raw().toBuffer();
  const br = bboxOf(bm, 3);
  const photo = await sharp(`${PARTS}/photo/source.jpg`).removeAlpha().raw().toBuffer();
  const px = Buffer.alloc(br.w * br.h * 4);
  for (let y = 0; y < br.h; y++) for (let x = 0; x < br.w; x++) {
    const X = br.x + x, Y = br.y + y, i = Y * W + X, o = (y * br.w + x) * 4;
    if (bm[i] < 128) continue; // outside the mask stays transparent, so a lifted layer carries no halo of the room behind her
    let inside = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = X + dx, yy = Y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && bm[yy * W + xx] >= 128) inside++; }
    px[o] = photo[i * 3]; px[o + 1] = photo[i * 3 + 1]; px[o + 2] = photo[i * 3 + 2]; px[o + 3] = inside === 9 ? 255 : Math.round(255 * Math.max(0.5, inside / 9)); // a pixel on the edge is part transparent
  }
  await sharp(px, { raw: { width: br.w, height: br.h, channels: 4 } }).webp({ quality: 92, alphaQuality: 100, effort: 5 }).toFile(`${OUT}/layer-body.webp`);
  layers.body = { src: 'assets/hero/layer-body.webp', rect: br };
  for (const n of SAM) layers.parts[n] = await outline(n, 70);
  for (const n of ['head', 'body']) layers.parts[n] = await outline(n, 80);
  layers.parts.seam = await outline('seam', 150);
  layers.parts.jaw = await outline('jaw', 150);
  return layers;
}

/* ------------------------------------------------------------------ main ----------------------------------------------------------------- */
if (process.argv[1]?.endsWith('make-hero.mjs')) {
  fs.mkdirSync(OUT, { recursive: true });
  const cell = Number(process.env.CELL ?? 2.2);
  const { meta, body } = await buildCloud({ cell });
  fs.writeFileSync(`${OUT}/cloud.json`, JSON.stringify(meta));
  fs.writeFileSync(`${OUT}/cloud.bin`, body);
  console.log(`cloud.bin ${(body.length / 1e6).toFixed(2)} MB (${Object.values(meta.parts).reduce((a, p) => a + p.n, 0).toLocaleString('en-US')} Gaussians)`);
  if (!process.argv.includes('--cloud-only')) {
    const layers = await buildLayers();
    fs.writeFileSync(`${OUT}/layers.json`, JSON.stringify(layers, null, 1));
    const bytes = fs.readdirSync(OUT).filter((f) => f.endsWith('.webp')).reduce((a, f) => a + fs.statSync(`${OUT}/${f}`).size, 0);
    console.log(`${Object.keys(layers.parts).length} outlines, 2 layers: ${(bytes / 1e3).toFixed(0)} KB of webp`);
  }
}
