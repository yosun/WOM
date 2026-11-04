import { promptSignIn } from './auth.ts';
import type { WorldMetrics } from '../../server/src/wometrics.ts';
import type { VideoGeneration } from '../../server/src/types.ts';
import type { AppliedFix, AssetCheck, AssetFinding, AssetVerdict, FixSuggestion, FixSuggestions, LayoutOverride, ObservationCreated, ObservationIssue, ObservationIssuePage, ObservationRecord, ObservationStatus, ObservationSummary, PlacementMethod, SceneDoc, SlideDoc, SlideEntry, WorldManifest, WorldOptions } from '../../server/src/types.ts';

export type { AppliedFix, AssetCheck, AssetFinding, AssetVerdict, FixSuggestion, FixSuggestions, LayoutOverride, ObservationCreated, ObservationIssue, ObservationIssuePage, ObservationRecord, ObservationStatus, ObservationSummary, PlacementMethod, SceneDoc, SlideDoc, SlideEntry, WorldManifest, WorldOptions };
export type { VideoGeneration };

/** An observation with the title of its world, as listed across worlds. */
export type ObservationListItem = ObservationRecord & { worldTitle: string };

export interface WorldSummary {
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
  running: boolean;
}

export interface CreditPack {
  id: string;
  name: string;
  usd: number;
  credits: number;
  /** Stripe's page for this pack, with the buyer's id attached. */
  url: string;
}

export interface CreditsInfo {
  balance: number | null;
  worldCredits: number;
  unlimited: boolean;
  canCreate: boolean;
  /** What can be bought. Empty where payments are not set up. */
  packs: CreditPack[];
  /** Packs are bought with a test card: no money moves. */
  testMode: boolean;
}

async function json<T>(res: Response, prompt = false): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    if (res.status === 401 && prompt) void promptSignIn();
    const msg = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

export const api = {
  health: () => fetch('/api/health').then((r) => json<{ ok: boolean; keys?: { meta: boolean; ai3d: boolean }; defaults?: WorldOptions }>(r)),
  account: () => fetch('/api/account').then((r) => json<{ ai3dBalanceUsd: number | null }>(r)),
  /** What building a world costs, and how many credits this person has. Administrators and a server with no accounts build free. */
  credits: () => fetch('/api/credits').then((r) => json<CreditsInfo>(r)),
  /** Add a promo code's credits to the balance. */
  redeem: (code: string) =>
    fetch('/api/credits/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => json<{ balance: number; worldCredits: number }>(r)),
  /** Choose the name in this person's share links, /u/<name>/<world>. */
  setHandle: (handle: string) =>
    fetch('/api/me/handle', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle }) }).then((r) => json<{ user: { id: string; handle: string | null; role: 'user' | 'admin' } }>(r)),
  list: () => fetch('/api/worlds').then((r) => json<WorldSummary[]>(r)),
  get: (id: string) => fetch(`/api/worlds/${id}`).then((r) => json<{ manifest: WorldManifest; log: string[]; running: boolean; access: { handle: string | null; visibility: 'private' | 'link'; canEdit: boolean } }>(r)),
  scene: (id: string) => fetch(`/api/worlds/${id}/scene`).then((r) => json<{ scene: SceneDoc; layout: LayoutOverride[] }>(r)),
  metrics: (id: string) => fetch(`/api/worlds/${id}/metrics`).then((r) => json<WorldMetrics>(r)).then((report) => {
    if (!report || report.schema !== 'wometrics/1') throw new Error('Restart the API server to load the new WOMetrics endpoint.');
    return report;
  }),
  /** Owner only: 'link' lets anyone with the link look; 'private' lets only the owner. */
  setVisibility: (id: string, visibility: 'private' | 'link') =>
    fetch(`/api/worlds/${id}/visibility`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visibility }) }).then((r) => json<{ visibility: 'private' | 'link' }>(r, true)),
  create: (file: File, options: WorldOptions, frame?: number) => {
    const form = new FormData();
    form.append('image', file);
    form.append('options', JSON.stringify(options));
    if (frame !== undefined) form.append('frame', String(frame));
    return fetch('/api/worlds', { method: 'POST', body: form }).then((r) => json<WorldManifest>(r, true));
  },
  /** What a file holds before a world is made from it: frames, the camera's depth and mattes, the lens. */
  inspect: (file: File) => {
    const form = new FormData();
    form.append('image', file);
    return fetch('/api/inspect', { method: 'POST', body: form }).then((r) => json<UploadInfo>(r, true));
  },
  camera: (id: string) => fetch(`/api/worlds/${id}/camera`).then((r) => json<CameraReport>(r)),
  cameras: () => fetch('/api/cameras').then((r) => json<CameraReport[]>(r)),
  retry: (id: string) => fetch(`/api/worlds/${id}/retry`, { method: 'POST' }).then((r) => json<WorldManifest>(r, true)),
  recompose: (id: string) => fetch(`/api/worlds/${id}/recompose`, { method: 'POST' }).then((r) => json<{ diagnostics: string[] }>(r, true)),
  remove: (id: string) => fetch(`/api/worlds/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r, true)),
  saveLayout: (id: string, objects: LayoutOverride[]) =>
    fetch(`/api/worlds/${id}/layout`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objects }) }).then((r) => json<{ ok: boolean }>(r, true)),
  resetLayout: (id: string) => fetch(`/api/worlds/${id}/layout`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r, true)),
  setPlacement: (id: string, method: PlacementMethod) =>
    fetch(`/api/worlds/${id}/placement`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method }) }).then((r) => json<{ placement: SceneDoc['placement'] }>(r, true)),
  /** Run SAM 3.1 on points/box (source-image pixels) and keep the result as a draft; the world is unchanged. */
  maskPreview: (id: string, objectId: string, prompt: MaskPrompt) => post<MaskDraft>(`/api/worlds/${id}/objects/${objectId}/mask/preview`, prompt),
  /** Keep the draft: only this object's cutout, 3D asset and placements are rebuilt. */
  applyMask: (id: string, objectId: string) => post<WorldManifest>(`/api/worlds/${id}/objects/${objectId}/mask`, {}),
  restoreMask: (id: string, objectId: string, version: number) => post<WorldManifest>(`/api/worlds/${id}/objects/${objectId}/mask/restore`, { version }),
  /** Generate another object model for comparison, without switching the world to it. */
  generateAssets: (id: string, model: WorldOptions['meshModel']) => post<{ started: boolean }>(`/api/worlds/${id}/assets`, { model }),
  /** Show another object model every object already has (free: no 3D jobs, agent placements only from the cache). */
  useObjectModel: (id: string, model: WorldOptions['meshModel']) => post<{ started: boolean }>(`/api/worlds/${id}/object-model`, { model }),
  /** Save which agents place this world's objects; with `run`, chosen agents that have not placed them yet run now. */
  setAgents: (id: string, agents: WorldOptions['placementAgents'], run: boolean) =>
    post<{ agents: string[]; running: string[] }>(`/api/worlds/${id}/agents`, { agents, run }),
  /** Show another model's asset for one object only. Free: the asset exists. Runs in the background. */
  useObjectAsset: (id: string, objectId: string, model: WorldOptions['meshModel']) => post<{ started: boolean }>(`/api/worlds/${id}/objects/${objectId}/asset`, { model }),
  /** Look for leftovers of the photo's background in assets that have no check yet (about two cents each). */
  checkAssets: (id: string, scope: 'active' | 'all') => post<{ started: boolean; assets: number; estimateUsd: number }>(`/api/worlds/${id}/assets/check`, { scope }),
  /** Flags: the record as JSON plus the frame and the layer frames, as one multipart form. */
  postObservation: (world: string, form: FormData) => fetch(`/api/worlds/${world}/observations`, { method: 'POST', body: form }).then((r) => json<ObservationCreated>(r, true)),
  /** Every flag with its rays: for counting. Lists of problems use `issues`. */
  observations: (q: { world?: string; status?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.world) p.set('world', q.world);
    if (q.status) p.set('status', q.status);
    return fetch(`/api/observations?${p}`).then((r) => json<ObservationListItem[]>(r));
  },
  /** The flags grouped into problems, one page, without rays. */
  issues: (q: { world?: string; status?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.world) p.set('world', q.world);
    if (q.status) p.set('status', q.status);
    if (q.limit !== undefined) p.set('limit', String(q.limit));
    if (q.offset !== undefined) p.set('offset', String(q.offset));
    return fetch(`/api/issues?${p}`).then((r) => json<ObservationIssuePage>(r));
  },
  /** What can be done about the problem a flag belongs to, best first, with the evidence and price of each. Free to ask. */
  fixes: (world: string, oid: string) => fetch(`/api/worlds/${world}/observations/${oid}/fixes`).then((r) => json<FixSuggestions>(r)),
  /** Apply one. A fix with a price needs `approveUsd` of at least that. Runs in the background: poll `get` until it is not running. */
  applyFix: (world: string, oid: string, fix: string, approveUsd?: number) => post<{ started: boolean; fix: FixSuggestion }>(`/api/worlds/${world}/observations/${oid}/fix`, { fix, approveUsd }),
  /** The flagged view is right now: every sighting of the problem becomes fixed. With a picture of the view, it is kept beside the flagged frame. */
  markFixed: (world: string, oid: string, after?: Blob) => {
    const form = new FormData();
    if (after) form.append('after', after, 'after.jpg');
    return fetch(`/api/worlds/${world}/observations/${oid}/fixed`, { method: 'POST', body: after ? form : undefined }).then((r) => json<{ updated: number; issue: ObservationIssue }>(r, true));
  },
  /** One flag, with its rays. */
  observation: (world: string, oid: string) => fetch(`/api/worlds/${world}/observations/${oid}`).then((r) => json<ObservationRecord>(r)),
  /** The same change to several flags, such as every sighting of a problem. */
  updateObservations: (world: string, ids: string[], patch: Partial<Pick<ObservationRecord, 'status' | 'note' | 'category'>> & { suspect?: string | null }) =>
    fetch(`/api/worlds/${world}/observations`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, ...patch }) }).then((r) => json<{ updated: number }>(r, true)),
  /** Every slide of every built world, in time order. */
  slides: () => fetch('/api/slides').then((r) => json<SlideDoc[]>(r)),
  /** One world's slides: its photo first, then the views saved inside it. */
  worldSlides: (id: string) => fetch(`/api/worlds/${id}/slides`).then((r) => json<SlideDoc[]>(r)),
  /** Video jobs and completed clips made from this world's image planes. */
  videos: (id: string) => fetch(`/api/worlds/${id}/videos`).then((r) => json<VideoGeneration[]>(r)),
  /** Start one video from the source slide's full image. Request IDs make uncertain submissions safe to retry. */
  generateVideo: (id: string, input: { slideId: string; prompt: string; title?: string; requestId: string }) =>
    post<VideoGeneration>(`/api/worlds/${id}/videos`, input),
  /** Save a view as a slide: `record` ({ entry, title?, caption? }) and `image` (exactly what the entry's camera saw). */
  createSlide: (id: string, form: FormData) => fetch(`/api/worlds/${id}/slides`, { method: 'POST', body: form }).then((r) => json<SlideDoc>(r, true)),
  /** Update a view slide's name and/or caption. Empty captions clear the saved caption. */
  updateSlide: (id: string, slide: string, patch: { title?: string; caption?: string | null }) =>
    fetch(`/api/worlds/${id}/slides/${slide}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => json<SlideDoc>(r, true)),
  /** Backward-compatible name-only helper. */
  renameSlide: (id: string, slide: string, title: string) =>
    fetch(`/api/worlds/${id}/slides/${slide}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }).then((r) => json<SlideDoc>(r, true)),
  deleteSlide: (id: string, slide: string) => fetch(`/api/worlds/${id}/slides/${slide}`, { method: 'DELETE' }).then((r) => json<{ ok: boolean }>(r, true)),
};

function post<T>(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => json<T>(r, true));
}

export interface UploadInfo {
  kind: 'jpeg' | 'png' | 'webp' | 'avif' | 'heif' | 'video';
  primary: number;
  frames: { index: number; width: number; height: number; timeS?: number; thumb: string }[];
  aux: { type: string; width: number; height: number; accuracy?: string }[];
  camera?: WorldManifest['image']['camera'];
  cameraLine: string;
  notes: string[];
}

export interface CameraReport {
  world: string;
  title: string;
  camera?: WorldManifest['image']['camera'];
  depth: {
    model: string;
    hfovDeg: number;
    errorDeg?: number;
    phone?: { type: string; accuracy?: string; absRel: number; r: number; scale?: number; samples: number };
  }[];
  aux: { type: string; width: number; height: number; accuracy?: string; preview?: string }[];
  frames: number;
}

export interface MaskPrompt {
  points: { x: number; y: number; positive: boolean }[];
  box?: { x0: number; y0: number; x1: number; y1: number };
}

export interface MaskDraft {
  url: string;
  box: { x0: number; y0: number; x1: number; y1: number };
  area: number;
  coverage: number;
  costUsd: number;
}

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
