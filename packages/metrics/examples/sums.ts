// A whole benchmark in one file: a task, two subjects (one free, one that costs money), a run, and the numbers.
//
//   node packages/metrics/examples/sums.ts
//
// Nothing here is specific to worlds, photos or any model: swap the cases, the scorer and the subjects and the
// same framework keeps the budget, the cache, the ledger, the stored runs and the reports.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBenchmark, defineSubject, defineTask, Ledger } from '@wom/metrics';

interface Sum { a: number; b: number }

// ---------- 1. a task: what is asked, and how an answer is scored ----------

const sums = defineTask<Sum, number>({
  id: 'sums',
  label: 'Sums',
  description: 'Add two numbers. The score is whether the answer is exact, and how far off it is.',
  metrics: [
    { id: 'exact', label: 'Exact', better: 'higher', format: 'percent' },
    { id: 'error', label: 'Error', better: 'lower', aggregate: 'meanAbs', digits: 1, range: [0, 10] },
  ],
  primary: 'exact',
  families: [
    { id: 'plain', label: 'No model', color: '#8ab8f0' },
    { id: 'model', label: 'Model', color: '#bfa4ee' },
  ],
  async cases() {
    const pairs: [number, number][] = [[2, 3], [10, 25], [7, 8], [99, 1]];
    return { cases: pairs.map(([a, b], i) => ({ id: `sum-${i}`, title: `${a} + ${b}`, dims: {}, data: { a, b } })) };
  },
  score(c, answer) {
    const error = answer - (c.data.a + c.data.b);
    return { scores: { exact: error === 0 ? 1 : 0, error } };
  },
});

// ---------- 2. subjects: anything that answers ----------

/** Free, and the reference the others are compared with. */
const calculator = defineSubject<Sum, number>({
  id: 'calculator',
  label: 'Calculator',
  methods: [{ id: 'calculator', label: 'Calculator', family: 'plain', baseline: true }],
  solve: async (c) => [{ method: 'calculator', answer: c.data.a + c.data.b }],
});

/** Costs $0.004 a question, and gets the big ones wrong. Every paid call goes through `spend.call`. */
const assistant = defineSubject<Sum, number>({
  id: 'assistant',
  label: 'Assistant',
  methods: [{ id: 'assistant', label: 'Assistant', family: 'model', subject: 'assistant-1', subjectLabel: 'Assistant' }],
  async solve(c, ctx) {
    const asked = await ctx.spend.call(
      { key: c.data, label: `assistant: ${c.title}`, estimateUsd: 0.01, ledger: { provider: 'acme', model: 'assistant-1' } },
      async () => ({ value: c.data.a + c.data.b + (c.data.a + c.data.b > 50 ? 1 : 0), costUsd: 0.004 }),
      { fresh: ctx.fresh },
    );
    return [{ method: 'assistant', answer: asked.value, costUsd: asked.costUsd, latencyMs: asked.latencyMs, calls: 1, cachedCalls: asked.cached ? 1 : 0 }];
  },
});

// ---------- 3. the benchmark: run, store, report ----------

const dir = mkdtempSync(path.join(os.tmpdir(), 'wom-sums-'));
const bench = createBenchmark({ dir: path.join(dir, 'bench'), ledger: new Ledger(path.join(dir, 'ledger.jsonl')) }).register(sums);

const first = await bench.run(sums, [calculator, assistant], { maxUsd: 0.5, log: () => undefined });
console.log(`first run:  paid $${first.spend.usd.toFixed(3)} for ${first.spend.newCalls} calls`);

// The same questions again are answered from the cache: nothing is paid.
const again = await bench.run(sums, [calculator, assistant], { maxUsd: 0, log: () => undefined });
console.log(`second run: paid $${again.spend.usd.toFixed(3)}, ${again.spend.cachedCalls} answers from the cache`);

// What the dashboard shows, as data.
const view = (await bench.view('sums', again.id))!;
for (const row of view.summary) {
  console.log(`${row.method.padEnd(11)} exact ${(100 * (row.scores.exact ?? 0)).toFixed(0)}%  error ${row.scores.error?.toFixed(1)}  cost $${row.costUsd.toFixed(3)}`);
}
console.log(`stored in ${path.join(dir, 'bench', 'sums', again.id)} (results.json, report.md)`);
