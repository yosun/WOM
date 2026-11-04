// World storage on disk: data/worlds/<id>/manifest.json plus every artifact the pipeline produces.
// Manifest writes are serialized per world and broadcast to SSE subscribers.
//
// With WOM_STORE=postgres (config.ts) the database is the record of who owns a world, who may see it, and its manifest:
// every manifest write also goes to the worlds table, as the world's owner. The files stay on disk beside it, and
// manifest.json is still written so the command-line tools keep working.
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SIGN_IN_REQUIRED, STORE, WORLDS_DIR } from './config.ts';
import { asCaller, asSystem, type Caller } from './db.ts';
import { appendLedger } from './ledger.ts';
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

/** Who may see and change a world. Kept apart from the manifest, which the pipeline owns. */
export interface WorldAccess {
  ownerId: string;
  /** The owner's public name, as in /u/<handle>/<world>. */
  handle: string | null;
  /** 'link': anyone with the link can look. 'private': only the owner. */
  visibility: 'private' | 'link';
  /** Taken down. Hidden from everyone but its owner and admins. */
  removed: boolean;
}

/** The columns of the worlds table that mirror the manifest, worked out when the manifest changes. */
interface WorldRow {
  title: string;
  status: string;
  manifest: string;
  objects: number;
  hasWorld: boolean;
  costUsd: number;
  sceneKey: string | null;
}

function rowOf(m: WorldManifest, snapshot: string): WorldRow {
  return {
    title: m.title,
    status: m.status,
    manifest: snapshot,
    objects: m.objects.length,
    hasWorld: Boolean(m.world?.splats?.length),
    costUsd: Math.round(m.costs.reduce((a, c) => a + c.usd, 0) * 10000) / 10000,
    sceneKey: m.scene?.file ?? null,
  };
}

async function saveRow(ownerId: string, id: string, r: WorldRow) {
  await asCaller({ id: ownerId, role: 'user' }, (db) => db.query(
    'update worlds set title = $2, status = $3, manifest = $4::jsonb, objects_count = $5, has_world = $6, cost_usd = $7, scene_key = $8, version = version + 1, updated_at = now() where id = $1',
    [id, r.title, r.status, r.manifest, r.objects, r.hasWorld, r.costUsd, r.sceneKey],
  ));
}

export class WorldHandle {
  readonly id: string;
  /** The Clerk id of the owner ('local' when worlds live on this machine alone). The pipeline saves as them. */
  readonly ownerId: string;
  manifest: WorldManifest;
  private writing: Promise<void> = Promise.resolve();
  private logLines: string[] = [];

  constructor(manifest: WorldManifest, ownerId = 'local') {
    this.id = manifest.id;
    this.ownerId = ownerId;
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
    const row = STORE === 'postgres' ? rowOf(this.manifest, snapshot) : null;
    this.writing = this.writing.then(() => writeFileAtomic(this.file('manifest.json'), snapshot)).catch((err) => {
      console.error(`[store] failed to write manifest for ${this.id}:`, err);
    });
    if (row) {
      this.writing = this.writing.then(() => saveRow(this.ownerId, this.id, row)).catch((err) => {
        console.error(`[store] failed to save world ${this.id} to the database:`, err);
      });
    }
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

  async addCost(item: CostItem, extra: { model?: string; jobId?: string } = {}) {
    if (!(item.usd > 0)) return;
    const usd = Math.round(item.usd * 10000) / 10000;
    await this.update((m) => {
      m.costs.push({ ...item, usd });
    });
    void appendLedger({ at: nowIso(), context: 'pipeline', provider: item.provider, label: item.label, usd, estimated: item.estimated, worldId: this.id, ...extra });
  }
}

const handles = new Map<string, WorldHandle>();

/** `owner` is the person who made the world; with WOM_STORE=postgres the world is recorded as theirs, visible by link. */
export async function createWorld(opts: { options: WorldOptions; width: number; height: number; owner: { id: string } }): Promise<WorldHandle> {
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
  if (STORE === 'postgres') {
    try {
      const row = rowOf(manifest, JSON.stringify(manifest, null, 2));
      await asCaller({ id: opts.owner.id, role: 'user' }, (db) => db.query(
        'insert into worlds (id, owner_id, title, status, manifest, objects_count, has_world, cost_usd, created_at, updated_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9)',
        [id, opts.owner.id, row.title, row.status, row.manifest, row.objects, row.hasWorld, row.costUsd, now],
      ));
    } catch (err) {
      await rm(worldDir(id), { recursive: true, force: true });
      throw err;
    }
    accessCache.delete(id);
  }
  const handle = new WorldHandle(manifest, STORE === 'postgres' ? opts.owner.id : 'local');
  handles.set(id, handle);
  await handle.update(() => undefined);
  return handle;
}

const loading = new Map<string, Promise<WorldHandle | null>>();

export function getWorld(id: string): Promise<WorldHandle | null> {
  if (!isWorldId(id)) return Promise.resolve(null);
  const cached = handles.get(id);
  if (cached) return Promise.resolve(cached);
  // Two requests for a world that is not loaded yet share one load, so they get the same handle.
  let pending = loading.get(id);
  if (!pending) {
    pending = loadWorld(id).finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

async function loadWorld(id: string): Promise<WorldHandle | null> {
  const file = path.join(worldDir(id), 'manifest.json');
  let ownerId = 'local';
  let manifest: WorldManifest | null = null;
  if (STORE === 'postgres') {
    // A world exists when the database has it. Worlds only on disk wait for scripts/import-worlds.mjs to give them an owner.
    const r = await asSystem((db) => db.query<{ owner_id: string; manifest: WorldManifest }>('select owner_id, manifest from worlds where id = $1', [id]));
    if (!r.rows[0]) return null;
    ownerId = r.rows[0].owner_id;
    manifest = r.rows[0].manifest;
    await mkdir(worldDir(id), { recursive: true });
    // A manifest on disk that is newer than the database's means a database write was lost; the next update saves it.
    if (existsSync(file)) {
      const onDisk = JSON.parse(await readFile(file, 'utf8')) as WorldManifest;
      if (onDisk.updatedAt > manifest.updatedAt) manifest = onDisk;
    }
  } else {
    if (!existsSync(file)) return null;
    manifest = JSON.parse(await readFile(file, 'utf8')) as WorldManifest;
  }
  // Steps added in later versions start as pending; labels follow the current wording.
  const finished = manifest.status === 'done' || manifest.status === 'partial';
  for (const s of STEP_ORDER) {
    // a world that was built before the step existed never ran it: say so instead of showing it as waiting
    if (!manifest.steps[s.id]) manifest.steps[s.id] = finished && s.id === 'split' ? { id: s.id, label: s.label, status: 'skipped', message: 'Added after this world was built' } : { id: s.id, label: s.label, status: 'pending' };
    else manifest.steps[s.id].label = s.label;
  }
  const handle = new WorldHandle(manifest, ownerId);
  await handle.loadLog();
  handles.set(id, handle);
  return handle;
}

/** Every world this server holds, whoever owns it: for boot work and admin pages. People get `listWorldsFor`. */
export async function listWorlds(): Promise<WorldManifest[]> {
  let ids: string[];
  if (STORE === 'postgres') {
    ids = (await asSystem((db) => db.query<{ id: string }>('select id from worlds order by created_at desc'))).rows.map((r) => r.id);
  } else {
    if (!existsSync(WORLDS_DIR)) return [];
    const entries = await readdir(WORLDS_DIR, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory() && isWorldId(e.name)).map((e) => e.name);
  }
  const out: WorldManifest[] = [];
  for (const id of ids) {
    const h = await getWorld(id).catch(() => null);
    if (h) out.push(h.manifest);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One line of a person's list of worlds. */
export interface WorldListItem {
  id: string;
  title: string;
  status: WorldManifest['status'];
  createdAt: string;
  thumb: string;
  objects: number;
  hasWorld: boolean;
  costUsd: number;
  handle: string | null;
  visibility: 'private' | 'link';
}

/** The worlds a person owns, newest first. `all` lists everyone's, for an admin. */
export async function listWorldsFor(caller: Caller, all = false): Promise<WorldListItem[]> {
  if (STORE === 'postgres') {
    const r = await asCaller(caller, (db) => db.query<{
      id: string; title: string; status: WorldManifest['status']; created_at: Date; thumb: string | null; objects_count: number;
      has_world: boolean; cost_usd: string; handle: string | null; visibility: 'private' | 'link';
    }>(
      `select w.id, w.title, w.status, w.created_at, w.manifest->'image'->>'thumb' as thumb, w.objects_count, w.has_world,
              w.cost_usd, p.handle, w.visibility
         from worlds w left join public_profiles p on p.id = w.owner_id
        where ($2::boolean and wom.is_admin()) or w.owner_id = $1
        order by w.created_at desc`,
      [caller.id, all],
    ));
    return r.rows.map((w) => ({
      id: w.id,
      title: w.title,
      status: w.status,
      createdAt: w.created_at.toISOString(),
      thumb: `/files/${w.id}/${w.thumb ?? 'thumb.jpg'}`,
      objects: w.objects_count,
      hasWorld: w.has_world,
      costUsd: Number(w.cost_usd),
      handle: w.handle,
      visibility: w.visibility,
    }));
  }
  return (await listWorlds()).map((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    createdAt: m.createdAt,
    thumb: `/files/${m.id}/${m.image.thumb}`,
    objects: m.objects.length,
    hasWorld: Boolean(m.world?.splats?.length),
    costUsd: m.costs.reduce((a, b) => a + b.usd, 0),
    handle: 'local',
    visibility: 'link',
  }));
}

const accessCache = new Map<string, { access: WorldAccess | null; until: number }>();
const ACCESS_TTL_MS = 10_000;

/**
 * Who owns a world and who may look at it, or null when there is no such world. Read from the database and kept for
 * ten seconds, so a world made private or taken down is hidden within that time, by every copy of the server.
 */
export async function worldAccess(id: string): Promise<WorldAccess | null> {
  if (!isWorldId(id)) return null;
  if (STORE !== 'postgres') {
    // One person's machine: the worlds are theirs. Where sign-in is required without a database, nothing is shared.
    const here = handles.has(id) || existsSync(path.join(worldDir(id), 'manifest.json'));
    return here ? { ownerId: 'local', handle: 'local', visibility: SIGN_IN_REQUIRED ? 'private' : 'link', removed: false } : null;
  }
  const hit = accessCache.get(id);
  if (hit && hit.until > Date.now()) return hit.access;
  const r = await asSystem((db) => db.query<{ owner_id: string; handle: string | null; visibility: 'private' | 'link'; removed_at: Date | null }>(
    'select w.owner_id, u.handle, w.visibility, w.removed_at from worlds w join users u on u.id = w.owner_id where w.id = $1',
    [id],
  ));
  const row = r.rows[0];
  const access: WorldAccess | null = row ? { ownerId: row.owner_id, handle: row.handle, visibility: row.visibility, removed: row.removed_at !== null } : null;
  accessCache.set(id, { access, until: Date.now() + ACCESS_TTL_MS });
  return access;
}

/** Drop what was kept about who may see worlds: one world, or all of them (a handle changed). */
export function forgetAccess(id?: string) {
  if (id) accessCache.delete(id);
  else accessCache.clear();
}

/** Let anyone with the link look at a world, or only its owner. Answers false when there is no such world for this person to change. */
export async function setVisibility(id: string, visibility: 'private' | 'link', caller: Caller): Promise<boolean> {
  if (STORE !== 'postgres') throw new Error('Who can see a world is kept in the database: start the server with WOM_STORE=postgres.');
  const r = await asCaller(caller, (db) => db.query('update worlds set visibility = $2, updated_at = now() where id = $1', [id, visibility]));
  forgetAccess(id);
  return r.rowCount === 1;
}

export async function deleteWorld(id: string) {
  if (STORE === 'postgres') {
    const owner = (await getWorld(id))?.ownerId;
    // The database forgets the world, and with it its log, slides and observations (cascade).
    if (owner) await asCaller({ id: owner, role: 'user' }, (db) => db.query('delete from worlds where id = $1', [id]));
    forgetAccess(id);
  }
  handles.delete(id);
  emitters.delete(id);
  await rm(worldDir(id), { recursive: true, force: true });
}
