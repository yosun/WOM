// Render-and-compare placement of one mesh in the photo's camera.
//
// 1. Orientation starts from Tripo's align_image convention (the model's +X front faces the camera,
//    +Y is image-up), turned toward the object's viewing ray, then refined over yaw/pitch.
// 2. Scale and image position are fitted so the rendered silhouette matches the SAM mask. Rendered
//    pixels outside the mask are forgiven where MoGe says something closer hides them (occlusion),
//    and pixels beyond the image border are ignored (truncation).
// 3. Depth is set so the mesh's visible surface matches MoGe's metric depth. Scaling the whole object
//    about the camera center leaves the silhouette unchanged, so this step cannot undo step 2.
import type { Mask } from './mask.ts';
import { axisAngle, fromColumns, mul, normalize, rotationBetween, type Mat3, type Vec3 } from './math.ts';
import type { Intrinsics } from './moge.ts';
import { renderShape, shapeBounds, shapePositions, withPositions, type Pose, type RenderWindow, type Shape } from './raster.ts';

/** Tripo meshes: model (+X front, +Y up, +Z viewer-left) to OpenCV camera frame for a frontal, upright view. */
export const R_TRIPO_MESH: Mat3 = fromColumns([0, 0, -1], [0, -1, 0], [-1, 0, 0]);
/**
 * TripoSplat: -Y is up, as in an OpenCV (y-down) camera frame, so identity keeps the splat upright.
 * Which way it faces varies per object (fitted yaws of 45–80° on the backyard sample), so splats are
 * fitted with the full yaw search (alignImage is false for them).
 */
export const R_CAMERA_ALIGNED: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface FitInputs {
  shape: Shape; // simplified mesh or thinned point cloud; centered internally
  /** Model-to-camera rotation for a frontal view of the object (see R_TRIPO_MESH / R_CAMERA_ALIGNED). */
  base?: Mat3;
  k: Intrinsics; // intrinsics on the fitting grid
  /** Object mask at source resolution and the scale from fitting-grid to source pixels. */
  mask: Mask;
  srcScaleX: number;
  srcScaleY: number;
  /** RGB image at source resolution (for color agreement), optional. */
  image?: { width: number; height: number; rgb: Uint8Array };
  /** Metric z-depth and validity on the fitting grid. */
  depth: Float32Array;
  valid: Uint8Array;
  alignImage: boolean;
  log?: (msg: string) => void;
}

export interface FitResult {
  pose: Pose; // includes the centering offset: p_cam = s R p_model + t
  iou: number;
  loss: number;
  yawDeg: number;
  pitchDeg: number;
  depthScale: number;
  centerDepth: number;
  heightM: number;
  evaluations: number;
}

interface Params {
  yaw: number; // degrees
  pitch: number; // degrees
  logS: number;
  u: number; // image-plane center on the fitting grid
  v: number;
  z: number; // depth of the model center
}

export function fitObject(inp: FitInputs): FitResult | null {
  const { k } = inp;
  const R_BASE = inp.base ?? R_TRIPO_MESH;
  // Center the shape at its bounding-box center so translation means "object center".
  const b = shapeBounds(inp.shape);
  const center: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const src = shapePositions(inp.shape);
  const P = new Float32Array(src.length);
  for (let i = 0; i < P.length; i += 3) {
    P[i] = src[i] - center[0];
    P[i + 1] = src[i + 1] - center[1];
    P[i + 2] = src[i + 2] - center[2];
  }
  const shape = withPositions(inp.shape, P);
  // Height along the model's up axis (Y for both conventions).
  const modelHeight = b.max[1] - b.min[1];

  // Mask box on the fitting grid.
  const mw = inp.mask.width, mh = inp.mask.height;
  let mx0 = mw, my0 = mh, mx1 = -1, my1 = -1;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (!inp.mask.data[y * mw + x]) continue;
      if (x < mx0) mx0 = x;
      if (x > mx1) mx1 = x;
      if (y < my0) my0 = y;
      if (y > my1) my1 = y;
    }
  }
  if (mx1 < 0) return null;
  const box = { x0: mx0 / inp.srcScaleX, y0: my0 / inp.srcScaleY, x1: (mx1 + 1) / inp.srcScaleX, y1: (my1 + 1) / inp.srcScaleY };
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const touches = {
    left: mx0 <= 1,
    right: mx1 >= mw - 2,
    top: my0 <= 1,
    bottom: my1 >= mh - 2,
  };

  // Fixed render window: the mask box grown by 45% on each side (may extend past the image).
  const pad = 0.45;
  const win: RenderWindow = { x0: box.x0 - bw * pad, y0: box.y0 - bh * pad, x1: box.x1 + bw * pad, y1: box.y1 + bh * pad };
  const longSide = Math.max(win.x1 - win.x0, win.y1 - win.y0);
  const res = 220 / longSide;
  const W = Math.max(24, Math.round((win.x1 - win.x0) * res));
  const H = Math.max(24, Math.round((win.y1 - win.y0) * res));
  const pxW = (win.x1 - win.x0) / W, pxH = (win.y1 - win.y0) / H;

  // Sample mask, depth, validity and color at window pixel centers.
  const inImage = new Uint8Array(W * H);
  const mWin = new Uint8Array(W * H);
  const zWin = new Float32Array(W * H);
  const vWin = new Uint8Array(W * H);
  const cWin = inp.image ? new Uint8Array(W * H * 3) : null;
  let maskPixels = 0;
  for (let y = 0; y < H; y++) {
    const gy = win.y0 + (y + 0.5) * pxH;
    for (let x = 0; x < W; x++) {
      const gx = win.x0 + (x + 0.5) * pxW;
      const p = y * W + x;
      if (gx < 0 || gy < 0 || gx >= k.width || gy >= k.height) continue;
      inImage[p] = 1;
      const sx = Math.min(mw - 1, Math.floor(gx * inp.srcScaleX)), sy = Math.min(mh - 1, Math.floor(gy * inp.srcScaleY));
      mWin[p] = inp.mask.data[sy * mw + sx];
      maskPixels += mWin[p];
      const di = Math.min(k.height - 1, Math.floor(gy)) * k.width + Math.min(k.width - 1, Math.floor(gx));
      zWin[p] = inp.depth[di];
      vWin[p] = inp.valid[di];
      if (cWin && inp.image) {
        const ix = Math.min(inp.image.width - 1, Math.floor((gx * inp.image.width) / k.width));
        const iy = Math.min(inp.image.height - 1, Math.floor((gy * inp.image.height) / k.height));
        const q = (iy * inp.image.width + ix) * 3;
        cWin[p * 3] = inp.image.rgb[q];
        cWin[p * 3 + 1] = inp.image.rgb[q + 1];
        cWin[p * 3 + 2] = inp.image.rgb[q + 2];
      }
    }
  }
  if (maskPixels < 12) return null;

  // Initial depth: median MoGe depth over the (eroded) mask.
  const zs: number[] = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const p = y * W + x;
      if (mWin[p] && mWin[p - 1] && mWin[p + 1] && mWin[p - W] && mWin[p + W] && vWin[p]) zs.push(zWin[p]);
    }
  }
  if (zs.length < 5) for (let p = 0; p < W * H; p++) if (mWin[p] && vWin[p]) zs.push(zWin[p]);
  if (zs.length === 0) return null;
  zs.sort((a, b2) => a - b2);
  const z0 = zs[Math.floor(zs.length * 0.5)];

  let evaluations = 0;
  const rayAt = (u: number, v: number): Vec3 => normalize([(u - k.cx) / k.fx, (v - k.cy) / k.fy, 1]);

  const poseOf = (p: Params): Pose => {
    const d = rayAt(p.u, p.v);
    const Rview = rotationBetween([0, 0, 1], d);
    // Yaw about the camera's vertical axis, pitch about its horizontal axis (both in the view-aligned frame).
    const Radj = mul(axisAngle([1, 0, 0], (p.pitch * Math.PI) / 180), axisAngle([0, 1, 0], (p.yaw * Math.PI) / 180));
    const R = mul(Rview, mul(Radj, R_BASE));
    return { R, t: [d[0] * p.z / d[2], d[1] * p.z / d[2], p.z], s: Math.exp(p.logS) };
  };

  interface Eval {
    loss: number;
    iou: number;
    render: ReturnType<typeof renderShape>;
  }

  const evaluate = (p: Params, withColor: boolean): Eval => {
    evaluations++;
    const pose = poseOf(p);
    const r = renderShape(shape, pose, k, win, W, H, { color: withColor && Boolean(cWin) });
    let miss = 0, extra = 0, inter = 0, union = 0, colorErr = 0, colorN = 0;
    for (let i = 0; i < W * H; i++) {
      if (!inImage[i]) continue;
      const rendered = r.invDepth[i] > 0;
      const m = mWin[i];
      if (m && rendered) {
        inter++;
        union++;
        if (r.color && cWin) {
          colorErr += Math.abs(r.color[i * 3] - cWin[i * 3]) + Math.abs(r.color[i * 3 + 1] - cWin[i * 3 + 1]) + Math.abs(r.color[i * 3 + 2] - cWin[i * 3 + 2]);
          colorN++;
        }
      } else if (m) {
        miss++;
        union++;
      } else if (rendered) {
        // Forgive coverage where a closer surface (an occluder) is visible in the photo.
        const zr = 1 / r.invDepth[i];
        const occluded = vWin[i] && zWin[i] < zr * 0.97;
        if (!occluded) { extra++; union++; }
      }
    }
    const iou = union ? inter / union : 0;
    let loss = (miss + extra) / maskPixels;
    if (colorN > 0) loss += 0.35 * (colorErr / colorN / 765);
    if (inp.alignImage) loss += 0.04 * (p.yaw / 90) ** 2 + 0.04 * (p.pitch / 45) ** 2;
    return { loss, iou, render: r };
  };

  /** Fit scale and image center from rendered vs. mask boxes (ignoring sides cut by the image border). */
  const snapToBox = (p: Params): Params => {
    let q = { ...p };
    for (let it = 0; it < 3; it++) {
      const r = renderShape(shape, poseOf(q), k, win, W, H);
      evaluations++;
      if (!r.box) {
        q.logS -= 0.7; // too large or off-window; shrink and retry
        continue;
      }
      const rx0 = win.x0 + r.box.x0 * pxW, rx1 = win.x0 + r.box.x1 * pxW;
      const ry0 = win.y0 + r.box.y0 * pxH, ry1 = win.y0 + r.box.y1 * pxH;
      const ratios: number[] = [];
      if (!touches.left && !touches.right) ratios.push(bw / Math.max(1e-6, rx1 - rx0));
      if (!touches.top && !touches.bottom) ratios.push(bh / Math.max(1e-6, ry1 - ry0));
      if (ratios.length === 0) ratios.push(Math.max(bw / Math.max(1e-6, rx1 - rx0), bh / Math.max(1e-6, ry1 - ry0)));
      const ratio = Math.min(4, Math.max(0.25, ratios.reduce((a, c) => a + c, 0) / ratios.length));
      // After scaling by `ratio` about the projected center, a rendered edge at e moves to c + (e - c) * ratio.
      // Choose the new center so the edges that are not cut by the image border land on the mask's edges.
      const place = (c: number, target: number, rendered: number) => target - (rendered - c) * ratio;
      let nu: number, nv: number;
      if (touches.left && !touches.right) nu = place(q.u, box.x1, rx1);
      else if (touches.right && !touches.left) nu = place(q.u, box.x0, rx0);
      else nu = place(q.u, (box.x0 + box.x1) / 2, (rx0 + rx1) / 2);
      if (touches.top && !touches.bottom) nv = place(q.v, box.y1, ry1);
      else if (touches.bottom && !touches.top) nv = place(q.v, box.y0, ry0);
      else nv = place(q.v, (box.y0 + box.y1) / 2, (ry0 + ry1) / 2);
      q = { ...q, logS: q.logS + Math.log(ratio), u: nu, v: nv };
    }
    return q;
  };

  // Initial guess: model about as tall as the mask box at depth z0 (+ half its own depth behind the surface).
  const initLogS = Math.log(((bh * z0) / k.fy) / Math.max(1e-6, modelHeight));
  const start: Params = { yaw: 0, pitch: 0, logS: initLogS, u: (box.x0 + box.x1) / 2, v: (box.y0 + box.y1) / 2, z: z0 * 1.05 };

  // Coarse orientation search.
  const yaws = inp.alignImage ? [0, -25, 25, -50, 50, 180] : [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  const pitches = inp.alignImage ? [0] : [-20, 0, 20];
  let best: { p: Params; e: Eval } | null = null;
  for (const yaw of yaws) {
    for (const pitch of pitches) {
      const p = snapToBox({ ...start, yaw, pitch });
      const e = evaluate(p, true);
      if (!best || e.loss < best.e.loss) best = { p, e };
    }
  }
  if (!best) return null;

  // Local refinement by coordinate descent.
  const steps: Record<keyof Params, number> = { yaw: 10, pitch: 6, logS: 0.06, u: bw * 0.03, v: bh * 0.03, z: 0 };
  const keys: (keyof Params)[] = ['logS', 'u', 'v', 'yaw', 'pitch'];
  for (let round = 0; round < 14; round++) {
    let improved = false;
    for (const key of keys) {
      for (const dir of [1, -1]) {
        let cand: Params = { ...best.p, [key]: best.p[key] + dir * steps[key] };
        // Turning the model changes its silhouette size and offset; re-fit those before judging the turn.
        if (key === 'yaw' || key === 'pitch') cand = snapToBox(cand);
        const e = evaluate(cand, true);
        if (e.loss < best.e.loss - 1e-5) {
          best = { p: cand, e };
          improved = true;
          break;
        }
      }
    }
    if (!improved) {
      for (const key of keys) steps[key] *= 0.5;
      if (steps.logS < 0.004) break;
    }
  }

  // Depth: match the mesh's visible surface to MoGe's metric depth.
  const fitDepth = (p: Params): { p: Params; k: number } => {
    const r = renderShape(shape, poseOf(p), k, win, W, H);
    evaluations++;
    const ratios: number[] = [];
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (!(r.invDepth[i] > 0) || !vWin[i] || !mWin[i]) continue;
        if (!(mWin[i - 1] && mWin[i + 1] && mWin[i - W] && mWin[i + W])) continue;
        ratios.push(zWin[i] * r.invDepth[i]);
      }
    }
    if (ratios.length < 5) return { p, k: 1 };
    ratios.sort((a, c) => a - c);
    const kk = Math.min(4, Math.max(0.25, ratios[Math.floor(ratios.length / 2)]));
    return { p: { ...p, z: p.z * kk, logS: p.logS + Math.log(kk) }, k: kk };
  };
  let depthScale = 1;
  for (let i = 0; i < 2; i++) {
    const d = fitDepth(best.p);
    depthScale *= d.k;
    best = { p: d.p, e: evaluate(d.p, false) };
  }

  const pose = poseOf(best.p);
  // Fold the centering offset back in: p_cam = s R (p - c) + t = s R p + (t - s R c).
  const Rc: Vec3 = [
    pose.R[0] * center[0] + pose.R[1] * center[1] + pose.R[2] * center[2],
    pose.R[3] * center[0] + pose.R[4] * center[1] + pose.R[5] * center[2],
    pose.R[6] * center[0] + pose.R[7] * center[1] + pose.R[8] * center[2],
  ];
  const t: Vec3 = [pose.t[0] - pose.s * Rc[0], pose.t[1] - pose.s * Rc[1], pose.t[2] - pose.s * Rc[2]];
  return {
    pose: { R: pose.R, t, s: pose.s },
    iou: best.e.iou,
    loss: best.e.loss,
    yawDeg: best.p.yaw,
    pitchDeg: best.p.pitch,
    depthScale,
    centerDepth: best.p.z,
    heightM: modelHeight * pose.s,
    evaluations,
  };
}
