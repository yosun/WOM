// Detail corrector. A generated 3D part gets the broad shapes of a face right and the fine detail wrong: lashes, brows, lip
// edges come out as smears and the surface has see-through gaps. At the photo's camera the photo is ground truth for those
// regions, so for chosen regions the part is made to reproduce it:
//
//   1. A layer of new Gaussians, one per photo pixel, is laid over each region on a smoothed copy of the part's surface (the depth
//      where the part becomes half opaque), a fraction of a millimetre in front of it. It closes the see-through gaps and carries the
//      detail at photo resolution.
//   2. With positions and opacities fixed, the render is linear in the Gaussians' colours, so the colours of every Gaussian that
//      shows in a region are fitted to the photo by least squares (kept within 0..1), at the viewer's pixel ratio. Over `feather`
//      pixels outside a region the target fades back to the render as it was, and pixels farther out are held to it, so nothing
//      outside the regions changes.
//
// A region is a mask in photo pixels (SAM concept masks for eyes, brows, lips and nose work), so nothing here is specific to one
// face or one photo. Regions that lie close together are corrected together; far ones separately. The part to correct can be any part
// of the scene: the others are rendered with it so occlusion is right.
import { apply, cross, normalize, type Mat3, type Vec3 } from './math.ts';
import {
  SH_C0, blockAverage, composite, compositeContrib, makeCamera, matFromQuat, prepareSplats, project, propIndex, quatFromMatrix, withExtraRows,
  type Projection, type Roi, type SplatPly, type SplatPose,
} from './splat.ts';

export interface Region {
  name: string;
  /** 1 inside the region, photo-sized (width * height). */
  mask: Uint8Array;
  /** Pixels over which the correction fades out, outside the mask. Default: the options' `feather`. */
  feather?: number;
  /** Grow the mask by this many pixels first: a segmentation mask hugs the feature, while lids, lashes and liner lie just outside it. */
  grow?: number;
}

export interface CorrectorOptions {
  /** Where the layer sits relative to the part's surface, in mm (negative = in front of it). */
  deltaMm: number;
  /** Size of a layer Gaussian, in pixels of the photo's camera. */
  sigmaPx: number;
  /** Screen pixels per photo pixel in the colour fit (2 = what a pixel-ratio-2 screen shows). */
  fitScale: number;
  iterations: number;
  /** Pull of the fitted colours back towards the ones they started with. */
  lambda: number;
  /** A Gaussian takes part in the fit when at least this much of it shows inside a region. */
  minShow: number;
  /** Layer Gaussians are made where the region weight is at least this. */
  layerMinWeight: number;
  /** Margin (px) around a region group that the fit may touch. */
  margin: number;
  feather: number;
  /** Thickness of a layer Gaussian relative to its width. */
  thickness: number;
  /** Blur (px) of the surface the layer follows. */
  surfaceSigma: number;
  /** Fill small holes and gaps in the region masks by this many pixels (a close). */
  closePx: number;
}

export const DEFAULT_CORRECTOR: CorrectorOptions = {
  deltaMm: -0.3, sigmaPx: 0.7, fitScale: 2, iterations: 500, lambda: 0.02, minShow: 0.1, layerMinWeight: 0.25, margin: 32, feather: 10, thickness: 0.3, surfaceSigma: 3, closePx: 2,
};

export interface CorrectorInput {
  width: number;
  height: number;
  fovY: number;
  /** The photo and the picture behind the figure (the clean plate), both RGB, width * height * 3. */
  photo: Uint8Array;
  backdrop: Uint8Array;
  /** All parts of the figure, with the poses they are shown at; `target` is the one that gets corrected. */
  parts: { ply: SplatPly; pose: SplatPose }[];
  target: number;
  regions: Region[];
  options?: Partial<CorrectorOptions>;
}

/** How closely one region's render matches the photo. */
export interface RegionMetric {
  name: string;
  pixels: number;
  /** Mean absolute colour error, 0..255. */
  colorError: number;
  /** Correlation of the fine detail (high-passed luminance) with the photo's, -1..1. */
  detailMatch: number;
  /** Variance of the Laplacian, and the photo's, so sharpness / photoSharpness is the share of the photo's detail. */
  sharpness: number;
  photoSharpness: number;
  /** Mean share of the region that shows through (transmittance). */
  seeThrough: number;
}

export interface CorrectorResult {
  /** The target part with the layer added and its colours fitted. */
  ply: SplatPly;
  added: number;
  refit: number;
  /** Per region, at the photo's own resolution and at the fit scale. */
  before: { photo: RegionMetric[]; fit: RegionMetric[] };
  after: { photo: RegionMetric[]; fit: RegionMetric[] };
  /** How much changed outside every region, over the pixels around the groups. */
  outside: { pixels: number; maxChange: number; over8: number; p99: number };
  groups: { regions: string[]; roi: Roi; added: number; refit: number }[];
  /** For looking at: each group's window rendered before and after at the fit scale, averaged to photo pixels (RGB bytes). */
  views: { roi: Roi; before: Uint8Array; after: Uint8Array; regionOf: Int16Array; names: string[] }[];
}

/* ---------------------------------------------------------------- region masks --------------------------------------------------------------- */

/** Squared distance to the nearest zero of `f` along one line (Felzenszwalb and Huttenlocher). */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    out[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Distance (px) from every pixel of a w*h window to the nearest set pixel of `mask` (0 on the mask itself). */
export function distanceToMask(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : INF;
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x];
  }
  return Float32Array.from(g, (s) => Math.sqrt(s));
}

/** Close small gaps of a mask: grow by r, then shrink by r. */
function closeMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask;
  const dist = distanceToMask(mask, w, h);
  const grown = Uint8Array.from(dist, (d) => (d <= r ? 1 : 0));
  const outside = distanceToMask(Uint8Array.from(grown, (v) => 1 - v), w, h);
  return Uint8Array.from(outside, (d, i) => (grown[i] && d > r ? 1 : 0));
}

interface PreparedRegion { name: string; mask: Uint8Array; box: Roi; feather: number }

function maskBox(mask: Uint8Array, w: number, h: number): Roi | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

const smoothstep = (v: number) => v * v * (3 - 2 * v);

/* ---------------------------------------------------------------- small image helpers --------------------------------------------------------------- */

function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) a += src[y * w + Math.min(w - 1, Math.max(0, x + j))] * k[j + r]; tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) a += tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x] * k[j + r]; out[y * w + x] = a; }
  return out;
}

/** Blur that skips NaN samples (normalized convolution), so holes take their value from the neighbours. */
function smoothSkippingNaN(D: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(3 * sigma), k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const num = new Float32Array(w * h), den = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) if (!Number.isNaN(D[p])) { num[p] = D[p]; den[p] = 1; }
  const pass = (src: Float32Array, horiz: boolean) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0;
      for (let j = -r; j <= r; j++) { const xx = horiz ? x + j : x, yy = horiz ? y : y + j; if (xx >= 0 && yy >= 0 && xx < w && yy < h) a += src[yy * w + xx] * k[j + r]; }
      out[y * w + x] = a;
    }
    return out;
  };
  const n2 = pass(pass(num, true), false), d2 = pass(pass(den, true), false);
  return Float32Array.from(n2, (v, p) => (d2[p] > 1e-3 ? v / d2[p] : NaN));
}

const grayAt = (img: Uint8Array, i: number) => 0.299 * img[i * 3] + 0.587 * img[i * 3 + 1] + 0.114 * img[i * 3 + 2];

/** Colour error, detail match and sharpness over the pixels of one region (`inside` is photo-sized). */
export function regionMetric(name: string, img: Uint8Array, photo: Uint8Array, inside: Uint8Array, W: number, H: number, seeThrough = 0): RegionMetric {
  const box = maskBox(inside, W, H);
  if (!box) return { name, pixels: 0, colorError: 0, detailMatch: 0, sharpness: 0, photoSharpness: 0, seeThrough };
  const m = 16;
  const x0 = Math.max(0, box.x0 - m), y0 = Math.max(0, box.y0 - m), x1 = Math.min(W, box.x1 + m), y1 = Math.min(H, box.y1 + m);
  const w = x1 - x0, h = y1 - y0;
  const gi = new Float32Array(w * h), gp = new Float32Array(w * h), ins = new Uint8Array(w * h);
  let mae = 0, n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y + y0) * W + x + x0, k = y * w + x;
    gi[k] = grayAt(img, i); gp[k] = grayAt(photo, i);
    ins[k] = inside[i];
    if (ins[k]) { mae += (Math.abs(img[i * 3] - photo[i * 3]) + Math.abs(img[i * 3 + 1] - photo[i * 3 + 1]) + Math.abs(img[i * 3 + 2] - photo[i * 3 + 2])) / 3; n++; }
  }
  const bi = gaussBlur(gi, w, h, 3), bp = gaussBlur(gp, w, h, 3);
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, cnt = 0;
  for (let k = 0; k < w * h; k++) if (ins[k]) { const a = gi[k] - bi[k], b = gp[k] - bp[k]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; cnt++; }
  const ncc = (sab - (sa * sb) / cnt) / Math.sqrt(Math.max(1e-12, (saa - (sa * sa) / cnt) * (sbb - (sb * sb) / cnt)));
  const lapVar = (g: Float32Array) => {
    let s1 = 0, s2 = 0, c = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      if (!ins[k]) continue;
      const L = g[k - 1] + g[k + 1] + g[k - w] + g[k + w] - 4 * g[k];
      s1 += L; s2 += L * L; c++;
    }
    return s2 / c - (s1 / c) ** 2;
  };
  return { name, pixels: n, colorError: mae / n, detailMatch: ncc, sharpness: lapVar(gi), photoSharpness: lapVar(gp), seeThrough };
}

const percentileOf = (arr: ArrayLike<number>, q: number) => { const a = Float64Array.from(arr as ArrayLike<number>).sort(); return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0; };

/* ---------------------------------------------------------------- the corrector --------------------------------------------------------------- */

export function correctRegions(input: CorrectorInput, log: (msg: string) => void = () => undefined): CorrectorResult {
  const opt: CorrectorOptions = { ...DEFAULT_CORRECTOR, ...input.options };
  const { width: W, height: H, photo, backdrop } = input;
  const S = opt.fitScale;
  const target = input.target, other = input.parts.filter((_, i) => i !== target);
  const pose = input.parts[target].pose;
  const regions: PreparedRegion[] = [];
  for (const r of input.regions) {
    let mask = closeMask(r.mask, W, H, opt.closePx);
    if (r.grow && r.grow > 0) { const d = distanceToMask(mask, W, H); mask = Uint8Array.from(d, (v) => (v <= r.grow! ? 1 : 0)); }
    const box = maskBox(mask, W, H);
    if (box) regions.push({ name: r.name, mask, box, feather: r.feather ?? opt.feather });
  }
  if (!regions.length) throw new Error('no region has any pixels');
  const maxFeather = Math.max(...regions.map((r) => r.feather));
  const margin = Math.max(opt.margin, maxFeather + 22);

  // regions that lie within reach of each other share a group (and one working window)
  type Group = { box: Roi; members: PreparedRegion[] };
  let groups: Group[] = regions.map((r) => ({ box: { x0: r.box.x0 - r.feather - margin, y0: r.box.y0 - r.feather - margin, x1: r.box.x1 + r.feather + margin, y1: r.box.y1 + r.feather + margin }, members: [r] }));
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i].box, b = groups[j].box;
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
        groups[i] = { box: { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }, members: [...groups[i].members, ...groups[j].members] };
        groups.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  groups = groups.map((g) => ({ ...g, box: { x0: Math.max(0, Math.floor(g.box.x0)), y0: Math.max(0, Math.floor(g.box.y0)), x1: Math.min(W, Math.ceil(g.box.x1)), y1: Math.min(H, Math.ceil(g.box.y1)) } }));

  const cam1 = makeCamera({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: input.fovY, width: W, height: H });
  const camS = makeCamera({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: input.fovY, width: W * S, height: H * S });
  const scaleRoi = (roi: Roi, s: number): Roi => ({ x0: roi.x0 * s, y0: roi.y0 * s, x1: roi.x1 * s, y1: roi.y1 * s });
  const otherSplats = other.map((p) => ({ splats: prepareSplats(p.ply), pose: p.pose }));
  const projectOthers = (cam: typeof cam1, roi: Roi): Projection[] => otherSplats.map((o) => project(o.splats, o.pose, cam, roi));

  let current = input.parts[target].ply;
  const photoF = (i: number) => photo[i] / 255;
  const pasted = (rgbF: Float32Array, roi: Roi): Uint8Array => {
    const rw = roi.x1 - roi.x0, img = Uint8Array.from(photo);
    for (let p = 0; p < rgbF.length / 3; p++) {
      const gi = (Math.floor(p / rw) + roi.y0) * W + (p % rw) + roi.x0;
      for (let c = 0; c < 3; c++) img[gi * 3 + c] = Math.round(255 * Math.min(1, Math.max(0, rgbF[p * 3 + c])));
    }
    return img;
  };

  const before = { photo: [] as RegionMetric[], fit: [] as RegionMetric[] };
  const after = { photo: [] as RegionMetric[], fit: [] as RegionMetric[] };
  const outsideChange: number[] = [];
  const groupStats: CorrectorResult['groups'] = [];
  const views: CorrectorResult['views'] = [];
  let totalAdded = 0, totalRefit = 0;

  for (const group of groups) {
    const roi = group.box, rw = roi.x1 - roi.x0, rh = roi.y1 - roi.y0, NP = rw * rh;
    const names = group.members.map((m) => m.name);
    const t0 = Date.now();
    const gIdx = (p: number) => (Math.floor(p / rw) + roi.y0) * W + (p % rw) + roi.x0;

    // region weights in the working window
    const wReg = new Float32Array(NP), regionOf = new Int16Array(NP).fill(-1);
    group.members.forEach((m, mi) => {
      const sub = new Uint8Array(NP);
      for (let p = 0; p < NP; p++) sub[p] = m.mask[gIdx(p)];
      const dist = distanceToMask(sub, rw, rh);
      for (let p = 0; p < NP; p++) {
        const v = Math.max(0, 1 - dist[p] / m.feather), wv = smoothstep(v);
        if (wv > wReg[p]) wReg[p] = wv;
        if (sub[p]) regionOf[p] = mi;
      }
    });
    const bg = new Float32Array(NP * 3);
    for (let p = 0; p < NP; p++) for (let c = 0; c < 3; c++) bg[p * 3 + c] = backdrop[gIdx(p) * 3 + c] / 255;

    /** The window as a photo-pixel render (the mean of each S x S block of a render at scale S), the backdrop behind see-through pixels. */
    const renderWindow = (ply: SplatPly, scale: number) => {
      const cam = scale === 1 ? cam1 : camS, rS = scaleRoi(roi, scale);
      const tgt = prepareSplats(ply);
      const r = composite([project(tgt, pose, cam, rS), ...projectOthers(cam, rS)], rS);
      const d = blockAverage(r, roi, scale);
      const rgb = new Float32Array(NP * 3);
      for (let p = 0; p < NP; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = d.C[p * 3 + c] + d.T[p] * bg[p * 3 + c];
      return { rgb, T: d.T };
    };
    const beforeFit = renderWindow(current, S), beforePhoto = renderWindow(current, 1);
    const tgtRgb = new Float32Array(NP * 3);
    for (let p = 0; p < NP; p++) { const g = gIdx(p), w = wReg[p]; for (let c = 0; c < 3; c++) tgtRgb[p * 3 + c] = w * photoF(g * 3 + c) + (1 - w) * beforeFit.rgb[p * 3 + c]; }

    // 1. the surface: the depth where the part becomes half opaque, smoothed
    const splats0 = prepareSplats(current);
    const ph1 = project(splats0, pose, cam1, roi);
    const r1 = compositeContrib([ph1, ...projectOthers(cam1, roi)], roi, 0);
    const D50 = new Float32Array(NP).fill(NaN), cum = new Float32Array(NP);
    for (let e = 0; e < r1.len; e++) {
      const p = r1.PIX[e];
      if (!Number.isNaN(D50[p])) continue;
      cum[p] += r1.WG[e];
      if (cum[p] >= 0.5) D50[p] = ph1.D[r1.ID[e]];
    }
    const Dsm = smoothSkippingNaN(D50, rw, rh, opt.surfaceSigma);

    // 2. the layer of new Gaussians
    const delta = opt.deltaMm / 1000;
    const Ro = matFromQuat(pose.quaternion), RoT: Mat3 = [Ro[0], Ro[3], Ro[6], Ro[1], Ro[4], Ro[7], Ro[2], Ro[5], Ro[8]], sP = pose.scale, tP = pose.position;
    const pointAt = (x: number, y: number, d: number): Vec3 => [((x + roi.x0 + 0.5 - cam1.cx) / cam1.fx) * d, (-(y + roi.y0 + 0.5 - cam1.cy) / cam1.fy) * d, -d];
    const ok = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < rw && yy < rh && !Number.isNaN(Dsm[yy * rw + xx]);
    interface LayerG { local: Vec3; q: [number, number, number, number]; s: Vec3; col: Vec3 }
    const layer: LayerG[] = [];
    let onSurface = 0;
    for (let p = 0; p < NP; p++) {
      if (wReg[p] < opt.layerMinWeight || Number.isNaN(Dsm[p])) continue;
      const x = p % rw, y = Math.floor(p / rw), d = Dsm[p] + delta;
      const P = pointAt(x, y, d);
      const local = apply(RoT, [P[0] - tP[0], P[1] - tP[1], P[2] - tP[2]]).map((v) => v / sP) as Vec3;
      let Tu: Vec3, Tv: Vec3;
      if (ok(x - 1, y) && ok(x + 1, y) && ok(x, y - 1) && ok(x, y + 1)) {
        // the 3D step for one pixel right (Tu) and one pixel down (Tv) on the smoothed surface
        const a = pointAt(x + 1, y, Dsm[p + 1] + delta), b = pointAt(x - 1, y, Dsm[p - 1] + delta);
        const c = pointAt(x, y + 1, Dsm[p + rw] + delta), e = pointAt(x, y - 1, Dsm[p - rw] + delta);
        Tu = [(a[0] - b[0]) / 2, (a[1] - b[1]) / 2, (a[2] - b[2]) / 2];
        Tv = [(c[0] - e[0]) / 2, (c[1] - e[1]) / 2, (c[2] - e[2]) / 2];
        onSurface++;
      } else {
        // no neighbours to take a slope from: a disc that faces the camera
        const f = d / cam1.fy, ray = normalize(P), t1 = normalize(cross([0, 1, 0], ray)), t2 = normalize(cross(ray, t1));
        Tu = [t1[0] * f, t1[1] * f, t1[2] * f];
        Tv = [-t2[0] * f, -t2[1] * f, -t2[2] * f];
      }
      let n = normalize(cross(Tu, Tv));
      if (n[0] * P[0] + n[1] * P[1] + n[2] * P[2] > 0) n = [-n[0], -n[1], -n[2]]; // toward the camera
      const e1 = normalize(Tu), e2 = normalize(cross(n, e1));
      const len1 = Math.hypot(Tu[0], Tu[1], Tu[2]), len2 = Math.abs(Tv[0] * e2[0] + Tv[1] * e2[1] + Tv[2] * e2[2]);
      const s1 = (opt.sigmaPx * len1) / sP, s2 = (opt.sigmaPx * Math.max(len2, 0.3 * len1)) / sP, sN = opt.thickness * Math.min(s1, s2);
      const E1 = apply(RoT, e1), E2 = apply(RoT, e2), NN = apply(RoT, n); // to the part's own frame
      const [qx, qy, qz, qw] = quatFromMatrix([E1[0], E2[0], NN[0], E1[1], E2[1], NN[1], E1[2], E2[2], NN[2]]);
      layer.push({ local, q: [qw, qx, qy, qz], s: [s1, s2, sN], col: [0, 1, 2].map((c) => Math.min(1, Math.max(0, tgtRgb[p * 3 + c]))) as Vec3 });
    }

    // the part with the layer added
    const n0 = current.count;
    const layered = withExtraRows(current, layer.length);
    const F = layered.props.length;
    const iX = propIndex(layered, 'x'), iDC = propIndex(layered, 'f_dc_0'), iOp = propIndex(layered, 'opacity'), iS = propIndex(layered, 'scale_0'), iR = propIndex(layered, 'rot_0');
    layer.forEach((g, j) => {
      const b = (n0 + j) * F;
      for (let c = 0; c < 3; c++) { layered.data[b + iX + c] = g.local[c]; layered.data[b + iDC + c] = (g.col[c] - 0.5) / SH_C0; }
      layered.data[b + iOp] = Math.log(0.99 / 0.01);
      for (let c = 0; c < 3; c++) layered.data[b + iS + c] = Math.log(g.s[c]);
      for (let c = 0; c < 4; c++) layered.data[b + iR + c] = g.q[c];
    });

    // 3. fit the colours at the viewer's pixel ratio
    const roiS = scaleRoi(roi, S), swS = rw * S, inv = 1 / (S * S);
    const layeredSplats = prepareSplats(layered);
    const phS = project(layeredSplats, pose, camS, roiS);
    const rS = compositeContrib([phS, ...projectOthers(camS, roiS)], roiS, 0);
    const photoPx = (q: number) => { const x = q % swS, y = (q - x) / swS; return Math.floor(y / S) * rw + Math.floor(x / S); };
    const show = new Float32Array(phS.count);
    for (let e = 0; e < rS.len; e++) show[rS.ID[e]] += rS.WG[e] * inv * wReg[photoPx(rS.PIX[e])];
    const varOf = new Int32Array(phS.count).fill(-1);
    let nv = 0, nLayerVars = 0;
    for (let i = 0; i < phS.count; i++) if (show[i] >= opt.minShow && phS.RAD[i] <= (margin - maxFeather) * S) { varOf[i] = nv++; if (layeredSplats.rows[phS.IDX[i]] >= n0) nLayerVars++; }
    const ids = new Int32Array(nv);
    for (let i = 0; i < phS.count; i++) if (varOf[i] >= 0) ids[varOf[i]] = i;
    const c0 = new Float32Array(nv * 3);
    for (let k = 0; k < nv; k++) for (let c = 0; c < 3; c++) c0[k * 3 + c] = phS.RGB[ids[k] * 3 + c];
    // merge each Gaussian's screen-pixel weights into photo-pixel weights (a Gaussian's entries are contiguous)
    let cap = 1 << 20, NE = 0, EP = new Int32Array(cap), EK = new Int32Array(cap), EW = new Float32Array(cap);
    const push = (p: number, k: number, w: number) => {
      if (NE === cap) { cap *= 2; const a = new Int32Array(cap); a.set(EP); EP = a; const b = new Int32Array(cap); b.set(EK); EK = b; const c = new Float32Array(cap); c.set(EW); EW = c; }
      EP[NE] = p; EK[NE] = k; EW[NE] = w; NE++;
    };
    const acc = new Map<number, number>();
    for (let e = 0; e < rS.len;) {
      const i = rS.ID[e];
      let e2 = e;
      while (e2 < rS.len && rS.ID[e2] === i) e2++;
      const k = varOf[i];
      if (k >= 0) {
        acc.clear();
        for (let q = e; q < e2; q++) { const pp = photoPx(rS.PIX[q]); acc.set(pp, (acc.get(pp) ?? 0) + rS.WG[q] * inv); }
        for (const [pp, w] of acc) push(pp, k, w);
      }
      e = e2;
    }
    const dS = blockAverage({ C: rS.C, T: rS.T }, roi, S);
    const fixed = new Float32Array(NP * 3);
    for (let p = 0; p < NP; p++) for (let c = 0; c < 3; c++) fixed[p * 3 + c] = dS.C[p * 3 + c] + dS.T[p] * bg[p * 3 + c];
    for (let e = 0; e < NE; e++) for (let c = 0; c < 3; c++) fixed[EP[e] * 3 + c] -= EW[e] * c0[EK[e] * 3 + c];

    // the Lipschitz constant of the gradient, by power iteration
    const u = new Float32Array(NP), vv = new Float32Array(nv).fill(1), z = new Float32Array(nv);
    let L = 1;
    for (let it = 0; it < 40; it++) {
      u.fill(0);
      for (let e = 0; e < NE; e++) u[EP[e]] += EW[e] * vv[EK[e]];
      for (let k = 0; k < nv; k++) z[k] = opt.lambda * vv[k];
      for (let e = 0; e < NE; e++) z[EK[e]] += EW[e] * u[EP[e]];
      let nz = 0, nn = 0;
      for (let k = 0; k < nv; k++) { nz += z[k] * z[k]; nn += vv[k] * vv[k]; }
      L = Math.sqrt(nz / nn);
      const s = 1 / Math.sqrt(nz);
      for (let k = 0; k < nv; k++) vv[k] = z[k] * s;
    }
    L *= 1.02;
    const x = Float32Array.from(c0), xOld = new Float32Array(nv * 3), yv = Float32Array.from(c0), g = new Float32Array(nv * 3), res = new Float32Array(NP * 3);
    const residual = (cols: Float32Array) => {
      res.set(fixed);
      for (let e = 0; e < NE; e++) { const p = EP[e] * 3, k = EK[e] * 3, w = EW[e]; res[p] += w * cols[k]; res[p + 1] += w * cols[k + 1]; res[p + 2] += w * cols[k + 2]; }
      for (let i = 0; i < NP * 3; i++) res[i] -= tgtRgb[i];
    };
    const inside = (p: number) => regionOf[p] >= 0;
    const meanError = () => { residual(x); let s = 0, n = 0; for (let p = 0; p < NP; p++) if (inside(p)) { s += Math.abs(res[p * 3]) + Math.abs(res[p * 3 + 1]) + Math.abs(res[p * 3 + 2]); n += 3; } return (255 * s) / Math.max(1, n); };
    const err0 = meanError();
    let t = 1;
    for (let it = 1; it <= opt.iterations; it++) {
      residual(yv);
      for (let k = 0; k < nv * 3; k++) g[k] = opt.lambda * (yv[k] - c0[k]);
      for (let e = 0; e < NE; e++) { const p = EP[e] * 3, k = EK[e] * 3, w = EW[e]; g[k] += w * res[p]; g[k + 1] += w * res[p + 1]; g[k + 2] += w * res[p + 2]; }
      xOld.set(x);
      for (let k = 0; k < nv * 3; k++) { const val = yv[k] - g[k] / L; x[k] = val < 0 ? 0 : val > 1 ? 1 : val; }
      const tn = (1 + Math.sqrt(1 + 4 * t * t)) / 2, mom = (t - 1) / tn;
      t = tn;
      for (let k = 0; k < nv * 3; k++) yv[k] = x[k] + mom * (x[k] - xOld[k]);
    }
    const err1 = meanError();
    for (let k = 0; k < nv; k++) {
      const row = layeredSplats.rows[phS.IDX[ids[k]]];
      for (let c = 0; c < 3; c++) layered.data[row * F + iDC + c] = (x[k * 3 + c] - 0.5) / SH_C0;
    }
    current = layered;
    totalAdded += layer.length; totalRefit += nv;
    groupStats.push({ regions: names, roi, added: layer.length, refit: nv });
    log(`${names.join(' + ')}: window ${rw}x${rh}; layer ${layer.length} Gaussians (${onSurface} along the surface); fit ${nv} Gaussians (${nLayerVars} new); mean error inside ${err0.toFixed(2)} -> ${err1.toFixed(2)}/255 (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

    // 4. check the written part against the photo
    const afterFit = renderWindow(current, S), afterPhoto = renderWindow(current, 1);
    const insideOf = (mi: number) => { const m = new Uint8Array(W * H); for (let p = 0; p < NP; p++) if (regionOf[p] === mi) m[gIdx(p)] = 1; return m; };
    const stats = (render: { rgb: Float32Array; T: Float32Array }, mi: number) => {
      const ins = insideOf(mi);
      let st = 0, n = 0;
      for (let p = 0; p < NP; p++) if (regionOf[p] === mi) { st += render.T[p]; n++; }
      return regionMetric(group.members[mi].name, pasted(render.rgb, roi), photo, ins, W, H, st / Math.max(1, n));
    };
    group.members.forEach((_, mi) => {
      before.fit.push(stats(beforeFit, mi)); after.fit.push(stats(afterFit, mi));
      before.photo.push(stats(beforePhoto, mi)); after.photo.push(stats(afterPhoto, mi));
    });
    const toBytes = (rgbF: Float32Array) => Uint8Array.from(rgbF, (v) => Math.round(255 * Math.min(1, Math.max(0, v))));
    views.push({ roi, before: toBytes(beforeFit.rgb), after: toBytes(afterFit.rgb), regionOf, names });
    // nothing outside the regions may change
    const imgB = pasted(beforeFit.rgb, roi), imgA = pasted(afterFit.rgb, roi);
    for (let p = 0; p < NP; p++) if (wReg[p] === 0) { const gi = gIdx(p); outsideChange.push(Math.max(Math.abs(imgA[gi * 3] - imgB[gi * 3]), Math.abs(imgA[gi * 3 + 1] - imgB[gi * 3 + 1]), Math.abs(imgA[gi * 3 + 2] - imgB[gi * 3 + 2]))); }
  }

  return {
    ply: current, added: totalAdded, refit: totalRefit, before, after,
    outside: { pixels: outsideChange.length, maxChange: outsideChange.reduce((m, v) => Math.max(m, v), 0), over8: outsideChange.filter((v) => v > 8).length, p99: percentileOf(outsideChange, 0.99) },
    groups: groupStats,
    views,
  };
}
