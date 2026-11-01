// Compose the final scene: calibrate the Marble world against the photo's camera, fit every object
// (TripoSplat splat or Tripo mesh) into place, build the depth relief, and write scene.json for the viewer.
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { calibrateMarble, marbleScale, rotateCloud } from '../geometry/calibrate.ts';
import { fitObject, R_CAMERA_ALIGNED, R_TRIPO_MESH } from '../geometry/fit.ts';
import { loadTriMesh, simplifyForFitting } from '../geometry/glb.ts';
import { loadPlyCloud } from '../geometry/ply.ts';
import { dilateMask, maskFromPng, resizeMask, type Mask } from '../geometry/mask.ts';
import { CV_TO_THREE, cvToThree, mul, normalize, quatFromMat3, type Vec3 } from '../geometry/math.ts';
import { centeredIntrinsics, estimateIntrinsics, hfovOf, loadMoge, resampleNearest, vfovOf, type Intrinsics, type MogeMaps } from '../geometry/moge.ts';
import { renderReprojection, type PreviewObject } from '../geometry/preview.ts';
import type { Pose, Shape } from '../geometry/raster.ts';
import { buildReliefGlb } from '../geometry/relief.ts';
import { decodeSpz, type SplatCloud } from '../geometry/spz.ts';
import type { WorldHandle } from '../store.ts';
import type { ObjectPlacement, SceneDoc } from '../types.ts';
import { errorMessage, median, writeFileAtomic } from '../util.ts';

function mogeFiles(files: Record<string, string>, world: WorldHandle) {
  return {
    points: world.file(files.points),
    depth: files.depth ? world.file(files.depth) : undefined,
    mask: files.mask ? world.file(files.mask) : undefined,
    normal: files.normal ? world.file(files.normal) : undefined,
  };
}

async function rgbOf(file: string, width?: number) {
  let img = sharp(file).removeAlpha();
  if (width) img = img.resize(width, null, { fit: 'inside' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgb: new Uint8Array(data) };
}

function averageRows(img: { width: number; height: number; rgb: Uint8Array }, y0: number, y1: number): string {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = 0; x < img.width; x++) {
      const q = (y * img.width + x) * 3;
      r += img.rgb[q]; g += img.rgb[q + 1]; b += img.rgb[q + 2]; n++;
    }
  }
  const hex = (v: number) => Math.round(v / Math.max(1, n)).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Gravity "up" in three.js camera coordinates from MoGe normals of floor-like pixels. */
function estimateUp(maps: MogeMaps, exclude: Uint8Array | null): { up: Vec3; floorPixels: number } {
  if (!maps.normals) return { up: [0, 1, 0], floorPixels: 0 };
  let sx = 0, sy = 0, sz = 0, n = 0;
  const { width: W, height: H } = maps;
  for (let y = Math.floor(H * 0.35); y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const i = y * W + x;
      if (!maps.valid[i] || (exclude && exclude[i])) continue;
      const nx = maps.normals[i * 3], ny = maps.normals[i * 3 + 1], nz = maps.normals[i * 3 + 2];
      if (ny > 0.8) { sx += nx; sy += ny; sz += nz; n++; }
    }
  }
  const total = (W * H) / 4;
  if (n < total * 0.02) return { up: [0, 1, 0], floorPixels: n };
  const up = normalize([sx, sy, sz]);
  // Guard against odd scenes: stay within 40° of the camera's own up.
  if (up[1] < Math.cos((40 * Math.PI) / 180)) return { up: [0, 1, 0], floorPixels: n };
  return { up, floorPixels: n };
}

export async function composeScene(world: WorldHandle): Promise<SceneDoc> {
  const m = world.manifest;
  const diagnostics: string[] = [];
  const origFiles = m.depth.original?.files;
  if (!origFiles?.points) throw new Error('MoGe-2 depth for the photo is missing');
  const orig = await loadMoge(mogeFiles(origFiles, world));
  const W = orig.width, H = orig.height;
  const kMoge = estimateIntrinsics(orig);
  diagnostics.push(`MoGe-2 camera: ${hfovOf(kMoge).toFixed(1)}° horizontal field of view on a ${W}×${H} grid`);

  const source = await rgbOf(world.file(m.image.file));
  const srcScaleX = source.width / W, srcScaleY = source.height / H;

  // Object masks at source resolution and a dilated union on the depth grid (pixels to ignore for background stats).
  const masks = new Map<string, Mask>();
  const exclude = new Uint8Array(W * H);
  for (const o of m.objects) {
    if (!o.mask?.file || !existsSync(world.file(o.mask.file))) continue;
    const mk = await maskFromPng(world.file(o.mask.file));
    masks.set(o.id, mk);
    const small = dilateMask(resizeMask(mk, W, H), Math.max(2, Math.round(W * 0.012)));
    for (let i = 0; i < exclude.length; i++) exclude[i] |= small.data[i];
  }

  // Clean-plate depth, rescaled to agree with the photo's depth on untouched background pixels.
  let bgDepth = orig.depth;
  let bgValid = orig.valid;
  let usingCleanDepth = false;
  const cleanFiles = m.depth.clean?.files;
  if (cleanFiles?.points) {
    try {
      const clean = await loadMoge(mogeFiles(cleanFiles, world));
      let cd = clean.depth, cv = clean.valid;
      if (clean.width !== W || clean.height !== H) {
        cd = resampleNearest(clean.depth, clean.width, clean.height, W, H);
        const cvF = resampleNearest(Float32Array.from(clean.valid), clean.width, clean.height, W, H);
        cv = Uint8Array.from(cvF, (v) => (v > 0.5 ? 1 : 0));
      }
      const ratios: number[] = [];
      for (let i = 0; i < W * H; i += 3) {
        if (exclude[i] || !orig.valid[i] || !cv[i]) continue;
        ratios.push(orig.depth[i] / cd[i]);
      }
      const r = ratios.length > 200 ? median(ratios) : 1;
      bgDepth = Float32Array.from(cd, (z) => z * r);
      bgValid = cv;
      usingCleanDepth = true;
      diagnostics.push(`Clean-plate depth rescaled by ${r.toFixed(3)} to match the photo (${ratios.length} background samples)`);
    } catch (err) {
      diagnostics.push(`Clean-plate depth unusable (${errorMessage(err)}); using the photo's depth for the background`);
    }
  }

  const { up, floorPixels } = estimateUp(orig, exclude);
  diagnostics.push(floorPixels ? `Gravity estimated from ${floorPixels} floor-facing depth samples` : 'No floor visible; assuming a level camera');

  // Marble world calibration: rotation + field of view (photometric), then metric scale (MoGe depth).
  let k: Intrinsics = kMoge;
  let cameraSource: 'marble' | 'moge' = 'moge';
  let worldDoc: SceneDoc['world'];
  let previewCloud: SplatCloud | undefined;
  let previewScale = 1;
  const splats = m.world?.splats ?? [];
  const cleanImageFile = m.cleanPlate?.file && existsSync(world.file(m.cleanPlate.file)) ? m.cleanPlate.file : m.image.file;
  if (splats.length) {
    try {
      const calibSplat = splats.find((s) => s.variant === '500k') ?? [...splats].sort((a, b) => b.size - a.size).find((s) => s.size < 15e6) ?? splats[0];
      const cloud = decodeSpz(await readFile(world.file(calibSplat.file)));
      const small = await rgbOf(world.file(cleanImageFile), 192);
      const upCv: Vec3 | null = floorPixels ? [up[0], -up[1], -up[2]] : null;
      const cal = calibrateMarble(cloud, small, upCv);
      if (cal.colorError < 0.3) {
        k = centeredIntrinsics(W, H, cal.hfovDeg);
        cameraSource = 'marble';
      } else {
        diagnostics.push(`Marble camera match was weak (color error ${cal.colorError.toFixed(3)}); keeping MoGe's camera`);
      }
      const rotated = rotateCloud(cloud, cal.R);
      const scale = marbleScale({ splats: rotated, k, depth: bgDepth, valid: bgValid, exclude: usingCleanDepth ? undefined : exclude });
      previewCloud = rotated;
      previewScale = scale.scale;
      diagnostics.push(
        `Marble camera: ${cal.hfovDeg.toFixed(1)}° horizontal FOV, pitch ${cal.pitchDeg.toFixed(1)}°, yaw ${cal.yawDeg.toFixed(1)}°, roll ${cal.rollDeg.toFixed(1)}° ` +
          `(color error ${cal.colorError.toFixed(3)}, coverage ${(cal.coverage * 100).toFixed(0)}%, ${cal.evaluations} renders); ` +
          `${scale.scale.toFixed(3)} m per Marble unit from ${scale.samples} depth samples (IQR ratio ${scale.spread.toFixed(2)})`,
      );
      const rank = (v: string) => (v === '500k' ? 0 : /full/.test(v) ? 1 : v === '150k' ? 2 : 3);
      worldDoc = {
        splats: [...splats]
          .sort((a, b) => rank(a.variant) - rank(b.variant))
          .map((s) => ({ variant: s.variant, url: `/files/${m.id}/${s.file}`, size: s.size })),
        colliderUrl: m.world?.collider ? `/files/${m.id}/${m.world.collider}` : undefined,
        panoUrl: m.world?.pano ? `/files/${m.id}/${m.world.pano}` : undefined,
        scale: scale.scale,
        // Marble raw → photo camera (OpenCV) → three.js camera frame.
        quaternion: quatFromMat3(mul(CV_TO_THREE, cal.R)),
        calibration: { hfovDeg: cal.hfovDeg, colorError: cal.colorError, depthSamples: scale.samples },
      };
    } catch (err) {
      diagnostics.push(`Marble world calibration failed: ${errorMessage(err)}`);
    }
  }
  const previewObjects: PreviewObject[] = [];

  // Fit every object.
  const sceneObjects: SceneDoc['objects'] = [];
  for (const o of m.objects) {
    const mk = masks.get(o.id);
    if (!o.mesh?.file || !mk || !existsSync(world.file(o.mesh.file))) continue;
    try {
      const t0 = Date.now();
      const kind = o.mesh.kind ?? (/\.(ply|spz|splat)$/i.test(o.mesh.file) ? 'splat' : 'mesh');
      let shape: Shape;
      if (kind === 'splat') {
        // Faint Gaussians still show in Spark (thin parts, leaves), so keep everything above 10% opacity.
        shape = { kind: 'points', cloud: await loadPlyCloud(world.file(o.mesh.file), { maxPoints: 45000, minOpacity: 0.1 }) };
      } else {
        const full = await loadTriMesh(world.file(o.mesh.file), { withTexture: true });
        shape = { kind: 'mesh', mesh: await simplifyForFitting(full, 9000) };
      }
      const fit = fitObject({
        shape,
        // TripoSplat splats are upright with -Y up (facing found by the yaw search); Tripo meshes face +X with +Y up.
        base: kind === 'splat' ? R_CAMERA_ALIGNED : R_TRIPO_MESH,
        k,
        mask: mk,
        srcScaleX,
        srcScaleY,
        image: source,
        depth: orig.depth,
        valid: orig.valid,
        alignImage: o.mesh.alignImage,
      });
      if (!fit) {
        diagnostics.push(`${o.name}: could not be fitted (empty mask or depth)`);
        continue;
      }
      previewObjects.push({ shape, pose: fit.pose as Pose });
      const R3 = mul(CV_TO_THREE, fit.pose.R);
      const placement: ObjectPlacement = {
        position: cvToThree(fit.pose.t),
        quaternion: quatFromMat3(R3),
        scale: fit.pose.s,
        fit: { iou: fit.iou, yawDeg: fit.yawDeg, pitchDeg: fit.pitchDeg, depthM: fit.centerDepth, heightM: fit.heightM },
      };
      await world.update((mm) => {
        const rec = mm.objects.find((x) => x.id === o.id);
        if (rec) rec.placement = placement;
      });
      sceneObjects.push({
        id: o.id,
        name: o.name,
        kind,
        url: `/files/${m.id}/${o.mesh.file}`,
        bytes: statSync(world.file(o.mesh.file)).size,
        position: placement.position,
        quaternion: placement.quaternion,
        scale: placement.scale,
        visible: true,
        fitIou: fit.iou,
      });
      diagnostics.push(
        `${o.name}: silhouette IoU ${fit.iou.toFixed(2)}, ${fit.centerDepth.toFixed(2)} m away, ${fit.heightM.toFixed(2)} m tall, ` +
          `yaw ${fit.yawDeg.toFixed(0)}°, pitch ${fit.pitchDeg.toFixed(0)}° (${fit.evaluations} renders, ${Date.now() - t0} ms)`,
      );
    } catch (err) {
      diagnostics.push(`${o.name}: placement failed (${errorMessage(err)})`);
    }
  }

  // Depth relief of the background, textured with the clean plate.
  let relief: SceneDoc['relief'];
  try {
    const tex = await sharp(world.file(cleanImageFile)).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    const r = await buildReliefGlb({ depth: bgDepth, valid: bgValid, k, textureJpeg: tex, out: world.file('relief.glb') });
    relief = { url: `/files/${m.id}/relief.glb` };
    diagnostics.push(`Depth relief: ${r.triangles} triangles${usingCleanDepth ? '' : ' (from the photo, objects included)'}`);
  } catch (err) {
    diagnostics.push(`Depth relief failed: ${errorMessage(err)}`);
  }

  // Orbit target: the middle of the placed objects, else straight ahead at the median background depth.
  let target: Vec3;
  if (sceneObjects.length) {
    const c = sceneObjects.reduce<Vec3>((a, o) => [a[0] + o.position[0], a[1] + o.position[1], a[2] + o.position[2]], [0, 0, 0]);
    target = [c[0] / sceneObjects.length, c[1] / sceneObjects.length, c[2] / sceneObjects.length];
  } else {
    const zs: number[] = [];
    for (let i = 0; i < W * H; i += 7) if (bgValid[i]) zs.push(bgDepth[i]);
    target = [0, 0, -Math.min(30, Math.max(1, median(zs) || 4))];
  }

  // Reprojection check: the reconstruction rendered from the photo's camera, saved next to the photo.
  try {
    const bg = await rgbOf(world.file(cleanImageFile), 640);
    const jpg = await renderReprojection({ k, width: 640, background: bg, cloud: previewCloud, splatScale: previewScale, objects: previewObjects });
    await writeFileAtomic(world.file('reprojection.jpg'), jpg);
  } catch (err) {
    diagnostics.push(`Reprojection preview failed: ${errorMessage(err)}`);
  }

  const clean = await rgbOf(world.file(cleanImageFile), 128);
  const version = Date.now();
  const doc: SceneDoc = {
    version,
    title: m.title,
    image: { url: `/files/${m.id}/${m.image.file}`, width: m.image.width, height: m.image.height },
    camera: { fovY: vfovOf(k), aspect: k.width / k.height, up, target, source: cameraSource },
    world: worldDoc,
    relief,
    objects: sceneObjects,
    lighting: {
      sky: averageRows(clean, 0, Math.ceil(clean.height * 0.08)),
      ground: averageRows(clean, Math.floor(clean.height * 0.92), clean.height),
      sun: [0.4, 0.8, 0.45],
    },
    diagnostics,
  };
  await writeFileAtomic(world.file('scene.json'), JSON.stringify(doc, null, 2));
  return doc;
}
