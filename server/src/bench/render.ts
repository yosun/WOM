// Images for the placement benchmark: the asset turntable a model chooses its yaw from, and overlays
// of a placement on the photo (for tool feedback and the report).
import sharp from 'sharp';
import type { Mask } from '../geometry/mask.ts';
import { apply, type Vec3 } from '../geometry/math.ts';
import { poseFromPlacement } from '../geometry/pose.ts';
import { renderShape, type Pose } from '../geometry/raster.ts';
import type { Box } from '../types.ts';
import type { BenchAsset, BenchObject, BenchWorld } from './context.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function labelSvg(w: number, h: number, lines: { text: string; x: number; y: number; size?: number; color?: string; anchor?: string; weight?: number }[]) {
  const parts = lines.map((l) =>
    `<text x="${l.x}" y="${l.y}" font-family="Helvetica, Arial, sans-serif" font-size="${l.size ?? 15}" font-weight="${l.weight ?? 600}" fill="${l.color ?? '#fff'}" text-anchor="${l.anchor ?? 'start'}" stroke="rgba(0,0,0,0.65)" stroke-width="3" paint-order="stroke">${esc(l.text)}</text>`,
  );
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`);
}

/** A turntable sheet has four tiles a row, 6 px apart. */
const TURNTABLE_COLS = 4;
const TURNTABLE_GAP = 6;

/** Where tile `index` of a turntable sheet with `tile`-pixel tiles lies: x0, y0, x1, y1 in sheet pixels. */
export function turntableTileBox(index: number, tile: number): [number, number, number, number] {
  const left = (index % TURNTABLE_COLS) * (tile + TURNTABLE_GAP);
  const top = Math.floor(index / TURNTABLE_COLS) * (tile + TURNTABLE_GAP);
  return [left, top, left + tile, top + tile];
}

/**
 * Render the asset at several yaws, seen from the photo camera's elevation, as one labelled sheet.
 * Tile `yaw` shows how the asset would look in the photo if it were placed with that yaw.
 */
export async function renderTurntable(asset: BenchAsset, elevationDeg: number, yaws = [0, 45, 90, 135, 180, 225, 270, 315], tile = 240): Promise<Buffer> {
  const half = (14 * Math.PI) / 180;
  const f = tile / 2 / Math.tan(half);
  const k = { fx: f, fy: f, cx: tile / 2, cy: tile / 2, width: tile, height: tile };
  const e = (elevationDeg * Math.PI) / 180;
  const up: Vec3 = [0, -Math.cos(e), -Math.sin(e)];
  const H = asset.frame.size[1];
  const extent = Math.max(...asset.frame.size);
  const D = (1.25 * extent) / (2 * Math.tan(half));
  const base: Vec3 = [-(H / 2) * up[0], -(H / 2) * up[1], D - (H / 2) * up[2]];
  const cols = TURNTABLE_COLS, rows = Math.ceil(yaws.length / cols);
  const tiles: { input: Buffer; left: number; top: number }[] = [];
  for (let i = 0; i < yaws.length; i++) {
    const pose = poseFromPlacement({ base, yawDeg: yaws[i], pitchDeg: 0, rollDeg: 0, heightM: H }, up, asset.frame);
    const r = renderShape(asset.shape, pose, k, { x0: 0, y0: 0, x1: tile, y1: tile }, tile, tile, { color: true });
    const rgb = Buffer.alloc(tile * tile * 3);
    for (let p = 0; p < tile * tile; p++) {
      const on = r.invDepth[p] > 0 && r.color;
      rgb[p * 3] = on ? r.color![p * 3] : 58;
      rgb[p * 3 + 1] = on ? r.color![p * 3 + 1] : 54;
      rgb[p * 3 + 2] = on ? r.color![p * 3 + 2] : 50;
    }
    // Base pivot marker: a red cross, 2 px thick.
    const bu = Math.round((f * base[0]) / base[2] + tile / 2), bv = Math.round((f * base[1]) / base[2] + tile / 2);
    for (let d = -6; d <= 6; d++) {
      for (const t of [0, 1]) {
        for (const [xx, yy] of [[bu + d, bv + t], [bu + t, bv + d]]) {
          if (xx < 0 || yy < 0 || xx >= tile || yy >= tile) continue;
          const q = (yy * tile + xx) * 3;
          rgb[q] = 255; rgb[q + 1] = 40; rgb[q + 2] = 40;
        }
      }
    }
    const img = await sharp(rgb, { raw: { width: tile, height: tile, channels: 3 } })
      .composite([{ input: labelSvg(tile, tile, [{ text: `yaw ${yaws[i]}°`, x: 10, y: 24, size: 18 }]) }])
      .png()
      .toBuffer();
    const [left, top] = turntableTileBox(i, tile);
    tiles.push({ input: img, left, top });
  }
  return sharp({ create: { width: cols * tile + (cols - 1) * TURNTABLE_GAP, height: rows * tile + (rows - 1) * TURNTABLE_GAP, channels: 3, background: '#ffffff' } })
    .composite(tiles)
    .jpeg({ quality: 88 })
    .toBuffer();
}

/** The photo with the object's mask outlined (so a model knows which object is meant). */
export async function photoWithOutline(world: BenchWorld, obj: BenchObject, maxSide = 1536): Promise<Buffer> {
  const { width: W, height: H } = world.source;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.round(W * scale), h = Math.round(H * scale);
  const rgb = await sharp(world.sourceJpeg).resize(w, h).removeAlpha().raw().toBuffer();
  drawOutline(rgb, w, h, obj.mask, scale, { x0: 0, y0: 0 }, [255, 0, 220], Math.max(2, Math.round(3 * scale * 1.5)));
  return sharp(rgb, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

/** Draw the boundary of a source-resolution mask into an RGB buffer that shows a (scaled, offset) view. */
function drawOutline(rgb: Buffer, w: number, h: number, mask: Mask, scale: number, origin: { x0: number; y0: number }, color: [number, number, number], thick = 2) {
  const at = (x: number, y: number) => {
    const sx = Math.floor(origin.x0 + x / scale), sy = Math.floor(origin.y0 + y / scale);
    return sx >= 0 && sy >= 0 && sx < mask.width && sy < mask.height && mask.data[sy * mask.width + sx] === 1;
  };
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (!at(x, y)) continue;
      if (at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)) continue;
      for (let dy = 0; dy < thick; dy++) {
        for (let dx = 0; dx < thick; dx++) {
          const xx = Math.min(w - 1, x + dx - (thick >> 1)), yy = Math.min(h - 1, y + dy - (thick >> 1));
          if (xx < 0 || yy < 0) continue;
          const q = (yy * w + xx) * 3;
          rgb[q] = color[0]; rgb[q + 1] = color[1]; rgb[q + 2] = color[2];
        }
      }
    }
  }
}

/** Source-pixel crop around an object (padded), clamped to the image. */
export function cropAround(world: BenchWorld, box: Box, pad = 0.4): Box {
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  return {
    x0: Math.max(0, Math.floor(box.x0 - bw * pad)),
    y0: Math.max(0, Math.floor(box.y0 - bh * pad)),
    x1: Math.min(world.source.width, Math.ceil(box.x1 + bw * pad)),
    y1: Math.min(world.source.height, Math.ceil(box.y1 + bh * pad)),
  };
}

/**
 * The placed asset composited over a crop of the photo: asset colours at 60%, the SAM mask in magenta
 * and the rendered silhouette in cyan.
 */
export async function renderOverlay(world: BenchWorld, obj: BenchObject, asset: BenchAsset, pose: Pose, opts: { size?: number; title?: string; subtitle?: string } = {}): Promise<Buffer> {
  const crop = cropAround(world, obj.box);
  const cw = crop.x1 - crop.x0, ch = crop.y1 - crop.y0;
  const size = opts.size ?? 448;
  const scale = size / Math.max(cw, ch);
  const w = Math.max(16, Math.round(cw * scale)), h = Math.max(16, Math.round(ch * scale));
  const rgb = await sharp(world.sourceJpeg).extract({ left: crop.x0, top: crop.y0, width: cw, height: ch }).resize(w, h).removeAlpha().raw().toBuffer();
  const win = { x0: crop.x0 / world.srcScaleX, y0: crop.y0 / world.srcScaleY, x1: crop.x1 / world.srcScaleX, y1: crop.y1 / world.srcScaleY };
  const r = renderShape(asset.shape, pose, world.k, win, w, h, { color: true });
  const on = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (!(r.invDepth[p] > 0)) continue;
    on[p] = 1;
    if (r.color) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round(rgb[p * 3 + c] * 0.4 + r.color[p * 3 + c] * 0.6);
  }
  drawOutline(rgb, w, h, obj.mask, scale, crop, [255, 0, 220], 2);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (on[p] && (!on[p - 1] || !on[p + 1] || !on[p - w] || !on[p + w])) { rgb[p * 3] = 0; rgb[p * 3 + 1] = 255; rgb[p * 3 + 2] = 255; }
    }
  }
  const lines = [];
  if (opts.title) lines.push({ text: opts.title, x: 8, y: 22, size: 16 });
  if (opts.subtitle) lines.push({ text: opts.subtitle, x: 8, y: h - 10, size: 13, weight: 500 });
  const img = sharp(rgb, { raw: { width: w, height: h, channels: 3 } });
  return (lines.length ? img.composite([{ input: labelSvg(w, h, lines) }]) : img).jpeg({ quality: 86 }).toBuffer();
}

/** Lay several labelled images out in a grid. */
export async function contactSheet(images: Buffer[], cols: number, gap = 8): Promise<Buffer> {
  const metas = await Promise.all(images.map((b) => sharp(b).metadata()));
  const cw = Math.max(...metas.map((m) => m.width ?? 0)), chh = Math.max(...metas.map((m) => m.height ?? 0));
  const rows = Math.ceil(images.length / cols);
  return sharp({ create: { width: cols * cw + (cols - 1) * gap, height: rows * chh + (rows - 1) * gap, channels: 3, background: '#ffffff' } })
    .composite(images.map((input, i) => ({ input, left: (i % cols) * (cw + gap), top: Math.floor(i / cols) * (chh + gap) })))
    .jpeg({ quality: 84 })
    .toBuffer();
}

/** Lowest point of the placed asset along gravity (robust to stray splats). */
export function lowestHeight(asset: BenchAsset, pose: Pose, up: Vec3): number {
  const P = asset.shape.kind === 'mesh' ? asset.shape.mesh.positions : asset.shape.cloud.positions;
  const n = P.length / 3;
  const step = Math.max(1, Math.floor(n / 20000));
  const hs: number[] = [];
  for (let i = 0; i < n; i += step) {
    const q = apply(pose.R, [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    hs.push(up[0] * (pose.s * q[0] + pose.t[0]) + up[1] * (pose.s * q[1] + pose.t[1]) + up[2] * (pose.s * q[2] + pose.t[2]));
  }
  hs.sort((a, b) => a - b);
  return hs[Math.floor(hs.length * 0.005)];
}
