// Durable image-to-video jobs. Each submission owns a first-frame snapshot and an AI3D idempotency key;
// restarting the server recovers the existing paid job instead of creating another one.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { downloadArtifact, findJobByKey, getJob, jobErrorText, listModels, submitJob, uploadImage, type Ai3dArtifact, type Ai3dJob, type SubmitJobBody } from './clients/ai3d.ts';
import { keysConfigured } from './config.ts';
import { cleanTitle, isSlideId, worldSlides } from './slides.ts';
import { getWorld, listWorlds, type WorldHandle } from './store.ts';
import type { VideoGeneration, VideoGenerationStatus } from './types.ts';
import { HttpError, nowIso, writeFileAtomic } from './util.ts';
import { characterCount, MAX_SLIDE_TITLE_CHARS, MAX_VIDEO_PROMPT_CHARS, videoInput, videoPromptTooLong } from './video-limits.ts';

const MODEL = 'h3-max-image-to-video';
const ACTIVE = new Set<VideoGenerationStatus>(['queued', 'uploading', 'generating', 'saving']);
const runFile = promisify(execFile);
const videoId = () => `v${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
export const isVideoId = (id: string) => /^v[a-z0-9]{12,40}$/.test(id);

export class VideoError extends Error {
  status: 400 | 404 | 409 | 413 | 503;
  constructor(status: VideoError['status'], message: string) { super(message); this.status = status; }
}

interface VideoRecord extends VideoGeneration {
  requestId: string;
  requestedTitle?: string;
  sourceFile: string;
  idempotencyKey: string;
  imageUrl?: string;
  submissionStartedAt?: string;
  jobId?: string;
  videoFile?: string;
  thumbnailFile?: string;
}

interface VideoProvider {
  listModels: typeof listModels;
  uploadImage: typeof uploadImage;
  submitJob: typeof submitJob;
  findJobByKey: typeof findJobByKey;
  getJob: typeof getJob;
  downloadArtifact: typeof downloadArtifact;
}
const provider: VideoProvider = { listModels, uploadImage, submitJob, findJobByKey, getJob, downloadArtifact };

function publicVideo(r: VideoRecord): VideoGeneration {
  const { id, world, slideId, title, prompt, status, createdAt, updatedAt, sourceImageUrl, videoUrl, thumbnailUrl, error } = r;
  return { id, world, slideId, title, prompt, status, createdAt, updatedAt, sourceImageUrl,
    ...(videoUrl ? { videoUrl } : {}), ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(error ? { error } : {}) };
}

async function readRecords(world: WorldHandle): Promise<VideoRecord[]> {
  let text: string;
  try { text = await readFile(world.file('videos.json'), 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
  const doc = JSON.parse(text) as { videos?: VideoRecord[] };
  if (!Array.isArray(doc.videos)) throw new Error('The world video history is invalid.');
  return doc.videos;
}

async function saveRecords(world: WorldHandle, records: VideoRecord[]) {
  // Deleting a world while its provider job finishes must not recreate its files.
  if (!existsSync(world.file('manifest.json'))) throw new Error('The world was deleted.');
  await writeFileAtomic(world.file('videos.json'), JSON.stringify({ videos: records }, null, 2));
}

/** Decode the source once so a queued job remains valid if its capture is later deleted. */
async function snapshot(world: WorldHandle, slideId: string, id: string) {
  const slide = (await worldSlides(world)).find((s) => s.id === slideId);
  if (!slide) throw new VideoError(404, 'This image is no longer in the world.');
  const prefix = `/files/${world.id}/`;
  if (!slide.image.url.startsWith(prefix)) throw new VideoError(400, 'The first frame must be a saved image in this world.');
  let source: string;
  try {
    const rel = decodeURIComponent(slide.image.url.slice(prefix.length));
    if (!rel || rel.includes('\0') || rel.includes('\\')) throw new Error('invalid image path');
    source = await realpath(world.file(rel));
    const base = await realpath(world.dir());
    if (!source.startsWith(base + path.sep)) throw new Error('image path escapes world');
  } catch { throw new VideoError(400, 'The first-frame image is unavailable.'); }
  const sourceFile = `videos/${id}-source.jpg`;
  // Captures are already JPEGs; decoding also checks that a manipulated scene cannot upload an unrelated file.
  let bytes: Buffer;
  try { bytes = await sharp(source).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 95 }).toBuffer(); }
  catch { throw new VideoError(400, 'The first frame must be a readable image.'); }
  if (bytes.byteLength > 10 * 1024 * 1024) throw new VideoError(413, 'The first frame is larger than the video service accepts.');
  await writeFileAtomic(world.file(sourceFile), bytes);
  return { sourceFile, title: slide.title };
}

/** ffprobe gives the actual duration; seeking to half distinguishes generations sharing a first frame. */
export async function extractMiddleFrame(videoFile: string, thumbnailFile: string): Promise<void> {
  const probe = await runFile(process.env.WOM_FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoFile], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The video duration is unavailable.');
  const tmp = `${thumbnailFile}.${process.pid}.tmp.jpg`;
  try {
    await runFile(process.env.WOM_FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(duration / 2), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', '-q:v', '3', tmp], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    await writeFileAtomic(thumbnailFile, await readFile(tmp));
  } finally { await rm(tmp, { force: true }); }
}

function videoArtifact(job: Ai3dJob): Ai3dArtifact | undefined {
  const artifacts = job.artifacts ?? [];
  return artifacts.find((a) => a.content_type?.split(';')[0] === 'video/mp4' || /\.mp4$/i.test(a.name))
    ?? artifacts.find((a) => a.content_type?.startsWith('video/') || /\.(?:webm|mov)$/i.test(a.name));
}
function artifactExtension(a: Ai3dArtifact) {
  return a.content_type?.startsWith('video/webm') || /\.webm$/i.test(a.name) ? 'webm'
    : a.content_type?.startsWith('video/quicktime') || /\.mov$/i.test(a.name) ? 'mov' : 'mp4';
}
function providerFailure(err: unknown, action: string) {
  // Never return provider response bodies, signed URLs, or credentials to the browser.
  if (err instanceof HttpError) {
    if (err.status === 402) return 'The video service has insufficient credit.';
    if (err.status === 401 || err.status === 403) return 'The server cannot access this video model. Check the AI3D key permissions.';
    if (err.status === 429) return 'The video service is busy. Please try again later.';
  }
  return `The video service could not ${action}. Please try again later.`;
}

/** A service instance also makes the paid provider boundary mockable without making real generations in tests. */
export class VideoService {
  private provider: VideoProvider;
  private thumbnail: typeof extractMiddleFrame;
  private pollMs: number;
  private writes = new Map<string, Promise<unknown>>();
  private running = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(opts: { provider?: VideoProvider; thumbnail?: typeof extractMiddleFrame; pollMs?: number } = {}) {
    this.provider = opts.provider ?? provider;
    this.thumbnail = opts.thumbnail ?? extractMiddleFrame;
    this.pollMs = opts.pollMs ?? 5000;
  }

  private serialized<T>(world: WorldHandle, fn: () => Promise<T>): Promise<T> {
    const run = (this.writes.get(world.id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    this.writes.set(world.id, run);
    void run.finally(() => { if (this.writes.get(world.id) === run) this.writes.delete(world.id); }).catch(() => undefined);
    return run;
  }

  private patch(world: WorldHandle, id: string, patch: Partial<VideoRecord>) {
    return this.serialized(world, async () => {
      const records = await readRecords(world);
      const record = records.find((r) => r.id === id);
      if (!record) throw new Error('The video generation no longer exists.');
      Object.assign(record, patch, { updatedAt: nowIso() });
      await saveRecords(world, records);
      return record;
    });
  }

  async create(world: WorldHandle, raw: unknown): Promise<VideoGeneration> {
    const body = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    if (typeof body.slideId !== 'string' || !isSlideId(body.slideId)) throw new VideoError(400, 'Choose a saved image for the first frame.');
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9._:-]{1,100}$/.test(body.requestId)) throw new VideoError(400, 'requestId must contain 1–100 letters, numbers, dots, colons, underscores or hyphens.');
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new VideoError(400, 'Enter a prompt for the video.');
    if (videoPromptTooLong(body.prompt)) throw new VideoError(413, `The video prompt is too long (${MAX_VIDEO_PROMPT_CHARS.toLocaleString('en-US')} characters and 16 KiB of model input maximum).`);
    if (body.title !== undefined && typeof body.title !== 'string') throw new VideoError(400, 'The video title must be text.');
    if (typeof body.title === 'string' && characterCount(body.title) > MAX_SLIDE_TITLE_CHARS) throw new VideoError(413, `The video title must be at most ${MAX_SLIDE_TITLE_CHARS} characters.`);
    const slideId = body.slideId, requestId = body.requestId, prompt = body.prompt;
    const requestedTitle = cleanTitle(body.title);
    const record = await this.serialized(world, async () => {
      const records = await readRecords(world);
      const existing = records.find((r) => r.requestId === requestId);
      if (existing) {
        if (existing.slideId !== slideId || existing.prompt !== prompt || existing.requestedTitle !== requestedTitle) throw new VideoError(409, 'This requestId was already used for a different video.');
        return existing;
      }
      if (records.filter((r) => ACTIVE.has(r.status)).length >= 8) throw new VideoError(409, 'Eight videos are already being generated in this world. Wait for one to finish.');
      if (records.length >= 1000) throw new VideoError(409, 'This world has reached its video history limit.');
      const id = videoId();
      const source = await snapshot(world, slideId, id);
      const now = nowIso();
      const record: VideoRecord = {
        id, world: world.id, slideId, title: requestedTitle ?? source.title, prompt, status: 'queued', createdAt: now, updatedAt: now,
        sourceImageUrl: `/files/${world.id}/${source.sourceFile}`, sourceFile: source.sourceFile,
        requestId, requestedTitle, idempotencyKey: `wom-video:${world.id}:${id}`,
      };
      await saveRecords(world, [...records, record]);
      return record;
    });
    void this.continue(world, record.id);
    return publicVideo(record);
  }

  async list(world: WorldHandle): Promise<VideoGeneration[]> {
    const records = await readRecords(world);
    for (const record of records) if (ACTIVE.has(record.status)) void this.continue(world, record.id);
    return records.map(publicVideo);
  }

  private schedule(world: WorldHandle, id: string) {
    if (this.disposed) return;
    const key = `${world.id}/${id}`;
    if (this.timers.has(key)) return;
    const timer = setTimeout(() => { this.timers.delete(key); void this.continue(world, id); }, this.pollMs);
    timer.unref();
    this.timers.set(key, timer);
  }

  /** Resume one network pass. Concurrent callers share it; the next provider poll is scheduled in the background. */
  continue(world: WorldHandle, id: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const key = `${world.id}/${id}`;
    const active = this.running.get(key);
    if (active) return active;
    const timer = this.timers.get(key);
    if (timer) { clearTimeout(timer); this.timers.delete(key); }
    const run = this.run(world, id).catch((err) => {
      // Persistence can fail or the world can be deleted. Its last durable state remains recoverable.
      console.error(`[videos] ${world.id}/${id}: ${err instanceof Error ? err.message : 'could not update video'}`);
      if (existsSync(world.file('manifest.json'))) this.schedule(world, id);
    }).finally(() => { if (this.running.get(key) === run) this.running.delete(key); });
    this.running.set(key, run);
    return run;
  }

  private async run(world: WorldHandle, id: string) {
    let r = (await readRecords(world)).find((record) => record.id === id);
    if (!r || !ACTIVE.has(r.status)) return;
    let job: Ai3dJob | null = null;
    if (!r.jobId && r.submissionStartedAt) {
      try { job = await this.provider.findJobByKey(r.idempotencyKey); }
      catch { this.schedule(world, id); return; }
      if (!job) {
        await this.patch(world, id, { status: 'submission_unknown', error: 'The submission could not be confirmed. Check the AI3D job before generating again; it may already have been accepted.' });
        return;
      }
      r = await this.patch(world, id, { jobId: job.id, status: 'generating', error: undefined });
    }
    if (!r.jobId) {
      try {
        if (!(await this.provider.listModels()).includes(MODEL)) {
          await this.patch(world, id, { status: 'failed', error: 'The image-to-video model is not available for this server.' });
          return;
        }
        r = await this.patch(world, id, { status: 'uploading', error: undefined });
        if (!r.imageUrl) {
          const imageUrl = await this.provider.uploadImage(await readFile(world.file(r.sourceFile)), `${id}.jpg`, 'image/jpeg');
          r = await this.patch(world, id, { imageUrl });
        }
      } catch (err) {
        await this.patch(world, id, { status: 'failed', error: providerFailure(err, 'prepare the first frame') });
        return;
      }
      // Persist before sending. A restart at any point beyond here goes through recovery, never a fresh submission.
      r = await this.patch(world, id, { status: 'generating', submissionStartedAt: nowIso() });
      try {
        const body: SubmitJobBody = { model: MODEL, image_url: r.imageUrl, input: videoInput(r.prompt) };
        job = await this.provider.submitJob(body, r.idempotencyKey);
      } catch (err) {
        try { job = await this.provider.findJobByKey(r.idempotencyKey); } catch { /* Uncertain submissions must not be charged again. */ }
        if (!job) {
          const definitive = err instanceof HttpError && [400, 401, 402, 403, 404, 413, 422].includes(err.status);
          await this.patch(world, id, { status: definitive ? 'failed' : 'submission_unknown', error: definitive ? providerFailure(err, 'start this video') : 'The submission could not be confirmed. Check the AI3D job before generating again; it may already have been accepted.' });
          return;
        }
      }
      if (!job?.id) {
        await this.patch(world, id, { status: 'submission_unknown', error: 'The video service did not return a job ID. Check the AI3D job before generating again.' });
        return;
      }
      r = await this.patch(world, id, { jobId: job.id, error: undefined });
    }
    if (!job || !['succeeded', 'failed', 'submission_unknown', 'canceled', 'cancelled'].includes(job.status)) {
      try { job = await this.provider.getJob(r.jobId!); }
      catch {
        await this.patch(world, id, { error: 'Waiting to reconnect to the video service. Your existing job will be checked again.' });
        this.schedule(world, id);
        return;
      }
    }
    if (job.status === 'failed' || job.status === 'canceled' || job.status === 'cancelled') {
      // Provider failure details may contain private URLs. Keep their response out of the public history.
      console.warn(`[videos] ${world.id}/${id} provider ${job.status}: ${jobErrorText(job).slice(0, 500)}`);
      await this.patch(world, id, { status: 'failed', error: job.status === 'failed' ? 'The video service could not complete this generation. You can try generating a new video.' : 'This video generation was canceled.' });
      return;
    }
    if (job.status === 'submission_unknown') {
      await this.patch(world, id, { status: 'submission_unknown', error: 'The provider could not confirm this submission. Check the AI3D job before generating again; it may already have been accepted.' });
      return;
    }
    if (job.status !== 'succeeded') {
      await this.patch(world, id, { status: 'generating', error: undefined });
      this.schedule(world, id);
      return;
    }
    const artifact = videoArtifact(job);
    if (!artifact) {
      await this.patch(world, id, { status: 'failed', error: 'The video service completed without returning a playable video.' });
      return;
    }
    const videoFile = r.videoFile ?? `videos/${id}.${artifactExtension(artifact)}`;
    r = await this.patch(world, id, { status: 'saving', videoFile, error: undefined });
    try {
      const exists = await stat(world.file(videoFile)).then((s) => s.size > 0).catch(() => false);
      if (!exists) await this.provider.downloadArtifact(artifact, world.file(videoFile));
    } catch {
      await this.patch(world, id, { error: 'Your video is complete. Retrying the download from the video service.' });
      this.schedule(world, id);
      return;
    }
    const thumbnailFile = `videos/${id}-thumb.jpg`;
    let hasThumbnail = existsSync(world.file(thumbnailFile));
    if (!hasThumbnail) {
      try { await this.thumbnail(world.file(videoFile), world.file(thumbnailFile)); hasThumbnail = true; }
      catch { console.warn(`[videos] ${world.id}/${id}: middle-frame thumbnail unavailable; the browser can extract it.`); }
    }
    await this.patch(world, id, {
      status: 'succeeded', videoUrl: `/files/${world.id}/${videoFile}`, error: undefined,
      ...(hasThumbnail ? { thumbnailFile, thumbnailUrl: `/files/${world.id}/${thumbnailFile}` } : {}),
    });
  }

  dispose() { this.disposed = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
}

const videos = new VideoService();
export function createVideoGeneration(world: WorldHandle, raw: unknown) {
  if (!keysConfigured().ai3d) throw new VideoError(503, 'AI3D_API_KEY must be configured in the server environment to generate videos.');
  return videos.create(world, raw);
}
export const listVideoGenerations = (world: WorldHandle) => videos.list(world);

/** Called at boot as well as on history reads; paid jobs continue even when their browser has closed. */
export async function resumeVideoGenerations() {
  for (const manifest of await listWorlds()) {
    const world = await getWorld(manifest.id);
    if (world) await videos.list(world).catch(() => console.error(`[videos] ${manifest.id}: could not read video history`));
  }
}
