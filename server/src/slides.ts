// Slides: the ways into a world, as the slide space shows them (web/src/slides/).
//
// Every built world has its photo slide: the photo, entered from the camera that took it (the origin of the
// scene). More slides come from inside the world (the viewer's Capture button, which people know as a bookmark).
// Each one is a frame of exactly what the viewer's camera saw plus that camera, so entering from it lines up the
// way entering from the photo does. A person can give a bookmark a name and caption of their own (updateSlide). They are
// stored with the world:
//   slides.json             { slides: SlideRecord[] }
//   slides/<id>.jpg         the frame (at most 2048 px)
//   slides/<id>-thumb.jpg   the same at most 640 px, for the stack
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { getWorld, listWorlds, type WorldHandle } from './store.ts';
import type { SceneDoc, SlideDoc, SlideEntry, SlideRecord, WorldManifest } from './types.ts';
import { nowIso, writeFileAtomic } from './util.ts';
import { characterCount, MAX_SLIDE_TITLE_CHARS, MAX_VIDEO_PROMPT_CHARS } from './video-limits.ts';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_SLIDES_PER_WORLD = 200;
const MAX_CAPTION_CHARS = MAX_VIDEO_PROMPT_CHARS;
const IMAGE_PX = 2048;
const THUMB_PX = 640;
/** How far the image's shape may be from the camera's before the slide is refused. */
const ASPECT_TOLERANCE = 0.02;

export class SlideError extends Error {
  status: 400 | 404 | 409 | 413;
  constructor(status: 400 | 404 | 409 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

function fail(message: string, status: SlideError['status'] = 400): never {
  throw new SlideError(status, message);
}

export const isSlideId = (id: string) => id === 'photo' || /^s[a-z0-9]{6,24}$/.test(id);
const newSlideId = () => `s${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;

// ---------- small quaternion helpers (x, y, z, w) ----------

type Quat = [number, number, number, number];
type Vec3 = [number, number, number];

function qmul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
function qnorm(q: Quat): Quat {
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
function qrot(q: Quat, v: Vec3): Vec3 {
  const r = qmul(qmul(q, [v[0], v[1], v[2], 0]), qconj(q));
  return [r[0], r[1], r[2]];
}

// ---------- reading ----------

/** What slides need from scene.json (which can be large: it carries every object's hull). */
interface SlideScene {
  fovY: number;
  target: Vec3;
  image: { url: string; width: number; height: number };
  world?: { scale: number; quaternion: Quat };
}

const sceneCache = new Map<string, { mtimeMs: number; scene: SlideScene }>();

async function readScene(world: WorldHandle): Promise<SlideScene | null> {
  if (!world.manifest.scene) return null;
  const file = world.file('scene.json');
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const cached = sceneCache.get(world.id);
  if (cached?.mtimeMs === mtimeMs) return cached.scene;
  try {
    const doc = JSON.parse(await readFile(file, 'utf8')) as SceneDoc;
    const scene: SlideScene = {
      fovY: doc.camera.fovY,
      target: doc.camera.target,
      image: doc.image,
      world: doc.world ? { scale: doc.world.scale, quaternion: doc.world.quaternion } : undefined,
    };
    sceneCache.set(world.id, { mtimeMs, scene });
    return scene;
  } catch {
    return null;
  }
}

async function readRecords(world: WorldHandle): Promise<SlideRecord[]> {
  const file = world.file('slides.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { slides?: unknown };
    return Array.isArray(parsed.slides) ? (parsed.slides as SlideRecord[]) : [];
  } catch {
    return [];
  }
}

/** EXIF dates come as ISO strings or as "2024:06:01 12:00:00"; anything unreadable falls back to when the world was made. */
function takenAt(m: WorldManifest): string {
  const raw = m.image.camera?.takenAt;
  if (raw) {
    const d = new Date(/^\d{4}:\d{2}:\d{2}/.test(raw) ? raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T') : raw);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return m.createdAt;
}

/**
 * A slide's entry in the scene as it is now. Slides made in a Marble world keep its calibration; when compose
 * has calibrated it differently since, the camera is moved the same way the world moved, so the view of the
 * world (and so the image) still lines up.
 */
function currentEntry(rec: SlideRecord, scene: SlideScene): SlideEntry {
  const was = rec.frame, now = scene.world;
  if (!was || !now) return rec.entry;
  const same = Math.abs(was.worldScale - now.scale) < 1e-9 && was.worldQuaternion.every((v, i) => Math.abs(v - now.quaternion[i]) < 1e-9);
  if (same) return rec.entry;
  const s = now.scale / was.worldScale;
  const dq = qnorm(qmul(now.quaternion, qconj(was.worldQuaternion)));
  const p = qrot(dq, rec.entry.position);
  return {
    ...rec.entry,
    position: [p[0] * s, p[1] * s, p[2] * s],
    quaternion: qnorm(qmul(dq, rec.entry.quaternion)),
    ...(rec.entry.focus !== undefined ? { focus: rec.entry.focus * s } : {}),
  };
}

function photoSlide(m: WorldManifest, scene: SlideScene): SlideDoc {
  const t = scene.target;
  return {
    id: 'photo',
    world: m.id,
    worldTitle: m.title,
    kind: 'photo',
    title: 'The photo',
    takenAt: takenAt(m),
    createdAt: m.createdAt,
    image: { url: scene.image.url, thumb: `/files/${m.id}/${m.image.thumb}`, width: scene.image.width, height: scene.image.height },
    entry: {
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      fovY: scene.fovY,
      aspect: scene.image.width / scene.image.height,
      ...(t[2] < -0.5 ? { focus: Math.hypot(...t) } : {}),
    },
  };
}

function viewSlide(m: WorldManifest, rec: SlideRecord, scene: SlideScene): SlideDoc {
  return {
    id: rec.id,
    world: m.id,
    worldTitle: m.title,
    kind: 'view',
    title: rec.title,
    ...(rec.caption ? { caption: rec.caption } : {}),
    takenAt: takenAt(m),
    createdAt: rec.createdAt,
    image: { url: `/files/${m.id}/${rec.image.file}`, thumb: `/files/${m.id}/${rec.image.thumb}`, width: rec.image.width, height: rec.image.height },
    entry: currentEntry(rec, scene),
  };
}

/** A built world's slides: its photo first, then the slides made inside it, oldest first. None until it has a scene. */
export async function worldSlides(world: WorldHandle): Promise<SlideDoc[]> {
  const scene = await readScene(world);
  if (!scene) return [];
  const records = await readRecords(world);
  return [photoSlide(world.manifest, scene), ...records.map((r) => viewSlide(world.manifest, r, scene))];
}

/** Every slide of every built world that `include` lets through, in time order (the memory's, then the slide's). */
export async function allSlides(include: (worldId: string) => boolean = () => true): Promise<SlideDoc[]> {
  const out: SlideDoc[] = [];
  for (const m of await listWorlds()) {
    if (!m.scene || !include(m.id)) continue;
    const world = await getWorld(m.id);
    if (world) out.push(...(await worldSlides(world).catch(() => [])));
  }
  return out.sort((a, b) => a.takenAt.localeCompare(b.takenAt) || a.world.localeCompare(b.world) || (a.kind === 'photo' ? -1 : b.kind === 'photo' ? 1 : a.createdAt.localeCompare(b.createdAt)));
}

// ---------- writing ----------

// Writes to one world's slides.json run one after another.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(worldId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(worldId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  queues.set(worldId, run);
  void run.finally(() => { if (queues.get(worldId) === run) queues.delete(worldId); }).catch(() => undefined);
  return run;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function nums(v: unknown, n: number, what: string, limit: number): number[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => isNum(x) && Math.abs(x) <= limit)) fail(`${what} must be ${n} numbers`);
  return v as number[];
}

function numIn(v: unknown, lo: number, hi: number, what: string): number {
  if (!isNum(v) || v < lo || v > hi) fail(`${what} must be a number from ${lo} to ${hi}`);
  return v;
}

/**
 * A name a person gave a slide: one line of plain text, at most 120 characters, or undefined when nothing
 * visible is left.
 *  - Control characters, line and paragraph separators, bidirectional overrides and runs of white space become
 *    one space. A line break would otherwise start a made-up line in the world's log, which is written line by line.
 *  - Characters that draw nothing and can carry hidden text are removed: the "tag" characters (U+E0000 to
 *    U+E007F), word joiner and the invisible operators, zero-width space, the soft hyphen and the byte order mark.
 *    The names are read back by scripts and agents, which would see what a person cannot.
 *  - The zero-width joiner and non-joiner stay, because emoji sequences and some scripts (Persian, Hindi) need
 *    them. A name with nothing but those, spaces and other invisible characters is refused.
 * The limit counts Unicode characters, so it never splits an emoji in half.
 */
export function cleanTitle(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return fail('title must be text');
  if (characterCount(v) > MAX_SLIDE_TITLE_CHARS) return fail(`title must be at most ${MAX_SLIDE_TITLE_CHARS} characters`, 413);
  const oneLine = v
    .replace(/[\u{e0000}-\u{e007f}\u2060-\u2064\u200b\u00ad\ufeff\u180e]/gu, '')
    .replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069\s]+/gu, ' ')
    .trim();
  // Something a person can see: a letter, number, mark, punctuation or symbol (an emoji is a symbol).
  return /[\p{L}\p{N}\p{M}\p{P}\p{S}]/u.test(oneLine) ? oneLine : undefined;
}

/**
 * A caption is optional, can span lines, and is limited to 16,000 Unicode code points. Hidden Unicode is removed
 * so a person and a script read the same words; ordinary spaces and line breaks remain useful in a caption.
 */
export function cleanCaption(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') return fail('caption must be text');
  const clean = v
    .replace(/[\u{e0000}-\u{e007f}\u2060-\u2064\u200b\u00ad\ufeff\u180e]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '')
    .replace(/\r\n?/g, '\n');
  const cut = [...clean].slice(0, MAX_CAPTION_CHARS).join('').trim();
  return /[\p{L}\p{N}\p{M}\p{P}\p{S}]/u.test(cut) ? cut : undefined;
}

/** The camera a slide enters from, checked number by number. */
export function parseEntry(v: unknown): SlideEntry {
  const o = (v ?? {}) as Record<string, unknown>;
  const position = nums(o.position, 3, 'entry.position', 1e5) as Vec3;
  const q = nums(o.quaternion, 4, 'entry.quaternion', 2) as Quat;
  const len = Math.hypot(...q);
  if (len < 0.5 || len > 1.5) fail('entry.quaternion must be a rotation (length 1)');
  const entry: SlideEntry = {
    position,
    quaternion: qnorm(q),
    fovY: numIn(o.fovY, 5, 150, 'entry.fovY'),
    aspect: numIn(o.aspect, 0.2, 5, 'entry.aspect'),
  };
  if (o.focus !== undefined && o.focus !== null) entry.focus = numIn(o.focus, 0.01, 1e5, 'entry.focus');
  return entry;
}

/**
 * Store a slide made inside the world. `form` carries `record` (JSON: `{ entry, title?, caption? }`) and `image` (the
 * frame, JPEG/PNG/WebP). Everything is checked before anything is written.
 */
export async function createSlide(world: WorldHandle, form: FormData): Promise<SlideDoc> {
  const raw = form.get('record');
  if (typeof raw !== 'string' || raw.length > 20_000) return fail('the form needs a "record" field with the slide as JSON');
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fail('"record" is not valid JSON');
  }
  const entry = parseEntry(r.entry);
  const title = cleanTitle(r.title);
  const caption = cleanCaption(r.caption);

  const file = form.get('image');
  if (!(file instanceof File)) return fail('the form needs an "image"');
  if (file.size > MAX_IMAGE_BYTES) return fail('the image is larger than 16 MB', 413);
  const input = Buffer.from(await file.arrayBuffer());
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return fail('the image could not be read');
  }
  if (!['jpeg', 'png', 'webp'].includes(meta.format ?? '') || !meta.width || !meta.height || meta.width < 64 || meta.height < 64 || meta.width > 8192 || meta.height > 8192) {
    return fail('the image must be a JPEG, PNG or WebP from 64 to 8192 px');
  }
  // The image is what the camera saw, so it has the camera's shape.
  if (Math.abs(meta.width / meta.height - entry.aspect) / entry.aspect > ASPECT_TOLERANCE) {
    fail(`the image is ${meta.width}×${meta.height} but the camera's shape is ${entry.aspect.toFixed(3)}`);
  }

  const scene = await readScene(world);
  if (!scene) fail('this world has no scene yet', 409);

  return serialized(world.id, async () => {
    const records = await readRecords(world);
    if (records.length >= MAX_SLIDES_PER_WORLD) fail(`a world keeps at most ${MAX_SLIDES_PER_WORLD} slides`, 409);
    const id = newSlideId();
    const files = { file: `slides/${id}.jpg`, thumb: `slides/${id}-thumb.jpg` };
    const views = records.map((x) => Number(/^View (\d+)$/.exec(x.title)?.[1] ?? 0));
    try {
      const big = await sharp(input).resize(IMAGE_PX, IMAGE_PX, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true });
      const thumb = await sharp(input).resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      await writeFileAtomic(world.file(files.file), big.data);
      await writeFileAtomic(world.file(files.thumb), thumb);
      const rec: SlideRecord = {
        id,
        title: title ?? `View ${Math.max(0, ...views) + 1}`,
        ...(caption ? { caption } : {}),
        createdAt: nowIso(),
        image: { ...files, width: big.info.width, height: big.info.height },
        entry,
        ...(scene.world ? { frame: { worldScale: scene.world.scale, worldQuaternion: scene.world.quaternion } } : {}),
      };
      await writeFileAtomic(world.file('slides.json'), JSON.stringify({ slides: [...records, rec] }, null, 2));
      world.log(`Slide ${id}: ${rec.title}`);
      return viewSlide(world.manifest, rec, scene);
    } catch (err) {
      // A slide is all or nothing: never leave files without their record.
      await Promise.all([files.file, files.thumb].map((f) => rm(world.file(f), { force: true }).catch(() => undefined)));
      throw err;
    }
  });
}

/**
 * Update a slide made inside the world: `body` may contain `title` and/or `caption`. Its picture and camera stay
 * as they were. A blank caption clears it; a blank title is refused. The photo slide keeps its own metadata.
 */
export async function updateSlide(world: WorldHandle, id: string, body: unknown): Promise<SlideDoc> {
  if (id === 'photo') fail('The photo is the world\'s own slide and cannot be changed.', 409);
  if (!isSlideId(id)) fail('no such slide', 404);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) fail('expected { "title"?: "…", "caption"?: "…" }');
  const input = body as Record<string, unknown>;
  const hasTitle = Object.prototype.hasOwnProperty.call(input, 'title');
  const hasCaption = Object.prototype.hasOwnProperty.call(input, 'caption');
  if (!hasTitle && !hasCaption) fail('expected a title or caption to change');
  const title = hasTitle ? cleanTitle(input.title) : undefined;
  if (hasTitle && !title) fail('the name needs at least one visible character');
  const caption = hasCaption ? cleanCaption(input.caption) : undefined;
  const scene = await readScene(world);
  if (!scene) fail('this world has no scene yet', 409);
  return serialized(world.id, async () => {
    const records = await readRecords(world);
    const found = records.find((r) => r.id === id);
    if (!found) fail('no such slide', 404);
    const updated: SlideRecord = { ...found };
    const changes: string[] = [];
    if (hasTitle) {
      updated.title = title!;
      if (title !== found.title) changes.push(`renamed from "${found.title}" to "${title}"`);
    }
    if (hasCaption) {
      if (caption) updated.caption = caption;
      else delete updated.caption;
      changes.push(caption ? 'caption updated' : 'caption cleared');
    }
    await writeFileAtomic(world.file('slides.json'), JSON.stringify({ slides: records.map((r) => (r.id === id ? updated : r)) }, null, 2));
    if (changes.length) world.log(`Slide ${id}: ${changes.join('; ')}`);
    return viewSlide(world.manifest, updated, scene);
  });
}

/** Backward-compatible name-only export for callers that used the earlier API. */
export const renameSlide = updateSlide;

/** Remove a slide made inside the world, with its images. The photo slide stays. */
export async function deleteSlide(world: WorldHandle, id: string): Promise<void> {
  if (id === 'photo') fail('The photo is the world\'s own slide and cannot be removed.', 409);
  if (!isSlideId(id)) fail('no such slide', 404);
  await serialized(world.id, async () => {
    const records = await readRecords(world);
    const rec = records.find((r) => r.id === id);
    if (!rec) fail('no such slide', 404);
    await writeFileAtomic(world.file('slides.json'), JSON.stringify({ slides: records.filter((r) => r.id !== id) }, null, 2));
    await Promise.all([rec.image.file, rec.image.thumb].map((f) => rm(world.file(f), { force: true }).catch(() => undefined)));
    world.log(`Slide ${id} removed (${rec.title})`);
  });
}
