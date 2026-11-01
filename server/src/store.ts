// World storage on disk: data/worlds/<id>/manifest.json plus every artifact the pipeline produces.
// Manifest writes are serialized per world and broadcast to SSE subscribers.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { WORLDS_DIR } from './config.ts';
import { STEP_ORDER, type CostItem, type StepId, type StepState, type WorldEvent, type WorldManifest, type WorldOptions } from './types.ts';
import { nowIso, writeFileAtomic } from './util.ts';

const ID_RE = /^[a-z0-9]{6,32}$/;

export function isWorldId(id: string) {
  return ID_RE.test(id);
}

export function worldDir(id: string) {
  if (!isWorldId(id)) throw new Error('invalid world id');
  return path.join(WORLDS_DIR, id);
}

/** Resolve a relative artifact path inside a world directory, refusing traversal. */
export function worldFile(id: string, rel: string) {
  const base = worldDir(id);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('path escapes world directory');
  return full;
}

export function newWorldId() {
  const t = Date.now().toString(36);
  return `${t}${randomBytes(4).toString('hex')}`;
}

const emitters = new Map<string, EventEmitter>();
export function worldEvents(id: string) {
  let e = emitters.get(id);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(100);
    emitters.set(id, e);
  }
  return e;
}

export function initialSteps(): Record<StepId, StepState> {
  return Object.fromEntries(STEP_ORDER.map((s) => [s.id, { id: s.id, label: s.label, status: 'pending' }])) as Record<StepId, StepState>;
}

export class WorldHandle {
  readonly id: string;
  manifest: WorldManifest;
  private writing: Promise<void> = Promise.resolve();
  private logLines: string[] = [];

  constructor(manifest: WorldManifest) {
    this.id = manifest.id;
    this.manifest = manifest;
  }

  dir() {
    return worldDir(this.id);
  }

  file(rel: string) {
    return worldFile(this.id, rel);
  }

  /** Mutate the manifest, persist it, and notify listeners. */
  async update(mutator: (m: WorldManifest) => void) {
    mutator(this.manifest);
    this.manifest.updatedAt = nowIso();
    const snapshot = JSON.stringify(this.manifest, null, 2);
    this.writing = this.writing.then(() => writeFileAtomic(this.file('manifest.json'), snapshot)).catch((err) => {
      console.error(`[store] failed to write manifest for ${this.id}:`, err);
    });
    await this.writing;
    worldEvents(this.id).emit('event', { type: 'manifest', manifest: this.manifest } satisfies WorldEvent);
  }

  log(message: string) {
    const at = nowIso();
    const line = `${at} ${message}`;
    this.logLines.push(line);
    console.log(`[world ${this.id}] ${message}`);
    worldEvents(this.id).emit('event', { type: 'log', message, at } satisfies WorldEvent);
    void writeFileAtomic(this.file('log.txt'), this.logLines.join('\n') + '\n').catch(() => undefined);
  }

  async loadLog() {
    try {
      this.logLines = (await readFile(this.file('log.txt'), 'utf8')).split('\n').filter(Boolean);
    } catch {
      this.logLines = [];
    }
  }

  recentLog(n = 200) {
    return this.logLines.slice(-n);
  }

  async setStep(id: StepId, patch: Partial<StepState>) {
    await this.update((m) => {
      const prev = m.steps[id];
      const next = { ...prev, ...patch };
      if (patch.status === 'running' && prev.status !== 'running') {
        next.startedAt = nowIso();
        next.endedAt = undefined;
        next.error = undefined;
      }
      if (patch.status && ['done', 'failed', 'skipped'].includes(patch.status)) next.endedAt = nowIso();
      m.steps[id] = next;
    });
  }

  async addCost(item: CostItem) {
    if (!(item.usd > 0)) return;
    await this.update((m) => {
      m.costs.push({ ...item, usd: Math.round(item.usd * 10000) / 10000 });
    });
  }
}

const handles = new Map<string, WorldHandle>();

export async function createWorld(opts: { options: WorldOptions; width: number; height: number }): Promise<WorldHandle> {
  const id = newWorldId();
  await mkdir(worldDir(id), { recursive: true });
  const now = nowIso();
  const manifest: WorldManifest = {
    id,
    createdAt: now,
    updatedAt: now,
    title: 'Untitled memory',
    status: 'queued',
    options: opts.options,
    image: { file: 'source.jpg', thumb: 'thumb.jpg', width: opts.width, height: opts.height },
    steps: initialSteps(),
    objects: [],
    depth: {},
    costs: [],
  };
  const handle = new WorldHandle(manifest);
  handles.set(id, handle);
  await handle.update(() => undefined);
  return handle;
}

export async function getWorld(id: string): Promise<WorldHandle | null> {
  if (!isWorldId(id)) return null;
  const cached = handles.get(id);
  if (cached) return cached;
  const file = path.join(worldDir(id), 'manifest.json');
  if (!existsSync(file)) return null;
  const manifest = JSON.parse(await readFile(file, 'utf8')) as WorldManifest;
  const handle = new WorldHandle(manifest);
  await handle.loadLog();
  handles.set(id, handle);
  return handle;
}

export async function listWorlds(): Promise<WorldManifest[]> {
  if (!existsSync(WORLDS_DIR)) return [];
  const entries = await readdir(WORLDS_DIR, { withFileTypes: true });
  const out: WorldManifest[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isWorldId(e.name)) continue;
    const h = await getWorld(e.name).catch(() => null);
    if (h) out.push(h.manifest);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteWorld(id: string) {
  handles.delete(id);
  emitters.delete(id);
  await rm(worldDir(id), { recursive: true, force: true });
}
