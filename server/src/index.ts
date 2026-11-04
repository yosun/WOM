// WOM API server: uploads, world pipeline control, live progress (SSE), and artifact files.
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import sharp from 'sharp';
import { accountBalanceUsd } from './clients/ai3d.ts';
import { DEFAULT_OPTIONS, HOST, PORT, WEB_DIST, keysConfigured, normalizeOptions } from './config.ts';
import { prepareRetry, isRunning, recompose, startWorld } from './pipeline/run.ts';
import { createWorld, deleteWorld, getWorld, isWorldId, listWorlds, worldEvents, worldFile } from './store.ts';
import type { LayoutOverride, SceneDoc, WorldEvent, WorldOptions } from './types.ts';
import { errorMessage, writeFileAtomic } from './util.ts';

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

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
  '.wasm': 'application/wasm',
};

const app = new Hono();

app.onError((err, c) => {
  console.error('[http]', err);
  return c.json({ error: errorMessage(err) }, 500);
});

app.get('/api/health', (c) => c.json({ ok: true, keys: keysConfigured(), defaults: DEFAULT_OPTIONS }));

app.get('/api/account', async (c) => {
  try {
    return c.json({ ai3dBalanceUsd: await accountBalanceUsd() });
  } catch (err) {
    return c.json({ ai3dBalanceUsd: null, error: errorMessage(err) });
  }
});

app.get('/api/worlds', async (c) => {
  const worlds = await listWorlds();
  return c.json(
    worlds.map((m) => ({
      id: m.id,
      title: m.title,
      status: m.status,
      createdAt: m.createdAt,
      thumb: `/files/${m.id}/${m.image.thumb}`,
      objects: m.objects.length,
      hasWorld: Boolean(m.world?.splats?.length),
      costUsd: m.costs.reduce((a, b) => a + b.usd, 0),
      running: isRunning(m.id),
    })),
  );
});

app.post('/api/worlds', async (c) => {
  const keys = keysConfigured();
  if (!keys.meta || !keys.ai3d) return c.json({ error: 'MUSE_API_KEY and AI3D_API_KEY must be set in .env' }, 400);
  const form = await c.req.formData();
  const file = form.get('image');
  if (!(file instanceof File)) return c.json({ error: 'Attach the photo as form field "image".' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: 'The photo is larger than 40 MB.' }, 413);
  let options: WorldOptions;
  try {
    const raw = form.get('options');
    options = normalizeOptions(typeof raw === 'string' && raw ? JSON.parse(raw) : undefined);
  } catch {
    return c.json({ error: 'options must be JSON' }, 400);
  }
  const input = Buffer.from(await file.arrayBuffer());
  let jpeg: Buffer, thumb: Buffer, width: number, height: number;
  try {
    const normalized = sharp(input, { limitInputPixels: 120_000_000 }).rotate().resize(2048, 2048, { fit: 'inside', withoutEnlargement: true }).removeAlpha();
    const out = await normalized.jpeg({ quality: 92, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    jpeg = out.data;
    width = out.info.width;
    height = out.info.height;
    thumb = await sharp(jpeg).resize(640, 640, { fit: 'inside' }).jpeg({ quality: 82 }).toBuffer();
  } catch {
    return c.json({ error: 'That file could not be read as an image. Use JPEG, PNG or WebP.' }, 415);
  }
  if (width < 256 || height < 256) return c.json({ error: 'The photo must be at least 256 pixels on each side.' }, 400);
  const world = await createWorld({ options, width, height, owner: { id: 'local' } });
  await writeFileAtomic(world.file('source.jpg'), jpeg);
  await writeFileAtomic(world.file('thumb.jpg'), thumb);
  world.log(`Created from "${file.name}" (${width}×${height}) with ${JSON.stringify(options)}`);
  void startWorld(world);
  return c.json(world.manifest, 201);
});

async function requireWorld(c: Context) {
  const id = c.req.param('id') ?? '';
  return isWorldId(id) ? getWorld(id) : null;
}

app.get('/api/worlds/:id', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  return c.json({ manifest: world.manifest, log: world.recentLog(), running: isRunning(world.id) });
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

app.post('/api/worlds/:id/retry', async (c) => {
  const world = await requireWorld(c);
  if (!world) return c.json({ error: 'not found' }, 404);
  if (isRunning(world.id)) return c.json({ error: 'This world is still being built.' }, 409);
  // Optionally switch models for the parts that are retried (e.g. a different mesh model).
  const body = (await c.req.json().catch(() => ({}))) as Partial<WorldOptions>;
  const next = normalizeOptions({ ...world.manifest.options, ...body });
  if (JSON.stringify(next) !== JSON.stringify(world.manifest.options)) {
    await world.update((m) => { m.options = next; });
    world.log(`Options for retry: ${JSON.stringify(next)}`);
  }
  await prepareRetry(world);
  void startWorld(world);
  return c.json(world.manifest);
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
  const rel = decodeURIComponent(c.req.path.slice(prefix.length));
  if (!rel || rel.includes('\0')) return c.json({ error: 'not found' }, 404);
  let file: string;
  try {
    file = worldFile(id, rel);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  // Generated artifacts never change in place except scene.json and relief.glb (rebuilt by compose).
  const mutable = /(^|\/)(scene\.json|relief\.glb|manifest\.json|log\.txt)$/.test(rel);
  return sendFile(c, file, mutable ? 'no-cache' : 'private, max-age=31536000, immutable');
});

// Built web app (npm run build). In development Vite serves the app and proxies /api and /files here.
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

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`WOM server listening on http://${info.address}:${info.port}`);
  const keys = keysConfigured();
  if (!keys.meta) console.warn('MUSE_API_KEY is missing from .env');
  if (!keys.ai3d) console.warn('AI3D_API_KEY is missing from .env');
});

// Resume worlds that were interrupted by a restart; their AI3D jobs are resumed, not resubmitted.
void (async () => {
  for (const m of await listWorlds()) {
    if (m.status === 'running' || m.status === 'queued') {
      const world = await getWorld(m.id);
      if (!world) continue;
      console.log(`[resume] continuing world ${m.id} (${m.title})`);
      await prepareRetry(world);
      void startWorld(world);
    }
  }
})();
