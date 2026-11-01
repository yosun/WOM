// Binary masks (row-major, 1 byte per pixel, 0 or 1) and box helpers.
import sharp from 'sharp';
import type { Box } from '../types.ts';

export interface Mask {
  width: number;
  height: number;
  data: Uint8Array;
}

export function emptyMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(width * height) };
}

export function maskArea(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

/** Half-open bounding box of set pixels, or null when the mask is empty. */
export function maskBox(m: Mask): Box | null {
  let x0 = m.width, y0 = m.height, x1 = -1, y1 = -1;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++) {
      if (!m.data[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

export function boxArea(b: Box) {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

export function boxIou(a: Box, b: Box) {
  const inter = boxArea({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Convert a 0-1000 grid box to pixel coordinates. */
export function gridBoxToPixels(b: Box, width: number, height: number): Box {
  return {
    x0: Math.floor((b.x0 / 1000) * width),
    y0: Math.floor((b.y0 / 1000) * height),
    x1: Math.ceil((b.x1 / 1000) * width),
    y1: Math.ceil((b.y1 / 1000) * height),
  };
}

export function maskIou(a: Mask, b: Mask) {
  let inter = 0, union = 0;
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i], y = b.data[i];
    inter += x & y;
    union += x | y;
  }
  return union ? inter / union : 0;
}

/** Morphological erosion/dilation with a square structuring element of radius r (separable). */
function morph(m: Mask, r: number, erode: boolean): Mask {
  if (r <= 0) return { ...m, data: m.data.slice() };
  const { width: w, height: h } = m;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const target = erode ? 0 : 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let hit = false;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (m.data[row + k] === target) { hit = true; break; }
      }
      tmp[row + x] = hit ? target : 1 - target;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let hit = false;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (tmp[k * w + x] === target) { hit = true; break; }
      }
      out[y * w + x] = hit ? target : 1 - target;
    }
  }
  return { width: w, height: h, data: out };
}

export const erodeMask = (m: Mask, r: number) => morph(m, r, true);
export const dilateMask = (m: Mask, r: number) => morph(m, r, false);

/** Resample a mask; a target pixel is set when at least half of its source area is set. */
export function resizeMask(m: Mask, width: number, height: number): Mask {
  const out = new Uint8Array(width * height);
  const sx = m.width / width, sy = m.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let s = 0, n = 0;
      for (let yy = y0; yy < Math.min(y1, m.height); yy++) {
        for (let xx = x0; xx < Math.min(x1, m.width); xx++) { s += m.data[yy * m.width + xx]; n++; }
      }
      out[y * width + x] = n && s * 2 >= n ? 1 : 0;
    }
  }
  return { width, height, data: out };
}

export async function maskToPng(m: Mask): Promise<Buffer> {
  const px = Buffer.alloc(m.width * m.height);
  for (let i = 0; i < px.length; i++) px[i] = m.data[i] ? 255 : 0;
  return sharp(px, { raw: { width: m.width, height: m.height, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
}

export async function maskFromPng(input: Buffer | string): Promise<Mask> {
  const { data, info } = await sharp(input).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) out[i] = data[i] >= 128 ? 1 : 0;
  return { width: info.width, height: info.height, data: out };
}

/**
 * Drop stray specks: keep the largest 8-connected component plus every component of at least `minPixels`
 * whose own box overlaps `region` (when given). Foliage and spokes legitimately split into many fragments,
 * so fragments inside the object's region are kept.
 */
export function cleanComponents(m: Mask, region?: Box, minPixels = 12): Mask {
  const { width: w, height: h } = m;
  const labels = new Int32Array(w * h);
  const comps: { size: number; box: Box }[] = [{ size: 0, box: { x0: 0, y0: 0, x1: 0, y1: 0 } }];
  const stack: number[] = [];
  let next = 1;
  for (let i = 0; i < w * h; i++) {
    if (!m.data[i] || labels[i]) continue;
    labels[i] = next;
    stack.push(i);
    let size = 0;
    const box = { x0: w, y0: h, x1: 0, y1: 0 };
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p - x) / w;
      if (x < box.x0) box.x0 = x;
      if (y < box.y0) box.y0 = y;
      if (x + 1 > box.x1) box.x1 = x + 1;
      if (y + 1 > box.y1) box.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (m.data[q] && !labels[q]) { labels[q] = next; stack.push(q); }
        }
      }
    }
    comps.push({ size, box });
    next++;
  }
  if (next <= 2) return m;
  let best = 1;
  for (let l = 1; l < comps.length; l++) if (comps[l].size > comps[best].size) best = l;
  const keep = new Uint8Array(comps.length);
  for (let l = 1; l < comps.length; l++) {
    if (l === best) { keep[l] = 1; continue; }
    if (comps[l].size < minPixels) continue;
    const b = comps[l].box;
    const inRegion = !region || (b.x1 > region.x0 && b.x0 < region.x1 && b.y1 > region.y0 && b.y0 < region.y1);
    if (inRegion) keep[l] = 1;
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = keep[labels[i]];
  return { width: w, height: h, data: out };
}
