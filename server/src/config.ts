import path from 'node:path';
import type { WorldOptions } from './types.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const DATA_DIR = path.resolve(process.env.WOM_DATA_DIR ?? path.join(ROOT, 'data'));
export const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
export const WEB_DIST = path.join(ROOT, 'dist');

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '127.0.0.1';
/** Addresses that only this machine can reach. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// Sign-in (Clerk, auth.ts). WOM_AUTH=required turns it on and WOM_AUTH=off turns it off, and off is only allowed on this
// machine. Unset, sign-in is on when HOST reaches beyond this machine and off on localhost.
const WOM_AUTH = process.env.WOM_AUTH?.trim().toLowerCase() ?? '';
if (WOM_AUTH === 'off' && !LOOPBACK_HOSTS.includes(HOST)) {
  console.error(`WOM_AUTH=off turns sign-in off, which is only for this machine, but HOST is ${HOST}. Set HOST to 127.0.0.1 or remove WOM_AUTH.`);
  process.exit(1);
}
export const SIGN_IN_REQUIRED = WOM_AUTH === 'required' || (WOM_AUTH !== 'off' && !LOOPBACK_HOSTS.includes(HOST));

// Sign-in with Clerk (auth.ts). The publishable key is served to the browser; the secret key never leaves the server.
export const CLERK_PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY?.trim() ?? '';
export const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY?.trim() ?? '';
/** Origins the app is signed in from. Clerk rejects a session that was issued for any other origin. */
export const CLERK_AUTHORIZED_PARTIES = (process.env.CLERK_AUTHORIZED_PARTIES?.trim() || [
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
].join(',')).split(',').map((origin) => origin.trim()).filter(Boolean);

/**
 * Where people and worlds are recorded. 'fs' (the default) keeps worlds as files on this machine, for one person.
 * 'postgres' keeps owners, handles and visibility in Neon (db/migrations, users.ts), which is what lets a world be shared
 * at /u/<handle>/<world> while its owner alone changes it. Without it, a server that requires sign-in shares nothing.
 */
export const STORE: 'fs' | 'postgres' = process.env.WOM_STORE?.trim().toLowerCase() === 'postgres' ? 'postgres' : 'fs';
if (STORE === 'postgres' && !(process.env.DATABASE_URL?.trim() && process.env.DATABASE_URL_SYSTEM?.trim())) {
  console.error('WOM_STORE=postgres needs DATABASE_URL and DATABASE_URL_SYSTEM in .env (scripts/db-roles.mjs writes them).');
  process.exit(1);
}
/** What building one world costs a person who is not an administrator, in credits (credits.ts). Needs WOM_STORE=postgres. */
export const WORLD_CREDITS = Math.max(1, Math.round(Number(process.env.WOM_WORLD_CREDITS ?? 500)) || 500);
/** The address people reach WOM at, such as https://wom.quest, for the links in a shared world's preview. Unset, the request's own address is used. */
export const PUBLIC_ORIGIN = (process.env.WOM_PUBLIC_ORIGIN?.trim() ?? '').replace(/\/$/, '');

/** What reads HEIC/HEIF uploads: macOS ImageIO (the default on a Mac) or libheif through Python and pillow-heif (the default elsewhere). */
const heicDecoder = process.env.WOM_HEIC_DECODER?.trim().toLowerCase();
if (heicDecoder && heicDecoder !== 'imageio' && heicDecoder !== 'libheif') {
  console.warn(`WOM_HEIC_DECODER=${heicDecoder} is not "imageio" or "libheif"; using the default for this platform.`);
}
export const HEIC_DECODER: 'imageio' | 'libheif' = heicDecoder === 'imageio' || heicDecoder === 'libheif' ? heicDecoder : process.platform === 'darwin' ? 'imageio' : 'libheif';
/** The Python that has pillow-heif installed; it runs server/tools/libheif-extract.py. */
export const HEIC_PYTHON = process.env.WOM_HEIC_PYTHON?.trim() || 'python3';

export const META_BASE_URL = (process.env.MUSE_BASE_URL ?? 'https://api.meta.ai/v1').replace(/\/$/, '');
export const AI3D_BASE_URL = (process.env.AI3D_BASE_URL ?? 'https://api.ai3d.dev/v2').replace(/\/$/, '');

/** Upper bound on simultaneous AI3D generation jobs per world. */
export const MAX_PARALLEL_MESH_JOBS = Number(process.env.WOM_MAX_PARALLEL_MESH_JOBS ?? 4);

export function metaKey(): string {
  const key = process.env.MUSE_API_KEY ?? process.env.MODEL_API_KEY;
  if (!key) throw new Error('MUSE_API_KEY is not set. Add it to .env.');
  return key;
}

export function ai3dKey(): string {
  const key = process.env.AI3D_API_KEY;
  if (!key) throw new Error('AI3D_API_KEY is not set. Add it to .env.');
  return key;
}

export function keysConfigured() {
  return {
    meta: Boolean(process.env.MUSE_API_KEY ?? process.env.MODEL_API_KEY),
    ai3d: Boolean(process.env.AI3D_API_KEY),
  };
}

export const DEFAULT_OPTIONS: WorldOptions = {
  maxObjects: 5,
  plannerModel: 'muse-spark-1.3',
  meshModel: 'idol',
  worldModel: 'worldlabs',
  depthModel: 'moge3',
  completeOccluded: true,
  splitPeople: true,
  placementAgents: ['muse-spark-1.3', 'muse-wonder-1.0'],
};

/**
 * The options a retry runs with: the world's own, with any changes asked for. A world made before an option existed keeps the old
 * behaviour (MoGe-2 depth; people built whole), so that a retry never starts work, or spends money, that its first run did not.
 */
export function retryOptions(prev: Partial<WorldOptions>, body: Partial<WorldOptions> = {}): WorldOptions {
  return normalizeOptions({ ...prev, depthModel: prev.depthModel ?? 'moge2', splitPeople: prev.splitPeople ?? false, ...body });
}

export function normalizeOptions(input: Partial<WorldOptions> | undefined): WorldOptions {
  const o = { ...DEFAULT_OPTIONS, ...(input ?? {}) };
  const planners = ['muse-spark-1.3', 'muse-wonder-1.0'] as const;
  const meshes = ['idol', 'triposplat', 'tripo-v31', 'tripo-p1', 'tripo-h31-image', 'tripo-p1-image'] as const;
  const worlds = ['worldlabs', 'worldlabs-draft', 'none'] as const;
  const depths = ['moge2', 'moge3'] as const;
  return {
    maxObjects: Math.max(0, Math.min(8, Math.round(Number(o.maxObjects) || 0))),
    plannerModel: planners.includes(o.plannerModel) ? o.plannerModel : DEFAULT_OPTIONS.plannerModel,
    meshModel: meshes.includes(o.meshModel) ? o.meshModel : DEFAULT_OPTIONS.meshModel,
    worldModel: worlds.includes(o.worldModel) ? o.worldModel : DEFAULT_OPTIONS.worldModel,
    depthModel: depths.includes(o.depthModel) ? o.depthModel : DEFAULT_OPTIONS.depthModel,
    placementAgents: Array.isArray(o.placementAgents) ? [...new Set(o.placementAgents.filter((m) => planners.includes(m)))] : DEFAULT_OPTIONS.placementAgents,
    completeOccluded: Boolean(o.completeOccluded),
    splitPeople: Boolean(o.splitPeople),
  };
}
