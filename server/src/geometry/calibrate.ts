// Align a World Labs Marble splat world with the photo's camera.
//
// Marble puts the input camera at the origin of its raw OpenCV-style frame (x right, y down, z forward),
// but with its own field of view, its own unit scale, and (for Marble 1.1) a gravity-leveled orientation.
// We recover the rotation and field of view photometrically: render the splats from the origin and
// compare with the clean plate, starting from MoGe's gravity estimate. Metric scale then comes from
// MoGe depth.
import { apply, axisAngle, mul, rotationBetween, type Mat3, type Vec3 } from './math.ts';
import type { Intrinsics } from './moge.ts';
import { centeredIntrinsics } from './moge.ts';
import type { SplatCloud } from './spz.ts';

export interface MarbleCalibration {
  hfovDeg: number;
  /** Rotation taking Marble raw coordinates into the photo's OpenCV camera frame. */
  R: Mat3;
  pitchDeg: number;
  yawDeg: number;
  rollDeg: number;
  colorError: number;
  coverage: number;
  evaluations: number;
}

interface Params {
  hfov: number;
  pitch: number;
  yaw: number;
  roll: number;
}

const DEG = Math.PI / 180;

function rotationOf(base: Mat3, p: Params): Mat3 {
  // Small corrections applied in the camera frame on top of the base orientation.
  const Rx = axisAngle([1, 0, 0], p.pitch * DEG);
  const Ry = axisAngle([0, 1, 0], p.yaw * DEG);
  const Rz = axisAngle([0, 0, 1], p.roll * DEG);
  return mul(Rz, mul(Rx, mul(Ry, base)));
}

/** Pre-filtered, subsampled splats for fast repeated projection. */
function prepare(cloud: SplatCloud, maxSplats: number) {
  const keep: number[] = [];
  for (let i = 0; i < cloud.count; i++) if (cloud.alphas[i] >= 0.3) keep.push(i);
  const step = Math.max(1, Math.floor(keep.length / maxSplats));
  const n = Math.ceil(keep.length / step);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  let j = 0;
  for (let t = 0; t < keep.length; t += step, j++) {
    const i = keep[t];
    pos[j * 3] = cloud.positions[i * 3];
    pos[j * 3 + 1] = cloud.positions[i * 3 + 1];
    pos[j * 3 + 2] = cloud.positions[i * 3 + 2];
    col[j * 3] = cloud.colors[i * 3];
    col[j * 3 + 1] = cloud.colors[i * 3 + 1];
    col[j * 3 + 2] = cloud.colors[i * 3 + 2];
    size[j] = Math.max(cloud.scales[i * 3], cloud.scales[i * 3 + 1], cloud.scales[i * 3 + 2]) * Math.sqrt(step);
  }
  return { n: j, pos, col, size };
}

function colorError(s: ReturnType<typeof prepare>, R: Mat3, img: { width: number; height: number; rgb: Uint8Array }, hfovDeg: number) {
  const { width: W, height: H, rgb } = img;
  const fx = W / 2 / Math.tan((hfovDeg * DEG) / 2);
  const cx = W / 2, cy = H / 2;
  const zb = new Float32Array(W * H).fill(Infinity);
  const id = new Int32Array(W * H).fill(-1);
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = R;
  for (let i = 0; i < s.n; i++) {
    const x0 = s.pos[i * 3], y0 = s.pos[i * 3 + 1], z0 = s.pos[i * 3 + 2];
    const z = r6 * x0 + r7 * y0 + r8 * z0;
    if (z <= 0.05) continue;
    const x = r0 * x0 + r1 * y0 + r2 * z0, y = r3 * x0 + r4 * y0 + r5 * z0;
    const uc = (fx * x) / z + cx, vc = (fx * y) / z + cy;
    if (uc < -2 || vc < -2 || uc >= W + 2 || vc >= H + 2) continue;
    const rad = Math.max(0, Math.min(2, Math.round((fx * s.size[i]) / z)));
    const ux = Math.floor(uc), vy = Math.floor(vc);
    for (let dy = -rad; dy <= rad; dy++) {
      const v = vy + dy;
      if (v < 0 || v >= H) continue;
      for (let dx = -rad; dx <= rad; dx++) {
        const u = ux + dx;
        if (u < 0 || u >= W) continue;
        const p = v * W + u;
        if (z < zb[p]) { zb[p] = z; id[p] = i; }
      }
    }
  }
  let err = 0, n = 0;
  for (let p = 0; p < W * H; p++) {
    const i = id[p];
    if (i < 0) continue;
    err += Math.abs(s.col[i * 3] - rgb[p * 3] / 255) + Math.abs(s.col[i * 3 + 1] - rgb[p * 3 + 1] / 255) + Math.abs(s.col[i * 3 + 2] - rgb[p * 3 + 2] / 255);
    n++;
  }
  const coverage = n / (W * H);
  // Uncovered pixels count as a mediocre match so the search cannot win by looking at empty space.
  const e = n ? (err / n / 3) * coverage + 0.25 * (1 - coverage) : 1;
  return { err: e, coverage };
}

/**
 * Find Marble's camera: field of view plus a rotation, searched around two starting orientations
 * (Marble's raw frame as-is, and leveled to MoGe's gravity estimate).
 */
export function calibrateMarble(
  cloud: SplatCloud,
  img: { width: number; height: number; rgb: Uint8Array },
  upCv: Vec3 | null,
): MarbleCalibration {
  const s = prepare(cloud, 160_000);
  let evaluations = 0;
  const bases: Mat3[] = [[1, 0, 0, 0, 1, 0, 0, 0, 1]];
  // A gravity-leveled Marble frame has "up" along raw -Y; rotate that onto the photo's up.
  if (upCv) bases.push(rotationBetween([0, -1, 0], upCv));

  const evalAt = (base: Mat3, p: Params) => {
    evaluations++;
    return colorError(s, rotationOf(base, p), img, p.hfov);
  };

  let best: { base: Mat3; p: Params; err: number; coverage: number } | null = null;
  for (const base of bases) {
    for (let hfov = 30; hfov <= 110; hfov += 4) {
      for (const pitch of [-8, 0, 8]) {
        const p = { hfov, pitch, yaw: 0, roll: 0 };
        const r = evalAt(base, p);
        if (!best || r.err < best.err) best = { base, p, err: r.err, coverage: r.coverage };
      }
    }
  }
  if (!best) throw new Error('no splats in view');

  // Coordinate descent over all four parameters.
  const steps: Params = { hfov: 3, pitch: 3, yaw: 3, roll: 2 };
  const keys: (keyof Params)[] = ['hfov', 'pitch', 'yaw', 'roll'];
  for (let round = 0; round < 40; round++) {
    let improved = false;
    for (const key of keys) {
      for (const dir of [1, -1]) {
        const cand: Params = { ...best.p, [key]: best.p[key] + dir * steps[key] };
        if (cand.hfov < 15 || cand.hfov > 130) continue;
        const r = evalAt(best.base, cand);
        if (r.err < best.err - 1e-6) {
          best = { ...best, p: cand, err: r.err, coverage: r.coverage };
          improved = true;
          break;
        }
      }
    }
    if (!improved) {
      for (const key of keys) steps[key] *= 0.5;
      if (steps.hfov < 0.2) break;
    }
  }
  const R = rotationOf(best.base, best.p);
  // Report the total rotation as camera-frame Euler-ish angles for diagnostics.
  const fwd = apply(R, [0, 0, 1]);
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, -fwd[1]))) / DEG;
  const yawDeg = Math.atan2(fwd[0], fwd[2]) / DEG;
  const right = apply(R, [1, 0, 0]);
  const rollDeg = Math.asin(Math.max(-1, Math.min(1, right[1]))) / DEG;
  return { hfovDeg: best.p.hfov, R, pitchDeg, yawDeg, rollDeg, colorError: best.err, coverage: best.coverage, evaluations };
}

/** Rotate splat centers into the photo camera frame (OpenCV), keeping Marble units. */
export function rotateCloud(cloud: SplatCloud, R: Mat3): SplatCloud {
  const positions = new Float32Array(cloud.positions.length);
  const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = R;
  for (let i = 0; i < cloud.count; i++) {
    const x = cloud.positions[i * 3], y = cloud.positions[i * 3 + 1], z = cloud.positions[i * 3 + 2];
    positions[i * 3] = r0 * x + r1 * y + r2 * z;
    positions[i * 3 + 1] = r3 * x + r4 * y + r5 * z;
    positions[i * 3 + 2] = r6 * x + r7 * y + r8 * z;
  }
  return { ...cloud, positions };
}

/**
 * Metric scale for Marble's raw units: the median ratio of MoGe depth to the front-most splat depth per
 * cell (cloud already rotated into the camera frame). `exclude` marks pixels to skip.
 */
export function marbleScale(opts: {
  splats: SplatCloud;
  k: Intrinsics;
  depth: Float32Array;
  valid: Uint8Array;
  exclude?: Uint8Array;
}): { scale: number; samples: number; spread: number } {
  const { splats, k } = opts;
  const cell = Math.max(2, Math.round(k.width / 160));
  const gw = Math.ceil(k.width / cell), gh = Math.ceil(k.height / cell);
  const zb = new Float32Array(gw * gh).fill(Infinity);
  const P = splats.positions;
  for (let i = 0; i < splats.count; i++) {
    const z = P[i * 3 + 2];
    if (z <= 0.05 || splats.alphas[i] < 0.5) continue;
    const u = (k.fx * P[i * 3]) / z + k.cx, v = (k.fy * P[i * 3 + 1]) / z + k.cy;
    if (u < 0 || v < 0 || u >= k.width || v >= k.height) continue;
    const g = Math.floor(v / cell) * gw + Math.floor(u / cell);
    if (z < zb[g]) zb[g] = z;
  }
  const ratios: number[] = [];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const zs = zb[gy * gw + gx];
      if (!Number.isFinite(zs)) continue;
      const px = Math.min(k.width - 1, gx * cell + (cell >> 1)), py = Math.min(k.height - 1, gy * cell + (cell >> 1));
      const p = py * k.width + px;
      if (!opts.valid[p] || (opts.exclude && opts.exclude[p])) continue;
      const zm = opts.depth[p];
      if (!(zm > 0)) continue;
      ratios.push(zm / zs);
    }
  }
  if (ratios.length < 20) return { scale: 1, samples: ratios.length, spread: Infinity };
  ratios.sort((a, b) => a - b);
  const q = (f: number) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * f))];
  return { scale: q(0.5), samples: ratios.length, spread: q(0.75) / q(0.25) };
}

export function marbleIntrinsics(width: number, height: number, hfovDeg: number) {
  return centeredIntrinsics(width, height, hfovDeg);
}
