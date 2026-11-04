// How close are the eyes to the photo? Measured in two separate ways, so placement and detail are never mixed up:
//   shift         where the render's eye lands relative to the photo's (px), found by cross-correlating fine detail;
//   detailMatch   how well the fine detail correlates with the photo's once that shift is undone (1 = identical);
//   colorError    mean absolute colour difference (0-255) inside the eye, with the shift undone;
//   sharpness     variance of the Laplacian inside the eye, with the shift undone (the photo's alongside).
import sharp from 'sharp';

export const W = 1699, H = 926;
/** Ellipses that hold each eye's lids, lashes, liner wing, iris and sclera (the viewer's right eye first). */
export const EYES = [
  { id: 'right', name: "Right eye (viewer's right)", cx: 832, cy: 248, a: 42, b: 24, deg: -25 },
  { id: 'left', name: 'Left eye', cx: 711, cy: 289, a: 35, b: 22, deg: -7.7 },
];
const SEARCH = 48;
/** Width (px) of the band outside each ellipse over which the eye corrector fades out. Same value as the corrector's own FEATHER. */
export const FEATHER = 10;
/** Distance (px) from a point to the nearest eye ellipse, 0 inside. The corrector changes nothing where this is FEATHER or more. */
export function distToEyes(x, y) {
  let best = Infinity;
  for (const e of EYES) {
    const t = (e.deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), dx = x - e.cx, dy = y - e.cy;
    const xr = dx * c + dy * s, yr = -dx * s + dy * c, rho = Math.hypot(xr / e.a, yr / e.b);
    best = Math.min(best, rho > 1 ? Math.hypot(xr, yr) * (1 - 1 / rho) : 0);
  }
  return best;
}

export async function loadRGB(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== W || info.height !== H) throw new Error(`${file} is ${info.width}x${info.height}, expected ${W}x${H}`);
  return data;
}
const inEllipse = (e, x, y) => {
  const t = (e.deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t), dx = x - e.cx, dy = y - e.cy;
  return Math.hypot((dx * c + dy * s) / e.a, (-dx * s + dy * c) / e.b) <= 1;
};
function blur(src, w, h, sigma) {
  const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) a += src[y * w + Math.min(w - 1, Math.max(0, x + j))] * k[j + r]; tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let j = -r; j <= r; j++) a += tmp[Math.min(h - 1, Math.max(0, y + j)) * w + x] * k[j + r]; out[y * w + x] = a; }
  return out;
}
const lumOf = (img) => { const g = new Float32Array(W * H); for (let i = 0; i < W * H; i++) g[i] = 0.299 * img[i * 3] + 0.587 * img[i * 3 + 1] + 0.114 * img[i * 3 + 2]; return g; };
const highpass = (g, sigma = 4) => { const b = blur(g, W, H, sigma), o = new Float32Array(W * H); for (let i = 0; i < o.length; i++) o[i] = g[i] - b[i]; return o; };

export function eyeMetrics(img, photo, cache = {}) {
  const gi = lumOf(img), gp = (cache.gp ??= lumOf(photo)), hi = highpass(gi), hp = (cache.hp ??= highpass(gp)), hi3 = highpass(gi, 3), hp3 = (cache.hp3 ??= highpass(gp, 3));
  return EYES.map((e) => {
    // 1. where does the render's eye land? correlate a window around the eye
    const wx = Math.round(e.a + 12), wy = Math.round(e.b + 12), x0 = Math.round(e.cx) - wx, y0 = Math.round(e.cy) - wy, ww = 2 * wx, wh = 2 * wy;
    const S = 2 * SEARCH + 1, score = new Float32Array(S * S).fill(-2);
    let best = -2, bdx = 0, bdy = 0;
    for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let sp = 0, sr = 0, spp = 0, srr = 0, spr = 0;
      for (let y = 0; y < wh; y += 1) { const py = y0 + y, ry = py + dy; if (ry < 0 || ry >= H) continue;
        for (let x = 0; x < ww; x += 1) { const px = x0 + x, rx = px + dx; if (rx < 0 || rx >= W) continue;
          const a = hp[py * W + px], b = hi[ry * W + rx]; sp += a; sr += b; spp += a * a; srr += b * b; spr += a * b; } }
      const n = ww * wh, vp = spp - (sp * sp) / n, vr = srr - (sr * sr) / n;
      if (vp < 1e-9 || vr < 1e-9) continue;
      const c = (spr - (sp * sr) / n) / Math.sqrt(vp * vr);
      score[(dy + SEARCH) * S + dx + SEARCH] = c;
      if (c > best) { best = c; bdx = dx; bdy = dy; }
    }
    const at = (dx, dy) => (Math.abs(dx) > SEARCH || Math.abs(dy) > SEARCH ? NaN : score[(dy + SEARCH) * S + dx + SEARCH]);
    const par = (m, c, p) => { const d = m - 2 * c + p; return Number.isFinite(d) && d < 0 ? (0.5 * (m - p)) / d : 0; };
    const sx = bdx + par(at(bdx - 1, bdy), best, at(bdx + 1, bdy)), sy = bdy + par(at(bdx, bdy - 1), best, at(bdx, bdy + 1));
    // 2. with the shift undone, compare the eye itself
    const ix = Math.round(sx), iy = Math.round(sy);
    const r = Math.max(e.a, e.b) + 6, ex0 = Math.max(1, Math.floor(e.cx - r)), ex1 = Math.min(W - 1, Math.ceil(e.cx + r)), ey0 = Math.max(1, Math.floor(e.cy - r)), ey1 = Math.min(H - 1, Math.ceil(e.cy + r));
    let mae = 0, n = 0, l1 = 0, l2 = 0, c1 = 0, p1 = 0, p2 = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let y = ey0; y < ey1; y++) for (let x = ex0; x < ex1; x++) {
      if (!inEllipse(e, x + 0.5, y + 0.5)) continue;
      const rx = x + ix, ry = y + iy, ri = ry * W + rx, pi = y * W + x;
      if (rx < 1 || ry < 1 || rx >= W - 1 || ry >= H - 1) continue;
      mae += (Math.abs(img[ri * 3] - photo[pi * 3]) + Math.abs(img[ri * 3 + 1] - photo[pi * 3 + 1]) + Math.abs(img[ri * 3 + 2] - photo[pi * 3 + 2])) / 3; n++;
      const L = gi[ri - 1] + gi[ri + 1] + gi[ri - W] + gi[ri + W] - 4 * gi[ri]; l1 += L; l2 += L * L;
      const Lp = gp[pi - 1] + gp[pi + 1] + gp[pi - W] + gp[pi + W] - 4 * gp[pi]; p1 += Lp; p2 += Lp * Lp; c1++;
      const a = hi3[ri], b = hp3[pi]; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
    }
    return {
      id: e.id, pixels: n, shiftPx: Math.hypot(sx, sy), shift: [sx, sy], detailMatch: (sab - (sa * sb) / c1) / Math.sqrt((saa - (sa * sa) / c1) * (sbb - (sb * sb) / c1)), colorError: mae / n,
      sharpness: l2 / c1 - (l1 / c1) ** 2, photoSharpness: p2 / c1 - (p1 / c1) ** 2,
    };
  });
}
