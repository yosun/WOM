// How well each depth model recovers the real camera: its field of view against the lens recorded in
// EXIF, and its depth against the depth or disparity map an iPhone stores with Portrait / LiDAR photos.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { estimateIntrinsics, hfovOf, loadMoge } from '../geometry/moge.ts';
import type { WorldHandle } from '../store.ts';
import type { CameraInfo, DepthEntry, DepthModel } from '../types.ts';

export interface PhoneDepthAgreement {
  type: string;
  accuracy?: string;
  /** Mean |aligned − phone| / phone after the best scale (and shift, for disparity). Lower is better. */
  absRel: number;
  /** Correlation between the two maps (1 = same shape). */
  r: number;
  /** Median phone depth ÷ model depth, for absolute (LiDAR) depth: how far off the model's metric scale is. */
  scale?: number;
  samples: number;
}

export interface CameraReport {
  world: string;
  title: string;
  camera?: CameraInfo;
  depth: { model: DepthModel; hfovDeg: number; errorDeg?: number; phone?: PhoneDepthAgreement }[];
  aux: { type: string; width: number; height: number; accuracy?: string; preview?: string }[];
  frames: number;
}

/** Field of view a depth model's point map implies (computed once and kept in the manifest). */
export async function depthFov(world: WorldHandle, entry: DepthEntry): Promise<number | undefined> {
  if (entry.hfovDeg) return entry.hfovDeg;
  const f = entry.files;
  if (!f?.points || !existsSync(world.file(f.points))) return undefined;
  const maps = await loadMoge({ points: world.file(f.points), mask: f.mask ? world.file(f.mask) : undefined });
  return hfovOf(estimateIntrinsics(maps));
}

async function compareWithPhone(world: WorldHandle, entry: DepthEntry, aux: { type: string; file: string; width: number; height: number; accuracy?: string }): Promise<PhoneDepthAgreement | undefined> {
  const f = entry.files;
  if (!f?.points || !existsSync(world.file(f.points)) || !existsSync(world.file(aux.file))) return undefined;
  const maps = await loadMoge({ points: world.file(f.points), mask: f.mask ? world.file(f.mask) : undefined });
  const raw = await readFile(world.file(aux.file));
  const phone = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  if (phone.length !== aux.width * aux.height) return undefined;
  const disparity = aux.type === 'disparity';
  const xs: number[] = [], ys: number[] = [];
  const step = Math.max(1, Math.floor(Math.sqrt((maps.width * maps.height) / 30000)));
  for (let y = 0; y < maps.height; y += step) {
    for (let x = 0; x < maps.width; x += step) {
      const i = y * maps.width + x;
      const z = maps.depth[i];
      if (!maps.valid[i] || !(z > 0)) continue;
      const px = Math.min(aux.width - 1, Math.floor(((x + 0.5) / maps.width) * aux.width));
      const py = Math.min(aux.height - 1, Math.floor(((y + 0.5) / maps.height) * aux.height));
      const p = phone[py * aux.width + px];
      if (!Number.isFinite(p) || !(p > 0)) continue;
      xs.push(disparity ? 1 / z : z);
      ys.push(p);
    }
  }
  const n = xs.length;
  if (n < 500) return undefined;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const r = sxy / Math.sqrt(sxx * syy);
  let absRel = 0;
  let scale: number | undefined;
  if (disparity) {
    // Dual-camera disparity is only known up to scale and shift.
    const a = sxy / sxx, b = my - a * mx;
    for (let i = 0; i < n; i++) absRel += Math.abs(a * xs[i] + b - ys[i]) / ys[i];
  } else {
    const ratios = xs.map((v, i) => ys[i] / v).sort((p, q) => p - q);
    const s = ratios[Math.floor(n / 2)];
    for (let i = 0; i < n; i++) absRel += Math.abs(s * xs[i] - ys[i]) / ys[i];
    if (aux.accuracy === 'absolute') scale = s;
  }
  return { type: aux.type, accuracy: aux.accuracy, absRel: absRel / n, r, scale, samples: n };
}

/** Field of view and depth agreement for every depth model the world has, against what the camera recorded. */
export async function cameraReport(world: WorldHandle): Promise<CameraReport> {
  const m = world.manifest;
  const entries = new Map<DepthModel, DepthEntry>();
  for (const [model, v] of Object.entries(m.depthAssets ?? {}) as [DepthModel, { original?: DepthEntry }][]) if (v.original) entries.set(model, v.original);
  if (m.depth.original && !entries.has((m.depth.original.job?.model ?? 'moge2') as DepthModel)) entries.set((m.depth.original.job?.model ?? 'moge2') as DepthModel, m.depth.original);

  const phoneAux = m.image.aux?.find((a) => (a.type === 'depth' || a.type === 'disparity') && a.file);
  const depth: CameraReport['depth'] = [];
  const fovs = new Map<DepthModel, number>();
  for (const [model, entry] of entries) {
    const hfov = await depthFov(world, entry);
    if (!hfov) continue;
    fovs.set(model, hfov);
    const phone = phoneAux ? await compareWithPhone(world, entry, phoneAux as { type: string; file: string; width: number; height: number; accuracy?: string }) : undefined;
    depth.push({ model, hfovDeg: hfov, errorDeg: m.image.camera?.hfovDeg ? hfov - m.image.camera.hfovDeg : undefined, phone });
  }
  // Keep computed fields of view so the next report is instant.
  if ([...fovs].some(([model]) => !entries.get(model)?.hfovDeg)) {
    await world.update((mm) => {
      for (const [model, hfov] of fovs) {
        const a = mm.depthAssets?.[model]?.original;
        if (a && !a.hfovDeg) a.hfovDeg = hfov;
        if (mm.depth.original && (mm.depth.original.job?.model ?? 'moge2') === model && !mm.depth.original.hfovDeg) mm.depth.original.hfovDeg = hfov;
      }
    });
  }
  depth.sort((a, b) => a.model.localeCompare(b.model));
  return {
    world: m.id,
    title: m.title,
    camera: m.image.camera,
    depth,
    aux: (m.image.aux ?? []).map((a) => ({ type: a.type, width: a.width, height: a.height, accuracy: a.accuracy, preview: a.preview ? `/files/${m.id}/${a.preview}` : undefined })),
    frames: m.image.frames?.length ?? 1,
  };
}
