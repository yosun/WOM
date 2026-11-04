// The ground plane (gravity "up" and camera height) from MoGe depth, fitted as a plane in a given camera.
//
// Averaging MoGe's per-pixel normals over the lawn of the backyard sample said the camera looked 14° down;
// a plane through the same ground points says 1.6°, and Tripo meshes (which are upright in their own
// frame) only line up with the photo at the plane's answer. So: pick floor-like pixels with the normals,
// then let a robust plane fit through their 3D points decide the orientation.
import { cross, dot, normalize, type Vec3 } from './math.ts';
import type { Intrinsics, MogeMaps } from './moge.ts';

export interface GroundPlane {
  /** Gravity up, unit vector, OpenCV camera frame (x right, y down, z forward). */
  up: Vec3;
  /** up · p for points on the ground (negative: the ground is below the camera). */
  height: number;
  inliers: number;
  candidates: number;
  /** RMS distance of inliers to the plane, metres. */
  rms: number;
}

/** 3D point of a MoGe pixel re-projected through `k` (z-depth from MoGe, rays from `k`). */
export function pointThrough(m: MogeMaps, k: Intrinsics | null, i: number): Vec3 {
  if (!k) return [m.points[i * 3], m.points[i * 3 + 1], m.points[i * 3 + 2]];
  const x = i % m.width, y = (i - x) / m.width, z = m.depth[i];
  return [((x + 0.5 - k.cx) / k.fx) * z, ((y + 0.5 - k.cy) / k.fy) * z, z];
}

/**
 * Fit the ground plane. `k` = null uses MoGe's own geometry; otherwise points are re-projected through
 * `k` (the camera the scene is composed in). `exclude` marks pixels to ignore (objects).
 */
export function fitGroundPlane(m: MogeMaps, k: Intrinsics | null, exclude: Uint8Array | null): GroundPlane | null {
  const W = m.width, H = m.height;
  const pts: Vec3[] = [];
  for (let y = Math.floor(H * 0.35); y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = y * W + x;
      if (!m.valid[i] || (exclude && exclude[i])) continue;
      // Floor candidates: normals within ~40° of the camera's own up (three.js +y). The plane fit decides the tilt.
      if (m.normals && m.normals[i * 3 + 1] < 0.75) continue;
      pts.push(pointThrough(m, k, i));
    }
  }
  if (pts.length < 200) return null;
  const zs = pts.map((p) => p[2]).sort((a, b) => a - b);
  const tol = Math.max(0.01, 0.02 * zs[zs.length >> 1]);
  // RANSAC with a deterministic generator so results are repeatable.
  let seed = 1234567;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let best: { n: Vec3; d: number; count: number } | null = null;
  const camUp: Vec3 = [0, -1, 0];
  for (let it = 0; it < 400; it++) {
    const a = pts[Math.floor(rand() * pts.length)], b = pts[Math.floor(rand() * pts.length)], c = pts[Math.floor(rand() * pts.length)];
    let n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    if (Math.hypot(...n) < 1e-9) continue;
    n = normalize(n);
    if (dot(n, camUp) < 0) n = [-n[0], -n[1], -n[2]];
    if (dot(n, camUp) < Math.cos((40 * Math.PI) / 180)) continue; // walls and slopes steeper than 40°
    const d = dot(n, a);
    let count = 0;
    for (let i = 0; i < pts.length; i += 3) if (Math.abs(dot(n, pts[i]) - d) < tol) count++;
    if (!best || count > best.count) best = { n, d, count };
  }
  if (!best) return null;
  // Least-squares refit on the inliers (smallest eigenvector of their covariance).
  const inl = pts.filter((p) => Math.abs(dot(best!.n, p) - best!.d) < tol);
  const c: Vec3 = [0, 0, 0];
  for (const p of inl) for (let j = 0; j < 3; j++) c[j] += p[j] / inl.length;
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of inl) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += (p[i] - c[i]) * (p[j] - c[j]);
  const tr = C[0] + C[4] + C[8];
  let v: Vec3 = best.n;
  for (let it = 0; it < 100; it++) {
    v = normalize([tr * v[0] - (C[0] * v[0] + C[1] * v[1] + C[2] * v[2]), tr * v[1] - (C[3] * v[0] + C[4] * v[1] + C[5] * v[2]), tr * v[2] - (C[6] * v[0] + C[7] * v[1] + C[8] * v[2])]);
  }
  if (dot(v, camUp) < 0) v = [-v[0], -v[1], -v[2]];
  const height = dot(v, c);
  let ss = 0;
  for (const p of inl) ss += (dot(v, p) - height) ** 2;
  return { up: v, height, inliers: inl.length, candidates: pts.length, rms: Math.sqrt(ss / inl.length) };
}
