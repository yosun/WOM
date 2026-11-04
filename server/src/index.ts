// WOM API server: uploads, world pipeline control, live progress (SSE), and artifact files.
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import sharp from 'sharp';
import { accountBalanceUsd } from './clients/ai3d.ts';
import { DEFAULT_OPTIONS, HOST, PORT, PUBLIC_ORIGIN, SIGN_IN_REQUIRED, STORE, WEB_DIST, WORLD_CREDITS, keysConfigured, normalizeOptions, retryOptions } from './config.ts';
import { balanceOf, CreditsError, holdForRetry, holdForWorld, mintPromo, redeemPromo, refundFailedWorlds, refundWorld } from './credits.ts';
import { handleWebhook, packsFor, STRIPE_TEST_MODE } from './stripe.ts';
import { guard, identify, levelOf, publicManifest, type AppEnv } from './access.ts';
import { authConfig, clerkConfigured } from './auth.ts';
import { appendLedger, ledgerExists } from './ledger.ts';
import { ensureAssetRegistry } from './pipeline/assets.ts';
import { applyPlacement } from './pipeline/placements.ts';
import { metricsRoutes } from './bench/suite.ts';
import { applyFix, suggestFixes } from './observe/fixes.ts';
import { createObservation, ensureThumbnail, getObservation, isObservationId, isThumbName, listIssues, listObservations, observationFilePath, ObservationError, resolveIssue, updateObservation, updateObservations } from './observe/store.ts';
import { checkWorldAssets, uncheckedAssets } from './pipeline/assetcheck.ts';
import { cameraReport } from './pipeline/camera.ts';
import { OBJECT_MODELS } from './pipeline/generate.ts';
import { decodePhoto, PhotoError, saveUpload, sourceImages, type DecodedPhoto } from './pipeline/photo.ts';
import { applyDraftMask, MaskError, parseMaskPrompt, previewMask, restoreMask } from './pipeline/remask.ts';
import { generateAssets, prepareRetry, isRunning, recompose, runPlacementAgents, startTask, startWorld, switchObjectAsset, switchObjectModel } from './pipeline/run.ts';
import { allSlides, createSlide, deleteSlide, updateSlide, SlideError, worldSlides } from './slides.ts';
import { createWorld, deleteWorld, forgetAccess, getWorld, isWorldId, listWorlds, listWorldsFor, setVisibility, worldAccess, worldEvents, worldFile } from './store.ts';
import { AGENT_PLACEMENTS, CHECK_PRICE_USD, OBSERVATION_STATUSES, PLACEMENT_METHODS, type ObservationStatus, type CameraInfo, type LayoutOverride, type MeshModel, type PlacementMethod, type PlannerModel, type SceneDoc, type WorldEvent, type WorldManifest, type WorldOptions } from './types.ts';
import { withPreview } from './share.ts';
import { HandleError, setHandle } from './users.ts';
import { errorMessage, writeFileAtomic } from './util.ts';

/** Photos are far smaller; the limit leaves room for short videos such as a Live Photo's .MOV. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.spz': 'application/octet-stream',
  '.json': 'application/json',
  '.exr': 'image/x-exr',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  console.error('[http]', err);
  return c.json({ error: errorMessage(err) }, 500);
});

// Who is asking, and what each route lets them do (access.ts). A world shared by link can be looked at by anyone; making
// worlds needs a signed-in person; changing a world is its owner's; a route with no rule is for administrators. The
// guard also covers the routes that metricsRoutes() adds further down, and /files and /bench-files, which sit outside /api.
for (const prefix of ['/api/*', '/files/*', '/bench-files/*']) {
  app.use(prefix, identify);
  app.use(prefix, guard);
}
app.get('/api/auth/config', authConfig);

app.get('/api/health', (c) => c.get('user') ? c.json({ ok: true, keys: keysConfigured(), defaults: DEFAULT_OPTIONS }) : c.json({ ok: true }));

// Who the visitor is: null for someone who is not signed in. The page reads this to decide what to offer.
app.get('/api/me', (c) => {
  const user = c.get('user');
  return c.json({ user: user && { id: user.id, handle: user.handle, role: user.role }, signInRequired: SIGN_IN_REQUIRED, shares: STORE === 'postgres' });
});

// Rename yourself in links: { handle }. Links made with the old name keep working, because a world is found by its id.
app.put('/api/me/handle', async (c) => {
  const user = c.get('user')!;
  if (STORE !== 'postgres') return c.json({ error: 'Names are kept in the database: start the server with WOM_STORE=postgres.' }, 409);
  try {
    const next = await setHandle(user, ((await c.req.json().catch(() => null)) as { handle?: unknown } | null)?.handle);
    forgetAccess();
    return c.json({ user: { id: next.id, handle: next.handle, role: next.role } });
  } catch (err) {
    if (err instanceof HandleError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// Credits pay for building worlds. An administrator, and a server with no database, build for free.
app.get('/api/credits', async (c) => {
  const user = c.get('user')!;
  const unlimited = STORE !== 'postgres' || user.role === 'admin';
  const balance = STORE === 'postgres' ? await balanceOf({ id: user.id, role: user.role }) : null;
  // Packs are offered only where a payment can be turned into credits: a database, and the secret that proves a webhook is Stripe's.
  const packs = STORE === 'postgres' && process.env.STRIPE_WEBHOOK_SECRET?.trim() ? packsFor(user.id) : [];
  return c.json({ balance, worldCredits: WORLD_CREDITS, unlimited, canCreate: unlimited || (balance ?? 0) >= WORLD_CREDITS, packs, testMode: STRIPE_TEST_MODE });
});

// Stripe says here that a pack was paid for. No cookie or token: the signature is the proof (stripe.ts). The body is small.
app.post('/api/stripe/webhook', bodyLimit({ maxSize: 512 * 1024, onError: (c) => c.json({ error: 'too large' }, 413) }), async (c) => {
  const result = await handleWebhook(await c.req.text(), c.req.header('stripe-signature'));
  return c.json(result.body, result.status);
});

// Add a promo code's credits to your balance: { code }.
app.post('/api/credits/redeem', async (c) => {
  const user = c.get('user')!;
  if (STORE !== 'postgres') return c.json({ error: 'Credits are kept in the database: start the server with WOM_STORE=postgres.' }, 409);
  try {
    const balance = await redeemPromo({ id: user.id, role: user.role }, ((await c.req.json().catch(() => null)) as { code?: unknown } | null)?.code);
    return c.json({ balance, worldCredits: WORLD_CREDITS });
  } catch (err) {
    if (err instanceof CreditsError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// Administrators: make a promo code, { credits, maxRedemptions?, expiresInDays?, note? }. The code is in this answer and nowhere else.
app.post('/api/admin/promo', async (c) => {
  if (STORE !== 'postgres') return c.json({ error: 'Promo codes are kept in the database: start the server with WOM_STORE=postgres.' }, 409);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { credits?: unknown; maxRedemptions?: unknown; expiresInDays?: unknown; note?: unknown };
  const days = body.expiresInDays === undefined ? null : Number(body.expiresInDays);
  if (days !== null && !(days > 0 && days <= 3650)) return c.json({ error: 'expiresInDays must be between 1 and 3650.' }, 400);
  try {
    const code = await mintPromo({
      credits: Number(body.credits),
      maxRedemptions: body.maxRedemptions === undefined ? 1 : Number(body.maxRedemptions),
      expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000),
      note: typeof body.note === 'string' ? body.note.slice(0, 200) : undefined,
    });
    return c.json({ code }, 201);
  } catch (err) {
    if (err instanceof CreditsError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.get('/api/account', async (c) => {
  try {
    return c.json({ ai3dBalanceUsd: await accountBalanceUsd() });
  } catch (err) {
    return c.json({ ai3dBalanceUsd: null, error: errorMessage(err) });
  }
});

// The worlds you own. An administrator can ask for everyone's with ?all=1.
app.get('/api/worlds', async (c) => {
  const user = c.get('user')!;
  const worlds = await listWorldsFor({ id: user.id, role: user.role }, c.req.query('all') === '1');
  return c.json(worlds.map((w) => ({ ...w, running: isRunning(w.id) })));
});

/** Read the uploaded file from a form and decode it (every frame, Apple's depth and mattes, the lens). */
async function readUpload(c: Context): Promise<{ form: FormData; name: string; input: Buffer; photo: DecodedPhoto } | Response> {
  const form = await c.req.formData();
  const file = form.get('image');
  if (!(file instanceof File)) return c.json({ error: 'Attach the photo as form field "image".' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: `The file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` }, 413);
  const input = Buffer.from(await file.arrayBuffer());
  try {
    return { form, name: file.name, input, photo: await decodePhoto(input) };
  } catch (err) {
    if (err instanceof PhotoError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

const dataUrl = (jpeg: Buffer) => `data:image/jpeg;base64,${jpeg.toString('base64')}`;

function cameraLine(cam: CameraInfo | undefined) {
  if (!cam) return 'no lens data';
  const who = [cam.make, cam.model].filter(Boolean).join(' ');
  const lens = cam.focalLength35mm ? `${cam.focalLength35mm} mm equivalent` : cam.focalLengthMm ? `${cam.focalLengthMm} mm` : '';
  return [who, lens, cam.hfovDeg ? `${cam.hfovDeg.toFixed(1)}° field of view` : ''].filter(Boolean).join(', ') || 'no lens data';
}

// What an upload holds before a world is made from it: its frames (to pick one), depth and mattes, and the lens.
app.post('/api/inspect', async (c) => {
  const up = await readUpload(c);
  if (up instanceof Response) return up;
  const { photo } = up;
  return c.json({
    kind: photo.kind,
    primary: photo.primary,
    frames: photo.frames.map((f) => ({ index: f.index, width: f.width, height: f.height, timeS: f.timeS, thumb: dataUrl(f.thumb) })),
    aux: photo.aux.map((a) => ({ type: a.type, width: a.width, height: a.height, accuracy: a.accuracy })),
    camera: photo.camera,
    cameraLine: cameraLine(photo.camera),
    notes: photo.notes,
  });
});

app.post('/api/worlds', async (c) => {
  const keys = keysConfigured();
  if (!keys.meta || !keys.ai3d) return c.json({ error: 'MUSE_API_KEY and AI3D_API_KEY must be set in .env' }, 400);
  // A world costs credits, unless the person is an administrator or the server keeps no accounts. Looked at before the upload is read.
  const user = c.get('user')!;
  const metered = STORE === 'postgres' && user.role !== 'admin';
  if (metered) {
    const balance = await balanceOf({ id: user.id, role: user.role });
    if (balance < WORLD_CREDITS) return c.json({ error: `A world costs ${WORLD_CREDITS} credits. You have ${balance}.`, credits: true, balance, needed: WORLD_CREDITS }, 402);
  }
  const up = await readUpload(c);
  if (up instanceof Response) return up;
  const { form, name, input, photo } = up;
  let options: WorldOptions;
  try {
    const raw = form.get('options');
    options = normalizeOptions(typeof raw === 'string' && raw ? JSON.parse(raw) : undefined);
  } catch {
    return c.json({ error: 'options must be JSON' }, 400);
  }
  const rawFrame = form.get('frame');
  const frameIndex = typeof rawFrame === 'string' && rawFrame !== '' ? Number(rawFrame) : photo.primary;
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= photo.frames.length) return c.json({ error: `frame must be 0–${photo.frames.length - 1}` }, 400);
  const source = await sourceImages(photo.frames[frameIndex]);
  if (source.width < 256 || source.height < 256) return c.json({ error: 'The photo must be at least 256 pixels on each side.' }, 400);
  const world = await createWorld({ options, width: source.width, height: source.height, owner: user });
  if (metered) {
    // Taken here, before anything that costs money starts. Two uploads at once cannot both spend the same credits.
    try {
      await holdForWorld({ id: user.id, role: user.role }, world.id, WORLD_CREDITS);
    } catch (err) {
      await deleteWorld(world.id);
      if (err instanceof CreditsError) return c.json({ error: `A world costs ${WORLD_CREDITS} credits. You have ${err.balance ?? 0}.`, credits: true, balance: err.balance ?? 0, needed: WORLD_CREDITS }, 402);
      throw err;
    }
  }
  try {
    await saveUpload(world, photo, { frameIndex, input, name, source });
  } catch (err) {
    // Nothing was built, so nothing is owed. If the credits cannot be given back, the world is kept so that they can still be found.
    if (metered) await refundWorld({ id: user.id, role: user.role }, world.id);
    await deleteWorld(world.id);
    throw err;
  }
  const { width, height } = source;
  const held = [photo.frames.length > 1 ? `${photo.frames.length} frames (using ${frameIndex + 1})` : '', photo.aux.length ? `camera ${photo.aux.map((a) => a.type).join(', ')}` : ''].filter(Boolean).join('; ');
  world.log(`Created from "${name}" (${photo.kind}, ${width}×${height}${held ? `; ${held}` : ''}); lens: ${cameraLine(photo.camera)}; options ${JSON.stringify(options)}`);
  for (const n of photo.notes) world.log(`upload: ${n}`);
  void startWorld(world);
  return c.json(world.manifest, 201);
});

// The real camera against each depth model: field of view (from EXIF) and depth (from an iPhone's depth map).
app.get('/api/worlds/:id/camera', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  return c.json(await cameraReport(world));
});

app.get('/api/cameras', async (c) => {
  const out = [];
  for (const m of await listWorlds()) {
    const world = await getWorld(m.id);
    if (world) out.push(await cameraReport(world).catch(() => null));
  }
  return c.json(out.filter(Boolean));
});

async function requireWorld(c: Context) {
  const id = c.req.param('id') ?? '';
  return isWorldId(id) ? getWorld(id) : null;
}

// A world, for whoever may look at it. Its owner gets the whole manifest and the build log; a visitor gets what the viewer needs.
app.get('/api/worlds/:id', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const access = c.get('access') ?? (await worldAccess(world.id));
  const canEdit = access !== null && levelOf(c.get('user'), access) === 'owner';
  return c.json({
    manifest: canEdit ? world.manifest : publicManifest(world.manifest),
    log: canEdit ? world.recentLog() : [],
    running: isRunning(world.id),
    access: { handle: access?.handle ?? null, visibility: access?.visibility ?? 'link', canEdit },
  });
});

// Who can look at the world: { visibility: 'link' } (anyone with the link) or { visibility: 'private' } (only you).
app.put('/api/worlds/:id/visibility', async (c) => {
  const user = c.get('user')!;
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const visibility = ((await c.req.json().catch(() => null)) as { visibility?: unknown } | null)?.visibility;
  if (visibility !== 'link' && visibility !== 'private') return c.json({ error: 'visibility must be "link" or "private"' }, 400);
  if (STORE !== 'postgres') return c.json({ error: 'Who can see a world is kept in the database: start the server with WOM_STORE=postgres.' }, 409);
  if (!(await setVisibility(world.id, visibility, { id: user.id, role: user.role }))) return c.json({ error: 'not found' }, 404);
  return c.json({ visibility });
});

app.get('/api/worlds/:id/events', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  return streamSSE(c, async (stream) => {
    const queue: WorldEvent[] = [{ type: 'manifest', manifest: world.manifest }];
    let wake: (() => void) | null = null;
    const onEvent = (e: WorldEvent) => {
      queue.push(e);
      wake?.();
    };
    const emitter = worldEvents(world.id);
    emitter.on('event', onEvent);
    stream.onAbort(() => {
      emitter.off('event', onEvent);
      wake?.();
    });
    const ping = setInterval(() => onEvent({ type: 'log', message: '', at: '' }), 20_000);
    try {
      while (!stream.aborted) {
        while (queue.length) {
          const e = queue.shift()!;
          if (e.type === 'log' && !e.message) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
          } else {
            await stream.writeSSE({ event: e.type, data: JSON.stringify(e.type === 'manifest' ? { ...e, running: isRunning(world.id) } : e) });
          }
        }
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    } finally {
      clearInterval(ping);
      emitter.off('event', onEvent);
    }
  });
});

app.get('/api/worlds/:id/scene', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const file = world.file('scene.json');
  if (!existsSync(file)) return c.json({ error: 'scene not ready' }, 404);
  const doc = JSON.parse(await readFile(file, 'utf8')) as SceneDoc;
  const layoutFile = world.file('layout.json');
  let layout: LayoutOverride[] = [];
  if (existsSync(layoutFile)) {
    try {
      layout = JSON.parse(await readFile(layoutFile, 'utf8')).objects ?? [];
    } catch {
      layout = [];
    }
  }
  return c.json({ scene: doc, layout });
});

function isVec(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

app.put('/api/worlds/:id/layout', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { objects?: unknown } | null;
  const list = Array.isArray(body?.objects) ? body!.objects : null;
  if (!list) return c.json({ error: 'expected { objects: [...] }' }, 400);
  const known = new Set(world.manifest.objects.map((o) => o.id));
  const clean: LayoutOverride[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    if (typeof raw?.id !== 'string' || !known.has(raw.id)) continue;
    if (!isVec(raw.position, 3) || !isVec(raw.quaternion, 4) || typeof raw.scale !== 'number' || !(raw.scale > 0)) continue;
    clean.push({ id: raw.id, position: raw.position as LayoutOverride['position'], quaternion: raw.quaternion as LayoutOverride['quaternion'], scale: raw.scale, visible: raw.visible !== false });
  }
  await writeFileAtomic(world.file('layout.json'), JSON.stringify({ objects: clean }, null, 2));
  return c.json({ ok: true, saved: clean.length });
});

app.delete('/api/worlds/:id/layout', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  await writeFileAtomic(world.file('layout.json'), JSON.stringify({ objects: [] }));
  return c.json({ ok: true });
});

// ---------- slides: the ways into each world (the photo, and views saved inside it) ----------

app.get('/api/slides', async (c) => {
  const user = c.get('user')!;
  // The slides of the worlds you own. An administrator can ask for everyone's with ?all=1.
  const mine = new Set((await listWorldsFor({ id: user.id, role: user.role }, c.req.query('all') === '1')).map((w) => w.id));
  return c.json(await allSlides((id) => !isRunning(id) && mine.has(id)));
});

// Public share links may read a world's slides. The global slide space remains owner-scoped in /api/slides.
app.get('/api/worlds/:id/slides', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  return c.json(await worldSlides(world));
});

app.post('/api/worlds/:id/slides', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'expected multipart form data with "record" and "image"' }, 400);
  try {
    return c.json(await createSlide(world, form), 201);
  } catch (err) {
    if (err instanceof SlideError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// Update a view slide's name and/or caption: { "title"?: "…", "caption"?: "…" }. Answers with the slide.
app.patch('/api/worlds/:id/slides/:sid', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await updateSlide(world, c.req.param('sid') ?? '', await c.req.json().catch(() => null)));
  } catch (err) {
    if (err instanceof SlideError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.delete('/api/worlds/:id/slides/:sid', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  try {
    await deleteSlide(world, c.req.param('sid') ?? '');
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof SlideError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.post('/api/worlds/:id/retry', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  if (isRunning(world.id)) return c.json({ error: 'This world is still being built.' }, 409);
  // A build that failed gave its credits back. Hold them again before anything runs, or say there are too few. A retry of a
  // partial build is free, because it still holds them, and so is an administrator's.
  const user = c.get('user')!;
  if (STORE === 'postgres' && user.role !== 'admin') {
    try {
      await holdForRetry({ id: user.id, role: user.role }, world.id, WORLD_CREDITS);
    } catch (err) {
      if (err instanceof CreditsError) return c.json({ error: `Retrying costs ${WORLD_CREDITS} credits again, because they were given back when the build failed. You have ${err.balance ?? 0}.`, credits: true, balance: err.balance ?? 0, needed: WORLD_CREDITS }, 402);
      throw err;
    }
  }
  // Optionally switch models for the parts that are retried (e.g. a different mesh model).
  const body = (await c.req.json().catch(() => ({}))) as Partial<WorldOptions>;
  // Worlds made before an option existed keep their old behaviour on a retry unless asked otherwise (see retryOptions).
  const prev = world.manifest.options;
  const next = retryOptions(prev, body);
  if (JSON.stringify(next) !== JSON.stringify(world.manifest.options)) {
    await world.update((m) => { m.options = next; });
    world.log(`Options for retry: ${JSON.stringify(next)}`);
  }
  await prepareRetry(world);
  void startWorld(world);
  return c.json(world.manifest);
});

// ---------- redo one object's mask (only that object is rebuilt) ----------

async function maskRoute(c: Context, fn: (world: NonNullable<Awaited<ReturnType<typeof requireWorld>>>, objectId: string) => Promise<Response>) {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  try {
    return await fn(world, c.req.param('oid') ?? '');
  } catch (err) {
    if (err instanceof MaskError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

app.post('/api/worlds/:id/objects/:oid/mask/preview', (c) => maskRoute(c, async (world, oid) => {
  const prompt = parseMaskPrompt(await c.req.json().catch(() => null), world.manifest.image.width, world.manifest.image.height);
  const draft = await previewMask(world, oid, prompt);
  // The draft file is rewritten by every preview; the query keeps browsers from showing a cached one.
  return c.json({ ...draft, url: `/files/${world.id}/${draft.file}?v=${Date.now()}` });
}));

app.post('/api/worlds/:id/objects/:oid/mask', (c) => maskRoute(c, async (world, oid) => {
  if (isRunning(world.id)) return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  await applyDraftMask(world, oid);
  void startWorld(world);
  return c.json(world.manifest);
}));

app.post('/api/worlds/:id/objects/:oid/mask/restore', (c) => maskRoute(c, async (world, oid) => {
  if (isRunning(world.id)) return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  const version = Number(((await c.req.json().catch(() => ({}))) as { version?: unknown }).version);
  if (!Number.isInteger(version) || version < 1) return c.json({ error: 'expected { version: <n> }' }, 400);
  await restoreMask(world, oid, version);
  void startWorld(world);
  return c.json(world.manifest);
}));

// Generate another object model for comparison (the world keeps showing its current model).
app.post('/api/worlds/:id/assets', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const model = ((await c.req.json().catch(() => ({}))) as { model?: string }).model as MeshModel;
  if (!(model in OBJECT_MODELS)) return c.json({ error: 'unknown object model' }, 400);
  if (!startTask(world, `Generating ${model}`, () => generateAssets(world, model))) return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  return c.json({ started: true }, 202);
});

// Show another object model the objects already have (free: no 3D jobs, agents only from the cache).
app.post('/api/worlds/:id/object-model', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const model = ((await c.req.json().catch(() => ({}))) as { model?: string }).model as MeshModel;
  if (!(model in OBJECT_MODELS)) return c.json({ error: 'unknown object model' }, 400);
  const missing = world.manifest.objects.filter((o) => o.cutout && !o.assets?.[model]?.file);
  if (missing.length) return c.json({ error: `${missing.map((o) => o.name).join(', ')} still need ${model}; generate it first` }, 409);
  if (!startTask(world, `Switching to ${model}`, () => switchObjectModel(world, model))) return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  return c.json({ started: true }, 202);
});

// Choose this world's placement agents (they run whenever its objects are rebuilt). With `run`, the chosen
// agents that have not placed the current objects yet run now.
app.post('/api/worlds/:id/agents', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { agents?: unknown; run?: unknown };
  if (!Array.isArray(body.agents)) return c.json({ error: 'expected { agents: ["muse-spark-1.3" | "muse-wonder-1.0", …], run?: boolean }' }, 400);
  const agents = [...new Set(body.agents.filter((a): a is PlannerModel => a === 'muse-spark-1.3' || a === 'muse-wonder-1.0'))];
  if (isRunning(world.id)) return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  await world.update((m) => { m.options.placementAgents = agents; });
  let toRun: PlannerModel[] = [];
  if (body.run !== false && existsSync(world.file('scene.json'))) {
    const doc = JSON.parse(await readFile(world.file('scene.json'), 'utf8')) as SceneDoc;
    const placed = new Set(doc.placement?.methods.map((m) => m.id));
    toRun = agents.filter((a) => !placed.has(AGENT_PLACEMENTS[a]));
  }
  if (toRun.length && !startTask(world, 'Placement agents', () => runPlacementAgents(world, toRun))) {
    return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  }
  return c.json({ agents, running: toRun }, toRun.length ? 202 : 200);
});

// Show another model's asset for one object (free: the asset exists, compose fits it again). The other
// objects keep theirs, and retries do not undo the choice.
app.post('/api/worlds/:id/objects/:oid/asset', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const oid = c.req.param('oid') ?? '';
  const model = ((await c.req.json().catch(() => ({}))) as { model?: string }).model as MeshModel;
  if (!(model in OBJECT_MODELS)) return c.json({ error: 'unknown object model' }, 400);
  const obj = world.manifest.objects.find((o) => o.id === oid);
  if (!obj) return c.json({ error: 'unknown object' }, 404);
  if (!obj.assets?.[model]?.file) return c.json({ error: `${obj.name} has no ${model} asset yet; generate it first` }, 409);
  if (!startTask(world, `Switching ${obj.name} to ${model}`, () => switchObjectAsset(world, oid, model))) return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  return c.json({ started: true }, 202);
});

// Check the world's assets for leftovers of the photo's background (about two cents each; answers are cached by content).
app.post('/api/worlds/:id/assets/check', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  if (!keysConfigured().meta) return c.json({ error: 'MUSE_API_KEY must be set in .env' }, 400);
  const scope = ((await c.req.json().catch(() => ({}))) as { scope?: string }).scope === 'active' ? 'active' : 'all';
  const todo = uncheckedAssets(world, scope);
  if (!todo.length) return c.json({ started: false, assets: 0, estimateUsd: 0 });
  if (!startTask(world, 'Asset check', () => checkWorldAssets(world, { scope }))) return c.json({ error: 'This world is busy; try again when it is done.' }, 409);
  return c.json({ started: true, assets: todo.length, estimateUsd: todo.length * CHECK_PRICE_USD }, 202);
});

// ---------- observations: problems flagged while walking a world ----------

app.post('/api/worlds/:id/observations', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: 'expected multipart form data with "record" and "frame"' }, 400);
  try {
    return c.json(await createObservation(world, form), 201);
  } catch (err) {
    if (err instanceof ObservationError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.get('/api/observations', async (c) => {
  const worldId = c.req.query('world');
  if (worldId && !isWorldId(worldId)) return c.json({ error: 'bad world id' }, 400);
  const status = OBSERVATION_STATUSES.find((s) => s.id === c.req.query('status'))?.id as ObservationStatus | undefined;
  const list = await listObservations({ world: worldId, status });
  const titles = new Map<string, string>();
  for (const w of new Set(list.map((r) => r.world))) titles.set(w, (await getWorld(w))?.manifest.title ?? 'a deleted world');
  return c.json(list.map((r) => ({ ...r, worldTitle: titles.get(r.world) ?? '' })));
});

// The flags grouped into problems, newest sighting first, one page at a time and without the rays: what the
// Observations page lists. ?world=&status=&limit=&offset=
app.get('/api/issues', async (c) => {
  const worldId = c.req.query('world');
  if (worldId && !isWorldId(worldId)) return c.json({ error: 'bad world id' }, 400);
  const status = OBSERVATION_STATUSES.find((s) => s.id === c.req.query('status'))?.id as ObservationStatus | undefined;
  const limit = Math.min(100, Math.max(1, Math.floor(Number(c.req.query('limit') ?? 20)) || 20));
  const offset = Math.max(0, Math.floor(Number(c.req.query('offset') ?? 0)) || 0);
  const titles = new Map<string, string>();
  const titleOf = async (w: string) => {
    if (!titles.has(w)) titles.set(w, (await getWorld(w))?.manifest.title ?? 'a deleted world');
    return titles.get(w)!;
  };
  return c.json(await listIssues({ world: worldId, status, limit, offset, titleOf }));
});

app.get('/api/worlds/:id/observations', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  return c.json(await listObservations({ world: world.id }));
});

// The same change to several flags, such as every sighting of a problem: { ids: [...], status?, note?, category?, suspect? }.
app.patch('/api/worlds/:id/observations', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  try {
    const { ids, ...patch } = body ?? {};
    return c.json({ updated: (await updateObservations(world, ids, patch)).length });
  } catch (err) {
    if (err instanceof ObservationError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.get('/api/worlds/:id/observations/:oid', async (c) => {
  const world = await requireWorld(c);
  const oid = c.req.param('oid') ?? '';
  const rec = world && isObservationId(oid) ? await getObservation(world.id, oid) : null;
  return rec ? c.json(rec) : c.json({ error: 'not found' }, 404);
});

app.patch('/api/worlds/:id/observations/:oid', async (c) => {
  const world = await requireWorld(c);
  const oid = c.req.param('oid') ?? '';
  if (!world || !isObservationId(oid)) return c.json({ error: 'not found' }, 404);
  try {
    return c.json(await updateObservation(world, oid, await c.req.json().catch(() => null)));
  } catch (err) {
    if (err instanceof ObservationError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// What can be done about the problem a flag belongs to, best first, with the evidence and the price of each. Free to ask.
app.get('/api/worlds/:id/observations/:oid/fixes', async (c) => {
  const world = await requireWorld(c);
  const oid = c.req.param('oid') ?? '';
  const rec = world && isObservationId(oid) ? await getObservation(world.id, oid) : null;
  return world && rec ? c.json(suggestFixes(world, rec)) : c.json({ error: 'not found' }, 404);
});

// Apply one of them: { fix: 'use:tripo-v31', approveUsd?: number, by?: 'human' | 'agent:<name>' }. A fix that charges needs
// approveUsd of at least its price. It runs in the background: poll GET /api/worlds/:id until it is no longer running.
app.post('/api/worlds/:id/observations/:oid/fix', async (c) => {
  const world = await requireWorld(c);
  const oid = c.req.param('oid') ?? '';
  if (!world || !isObservationId(oid)) return c.json({ error: 'not found' }, 404);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as { fix?: unknown; approveUsd?: unknown; by?: unknown };
  try {
    return c.json(await applyFix(world, oid, body.fix, body), 202);
  } catch (err) {
    if (err instanceof ObservationError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

// The view is right after a fix: mark every sighting of the problem fixed. A multipart `after` picture of the view
// is kept beside the flagged frame.
app.post('/api/worlds/:id/observations/:oid/fixed', async (c) => {
  const world = await requireWorld(c);
  const oid = c.req.param('oid') ?? '';
  if (!world || !isObservationId(oid)) return c.json({ error: 'not found' }, 404);
  const form = (c.req.header('content-type') ?? '').includes('multipart/form-data') ? await c.req.formData().catch(() => null) : null;
  const after = form?.get('after');
  try {
    return c.json(await resolveIssue(world, oid, after instanceof File ? after : null));
  } catch (err) {
    if (err instanceof ObservationError) return c.json({ error: err.message }, err.status);
    throw err;
  }
});

app.get('/bench-files/observations/:world/:oid/:name', async (c) => {
  const world = c.req.param('world') ?? '';
  const file = isWorldId(world) ? observationFilePath(world, c.req.param('oid') ?? '', c.req.param('name') ?? '') : null;
  if (!file) return c.json({ error: 'not found' }, 404);
  // Flags saved before thumbnails existed get theirs the first time a list asks for it.
  const wanted = c.req.param('name') ?? '';
  if (isThumbName(wanted)) await ensureThumbnail(world, c.req.param('oid') ?? '', wanted).catch(() => undefined);
  // A flag's files never change after it is saved.
  return sendFile(c, file, 'private, max-age=31536000, immutable');
});

// WOM, World Observation Metrics: the benchmark's runs and files (/api/bench/*, /bench-files/<task>/*) and the
// spend report. The metrics package serves them; bench/suite.ts says which tasks the app measures. After the
// observation files above, which share the /bench-files prefix.
app.route('/', metricsRoutes());

// Choose which placement this world shows by default (fitter, grounded, or an agent's).
app.post('/api/worlds/:id/placement', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const method = (body as { method?: string }).method as PlacementMethod;
  if (!PLACEMENT_METHODS.some((p) => p.id === method)) return c.json({ error: 'unknown placement method' }, 400);
  if (isRunning(world.id)) return c.json({ error: 'This world is still being built.' }, 409);
  const file = world.file('scene.json');
  if (!existsSync(file)) return c.json({ error: 'no scene yet' }, 409);
  const doc = applyPlacement(JSON.parse(await readFile(file, 'utf8')) as SceneDoc, method);
  await writeFileAtomic(file, JSON.stringify(doc, null, 2));
  await world.update((m) => { m.placementMethod = method; });
  return c.json({ placement: doc.placement });
});

app.post('/api/worlds/:id/recompose', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  if (isRunning(world.id)) return c.json({ error: 'This world is still being built.' }, 409);
  const doc = await recompose(world);
  return c.json({ diagnostics: doc.diagnostics });
});

app.delete('/api/worlds/:id', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  if (isRunning(world.id)) return c.json({ error: 'This world is still being built.' }, 409);
  // A world that never produced anything owes nothing. Normally its credits are already back; this is for when giving them back
  // failed, because once the world is gone nothing could find them. If it fails again the world stays, and so can be deleted later.
  if (STORE === 'postgres' && (world.manifest.status === 'failed' || world.manifest.status === 'queued')) {
    await refundWorld({ id: world.ownerId, role: 'user' }, world.id);
  }
  await deleteWorld(world.id);
  return c.json({ ok: true });
});

async function sendFile(c: Context, file: string, cache: string) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  if (!info.isFile()) return c.json({ error: 'not found' }, 404);
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, {
    headers: { 'Content-Type': type, 'Content-Length': String(info.size), 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' },
  });
}

app.get('/files/:id/*', async (c) => {
  const id = c.req.param('id');
  if (!isWorldId(id)) return c.json({ error: 'not found' }, 404);
  const prefix = `/files/${id}/`;
  let rel: string;
  try {
    rel = decodeURIComponent(c.req.path.slice(prefix.length));
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  if (!rel || rel.includes('\0')) return c.json({ error: 'not found' }, 404);
  let file: string;
  try {
    file = worldFile(id, rel);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  // Generated artifacts never change in place except scene.json and relief.glb (rebuilt by compose).
  const mutable = /(^|\/)(scene\.json|relief\.glb|manifest\.json|log\.txt|slides\.json)$/.test(rel);
  return sendFile(c, file, mutable ? 'no-cache' : 'private, max-age=31536000, immutable');
});

// A shared world's address, wom.quest/u/<handle>/<world>. The page is the app. This adds the preview tags a pasted link needs,
// and sends an old handle (or '-', which the app writes where it does not know the owner's) to the owner's current one.
// It tells nothing about a world that anyone may not look at: that answer is the same as for a world that does not exist.
app.get('/u/:handle/:id', async (c, next) => {
  if (!existsSync(WEB_DIST)) return next();
  const id = c.req.param('id');
  const found = await worldAccess(id);
  const shared = found && levelOf(null, found) === 'viewer' ? found : null;
  const here = new URL(c.req.url);
  if (shared?.handle && c.req.param('handle') !== shared.handle) return c.redirect(`/u/${shared.handle}/${id}${here.search}`, 302);
  const world = shared ? await getWorld(id) : null;
  const origin = PUBLIC_ORIGIN || here.origin;
  const pageUrl = `${origin}/u/${shared?.handle ?? '-'}/${id}`;
  const template = await readFile(path.join(WEB_DIST, 'index.html'), 'utf8');
  const page = withPreview(template, world && shared
    ? {
        url: pageUrl,
        title: world.manifest.title,
        description: world.manifest.plan?.summary,
        image: { url: `${origin}/og/${id}.jpg`, width: 1200, height: 630, alt: world.manifest.title },
      }
    : { url: pageUrl });
  return c.html(page, 200, { 'Cache-Control': 'no-cache' });
});

// The picture a pasted link shows: the memory's photo cropped to the shape chats use, made once.
app.get('/og/:file', async (c) => {
  const id = (c.req.param('file') ?? '').replace(/\.jpg$/, '');
  const found = await worldAccess(id);
  if (!found || levelOf(null, found) !== 'viewer') return c.json({ error: 'not found' }, 404);
  const source = worldFile(id, 'source.jpg');
  const card = worldFile(id, 'og.jpg');
  if (!existsSync(card)) {
    if (!existsSync(source)) return c.json({ error: 'not found' }, 404);
    await writeFileAtomic(card, await sharp(source).rotate().resize(1200, 630, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 }).toBuffer());
  }
  return sendFile(c, card, 'public, max-age=3600');
});

// The browser's app shell is public. APIs and files are protected by access.ts above.
app.get('*', async (c) => {
  if (!existsSync(WEB_DIST)) {
    return c.text('WOM API is running. Start the web app with `npm run dev` and open http://localhost:5173', 200);
  }
  const rel = c.req.path === '/' ? 'index.html' : c.req.path.slice(1);
  const file = path.resolve(WEB_DIST, rel);
  if (file.startsWith(WEB_DIST + path.sep) && existsSync(file)) {
    return sendFile(c, file, rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
  return sendFile(c, path.join(WEB_DIST, 'index.html'), 'no-cache');
});

/** Listen, and pick up the worlds a restart interrupted. */
async function start() {
  // Before the first request, so that it cannot meet a retry halfway: give back what failed builds still hold (see refundFailedWorlds).
  if (STORE === 'postgres') {
    await refundFailedWorlds()
      .then((r) => { if (r.worlds) console.log(`[credits] gave back ${r.credits} credits for ${r.worlds} failed world(s)`); })
      .catch((err) => console.error(`[credits] could not check failed worlds for credits to give back: ${errorMessage(err)}`));
  }
  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
    console.log(`WOM server listening on http://${info.address}:${info.port}`);
    const keys = keysConfigured();
    if (!keys.meta) console.warn('MUSE_API_KEY is missing from .env');
    if (!keys.ai3d) console.warn('AI3D_API_KEY is missing from .env');
    if (!SIGN_IN_REQUIRED) console.log('Sign-in is off: this server listens on this machine only. Set WOM_AUTH=required to require it.');
    else if (!clerkConfigured()) console.warn('Sign-in is required, but CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are missing from .env: every request that needs a person is refused until they are set.');
    if (SIGN_IN_REQUIRED && STORE !== 'postgres') console.warn('Sign-in is required but WOM_STORE is not postgres: no world can be shared, and anyone signed in can reach every world. Set WOM_STORE=postgres to share worlds by link.');
  });
  void resumeWorlds();
}

// Resume worlds that were interrupted by a restart; their AI3D jobs are resumed, not resubmitted.
async function resumeWorlds() {
  const worlds = await listWorlds();
  // Track every generated asset per model, and start the cost ledger from what worlds already spent.
  for (const m of worlds) {
    const world = await getWorld(m.id);
    if (world) await ensureAssetRegistry(world).catch((err) => console.error(`[assets] ${m.id}: ${errorMessage(err)}`));
  }
  if (!ledgerExists()) {
    await appendLedger(...worlds.flatMap((m) => m.costs.map((c) => ({
      at: m.createdAt, context: 'pipeline' as const, provider: c.provider, label: c.label, usd: c.usd, estimated: c.estimated, worldId: m.id, backfilled: true,
    }))));
  }
  for (const m of worlds) {
    if (m.status === 'running' || m.status === 'queued') {
      const world = await getWorld(m.id);
      if (!world) continue;
      console.log(`[resume] continuing world ${m.id} (${m.title})`);
      await prepareRetry(world);
      void startWorld(world);
    }
  }
}

// Only when this file is the program. Tests import `app` and call it without opening a port.
if (import.meta.main) void start();
