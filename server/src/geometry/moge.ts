// Load MoGe-2 outputs (points.exr, depth.exr, mask.png, normal.exr) into top-down arrays
// and estimate the camera intrinsics the point map implies.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { FloatType } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

export interface MogeMaps {
  width: number;
  height: number;
  /** Camera-space points, OpenCV frame (x right, y down, z forward), meters. 3 floats per pixel, top row first. */
  points: Float32Array;
  /** z-depth in meters, top row first. */
  depth: Float32Array;
  valid: Uint8Array;
  /** Unit normals in the OpenGL/three.js camera frame (x right, y up, z toward the viewer). */
  normals?: Float32Array;
}

export interface Intrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

async function readExr(file: string, channels: number) {
  const buf = await readFile(file);
  const loader = new EXRLoader();
  loader.setDataType(FloatType);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const parsed = loader.parse(ab) as { width: number; height: number; data: Float32Array };
  const { width, height, data } = parsed;
  const stride = data.length / (width * height);
  const out = new Float32Array(width * height * channels);
  // EXRLoader writes rows bottom-up for WebGL; flip back to image order.
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) {
      const s = (srcRow + x) * stride;
      const d = (y * width + x) * channels;
      for (let c = 0; c < channels; c++) out[d + c] = data[s + c];
    }
  }
  return { width, height, data: out };
}

export async function loadMoge(files: { points: string; depth?: string; mask?: string; normal?: string }): Promise<MogeMaps> {
  const pts = await readExr(files.points, 3);
  const { width, height } = pts;
  const n = width * height;
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) depth[i] = pts.data[i * 3 + 2];
  const valid = new Uint8Array(n);
  let maskData: Buffer | null = null;
  if (files.mask) {
    const m = await sharp(files.mask).extractChannel(0).resize(width, height, { kernel: 'nearest' }).raw().toBuffer();
    maskData = m;
  }
  for (let i = 0; i < n; i++) {
    const z = depth[i];
    valid[i] = Number.isFinite(z) && z > 1e-4 && z < 1e5 && (!maskData || maskData[i] >= 128) ? 1 : 0;
  }
  let normals: Float32Array | undefined;
  if (files.normal) {
    const nm = await readExr(files.normal, 3);
    if (nm.width === width && nm.height === height) normals = nm.data;
  }
  return { width, height, points: pts.data, depth, valid, normals };
}

/** Least-squares fit of fx, cx (and fy, cy) from x/z = (u - cx)/fx over valid pixels. */
export function estimateIntrinsics(m: MogeMaps): Intrinsics {
  let su = 0, sa = 0, suu = 0, sua = 0, nu = 0;
  let sv = 0, sb = 0, svv = 0, svb = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((m.width * m.height) / 40000)));
  for (let y = 0; y < m.height; y += step) {
    for (let x = 0; x < m.width; x += step) {
      const i = y * m.width + x;
      if (!m.valid[i]) continue;
      const X = m.points[i * 3], Y = m.points[i * 3 + 1], Z = m.points[i * 3 + 2];
      if (!(Z > 0)) continue;
      const u = x + 0.5, v = y + 0.5, a = X / Z, b = Y / Z;
      su += u; sa += a; suu += u * u; sua += u * a;
      sv += v; sb += b; svv += v * v; svb += v * b;
      nu++;
    }
  }
  if (nu < 100) {
    // Fall back to a 60° horizontal field of view.
    const fx = m.width / 2 / Math.tan((60 * Math.PI) / 360);
    return { fx, fy: fx, cx: m.width / 2, cy: m.height / 2, width: m.width, height: m.height };
  }
  // a = u/fx - cx/fx  →  slope = 1/fx, intercept = -cx/fx
  const slopeU = (nu * sua - su * sa) / (nu * suu - su * su);
  const interU = (sa - slopeU * su) / nu;
  const slopeV = (nu * svb - sv * sb) / (nu * svv - sv * sv);
  const interV = (sb - slopeV * sv) / nu;
  const fx = 1 / slopeU, fy = 1 / slopeV;
  return { fx, fy, cx: -interU * fx, cy: -interV * fy, width: m.width, height: m.height };
}

export function centeredIntrinsics(width: number, height: number, hfovDeg: number): Intrinsics {
  const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

export function scaleIntrinsics(k: Intrinsics, width: number, height: number): Intrinsics {
  const sx = width / k.width, sy = height / k.height;
  return { fx: k.fx * sx, fy: k.fy * sy, cx: k.cx * sx, cy: k.cy * sy, width, height };
}

export const hfovOf = (k: Intrinsics) => (2 * Math.atan(k.width / 2 / k.fx) * 180) / Math.PI;
export const vfovOf = (k: Intrinsics) => (2 * Math.atan(k.height / 2 / k.fy) * 180) / Math.PI;

/** Bilinear-free nearest lookup of a float map on a different grid. */
export function resampleNearest(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}
