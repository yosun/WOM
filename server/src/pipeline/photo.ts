// Uploaded photos. JPEG, PNG, WebP and AVIF are read with sharp. HEIC/HEIF is read with macOS ImageIO
// (server/tools/imageio-extract.swift) on a Mac and with libheif (server/tools/libheif-extract.py)
// elsewhere. Both also return every frame in the file and the depth, disparity and matte images Apple
// cameras store with a photo. Videos (such as a Live Photo's .MOV) give several frames through ffmpeg.
// The lens recorded in EXIF gives the photo's real field of view.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import exifr from 'exifr';
import sharp from 'sharp';
import { DATA_DIR, HEIC_DECODER, HEIC_PYTHON, ROOT } from '../config.ts';
import type { WorldHandle } from '../store.ts';
import type { CameraInfo, WorldManifest } from '../types.ts';
import { errorMessage, writeFileAtomic } from '../util.ts';

const run = promisify(execFile);
const MAX_PIXELS = 120_000_000;
const THUMB_PX = 360;
/** Frames taken from a video, spread evenly over its length. */
const VIDEO_FRAMES = 8;

export type PhotoKind = 'jpeg' | 'png' | 'webp' | 'avif' | 'heif' | 'video';

export interface PhotoFrame {
  index: number;
  /** Upright size. */
  width: number;
  height: number;
  /** Upright JPEG at full resolution. */
  jpeg: Buffer;
  thumb: Buffer;
  /** Seconds into the video, for video frames. */
  timeS?: number;
}

export interface PhotoAux {
  /** depth (metres), disparity (1/metre), portrait-matte, sky-matte, hair-matte, …, hdr-gain-map. */
  type: string;
  width: number;
  height: number;
  /** Float32 little-endian (depth, disparity) or PNG (mattes); upright like the photo. */
  data?: Buffer;
  ext?: 'f32' | 'png';
  preview?: Buffer;
  accuracy?: string;
  quality?: string;
  min?: number;
  max?: number;
}

export interface DecodedPhoto {
  kind: PhotoKind;
  frames: PhotoFrame[];
  /** The frame the camera marks as the photo (the first one for videos: none is preferred). */
  primary: number;
  aux: PhotoAux[];
  camera?: CameraInfo;
  notes: string[];
}

export class PhotoError extends Error {
  status: 400 | 415 | 501;
  constructor(status: 400 | 415 | 501, message: string) {
    super(message);
    this.status = status;
  }
}

/** What kind of file this is, from its first bytes (the file name is not trusted). */
export function sniff(buf: Buffer): PhotoKind | null {
  if (buf.length < 16) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    // ISO base media file: the major brand and the compatible brands say what is inside.
    const size = Math.min(buf.readUInt32BE(0), buf.length, 256);
    const brands = [buf.subarray(8, 12).toString('latin1')];
    for (let o = 16; o + 4 <= size; o += 4) brands.push(buf.subarray(o, o + 4).toString('latin1'));
    if (brands[0] === 'avif' || brands[0] === 'avis') return 'avif';
    if (brands.some((b) => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(b))) return 'heif';
    if (brands.includes('avif')) return 'avif';
    if (brands.some((b) => ['mif1', 'msf1'].includes(b))) return 'heif';
    if (brands.some((b) => ['qt  ', 'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'M4V ', 'avc1', '3gp4', '3gp5', '3gp6', 'dash'].includes(b))) return 'video';
  }
  return null;
}

// ---------- lens ----------

/** Field of view from a 35 mm-equivalent focal length, matched on the diagonal like camera makers do. */
export function fovFrom35mm(f35: number, width: number, height: number) {
  const halfDiagTan = Math.hypot(36, 24) / 2 / f35;
  const diag = Math.hypot(width, height);
  const deg = (t: number) => (2 * Math.atan(t) * 180) / Math.PI;
  return { hfovDeg: deg((halfDiagTan * width) / diag), vfovDeg: deg((halfDiagTan * height) / diag) };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\0+$/, '') : undefined);

/** The camera and lens from EXIF, with the field of view of the upright photo when the lens says enough. */
export async function readCamera(input: Buffer, upright: { width: number; height: number }): Promise<CameraInfo | undefined> {
  let t: Record<string, unknown> | undefined;
  try {
    t = await exifr.parse(input, {
      pick: ['Make', 'Model', 'LensMake', 'LensModel', 'FocalLength', 'FocalLengthIn35mmFormat', 'FNumber', 'DateTimeOriginal', 'Orientation'],
      translateValues: false,
      reviveValues: true,
    });
  } catch {
    t = undefined;
  }
  if (!t) return undefined;
  return cameraFrom({
    make: str(t.Make),
    model: str(t.Model),
    lens: str(t.LensModel),
    focalLengthMm: num(t.FocalLength),
    focalLength35mm: num(t.FocalLengthIn35mmFormat),
    fNumber: num(t.FNumber),
    takenAt: t.DateTimeOriginal instanceof Date ? t.DateTimeOriginal.toISOString() : str(t.DateTimeOriginal),
  }, upright, 'exif');
}

function cameraFrom(c: Omit<CameraInfo, 'hfovDeg' | 'vfovDeg' | 'source'>, upright: { width: number; height: number }, source: CameraInfo['source']): CameraInfo | undefined {
  const fields = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined));
  if (!Object.keys(fields).length) return undefined;
  const clean: CameraInfo = { ...fields, source };
  if (clean.focalLength35mm && clean.focalLength35mm > 4 && clean.focalLength35mm < 2000) {
    Object.assign(clean, fovFrom35mm(clean.focalLength35mm, upright.width, upright.height));
  }
  return clean;
}

// ---------- decoding ----------

async function upright(input: Buffer) {
  const img = sharp(input, { limitInputPixels: MAX_PIXELS }).rotate().removeAlpha();
  const { data, info } = await img.jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true });
  const thumb = await sharp(data).resize(THUMB_PX, THUMB_PX, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  return { jpeg: data, width: info.width, height: info.height, thumb };
}

/** Decode an upload into upright frames, Apple's auxiliary images and the camera. Throws PhotoError. */
export async function decodePhoto(buf: Buffer): Promise<DecodedPhoto> {
  const kind = sniff(buf);
  if (!kind) throw new PhotoError(415, 'That file is not a photo WOM can read. Use JPEG, PNG, WebP, HEIC/HEIF, AVIF, or a short video (MOV/MP4).');
  if (kind === 'heif') return decodeHeif(buf);
  if (kind === 'video') return decodeVideo(buf);
  let u;
  try {
    u = await upright(buf);
  } catch {
    throw new PhotoError(415, 'That file could not be read as an image.');
  }
  const camera = await readCamera(buf, u);
  return { kind, frames: [{ index: 0, ...u }], primary: 0, aux: [], camera, notes: [] };
}

// HEIC through a helper program that writes the frames and auxiliary images to a folder and describes
// them as JSON: ImageIO on a Mac (compiled once per version of its source), libheif through Python elsewhere.
interface HeifHelper {
  name: 'ImageIO' | 'libheif';
  command: string;
  args: string[];
}

let helperPromise: Promise<HeifHelper> | null = null;
function heifHelper(): Promise<HeifHelper> {
  helperPromise ??= (async (): Promise<HeifHelper> => {
    if (HEIC_DECODER === 'libheif') return { name: 'libheif', command: HEIC_PYTHON, args: [path.join(ROOT, 'server', 'tools', 'libheif-extract.py')] };
    if (process.platform !== 'darwin') throw new PhotoError(501, 'The ImageIO HEIC reader needs macOS. Set WOM_HEIC_DECODER=libheif to read HEIC with libheif, or convert the photo to JPEG first.');
    const src = path.join(ROOT, 'server', 'tools', 'imageio-extract.swift');
    const hash = createHash('sha256').update(await readFile(src)).digest('hex').slice(0, 12);
    const bin = path.join(DATA_DIR, 'tools', `imageio-extract-${hash}`);
    if (!existsSync(bin)) {
      await mkdir(path.dirname(bin), { recursive: true });
      try {
        await run('swiftc', ['-O', src, '-o', bin], { timeout: 300_000 });
      } catch (err) {
        throw new PhotoError(501, `Could not build the HEIC reader; install Xcode's command line tools (xcode-select --install). ${errorMessage(err)}`);
      }
    }
    return { name: 'ImageIO', command: bin, args: [] };
  })().catch((err) => {
    helperPromise = null;
    throw err;
  });
  return helperPromise;
}

/**
 * What to tell the client when the HEIC helper fails. The helper's last line on stderr says why (it names no
 * paths); the full output goes to the server log. Exit status 3 means pillow-heif is missing, 4 an image over MAX_PIXELS.
 */
function heifFailure(helper: HeifHelper, err: unknown): PhotoError {
  const e = err as { code?: unknown; stderr?: unknown; killed?: boolean };
  const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
  if (helper.name === 'libheif' && (e.code === 'ENOENT' || e.code === 3)) {
    return new PhotoError(501, 'HEIC/HEIF photos need Python 3 with pillow-heif on the server (pip install pillow-heif; WOM_HEIC_PYTHON names the interpreter). Convert the photo to JPEG first.');
  }
  if (e.code === 4) return new PhotoError(415, `That photo has more than ${MAX_PIXELS / 1e6} megapixels, which is more than WOM reads.`);
  if (stderr) console.warn(`[heic] ${helper.name} failed: ${stderr}`);
  const reason = stderr.split('\n').pop() || (e.killed ? 'it took too long' : 'unknown error');
  return new PhotoError(415, `That HEIC/HEIF file could not be read: ${reason}`);
}

interface HelperOutput {
  uti: string;
  count: number;
  primaryIndex: number;
  frames: { index: number; width: number; height: number; orientation: number; file: string; thumb?: string }[];
  aux: { type: string; width: number; height: number; file?: string; preview?: string; accuracy?: string; quality?: string; min?: number; max?: number }[];
  notes: string[];
}

async function decodeHeif(buf: Buffer): Promise<DecodedPhoto> {
  const helper = await heifHelper();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wom-heif-'));
  try {
    const input = path.join(dir, 'input.heic');
    await writeFile(input, buf);
    let out: HelperOutput;
    try {
      const limit = helper.name === 'libheif' ? ['--max-pixels', String(MAX_PIXELS)] : [];
      const { stdout } = await run(helper.command, [...helper.args, input, path.join(dir, 'out'), '--thumbs', String(THUMB_PX), ...limit], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      out = JSON.parse(stdout) as HelperOutput;
    } catch (err) {
      throw heifFailure(helper, err);
    }
    const frames: PhotoFrame[] = [];
    for (const f of out.frames) {
      // The frame JPEG keeps the camera's orientation tag; sharp turns it upright.
      const u = await upright(await readFile(path.join(dir, 'out', f.file)));
      const thumb = f.thumb ? await readFile(path.join(dir, 'out', f.thumb)) : u.thumb;
      frames.push({ index: f.index, width: u.width, height: u.height, jpeg: u.jpeg, thumb });
    }
    if (!frames.length) throw new PhotoError(415, 'That HEIC/HEIF file holds no readable image.');
    const primary = Math.max(0, frames.findIndex((f) => f.index === out.primaryIndex));
    const aux: PhotoAux[] = [];
    for (const a of out.aux) {
      aux.push({
        type: a.type,
        width: a.width,
        height: a.height,
        data: a.file ? await readFile(path.join(dir, 'out', a.file)) : undefined,
        ext: a.file?.endsWith('.f32') ? 'f32' : a.file ? 'png' : undefined,
        preview: a.preview && a.preview !== a.file ? await readFile(path.join(dir, 'out', a.preview)) : undefined,
        accuracy: a.accuracy,
        quality: a.quality,
        min: a.min,
        max: a.max,
      });
    }
    const camera = (await readCamera(buf, frames[primary])) ?? (await readCamera(frames[primary].jpeg, frames[primary]));
    return { kind: 'heif', frames, primary, aux, camera, notes: out.notes };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Video through ffmpeg (frames come out upright: ffmpeg applies the rotation the file asks for).
async function decodeVideo(buf: Buffer): Promise<DecodedPhoto> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wom-video-'));
  try {
    const input = path.join(dir, 'input.mov');
    await writeFile(input, buf);
    let probe: { format?: { duration?: string; tags?: Record<string, string> }; streams?: { width?: number; height?: number; tags?: Record<string, string> }[] };
    try {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-select_streams', 'v:0', input], { timeout: 60_000 });
      probe = JSON.parse(stdout);
    } catch (err) {
      const missing = /ENOENT/.test(errorMessage(err));
      throw new PhotoError(missing ? 501 : 415, missing ? 'Videos need ffmpeg on the server (brew install ffmpeg).' : 'That video could not be read.');
    }
    const duration = Number(probe.format?.duration ?? 0);
    if (!probe.streams?.length) throw new PhotoError(415, 'That file has no video track.');
    const times = duration > 0 ? Array.from({ length: VIDEO_FRAMES }, (_, i) => (duration * (i + 0.5)) / VIDEO_FRAMES) : [0];
    const frames: PhotoFrame[] = [];
    for (const [i, t] of times.entries()) {
      const file = path.join(dir, `frame-${i}.jpg`);
      try {
        await run('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', input, '-frames:v', '1', '-q:v', '2', file], { timeout: 60_000 });
        const u = await upright(await readFile(file));
        frames.push({ index: i, timeS: t, ...u });
      } catch {
        // A frame past the end of a short clip; skip it.
      }
    }
    if (!frames.length) throw new PhotoError(415, 'No frame could be read from that video.');
    // Apple writes the lens into a Live Photo's QuickTime metadata.
    const tags = { ...(probe.format?.tags ?? {}), ...(probe.streams[0].tags ?? {}) };
    const tag = (k: string) => Object.entries(tags).find(([key]) => key.toLowerCase() === k)?.[1];
    const camera = cameraFrom({
      make: str(tag('com.apple.quicktime.make')),
      model: str(tag('com.apple.quicktime.model')),
      lens: str(tag('com.apple.quicktime.camera.lens_model')),
      focalLength35mm: num(tag('com.apple.quicktime.camera.focal_length.35mm_equivalent')),
      takenAt: str(tag('com.apple.quicktime.creationdate')) ?? str(tag('creation_time')),
    }, frames[0], 'video');
    return { kind: 'video', frames, primary: 0, aux: [], camera, notes: [] };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- storing an upload with its world ----------

/** The world's working photo (at most 2048 px) and its thumbnail, from the chosen frame. */
export async function sourceImages(frame: PhotoFrame) {
  const out = await sharp(frame.jpeg).resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const thumb = await sharp(out.data).resize(640, 640, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  return { jpeg: out.data, thumb, width: out.info.width, height: out.info.height };
}

/**
 * Write source.jpg and thumb.jpg, and keep what the upload held beyond one picture: the original file,
 * every frame, and the camera's depth and mattes (these describe the camera's own photo, so they are kept
 * only when that frame is the one used).
 */
export async function saveUpload(
  world: WorldHandle,
  photo: DecodedPhoto,
  opts: { frameIndex: number; input: Buffer; name: string; source: Awaited<ReturnType<typeof sourceImages>> },
) {
  await writeFileAtomic(world.file('source.jpg'), opts.source.jpeg);
  await writeFileAtomic(world.file('thumb.jpg'), opts.source.thumb);
  const extras: Partial<WorldManifest['image']> = photo.camera ? { camera: photo.camera } : {};
  if (photo.kind === 'heif' || photo.kind === 'video' || photo.frames.length > 1 || photo.aux.length) {
    const ext = photo.kind === 'heif' ? 'heic' : photo.kind === 'video' ? (/\.mp4$/i.test(opts.name) ? 'mp4' : 'mov') : photo.kind;
    const originalFile = `source/original.${ext}`;
    await writeFileAtomic(world.file(originalFile), opts.input);
    extras.original = { file: originalFile, kind: photo.kind, name: opts.name.slice(0, 200) };
    extras.frames = [];
    for (const f of photo.frames) {
      await writeFileAtomic(world.file(`source/frame-${f.index}.jpg`), f.jpeg);
      await writeFileAtomic(world.file(`source/frame-${f.index}-thumb.jpg`), f.thumb);
      extras.frames.push({ file: `source/frame-${f.index}.jpg`, thumb: `source/frame-${f.index}-thumb.jpg`, width: f.width, height: f.height, ...(f.timeS !== undefined ? { timeS: f.timeS } : {}) });
    }
    extras.frame = opts.frameIndex;
    if (opts.frameIndex === photo.primary && photo.aux.length) {
      extras.aux = [];
      for (const a of photo.aux) {
        const file = a.data ? `source/aux-${a.type}.${a.ext}` : undefined;
        if (file) await writeFileAtomic(world.file(file), a.data!);
        const preview = a.preview ? `source/aux-${a.type}-preview.png` : a.ext === 'png' ? file : undefined;
        if (a.preview) await writeFileAtomic(world.file(preview!), a.preview);
        extras.aux.push({ type: a.type, width: a.width, height: a.height, file, preview, accuracy: a.accuracy, quality: a.quality });
      }
    }
  }
  await world.update((m) => { Object.assign(m.image, extras); });
}
