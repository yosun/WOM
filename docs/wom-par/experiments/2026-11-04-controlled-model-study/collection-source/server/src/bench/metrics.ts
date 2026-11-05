// How well a placement lines the asset up with the photo, measured from the photo's camera.
//
//   iou          silhouette vs. the SAM mask (pixels hidden by something closer in MoGe depth and parts
//                beyond the image border are not counted against it) — what the fitter optimizes
//   colorErr     mean |rendered colour − photo| where both cover the object, 0–1 — catches wrong yaw
//   depthErr     median |ln(rendered depth / MoGe depth)| on the visible surface — distance along the ray
//   contactGapM  lowest point of the asset minus the local ground height, metres (+ floating, − sunk)
//   tiltDeg      angle between the asset's up axis and gravity
import { placementFromPose } from '../geometry/pose.ts';
import { renderShape, type Pose } from '../geometry/raster.ts';
import { median } from '../util.ts';
import { groundHeight, type BenchAsset, type BenchObject, type BenchWorld } from './context.ts';
import { cropAround, lowestHeight } from './render.ts';

export interface PlacementMetrics {
  iou: number;
  colorErr: number;
  depthErr: number;
  contactGapM: number;
  tiltDeg: number;
  yawDeg: number;
  heightM: number;
  /** Distance between rendered and mask centroids, as a fraction of the mask box diagonal. */
  centroidErr: number;
}

export function evaluatePlacement(world: BenchWorld, obj: BenchObject, asset: BenchAsset, pose: Pose): PlacementMetrics {
  const { k, moge } = world;
  const crop = cropAround(world, obj.box, 0.3);
  const win = { x0: crop.x0 / world.srcScaleX, y0: crop.y0 / world.srcScaleY, x1: crop.x1 / world.srcScaleX, y1: crop.y1 / world.srcScaleY };
  const long = Math.max(win.x1 - win.x0, win.y1 - win.y0);
  const res = 360 / long;
  const W = Math.max(24, Math.round((win.x1 - win.x0) * res)), H = Math.max(24, Math.round((win.y1 - win.y0) * res));
  const pxW = (win.x1 - win.x0) / W, pxH = (win.y1 - win.y0) / H;
  const r = renderShape(asset.shape, pose, k, win, W, H, { color: true });

  let inter = 0, union = 0, cErr = 0, cN = 0;
  let mx = 0, my = 0, mn = 0, rx = 0, ry = 0, rn = 0;
  const dErr: number[] = [];
  for (let y = 0; y < H; y++) {
    const gy = win.y0 + (y + 0.5) * pxH;
    for (let x = 0; x < W; x++) {
      const gx = win.x0 + (x + 0.5) * pxW;
      if (gx < 0 || gy < 0 || gx >= k.width || gy >= k.height) continue;
      const p = y * W + x;
      const sx = Math.min(obj.mask.width - 1, Math.floor(gx * world.srcScaleX)), sy = Math.min(obj.mask.height - 1, Math.floor(gy * world.srcScaleY));
      const m = obj.mask.data[sy * obj.mask.width + sx] === 1;
      const di = Math.min(moge.height - 1, Math.floor(gy)) * moge.width + Math.min(moge.width - 1, Math.floor(gx));
      const rendered = r.invDepth[p] > 0;
      if (m) { mx += x; my += y; mn++; }
      if (rendered) { rx += x; ry += y; rn++; }
      if (m && rendered) {
        inter++;
        union++;
        if (r.color) {
          const q = (sy * world.source.width + sx) * 3;
          cErr += Math.abs(r.color[p * 3] - world.source.rgb[q]) + Math.abs(r.color[p * 3 + 1] - world.source.rgb[q + 1]) + Math.abs(r.color[p * 3 + 2] - world.source.rgb[q + 2]);
          cN++;
        }
        if (moge.valid[di]) dErr.push(Math.abs(Math.log(1 / r.invDepth[p] / moge.depth[di])));
      } else if (m) {
        union++;
      } else if (rendered) {
        const occluded = moge.valid[di] && moge.depth[di] < (1 / r.invDepth[p]) * 0.97;
        if (!occluded) union++;
      }
    }
  }
  const pl = placementFromPose(pose, world.up, asset.frame);
  const ground = groundHeight(world, obj.box);
  const diag = Math.hypot(W, H) * ((obj.box.x1 - obj.box.x0) / (crop.x1 - crop.x0) + (obj.box.y1 - obj.box.y0) / (crop.y1 - crop.y0)) / 2;
  return {
    iou: union ? inter / union : 0,
    colorErr: cN ? cErr / cN / 765 : 1,
    depthErr: dErr.length ? median(dErr) : Number.NaN,
    contactGapM: lowestHeight(asset, pose, world.up) - ground,
    tiltDeg: pl.tiltDeg,
    yawDeg: pl.yawDeg,
    heightM: pl.heightM,
    centroidErr: mn && rn ? Math.hypot(rx / rn - mx / mn, ry / rn - my / mn) / Math.max(1, diag) : 1,
  };
}
