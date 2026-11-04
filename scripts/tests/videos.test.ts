import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Ai3dArtifact, Ai3dJob, SubmitJobBody } from '../../server/src/clients/ai3d.ts';

// Every test uses disposable worlds and an injected provider; no generation or upload reaches AI3D.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wom-videos-test-'));
process.env.WOM_DATA_DIR = dataDir;
process.env.WOM_STORE = 'fs';
process.env.WOM_AUTH = 'off';
process.env.HOST = '127.0.0.1';
process.env.AI3D_API_KEY = 'test-only-key';
const { VideoService, VideoError, extractMiddleFrame } = await import('../../server/src/videos.ts');
const { DEFAULT_OPTIONS } = await import('../../server/src/config.ts');
const { createWorld } = await import('../../server/src/store.ts');
const { createSlide, deleteSlide } = await import('../../server/src/slides.ts');
const { writeFileAtomic } = await import('../../server/src/util.ts');
const { isPublicFile, setResolverForTests } = await import('../../server/src/access.ts');
const { app } = await import('../../server/src/index.ts');
const { MAX_SLIDE_TITLE_CHARS, MAX_VIDEO_PROMPT_CHARS, MAX_VIDEO_INPUT_BYTES, videoInputBytes } = await import('../../server/src/video-limits.ts');

const services: InstanceType<typeof VideoService>[] = [];
const realFetch = globalThis.fetch;
afterEach(() => { for (const service of services.splice(0)) service.dispose(); setResolverForTests(null); globalThis.fetch = realFetch; });
after(async () => { await rm(dataDir, { recursive: true, force: true }); });
const artifact: Ai3dArtifact = { name: 'provider-result-42.mp4', size: 16, content_type: 'video/mp4', download_url: 'https://download.test/private-video' };
const complete: Ai3dJob = { id: 'provider-job', model: 'h3-max-image-to-video', status: 'succeeded', artifacts: [artifact] };
const firstFrame = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#c55c36' } }).jpeg().toBuffer();
const calls = () => ({ uploads: 0, submits: [] as { body: SubmitJobBody; key: string }[], polls: 0, recoveries: 0, downloads: 0 });

function mockedProvider(c = calls()) {
  return {
    async listModels() { return ['h3-max-image-to-video']; },
    async uploadImage(bytes: Uint8Array, _filename: string, mime: string) {
      c.uploads++;
      assert.equal(mime, 'image/jpeg');
      assert.equal((await sharp(bytes).metadata()).width, 512);
      return 'https://uploads.test/first-frame.jpg';
    },
    async submitJob(body: SubmitJobBody, key: string) { c.submits.push({ body, key }); return complete; },
    async findJobByKey(_key: string): Promise<Ai3dJob | null> { c.recoveries++; return null; },
    async getJob(_id: string) { c.polls++; return complete; },
    async downloadArtifact(a: Ai3dArtifact, file: string) { c.downloads++; assert.equal(a.download_url, artifact.download_url); await writeFileAtomic(file, Buffer.from('a completed mp4')); },
  };
}
const thumbnail = async (_video: string, file: string) => { await writeFileAtomic(file, await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } }).jpeg().toBuffer()); };
function service(provider = mockedProvider(), thumb = thumbnail) {
  const s = new VideoService({ provider, thumbnail: thumb, pollMs: 60_000 });
  services.push(s);
  return s;
}
async function worldFixture(capture = false) {
  const world = await createWorld({ options: DEFAULT_OPTIONS, width: 512, height: 512, owner: { id: 'local' } });
  await writeFileAtomic(world.file('source.jpg'), firstFrame);
  await writeFileAtomic(world.file('thumb.jpg'), firstFrame);
  await writeFileAtomic(world.file('scene.json'), JSON.stringify({ camera: { fovY: 60, target: [0, 0, -3] }, image: { url: `/files/${world.id}/source.jpg`, width: 512, height: 512 } }));
  await world.update((m) => { m.scene = { file: 'scene.json', version: 1 }; m.status = 'done'; });
  if (!capture) return { world, slideId: 'photo' };
  const form = new FormData();
  form.set('record', JSON.stringify({ title: 'Saved sunset', caption: 'Make the clouds move.', entry: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovY: 60, aspect: 1 } }));
  form.set('image', new File([new Uint8Array(firstFrame)], 'capture.jpg', { type: 'image/jpeg' }));
  const slide = await createSlide(world, form);
  return { world, slideId: slide.id };
}
const request = (slideId = 'photo', requestId = 'request-1', prompt = '  Clouds drift across the sky.\nKeep the camera still.  ') => ({ slideId, requestId, prompt, title: 'Clouds' });

test('the real provider adapter uses server credentials and the documented AI3D upload/job/download endpoints', async () => {
  const { world } = await worldFixture();
  const seen: string[] = [];
  globalThis.fetch = async (url, init) => {
    const address = String(url);
    seen.push(address);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-only-key');
    if (address.endsWith('/models?format=json')) return Response.json({ models: [{ id: 'h3-max-image-to-video' }] });
    if (address.endsWith('/uploads')) {
      assert.equal(init?.method, 'POST');
      assert.ok(init?.body instanceof FormData);
      assert.ok(init.body.get('image') instanceof File);
      return Response.json({ image_url: 'https://uploads.test/first-frame.jpg' });
    }
    if (address.endsWith('/jobs')) {
      assert.equal(init?.method, 'POST');
      assert.match((init.headers as Record<string, string>)['Idempotency-Key'], /^wom-video:/);
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, 'h3-max-image-to-video');
      assert.equal(body.image_url, 'https://uploads.test/first-frame.jpg');
      assert.equal(body.input.prompt, request().prompt);
      return Response.json(complete, { status: 202 });
    }
    if (address === artifact.download_url) return new Response('playable video bytes');
    throw new Error(`Unexpected provider request: ${address}`);
  };
  const s = new VideoService({ thumbnail, pollMs: 60_000 });
  services.push(s);
  const r = await s.create(world, request());
  await s.continue(world, r.id);
  assert.equal((await s.list(world))[0].status, 'succeeded');
  assert.equal(seen.length, 4);
});

test('a capture uses its own durable first frame and exact prompt, with safe public URLs', async () => {
  const { world, slideId } = await worldFixture(true);
  const c = calls();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider = mockedProvider(c);
  let uploaded: Buffer | undefined;
  const upload = provider.uploadImage;
  provider.uploadImage = async (bytes, filename, mime) => { uploaded = Buffer.from(bytes); return upload(bytes, filename, mime); };
  provider.listModels = async () => { await gate; return ['h3-max-image-to-video']; };
  const s = service(provider);
  const r = await s.create(world, request(slideId));
  // The source capture can disappear before its queued upload starts.
  await deleteSlide(world, slideId);
  release();
  await s.continue(world, r.id);
  const result = (await s.list(world))[0];
  assert.equal(result.status, 'succeeded');
  assert.equal(c.uploads, 1);
  assert.equal(c.downloads, 1);
  assert.equal(c.submits.length, 1);
  assert.deepEqual(c.submits[0].body, {
    model: 'h3-max-image-to-video', image_url: 'https://uploads.test/first-frame.jpg',
    input: { prompt: request(slideId).prompt, duration: 5, resolution: '768P', sync_mode: false, prompt_expansion_mode: 'balanced' },
  });
  assert.match(c.submits[0].key, /^wom-video:/);
  assert.ok(result.sourceImageUrl.endsWith(`/${r.id}-source.jpg`));
  assert.ok(result.thumbnailUrl?.endsWith(`/${r.id}-thumb.jpg`));
  assert.ok(result.videoUrl?.endsWith(`/${r.id}.mp4`));
  assert.deepEqual(await readFile(world.file(`videos/${r.id}-source.jpg`)), uploaded);
  assert.ok(!JSON.stringify(result).includes('provider-job'));
  assert.ok(!JSON.stringify(result).includes('uploads.test'));
  assert.ok(!JSON.stringify(result).includes('requestId'));
});

test('simultaneous retries are idempotent, but repeating a prompt with a new request creates a new video', async () => {
  const { world } = await worldFixture();
  const c = calls(), s = service(mockedProvider(c));
  const [a, b] = await Promise.all([s.create(world, request()), s.create(world, request())]);
  assert.equal(a.id, b.id);
  await s.continue(world, a.id);
  await assert.rejects(s.create(world, { ...request(), prompt: 'A different prompt.' }), (err: unknown) => err instanceof VideoError && err.status === 409);
  const next = await s.create(world, request('photo', 'request-2'));
  await s.continue(world, next.id);
  assert.notEqual(a.id, next.id);
  assert.equal(c.submits.length, 2);
  assert.notEqual(c.submits[0].key, c.submits[1].key);
  assert.equal((await s.list(world)).length, 2);
});

test('invalid requests and external first-frame paths cannot reach the paid provider', async () => {
  const { world } = await worldFixture();
  const c = calls(), s = service(mockedProvider(c));
  for (const body of [null, { ...request(), requestId: undefined }, { ...request(), requestId: '../../unsafe' }, { ...request(), prompt: '  ' }, { ...request(), prompt: 1 }, { ...request(), slideId: '../../source' }]) {
    await assert.rejects(s.create(world, body), (err: unknown) => err instanceof VideoError && err.status === 400);
  }
  for (const prompt of ['x'.repeat(16_001), '🌧'.repeat(6000)]) {
    await assert.rejects(s.create(world, request('photo', 'long-prompt', prompt)), (err: unknown) => err instanceof VideoError && err.status === 413);
  }
  const other = await worldFixture();
  await writeFileAtomic(other.world.file('scene.json'), JSON.stringify({ camera: { fovY: 60, target: [0, 0, -3] }, image: { url: 'https://example.test/untrusted.jpg', width: 512, height: 512 } }));
  await assert.rejects(s.create(other.world, request()), (err: unknown) => err instanceof VideoError && err.status === 400);
  assert.equal(c.uploads, 0);
  assert.equal(c.submits.length, 0);
});

test('prompt and title limits accept the boundary and reject Unicode or escaped input beyond it', async () => {
  const { world } = await worldFixture();
  const c = calls(), s = service(mockedProvider(c));
  const title = '🌧'.repeat(MAX_SLIDE_TITLE_CHARS);
  const atCharacterLimit = 'x'.repeat(MAX_VIDEO_PROMPT_CHARS);
  const first = await s.create(world, { ...request('photo', 'character-limit', atCharacterLimit), title });
  await s.continue(world, first.id);
  assert.equal(first.title, title);
  assert.equal(c.submits[0].body.input?.prompt, atCharacterLimit);

  // AI3D's ASCII JSON escaping can reach its 16 KiB input cap before the character cap.
  const room = MAX_VIDEO_INPUT_BYTES - videoInputBytes('');
  assert.equal(videoInputBytes('é') - videoInputBytes(''), 6);
  assert.equal(videoInputBytes('🌧') - videoInputBytes(''), 12);
  assert.equal(videoInputBytes('"') - videoInputBytes(''), 2);
  const atByteLimit = 'é'.repeat(Math.floor(room / 6)) + 'x'.repeat(room % 6);
  assert.equal(videoInputBytes(atByteLimit), MAX_VIDEO_INPUT_BYTES);
  const second = await s.create(world, request('photo', 'byte-limit', atByteLimit));
  await s.continue(world, second.id);
  assert.equal(c.submits[1].body.input?.prompt, atByteLimit);

  for (const prompt of [atCharacterLimit + 'x', atByteLimit + 'x', '"'.repeat(Math.floor(room / 2) + 1)]) {
    await assert.rejects(s.create(world, request('photo', 'too-long', prompt)), (err: unknown) => err instanceof VideoError && err.status === 413);
  }
  await assert.rejects(s.create(world, { ...request('photo', 'long-title'), title: title + '🌧' }), (err: unknown) => err instanceof VideoError && err.status === 413);
  assert.equal(c.submits.length, 2, 'invalid input must never reach the provider');
});

test('slide and video HTTP endpoints enforce title limits and preserve long saved motion prompts', async () => {
  const { world, slideId } = await worldFixture(true);
  setResolverForTests(async () => ({ user: { id: 'local', handle: 'local', role: 'admin' }, cookies: [] }));
  const slideUrl = `/api/worlds/${world.id}/slides/${slideId}`;
  const patchSlide = (body: unknown) => app.request(slideUrl, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const title = '🌧'.repeat(MAX_SLIDE_TITLE_CHARS);
  const accepted = await patchSlide({ title });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).title, title);
  assert.equal((await patchSlide({ title: title + '🌧' })).status, 413);

  const prompt = 'A long motion prompt. '.repeat(600);
  const saved = await patchSlide({ caption: prompt });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).caption, prompt.trim());
  const slides = await app.request(`/api/worlds/${world.id}/slides`);
  assert.equal((await slides.json()).find((slide: { id: string }) => slide.id === slideId).caption, prompt.trim());

  const postVideo = (body: unknown) => app.request(`/api/worlds/${world.id}/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await postVideo({ ...request(slideId), title: title + '🌧' })).status, 413);
  assert.equal((await postVideo(request(slideId, 'long-prompt-http', '🌧'.repeat(6000)))).status, 413);
});

test('restart recovery finds the already accepted paid job without uploading or submitting again', async () => {
  const { world } = await worldFixture();
  const first = mockedProvider();
  first.submitJob = async () => ({ ...complete, status: 'queued', artifacts: [] });
  first.getJob = async () => ({ ...complete, status: 'running', artifacts: [] });
  const initial = service(first);
  const r = await initial.create(world, request());
  await initial.continue(world, r.id);
  initial.dispose();
  const stored = JSON.parse(await readFile(world.file('videos.json'), 'utf8'));
  delete stored.videos[0].jobId; // The server stopped after submission but before saving its response.
  await writeFileAtomic(world.file('videos.json'), JSON.stringify(stored));
  const c = calls(), provider = mockedProvider(c);
  provider.findJobByKey = async (key) => { c.recoveries++; assert.equal(key, stored.videos[0].idempotencyKey); return complete; };
  const resumed = service(provider);
  await resumed.list(world);
  await resumed.continue(world, r.id);
  assert.equal((await resumed.list(world))[0].status, 'succeeded');
  assert.equal(c.recoveries, 1);
  assert.equal(c.uploads, 0);
  assert.equal(c.submits.length, 0);
  assert.equal(c.downloads, 1);
});

test('ambiguous submissions remain unknown and never automatically create another paid job', async () => {
  const { world } = await worldFixture();
  const c = calls(), provider = mockedProvider(c);
  provider.submitJob = async (body, key) => { c.submits.push({ body, key }); throw new TypeError('Connection closed after sending'); };
  const s = service(provider);
  const r = await s.create(world, request());
  await s.continue(world, r.id);
  assert.equal((await s.list(world))[0].status, 'submission_unknown');
  await s.continue(world, r.id);
  s.dispose();
  const resumed = service(provider);
  await resumed.list(world);
  await resumed.continue(world, r.id);
  assert.equal(c.submits.length, 1);
  assert.equal(c.recoveries, 1);
});

test('temporary polling and download failures retry the existing job; thumbnail failure keeps playback available', async () => {
  const { world } = await worldFixture();
  const c = calls(), provider = mockedProvider(c);
  provider.submitJob = async (body, key) => { c.submits.push({ body, key }); return { ...complete, status: 'queued', artifacts: [] }; };
  provider.getJob = async () => { if (c.polls++ === 0) throw new TypeError('offline'); return complete; };
  provider.downloadArtifact = async (_artifact, file) => { if (c.downloads++ === 0) throw new TypeError('offline'); await writeFileAtomic(file, Buffer.from('mp4')); };
  const s = service(provider, async () => { throw new Error('ffmpeg is unavailable'); });
  const r = await s.create(world, request());
  await s.continue(world, r.id);
  assert.equal((await s.list(world))[0].status, 'generating');
  await s.continue(world, r.id);
  assert.equal((await s.list(world))[0].status, 'saving');
  await s.continue(world, r.id);
  const result = (await s.list(world))[0];
  assert.equal(result.status, 'succeeded');
  assert.ok(result.videoUrl);
  assert.equal(result.thumbnailUrl, undefined);
  assert.equal(c.submits.length, 1);
  assert.equal(c.downloads, 2);
});

test('completed histories restore missing or corrupt middle frames without changing the generating image', async () => {
  const { world } = await worldFixture();
  const c = calls(), s = service(mockedProvider(c));
  const created = await s.create(world, request());
  await s.continue(world, created.id);
  s.dispose();
  const source = world.file(`videos/${created.id}-source.jpg`);
  const before = await readFile(source);
  const thumb = world.file(`videos/${created.id}-thumb.jpg`);
  await writeFileAtomic(thumb, 'not a JPEG');
  const history = JSON.parse(await readFile(world.file('videos.json'), 'utf8'));
  delete history.videos[0].thumbnailFile;
  delete history.videos[0].thumbnailUrl;
  await writeFileAtomic(world.file('videos.json'), JSON.stringify(history));

  let repairs = 0;
  const resumed = service(mockedProvider(c), async (video, file) => {
    repairs++;
    assert.equal(video, world.file(`videos/${created.id}.mp4`));
    await thumbnail(video, file);
  });
  await Promise.all(Array.from({ length: 5 }, () => resumed.list(world)));
  const until = Date.now() + 3000;
  let result = (await resumed.list(world))[0];
  while (!result.thumbnailUrl && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = (await resumed.list(world))[0];
  }
  assert.equal(result.thumbnailUrl, `/files/${world.id}/videos/${created.id}-thumb.jpg`);
  assert.equal((await sharp(thumb).metadata()).format, 'jpeg');
  assert.deepEqual(await readFile(source), before);
  assert.equal(repairs, 1);
  assert.equal(c.submits.length, 1);
  assert.equal(c.downloads, 1);
});

test('a failed middle-frame extraction retries without resubmitting or hiding the finished video', async () => {
  const { world } = await worldFixture();
  const c = calls();
  let attempts = 0;
  const s = new VideoService({
    provider: mockedProvider(c), pollMs: 60_000, frameRetryMs: 20,
    thumbnail: async (video, file) => {
      if (++attempts < 3) throw new Error('temporarily unavailable');
      await thumbnail(video, file);
    },
  });
  services.push(s);
  const created = await s.create(world, request());
  await s.continue(world, created.id);
  assert.equal((await s.list(world))[0].status, 'succeeded');
  const until = Date.now() + 3000;
  let result = (await s.list(world))[0];
  while (!result.thumbnailUrl && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = (await s.list(world))[0];
  }
  assert.ok(result.thumbnailUrl);
  assert.equal(attempts, 3);
  assert.equal(c.submits.length, 1);
  assert.equal(c.downloads, 1);
});

test('a missing generating snapshot is not replaced by the current slide or video frame', async () => {
  const { world } = await worldFixture();
  const s = service();
  const created = await s.create(world, request());
  await s.continue(world, created.id);
  s.dispose();
  const source = world.file(`videos/${created.id}-source.jpg`);
  await rm(source);
  await rm(world.file(`videos/${created.id}-thumb.jpg`));
  let audited!: () => void;
  const sourceChecked = new Promise<void>((resolve) => { audited = resolve; });
  const resumed = service(mockedProvider(), async (video, file) => { audited(); await thumbnail(video, file); });
  await resumed.list(world);
  await sourceChecked;
  await assert.rejects(readFile(source), { code: 'ENOENT' });
});

test('missing model fails clearly before an upload or paid submission', async () => {
  const { world } = await worldFixture();
  const c = calls(), provider = mockedProvider(c);
  provider.listModels = async () => ['different-model'];
  const s = service(provider);
  const r = await s.create(world, request());
  await s.continue(world, r.id);
  const result = (await s.list(world))[0];
  assert.equal(result.status, 'failed');
  assert.match(result.error!, /not available/);
  assert.equal(c.uploads, 0);
  assert.equal(c.submits.length, 0);
});

test('shared history and video files are readable, private metadata is hidden, and viewers cannot generate', async () => {
  const { world } = await worldFixture();
  const s = service();
  const r = await s.create(world, request());
  await s.continue(world, r.id);
  const record = (await s.list(world))[0];
  assert.equal(isPublicFile(`videos/${r.id}.mp4`), true);
  assert.equal(isPublicFile(`videos/${r.id}-thumb.jpg`), true);
  assert.equal(isPublicFile(`videos/${r.id}-source.jpg`), true);
  assert.equal(isPublicFile('videos.json'), false);
  assert.equal(isPublicFile('videos/provider-private.json'), false);
  setResolverForTests(async () => ({ user: null, cookies: [] }));
  const history = await app.request(`/api/worlds/${world.id}/videos`);
  assert.equal(history.status, 200);
  assert.equal((await history.json())[0].id, r.id);
  assert.equal((await app.request(record.videoUrl!)).status, 200);
  assert.equal((await app.request(`/files/${world.id}/videos.json`)).status, 404);
  assert.equal((await app.request(`/api/worlds/${world.id}/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) })).status, 401);
});

test('MP4 byte ranges support browser seeking, suffix ranges, and invalid-range responses', async () => {
  const { world } = await worldFixture();
  const id = 'vtest1234567890';
  const bytes = Buffer.from('0123456789abcdef');
  await writeFileAtomic(world.file(`videos/${id}.mp4`), bytes);
  setResolverForTests(async () => ({ user: null, cookies: [] }));
  const url = `/files/${world.id}/videos/${id}.mp4`;
  const whole = await app.request(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('Content-Type'), 'video/mp4');
  assert.equal(whole.headers.get('Accept-Ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), bytes);
  for (const [range, body, contentRange] of [['bytes=2-5', '2345', 'bytes 2-5/16'], ['bytes=12-', 'cdef', 'bytes 12-15/16'], ['bytes=-4', 'cdef', 'bytes 12-15/16'], ['bytes=12-99', 'cdef', 'bytes 12-15/16']]) {
    const response = await app.request(url, { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(await response.text(), body);
  }
  for (const range of ['bytes=16-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,4-5', 'bytes=-', 'bytes=999999999999999999999-']) {
    const response = await app.request(url, { headers: { Range: range } });
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('Content-Range'), 'bytes */16');
  }
  // Request validation also runs at the real HTTP boundary without reaching a provider.
  setResolverForTests(async () => ({ user: { id: 'local', handle: 'local', role: 'admin' }, cookies: [] }));
  const response = await app.request(`/api/worlds/${world.id}/videos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slideId: 'photo', prompt: 'Move the clouds.' }) });
  assert.equal(response.status, 400);
});

test('thumbnail extraction selects the middle of the actual video instead of its first frame', async (t) => {
  const run = promisify(execFile);
  try { await run('ffmpeg', ['-version']); await run('ffprobe', ['-version']); }
  catch { t.skip('ffmpeg and ffprobe are optional on this machine'); return; }
  const file = path.join(dataDir, 'middle-frame.mp4'), thumb = path.join(dataDir, 'middle-frame.jpg');
  // The first second is red; the three seconds after it are blue. The midpoint must be blue.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10:d=3', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { timeout: 30_000 });
  await extractMiddleFrame(file, thumb);
  const stats = await sharp(await readFile(thumb)).stats();
  assert.ok(stats.channels[2].mean > stats.channels[0].mean + 150, 'middle-frame thumbnail should show the later blue frames');
});
