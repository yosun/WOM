import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export class HttpError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function isRetryableStatus(status: number) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** Retry an async operation on transient HTTP and network failures with exponential backoff and jitter. */
export async function withRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  opts: { attempts?: number; baseMs?: number; retryOn?: (err: unknown) => boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const retryable = opts.retryOn
        ? opts.retryOn(err)
        : err instanceof HttpError
          ? isRetryableStatus(err.status)
          : err instanceof TypeError || (err as Error)?.name === 'TimeoutError';
      if (!retryable || attempt === attempts) break;
      const delay = baseMs * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
      console.warn(`[retry] ${label} failed (attempt ${attempt}/${attempts}): ${(err as Error).message}; retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export async function writeFileAtomic(file: string, data: string | Uint8Array) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function streamToFile(body: ReadableStream<Uint8Array>, file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.part`;
  await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
  await rename(tmp, file);
}

export function nowIso() {
  return new Date().toISOString();
}

export function errorMessage(err: unknown): string {
  if (err instanceof HttpError) {
    const snippet = err.body.length > 400 ? `${err.body.slice(0, 400)}…` : err.body;
    return `${err.message}${snippet ? `: ${snippet}` : ''}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Run tasks with a concurrency limit, collecting settled results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function median(values: ArrayLike<number>): number {
  const arr = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  if (arr.length === 0) return Number.NaN;
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const arr = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  if (arr.length === 0) return Number.NaN;
  const idx = clamp((arr.length - 1) * p, 0, arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
}
