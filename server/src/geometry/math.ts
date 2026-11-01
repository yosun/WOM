// Small 3D math helpers. Matrices are 3x3, row-major, stored in plain arrays.
export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm(a: Vec3) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

/** Rotation about a unit axis by `angle` radians (Rodrigues). */
export function axisAngle(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/** Minimal rotation taking unit vector a onto unit vector b. */
export function rotationBetween(a: Vec3, b: Vec3): Mat3 {
  const an = normalize(a), bn = normalize(b);
  const c = dot(an, bn);
  if (c > 1 - 1e-9) return [...IDENTITY] as Mat3;
  if (c < -1 + 1e-9) {
    const ortho = Math.abs(an[0]) < 0.9 ? cross(an, [1, 0, 0]) : cross(an, [0, 1, 0]);
    return axisAngle(ortho, Math.PI);
  }
  return axisAngle(cross(an, bn), Math.acos(c));
}

/** Rotation matrix from columns (images of the x, y and z basis vectors). */
export function fromColumns(cx: Vec3, cy: Vec3, cz: Vec3): Mat3 {
  return [cx[0], cy[0], cz[0], cx[1], cy[1], cz[1], cx[2], cy[2], cz[2]];
}

export function quatFromMat3(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let x, y, z, w;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}

/** OpenCV camera frame (x right, y down, z forward) to three.js camera frame (x right, y up, z backward). */
export const CV_TO_THREE: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

export function cvToThree(v: Vec3): Vec3 {
  return [v[0], -v[1], -v[2]];
}
