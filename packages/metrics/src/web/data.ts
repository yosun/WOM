// What the dashboard reads from the server (the routes in node/routes.ts). Every request is made once and
// shared by the tabs that need it; a failed one is forgotten so the next visit to a tab tries again.
import type { RunItem, RunView, SpendSummary, TaskItem } from '../core/types.ts';
import { StaleServerError } from './ui.ts';

const STALE = 'The metrics API is not available from this server. If it was started before this version, restart it (npm run dev, or npm start).';

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  // A server that predates the routes answers with a 404, or with the app's page instead of JSON.
  if (r.status === 404 && /\/api\/bench\/(tasks|spend)$/.test(url)) throw new StaleServerError(STALE);
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${url}: ${r.status}`);
  }
  try {
    return (await r.json()) as T;
  } catch {
    throw new StaleServerError(STALE);
  }
}

export class MetricsData {
  private memo = new Map<string, Promise<unknown>>();
  private readonly base: string;

  /** `base` is where the routes are mounted, without a trailing slash. */
  constructor(base = '') {
    this.base = base;
  }

  /**
   * Make a request once for this page: the same key gets the same answer, and a failed one is forgotten.
   * An application's own tabs use it so that two tabs asking for the same thing ask the server once.
   */
  remember<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.memo.set(key, p);
      p.catch(() => this.memo.delete(key));
    }
    return p;
  }

  /** Every task, with how many runs it has. */
  tasks(): Promise<TaskItem[]> {
    return this.remember('tasks', async () => {
      const v = await getJson<TaskItem[]>(`${this.base}/api/bench/tasks`);
      if (!Array.isArray(v)) throw new StaleServerError(STALE);
      return v;
    });
  }

  /** The runs of a task, newest first. */
  runs(task: string): Promise<RunItem[]> {
    return this.remember(`runs:${task}`, async () => {
      const v = await getJson<RunItem[]>(`${this.base}/api/bench/${encodeURIComponent(task)}/runs`);
      if (!Array.isArray(v)) throw new StaleServerError(STALE);
      return v;
    });
  }

  run(task: string, id: string): Promise<RunView> {
    return this.remember(`run:${task}:${id}`, () => getJson<RunView>(`${this.base}/api/bench/${encodeURIComponent(task)}/runs/${encodeURIComponent(id)}`));
  }

  spend(): Promise<SpendSummary> {
    return this.remember('spend', async () => {
      const v = await getJson<SpendSummary>(`${this.base}/api/bench/spend`);
      // A server that predates this version has the same report without the per-case costs.
      if (!v || !Array.isArray(v.perCase)) throw new StaleServerError(STALE);
      return v;
    });
  }

  /** Where a run's files (report.md, results.json, overlays) are served. */
  fileUrl(task: string, id: string, rel: string): string {
    return `${this.base}/bench-files/${task}/${id}/${rel}`;
  }
}
