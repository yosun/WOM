// One object × one asset in one world: the placement methods (classic fitter, grounded fitter, and the
// inputs and tools the language models use). Shared by the benchmark and by the pipeline's placement
// step, so a placement shown in the viewer is computed exactly as the benchmark scores it.
import { fitObject, type FitResult } from '../geometry/fit.ts';
import { dot, normalize, type Vec3 } from '../geometry/math.ts';
import { hfovOf } from '../geometry/moge.ts';
import { groundPose, placementFromPose, poseFromPlacement, type Placement } from '../geometry/pose.ts';
import type { Pose } from '../geometry/raster.ts';
import { gridToK, groundHeight, groundPointAt, mogePointAt, projectToGrid, type BenchAsset, type BenchObject, type BenchWorld } from './context.ts';
import type { PlacementArgs, PlacementTask, Scored } from './llm.ts';
import { evaluatePlacement } from './metrics.ts';
import { photoWithOutline, renderOverlay, renderTurntable } from './render.ts';

export const YAWS = [0, 45, 90, 135, 180, 225, 270, 315];
const DEG = 180 / Math.PI;

export function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = Date.now();
  const value = fn();
  return { value, ms: Date.now() - t0 };
}

export class CaseRunner {
  readonly label: string;
  readonly ground: number;
  readonly world: BenchWorld;
  readonly obj: BenchObject;
  readonly asset: BenchAsset;
  constructor(world: BenchWorld, obj: BenchObject, asset: BenchAsset) {
    this.world = world;
    this.obj = obj;
    this.asset = asset;
    this.label = `${world.id}/${obj.id}/${asset.model}`;
    this.ground = groundHeight(world, obj.box);
  }

  private fitInputs() {
    const { world, obj, asset } = this;
    return {
      shape: asset.shape,
      k: world.k,
      mask: obj.mask,
      srcScaleX: world.srcScaleX,
      srcScaleY: world.srcScaleY,
      image: world.source,
      depth: world.moge.depth,
      valid: world.moge.valid,
      alignImage: asset.alignImage,
    };
  }

  pose(p: Placement): Pose {
    return poseFromPlacement(p, this.world.up, this.asset.frame);
  }

  placementOf(pose: Pose): Placement & { tiltDeg: number } {
    return placementFromPose(pose, this.world.up, this.asset.frame);
  }

  /** The compose fitter: view-aligned, ±20° pitch, distance from depth. */
  fitClassic(): { fit: FitResult | null; ms: number } {
    const { value, ms } = timed(() => fitObject({ ...this.fitInputs(), base: this.asset.fitBase }));
    return { fit: value, ms };
  }

  /**
   * The fitter kept upright along gravity, then grounded: scaled about the camera so the base pivot sits on
   * the ground plane (same silhouette). This is the geometric answer in the same terms the models use.
   */
  fitGrounded(yawCenter?: number, yawWindow?: number): { pose: Pose | null; factor: number; ms: number } {
    const { value, ms } = timed(() =>
      fitObject({
        ...this.fitInputs(),
        base: this.asset.frame.canon,
        upright: this.world.up,
        yawRange: yawCenter === undefined ? undefined : { center: yawCenter, window: yawWindow ?? 30 },
      }),
    );
    if (!value) return { pose: null, factor: 1, ms };
    const g = groundPose(value.pose, this.world.up, this.asset.frame, this.ground);
    return { pose: g.pose, factor: g.factor, ms };
  }

  place = (a: PlacementArgs): Placement | null => {
    if (![a.base_x, a.base_y, a.height_m, a.yaw_deg].every(Number.isFinite) || !(a.height_m > 0)) return null;
    const hit = groundPointAt(this.world, a.base_x, a.base_y, this.ground);
    if (!hit) return null;
    return { base: hit.point, yawDeg: a.yaw_deg, pitchDeg: a.pitch_deg ?? 0, rollDeg: a.roll_deg ?? 0, heightM: a.height_m };
  };

  score = async (p: Placement, title?: string): Promise<Scored> => {
    const pose = this.pose(p);
    const metrics = evaluatePlacement(this.world, this.obj, this.asset, pose);
    const [x, y] = projectToGrid(this.world, p.base);
    const overlay = await renderOverlay(this.world, this.obj, this.asset, pose, {
      title,
      subtitle: `IoU ${metrics.iou.toFixed(2)} · yaw ${metrics.yawDeg.toFixed(0)}° · ${metrics.heightM.toFixed(2)} m · gap ${(metrics.contactGapM * 100).toFixed(0)} cm`,
    });
    return { placement: p, metrics, overlay, grid: { x, y } };
  };

  autoFit = async (yawCenter?: number, yawWindow?: number): Promise<Scored> => {
    const { pose } = this.fitGrounded(yawCenter, yawWindow);
    if (!pose) throw new Error('the fitter could not place this object');
    return this.score(this.placementOf(pose), 'auto_fit');
  };

  measure = (pts: { x: number; y: number }[]) => {
    const { moge, up } = this.world;
    const upThree: Vec3 = [up[0], -up[1], -up[2]];
    return pts.map(({ x, y }) => {
      const p = mogePointAt(this.world, x, y);
      const [u, v] = gridToK(this.world, x, y);
      const i = Math.min(moge.height - 1, Math.max(0, Math.floor(v))) * moge.width + Math.min(moge.width - 1, Math.max(0, Math.floor(u)));
      const n: Vec3 | null = moge.normals ? [moge.normals[i * 3], moge.normals[i * 3 + 1], moge.normals[i * 3 + 2]] : null;
      const hit = groundPointAt(this.world, x, y, this.ground);
      return {
        x,
        y,
        distance_m: p ? Math.round(Math.hypot(...p) * 100) / 100 : null,
        is_ground: n ? dot(n, upThree) > 0.9 : null,
        ground_ray_hit_m: hit?.via === 'ground' ? Math.round(Math.hypot(...hit.point) * 100) / 100 : null,
      };
    });
  };

  /** What a language model is shown, plus the tools that act on this case. */
  async task(): Promise<PlacementTask> {
    const { world, obj, asset } = this;
    const facts = caseFacts(world, obj);
    const size = asset.frame.size;
    return {
      label: this.label,
      objectName: obj.name,
      description: obj.plan?.description ?? '',
      assetKind: asset.kind,
      assetModel: asset.model,
      proportions: [size[0] / size[1], 1, size[2] / size[1]],
      facts,
      photo: await photoWithOutline(world, obj),
      turntable: await renderTurntable(asset, facts.viewElevationDeg, YAWS),
      yaws: YAWS,
      place: this.place,
      score: (p) => this.score(p),
      autoFit: this.autoFit,
      measure: this.measure,
    };
  }
}

export function caseFacts(world: BenchWorld, obj: BenchObject) {
  const { k, up } = world;
  const cu = ((obj.box.x0 + obj.box.x1) / 2) / world.srcScaleX, cv = ((obj.box.y0 + obj.box.y1) / 2) / world.srcScaleY;
  const ray = normalize([(cu - k.cx) / k.fx, (cv - k.cy) / k.fy, 1]);
  return {
    imageWidth: world.source.width,
    imageHeight: world.source.height,
    hfovDeg: hfovOf(k),
    cameraHeightM: -world.groundH,
    cameraPitchDownDeg: Math.asin(Math.max(-1, Math.min(1, -up[2]))) * DEG,
    viewElevationDeg: Math.asin(Math.max(-1, Math.min(1, -dot(ray, up)))) * DEG,
  };
}
