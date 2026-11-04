// Observations: problems that people or agents flag while walking a world. A flag is a frame plus the
// exact state that drew it (camera, layers, every object's asset and transform) and what the viewer could
// measure at the marked spot (rays through it, the splats near it, frames with one layer hidden).
// The asset check opens flags too (flagAssetCheck): their frame is the turntable it saw, with no camera.
//
// Stored under data/bench/observations/<world>/<id>/ so they sit with the other benchmark material:
//   observation.json   the record (ObservationRecord)
//   frame.jpg          what the viewer showed (frame.png in flags saved before frames were compressed)
//   thumb.jpg, tiny.jpg  640 and 160 px wide, for lists; made on first request for flags that predate them
//   all.jpg            the same frame at the size of the layer frames below
//   without-<layer>.jpg  the frame with that layer hidden (only for layers the rays reached)
//
// The viewer reports facts. The server decides the suspect layer, so there is one rule for it and the
// same rule applies to flags posted by an agent.
//
// People flag what they see, so one problem arrives many times from different spots. listIssues groups
// flags that mark the same place on the same layer into one issue, which is what the Observations page lists.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR } from '../config.ts';
import type { WorldHandle } from '../store.ts';
import {
  OBSERVATION_CATEGORIES,
  OBSERVATION_STATUSES,
  PLACEMENT_METHODS,
  type AppliedFix,
  type ObservationAssetCheck,
  type ObservationCategory,
  type ObservationCreated,
  type ObservationIssue,
  type ObservationIssuePage,
  type ObservationMark,
  type ObservationObjectState,
  type ObservationRay,
  type ObservationRecord,
  type ObservationSplats,
  type ObservationStatus,
  type ObservationSummary,
} from '../types.ts';
import { nowIso, writeFileAtomic } from '../util.ts';

export const OBSERVATIONS_DIR = path.join(DATA_DIR, 'bench', 'observations');

const MAX_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_LAYER_FRAME_BYTES = 3 * 1024 * 1024;
const MAX_RAYS = 64;
const MAX_HITS_PER_RAY = 12;
/** A frame is a photographic render, so a JPEG is about a seventh of its PNG with no visible loss (mean error 1.7 of 255). */
const FRAME_JPEG_QUALITY = 92;
/**
 * The two small pictures a list needs: `thumb.jpg` is what a card shows (about as wide as the card, 50 KB),
 * `tiny.jpg` is a tile in the strip of other sightings (5 KB). The full frame opens on a click.
 */
const THUMBS = {
  'thumb.jpg': { width: 640, quality: 78 },
  'tiny.jpg': { width: 160, quality: 70 },
} as const;
export type ThumbName = keyof typeof THUMBS;
export const isThumbName = (name: string): name is ThumbName => name in THUMBS;
/** Sightings listed with an issue; its other flags are still counted and can be changed together. */
const SIGHTINGS_SHOWN = 12;

export class ObservationError extends Error {
  status: 400 | 402 | 404 | 409 | 413;
  constructor(status: 400 | 402 | 404 | 409 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(message: string, status: 400 | 404 | 413 = 400): never {
  throw new ObservationError(status, message);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function nums(v: unknown, n: number, what: string): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every(isNum)) fail(`${what} must be ${n} numbers`);
  return v as number[];
}

function numIn(v: unknown, lo: number, hi: number, what: string): number {
  if (!isNum(v) || v < lo || v > hi) fail(`${what} must be a number from ${lo} to ${hi}`);
  return v;
}

function text(v: unknown, max: number, what: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') fail(`${what} must be text`);
  return v.trim().slice(0, max) || undefined;
}

export const isObservationId = (id: string) => /^o[a-z0-9]{6,24}$/.test(id);

function newObservationId() {
  return `o${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/** `world`, `relief`, or `object:<id>` for an object the world has. */
function layerOk(layer: unknown, objectIds: Set<string>): layer is string {
  return typeof layer === 'string' && (layer === 'world' || layer === 'relief' || (layer.startsWith('object:') && objectIds.has(layer.slice('object:'.length))));
}

const layerSlug = (layer: string) => layer.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

export function observationDir(worldId: string, id: string) {
  return path.join(OBSERVATIONS_DIR, worldId, id);
}

/** Only the files an observation writes can be served. */
export function observationFilePath(worldId: string, id: string, name: string): string | null {
  if (!isObservationId(id) || !/^(frame\.(png|jpg)|thumb\.jpg|tiny\.jpg|after-[a-f0-9]{8}\.jpg|all\.(jpg|png)|without-[a-z0-9-]+\.(jpg|png))$/.test(name)) return null;
  return path.join(observationDir(worldId, id), name);
}

// ---------- deciding the suspect ----------

/** The share of rays whose nearest hit is each layer (rays that hit nothing are not counted), largest first. */
export function tally(rays: ObservationRay[]): { layer: string; share: number }[] {
  const counts = new Map<string, number>();
  let n = 0;
  for (const ray of rays) {
    let best: ObservationRay['hits'][number] | undefined;
    for (const h of ray.hits) if (!best || h.distance < best.distance) best = h;
    if (!best) continue;
    n++;
    counts.set(best.layer, (counts.get(best.layer) ?? 0) + 1);
  }
  return [...counts].map(([layer, c]) => ({ layer, share: c / n })).sort((a, b) => b.share - a.share);
}

/**
 * The layer a problem is in. The surface the viewer sees at the marked spot is the nearest hit of the
 * rays, so most nearest hits in one layer decide it (at least 40%). Without that, the author's hint, then
 * the object whose removal changes the marked region most (at least 10% of its pixels), then the world:
 * the background behind everything.
 */
export function chooseSuspect(votes: { layer: string; share: number }[], ablation: { layer: string; changedShare: number }[], hint: string | undefined): { suspect: string | null; source: ObservationRecord['suspectSource'] } {
  if (votes[0] && votes[0].share >= 0.4) return { suspect: votes[0].layer, source: 'ray' };
  if (hint) return { suspect: hint, source: 'author' };
  const others = ablation.filter((a) => a.layer !== 'world').sort((a, b) => b.changedShare - a.changedShare);
  if (others[0] && others[0].changedShare >= 0.1) return { suspect: others[0].layer, source: 'ablation' };
  if (ablation.some((a) => a.layer === 'world')) return { suspect: 'world', source: 'ablation' };
  return { suspect: votes[0]?.layer ?? null, source: votes[0] ? 'ray' : null };
}

// ---------- images ----------

async function decode(buf: Buffer, what: string) {
  try {
    const meta = await sharp(buf).metadata();
    if ((meta.format !== 'png' && meta.format !== 'jpeg') || !meta.width || !meta.height || meta.width > 8192 || meta.height > 8192) fail(`${what} must be a PNG or JPEG image`);
    return { format: meta.format, width: meta.width, height: meta.height };
  } catch (err) {
    if (err instanceof ObservationError) throw err;
    return fail(`${what} could not be read as an image`);
  }
}

const makeThumbnail = (input: Buffer | string, name: ThumbName) =>
  sharp(input).removeAlpha().resize({ width: THUMBS[name].width, withoutEnlargement: true }).jpeg({ quality: THUMBS[name].quality, mozjpeg: true }).toBuffer();

/** Save a frame as frame.jpg with its two small pictures beside it. A PNG is compressed once; a JPEG is kept as it came. */
async function writeFrame(dir: string, bytes: Buffer, format: 'png' | 'jpeg'): Promise<{ frame: string; thumb: string; tiny: string }> {
  const jpeg = format === 'jpeg' ? bytes : await sharp(bytes).removeAlpha().jpeg({ quality: FRAME_JPEG_QUALITY, mozjpeg: true }).toBuffer();
  await writeFileAtomic(path.join(dir, 'frame.jpg'), jpeg);
  for (const name of Object.keys(THUMBS) as ThumbName[]) await writeFileAtomic(path.join(dir, name), await makeThumbnail(bytes, name));
  return { frame: 'frame.jpg', thumb: 'thumb.jpg', tiny: 'tiny.jpg' };
}

/**
 * Make one of a flag's small pictures from its frame if it has none (flags saved before they existed), so a
 * list never has to load full frames. Nothing else about the flag changes.
 */
export async function ensureThumbnail(worldId: string, id: string, name: ThumbName = 'thumb.jpg'): Promise<void> {
  if (!isObservationId(id)) return;
  const dir = observationDir(worldId, id);
  const target = path.join(dir, name);
  if (existsSync(target)) return;
  const rec = await readRecord(worldId, id);
  const frameFile = rec && path.join(dir, rec.files.frame);
  if (!frameFile || !existsSync(frameFile)) return;
  await writeFileAtomic(target, await makeThumbnail(frameFile, name));
}

/** Share of the region's pixels that differ visibly between two frames of the same size. */
async function regionChange(a: Buffer, b: Buffer, region: [number, number, number, number], frame: { width: number; height: number }): Promise<number> {
  const [ra, rb] = await Promise.all([a, b].map((x) => sharp(x).removeAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) fail('the layer frames must all have the same size');
  const W = ra.info.width, H = ra.info.height;
  const sx = W / frame.width, sy = H / frame.height;
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(region[0] * sx))), y0 = Math.max(0, Math.min(H - 1, Math.floor(region[1] * sy)));
  const x1 = Math.max(x0 + 1, Math.min(W, Math.ceil(region[2] * sx))), y1 = Math.max(y0 + 1, Math.min(H, Math.ceil(region[3] * sy)));
  let changed = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 3;
      const d = (Math.abs(ra.data[i] - rb.data[i]) + Math.abs(ra.data[i + 1] - rb.data[i + 1]) + Math.abs(ra.data[i + 2] - rb.data[i + 2])) / 3;
      if (d > 24) changed++;
      n++;
    }
  }
  return n ? changed / n : 0;
}

// ---------- reading what a client sent ----------

function parseObjectState(raw: unknown, world: WorldHandle): ObservationObjectState[] {
  if (!Array.isArray(raw) || raw.length > 32) fail('scene.objects must be a list of at most 32 objects');
  const known = new Map(world.manifest.objects.map((o) => [o.id, o]));
  const prefix = `/files/${world.id}/`;
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    const rec = known.get(id);
    if (!rec) fail(`scene.objects[${i}] is not an object of this world`);
    const url = text(o.url, 300, 'object url') ?? '';
    if (!url.startsWith(prefix)) fail(`scene.objects[${i}].url must point into this world`);
    const t = (o.transform ?? {}) as Record<string, unknown>;
    // The model and mask version are in the asset's path: objects/<id>[/m<n>]/<model>/model.<ext>.
    const rel = url.slice(prefix.length);
    const byFile = Object.values(rec.assets ?? {}).find((a) => a?.file === rel);
    const m = /^objects\/[^/]+\/(?:m(\d+)\/)?([a-z0-9-]+)\/model\.[a-z]+$/.exec(rel);
    return {
      id,
      visible: o.visible !== false,
      url,
      asset: byFile?.model ?? m?.[2],
      maskVersion: m ? (m[1] ? Number(m[1]) : 1) : rec.maskVersion ?? 1,
      transform: {
        position: nums((t as { position?: unknown }).position, 3, 'object position') as [number, number, number],
        quaternion: nums((t as { quaternion?: unknown }).quaternion, 4, 'object quaternion') as [number, number, number, number],
        scale: numIn(t.scale, 1e-6, 1e6, 'object scale'),
      },
    };
  });
}

function parseRays(raw: unknown, objectIds: Set<string>, frame: { width: number; height: number }): ObservationRay[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RAYS) fail(`rays must be a list of at most ${MAX_RAYS}`);
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const px = nums(o.px, 2, `rays[${i}].px`) as [number, number];
    if (!Array.isArray(o.hits) || o.hits.length > MAX_HITS_PER_RAY) fail(`rays[${i}].hits must be a list of at most ${MAX_HITS_PER_RAY}`);
    return {
      px: [Math.max(0, Math.min(frame.width, px[0])), Math.max(0, Math.min(frame.height, px[1]))],
      hits: o.hits.map((h, j) => {
        const hit = (h ?? {}) as Record<string, unknown>;
        if (!layerOk(hit.layer, objectIds)) fail(`rays[${i}].hits[${j}].layer is not a layer of this world`);
        return { layer: hit.layer, distance: numIn(hit.distance, 0, 1e6, 'hit distance'), point: nums(hit.point, 3, 'hit point') as [number, number, number] };
      }),
    };
  });
}

function parseMark(raw: unknown, frame: { width: number; height: number }): ObservationMark {
  const o = (raw ?? {}) as Record<string, unknown>;
  const clampX = (v: number) => Math.max(0, Math.min(frame.width, v));
  const clampY = (v: number) => Math.max(0, Math.min(frame.height, v));
  if (o.kind === 'point') {
    const [x, y] = nums(o.px, 2, 'mark.px');
    return { kind: 'point', px: [clampX(x), clampY(y)] };
  }
  if (o.kind === 'box') {
    const [a, b, c, d] = nums(o.px, 4, 'mark.px');
    const x0 = clampX(Math.min(a, c)), x1 = clampX(Math.max(a, c)), y0 = clampY(Math.min(b, d)), y1 = clampY(Math.max(b, d));
    if (x1 - x0 < 2 || y1 - y0 < 2) fail('the marked box is too small');
    return { kind: 'box', px: [x0, y0, x1, y1] };
  }
  return fail('mark must be a point or a box');
}

function parseSplats(raw: unknown, objectIds: Set<string>): ObservationSplats | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = raw as Record<string, unknown>;
  if (!layerOk(o.layer, objectIds)) fail('splats.layer is not a layer of this world');
  const b = (o.bounds ?? {}) as { min?: unknown; max?: unknown };
  return {
    layer: o.layer,
    count: Math.round(numIn(o.count, 0, 1e9, 'splats.count')),
    meanOpacity: numIn(o.meanOpacity, 0, 1, 'splats.meanOpacity'),
    meanAnisotropy: numIn(o.meanAnisotropy, 0, 1e9, 'splats.meanAnisotropy'),
    thinShare: numIn(o.thinShare, 0, 1, 'splats.thinShare'),
    bounds: { min: nums(b.min, 3, 'splats.bounds.min') as [number, number, number], max: nums(b.max, 3, 'splats.bounds.max') as [number, number, number] },
  };
}

export function parseAuthor(v: unknown): string {
  if (v === undefined || v === null || v === '') return 'human';
  if (typeof v === 'string' && (v === 'human' || /^agent:[a-z0-9._-]{1,40}$/i.test(v))) return v;
  return fail('author must be "human" or "agent:<name>"');
}

function parseCategory(v: unknown): ObservationCategory | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (OBSERVATION_CATEGORIES.some((c) => c.id === v)) return v as ObservationCategory;
  return fail('unknown category');
}

// ---------- create, read, update ----------

/**
 * Store a flag. `form` carries `record` (JSON), `frame` (PNG or JPEG), and layer frames as `ablate:all` and
 * `ablate:<layer>` (JPEG or PNG, all of one size). Answers with the record and the issue it belongs to now.
 */
export async function createObservation(world: WorldHandle, form: FormData): Promise<ObservationCreated> {
  const rawRecord = form.get('record');
  if (typeof rawRecord !== 'string' || rawRecord.length > 400_000) return fail('the form needs a "record" field with the flag as JSON');
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(rawRecord) as Record<string, unknown>;
  } catch {
    return fail('"record" is not valid JSON');
  }
  const objectIds = new Set(world.manifest.objects.map((o) => o.id));

  const frameFile = form.get('frame');
  if (!(frameFile instanceof File)) return fail('the form needs a "frame" image');
  if (frameFile.size > MAX_FRAME_BYTES) return fail('the frame is larger than 12 MB', 413);
  const frameBytes = Buffer.from(await frameFile.arrayBuffer());
  const frameInfo = await decode(frameBytes, 'frame');
  const fr = (r.frame ?? {}) as Record<string, unknown>;
  const frame = { width: Math.round(numIn(fr.width, 16, 8192, 'frame.width')), height: Math.round(numIn(fr.height, 16, 8192, 'frame.height')) };
  if (frame.width !== frameInfo.width || frame.height !== frameInfo.height) fail(`the frame is ${frameInfo.width}×${frameInfo.height} but the record says ${frame.width}×${frame.height}`);

  const cam = (r.camera ?? {}) as Record<string, unknown>;
  const near = numIn(cam.near, 1e-6, 1e6, 'camera.near');
  const camera: ObservationRecord['camera'] = {
    position: nums(cam.position, 3, 'camera.position') as [number, number, number],
    quaternion: nums(cam.quaternion, 4, 'camera.quaternion') as [number, number, number, number],
    fovY: numIn(cam.fovY, 1, 170, 'camera.fovY'),
    aspect: numIn(cam.aspect, 0.1, 10, 'camera.aspect'),
    near,
    far: numIn(cam.far, near, 1e9, 'camera.far'),
    up: nums(cam.up, 3, 'camera.up') as [number, number, number],
  };
  const vp = (r.viewport ?? {}) as Record<string, unknown>;
  const viewport = { width: numIn(vp.width, 1, 16384, 'viewport.width'), height: numIn(vp.height, 1, 16384, 'viewport.height'), pixelRatio: numIn(vp.pixelRatio, 0.25, 8, 'viewport.pixelRatio') };

  const sc = (r.scene ?? {}) as Record<string, unknown>;
  const layers = (sc.layers ?? {}) as Record<string, unknown>;
  const placementMethod = typeof sc.placementMethod === 'string' && PLACEMENT_METHODS.some((p) => p.id === sc.placementMethod) ? (sc.placementMethod as NonNullable<ObservationRecord['scene']>['placementMethod']) : undefined;
  const scene: ObservationRecord['scene'] = {
    version: numIn(sc.version, 0, Number.MAX_SAFE_INTEGER, 'scene.version'),
    worldVariant: text(sc.worldVariant, 40, 'scene.worldVariant'),
    layers: { world: layers.world !== false, relief: layers.relief === true, objects: layers.objects !== false },
    objects: parseObjectState(sc.objects ?? [], world),
    placementMethod,
  };

  const mark = parseMark(r.mark, frame);
  const rays = parseRays(r.rays, objectIds, frame);
  const splats = parseSplats(r.splats, objectIds);
  const hint = r.suspectHint === undefined || r.suspectHint === null || r.suspectHint === '' ? undefined : layerOk(r.suspectHint, objectIds) ? r.suspectHint : fail('suspectHint is not a layer of this world');
  // Everything is checked before anything is written, so a rejected flag leaves nothing on disk.
  const author = parseAuthor(r.author);
  const category = parseCategory(r.category);
  const note = text(r.note, 2000, 'note');

  // Layer frames.
  const layerFrames: { layer: string | 'all'; bytes: Buffer; format: 'png' | 'jpeg'; width: number; height: number }[] = [];
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('ablate:') || !(value instanceof File)) continue;
    const layer = key.slice('ablate:'.length);
    if (layer !== 'all' && !layerOk(layer, objectIds)) fail(`${key} is not a layer of this world`);
    if (layerFrames.some((f) => f.layer === layer)) fail(`${key} was sent twice`);
    if (layerFrames.length >= 40) fail('too many layer frames');
    if (value.size > MAX_LAYER_FRAME_BYTES) fail(`${key} is larger than 3 MB`, 413);
    const bytes = Buffer.from(await value.arrayBuffer());
    const info = await decode(bytes, key);
    layerFrames.push({ layer, bytes, format: info.format, width: info.width, height: info.height });
  }
  if (new Set(layerFrames.map((f) => `${f.width}x${f.height}`)).size > 1) fail('the layer frames must all have the same size');

  const id = newObservationId();
  const dir = observationDir(world.id, id);
  try {
    await mkdir(dir, { recursive: true });
    const files: ObservationRecord['files'] = await writeFrame(dir, frameBytes, frameInfo.format);

    // How much of the marked region changes when each layer is hidden. Compared with the frame with every
    // layer shown, made the same way (or the full frame, scaled down, if that was not sent).
    const region: [number, number, number, number] = mark.kind === 'box' ? mark.px : [mark.px[0] - frame.width * 0.03, mark.px[1] - frame.width * 0.03, mark.px[0] + frame.width * 0.03, mark.px[1] + frame.width * 0.03];
    const all = layerFrames.find((f) => f.layer === 'all');
    if (all) {
      files.all = `all.${all.format === 'png' ? 'png' : 'jpg'}`;
      await writeFileAtomic(path.join(dir, files.all), all.bytes);
    }
    const ablation: ObservationRecord['ablation'] = [];
    for (const f of layerFrames) {
      if (f.layer === 'all') continue;
      const base = all ? all.bytes : await sharp(frameBytes).resize(f.width, f.height, { fit: 'fill' }).png().toBuffer();
      const file = `without-${layerSlug(f.layer)}.${f.format === 'png' ? 'png' : 'jpg'}`;
      await writeFileAtomic(path.join(dir, file), f.bytes);
      ablation.push({ layer: f.layer, file, changedShare: Math.round((await regionChange(base, f.bytes, region, frame)) * 1000) / 1000 });
    }

    const votes = tally(rays).map((v) => ({ layer: v.layer, share: Math.round(v.share * 1000) / 1000 }));
    const { suspect, source } = chooseSuspect(votes, ablation, hint);
    const record: ObservationRecord = {
      id,
      world: world.id,
      createdAt: nowIso(),
      author,
      status: 'open',
      category,
      note,
      camera,
      viewport,
      frame,
      scene,
      mark,
      rays,
      votes,
      suspect,
      suspectSource: source,
      ablation,
      splats,
      files,
    };
    await writeFileAtomic(path.join(dir, 'observation.json'), JSON.stringify(record, null, 2));
    world.log(`Observation ${id}: ${record.note ?? 'flagged'}${suspect ? ` (suspect ${suspect})` : ''}`);
    return { ...record, issue: await issueOf(world.id, id) };
  } catch (err) {
    // A flag is all or nothing: never leave a folder without its record.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Open a flag for an asset the asset check found background inside, so a person inspects it. There is no
 * viewer: the frame is the turntable the checker saw, `mark` the tile where it saw the problem, and the layer
 * is the object. An asset gets one such flag whatever its status, so a false alarm stays closed; returns
 * null when it already has one.
 */
export async function flagAssetCheck(world: WorldHandle, a: { check: ObservationAssetCheck; sheet: Buffer; mark: [number, number, number, number] | null; note: string }): Promise<ObservationRecord | null> {
  const objectIds = new Set(world.manifest.objects.map((o) => o.id));
  const suspect = `object:${a.check.object}`;
  if (!layerOk(suspect, objectIds)) throw new Error(`no object ${a.check.object} in this world`);
  const existing = await listObservations({ world: world.id });
  if (existing.some((r) => r.assetCheck?.file === a.check.file && r.assetCheck.bytes === a.check.bytes)) return null;

  const meta = await sharp(a.sheet).metadata();
  const frame = { width: meta.width ?? 0, height: meta.height ?? 0 };
  const id = newObservationId();
  const record: ObservationRecord = {
    id,
    world: world.id,
    createdAt: nowIso(),
    author: 'agent:asset-check',
    status: 'open',
    category: 'background-in-object',
    note: a.note.trim().slice(0, 2000),
    frame,
    mark: { kind: 'box', px: a.mark ?? [0, 0, frame.width, frame.height] },
    rays: [],
    votes: [],
    suspect,
    suspectSource: 'author',
    ablation: [],
    files: { frame: 'frame.jpg', thumb: 'thumb.jpg', tiny: 'tiny.jpg' },
    assetCheck: a.check,
  };
  const dir = observationDir(world.id, id);
  try {
    await mkdir(dir, { recursive: true });
    // The turntable is already a JPEG: keep its bytes.
    await writeFrame(dir, a.sheet, meta.format === 'jpeg' ? 'jpeg' : 'png');
    await writeFileAtomic(path.join(dir, 'observation.json'), JSON.stringify(record, null, 2));
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  world.log(`Observation ${id}: ${record.note} (suspect ${suspect})`);
  return record;
}

async function readRecord(worldId: string, id: string): Promise<ObservationRecord | null> {
  const file = path.join(observationDir(worldId, id), 'observation.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8')) as ObservationRecord;
  } catch {
    return null;
  }
}

export async function getObservation(worldId: string, id: string): Promise<ObservationRecord | null> {
  return isObservationId(id) ? readRecord(worldId, id) : null;
}

/** Newest first. `world` limits it to one world; `status` to one status. */
export async function listObservations(filter: { world?: string; status?: ObservationStatus } = {}): Promise<ObservationRecord[]> {
  if (!existsSync(OBSERVATIONS_DIR)) return [];
  const worlds = filter.world ? [filter.world] : await readdir(OBSERVATIONS_DIR);
  const out: ObservationRecord[] = [];
  for (const w of worlds) {
    const base = path.join(OBSERVATIONS_DIR, w);
    if (!existsSync(base)) continue;
    for (const id of await readdir(base)) {
      if (!isObservationId(id)) continue;
      const rec = await readRecord(w, id);
      if (rec && (!filter.status || rec.status === filter.status)) out.push(rec);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A status, note, category or suspect change (a person overriding the rule), applied to a record in memory. Throws if it is not valid. */
function applyPatch(rec: ObservationRecord, patch: unknown, objectIds: Set<string>) {
  const p = (patch ?? {}) as Record<string, unknown>;
  if (p.status !== undefined) {
    if (!OBSERVATION_STATUSES.some((s) => s.id === p.status)) fail('unknown status');
    rec.status = p.status as ObservationStatus;
  }
  if (p.note !== undefined) rec.note = text(p.note, 2000, 'note');
  if (p.category !== undefined) rec.category = parseCategory(p.category);
  if (p.suspect !== undefined) {
    if (p.suspect !== null && !layerOk(p.suspect, objectIds)) fail('suspect is not a layer of this world');
    rec.suspect = p.suspect;
    rec.suspectSource = p.suspect === null ? null : 'human';
  }
}

const recordFile = (worldId: string, id: string) => path.join(observationDir(worldId, id), 'observation.json');

/** Change an observation's status, note, category or suspect. */
export async function updateObservation(world: WorldHandle, id: string, patch: unknown): Promise<ObservationRecord> {
  const rec = await getObservation(world.id, id);
  if (!rec) return fail('no such observation', 404);
  applyPatch(rec, patch, new Set(world.manifest.objects.map((o) => o.id)));
  await writeFileAtomic(recordFile(world.id, id), JSON.stringify(rec, null, 2));
  return rec;
}

/** The same change to several flags, such as every sighting of an issue. All are checked before any is written. */
export async function updateObservations(world: WorldHandle, ids: unknown, patch: unknown): Promise<ObservationRecord[]> {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 500 || !ids.every((i) => typeof i === 'string' && isObservationId(i))) fail('ids must be a list of 1 to 500 observation ids');
  const objectIds = new Set(world.manifest.objects.map((o) => o.id));
  const recs: ObservationRecord[] = [];
  for (const id of new Set(ids as string[])) {
    const rec = await getObservation(world.id, id);
    if (!rec) return fail(`no observation ${id}`, 404);
    applyPatch(rec, patch, objectIds);
    recs.push(rec);
  }
  for (const rec of recs) await writeFileAtomic(recordFile(world.id, rec.id), JSON.stringify(rec, null, 2));
  return recs;
}

// ---------- issues: the flags of one problem, grouped ----------

type Vec3 = [number, number, number];

/** Two flags mark the same spot when their points are closer than this: a base, plus a share of the distance they were marked from (the same pixels cover more of a far surface). */
const SAME_SPOT_BASE_M = 0.3;
const SAME_SPOT_PER_M = 0.06;
const sameSpotTolerance = (distance: number) => SAME_SPOT_BASE_M + SAME_SPOT_PER_M * distance;

const mean3 = (ps: Vec3[]): Vec3 => [ps.reduce((a, p) => a + p[0], 0) / ps.length, ps.reduce((a, p) => a + p[1], 0) / ps.length, ps.reduce((a, p) => a + p[2], 0) / ps.length];

/** Rotate v by the inverse of the quaternion (x, y, z, w). */
function unrotate(q: [number, number, number, number], v: Vec3): Vec3 {
  const [qx, qy, qz] = [-q[0], -q[1], -q[2]], qw = q[3];
  const tx = 2 * (qy * v[2] - qz * v[1]), ty = 2 * (qz * v[0] - qx * v[2]), tz = 2 * (qx * v[1] - qy * v[0]);
  return [v[0] + qw * tx + (qy * tz - qz * ty), v[1] + qw * ty + (qz * tx - qx * tz), v[2] + qw * tz + (qx * ty - qy * tx)];
}

/**
 * Where a flag marks, on the layer it blames: the mean of that layer's nearest surface along each ray. For
 * an object this is measured in the object's own frame (moved back by its position, turned back by its
 * rotation, still in metres), so the same spot on the object matches even when the object stands elsewhere
 * in another flag. Null when no ray reached the layer; flags the asset check opened have no rays at all.
 */
export function locationOf(rec: Pick<ObservationRecord, 'rays' | 'suspect' | 'scene'>): { point: Vec3; distance: number } | null {
  const suspect = rec.suspect;
  if (!suspect) return null;
  const points: Vec3[] = [];
  const distances: number[] = [];
  for (const ray of rec.rays) {
    let best: ObservationRay['hits'][number] | undefined;
    for (const h of ray.hits) if (h.layer === suspect && (!best || h.distance < best.distance)) best = h;
    if (best) { points.push(best.point); distances.push(best.distance); }
  }
  if (!points.length) return null;
  let point = mean3(points);
  const object = suspect.startsWith('object:') ? rec.scene?.objects.find((o) => o.id === suspect.slice('object:'.length)) : undefined;
  if (object) {
    const t = object.transform.position;
    point = unrotate(object.transform.quaternion, [point[0] - t[0], point[1] - t[1], point[2] - t[2]]);
  }
  return { point, distance: distances.reduce((a, b) => a + b, 0) / distances.length };
}

/** Flags can be one problem only when they blame the same layer of the same world and, for an object, the same asset and mask. */
function groupKey(rec: ObservationRecord): string {
  const object = rec.suspect?.startsWith('object:') ? rec.scene?.objects.find((o) => o.id === rec.suspect!.slice('object:'.length)) : undefined;
  return [rec.world, rec.suspect ?? '', object ? `${object.asset ?? ''}@m${object.maskVersion ?? 1}` : ''].join('|');
}

/** Groups of flags that mark the same spot (single link: a flag between two others joins them). Flags that cannot be placed stand alone. */
export function clusterObservations(recs: ObservationRecord[]): ObservationRecord[][] {
  const parent = recs.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const buckets = new Map<string, { i: number; point: Vec3; tol: number }[]>();
  recs.forEach((rec, i) => {
    const loc = rec.assetCheck ? null : locationOf(rec);
    if (!loc) return;
    const key = groupKey(rec);
    const bucket = buckets.get(key) ?? [];
    bucket.push({ i, point: loc.point, tol: sameSpotTolerance(loc.distance) });
    buckets.set(key, bucket);
  });
  for (const bucket of buckets.values()) {
    for (let a = 0; a < bucket.length; a++) {
      for (let b = 0; b < a; b++) {
        const d = Math.hypot(bucket[a].point[0] - bucket[b].point[0], bucket[a].point[1] - bucket[b].point[1], bucket[a].point[2] - bucket[b].point[2]);
        if (d <= Math.max(bucket[a].tol, bucket[b].tol)) parent[find(bucket[a].i)] = find(bucket[b].i);
      }
    }
  }
  const groups = new Map<number, ObservationRecord[]>();
  recs.forEach((rec, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), rec]);
  });
  return [...groups.values()];
}

export function toSummary(rec: ObservationRecord): ObservationSummary {
  const { rays, ...rest } = rec;
  return { ...rest, rayCount: rays.length };
}

const newestFirst = (a: ObservationRecord, b: ObservationRecord) => b.createdAt.localeCompare(a.createdAt);

/** What a group of flags says as a whole. A repeat flag after a fix reopens it: the status is the newest sighting's. */
function describeGroup(group: ObservationRecord[]) {
  const sorted = [...group].sort(newestFirst);
  const newest = sorted[0];
  return { sorted, newest, status: newest.status, reopened: newest.status === 'open' && sorted.slice(1).some((r) => r.status === 'fixed') };
}

function assemble(group: ObservationRecord[], worldTitle: string): ObservationIssue {
  const { sorted, newest, status, reopened } = describeGroup(group);
  const oldest = sorted[sorted.length - 1];
  const share = (r: ObservationRecord) => r.votes.find((v) => v.layer === r.suspect)?.share ?? 0;
  // The clearest sighting; of equals the newest, because only a strictly larger share replaces it.
  const best = sorted.reduce((a, b) => (share(b) > share(a) ? b : a));
  const locations = sorted.map((r) => (r.assetCheck ? null : locationOf(r))).filter((l): l is NonNullable<typeof l> => Boolean(l));
  // Every flag of a problem carries the fixes applied for it, so the newest of them all is the newest fix.
  const fixes = sorted.flatMap((r) => r.fixes ?? []);
  const fix = fixes.length ? fixes.reduce((a, b) => (b.at > a.at ? b : a)) : undefined;
  return {
    id: oldest.id,
    world: newest.world,
    worldTitle,
    suspect: newest.suspect,
    status,
    reopened,
    count: sorted.length,
    ids: sorted.map((r) => r.id),
    firstSeen: oldest.createdAt,
    lastSeen: newest.createdAt,
    best: toSummary(best),
    sightings: sorted.slice(0, SIGHTINGS_SHOWN).map(toSummary),
    location: locations.length ? (mean3(locations.map((l) => l.point)).map((v) => Math.round(v * 1000) / 1000) as Vec3) : null,
    ...(fix ? { fix } : {}),
  };
}

/** Every flag of the problem a flag belongs to (the flag itself among them), or null when there is no such flag. */
export async function groupOf(worldId: string, id: string): Promise<ObservationRecord[] | null> {
  if (!isObservationId(id)) return null;
  return clusterObservations(await listObservations({ world: worldId })).find((g) => g.some((r) => r.id === id)) ?? null;
}

/** The issue a saved flag belongs to now, for telling its author "this is the third sighting". */
async function issueOf(worldId: string, id: string): Promise<ObservationCreated['issue']> {
  const group = await groupOf(worldId, id);
  if (!group) return undefined;
  const { sorted, status, reopened } = describeGroup(group);
  return { id: sorted[sorted.length - 1].id, count: group.length, status, reopened };
}

/** Problems, newest sighting first, one page of them. Every problem is counted whatever the filter. */
export async function listIssues(opts: { world?: string; status?: ObservationStatus; limit: number; offset: number; titleOf: (world: string) => Promise<string> }): Promise<ObservationIssuePage> {
  const records = await listObservations({ world: opts.world });
  const perWorld = new Map<string, ObservationRecord[]>();
  for (const r of records) perWorld.set(r.world, [...(perWorld.get(r.world) ?? []), r]);
  const groups: { group: ObservationRecord[]; status: ObservationStatus; lastSeen: string }[] = [];
  for (const recs of perWorld.values()) {
    for (const group of clusterObservations(recs)) {
      const { newest, status } = describeGroup(group);
      groups.push({ group, status, lastSeen: newest.createdAt });
    }
  }
  groups.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const byStatus: ObservationIssuePage['byStatus'] = {};
  for (const g of groups) byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
  const shown = opts.status ? groups.filter((g) => g.status === opts.status) : groups;
  const issues: ObservationIssue[] = [];
  for (const g of shown.slice(opts.offset, opts.offset + opts.limit)) issues.push(assemble(g.group, await opts.titleOf(g.group[0].world)));

  const worlds: ObservationIssuePage['worlds'] = [];
  if (existsSync(OBSERVATIONS_DIR)) {
    for (const w of await readdir(OBSERVATIONS_DIR)) {
      const n = (await readdir(path.join(OBSERVATIONS_DIR, w)).catch(() => [] as string[])).filter(isObservationId).length;
      if (n) worlds.push({ id: w, title: await opts.titleOf(w), flags: n });
    }
  }
  return { total: shown.length, issues, all: groups.length, flags: records.length, byStatus, worlds };
}

// ---------- fixes ----------

/** Note a fix on every flag of the problem the flag belongs to. Returns how many flags carry it now. */
export async function recordFix(worldId: string, id: string, fix: AppliedFix): Promise<number> {
  const group = await groupOf(worldId, id);
  if (!group) return 0;
  for (const rec of group) {
    rec.fixes = [...(rec.fixes ?? []), fix].slice(-20);
    await writeFileAtomic(recordFile(worldId, rec.id), JSON.stringify(rec, null, 2));
  }
  return group.length;
}

const MAX_AFTER_BYTES = 3 * 1024 * 1024;

/**
 * A person looked at the flagged view again and it is right: mark every sighting of the problem fixed. `after`
 * (a PNG or JPEG of the view now) is kept beside the flagged frame, on the flag it was taken for, as the record
 * of what changed; a new one replaces the old.
 */
export async function resolveIssue(world: WorldHandle, id: string, after: File | null): Promise<{ updated: number; issue: ObservationIssue }> {
  const group = await groupOf(world.id, id);
  if (!group) return fail('no such observation', 404);
  const rec = group.find((r) => r.id === id)!;
  if (after) {
    if (after.size > MAX_AFTER_BYTES) fail('the picture is larger than 3 MB', 413);
    const bytes = Buffer.from(await after.arrayBuffer());
    await decode(bytes, 'after');
    const dir = observationDir(world.id, id);
    const name = `after-${randomBytes(4).toString('hex')}.jpg`;
    await writeFileAtomic(path.join(dir, name), await makeThumbnail(bytes, 'thumb.jpg'));
    if (rec.files.after) await rm(path.join(dir, rec.files.after), { force: true });
    rec.files.after = name;
  }
  for (const r of group) {
    r.status = 'fixed';
    await writeFileAtomic(recordFile(world.id, r.id), JSON.stringify(r, null, 2));
  }
  return { updated: group.length, issue: assemble(group, world.manifest.title) };
}
