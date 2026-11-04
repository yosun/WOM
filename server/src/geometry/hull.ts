// Convex hulls used as walking colliders for objects. A capsule against an object's full Tripo mesh
// (~140k triangles in about a metre) tests tens of thousands of triangles per check; against its hull
// (a few hundred) it tests a few hundred, and slides smoothly instead of snagging on fur and spokes.
import { Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';

export interface HullMesh {
  /** xyz per vertex, in the object's own coordinates. */
  positions: number[];
  indices: number[];
}

/**
 * Convex hull of a point set. `trim` drops that share of points at each end of every axis first, so a
 * few stray splats far from the object do not inflate the hull. At most `maxPoints` points are used.
 */
export function convexHull(positions: Float32Array, opts: { trim?: number; maxPoints?: number } = {}): HullMesh | null {
  const n = Math.floor(positions.length / 3);
  if (n < 8) return null;
  const trim = opts.trim ?? 0.005;
  const lo = [-Infinity, -Infinity, -Infinity], hi = [Infinity, Infinity, Infinity];
  if (trim > 0) {
    const sampleStep = Math.max(1, Math.floor(n / 20000));
    for (let k = 0; k < 3; k++) {
      const a: number[] = [];
      for (let i = 0; i < n; i += sampleStep) a.push(positions[i * 3 + k]);
      a.sort((x, y) => x - y);
      lo[k] = a[Math.floor(a.length * trim)];
      hi[k] = a[Math.min(a.length - 1, Math.ceil(a.length * (1 - trim)))];
    }
  }
  const step = Math.max(1, Math.floor(n / (opts.maxPoints ?? 6000)));
  const pts: Vector3[] = [];
  for (let i = 0; i < n; i += step) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2]) continue;
    pts.push(new Vector3(x, y, z));
  }
  if (pts.length < 8) return null;
  const hull = new ConvexHull().setFromPoints(pts);
  const index = new Map<object, number>();
  const out: HullMesh = { positions: [], indices: [] };
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  for (const face of hull.faces) {
    let edge = face.edge;
    do {
      const vertex = edge.head();
      let i = index.get(vertex);
      if (i === undefined) {
        i = index.size;
        index.set(vertex, i);
        out.positions.push(round(vertex.point.x), round(vertex.point.y), round(vertex.point.z));
      }
      out.indices.push(i);
      edge = edge.next;
    } while (edge !== face.edge);
  }
  return out.indices.length >= 12 ? out : null;
}
