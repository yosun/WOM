// CPU renders used by compose: a front-most-splat depth map of the Marble world on the photo's camera
// grid, and a reprojection preview (world + placed meshes seen from the original camera) for checking
// alignment against the photo.
import sharp from 'sharp';
import type { Intrinsics } from './moge.ts';
import { renderShape, type Pose, type Shape } from './raster.ts';
import type { SplatCloud } from './spz.ts';

/** Front-most splat depth per pixel (Marble raw units), Infinity where no splat lands. */
export function splatDepthMap(cloud: SplatCloud, k: Intrinsics): Float32Array {
  const W = k.width, H = k.height;
  const zb = new Float32Array(W * H).fill(Infinity);
  const P = cloud.positions;
  for (let i = 0; i < cloud.count; i++) {
    const z = P[i * 3 + 2];
    if (z <= 0.05 || cloud.alphas[i] < 0.5) continue;
    const uc = (k.fx * P[i * 3]) / z + k.cx, vc = (k.fy * P[i * 3 + 1]) / z + k.cy;
    if (uc < -3 || vc < -3 || uc >= W + 3 || vc >= H + 3) continue;
    const s = Math.max(cloud.scales[i * 3], cloud.scales[i * 3 + 1], cloud.scales[i * 3 + 2]);
    const r = Math.max(0, Math.min(2, Math.round((k.fx * s) / z)));
    const ux = Math.floor(uc), vy = Math.floor(vc);
    for (let dy = -r; dy <= r; dy++) {
      const v = vy + dy;
      if (v < 0 || v >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const u = ux + dx;
        if (u < 0 || u >= W) continue;
        const p = v * W + u;
        if (z < zb[p]) zb[p] = z;
      }
    }
  }
  return zb;
}

export interface PreviewObject {
  shape: Shape;
  pose: Pose; // OpenCV camera frame, meters
}

/** Render the reconstruction from the original camera: splats (scaled to meters) plus meshes. */
export async function renderReprojection(opts: {
  k: Intrinsics;
  width: number;
  background: { width: number; height: number; rgb: Uint8Array }; // clean plate, used where no splat lands
  cloud?: SplatCloud;
  splatScale?: number;
  objects: PreviewObject[];
}): Promise<Buffer> {
  const W = opts.width;
  const H = Math.round((W * opts.k.height) / opts.k.width);
  const sx = W / opts.k.width, sy = H / opts.k.height;
  const k: Intrinsics = { fx: opts.k.fx * sx, fy: opts.k.fy * sy, cx: opts.k.cx * sx, cy: opts.k.cy * sy, width: W, height: H };
  const img = Buffer.alloc(W * H * 3);
  const zb = new Float32Array(W * H).fill(Infinity);
  const bg = opts.background;
  for (let y = 0; y < H; y++) {
    const by = Math.min(bg.height - 1, Math.floor((y * bg.height) / H));
    for (let x = 0; x < W; x++) {
      const bx = Math.min(bg.width - 1, Math.floor((x * bg.width) / W));
      const q = (by * bg.width + bx) * 3, p = (y * W + x) * 3;
      // Dim the photo fallback so gaps in the splat world stand out.
      img[p] = bg.rgb[q] * 0.35; img[p + 1] = bg.rgb[q + 1] * 0.35; img[p + 2] = bg.rgb[q + 2] * 0.35;
    }
  }
  if (opts.cloud) {
    const c = opts.cloud, s = opts.splatScale ?? 1, P = c.positions;
    for (let i = 0; i < c.count; i++) {
      const z = P[i * 3 + 2];
      if (z <= 0.05 || c.alphas[i] < 0.3) continue;
      const uc = (k.fx * P[i * 3]) / z + k.cx, vc = (k.fy * P[i * 3 + 1]) / z + k.cy;
      if (uc < -4 || vc < -4 || uc >= W + 4 || vc >= H + 4) continue;
      const sc = Math.max(c.scales[i * 3], c.scales[i * 3 + 1], c.scales[i * 3 + 2]);
      const r = Math.max(0, Math.min(3, Math.round((k.fx * sc) / z)));
      const zm = z * s;
      const ux = Math.floor(uc), vy = Math.floor(vc);
      for (let dy = -r; dy <= r; dy++) {
        const v = vy + dy;
        if (v < 0 || v >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const u = ux + dx;
          if (u < 0 || u >= W) continue;
          const p = v * W + u;
          if (zm >= zb[p]) continue;
          zb[p] = zm;
          img[p * 3] = c.colors[i * 3] * 255;
          img[p * 3 + 1] = c.colors[i * 3 + 1] * 255;
          img[p * 3 + 2] = c.colors[i * 3 + 2] * 255;
        }
      }
    }
  }
  for (const o of opts.objects) {
    const r = renderShape(o.shape, o.pose, k, { x0: 0, y0: 0, x1: W, y1: H }, W, H, { color: true });
    for (let p = 0; p < W * H; p++) {
      const inv = r.invDepth[p];
      if (!(inv > 0)) continue;
      const z = 1 / inv;
      if (z >= zb[p]) continue;
      zb[p] = z;
      if (r.color) {
        img[p * 3] = r.color[p * 3]; img[p * 3 + 1] = r.color[p * 3 + 1]; img[p * 3 + 2] = r.color[p * 3 + 2];
      } else {
        img[p * 3] = 230; img[p * 3 + 1] = 180; img[p * 3 + 2] = 110;
      }
    }
  }
  return sharp(img, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 86 }).toBuffer();
}
