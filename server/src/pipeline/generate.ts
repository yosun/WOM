// AI3D-backed generation steps: MoGe depth, object splats/meshes (IDOL, TripoSplat, Tripo), and the World Labs Marble world.
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { downloadArtifact, type Ai3dArtifact, type Ai3dJob } from '../clients/ai3d.ts';
import { optimizeGlb } from '../geometry/glb.ts';
import type { WorldHandle } from '../store.ts';
import type { DepthEntry, DepthModel, MeshModel, ObjectRecord, WorldModel } from '../types.ts';
import { errorMessage, nowIso } from '../util.ts';
import { activateAsset, activateWorldAsset, objectDir, sha256File, versionSuffix } from './assets.ts';
import { depthFov } from './camera.ts';
import { runAi3dJob } from './jobs.ts';

// ---------- MoGe-2 / MoGe-3 depth ----------

const MOGE_FILES = ['points.exr', 'depth.exr', 'mask.png', 'normal.exr'];

export const DEPTH_MODELS: Record<DepthModel, { label: string; input: Record<string, unknown> }> = {
  moge2: { label: 'MoGe-2', input: { max_size: 800, resolution_level: 'High', apply_mask: true, remove_edges: true } },
  // MoGe-3 (Ruicheng/moge-3-vitg) returns the same EXR maps plus meshes; sky and edges come back as NaN.
  moge3: { label: 'MoGe-3', input: { max_size: 1024, resolution_level: 'High', apply_mask: true, remove_edges: true, refine_steps: 3 } },
};

/** Depth for the photo or the clean plate. Each depth model runs at most once per image and is kept. */
export async function runMoge(world: WorldHandle, which: 'original' | 'clean', imageUrl: string, model: DepthModel = world.manifest.options.depthModel ?? 'moge2'): Promise<Record<string, string>> {
  const spec = DEPTH_MODELS[model];
  const complete = (files?: Record<string, string>) => Boolean(files?.points && Object.values(files).every((f) => existsSync(world.file(f))));
  const have = world.manifest.depthAssets?.[model]?.[which];
  if (have && complete(have.files)) {
    if (world.manifest.depth[which]?.job?.jobId !== have.job.jobId) {
      world.log(`Reusing ${spec.label} depth for the ${which === 'original' ? 'photo' : 'clean plate'} (no new job)`);
      await world.update((m) => { m.depth[which] = have; });
    }
    return have.files!;
  }
  // Worlds from before the registry: the active maps count if they came from this model.
  const active = world.manifest.depth[which];
  if (active && complete(active.files) && (active.job?.model ?? 'moge2') === model) return active.files!;

  const job = await runAi3dJob({
    world,
    name: model === 'moge2' ? `moge-${which}` : `${model}-${which}`,
    label: `${spec.label} depth (${which === 'original' ? 'photo' : 'clean plate'})`,
    body: { model, image_url: imageUrl, input: spec.input },
    slot: {
      get: () => world.manifest.depthAssets?.[model]?.[which]?.job,
      set: (ref) => {
        const m = world.manifest;
        m.depthAssets ??= {};
        m.depthAssets[model] ??= {};
        m.depthAssets[model]![which] = { ...(m.depthAssets[model]![which] ?? {}), job: ref };
      },
    },
    timeoutMs: 20 * 60_000,
  });
  const files: Record<string, string> = {};
  const dir = model === 'moge2' ? `depth/${which}` : `depth/${model}/${which}`;
  for (const name of MOGE_FILES) {
    const art = job.artifacts?.find((a) => a.name === name) ?? job.artifacts?.find((a) => a.name.endsWith(name));
    if (!art) {
      if (name === 'points.exr') throw new Error(`${spec.label} returned no points.exr`);
      continue;
    }
    const rel = `${dir}/${name}`;
    await downloadArtifact(art, world.file(rel));
    files[name.replace(/\.\w+$/, '')] = rel;
  }
  // The field of view the point map implies, to compare depth models with the lens in EXIF.
  const hfovDeg = await depthFov(world, { files } as DepthEntry).catch(() => undefined);
  if (which === 'original' && hfovDeg && world.manifest.image.camera?.hfovDeg) {
    world.log(`${spec.label} field of view ${hfovDeg.toFixed(1)}°; the lens says ${world.manifest.image.camera.hfovDeg.toFixed(1)}°`);
  }
  await world.update((m) => {
    const entry = { ...m.depthAssets![model]![which]!, files, ...(hfovDeg ? { hfovDeg } : {}) };
    m.depthAssets![model]![which] = entry;
    m.depth[which] = entry;
  });
  return files;
}

// ---------- Objects (TripoSplat splats or Tripo meshes) ----------

export interface ObjectModelSpec {
  kind: 'splat' | 'mesh';
  label: string;
  /** How the output is oriented relative to the input image (see geometry/fit.ts). */
  frame: 'camera' | 'tripo-mesh';
  /** Accepts orientation=align_image (Tripo meshes). */
  alignImage: boolean;
  input: (alignImage: boolean) => Record<string, unknown>;
}

export const OBJECT_MODELS: Record<MeshModel, ObjectModelSpec> = {
  // Speridlabs Idol on a Hugging Face Space: background removal, framing, then up to 1M Gaussians ($0.10).
  // "Synthetic" frames the object at 1/1.2 of the crop (more pixels on the object); our cutouts are already isolated.
  idol: {
    kind: 'splat',
    label: 'IDOL splat',
    frame: 'camera',
    alignImage: false,
    input: () => ({ mode: 'Synthetic', gaussians: '262,144' }),
  },
  triposplat: {
    kind: 'splat',
    label: 'TripoSplat splat',
    frame: 'camera',
    alignImage: false,
    input: () => ({ output_format: 'ply' }),
  },
  'tripo-v31': {
    kind: 'mesh',
    label: 'Tripo H3.1 mesh',
    frame: 'tripo-mesh',
    alignImage: true,
    input: (align) => ({
      texture: true,
      pbr: true,
      texture_alignment: 'original_image',
      texture_quality: 'standard',
      face_limit: 150000,
      ...(align ? { orientation: 'align_image' } : {}),
    }),
  },
  // fal's Tripo P1 endpoint takes only face_limit, texture and model_seed.
  'tripo-p1': { kind: 'mesh', label: 'Tripo P1 mesh', frame: 'tripo-mesh', alignImage: false, input: () => ({ texture: true, face_limit: 12000 }) },
  'tripo-h31-image': {
    kind: 'mesh',
    label: 'Tripo H3.1 mesh',
    frame: 'tripo-mesh',
    alignImage: true,
    input: (align) => ({ texture: true, pbr: true, face_limit: 150000, ...(align ? { orientation: 'align_image' } : {}) }),
  },
  'tripo-p1-image': { kind: 'mesh', label: 'Tripo P1 mesh', frame: 'tripo-mesh', alignImage: true, input: (align) => ({ texture: true, pbr: true, face_limit: 12000, ...(align ? { orientation: 'align_image' } : {}) }) },
};

function pickOutput(job: Ai3dJob, kind: 'splat' | 'mesh'): Ai3dArtifact | undefined {
  const arts = job.artifacts ?? [];
  if (kind === 'splat') {
    return arts.find((a) => /\.(ply|spz|splat)$/i.test(a.name) && (a.role === 'splat' || a.role === 'mesh' || !a.role)) ?? arts.find((a) => /\.(ply|spz|splat)$/i.test(a.name));
  }
  return arts.find((a) => a.role === 'mesh' && /\.glb$/i.test(a.name)) ?? arts.find((a) => /\.glb$/i.test(a.name)) ?? arts.find((a) => a.role === 'mesh');
}

/**
 * Generate (or reuse) `model`'s asset for one object's current cutout. `activate: false` only adds it to
 * the registry, e.g. to compare models without changing what the world shows.
 */
export async function runObjectModel(world: WorldHandle, obj: ObjectRecord, model: MeshModel, opts: { activate?: boolean } = {}): Promise<void> {
  const activate = opts.activate ?? true;
  const spec = OBJECT_MODELS[model];
  const find = () => world.manifest.objects.find((o) => o.id === obj.id)!;
  // Every model's output is kept, so each model is generated at most once per object (and mask version).
  const have = find().assets?.[model];
  if (have?.file && existsSync(world.file(have.file))) {
    if (activate && find().mesh?.file !== have.file) {
      world.log(`${obj.name}: reusing the ${model} ${spec.kind} from ${have.createdAt.slice(0, 10)} (no new job)`);
      await world.update(() => activateAsset(find(), have));
    }
    return;
  }
  const imageUrl = obj.cutout?.publicUrl;
  if (!imageUrl) throw new Error(`no uploaded cutout for ${obj.name}`);
  const cutoutSha256 = obj.cutout?.file && existsSync(world.file(obj.cutout.file)) ? await sha256File(world.file(obj.cutout.file)) : undefined;
  let alignImage = spec.alignImage && (have?.alignImage ?? true);

  const attempt = async () =>
    runAi3dJob({
      world,
      // One job slot per model and mask version, so a job is never reused across models or masks.
      name: `${model}-${obj.id}${versionSuffix(find())}`,
      label: `${spec.label}: ${obj.name}`,
      body: { model, image_url: imageUrl, input: spec.input(alignImage) },
      slot: {
        get: () => find().assets?.[model]?.job,
        set: (ref) => {
          const o = find();
          o.assets ??= {};
          const prev = o.assets[model];
          o.assets[model] = {
            ...(prev ?? { model, kind: spec.kind, createdAt: nowIso(), source: 'pipeline' as const }),
            job: ref,
            alignImage,
            cutoutSha256,
          };
        },
      },
      timeoutMs: 30 * 60_000,
    });

  let job: Ai3dJob;
  try {
    job = await attempt();
  } catch (err) {
    const msg = errorMessage(err);
    // If the provider rejects the orientation option, try once more with defaults (placement then searches all yaws).
    if (alignImage && /orientation|422|1004|invalid/i.test(msg)) {
      world.log(`${model} rejected orientation=align_image for ${obj.name}; retrying with default orientation`);
      alignImage = false;
      await world.update(() => {
        const a = find().assets?.[model];
        if (a) Object.assign(a, { alignImage: false, job: { ...a.job, status: 'failed' } });
      });
      job = await attempt();
    } else {
      throw err;
    }
  }

  const art = pickOutput(job, spec.kind);
  if (!art) throw new Error(`${model} returned no ${spec.kind === 'splat' ? 'splat file' : 'GLB'} for ${obj.name}`);
  // Each model writes into its own folder, so outputs of different models never overwrite each other.
  const dir = `${objectDir(find())}/${model}`;
  let previewRel: string | undefined;
  const preview = job.artifacts?.find((a) => a !== art && (a.role === 'preview' || a.role === 'image' || /\.(png|jpe?g|webp)$/i.test(a.name)));
  if (preview) {
    const ext = (/\.(png|jpe?g|webp)$/i.exec(preview.name)?.[1] ?? 'png').toLowerCase();
    previewRel = `${dir}/preview.${ext}`;
    await downloadArtifact(preview, world.file(previewRel)).catch(() => (previewRel = undefined));
  }

  let rel: string;
  if (spec.kind === 'splat') {
    const ext = (/\.(ply|spz|splat)$/i.exec(art.name)?.[1] ?? 'ply').toLowerCase();
    rel = `${dir}/model.${ext}`;
    await downloadArtifact(art, world.file(rel));
    world.log(`${obj.name}: splat ${(art.size / 1e6).toFixed(1)} MB`);
  } else {
    const rawRel = `${dir}/model.raw.glb`;
    rel = `${dir}/model.glb`;
    await downloadArtifact(art, world.file(rawRel));
    try {
      const before = (await stat(world.file(rawRel))).size;
      const after = await optimizeGlb(world.file(rawRel), world.file(rel), 2048);
      world.log(`${obj.name}: mesh ${(before / 1e6).toFixed(1)} MB → ${(after / 1e6).toFixed(1)} MB after texture compression`);
      await rm(world.file(rawRel), { force: true });
    } catch (err) {
      world.log(`${obj.name}: GLB optimization failed (${errorMessage(err)}); serving the original file`);
      const { rename } = await import('node:fs/promises');
      await rename(world.file(rawRel), world.file(rel));
    }
  }
  await world.update(() => {
    const o = find();
    const asset = { ...o.assets![model]!, file: rel, previewFile: previewRel, alignImage, kind: spec.kind };
    o.assets![model] = asset;
    if (activate) activateAsset(o, asset);
  });
}

// ---------- World Labs Marble ----------

function classifyWorldArtifacts(job: Ai3dJob) {
  const arts = job.artifacts ?? [];
  const spz = arts.filter((a) => a.role === 'splat' || /\.spz$/i.test(a.name));
  // Name the splat variants; older jobs carry no variant, so rank by size (100k < 500k < full_res).
  const sorted = [...spz].sort((a, b) => a.size - b.size);
  const names = ['100k', '500k', 'full_res'];
  const splats = sorted.map((a, i) => ({ art: a, variant: a.variant ?? (sorted.length === 3 ? names[i] : i === sorted.length - 1 ? 'full_res' : names[i]) }));
  const collider = arts.find((a) => a.role === 'collider') ?? arts.find((a) => /\.glb$/i.test(a.name));
  const pano = arts.find((a) => a.role === 'pano');
  const thumb = arts.find((a) => a.role === 'thumbnail') ?? (pano ? undefined : arts.find((a) => /\.(webp|jpe?g|png)$/i.test(a.name)));
  return { splats, collider, pano, thumb };
}

export async function runWorldGen(world: WorldHandle, model: Exclude<WorldModel, 'none'>, imageUrl: string, prompt: string) {
  const complete = (s?: { file: string }[]) => Boolean(s?.length && s.every((x) => existsSync(world.file(x.file))));
  // Each world model is generated at most once per photo; switching back reuses the earlier world.
  const have = world.manifest.worldAssets?.[model];
  if (have && complete(have.splats)) {
    if (world.manifest.world?.job?.jobId !== have.job.jobId) {
      world.log(`Reusing the ${model} world from ${have.createdAt.slice(0, 10)} (no new job)`);
      await world.update((m) => activateWorldAsset(m, have));
    }
    return;
  }
  // Worlds from before the registry: the active world counts if it came from this model.
  const w = world.manifest.world;
  if (complete(w?.splats) && (w?.job?.model ?? model) === model) return;
  const input: Record<string, unknown> = {};
  if (prompt.trim()) input.text_prompt = prompt.trim().slice(0, 2000);
  const job = await runAi3dJob({
    world,
    name: `world-${model}`,
    label: `Marble world (${model === 'worldlabs' ? 'Marble 1.1' : 'Marble draft'})`,
    body: { model, image_url: imageUrl, input },
    slot: {
      get: () => world.manifest.worldAssets?.[model]?.job,
      set: (ref) => {
        const m = world.manifest;
        m.worldAssets ??= {};
        m.worldAssets[model] = { ...(m.worldAssets[model] ?? { model, createdAt: nowIso(), source: 'pipeline' as const }), job: ref };
      },
    },
    timeoutMs: 45 * 60_000,
    onStatus: (s) => void world.setStep('world', { message: `Marble job ${s}` }),
  });
  const { splats, collider, pano, thumb } = classifyWorldArtifacts(job);
  if (splats.length === 0) throw new Error('Marble returned no SPZ splats');
  const dir = `world/${model}`;
  const out: { variant: string; file: string; size: number }[] = [];
  for (const s of splats) {
    const rel = `${dir}/splat-${s.variant.replace(/[^a-z0-9_]/gi, '')}.spz`;
    await downloadArtifact(s.art, world.file(rel));
    out.push({ variant: s.variant, file: rel, size: s.art.size });
  }
  const ext = (a: Ai3dArtifact) => (/\.(\w+)$/.exec(a.name)?.[1] ?? 'bin').toLowerCase();
  let colliderRel: string | undefined, panoRel: string | undefined, thumbRel: string | undefined;
  if (collider) {
    colliderRel = `${dir}/collider.glb`;
    await downloadArtifact(collider, world.file(colliderRel));
  }
  if (pano) {
    panoRel = `${dir}/pano.${ext(pano)}`;
    await downloadArtifact(pano, world.file(panoRel));
  }
  if (thumb) {
    thumbRel = `${dir}/thumbnail.${ext(thumb)}`;
    await downloadArtifact(thumb, world.file(thumbRel));
  }
  await world.update((m) => {
    const asset = { ...m.worldAssets![model]!, splats: out, collider: colliderRel, pano: panoRel, thumbnail: thumbRel };
    m.worldAssets![model] = asset;
    activateWorldAsset(m, asset);
  });
}
