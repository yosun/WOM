// Read-only view of a built world for benchmarks: photo, MoGe depth, the camera compose used, gravity,
// the ground plane, object masks and every generated 3D asset. Nothing here writes to the world.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { WORLDS_DIR } from '../config.ts';
import { loadTriMesh, simplifyForFitting } from '../geometry/glb.ts';
import { fitGroundPlane, pointThrough, type GroundPlane } from '../geometry/ground.ts';
import { dilateMask, maskBox, maskFromPng, resizeMask, type Mask } from '../geometry/mask.ts';
import { dot, normalize, type Mat3, type Vec3 } from '../geometry/math.ts';
import { centeredIntrinsics, estimateIntrinsics, loadMoge, type Intrinsics, type MogeMaps } from '../geometry/moge.ts';
import { loadPlyCloud } from '../geometry/ply.ts';
import { assetFrame, canonFor, viewBaseFor, type AssetFrame } from '../geometry/pose.ts';
import type { Shape } from '../geometry/raster.ts';
import { mtimeIn, planRegistry } from '../pipeline/assets.ts';
import type { Box, DepthModel, MeshModel, ObjectAsset, PlannedObject, SceneDoc, WorldManifest } from '../types.ts';
import { median } from '../util.ts';

export interface BenchAsset {
  model: MeshModel;
  kind: 'splat' | 'mesh';
  file: string;
  source: ObjectAsset['source'];
  jobId?: string;
  /** Thinned for fitting and scoring; carries colours. */
  shape: Shape;
  frame: AssetFrame;
  /** Base rotation the classic (view-aligned) fitter uses for this kind of asset. */
  fitBase: Mat3;
  alignImage: boolean;
}

export interface BenchObject {
  id: string;
  name: string;
  plan?: PlannedObject;
  /** Mask at source resolution and its half-open pixel box. */
  mask: Mask;
  box: Box;
  /** Assets that exist on disk (the registry plus legacy files recovered read-only). */
  assets: ObjectAsset[];
  /** Which of the object's masks this is (1 = the pipeline's own; higher = redone by the user). */
  maskVersion: number;
}

export interface BenchWorld {
  id: string;
  title: string;
  manifest: WorldManifest;
  scene: SceneDoc;
  /** Which depth model's maps this view uses. */
  depthModel: DepthModel;
  file: (rel: string) => string;
  /** Photo at source resolution. */
  source: { width: number; height: number; rgb: Uint8Array };
  sourceJpeg: Buffer;
  moge: MogeMaps;
  /** Camera on the MoGe grid, the same one compose used (Marble-calibrated when available). */
  k: Intrinsics;
  srcScaleX: number;
  srcScaleY: number;
  /** Gravity up in the OpenCV camera frame (from the ground-plane fit; compose's estimate as fallback). */
  up: Vec3;
  /** Height of the global ground plane along `up` (negative: below the camera). */
  groundH: number;
  ground: GroundPlane | null;
  objects: BenchObject[];
  /** Union of dilated object masks on the MoGe grid (pixels that are not background). */
  exclude: Uint8Array;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Load a world for placement. `depthModel` picks one of its stored depth maps (default: the active one). */
export async function loadBenchWorld(id: string, depthModel?: DepthModel): Promise<BenchWorld> {
  const dir = path.join(WORLDS_DIR, id);
  const file = (rel: string) => {
    const full = path.resolve(dir, rel);
    if (!full.startsWith(dir + path.sep)) throw new Error('path escapes world directory');
    return full;
  };
  const manifest = readJson<WorldManifest>(file('manifest.json'));
  if (!existsSync(file('scene.json'))) throw new Error(`world ${id} has no scene.json yet`);
  const scene = readJson<SceneDoc>(file('scene.json'));
  const activeDepth = (manifest.depth.original?.job?.model ?? 'moge2') as DepthModel;
  const wanted = depthModel ?? activeDepth;
  const depthEntry = wanted === activeDepth ? manifest.depth.original : manifest.depthAssets?.[wanted]?.original;
  const origFiles = depthEntry?.files;
  if (!origFiles?.points || !existsSync(file(origFiles.points))) throw new Error(`world ${id} has no ${wanted} depth maps`);
  const moge = await loadMoge({
    points: file(origFiles.points),
    depth: origFiles.depth ? file(origFiles.depth) : undefined,
    mask: origFiles.mask ? file(origFiles.mask) : undefined,
    normal: origFiles.normal ? file(origFiles.normal) : undefined,
  });
  const W = moge.width, H = moge.height;
  const hfov = scene.world?.calibration?.hfovDeg;
  const k = scene.camera.source === 'marble' && hfov ? centeredIntrinsics(W, H, hfov) : estimateIntrinsics(moge);
  const sourceJpeg = readFileSync(file(manifest.image.file));
  const { data, info } = await sharp(sourceJpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const source = { width: info.width, height: info.height, rgb: new Uint8Array(data) };
  const upThree = normalize(scene.camera.up);
  let up: Vec3 = [upThree[0], -upThree[1], -upThree[2]];

  // Objects: masks and every asset on disk (registry entries, plus legacy files recovered read-only).
  const logFile = file('log.txt');
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
  const registry = planRegistry(manifest, log, mtimeIn({ file }));
  const objects: BenchObject[] = [];
  const exclude = new Uint8Array(W * H);
  for (const o of manifest.objects) {
    if (!o.mask?.file || !existsSync(file(o.mask.file))) continue;
    const mask = await maskFromPng(file(o.mask.file));
    const box = maskBox(mask);
    if (!box) continue;
    const small = dilateMask(resizeMask(mask, W, H), Math.max(2, Math.round(W * 0.012)));
    for (let i = 0; i < exclude.length; i++) exclude[i] |= small.data[i];
    const assets = Object.values(registry.objects.get(o.id) ?? {}).filter((a): a is ObjectAsset => Boolean(a?.file && existsSync(file(a.file))));
    objects.push({ id: o.id, name: o.name, plan: manifest.plan?.objects.find((p) => p.id === o.id), mask, box, assets, maskVersion: o.maskVersion ?? 1 });
  }

  // Gravity and ground from a plane through the ground points, in the camera the scene is composed in.
  const plane = fitGroundPlane(moge, k, exclude);
  if (plane) up = plane.up;

  const world: BenchWorld = {
    id,
    title: manifest.title,
    manifest,
    scene,
    depthModel: wanted,
    file,
    source,
    sourceJpeg,
    moge,
    k,
    srcScaleX: source.width / W,
    srcScaleY: source.height / H,
    up,
    groundH: plane?.height ?? -1.5,
    ground: plane,
    objects,
    exclude,
  };
  return world;
}

/**
 * Height of the ground along gravity (`up · p`, metres; negative below the camera) near a source-pixel
 * box: the median over floor-facing pixels around and below it, else the global plane.
 */
export function groundHeight(world: BenchWorld, near: Box | null): number {
  const { moge, up } = world;
  if (!moge.normals || !near) return world.groundH;
  const W = moge.width, H = moge.height;
  let x0 = 0, x1 = W, y0 = Math.floor(H * 0.4), y1 = H;
  if (near) {
    const bx0 = near.x0 / world.srcScaleX, bx1 = near.x1 / world.srcScaleX, by0 = near.y0 / world.srcScaleY, by1 = near.y1 / world.srcScaleY;
    const bw = bx1 - bx0, bh = by1 - by0;
    x0 = Math.max(0, Math.floor(bx0 - 0.6 * bw));
    x1 = Math.min(W, Math.ceil(bx1 + 0.6 * bw));
    y0 = Math.max(0, Math.floor(by0 + 0.4 * bh));
    y1 = Math.min(H, Math.ceil(by1 + 0.6 * bh));
  }
  const hs: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * W + x;
      if (!moge.valid[i] || world.exclude[i] || moge.normals[i * 3 + 1] < 0.75) continue;
      const h = dot(up, pointThrough(moge, world.k, i));
      // Only points close to the global plane: grass and paving, not low walls or plants.
      if (Math.abs(h - world.groundH) < 0.25 * Math.abs(world.groundH)) hs.push(h);
    }
  }
  return hs.length >= 30 ? median(hs) : world.groundH;
}

/** Grid (0–1000) image coordinates → pixel on the MoGe grid. */
export function gridToK(world: BenchWorld, x: number, y: number): [number, number] {
  return [(x / 1000) * world.k.width, (y / 1000) * world.k.height];
}

/** Pixel on the MoGe grid → 0–1000 grid. */
export function kToGrid(world: BenchWorld, u: number, v: number): [number, number] {
  return [(u / world.k.width) * 1000, (v / world.k.height) * 1000];
}

export function projectToGrid(world: BenchWorld, p: Vec3): [number, number] {
  const { k } = world;
  return kToGrid(world, (k.fx * p[0]) / p[2] + k.cx, (k.fy * p[1]) / p[2] + k.cy);
}

/** MoGe point (metres, camera frame) at a 0–1000 grid location, or null where depth is invalid. */
export function mogePointAt(world: BenchWorld, x: number, y: number): Vec3 | null {
  const { moge } = world;
  const [u, v] = gridToK(world, x, y);
  const px = Math.min(moge.width - 1, Math.max(0, Math.floor(u))), py = Math.min(moge.height - 1, Math.max(0, Math.floor(v)));
  const i = py * moge.width + px;
  if (!moge.valid[i]) return null;
  return pointThrough(moge, world.k, i);
}

/**
 * Where the camera ray through a 0–1000 grid location meets the ground plane (height `groundH`).
 * Falls back to the MoGe point when the ray does not reach the ground in front of the camera.
 */
export function groundPointAt(world: BenchWorld, x: number, y: number, groundH: number): { point: Vec3; via: 'ground' | 'depth' } | null {
  const { k, up } = world;
  const [u, v] = gridToK(world, x, y);
  const d: Vec3 = [(u - k.cx) / k.fx, (v - k.cy) / k.fy, 1];
  const den = dot(up, d);
  if (den < -1e-6) {
    const lambda = groundH / den;
    if (lambda > 0 && lambda < 500) return { point: [d[0] * lambda, d[1] * lambda, d[2] * lambda], via: 'ground' };
  }
  const p = mogePointAt(world, x, y);
  return p ? { point: p, via: 'depth' } : null;
}

/** Load an asset's geometry (thinned) and canonical frame. */
export async function loadAsset(world: Pick<BenchWorld, 'file'>, rec: ObjectAsset): Promise<BenchAsset> {
  const file = world.file(rec.file!);
  let shape: Shape;
  if (rec.kind === 'splat') {
    shape = { kind: 'points', cloud: await loadPlyCloud(file, { maxPoints: 45000, minOpacity: 0.1 }) };
  } else {
    const full = await loadTriMesh(file, { withTexture: true });
    shape = { kind: 'mesh', mesh: await simplifyForFitting(full, 9000) };
  }
  const canon = canonFor(rec.model);
  const positions = shape.kind === 'mesh' ? shape.mesh.positions : shape.cloud.positions;
  return {
    model: rec.model,
    kind: rec.kind,
    file: rec.file!,
    source: rec.source,
    jobId: rec.job?.jobId,
    shape,
    frame: assetFrame(positions, canon),
    fitBase: viewBaseFor(rec.model),
    alignImage: rec.alignImage,
  };
}
