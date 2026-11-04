// A small CPU Gaussian-splat renderer (EWA splatting, front-to-back alpha) that follows Spark's defaults:
// colour = 0.5 + 0.2821 * f_dc, alpha = sigmoid(opacity) * exp(-d^2 / 2) up to sqrt(8) sigma, 0.3 px^2 dilation,
// and the opacity Spark takes off for the area that dilation adds. It exists so a part can be fitted to the photo's
// pixels, which the silhouette fitter cannot do, and so a render can be taken apart: for fixed positions and opacities
// the image is linear in the Gaussians' colours, which `compositeContrib` exposes.
//
// Scene conventions are the viewer's: metres, three.js axes (the camera looks down -Z, +Y is up), quaternions are
// [x, y, z, w]. A PLY stores its rotation as (w, x, y, z) in rot_0..rot_3, scales as logs and opacity as a logit.
import { readFileSync } from 'node:fs';
import { writeFileAtomic } from '../util.ts';
import { apply, axisAngle, mul, transpose, type Mat3, type Quat, type Vec3 } from './math.ts';

export const SH_C0 = 0.28209479177387814;
const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

export interface Roi { x0: number; y0: number; x1: number; y1: number }
/** Where a part sits in the scene: position (m), rotation and a uniform scale, as the viewer's object transform. */
export interface SplatPose { position: Vec3; quaternion: Quat; scale: number }

/* ---------------------------------------------------------------- the PLY file --------------------------------------------------------------- */

/** The vertex data of a Gaussian-splat PLY: float32 properties only, rows in file order. */
export interface SplatPly {
  header: string;
  props: string[];
  count: number;
  data: Float32Array;
}

export function readSplatPly(file: string): SplatPly {
  const buf = readFileSync(file);
  const marker = buf.indexOf('end_header\n');
  if (marker < 0) throw new Error(`${file}: not a PLY file`);
  const end = marker + 'end_header\n'.length;
  const header = buf.subarray(0, end).toString('latin1');
  if (!/format binary_little_endian 1\.0/.test(header)) throw new Error(`${file}: only binary little-endian PLY is supported`);
  if (/property (?!float )/.test(header)) throw new Error(`${file}: expected a PLY whose properties are all float`);
  const count = Number(/element vertex (\d+)/.exec(header)?.[1]);
  const props = [...header.matchAll(/property float (\w+)/g)].map((m) => m[1]);
  if (!Number.isFinite(count) || props.length === 0) throw new Error(`${file}: no vertices`);
  const bytes = count * props.length * 4;
  if (buf.length - end < bytes) throw new Error(`${file}: truncated (${buf.length - end} of ${bytes} bytes)`);
  // slice() copies, which also gives the Float32Array the 4-byte alignment it needs
  const data = new Float32Array(buf.buffer.slice(buf.byteOffset + end, buf.byteOffset + end + bytes));
  return { header, props, count, data };
}

export function splatPlyBytes(ply: SplatPly): Buffer {
  const header = ply.header.replace(/element vertex \d+/, `element vertex ${ply.count}`);
  return Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(ply.data.buffer, ply.data.byteOffset, ply.count * ply.props.length * 4)]);
}

export async function writeSplatPly(file: string, ply: SplatPly) {
  await writeFileAtomic(file, splatPlyBytes(ply));
}

export function propIndex(ply: SplatPly, name: string): number {
  const i = ply.props.indexOf(name);
  if (i < 0) throw new Error(`PLY has no "${name}" property`);
  return i;
}

/** A copy of the PLY with `extra` more rows (zeroed, ready to fill) after the existing ones. */
export function withExtraRows(ply: SplatPly, extra: number): SplatPly {
  const F = ply.props.length;
  const data = new Float32Array((ply.count + extra) * F);
  data.set(ply.data.subarray(0, ply.count * F));
  return { header: ply.header, props: ply.props, count: ply.count + extra, data };
}

/* ---------------------------------------------------------------- Gaussians ready to project --------------------------------------------------------------- */

export interface Splats {
  n: number;
  /** Row of each kept Gaussian in the PLY (Gaussians that are nearly transparent are dropped). */
  rows: Int32Array;
  pos: Float32Array;
  col: Float32Array;
  op: Float32Array;
  /** R * diag(scale), row-major 3x3 per Gaussian. */
  M: Float32Array;
}

export function prepareSplats(ply: SplatPly): Splats {
  const F = ply.props.length, f = ply.data, n = ply.count;
  const iX = propIndex(ply, 'x'), iDC = propIndex(ply, 'f_dc_0'), iOp = propIndex(ply, 'opacity'), iS = propIndex(ply, 'scale_0'), iR = propIndex(ply, 'rot_0');
  let kept = 0;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (sigmoid(f[i * F + iOp]) >= 1 / 255) { keep[i] = 1; kept++; }
  const pos = new Float32Array(kept * 3), col = new Float32Array(kept * 3), op = new Float32Array(kept), M = new Float32Array(kept * 9), rows = new Int32Array(kept);
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const b = i * F;
    pos[j * 3] = f[b + iX]; pos[j * 3 + 1] = f[b + iX + 1]; pos[j * 3 + 2] = f[b + iX + 2];
    for (let c = 0; c < 3; c++) col[j * 3 + c] = Math.min(1, Math.max(0, 0.5 + SH_C0 * f[b + iDC + c]));
    op[j] = sigmoid(f[b + iOp]);
    let qw = f[b + iR], qx = f[b + iR + 1], qy = f[b + iR + 2], qz = f[b + iR + 3];
    const ql = Math.hypot(qw, qx, qy, qz) || 1;
    qw /= ql; qx /= ql; qy /= ql; qz /= ql;
    const R = [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
      2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
      2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)];
    const s = [Math.exp(f[b + iS]), Math.exp(f[b + iS + 1]), Math.exp(f[b + iS + 2])];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[j * 9 + r * 3 + c] = R[r * 3 + c] * s[c];
    rows[j] = i;
    j++;
  }
  return { n: kept, rows, pos, col, op, M };
}

export const loadSplats = (file: string): Splats => prepareSplats(readSplatPly(file));

/* ---------------------------------------------------------------- small maths --------------------------------------------------------------- */

export const matFromQuat = ([x, y, z, w]: Quat): Mat3 => [
  1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
  2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
  2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
];

/** Rotation by angle |w| about the axis w (a rotation vector). */
export function rotationVector(w: Vec3): Mat3 {
  const a = Math.hypot(w[0], w[1], w[2]);
  if (a < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return axisAngle(w, a);
}

/** Quaternion [x, y, z, w] of a rotation matrix. */
export function quatFromMatrix(m: Mat3): Quat {
  const t = m[0] + m[4] + m[8];
  let x: number, y: number, z: number, w: number;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; w = 0.25 * s; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s; }
  else if (m[0] > m[4] && m[0] > m[8]) { const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; w = (m[7] - m[5]) / s; x = 0.25 * s; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s; }
  else if (m[4] > m[8]) { const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = 0.25 * s; z = (m[5] + m[7]) / s; }
  else { const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2; w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = 0.25 * s; }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}

/* ---------------------------------------------------------------- camera and projection --------------------------------------------------------------- */

/** Three.js convention (looks down -Z, +Y up). width/height are the full render size; `level` divides everything for a pyramid level. */
export interface SplatCamera {
  R: Mat3;
  Rt: Mat3;
  pos: Vec3;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
  near: number;
  level: number;
}

export function makeCamera(o: { position: Vec3; quaternion: Quat; fovY: number; width: number; height: number; near?: number; level?: number }): SplatCamera {
  const level = o.level ?? 1;
  const R = matFromQuat(o.quaternion);
  const fy = o.height / 2 / Math.tan((o.fovY * Math.PI) / 360);
  return { R, Rt: transpose(R), pos: o.position, fx: fy / level, fy: fy / level, cx: o.width / 2 / level, cy: o.height / 2 / level, width: o.width / level, height: o.height / level, near: o.near ?? 0.02, level };
}

/** Projected Gaussians as packed arrays: centre (U, V), depth D, the inverse 2D covariance (CA, CB, CC), alpha, pixel radius, colour, and the source index. */
export interface Projection {
  count: number;
  U: Float32Array;
  V: Float32Array;
  D: Float32Array;
  CA: Float32Array;
  CB: Float32Array;
  CC: Float32Array;
  AL: Float32Array;
  RAD: Float32Array;
  RGB: Float32Array;
  IDX: Int32Array;
}

/** Project every Gaussian of one part. `roi` is in this camera's pixel grid; Gaussians that cannot touch it are dropped. */
export function project(splats: Splats, pose: SplatPose, cam: SplatCamera, roi: Roi, dil = 0.3): Projection {
  const { n, pos, col, op, M } = splats;
  const Ro = matFromQuat(pose.quaternion), s = pose.scale;
  const A = mul(cam.Rt, Ro);
  const tv = apply(cam.Rt, [pose.position[0] - cam.pos[0], pose.position[1] - cam.pos[1], pose.position[2] - cam.pos[2]]);
  const U = new Float32Array(n), V = new Float32Array(n), D = new Float32Array(n), CA = new Float32Array(n), CB = new Float32Array(n), CC = new Float32Array(n);
  const AL = new Float32Array(n), RAD = new Float32Array(n), RGB = new Float32Array(n * 3), IDX = new Int32Array(n);
  let cnt = 0;
  const { fx, fy, cx, cy } = cam;
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = A;
  for (let i = 0; i < n; i++) {
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    const z = tv[2] + s * (a6 * px + a7 * py + a8 * pz);
    const d = -z;
    if (d <= cam.near) continue;
    const x = tv[0] + s * (a0 * px + a1 * py + a2 * pz), y = tv[1] + s * (a3 * px + a4 * py + a5 * pz);
    const inv = 1 / d;
    const u = cx + fx * x * inv, v = cy - fy * y * inv;
    const m = i * 9;
    // B = s * A * M (columns), then T = J B
    const j00 = fx * inv, j02 = fx * x * inv * inv, j11 = -fy * inv, j12 = -fy * y * inv * inv;
    let t0a = 0, t0b = 0, t0c = 0, t1a = 0, t1b = 0, t1c = 0;
    for (let c = 0; c < 3; c++) {
      const m0 = M[m + c], m1 = M[m + 3 + c], m2 = M[m + 6 + c];
      const b0 = s * (a0 * m0 + a1 * m1 + a2 * m2), b1 = s * (a3 * m0 + a4 * m1 + a5 * m2), b2 = s * (a6 * m0 + a7 * m1 + a8 * m2);
      const T0 = j00 * b0 + j02 * b2, T1 = j11 * b1 + j12 * b2;
      if (c === 0) { t0a = T0; t1a = T1; } else if (c === 1) { t0b = T0; t1b = T1; } else { t0c = T0; t1c = T1; }
    }
    const a = t0a * t0a + t0b * t0b + t0c * t0c + dil, b = t0a * t1a + t0b * t1b + t0c * t1c, c2 = t1a * t1a + t1b * t1b + t1c * t1c + dil;
    const det = a * c2 - b * b;
    if (det <= 1e-12) continue;
    // Spark lowers opacity by the area its blur adds (rgba.a *= sqrt(detOrig / det))
    const alpha = op[i] * Math.sqrt(Math.max(0, ((a - dil) * (c2 - dil) - b * b) / det));
    if (alpha < 0.5 / 255) continue;
    const mid = (a + c2) / 2, lmax = mid + Math.sqrt(Math.max(0.01, mid * mid - det));
    const r = Math.ceil(Math.sqrt(8 * lmax));
    if (u + r < roi.x0 || u - r > roi.x1 || v + r < roi.y0 || v - r > roi.y1) continue;
    U[cnt] = u; V[cnt] = v; D[cnt] = d; CA[cnt] = c2 / det; CB[cnt] = -b / det; CC[cnt] = a / det; AL[cnt] = alpha; RAD[cnt] = r; IDX[cnt] = i;
    RGB[cnt * 3] = col[i * 3]; RGB[cnt * 3 + 1] = col[i * 3 + 1]; RGB[cnt * 3 + 2] = col[i * 3 + 2];
    cnt++;
  }
  return { count: cnt, U, V, D, CA, CB, CC, AL, RAD, RGB, IDX };
}

/* ---------------------------------------------------------------- compositing --------------------------------------------------------------- */

const EXP_N = 4096;
const EXP = new Float32Array(EXP_N + 1);
for (let i = 0; i <= EXP_N; i++) EXP[i] = Math.exp((-4 * i) / EXP_N);

// Sort key: depth bin (20 bits), then part (3 bits), then Gaussian (22 bits), packed in a double (45 bits).
const KEY_I = 2 ** 22, KEY_P = 2 ** 25;
const MAX_PARTS = 8;

/** Front-to-back order of the Gaussians of all parts. */
function depthOrder(parts: Projection[]): Float64Array {
  let total = 0;
  for (const p of parts) total += p.count;
  if (parts.length > MAX_PARTS) throw new Error(`at most ${MAX_PARTS} parts per render`);
  const keys = new Float64Array(total);
  let dmin = Infinity, dmax = -Infinity;
  for (const p of parts) for (let i = 0; i < p.count; i++) { const d = p.D[i]; if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
  const span = Math.max(1e-6, dmax - dmin);
  let k = 0;
  parts.forEach((p, pi) => {
    if (p.count >= KEY_I) throw new Error('too many Gaussians in one part for the sort key');
    for (let i = 0; i < p.count; i++) keys[k++] = Math.min(2 ** 20 - 1, Math.floor(((p.D[i] - dmin) / span) * (2 ** 20 - 1))) * KEY_P + pi * KEY_I + i;
  });
  keys.sort();
  return keys;
}

export interface Composite {
  /** Premultiplied colour, 3 floats per pixel of the roi. */
  C: Float32Array;
  /** Transmittance: 1 where nothing was drawn. */
  T: Float32Array;
  w: number;
  h: number;
  /** With `depth: true`: opacity-weighted depth sums and the weights that go with them. */
  Dacc: Float32Array | null;
  Wacc: Float32Array | null;
}

/** Alpha-composite projected Gaussians (front to back) into the roi window. */
export function composite(parts: Projection[], roi: Roi, opts: { depth?: boolean } = {}): Composite {
  const w = roi.x1 - roi.x0, h = roi.y1 - roi.y0;
  const keys = depthOrder(parts);
  const C = new Float32Array(w * h * 3), T = new Float32Array(w * h).fill(1);
  const Dacc = opts.depth ? new Float32Array(w * h) : null, Wacc = opts.depth ? new Float32Array(w * h) : null;
  for (let q = 0; q < keys.length; q++) {
    const key = keys[q], low = key % KEY_P, pi = Math.floor(low / KEY_I), i = low - pi * KEY_I;
    const p = parts[pi];
    const u = p.U[i] - roi.x0, v = p.V[i] - roi.y0, r = p.RAD[i];
    const ca = p.CA[i], cb = p.CB[i], cc = p.CC[i], al = p.AL[i];
    const x0 = Math.max(0, Math.floor(u - r - 0.5)), x1 = Math.min(w - 1, Math.ceil(u + r - 0.5));
    const y0 = Math.max(0, Math.floor(v - r - 0.5)), y1 = Math.min(h - 1, Math.ceil(v + r - 0.5));
    const cr = p.RGB[i * 3], cg = p.RGB[i * 3 + 1], cbb = p.RGB[i * 3 + 2];
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - v;
      for (let x = x0; x <= x1; x++) {
        const o = y * w + x, t = T[o];
        if (t < 0.003) continue;
        const dx = x + 0.5 - u;
        const e = 0.5 * (ca * dx * dx + 2 * cb * dx * dy + cc * dy * dy);
        if (e > 4) continue;
        let a = al * EXP[(e * (EXP_N / 4)) | 0];
        if (a < 1 / 255) continue;
        if (a > 0.99) a = 0.99;
        const wgt = t * a;
        C[o * 3] += wgt * cr; C[o * 3 + 1] += wgt * cg; C[o * 3 + 2] += wgt * cbb;
        if (Dacc && Wacc) { Dacc[o] += wgt * p.D[i]; Wacc[o] += wgt; }
        T[o] = t * (1 - a);
      }
    }
  }
  return { C, T, w, h, Dacc, Wacc };
}

export function render(objects: { splats: Splats; pose: SplatPose }[], cam: SplatCamera, roi: Roi, opts?: { depth?: boolean }): Composite {
  return composite(objects.map((o) => project(o.splats, o.pose, cam, roi)), roi, opts);
}

export interface Contributions extends Omit<Composite, 'Dacc' | 'Wacc'> {
  len: number;
  /** One entry per (pixel, Gaussian of parts[rec]) that touched it: the pixel (index in the roi), the Gaussian (index in its projection) and T * alpha. */
  PIX: Int32Array;
  ID: Int32Array;
  WG: Float32Array;
}

/**
 * Same as `composite`, and also records every weight T * alpha with which a Gaussian of parts[rec] lands on a pixel, so that
 * C(p) = sum of weight * colour holds exactly for fixed positions and opacities.
 */
export function compositeContrib(parts: Projection[], roi: Roi, rec = 0): Contributions {
  const w = roi.x1 - roi.x0, h = roi.y1 - roi.y0;
  const keys = depthOrder(parts);
  const C = new Float32Array(w * h * 3), T = new Float32Array(w * h).fill(1);
  let cap = 1 << 21, len = 0;
  let PIX = new Int32Array(cap), ID = new Int32Array(cap), WG = new Float32Array(cap);
  for (let q = 0; q < keys.length; q++) {
    const key = keys[q], low = key % KEY_P, pi = Math.floor(low / KEY_I), i = low - pi * KEY_I;
    const p = parts[pi];
    const u = p.U[i] - roi.x0, v = p.V[i] - roi.y0, r = p.RAD[i];
    const ca = p.CA[i], cb = p.CB[i], cc = p.CC[i], al = p.AL[i];
    const x0 = Math.max(0, Math.floor(u - r - 0.5)), x1 = Math.min(w - 1, Math.ceil(u + r - 0.5));
    const y0 = Math.max(0, Math.floor(v - r - 0.5)), y1 = Math.min(h - 1, Math.ceil(v + r - 0.5));
    const cr = p.RGB[i * 3], cg = p.RGB[i * 3 + 1], cbb = p.RGB[i * 3 + 2];
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - v;
      for (let x = x0; x <= x1; x++) {
        const o = y * w + x, t = T[o];
        if (t < 0.003) continue;
        const dx = x + 0.5 - u;
        const e = 0.5 * (ca * dx * dx + 2 * cb * dx * dy + cc * dy * dy);
        if (e > 4) continue;
        let a = al * EXP[(e * (EXP_N / 4)) | 0];
        if (a < 1 / 255) continue;
        if (a > 0.99) a = 0.99;
        const wgt = t * a;
        C[o * 3] += wgt * cr; C[o * 3 + 1] += wgt * cg; C[o * 3 + 2] += wgt * cbb;
        if (pi === rec) {
          if (len === cap) {
            cap *= 2;
            const A = new Int32Array(cap); A.set(PIX); PIX = A;
            const B = new Int32Array(cap); B.set(ID); ID = B;
            const G = new Float32Array(cap); G.set(WG); WG = G;
          }
          PIX[len] = o; ID[len] = i; WG[len] = wgt; len++;
        }
        T[o] = t * (1 - a);
      }
    }
  }
  return { C, T, w, h, len, PIX: PIX.subarray(0, len), ID: ID.subarray(0, len), WG: WG.subarray(0, len) };
}

/**
 * A render made `S` times larger than the photo, averaged back to photo pixels the way the viewer's frame capture does
 * (S x S screen pixels per photo pixel). `roi` is in photo pixels.
 */
export function blockAverage(r: { C: Float32Array; T: Float32Array }, roi: Roi, S: number): { C: Float32Array; T: Float32Array } {
  if (S === 1) return { C: r.C, T: r.T };
  const rw = roi.x1 - roi.x0, rh = roi.y1 - roi.y0, sw = rw * S;
  const C = new Float32Array(rw * rh * 3), T = new Float32Array(rw * rh), inv = 1 / (S * S);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const o = y * rw + x;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
      const q = (y * S + dy) * sw + x * S + dx;
      C[o * 3] += r.C[q * 3] * inv; C[o * 3 + 1] += r.C[q * 3 + 1] * inv; C[o * 3 + 2] += r.C[q * 3 + 2] * inv; T[o] += r.T[q] * inv;
    }
  }
  return { C, T };
}
