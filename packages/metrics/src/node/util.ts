// Small helpers the node side shares.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Write to a temporary file and rename it over the target, so a reader never sees half a file. */
export async function writeFileAtomic(file: string, data: string | Buffer) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** Like Promise.allSettled over `items`, but at most `limit` run at once. Results keep the order of `items`. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        out[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** `20261101-215829` from the current time (UTC): sorts by time and is safe in a path. */
export function newRunId(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/** A path-safe name for a case id. */
export const slug = (id: string) => id.replace(/[/@]/g, '__');
