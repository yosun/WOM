// Redo one object's mask. SAM 3.1 runs on the user's points (and optional box); when the user keeps the
// result, only that object's cutout, 3D asset and placements are made again. Everything else in the world
// (plan, clean plate, depth, Marble world, other objects) is reused. The replaced mask, its cutout and
// every asset made from it move to the object's `history`, so going back costs nothing.
import { existsSync } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { buildObjectPrompt } from '@meta-sam/parser';
import { SAM_IMAGE_PRICE_USD, samSegment, toDataUrl } from '../clients/meta.ts';
import { cleanComponents, maskArea, maskBox, maskFromPng, maskToPng, type Mask } from '../geometry/mask.ts';
import type { WorldHandle } from '../store.ts';
import type { Box, ObjectRecord, ObjectVersion } from '../types.ts';
import { nowIso, writeFileAtomic } from '../util.ts';
import { activateAsset, objectDir } from './assets.ts';
import { parseSamOutput } from './segment.ts';

/** Points and box in source-image pixels. `positive: false` marks something that is not the object. */
export interface MaskPrompt {
  points: { x: number; y: number; positive: boolean }[];
  box?: Box;
}

export interface MaskDraft {
  file: string;
  box: Box;
  area: number;
  /** Share of the image the mask covers. */
  coverage: number;
  costUsd: number;
}

const draftFile = (o: { id: string }) => `objects/${o.id}/mask-draft.png`;

function objectRecord(world: WorldHandle, id: string): ObjectRecord {
  const o = world.manifest.objects.find((x) => x.id === id);
  if (!o) throw new MaskError(404, `unknown object ${id}`);
  return o;
}

export class MaskError extends Error {
  status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** Check and clamp a prompt from the browser against the image size. */
export function parseMaskPrompt(raw: unknown, width: number, height: number): MaskPrompt {
  const body = (raw ?? {}) as { points?: unknown; box?: unknown };
  const inside = (x: unknown, y: unknown) => typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < width && y < height;
  const points: MaskPrompt['points'] = [];
  for (const p of Array.isArray(body.points) ? body.points.slice(0, 24) : []) {
    const q = p as { x?: unknown; y?: unknown; positive?: unknown };
    if (!inside(q.x, q.y)) throw new MaskError(400, 'every point must lie inside the photo');
    points.push({ x: Math.floor(q.x as number), y: Math.floor(q.y as number), positive: q.positive !== false });
  }
  let box: Box | undefined;
  if (body.box) {
    const b = body.box as Partial<Box>;
    const x0 = Math.max(0, Math.floor(Math.min(b.x0 ?? NaN, b.x1 ?? NaN))), x1 = Math.min(width, Math.ceil(Math.max(b.x0 ?? NaN, b.x1 ?? NaN)));
    const y0 = Math.max(0, Math.floor(Math.min(b.y0 ?? NaN, b.y1 ?? NaN))), y1 = Math.min(height, Math.ceil(Math.max(b.y0 ?? NaN, b.y1 ?? NaN)));
    if (![x0, x1, y0, y1].every(Number.isFinite) || x1 - x0 < 4 || y1 - y0 < 4) throw new MaskError(400, 'the box is too small or outside the photo');
    box = { x0, y0, x1, y1 };
  }
  if (!points.some((p) => p.positive) && !box) throw new MaskError(400, 'click at least one point on the object, or draw a box around it');
  return { points, box };
}

/** Run SAM 3.1 on the prompt and keep the result as the object's draft mask (the world is not changed). */
export async function previewMask(world: WorldHandle, objectId: string, prompt: MaskPrompt): Promise<MaskDraft> {
  const o = objectRecord(world, objectId);
  const { width, height } = world.manifest.image;
  const text = buildObjectPrompt({
    size: { width, height },
    objects: [{
      id: 1,
      prompts: [{
        ...(prompt.box ? { box: { left: prompt.box.x0, top: prompt.box.y0, right: prompt.box.x1, bottom: prompt.box.y1 } } : {}),
        points: prompt.points.map((p) => ({ x: p.x, y: p.y, label: p.positive ? 'positive' as const : 'negative' as const })),
      }],
    }],
  });
  const jpeg = await readFile(world.file(world.manifest.image.file));
  const instances = parseSamOutput(await samSegment(toDataUrl(jpeg, 'image/jpeg'), text), width, height);
  await world.addCost({ label: `SAM 3.1 mask redo: ${o.name}`, usd: SAM_IMAGE_PRICE_USD, provider: 'meta', estimated: false });
  const best = instances.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  if (!best) throw new MaskError(409, 'SAM 3.1 found nothing there; try points on a clearer part of the object');
  // Drop stray specks away from what the user marked.
  const marks = prompt.box ?? boxAround(prompt.points.filter((p) => p.positive), best.box);
  const mask: Mask = cleanComponents(best.mask, marks);
  const box = maskBox(mask);
  if (!box) throw new MaskError(409, 'SAM 3.1 returned an empty mask');
  const area = maskArea(mask);
  const file = draftFile(o);
  await writeFileAtomic(world.file(file), await maskToPng(mask));
  world.log(`${o.name}: draft mask from ${prompt.points.length} point(s)${prompt.box ? ' and a box' : ''} (${(100 * area / (width * height)).toFixed(1)}% of the photo)`);
  return { file, box, area, coverage: area / (width * height), costUsd: SAM_IMAGE_PRICE_USD };
}

function boxAround(points: { x: number; y: number }[], fallback: Box): Box {
  if (!points.length) return fallback;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const pad = 0.15 * Math.max(fallback.x1 - fallback.x0, fallback.y1 - fallback.y0);
  return {
    x0: Math.min(...xs, fallback.x0) - pad,
    y0: Math.min(...ys, fallback.y0) - pad,
    x1: Math.max(...xs, fallback.x1) + pad,
    y1: Math.max(...ys, fallback.y1) + pad,
  };
}

/** The object's current mask with everything made from it, as a history entry. */
function snapshot(o: ObjectRecord): ObjectVersion {
  return { maskVersion: o.maskVersion ?? 1, mask: o.mask, cutout: o.cutout, mesh: o.mesh, assets: o.assets, aligned: o.aligned, replacedAt: nowIso() };
}

/** Steps that must run again after an object's mask changed. */
function markForRebuild(world: WorldHandle, steps: ('cutouts' | 'meshes')[]) {
  return world.update((m) => {
    for (const s of [...steps, 'compose', 'placements'] as const) {
      if (m.steps[s]) { m.steps[s].status = 'pending'; m.steps[s].error = undefined; }
    }
    if (m.status === 'done' || m.status === 'partial') m.status = 'queued';
  });
}

/**
 * Make the draft the object's mask. The cutout, the active model's asset and the placements are then
 * rebuilt for this object only (the caller starts the pipeline).
 */
export async function applyDraftMask(world: WorldHandle, objectId: string): Promise<void> {
  const o = objectRecord(world, objectId);
  const draft = draftFile(o);
  if (!existsSync(world.file(draft))) throw new MaskError(409, 'preview a mask first');
  const mask = await maskFromPng(world.file(draft));
  const box = maskBox(mask);
  if (!box) throw new MaskError(409, 'the draft mask is empty');
  const version = (o.maskVersion ?? 1) + 1;
  const file = `${objectDir({ id: o.id, maskVersion: version })}/mask.png`;
  await copyFile(world.file(draft), world.file(file)).catch(async () => {
    await writeFileAtomic(world.file(file), await readFile(world.file(draft)));
  });
  await rm(world.file(draft), { force: true });
  const { width, height } = world.manifest.image;
  await world.update((m) => {
    const rec = m.objects.find((x) => x.id === objectId)!;
    rec.history = [...(rec.history ?? []), snapshot(rec)];
    rec.maskVersion = version;
    rec.mask = { file, box, area: maskArea(mask), method: 'manual' };
    rec.cutout = undefined;
    rec.mesh = undefined;
    rec.assets = undefined;
    rec.aligned = undefined;
    // A new mask means new assets; the object follows the world's model again.
    rec.pinnedModel = undefined;
    rec.placement = undefined;
    rec.status = 'pending';
    rec.error = undefined;
    // Keep the plan's box in step with the mask (the build page draws it over the photo).
    const planned = m.plan?.objects.find((p) => p.id === objectId);
    if (planned) {
      planned.box = { x0: Math.floor((box.x0 / width) * 1000), y0: Math.floor((box.y0 / height) * 1000), x1: Math.ceil((box.x1 / width) * 1000), y1: Math.ceil((box.y1 / height) * 1000) };
    }
  });
  world.log(`${o.name}: mask v${version} kept (v${version - 1} and its assets are in the object's history); rebuilding this object`);
  await markForRebuild(world, ['cutouts', 'meshes']);
}

/** Bring back an earlier mask with its cutout and assets (the current one moves to history). */
export async function restoreMask(world: WorldHandle, objectId: string, version: number): Promise<void> {
  const o = objectRecord(world, objectId);
  const entry = o.history?.find((v) => v.maskVersion === version);
  if (!entry) throw new MaskError(404, `no mask version ${version} for ${o.name}`);
  if (!entry.mask || !entry.cutout) throw new MaskError(409, `mask version ${version} has no cutout to restore`);
  const { width, height } = world.manifest.image;
  await world.update((m) => {
    const rec = m.objects.find((x) => x.id === objectId)!;
    const current = snapshot(rec);
    rec.history = [...(rec.history ?? []).filter((v) => v.maskVersion !== version), ...(rec.mask ? [current] : [])];
    rec.maskVersion = entry.maskVersion;
    rec.mask = entry.mask;
    rec.cutout = entry.cutout;
    rec.assets = entry.assets;
    rec.pinnedModel = undefined;
    rec.mesh = entry.mesh;
    rec.placement = undefined;
    // Show the world's current object model if this version has it.
    const wanted = entry.assets?.[m.options.meshModel];
    if (wanted?.file) activateAsset(rec, wanted);
    rec.status = 'pending';
    rec.error = undefined;
    const planned = m.plan?.objects.find((p) => p.id === objectId);
    const b = entry.mask!.box;
    if (planned) planned.box = { x0: Math.floor((b.x0 / width) * 1000), y0: Math.floor((b.y0 / height) * 1000), x1: Math.ceil((b.x1 / width) * 1000), y1: Math.ceil((b.y1 / height) * 1000) };
  });
  world.log(`${o.name}: restored mask v${version}`);
  await markForRebuild(world, ['meshes']);
}
