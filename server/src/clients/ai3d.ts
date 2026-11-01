// Client for the AI3D API v2 (https://api.ai3d.dev/v2): uploads, asynchronous jobs and artifact downloads.
// The API owns provider credentials; we only ever talk to AI3D.
import { AI3D_BASE_URL, ai3dKey } from '../config.ts';
import { HttpError, sleep, streamToFile, withRetry } from '../util.ts';

export interface Ai3dArtifact {
  name: string;
  size: number;
  content_type?: string;
  role?: string;
  variant?: string;
  source_path?: string;
  download_url: string;
  public_url?: string;
}

export interface Ai3dJob {
  id: string;
  status: string;
  model: string;
  error?: unknown;
  viewer_url?: string;
  artifacts?: Ai3dArtifact[];
  billing?: {
    state?: string;
    reserved_nano_usd?: number | null;
    charged_nano_usd?: number | null;
  };
  [key: string]: unknown;
}

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'submission_unknown', 'canceled', 'cancelled']);

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${ai3dKey()}`, ...extra };
}

async function readJson(res: Response, label: string) {
  const text = await res.text();
  if (!res.ok) throw new HttpError(`AI3D ${label} returned ${res.status}`, res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`AI3D ${label} returned invalid JSON`, 502, text.slice(0, 500));
  }
}

/** Upload a PNG/JPEG/WebP (≤10 MiB) and get a signed public HTTPS image_url for job inputs. */
export async function uploadImage(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
  if (bytes.byteLength > 10 * 1024 * 1024) throw new Error(`${filename} is larger than the 10 MiB AI3D upload limit`);
  return withRetry(`upload ${filename}`, async () => {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const res = await fetch(`${AI3D_BASE_URL}/uploads`, {
      method: 'POST',
      headers: authHeaders(),
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const json = await readJson(res, 'upload');
    if (!json.image_url) throw new Error('AI3D upload response had no image_url');
    return json.image_url as string;
  });
}

// AI3D asks clients to admit prepaid jobs one at a time per account.
let submitChain: Promise<unknown> = Promise.resolve();

export interface SubmitJobBody {
  model: string;
  image_url?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Submit a job. Retries reuse the same idempotency key, so a timed-out request never creates a duplicate.
 * If the key was already used, AI3D returns the original job.
 */
export function submitJob(body: SubmitJobBody, idempotencyKey: string, path = '/jobs'): Promise<Ai3dJob> {
  const run = async () =>
    withRetry(`submit ${body.model}`, async () => {
      const res = await fetch(`${AI3D_BASE_URL}${path}`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      return (await readJson(res, `submit ${body.model}`)) as Ai3dJob;
    });
  const result = submitChain.then(run, run);
  submitChain = result.catch(() => undefined);
  return result;
}

export async function getJob(jobId: string): Promise<Ai3dJob> {
  return withRetry(`get job ${jobId}`, async () => {
    const res = await fetch(`${AI3D_BASE_URL}/jobs/${encodeURIComponent(jobId)}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(60_000),
    });
    return (await readJson(res, 'get job')) as Ai3dJob;
  }, { attempts: 6 });
}

/** Find a job previously created with this idempotency key (used to resume after a restart). */
export async function findJobByKey(idempotencyKey: string): Promise<Ai3dJob | null> {
  const res = await fetch(`${AI3D_BASE_URL}/jobs/recovery/${encodeURIComponent(idempotencyKey)}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) return null;
  const json = await readJson(res, 'job recovery');
  const job = (json.job ?? json) as Ai3dJob;
  return job?.id ? job : null;
}

export async function waitForJob(
  jobId: string,
  opts: { timeoutMs: number; pollMs?: number; onUpdate?: (job: Ai3dJob) => void },
): Promise<Ai3dJob> {
  const deadline = Date.now() + opts.timeoutMs;
  let pollMs = opts.pollMs ?? 4000;
  let lastStatus = '';
  for (;;) {
    const job = await getJob(jobId);
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      opts.onUpdate?.(job);
    }
    if (TERMINAL_STATUSES.has(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`AI3D job ${jobId} (${job.model}) did not finish within ${Math.round(opts.timeoutMs / 60000)} min (last status ${job.status})`);
    await sleep(pollMs);
    pollMs = Math.min(pollMs * 1.25, 15000);
  }
}

export async function downloadArtifact(artifact: Ai3dArtifact, file: string) {
  await withRetry(`download ${artifact.name}`, async () => {
    const res = await fetch(artifact.download_url, {
      headers: authHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok || !res.body) throw new HttpError(`AI3D download ${artifact.name} returned ${res.status}`, res.status, await res.text().catch(() => ''));
    await streamToFile(res.body, file);
  });
}

export function jobErrorText(job: Ai3dJob): string {
  if (!job.error) return `job ended with status ${job.status}`;
  return typeof job.error === 'string' ? job.error : JSON.stringify(job.error);
}

export function chargedUsd(job: Ai3dJob): number | undefined {
  const nano = job.billing?.charged_nano_usd ?? undefined;
  return typeof nano === 'number' ? nano / 1e9 : undefined;
}

export function reservedUsd(job: Ai3dJob): number | undefined {
  const nano = job.billing?.reserved_nano_usd ?? undefined;
  return typeof nano === 'number' ? nano / 1e9 : undefined;
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${AI3D_BASE_URL}/models?format=json`, { headers: authHeaders(), signal: AbortSignal.timeout(30_000) });
  const json = await readJson(res, 'models');
  return (json.models ?? []).map((m: { id: string }) => m.id);
}

export async function accountBalanceUsd(): Promise<number | null> {
  const res = await fetch(`${AI3D_BASE_URL}/account`, { headers: authHeaders(), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const json = await res.json();
  const nano = json.available_credit_nano_usd ?? json.balance_nano_usd;
  return typeof nano === 'number' ? nano / 1e9 : null;
}
