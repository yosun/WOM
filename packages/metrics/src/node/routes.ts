// The HTTP side the dashboard reads. Mount it in the application's Hono app:
//
//   app.route('/', createMetricsRoutes(bench, { usage: () => ({ ...hooks }) }));
//
//   GET /api/bench/tasks                    every task, with how many runs it has
//   GET /api/bench/:task/runs               a task's runs, newest first
//   GET /api/bench/:task/runs/:id           one run as the dashboard shows it (RunView)
//   GET /api/bench/spend                    what the ledger says was paid for (SpendSummary)
//   GET /bench-files/:task/:id/<path>       a file of a run: overlays, sheets, report.md, results.json
//
// Observations and camera reports belong to the application, which stores and serves them; the dashboard
// asks for them at the paths documented in the README.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import type { Benchmark } from './benchmark.ts';
import { isRunId, isTaskId } from './store.ts';
import type { UsageHooks } from './usage.ts';

export interface RoutesOptions {
  /** What the ledger's labels mean in this application. Called for each spend report. */
  usage?: () => Promise<UsageHooks> | UsageHooks;
}

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
};

export function createMetricsRoutes(bench: Benchmark, o: RoutesOptions = {}): Hono {
  const app = new Hono();

  app.get('/api/bench/tasks', async (c) => c.json(await bench.tasks()));

  app.get('/api/bench/spend', async (c) => c.json(await bench.usage(await o.usage?.())));

  app.get('/api/bench/:task/runs', async (c) => {
    const task = c.req.param('task');
    if (!isTaskId(task)) return c.json({ error: 'not found' }, 404);
    return c.json(await bench.runs(task));
  });

  app.get('/api/bench/:task/runs/:id', async (c) => {
    const task = c.req.param('task'), id = c.req.param('id');
    if (!isTaskId(task) || !isRunId(id)) return c.json({ error: 'not found' }, 404);
    const view = await bench.view(task, id);
    return view ? c.json(view) : c.json({ error: 'not found' }, 404);
  });

  app.get('/bench-files/:task/:id/*', async (c) => {
    const task = c.req.param('task'), id = c.req.param('id');
    if (!isTaskId(task) || !isRunId(id)) return c.json({ error: 'not found' }, 404);
    const rel = decodeURIComponent(c.req.path.slice(`/bench-files/${task}/${id}/`.length));
    const file = bench.store.resolve(task, id, rel);
    const type = TYPES[path.extname(rel).toLowerCase()];
    if (!file || !type) return c.json({ error: 'not found' }, 404);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return c.json({ error: 'not found' }, 404);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { 'Content-Type': type, 'Content-Length': String(info.size), 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' },
    });
  });

  return app;
}
