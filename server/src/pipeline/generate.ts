// AI3D-backed generation steps: MoGe-2 depth, object splats/meshes (TripoSplat, Tripo), and the World Labs Marble world.
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { downloadArtifact, type Ai3dArtifact, type Ai3dJob } from '../clients/ai3d.ts';
import { optimizeGlb } from '../geometry/glb.ts';
import type { WorldHandle } from '../store.ts';
import type { MeshModel, ObjectRecord, WorldModel } from '../types.ts';
import { errorMessage } from '../util.ts';
import { runAi3dJob } from './jobs.ts';

// ---------- MoGe-2 ----------

const MOGE_FILES = ['points.exr', 'depth.exr', 'mask.png', 'normal.exr'];

export async function runMoge(world: WorldHandle, which: 'original' | 'clean', imageUrl: string): Promise<Record<string, string>> {
  const existing = world.manifest.depth[which];
  if (existing?.files && Object.values(existing.files).every((f) => existsSync(world.file(f)))) return existing.files;
  const job = await runAi3dJob({
    world,
    name: `moge-${which}`,
    label: `MoGe-2 depth (${which === 'original' ? 'photo' : 'clean plate'})`,
    body: { model: 'moge2', image_url: imageUrl, input: { max_size: 800, resolution_level: 'High', apply_mask: true, remove_edges: true } },
    slot: {
      get: () => world.manifest.depth[which]?.job,
      set: (ref) => {
        world.manifest.depth[which] = { ...(world.manifest.depth[which] ?? {}), job: ref };
      },
    },
    timeoutMs: 20 * 60_000,
  });
  const files: Record<string, string> = {};
  for (const name of MOGE_FILES) {
    const art = job.artifacts?.find((a) => a.name === name) ?? job.artifacts?.find((a) => a.name.endsWith(name));
    if (!art) {
      if (name === 'points.exr') throw new Error('MoGe-2 returned no points.exr');
      continue;
    }
    const rel = `depth/${which}/${name}`;
    await downloadArtifact(art, world.file(rel));
    files[name.replace(/\.\w+$/, '')] = rel;
  }
  await world.update((m) => {
    m.depth[which] = { ...(m.depth[which] ?? { job: m.depth[which]!.job }), files } as typeof m.depth.original;
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

export async function runObjectModel(world: WorldHandle, obj: ObjectRecord, model: MeshModel): Promise<void> {
  const spec = OBJECT_MODELS[model];
  if (obj.mesh?.file && obj.mesh.job?.model === model && existsSync(world.file(obj.mesh.file))) return;
  const imageUrl = obj.cutout?.publicUrl;
  if (!imageUrl) throw new Error(`no uploaded cutout for ${obj.name}`);
  const find = () => world.manifest.objects.find((o) => o.id === obj.id)!;
  // Switching models: forget the previous output so a failed job never leaves a mismatched file behind.
  if (obj.mesh?.job?.model && obj.mesh.job.model !== model && obj.mesh.file) {
    world.log(`${obj.name}: replacing the ${obj.mesh.job.model} output with ${model}`);
    await world.update(() => {
      const o = find();
      if (o.mesh) o.mesh = { job: o.mesh.job, alignImage: o.mesh.alignImage };
      o.placement = undefined;
    });
  }
  let alignImage = spec.alignImage && (obj.mesh?.job?.model !== model || (obj.mesh?.alignImage ?? true));

  const attempt = async () =>
    runAi3dJob({
      world,
      // Separate job slots per model family so switching models never reuses another model's job.
      name: `${spec.kind}-${obj.id}`,
      label: `${spec.label}: ${obj.name}`,
      body: { model, image_url: imageUrl, input: spec.input(alignImage) },
      slot: {
        get: () => find().mesh?.job,
        set: (ref) => {
          const o = find();
          o.mesh = { ...(o.mesh ?? { alignImage }), job: ref, alignImage, kind: spec.kind };
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
        const o = find();
        if (o.mesh) o.mesh = { ...o.mesh, alignImage: false, job: { ...o.mesh.job, status: 'failed' } };
      });
      job = await attempt();
    } else {
      throw err;
    }
  }

  const art = pickOutput(job, spec.kind);
  if (!art) throw new Error(`${model} returned no ${spec.kind === 'splat' ? 'splat file' : 'GLB'} for ${obj.name}`);
  let previewRel: string | undefined;
  const preview = job.artifacts?.find((a) => a !== art && (a.role === 'preview' || a.role === 'image' || /\.(png|jpe?g|webp)$/i.test(a.name)));
  if (preview) {
    const ext = (/\.(png|jpe?g|webp)$/i.exec(preview.name)?.[1] ?? 'png').toLowerCase();
    previewRel = `objects/${obj.id}/${spec.kind}-preview.${ext}`;
    await downloadArtifact(preview, world.file(previewRel)).catch(() => (previewRel = undefined));
  }

  let rel: string;
  if (spec.kind === 'splat') {
    const ext = (/\.(ply|spz|splat)$/i.exec(art.name)?.[1] ?? 'ply').toLowerCase();
    rel = `objects/${obj.id}/model.${ext}`;
    await downloadArtifact(art, world.file(rel));
    world.log(`${obj.name}: splat ${(art.size / 1e6).toFixed(1)} MB`);
  } else {
    const rawRel = `objects/${obj.id}/model.raw.glb`;
    rel = `objects/${obj.id}/model.glb`;
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
    o.mesh = { ...o.mesh!, file: rel, previewFile: previewRel, alignImage, kind: spec.kind };
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
  const w = world.manifest.world;
  if (w?.splats?.length && w.splats.every((s) => existsSync(world.file(s.file)))) return;
  const input: Record<string, unknown> = {};
  if (prompt.trim()) input.text_prompt = prompt.trim().slice(0, 2000);
  const job = await runAi3dJob({
    world,
    name: `world-${model}`,
    label: `Marble world (${model === 'worldlabs' ? 'Marble 1.1' : 'Marble draft'})`,
    body: { model, image_url: imageUrl, input },
    slot: {
      get: () => world.manifest.world?.job,
      set: (ref) => {
        world.manifest.world = { ...(world.manifest.world ?? {}), job: ref };
      },
    },
    timeoutMs: 45 * 60_000,
    onStatus: (s) => void world.setStep('world', { message: `Marble job ${s}` }),
  });
  const { splats, collider, pano, thumb } = classifyWorldArtifacts(job);
  if (splats.length === 0) throw new Error('Marble returned no SPZ splats');
  const out: { variant: string; file: string; size: number }[] = [];
  for (const s of splats) {
    const rel = `world/splat-${s.variant.replace(/[^a-z0-9_]/gi, '')}.spz`;
    await downloadArtifact(s.art, world.file(rel));
    out.push({ variant: s.variant, file: rel, size: s.art.size });
  }
  const ext = (a: Ai3dArtifact) => (/\.(\w+)$/.exec(a.name)?.[1] ?? 'bin').toLowerCase();
  let colliderRel: string | undefined, panoRel: string | undefined, thumbRel: string | undefined;
  if (collider) {
    colliderRel = 'world/collider.glb';
    await downloadArtifact(collider, world.file(colliderRel));
  }
  if (pano) {
    panoRel = `world/pano.${ext(pano)}`;
    await downloadArtifact(pano, world.file(panoRel));
  }
  if (thumb) {
    thumbRel = `world/thumbnail.${ext(thumb)}`;
    await downloadArtifact(thumb, world.file(thumbRel));
  }
  await world.update((m) => {
    m.world = { ...(m.world ?? { job: m.world!.job }), splats: out, collider: colliderRel, pano: panoRel, thumbnail: thumbRel } as typeof m.world;
  });
}
