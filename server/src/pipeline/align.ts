// Align a split person's head and body to the photo's pixels, as part of compose. The work (geometry/alignJob.ts) runs in a worker thread
// and is cached: the result is keyed by everything it depends on, so a recompose that changes nothing for the person costs a hash.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { runAlignJob, type AlignJob, type AlignResult } from '../geometry/alignJob.ts';
import { convexHull, type HullMesh } from '../geometry/hull.ts';
import { loadPlyCloud } from '../geometry/ply.ts';
import type { SplatPose } from '../geometry/splat.ts';
import type { WorldHandle } from '../store.ts';
import type { AlignedAsset, ObjectRecord } from '../types.ts';
import { errorMessage } from '../util.ts';
import { sha256File } from './assets.ts';
import { REGION_DIR } from './split.ts';

/** Bump when the algorithm changes in a way that makes old results wrong. */
export const ALIGN_VERSION = 1;
const WORKER_TIMEOUT_MS = 20 * 60_000;

export interface SplitPair { head: ObjectRecord; body: ObjectRecord }

/** The head and body objects the split step made, as pairs, when both have a 3D asset. */
export function splitPairs(world: WorldHandle): SplitPair[] {
  const m = world.manifest;
  const byPerson = new Map<string, Partial<Record<'head' | 'body', ObjectRecord>>>();
  for (const p of m.plan?.objects ?? []) {
    if (!p.part) continue;
    const rec = m.objects.find((o) => o.id === p.id);
    if (rec) byPerson.set(p.part.of, { ...byPerson.get(p.part.of), [p.part.role]: rec });
  }
  // alignment moves Gaussians, so both parts must be Gaussian-splat PLY files
  const isSplat = (o?: ObjectRecord) => Boolean(o?.mesh?.file && (o.mesh.kind === 'splat' || /\.ply$/i.test(o.mesh.file)));
  return [...byPerson.values()].filter((v): v is SplitPair => Boolean(isSplat(v.head) && isSplat(v.body) && v.head?.mask && v.body?.mask));
}

const round = (v: number[], d = 6) => v.map((x) => +x.toFixed(d));

/** Everything the result depends on, hashed. */
export async function alignKey(world: WorldHandle, pair: SplitPair, poses: { head: SplatPose; body: SplatPose }, fovY: number): Promise<string> {
  const h = createHash('sha256');
  h.update(`v${ALIGN_VERSION}\n`);
  for (const f of [pair.head.mesh!.file!, pair.body.mesh!.file!, pair.head.mask!.file, pair.body.mask!.file, world.manifest.image.file, world.manifest.cleanPlate?.file ?? '']) {
    h.update(f && existsSync(world.file(f)) ? await sha256File(world.file(f)) : `none:${f}`);
  }
  const dir = world.file(`objects/${pair.head.id}/${REGION_DIR}`);
  const regions = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
  for (const f of regions) h.update(`${f}:${await sha256File(`${dir}/${f}`)}`);
  h.update(JSON.stringify({ head: { p: round(poses.head.position), q: round(poses.head.quaternion), s: +poses.head.scale.toFixed(6) }, body: { p: round(poses.body.position), q: round(poses.body.quaternion), s: +poses.body.scale.toFixed(6) }, fovY: +fovY.toFixed(5) }));
  return h.digest('hex').slice(0, 32);
}

/** Run the job in a worker thread; falls back to this thread only if workers cannot start. */
export function runInWorker(job: AlignJob, log: (msg: string) => void): Promise<AlignResult> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('../geometry/alignWorker.ts', import.meta.url), { workerData: job });
    } catch (err) {
      log(`could not start a worker thread (${errorMessage(err)}); aligning on the main thread`);
      runAlignJob(job, log).then(resolve, reject);
      return;
    }
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error(`alignment took more than ${WORKER_TIMEOUT_MS / 60000} minutes`)); }, WORKER_TIMEOUT_MS);
    let settled = false;
    const end = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    worker.on('message', (msg: { type: 'log'; message: string } | { type: 'done'; result: AlignResult } | { type: 'error'; message: string }) => {
      if (msg.type === 'log') log(msg.message);
      else if (msg.type === 'done') end(() => resolve(msg.result));
      else end(() => reject(new Error(msg.message)));
    });
    worker.on('error', (err) => end(() => reject(err)));
    worker.on('exit', (code) => end(() => reject(new Error(`the alignment worker stopped with code ${code}`))));
  });
}

export interface AlignedPart {
  file: string;
  pose: SplatPose;
  bytes: number;
  collider: HullMesh | null;
}

/**
 * Align one pair. Returns the aligned files for both parts, or null when it could not be done (the caller keeps the plain fit).
 * `poses` are the silhouette fitter's, in three.js coordinates; `fovY` is the camera the scene is composed in.
 */
export async function alignPair(world: WorldHandle, pair: SplitPair, poses: { head: SplatPose; body: SplatPose }, fovY: number): Promise<{ head: AlignedPart; body: AlignedPart; reused: boolean; summary: string } | null> {
  const m = world.manifest;
  const { head, body } = pair;
  if (!m.cleanPlate?.file || !existsSync(world.file(m.cleanPlate.file))) { world.log(`align: no clean plate to show behind ${head.name}; not aligned`); return null; }
  const key = await alignKey(world, pair, poses, fovY);
  const outHead = `${objectDirOf(head)}/model-aligned.ply`, outBody = `${objectDirOf(body)}/model-aligned.ply`;
  const part = async (rec: ObjectRecord, rel: string, pose: SplatPose): Promise<AlignedPart> => {
    const cloud = await loadPlyCloud(world.file(rel), { maxPoints: 20000, minOpacity: 0.5 });
    return { file: rel, pose, bytes: statSync(world.file(rel)).size, collider: convexHull(cloud.positions, { trim: 0.005 }) };
  };
  const cached = head.aligned?.key === key && body.aligned?.key === key && existsSync(world.file(head.aligned.file)) && existsSync(world.file(body.aligned.file));
  if (cached) {
    return { head: await part(head, head.aligned!.file, poses.head), body: await part(body, body.aligned!.file, poses.body), reused: true, summary: `reused (${head.aligned!.stats.seconds.toFixed(0)} s the first time)${head.aligned!.stats.notes?.length ? `; ${head.aligned!.stats.notes.join('; ')}` : ''}` };
  }

  const regionDir = world.file(`objects/${head.id}/${REGION_DIR}`);
  const regions: Record<string, string> = {};
  if (existsSync(regionDir)) for (const f of readdirSync(regionDir)) if (f.endsWith('.png')) regions[f.replace(/\.png$/, '')] = `${regionDir}/${f}`;
  const job: AlignJob = {
    photoFile: world.file(m.image.file), backdropFile: world.file(m.cleanPlate.file),
    headPly: world.file(head.mesh!.file!), bodyPly: world.file(body.mesh!.file!),
    headPose: poses.head, bodyPose: poses.body,
    headMask: world.file(head.mask!.file), bodyMask: world.file(body.mask!.file),
    regions, fovY, outHead: world.file(outHead), outBody: world.file(outBody),
  };
  const t0 = Date.now();
  world.log(`align: ${head.name} and ${body.name} to the photo's pixels (a minute or two; the server stays responsive)`);
  const res = await runInWorker(job, (msg) => world.log(`align: ${msg}`));
  const stamp = new Date().toISOString();
  const asset = (rel: string, pose: SplatPose, own: 'head' | 'body'): AlignedAsset => ({
    file: rel, key, pose: { position: pose.position, quaternion: pose.quaternion, scale: pose.scale },
    stats: {
      warpedGaussians: res.warp[own].warped, meanShiftPx: res.warp[own].meanShiftPx,
      seamPatches: own === 'body' ? res.seamPatches : 0, correctorGaussians: own === 'head' ? res.corrector?.added ?? 0 : 0, regions: own === 'head' ? res.corrector?.regions ?? [] : [],
      notes: res.notes,
      seconds: res.seconds,
    },
    createdAt: stamp,
  });
  await world.update(() => {
    head.aligned = asset(outHead, poses.head, 'head');
    body.aligned = asset(outBody, poses.body, 'body');
  });
  const bits = [`warped ${res.warp.head.warped + res.warp.body.warped} Gaussians (mean ${((res.warp.head.meanShiftPx + res.warp.body.meanShiftPx) / 2).toFixed(1)} px)`, `${res.seamPatches} seam patches`, res.corrector ? `corrector added ${res.corrector.added} Gaussians to ${res.corrector.regions.join(', ')}` : 'no corrector regions', ...res.notes];
  return { head: await part(head, outHead, poses.head), body: await part(body, outBody, poses.body), reused: false, summary: `${bits.join('; ')} in ${((Date.now() - t0) / 1000).toFixed(0)} s` };
}

function objectDirOf(o: ObjectRecord) {
  const v = o.maskVersion ?? 1;
  return v > 1 ? `objects/${o.id}/m${v}` : `objects/${o.id}`;
}

/** Drop a saved layout for these objects: it was made for different geometry, and would pull the aligned parts out of place. */
export async function dropStaleLayout(world: WorldHandle, ids: string[]): Promise<boolean> {
  const file = world.file('layout.json');
  if (!existsSync(file)) return false;
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as { objects?: { id: string }[] };
    if (!saved.objects?.some((l) => ids.includes(l.id))) return false;
    const { writeFileAtomic } = await import('../util.ts');
    await writeFileAtomic(file, JSON.stringify({ ...saved, objects: saved.objects.filter((l) => !ids.includes(l.id)) }, null, 2));
    return true;
  } catch {
    return false;
  }
}
