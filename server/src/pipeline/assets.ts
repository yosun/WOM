// Per-model registry of generated 3D assets. Every object keeps the output of every model it was ever
// generated with (TripoSplat, Tripo H3.1, Tripo P1 …) and every world keeps each Marble variant, so
// switching models, retrying, or benchmarking reuses paid work instead of generating it again.
//
// Worlds built before the registry existed are migrated by `ensureAssetRegistry`: the active asset is
// registered as is, and older files left on disk (objects/<id>/model.glb from a previous model) are
// matched to the job that produced them by reading the world's log.
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { WorldHandle } from '../store.ts';
import type { Ai3dJobRef, DepthModel, MeshModel, ObjectAsset, ObjectRecord, WorldAsset, WorldManifest, WorldModel } from '../types.ts';

const MESH_MODELS: MeshModel[] = ['idol', 'triposplat', 'tripo-v31', 'tripo-p1', 'tripo-h31-image', 'tripo-p1-image'];
const SPLAT_MODELS = new Set<MeshModel>(['idol', 'triposplat']);

export const assetKind = (model: MeshModel): 'splat' | 'mesh' => (SPLAT_MODELS.has(model) ? 'splat' : 'mesh');
const isMeshModel = (s: string | undefined): s is MeshModel => Boolean(s && (MESH_MODELS as string[]).includes(s));

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Folder of an object's current mask version: objects/<id> for the first mask, objects/<id>/m<n> after
 * the mask was redone, so files made from an earlier mask are never overwritten.
 */
export function objectDir(o: { id: string; maskVersion?: number }) {
  const v = o.maskVersion ?? 1;
  return v > 1 ? `objects/${o.id}/m${v}` : `objects/${o.id}`;
}

/** Keeps AI3D job names, and so their idempotency keys, distinct per mask version. */
export function versionSuffix(o: { maskVersion?: number }) {
  const v = o.maskVersion ?? 1;
  return v > 1 ? `-m${v}` : '';
}

/** The model an object should show: its own choice if it has one, else the world's. */
export function wantedModel(m: WorldManifest, o: ObjectRecord): MeshModel {
  return o.pinnedModel ?? m.options.meshModel;
}

/** Make `asset` the object's active 3D asset. The old placement is dropped; compose fits the new one. */
export function activateAsset(o: ObjectRecord, asset: ObjectAsset) {
  o.mesh = { job: asset.job, kind: asset.kind, file: asset.file, previewFile: asset.previewFile, alignImage: asset.alignImage };
  o.placement = undefined;
}

export function activateWorldAsset(m: WorldManifest, asset: WorldAsset) {
  m.world = { job: asset.job, splats: asset.splats, collider: asset.collider, pano: asset.pano, thumbnail: asset.thumbnail };
}

/** Assets that are complete on disk, keyed by model. */
export function readyAssets(o: ObjectRecord, exists: (rel: string) => boolean): ObjectAsset[] {
  return Object.values(o.assets ?? {}).filter((a): a is ObjectAsset => Boolean(a?.file && exists(a.file)));
}

interface Success {
  kind: 'splat' | 'mesh';
  model?: MeshModel;
  jobId?: string;
}

/** Replay a world log and return, per object name, the jobs whose output was downloaded (in order). */
function successesFromLog(names: string[], lines: string[]): Map<string, Success[]> {
  const out = new Map<string, Success[]>(names.map((n) => [n, []]));
  const last = new Map<string, { model?: MeshModel; jobId?: string }>();
  let optionModel: MeshModel | undefined;
  // Longest names first so "palm tree" never matches inside "tall potted palm tree".
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const raw of lines) {
    const line = raw.replace(/^\S+\s+/, '');
    const opt = /^Options for retry: (\{.*\})$/.exec(line);
    if (opt) {
      try {
        const model = JSON.parse(opt[1]).meshModel;
        if (isMeshModel(model)) optionModel = model;
      } catch {
        // ignore malformed lines
      }
      continue;
    }
    for (const name of sorted) {
      const submitted = line.includes(`: ${name}: submitted AI3D `) ? /submitted AI3D (\S+) job (\S+)/.exec(line) : null;
      if (submitted) {
        last.set(name, { model: isMeshModel(submitted[1]) ? submitted[1] : undefined, jobId: submitted[2] });
        break;
      }
      const resumed = line.includes(`: ${name}: resuming AI3D job `) ? /resuming AI3D job (\S+)/.exec(line) : null;
      if (resumed) {
        const prev = last.get(name);
        last.set(name, prev?.jobId === resumed[1] ? prev : { jobId: resumed[1] });
        break;
      }
      const meshDone = line.startsWith(`${name}: mesh `) || line.startsWith(`${name}: GLB optimization failed`);
      const splatDone = line.startsWith(`${name}: splat `);
      if (meshDone || splatDone) {
        const kind = splatDone ? 'splat' : 'mesh';
        const job = last.get(name);
        const fallback = optionModel && assetKind(optionModel) === kind ? optionModel : undefined;
        const model = job?.model && assetKind(job.model) === kind ? job.model : fallback;
        out.get(name)!.push({ kind, model, jobId: job?.jobId });
        break;
      }
    }
  }
  return out;
}

export interface RegistryPlan {
  objects: Map<string, Partial<Record<MeshModel, ObjectAsset>>>;
  worldAssets: Partial<Record<Exclude<WorldModel, 'none'>, WorldAsset>>;
  depthAssets: NonNullable<WorldManifest['depthAssets']>;
  notes: string[];
  changed: boolean;
}

/**
 * Work out the full registry for a manifest without touching it: existing entries, the active assets,
 * and legacy files recovered from the log. `mtime(rel)` returns null for missing files.
 */
export function planRegistry(m: WorldManifest, logLines: string[], mtime: (rel: string) => number | null): RegistryPlan {
  const notes: string[] = [];
  let changed = false;
  const iso = (ms: number | null) => new Date(ms ?? Date.parse(m.updatedAt)).toISOString();
  const successes = successesFromLog(m.objects.map((o) => o.name), logLines);
  const objects = new Map<string, Partial<Record<MeshModel, ObjectAsset>>>();

  for (const o of m.objects) {
    const assets: Partial<Record<MeshModel, ObjectAsset>> = { ...(o.assets ?? {}) };
    const known = new Set(Object.values(assets).map((a) => a?.file).filter(Boolean));

    // 1. The active asset.
    const active = o.mesh;
    if (active?.file && active.job?.model && isMeshModel(active.job.model) && !assets[active.job.model] && mtime(active.file) !== null) {
      const model = active.job.model;
      assets[model] = {
        model,
        kind: active.kind ?? assetKind(model),
        file: active.file,
        previewFile: active.previewFile && mtime(active.previewFile) !== null ? active.previewFile : undefined,
        alignImage: active.alignImage,
        job: active.job,
        createdAt: iso(mtime(active.file)),
        source: 'pipeline',
      };
      known.add(active.file);
      changed = true;
    }

    // 2. Files a previous model left behind in the object's folder. Once the mask was redone, those files
    //    belong to the first mask and are already kept in `history`.
    const legacy: { file: string; kind: 'splat' | 'mesh'; previews: string[] }[] = o.history?.length ? [] : [
      { file: `objects/${o.id}/model.glb`, kind: 'mesh', previews: [`objects/${o.id}/preview.png`, `objects/${o.id}/mesh-preview.png`, `objects/${o.id}/mesh-preview.webp`] },
      { file: `objects/${o.id}/model.ply`, kind: 'splat', previews: [`objects/${o.id}/splat-preview.png`, `objects/${o.id}/splat-preview.webp`] },
    ];
    for (const l of legacy) {
      if (known.has(l.file) || mtime(l.file) === null) continue;
      const hit = [...(successes.get(o.name) ?? [])].reverse().find((s) => s.kind === l.kind && s.model);
      if (!hit?.model) {
        notes.push(`${o.name}: found ${l.file} but could not tell which model made it; left unregistered`);
        continue;
      }
      if (assets[hit.model]) continue;
      const job: Ai3dJobRef = { model: hit.model, jobId: hit.jobId, idempotencyKey: `legacy-${hit.jobId ?? o.id}`, status: 'succeeded' };
      assets[hit.model] = {
        model: hit.model,
        kind: l.kind,
        file: l.file,
        previewFile: l.previews.find((p) => mtime(p) !== null),
        alignImage: l.kind === 'mesh' && (hit.model === 'tripo-v31' || hit.model === 'tripo-h31-image'),
        job,
        createdAt: iso(mtime(l.file)),
        source: 'legacy',
      };
      notes.push(`${o.name}: registered the earlier ${hit.model} ${l.kind} (${l.file}${hit.jobId ? `, job ${hit.jobId}` : ''})`);
      changed = true;
    }
    objects.set(o.id, assets);
  }

  // 3. The active surrounding world.
  const worldAssets = { ...(m.worldAssets ?? {}) };
  const w = m.world;
  const wm = w?.job?.model;
  if (w?.splats?.length && (wm === 'worldlabs' || wm === 'worldlabs-draft') && !worldAssets[wm] && w.splats.every((s) => mtime(s.file) !== null)) {
    worldAssets[wm] = { model: wm, job: w.job, splats: w.splats, collider: w.collider, pano: w.pano, thumbnail: w.thumbnail, createdAt: iso(mtime(w.splats[0].file)), source: 'pipeline' };
    changed = true;
  }

  // 4. The active depth maps.
  const depthAssets: NonNullable<WorldManifest['depthAssets']> = { ...(m.depthAssets ?? {}) };
  for (const which of ['original', 'clean'] as const) {
    const d = m.depth[which];
    const dm = (d?.job?.model ?? 'moge2') as DepthModel;
    if (d?.files?.points && mtime(d.files.points) !== null && !depthAssets[dm]?.[which]) {
      depthAssets[dm] = { ...(depthAssets[dm] ?? {}), [which]: d };
      changed = true;
    }
  }
  return { objects, worldAssets, depthAssets, notes, changed };
}

export function mtimeIn(world: { file: (rel: string) => string }) {
  return (rel: string): number | null => {
    try {
      return statSync(world.file(rel)).mtimeMs;
    } catch {
      return null;
    }
  };
}

/** Bring a world's registry up to date (run at server start). Returns notes about what was registered. */
export async function ensureAssetRegistry(world: WorldHandle): Promise<string[]> {
  const plan = planRegistry(world.manifest, world.recentLog(1_000_000), mtimeIn(world));
  if (!plan.changed) return plan.notes;
  // Record which cutout each asset came from (cutouts are made once, so the current one is the source).
  const shas = new Map<string, string>();
  for (const o of world.manifest.objects) {
    if (o.cutout?.file && mtimeIn(world)(o.cutout.file) !== null) shas.set(o.id, await sha256File(world.file(o.cutout.file)));
  }
  await world.update((m) => {
    for (const o of m.objects) {
      const assets = plan.objects.get(o.id);
      if (!assets) continue;
      for (const a of Object.values(assets)) if (a && !a.cutoutSha256 && shas.has(o.id)) a.cutoutSha256 = shas.get(o.id);
      o.assets = assets;
    }
    m.worldAssets = plan.worldAssets;
    m.depthAssets = plan.depthAssets;
  });
  for (const n of plan.notes) world.log(`assets: ${n}`);
  return plan.notes;
}
