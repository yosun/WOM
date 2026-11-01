// A small CPU rasterizer: renders a posed mesh through pinhole intrinsics into a pixel window,
// producing coverage, z-depth and (optionally) base color. Used to fit object poses to SAM masks.
import type { TriMesh } from './glb.ts';
import type { Intrinsics } from './moge.ts';
import type { Mat3, Vec3 } from './math.ts';
import type { PointCloud } from './ply.ts';

export interface Pose {
  /** Model-to-camera rotation (OpenCV camera frame). */
  R: Mat3;
  /** Camera-space translation of the model origin (meters). */
  t: Vec3;
  /** Uniform scale. */
  s: number;
}

export interface RenderWindow {
  /** Window in intrinsics pixel units (half-open). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface RenderOutput {
  width: number;
  height: number;
  /** Inverse depth per pixel (0 where empty). */
  invDepth: Float32Array;
  color: Uint8Array | null;
  covered: number;
  /** Bounding box of covered pixels in window pixel coordinates (half-open), or null. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Project transformed vertices once per pose. Returns screen x, y (window pixels) and 1/z. */
function projectVertices(mesh: TriMesh, pose: Pose, k: Intrinsics, win: RenderWindow, width: number, height: number) {
  const n = mesh.positions.length / 3;
  const sx = new Float32Array(n), sy = new Float32Array(n), iz = new Float32Array(n);
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = pose.R;
  const s = pose.s, [tx, ty, tz] = pose.t;
  const ax = width / (win.x1 - win.x0), ay = height / (win.y1 - win.y0);
  const P = mesh.positions;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3] * s, y = P[i * 3 + 1] * s, z = P[i * 3 + 2] * s;
    const cx = r0 * x + r1 * y + r2 * z + tx;
    const cy = r3 * x + r4 * y + r5 * z + ty;
    const cz = r6 * x + r7 * y + r8 * z + tz;
    if (cz <= 1e-3) { iz[i] = -1; continue; }
    const inv = 1 / cz;
    sx[i] = (k.fx * cx * inv + k.cx - win.x0) * ax;
    sy[i] = (k.fy * cy * inv + k.cy - win.y0) * ay;
    iz[i] = inv;
  }
  return { sx, sy, iz };
}

export function renderMesh(
  mesh: TriMesh,
  pose: Pose,
  k: Intrinsics,
  win: RenderWindow,
  width: number,
  height: number,
  opts: { color?: boolean } = {},
): RenderOutput {
  const { sx, sy, iz } = projectVertices(mesh, pose, k, win, width, height);
  const invDepth = new Float32Array(width * height);
  const wantColor = Boolean(opts.color && mesh.texture && mesh.uvs);
  const color = wantColor ? new Uint8Array(width * height * 3) : null;
  const I = mesh.indices;
  const uv = mesh.uvs;
  const tex = mesh.texture;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const za = iz[a], zb = iz[b], zc = iz[c];
    if (za < 0 || zb < 0 || zc < 0) continue;
    const ax = sx[a], ay = sy[a], bx = sx[b], by = sy[b], cx = sx[c], cy = sy[c];
    let minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
    let minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
    if (maxX < 0 || maxY < 0 || minX >= width || minY >= height) continue;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(width - 1, Math.ceil(maxX));
    const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(height - 1, Math.ceil(maxY));
    const invArea = 1 / area;
    // Tiny triangles (smaller than a pixel) still claim the pixel under their centroid.
    if (x1 - x0 <= 1 && y1 - y0 <= 1 && maxX - minX < 1 && maxY - minY < 1) {
      const px = Math.floor((ax + bx + cx) / 3), py = Math.floor((ay + by + cy) / 3);
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const z = (za + zb + zc) / 3;
      const p = py * width + px;
      if (z > invDepth[p]) {
        invDepth[p] = z;
        if (color && uv && tex) sampleInto(color, p, tex, (uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3, (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3);
      }
      continue;
    }
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * invArea;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * za + w1 * zb + w2 * zc;
        const p = y * width + x;
        if (z <= invDepth[p]) continue;
        invDepth[p] = z;
        if (color && uv && tex) {
          // Perspective-correct UV.
          const qa = w0 * za, qb = w1 * zb, qc = w2 * zc;
          const qs = 1 / (qa + qb + qc);
          const u = (qa * uv[a * 2] + qb * uv[b * 2] + qc * uv[c * 2]) * qs;
          const v = (qa * uv[a * 2 + 1] + qb * uv[b * 2 + 1] + qc * uv[c * 2 + 1]) * qs;
          sampleInto(color, p, tex, u, v);
        }
      }
    }
  }
  let covered = 0;
  let bx0 = width, by0 = height, bx1 = -1, by1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (invDepth[y * width + x] <= 0) continue;
      covered++;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  return { width, height, invDepth, color, covered, box: bx1 < 0 ? null : { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 } };
}

/** Render a point cloud (Gaussian centers drawn as small discs) with the same outputs as renderMesh. */
export function renderPoints(
  cloud: PointCloud,
  pose: Pose,
  k: Intrinsics,
  win: RenderWindow,
  width: number,
  height: number,
  opts: { color?: boolean } = {},
): RenderOutput {
  const invDepth = new Float32Array(width * height);
  const color = opts.color ? new Uint8Array(width * height * 3) : null;
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = pose.R;
  const s = pose.s, [tx, ty, tz] = pose.t;
  const ax = width / (win.x1 - win.x0), ay = height / (win.y1 - win.y0);
  const P = cloud.positions;
  for (let i = 0; i < cloud.count; i++) {
    const x = P[i * 3] * s, y = P[i * 3 + 1] * s, z = P[i * 3 + 2] * s;
    const cz = r6 * x + r7 * y + r8 * z + tz;
    if (cz <= 1e-3) continue;
    const inv = 1 / cz;
    const cx = r0 * x + r1 * y + r2 * z + tx;
    const cy = r3 * x + r4 * y + r5 * z + ty;
    const u = (k.fx * cx * inv + k.cx - win.x0) * ax;
    const v = (k.fy * cy * inv + k.cy - win.y0) * ay;
    const rad = Math.min(3, Math.max(0.6, k.fx * s * cloud.radii[i] * inv * ax));
    const ux0 = Math.max(0, Math.floor(u - rad)), ux1 = Math.min(width - 1, Math.floor(u + rad));
    const vy0 = Math.max(0, Math.floor(v - rad)), vy1 = Math.min(height - 1, Math.floor(v + rad));
    if (ux1 < ux0 || vy1 < vy0) continue;
    const r2sq = rad * rad;
    for (let py = vy0; py <= vy1; py++) {
      const dy = py + 0.5 - v;
      for (let px = ux0; px <= ux1; px++) {
        const dx = px + 0.5 - u;
        if (dx * dx + dy * dy > r2sq && !(ux0 === ux1 && vy0 === vy1)) continue;
        const p = py * width + px;
        if (inv <= invDepth[p]) continue;
        invDepth[p] = inv;
        if (color) {
          color[p * 3] = cloud.colors[i * 3];
          color[p * 3 + 1] = cloud.colors[i * 3 + 1];
          color[p * 3 + 2] = cloud.colors[i * 3 + 2];
        }
      }
    }
  }
  let covered = 0;
  let bx0 = width, by0 = height, bx1 = -1, by1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (invDepth[y * width + x] <= 0) continue;
      covered++;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    }
  }
  return { width, height, invDepth, color, covered, box: bx1 < 0 ? null : { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 } };
}

/** Something the fitter can render: a triangle mesh or a splat point cloud. */
export type Shape = { kind: 'mesh'; mesh: TriMesh } | { kind: 'points'; cloud: PointCloud };

export function renderShape(shape: Shape, pose: Pose, k: Intrinsics, win: RenderWindow, width: number, height: number, opts: { color?: boolean } = {}) {
  return shape.kind === 'mesh' ? renderMesh(shape.mesh, pose, k, win, width, height, opts) : renderPoints(shape.cloud, pose, k, win, width, height, opts);
}

export function shapePositions(shape: Shape) {
  return shape.kind === 'mesh' ? shape.mesh.positions : shape.cloud.positions;
}

export function shapeBounds(shape: Shape) {
  return shape.kind === 'mesh' ? shape.mesh.bounds : shape.cloud.bounds;
}

export function withPositions(shape: Shape, positions: Float32Array): Shape {
  return shape.kind === 'mesh' ? { kind: 'mesh', mesh: { ...shape.mesh, positions } } : { kind: 'points', cloud: { ...shape.cloud, positions } };
}

function sampleInto(out: Uint8Array, p: number, tex: NonNullable<TriMesh['texture']>, u: number, v: number) {
  const fu = u - Math.floor(u), fv = v - Math.floor(v);
  const tx = Math.min(tex.width - 1, Math.floor(fu * tex.width));
  const ty = Math.min(tex.height - 1, Math.floor(fv * tex.height));
  const q = (ty * tex.width + tx) * 3;
  out[p * 3] = tex.rgb[q];
  out[p * 3 + 1] = tex.rgb[q + 1];
  out[p * 3 + 2] = tex.rgb[q + 2];
}
