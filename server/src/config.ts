import path from 'node:path';
import type { WorldOptions } from './types.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const DATA_DIR = path.resolve(process.env.WOM_DATA_DIR ?? path.join(ROOT, 'data'));
export const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
export const WEB_DIST = path.join(ROOT, 'dist');

export const PORT = Number(process.env.PORT ?? 8787);
export const HOST = process.env.HOST ?? '127.0.0.1';

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
  meshModel: 'triposplat',
  worldModel: 'worldlabs',
  completeOccluded: true,
};

export function normalizeOptions(input: Partial<WorldOptions> | undefined): WorldOptions {
  const o = { ...DEFAULT_OPTIONS, ...(input ?? {}) };
  const planners = ['muse-spark-1.3', 'muse-wonder-1.0'] as const;
  const meshes = ['triposplat', 'tripo-v31', 'tripo-p1', 'tripo-h31-image', 'tripo-p1-image'] as const;
  const worlds = ['worldlabs', 'worldlabs-draft', 'none'] as const;
  return {
    maxObjects: Math.max(0, Math.min(8, Math.round(Number(o.maxObjects) || 0))),
    plannerModel: planners.includes(o.plannerModel) ? o.plannerModel : DEFAULT_OPTIONS.plannerModel,
    meshModel: meshes.includes(o.meshModel) ? o.meshModel : DEFAULT_OPTIONS.meshModel,
    worldModel: worlds.includes(o.worldModel) ? o.worldModel : DEFAULT_OPTIONS.worldModel,
    completeOccluded: Boolean(o.completeOccluded),
  };
}
