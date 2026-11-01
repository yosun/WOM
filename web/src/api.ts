import type { LayoutOverride, SceneDoc, WorldManifest, WorldOptions } from '../../server/src/types.ts';

export type { LayoutOverride, SceneDoc, WorldManifest, WorldOptions };

export interface WorldSummary {
  id: string;
  title: string;
  status: WorldManifest['status'];
  createdAt: string;
  thumb: string;
  objects: number;
  hasWorld: boolean;
  costUsd: number;
  running: boolean;
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  health: () => fetch('/api/health').then((r) => json<{ ok: boolean; keys: { meta: boolean; ai3d: boolean }; defaults: WorldOptions }>(r)),
  account: () => fetch('/api/account').then((r) => json<{ ai3dBalanceUsd: number | null }>(r)),
  list: () => fetch('/api/worlds').then((r) => json<WorldSummary[]>(r)),
  get: (id: string) => fetch(`/api/worlds/${id}`).then((r) => json<{ manifest: WorldManifest; log: string[]; running: boolean }>(r)),
  scene: (id: string) => fetch(`/api/worlds/${id}/scene`).then((r) => json<{ scene: SceneDoc; layout: LayoutOverride[] }>(r)),
  create: (file: File, options: WorldOptions) => {
    const form = new FormData();
    form.append('image', file);
    form.append('options', JSON.stringify(options));
    return fetch('/api/worlds', { method: 'POST', body: form }).then((r) => json<WorldManifest>(r));
  },
  retry: (id: string) => fetch(`/api/worlds/${id}/retry`, { method: 'POST' }).then((r) => json<WorldManifest>(r)),
  recompose: (id: string) => fetch(`/api/worlds/${id}/recompose`, { method: 'POST' }).then((r) => json<{ diagnostics: string[] }>(r)),
  remove: (id: string) => fetch(`/api/worlds/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
  saveLayout: (id: string, objects: LayoutOverride[]) =>
    fetch(`/api/worlds/${id}/layout`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objects }) }).then((r) => json<{ ok: boolean }>(r)),
  resetLayout: (id: string) => fetch(`/api/worlds/${id}/layout`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r)),
};

export function subscribe(id: string, handlers: { manifest: (m: WorldManifest, running: boolean) => void; log: (line: string) => void }) {
  const es = new EventSource(`/api/worlds/${id}/events`);
  es.addEventListener('manifest', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as { manifest: WorldManifest; running: boolean };
    handlers.manifest(data.manifest, data.running);
  });
  es.addEventListener('log', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as { message: string; at: string };
    if (data.message) handlers.log(`${data.at} ${data.message}`);
  });
  return () => es.close();
}
