// Walking through a world: the camera rides on a capsule that keeps to the ground, slides along walls
// and objects, and steps up small bumps. Collisions use three-mesh-bvh against the world's collider mesh
// (Marble's, or the depth relief) and one convex hull per object; no physics engine is needed for this.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

export interface ColliderSource {
  bvh: MeshBVH;
  /** The object that places the collider (its matrixWorld, uniform scale); null = scene coordinates. */
  object: THREE.Object3D | null;
  /** False while the layer or object is hidden. */
  active: () => boolean;
}

/** Every mesh under `root` as one triangle geometry, in scene coordinates after `extra`. */
export function mergedGeometry(root: THREE.Object3D, extra?: THREE.Matrix4): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((n) => { if ((n as THREE.Mesh).isMesh) meshes.push(n as THREE.Mesh); });
  let vertexCount = 0, indexCount = 0;
  for (const m of meshes) {
    vertexCount += m.geometry.attributes.position.count;
    indexCount += m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count;
  }
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const v = new THREE.Vector3(), mat = new THREE.Matrix4();
  let vo = 0, io = 0;
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    mat.copy(m.matrixWorld);
    if (extra) mat.premultiply(extra);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mat);
      positions[(vo + i) * 3] = v.x;
      positions[(vo + i) * 3 + 1] = v.y;
      positions[(vo + i) * 3 + 2] = v.z;
    }
    const index = m.geometry.index;
    if (index) for (let i = 0; i < index.count; i++) indices[io++] = vo + index.getX(i);
    else for (let i = 0; i < pos.count; i++) indices[io++] = vo + i;
    vo += pos.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  return g;
}

export function geometryFromArrays(positions: number[], indices: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  return g;
}

const GRAVITY = 9.8;

export class Walker {
  readonly colliders: ColliderSource[] = [];
  readonly up = new THREE.Vector3(0, 1, 0);
  /** Eye above the ground: the photo camera's own height, measured when walking starts. */
  eyeHeight = 1.6;
  radius = 0.25;
  /** Bumps lower than this are stepped onto. */
  stepHeight = 0.2;
  private headroom = 0.1;
  private velocityUp = 0;
  private grounded = false;
  private lastGround = 0;
  private readonly startEye = new THREE.Vector3();

  // scratch
  private readonly seg = new THREE.Line3();
  private readonly box = new THREE.Box3();
  private readonly triPoint = new THREE.Vector3();
  private readonly capPoint = new THREE.Vector3();
  private readonly push = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();
  private readonly lin = new THREE.Matrix3();
  private readonly scaleV = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly normal = new THREE.Vector3();
  private readonly down = new THREE.Vector3();

  setUp(up: THREE.Vector3) {
    this.up.copy(up).normalize();
  }

  get hasColliders() {
    return this.colliders.some((c) => c.active());
  }

  /** Distance from `point` down to the first surface below it (within `max`), or null. */
  groundBelow(point: THREE.Vector3, max = 30): number | null {
    return this.hitDistance(point, this.down.copy(this.up).negate(), max);
  }

  /** Distance from `point` along the unit vector `direction` to the first collider surface (within `max`), or null. */
  hitDistance(point: THREE.Vector3, direction: THREE.Vector3, max = 30): number | null {
    let best: number | null = null;
    for (const c of this.colliders) {
      if (!c.active()) continue;
      this.ray.origin.copy(point);
      this.ray.direction.copy(direction);
      let scale = 1;
      if (c.object) {
        this.inv.copy(c.object.matrixWorld).invert();
        this.ray.applyMatrix4(this.inv);
        scale = c.object.getWorldScale(this.scaleV).x;
        this.ray.direction.normalize();
      }
      const hit = c.bvh.raycastFirst(this.ray, THREE.DoubleSide);
      if (!hit) continue;
      const d = hit.distance * scale;
      if (d <= max && (best === null || d < best)) best = d;
    }
    return best;
  }

  /**
   * Start walking at `eye` (the photo's viewpoint). The eye height is measured on the collider below;
   * when nothing is directly below (a depth relief only covers what the photo shows), `knownHeight` (the
   * photo camera's height above the fitted ground plane) is used and the walker holds that height until
   * the ground comes underfoot. Returns false when neither is available.
   */
  start(eye: THREE.Vector3, knownHeight?: number): boolean {
    const measured = this.groundBelow(eye, 12);
    const d = measured !== null && measured >= 0.15 ? measured : knownHeight && knownHeight >= 0.15 && knownHeight < 12 ? knownHeight : null;
    if (d === null) return false;
    this.eyeHeight = d;
    this.radius = THREE.MathUtils.clamp(d * 0.2, 0.12, 0.3);
    this.stepHeight = THREE.MathUtils.clamp(d * 0.25, 0.08, 0.35);
    this.startEye.copy(eye);
    this.velocityUp = 0;
    this.grounded = true;
    this.lastGround = this.heightOf(eye) - d;
    return true;
  }

  /** Walk again after flying: fall back to the ground. */
  resume() {
    this.velocityUp = 0;
    this.grounded = false;
  }

  private heightOf(p: THREE.Vector3) {
    return p.dot(this.up);
  }

  /** Move `eye` by the horizontal `move`, with gravity; it is pushed out of everything it touches. */
  step(eye: THREE.Vector3, move: THREE.Vector3, dt: number) {
    this.velocityUp -= GRAVITY * dt;
    const before = eye.clone();
    const plain = eye.clone();
    let groundedPlain = this.travel(plain, move, this.velocityUp * dt);
    let result = plain;
    // Step up: try the same move from a little higher, then settle back down.
    const horizontal = move.length();
    if (this.grounded && horizontal > 1e-4) {
      const lifted = eye.clone().addScaledVector(this.up, this.stepHeight);
      this.collideAll(lifted);
      this.travel(lifted, move, 0);
      const groundedLifted = this.travel(lifted, new THREE.Vector3(), -this.stepHeight);
      const progress = (p: THREE.Vector3) => {
        const d = p.clone().sub(before);
        d.addScaledVector(this.up, -d.dot(this.up));
        return d.dot(move) / horizontal;
      };
      if (groundedLifted && progress(lifted) > progress(plain) + 0.002) {
        result = lifted;
        groundedPlain = true;
      }
    }
    eye.copy(result);
    this.grounded = groundedPlain;
    // Keep contact when walking down slopes instead of flying off small drops.
    if (!this.grounded && this.velocityUp <= 0) {
      const d = this.groundBelow(eye, this.eyeHeight + this.stepHeight);
      if (d !== null && d > this.eyeHeight - 0.02) {
        eye.addScaledVector(this.up, this.eyeHeight - d);
        this.grounded = true;
      }
    }
    if (this.grounded) {
      this.velocityUp = 0;
      this.lastGround = this.heightOf(eye) - this.eyeHeight;
    }
    // Nothing below (past the edge of the collider): hover at the last ground height instead of falling.
    if (!this.grounded && this.groundBelow(eye, 60) === null) {
      eye.addScaledVector(this.up, this.lastGround + this.eyeHeight - this.heightOf(eye));
      this.velocityUp = 0;
      this.grounded = true;
    }
    if (this.heightOf(eye) < this.heightOf(this.startEye) - 40) {
      eye.copy(this.startEye);
      this.velocityUp = 0;
    }
  }

  /** Move in small steps (no tunnelling through thin walls) and collide after each; true when grounded. */
  private travel(eye: THREE.Vector3, move: THREE.Vector3, rise: number): boolean {
    const total = move.clone().addScaledVector(this.up, rise);
    const steps = Math.min(10, Math.max(1, Math.ceil(total.length() / (this.radius * 0.5))));
    total.multiplyScalar(1 / steps);
    let grounded = false;
    for (let s = 0; s < steps; s++) {
      eye.add(total);
      grounded = this.collideAll(eye) || grounded;
    }
    return grounded;
  }

  /** Push the capsule at `eye` out of every collider; true when a surface below holds it up. */
  private collideAll(eye: THREE.Vector3): boolean {
    let grounded = false;
    for (const c of this.colliders) {
      if (!c.active()) continue;
      const seg = this.seg;
      seg.start.copy(eye).addScaledVector(this.up, -(this.eyeHeight - this.radius));
      seg.end.copy(eye).addScaledVector(this.up, Math.max(this.headroom - this.radius, -(this.eyeHeight - this.radius) + 0.01));
      let r = this.radius;
      if (c.object) {
        this.inv.copy(c.object.matrixWorld).invert();
        seg.start.applyMatrix4(this.inv);
        seg.end.applyMatrix4(this.inv);
        r = this.radius / c.object.getWorldScale(this.scaleV).x;
      }
      this.origin.copy(seg.start);
      this.box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(r);
      c.bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(this.box),
        intersectsTriangle: (tri) => {
          const d = tri.closestPointToSegment(seg, this.triPoint, this.capPoint);
          if (d >= r) return false;
          if (d > 1e-6) this.push.subVectors(this.capPoint, this.triPoint).normalize();
          else {
            // The axis passes through the triangle: push along its normal, towards the capsule's side.
            tri.getNormal(this.normal);
            this.push.copy(this.normal);
          }
          seg.start.addScaledVector(this.push, r - d);
          seg.end.addScaledVector(this.push, r - d);
          return false;
        },
      });
      const delta = seg.start.clone().sub(this.origin);
      if (delta.lengthSq() < 1e-12) continue;
      if (c.object) delta.applyMatrix3(this.lin.setFromMatrix4(c.object.matrixWorld));
      eye.add(delta);
      if (delta.dot(this.up) > 0.4 * delta.length()) grounded = true;
    }
    return grounded;
  }
}
