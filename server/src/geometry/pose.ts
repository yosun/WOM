// Object placement in the terms people (and language models) use: a base pivot standing on the ground,
// an up axis along gravity, a yaw about that axis, and a real-world height. Converts to and from the
// raster/fitter pose (p_cam = s R p_raw + t, OpenCV camera frame: x right, y down, z forward).
//
// Canonical asset frame: +Y up, origin at the base pivot (centre of the bottom of the bounding box).
// At yaw 0 the asset's +Z side faces the camera and its +X side points to the camera's right.
// Positive yaw turns the asset counter-clockwise seen from above, so at yaw 90 its +Z side points
// to the right of the image.
import { apply, axisAngle, cross, dot, fromColumns, mul, normalize, transpose, type Mat3, type Vec3 } from './math.ts';
import type { MeshModel } from '../types.ts';
import type { Pose } from './raster.ts';

/**
 * IDOL: −Y is up, as with TripoSplat (checked on the backyard objects). Which way an object faces varies
 * (the dog's face is along +X, the bench's front along −Z), so the fitter searches the full circle of yaw.
 */
const CANON_IDOL: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

/** TripoSplat: −Y is up in the raw file. Rotating 180° about X makes +Y up. */
export const CANON_SPLAT: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
/** Tripo meshes: +Y up and +X front. Turning −90° about Y puts the front on +Z. */
export const CANON_TRIPO_MESH: Mat3 = axisAngle([0, 1, 0], -Math.PI / 2);

/** Raw → canonical (+Y up) rotation for each object generator's output. */
export function canonFor(model: MeshModel): Mat3 {
  if (model === 'idol') return CANON_IDOL;
  return model === 'triposplat' ? CANON_SPLAT : CANON_TRIPO_MESH;
}

/** Raw → OpenCV view-aligned frame (y down, front facing the camera), used by the classic fitter. */
export function viewBaseFor(model: MeshModel): Mat3 {
  return mul([1, 0, 0, 0, -1, 0, 0, 0, -1], canonFor(model));
}

export interface AssetFrame {
  /** Raw asset coordinates → canonical frame. */
  canon: Mat3;
  /** Base pivot in raw coordinates. */
  pivotRaw: Vec3;
  /** Canonical bounding-box size (x width, y height, z depth) in raw units. */
  size: Vec3;
}

/** Canonical frame of an asset from its raw positions (robust to a few stray splats). */
export function assetFrame(positions: Float32Array, canon: Mat3): AssetFrame {
  const n = positions.length / 3;
  const step = Math.max(1, Math.floor(n / 60000));
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (let i = 0; i < n; i += step) {
    const p = apply(canon, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    xs.push(p[0]); ys.push(p[1]); zs.push(p[2]);
  }
  const q = (a: number[], f: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))];
  };
  const lo: Vec3 = [q(xs, 0.002), q(ys, 0.002), q(zs, 0.002)];
  const hi: Vec3 = [q(xs, 0.998), q(ys, 0.998), q(zs, 0.998)];
  const pivotCanon: Vec3 = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  return { canon, pivotRaw: apply(transpose(canon), pivotCanon), size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

export interface Placement {
  /** Base pivot in camera coordinates (OpenCV), metres. */
  base: Vec3;
  /** Rotation about gravity, degrees. 0 = canonical +Z faces the camera. */
  yawDeg: number;
  /** Lean forward/back about the asset's own X axis, degrees (0 = upright). */
  pitchDeg: number;
  /** Lean sideways about the asset's own Z axis, degrees (0 = upright). */
  rollDeg: number;
  /** Real height of the asset's canonical bounding box, metres. */
  heightM: number;
}

const DEG = Math.PI / 180;

/**
 * Upright basis at `base`: columns are the canonical X, Y (= gravity up) and Z (horizontal, toward
 * the camera) axes expressed in camera coordinates.
 */
export function uprightBasis(base: Vec3, up: Vec3): Mat3 {
  const g = normalize(up);
  let h: Vec3 = [base[0] - dot(base, g) * g[0], base[1] - dot(base, g) * g[1], base[2] - dot(base, g) * g[2]];
  if (Math.hypot(...h) < 1e-6) h = [0, 0, 1];
  h = normalize(h);
  const z: Vec3 = [-h[0], -h[1], -h[2]];
  const x = normalize(cross(g, z));
  return fromColumns(x, g, z);
}

export function placementRotation(p: Pick<Placement, 'base' | 'yawDeg' | 'pitchDeg' | 'rollDeg'>, up: Vec3): Mat3 {
  const tilt = mul(axisAngle([1, 0, 0], p.pitchDeg * DEG), axisAngle([0, 0, 1], p.rollDeg * DEG));
  return mul(uprightBasis(p.base, up), mul(axisAngle([0, 1, 0], p.yawDeg * DEG), tilt));
}

/**
 * Put the base pivot on the ground plane (`up · p = groundH`) by scaling the whole placement about the
 * camera centre. The silhouette seen from the camera does not change; the object only gets closer and
 * smaller (or farther and larger). Returns the factor used.
 */
export function groundPose(pose: Pose, up: Vec3, frame: AssetFrame, groundH: number): { pose: Pose; factor: number } {
  const c = apply(pose.R, frame.pivotRaw);
  const pivot: Vec3 = [pose.t[0] + pose.s * c[0], pose.t[1] + pose.s * c[1], pose.t[2] + pose.s * c[2]];
  const h = dot(up, pivot);
  if (!(groundH < 0) || !(h < 0)) return { pose, factor: 1 };
  const factor = groundH / h;
  return { pose: { R: pose.R, s: pose.s * factor, t: [pose.t[0] * factor, pose.t[1] * factor, pose.t[2] * factor] }, factor };
}

export function poseFromPlacement(p: Placement, up: Vec3, frame: AssetFrame): Pose {
  const R = mul(placementRotation(p, up), frame.canon);
  const s = p.heightM / Math.max(1e-9, frame.size[1]);
  const c = apply(R, frame.pivotRaw);
  return { R, s, t: [p.base[0] - s * c[0], p.base[1] - s * c[1], p.base[2] - s * c[2]] };
}

export function placementFromPose(pose: Pose, up: Vec3, frame: AssetFrame): Placement & { tiltDeg: number } {
  const c = apply(pose.R, frame.pivotRaw);
  const base: Vec3 = [pose.t[0] + pose.s * c[0], pose.t[1] + pose.s * c[1], pose.t[2] + pose.s * c[2]];
  const Rplace = mul(pose.R, transpose(frame.canon));
  const Q = mul(transpose(uprightBasis(base, up)), Rplace); // = Ry(yaw) · Rx(pitch) · Rz(roll)
  const front: Vec3 = [Q[2], Q[5], Q[8]];
  const yaw = Math.atan2(front[0], front[2]);
  const T = mul(axisAngle([0, 1, 0], -yaw), Q);
  const pitch = Math.atan2(-T[5], T[8]);
  const roll = Math.atan2(-T[1], T[0]);
  const upAxis: Vec3 = [Rplace[1], Rplace[4], Rplace[7]];
  const tiltDeg = Math.acos(Math.max(-1, Math.min(1, dot(normalize(upAxis), normalize(up))))) / DEG;
  return {
    base,
    yawDeg: ((yaw / DEG) % 360 + 360) % 360,
    pitchDeg: pitch / DEG,
    rollDeg: roll / DEG,
    heightM: pose.s * frame.size[1],
    tiltDeg,
  };
}

/** Signed smallest difference between two angles in degrees, in (−180, 180]. */
export function angleDiff(a: number, b: number) {
  let d = ((a - b) % 360 + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}
