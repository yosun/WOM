// Freeze LOCAL WOM outputs for a Par course. Read-only fixture server: no app startup, jobs or API spend.
// Requires a built viewer, Chrome/Chromium, ffmpeg and Playwright (PLAYWRIGHT_CORE may point outside repo).
import { constants, createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import sharp from 'sharp';
import { PAR_PROTOCOL, parFileDigest, readParCourse, type ParBundle, type ParCourse, type ParFile } from '@wom/metrics';
import { DATA_DIR, ROOT } from '../server/src/config.ts';

const args = process.argv.slice(2);
const opt = (key: string) => {
  const i = args.indexOf(`--${key}`);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`--${key} requires a value`);
  return args[i + 1];
};
if (args.includes('--help')) {
  console.log('freeze-par --plan <plan.json> --out <new-artifact-root> --manifest <new-course.json>\nNeeds npm run build, ffmpeg, Chrome, and PLAYWRIGHT_CORE (or installed playwright-core). Never overwrites an existing course.');
  process.exit(0);
}
const planFile = path.resolve(opt('plan') ?? 'docs/wom-par/courses/0.1-pilot-plan.json');
const out = path.resolve(opt('out') ?? 'data/par-courses/wompar-0.1-pilot');
const manifestFile = path.resolve(opt('manifest') ?? 'docs/wom-par/courses/0.1-pilot.json');
if (existsSync(out) || existsSync(manifestFile)) throw new Error('Refusing to overwrite a frozen course. Use new paths/id for a new snapshot.');
const plan = JSON.parse(await readFile(planFile, 'utf8')) as {
  id: string; label: string; reference: ParCourse['reference']; conditions: string; rubric: string; patrol: string;
  scenes: { id: string; world: string; note: string }[];
};
if (!/^[a-zA-Z0-9._-]+$/.test(plan.id) || !Array.isArray(plan.scenes) || !plan.scenes.length ||
    new Set(plan.scenes.map((s) => s.id)).size !== plan.scenes.length ||
    plan.scenes.some((s) => !/^[a-zA-Z0-9._-]+$/.test(s.id) || !/^[a-zA-Z0-9_-]+$/.test(s.world) || s.id === '.' || s.id === '..')) {
  throw new Error('Invalid/duplicate scene or world ids in freeze plan');
}
const pwFile = process.env.PLAYWRIGHT_CORE ?? path.join(ROOT, 'node_modules/playwright-core/index.mjs');
const pw = await import(pathToFileURL(path.resolve(pwFile)).href);
const stage = `${out}.partial-${Date.now()}`;
await mkdir(stage, { recursive: true });
const encode = promisify(execFile);
const createdAt = new Date().toISOString();
const git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim());

const put = async (rel: string, value: string | Buffer | object, bundle = false): Promise<ParFile> => {
  const full = path.join(stage, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return { path: rel, sha256: await parFileDigest(full), ...(bundle ? { kind: 'bundle' as const } : {}) };
};
const clone = async (src: string, rel: string): Promise<ParFile> => {
  const full = path.join(stage, rel);
  await mkdir(path.dirname(full), { recursive: true });
  // Copy-on-write where supported; never hardlink a mutable live asset to the reference.
  await copyFile(src, full, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  return { path: rel, sha256: await parFileDigest(full) };
};
const bundle = (rel: string, files: ParFile[], provenance: Record<string, unknown> = {}) =>
  put(rel, { format: 'wom-par-bundle-v1', files, provenance } satisfies ParBundle, true);
const staticFiles = new Map<string, string>();
const fixtures = new Map<string, { scene: any; layout: any[]; manifest: any }>();
const walkDist = async (dir: string, prefix = ''): Promise<ParFile[]> => {
  const files: ParFile[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await walkDist(path.join(dir, entry.name), `${rel}/`));
    else if (entry.isFile()) {
      const file = await clone(path.join(dir, entry.name), `renderer/${rel}`);
      staticFiles.set(`/${rel}`, path.join(stage, file.path));
      files.push(file);
    }
  }
  return files;
};
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const url = new URL(req.url!, 'http://127.0.0.1');
  let value: unknown;
  if (url.pathname === '/api/me') value = { user: null, signInRequired: false, shares: false };
  else if (url.pathname === '/api/auth/config') value = { required: false };
  else if (url.pathname === '/api/health') value = { ok: true };
  else if (url.pathname === '/api/worlds') value = [];
  else {
    const match = /^\/api\/worlds\/([^/]+)(\/scene)?$/.exec(url.pathname);
    const fixture = match && fixtures.get(match[1]);
    if (fixture) value = match![2] ? { scene: fixture.scene, layout: fixture.layout }
      : { manifest: fixture.manifest, log: [], running: false, access: { handle: 'local', visibility: 'link', canEdit: false } };
    else if (url.pathname.startsWith('/api/')) value = [];
  }
  if (value !== undefined) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); return; }
  const file = staticFiles.get(decodeURIComponent(url.pathname)) ?? (url.pathname.startsWith('/u/') ? staticFiles.get('/index.html') : undefined);
  if (!file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

let browser: any;
try {
  if (!existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('Run npm run build before freezing the renderer.');
  const renderer = await bundle('renderer.json', await walkDist(path.join(ROOT, 'dist')), { git, dirty, createdAt });
  const conditions = await clone(path.resolve(ROOT, plan.conditions), 'protocol/conditions.json');
  const rubric = await clone(path.resolve(ROOT, plan.rubric), 'protocol/rubric.md');
  const settings = JSON.parse(await readFile(path.join(stage, conditions.path), 'utf8'));
  const patrol = JSON.parse(await readFile(path.resolve(ROOT, plan.patrol), 'utf8'));
  const course: ParCourse = { protocol: PAR_PROTOCOL, id: plan.id, label: plan.label, release: 'pilot', sampling: 'convenience',
    reference: plan.reference, conditions, rubric, evaluation: { id: 'human-v1', kind: 'human', judgesPerTrial: 5 },
    strata: [{ id: 'local-pilot', weight: 1 }], scenes: [] };
  const prepared: { item: typeof plan.scenes[number]; prefix: string; source: ParFile; artifact: ParFile; trajectory: ParFile; samples: any[]; endpoints: number[] }[] = [];
  for (const item of plan.scenes) {
    const dir = path.join(DATA_DIR, 'worlds', item.world), prefix = `reference/${item.id}`;
    const sceneBytes = await readFile(path.join(dir, 'scene.json'));
    const scene = JSON.parse(sceneBytes.toString('utf8'));
    const manifestBytes = await readFile(path.join(dir, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const layoutBytes = existsSync(path.join(dir, 'layout.json')) ? await readFile(path.join(dir, 'layout.json')) : undefined;
    const layout = layoutBytes ? JSON.parse(layoutBytes.toString('utf8')).objects ?? [] : [];
    const raw = patrol.results.find((r: any) => r.case === item.world)?.details?.views;
    if (!raw?.length || raw[0].id !== 'photo') throw new Error(`No declared patrol endpoints for ${item.world}`);
    const files: ParFile[] = [renderer, await put(`${prefix}/scene.json`, sceneBytes)];
    if (layoutBytes) files.push(await put(`${prefix}/layout.json`, layoutBytes));
    const paths = new Set<string>();
    const urls = (v: any) => {
      if (typeof v === 'string' && v.startsWith(`/files/${item.world}/`)) paths.add(decodeURIComponent(v.slice(`/files/${item.world}/`.length).split('?')[0]));
      else if (Array.isArray(v)) v.forEach(urls);
      else if (v && typeof v === 'object') Object.values(v).forEach(urls);
    };
    urls(scene);
    const sourcePath = manifest.image.file;
    paths.add(sourcePath);
    let source: ParFile | undefined;
    for (const rel of [...paths].sort()) {
      if (path.isAbsolute(rel) || rel.split('/').some((p) => p === '..' || p === '') || rel.includes('\\')) throw new Error('Unsafe world asset path');
      const copy = await clone(path.join(dir, rel), `${prefix}/world/${rel}`);
      files.push(copy);
      staticFiles.set(`/files/${item.world}/${rel}`, path.join(stage, copy.path));
      if (rel === sourcePath) source = copy;
    }
    if (!source) throw new Error('Missing source photograph');
    files.push(await put(`${prefix}/provenance.json`, { world: item.world, options: manifest.options, activePlacement: scene.placement?.active,
      note: item.note, originalManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), git, dirty, createdAt }));
    const artifact = await bundle(`${prefix}/artifact.json`, files, { world: item.world, note: item.note });
    fixtures.set(item.world, { scene, layout, manifest });
    const home = raw[0].pose, samples = [{ id: '0000', position: home.position, quaternion: home.quaternion }], endpoints = [0];
    const steps = settings.path.stepsEachWay;
    const add = (from: any, to: any) => {
      for (let k = 1; k <= steps; k++) samples.push({ id: String(samples.length).padStart(4, '0'),
        position: new Vector3(...from.position).lerp(new Vector3(...to.position), k / steps).toArray(),
        quaternion: new Quaternion(...from.quaternion).slerp(new Quaternion(...to.quaternion), k / steps).toArray() });
    };
    for (const view of raw.slice(1)) { add(home, view.pose); endpoints.push(samples.length - 1); add(view.pose, home); }
    const trajectory = await put(`${prefix}/trajectory.json`, { protocol: PAR_PROTOCOL, sourceWorld: item.world,
      fovY: scene.camera.fovY, aspect: settings.viewport.width / settings.viewport.height, rendererSha256: renderer.sha256,
      endpointIds: raw.map((v: any) => v.id), endpointFrames: endpoints, samples });
    prepared.push({ item, prefix, source, artifact, trajectory, samples, endpoints });
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No capture server address');
  const origin = `http://127.0.0.1:${address.port}`;
  const executablePath = process.env.BROWSER_EXECUTABLE ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await pw.chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] });
  for (const p of prepared) {
    console.log(`Capturing ${p.item.id}: ${p.samples.length} required camera samples`);
    const context = await browser.newContext({ viewport: { width: settings.viewport.width, height: settings.viewport.height }, deviceScaleFactor: settings.viewport.pixelRatio });
    // Frozen local data only. Remote fetches and all mutations are blocked.
    await context.route('**/*', (route: any) => route.request().method() === 'GET' && route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (err: Error) => errors.push(err.message));
    await page.goto(`${origin}/u/local/${p.item.world}?debug`);
    await page.waitForFunction(() => Boolean((window as any).__wom?.viewer), null, { timeout: 60_000 });
    const phase = await page.evaluate(() => (window as any).__wom.viewer.ready(180_000));
    if (phase !== 'portal') throw new Error(`Unexpected viewer phase: ${phase}`);
    await page.evaluate(() => (window as any).__wom.viewer.enter());
    await new Promise((resolve) => setTimeout(resolve, 900));
    const fixture = fixtures.get(p.item.world)!;
    await page.evaluate(({ fov, aspect }: { fov: number; aspect: number }) => {
      const w = (window as any).__wom;
      w.camera.fov = fov;
      w.camera.aspect = aspect;
      w.camera.updateProjectionMatrix();
    }, { fov: fixture.scene.camera.fovY, aspect: settings.viewport.width / settings.viewport.height });
    const frames: ParFile[] = [], thumbs: Buffer[] = [];
    for (let i = 0; i < p.samples.length; i++) {
      await page.evaluate((pose: any) => (window as any).__wom.viewer.setPose(pose), p.samples[i]);
      await new Promise((resolve) => setTimeout(resolve, settings.frames.settleMs));
      const base64 = await page.evaluate(async (maxWidth: number) => {
        const blob = await (window as any).__wom.viewer.frame({ maxWidth, type: 'jpeg' });
        return await new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
      }, settings.frames.width);
      const bytes = Buffer.from(base64, 'base64');
      const size = await sharp(bytes).metadata();
      if (size.width !== settings.frames.width || size.height !== settings.frames.height) throw new Error(`Unexpected capture size: ${size.width}×${size.height}`);
      frames.push(await put(`${p.prefix}/frames/${String(i).padStart(4, '0')}.jpg`, bytes));
      if (p.endpoints.includes(i)) thumbs.push(await sharp(bytes).resize(256, 160).toBuffer());
      if (errors.length) throw new Error(`Viewer errors: ${errors.join('; ')}`);
    }
    const clip = `${p.prefix}/walkthrough.mp4`;
    await encode('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-framerate', String(settings.path.reviewFps),
      '-i', path.join(stage, p.prefix, 'frames/%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18',
      '-movflags', '+faststart', path.join(stage, clip)]);
    const sheet = await sharp({ create: { width: 1024, height: Math.ceil(thumbs.length / 4) * 160, channels: 3, background: '#171512' } })
      .composite(thumbs.map((input, i) => ({ input, left: i % 4 * 256, top: Math.floor(i / 4) * 160 }))).jpeg({ quality: 90 }).toBuffer();
    const files = [...frames, { path: clip, sha256: await parFileDigest(path.join(stage, clip)) }, await put(`${p.prefix}/endpoints.jpg`, sheet),
      await put(`${p.prefix}/capture.json`, { browser: await browser.version(), rendererSha256: renderer.sha256,
        settings, samples: frames.length, endpointFrames: p.endpoints, errors, capturedAt: new Date().toISOString() })];
    const evidence = await bundle(`${p.prefix}/evidence.json`, files, { protocol: PAR_PROTOCOL, status: 'ok', sourceSha256: p.source.sha256,
      trajectorySha256: p.trajectory.sha256, conditionsSha256: conditions.sha256, rendererSha256: renderer.sha256,
      cameraSamples: p.samples.map((s, i) => ({ id: s.id, frameSha256: frames[i].sha256 })),
      walkthroughSha256: files.find((f) => f.path === clip)!.sha256 });
    course.scenes.push({ id: p.item.id, title: fixture.manifest.title, source: p.source, stratum: 'local-pilot', trajectory: p.trajectory,
      trials: [{ id: 'saved-0', reference: { status: 'ok', artifact: p.artifact, evidence } }] });
    await context.close();
  }
  const localManifest = await put('course.json', course);
  const loaded = await readParCourse(path.join(stage, localManifest.path), stage);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(path.dirname(manifestFile), { recursive: true });
  await rename(stage, out);
  await writeFile(manifestFile, JSON.stringify(course, null, 2) + '\n', { flag: 'wx' });
  console.log(`Frozen ${course.scenes.length} photographs. Course SHA-256: ${loaded.sha256}`);
  console.log(`Artifact root: ${out}\nManifest: ${manifestFile}`);
} catch (err) {
  await rm(stage, { recursive: true, force: true });
  throw err;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
