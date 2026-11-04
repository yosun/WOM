// The benchmark: register tasks, run subjects on them, keep the runs, the spend and the reports.
//
//   const bench = createBenchmark({ dir: 'data/bench', ledger: new Ledger('data/ledger.jsonl') });
//   bench.register(placement);
//   await bench.run(placement, [solver, assistant], { maxUsd: 3 });      // stored; shown by the dashboard
//   const scored = await bench.evaluate(placement, someCase, [assistant], { spend });   // one case, not stored
//
// A run covers every case of the task with every subject. All subjects answer a case at once; each answer is
// scored by the task; then the task may add scores that compare the answers and keep files for the case.
import path from 'node:path';
import { isNum, metricOf, sortMethods } from '../core/analyze.ts';
import type { CaseRecord, MethodSpec, ResultRecord, RunFile, RunItem, RunView, TaskInfo, TaskItem } from '../core/types.ts';
import { taskInfo, type Answer, type Case, type CaseSelection, type FinishOutcome, type Outcome, type ScoreContext, type ScoredAnswer, type Subject, type Task } from './define.ts';
import type { Ledger } from './ledger.ts';
import { renderReport } from './report.ts';
import { BudgetExceeded, Spend } from './spend.ts';
import { isRunId, RunStore } from './store.ts';
import { summarizeLedger, type UsageHooks } from './usage.ts';
import { buildRunView, taskInfoOf } from './view.ts';
import { errorMessage, mapLimit, newRunId, nowIso, writeFileAtomic } from './util.ts';

export interface BenchmarkOptions {
  /** Where runs are kept: <dir>/<task>/<run>/. */
  dir: string;
  ledger: Ledger;
  /** Where paid answers are cached. Default <dir>/cache. */
  cacheDir?: string;
}

export interface RunOptions {
  selection?: CaseSelection;
  /** Cap on new paid calls. Default 0: only answers already in the cache are used. */
  maxUsd?: number;
  /** Cases measured at once. Default 2. */
  concurrency?: number;
  /** Ask again instead of using cached answers. */
  fresh?: boolean;
  /** How the run was set up, kept with it and shown by the dashboard. */
  config?: Record<string, unknown>;
  log?: (message: string) => void;
  id?: string;
}

export interface EvaluateOptions {
  /** The budget to spend from. Default: a fresh one that allows no new paid calls. */
  spend?: Spend;
  fresh?: boolean;
  log?: (message: string) => void;
}

type AnyTask = Task<any, any>;

export class Benchmark {
  readonly dir: string;
  readonly ledger: Ledger;
  readonly cacheDir: string;
  readonly store: RunStore;
  private readonly known = new Map<string, AnyTask>();

  constructor(o: BenchmarkOptions) {
    this.dir = o.dir;
    this.ledger = o.ledger;
    this.cacheDir = o.cacheDir ?? path.join(o.dir, 'cache');
    this.store = new RunStore(o.dir);
  }

  register(task: AnyTask): this {
    this.known.set(task.id, task);
    return this;
  }

  task(id: string): AnyTask | undefined {
    return this.known.get(id);
  }

  /** A budget that books to this benchmark's ledger and caches in its cache folder. */
  budget(o: { maxUsd: number; id: string }): Spend {
    return new Spend({ maxUsd: o.maxUsd, id: o.id, ledger: this.ledger, cacheDir: this.cacheDir });
  }

  // ---------- measuring ----------

  async run<D, A>(task: Task<D, A>, subjects: Subject<D, A>[], o: RunOptions = {}): Promise<RunFile> {
    const log = o.log ?? console.log;
    const id = o.id ?? newRunId();
    if (!isRunId(id)) throw new Error(`invalid run id ${id}`);
    const startedAt = nowIso();
    const methods = this.methodsOf(subjects);
    const maxUsd = o.maxUsd ?? 0, concurrency = Math.max(1, o.concurrency ?? 2), fresh = o.fresh ?? false;
    const spend = this.budget({ maxUsd, id });

    const built = await task.cases(o.selection ?? {}, { log });
    const skipped = [...(built.skipped ?? [])];
    log(`${task.id} ${id}: ${built.cases.length} case(s), ${subjects.length} subject(s), budget $${maxUsd.toFixed(2)}`);
    if (skipped.length) log(`not available (skipped): ${skipped.join(', ')}`);

    const write = (rel: string, data: string | Buffer) => this.store.writeFile(task.id, id, rel, data);
    const settled = await mapLimit(built.cases, concurrency, async (c) => {
      const done = await this.answerCase(task, subjects, c, { spend, fresh, log, write });
      log(`${c.id}: ${this.line(task, methods, done.scored)}`);
      return { c, ...done };
    });

    const cases: CaseRecord[] = [];
    const results: ResultRecord[] = [];
    settled.forEach((s, i) => {
      if (s.status === 'rejected') {
        const msg = `${built.cases[i].id}: ${errorMessage(s.reason)}`;
        log(`failed: ${msg}`);
        skipped.push(msg);
        return;
      }
      const { c, scored, finish } = s.value;
      cases.push(this.recordOf(c, finish));
      results.push(...this.resultsOf(c, scored, finish));
    });

    const run: RunFile = {
      format: 2,
      id,
      task: taskInfo(task),
      startedAt,
      finishedAt: nowIso(),
      config: { ...o.config, maxUsd, fresh, concurrency },
      methods: sortMethods(methods.filter((m) => results.some((r) => r.method === m.id))),
      cases,
      results,
      spend: { usd: spend.usd, newCalls: spend.calls, cachedCalls: spend.cachedCalls },
      skipped,
    };
    await this.store.write(run);
    this.known.set(task.id, task);
    await this.report(task.id, id);
    log(`spent $${spend.usd.toFixed(3)} on ${spend.calls} new call(s); ${spend.cachedCalls} answered from cache`);
    log(`report: ${path.relative(process.cwd(), path.join(this.store.runDir(task.id, id), 'report.md'))}`);
    return run;
  }

  /** Answer one case with some subjects and score the answers. Nothing is stored. */
  async evaluate<D, A>(task: Task<D, A>, c: Case<D>, subjects: Subject<D, A>[], o: EvaluateOptions = {}): Promise<ScoredAnswer<A>[]> {
    this.methodsOf(subjects);
    const spend = o.spend ?? this.budget({ maxUsd: 0, id: `evaluate-${task.id}` });
    const done = await this.answerCase(task, subjects, c, { spend, fresh: o.fresh ?? false, log: o.log ?? (() => undefined), write: async (rel) => rel });
    return done.scored;
  }

  private methodsOf(subjects: Subject<any, any>[]): MethodSpec[] {
    const seen = new Set<string>();
    const methods = subjects.flatMap((s) => s.methods);
    for (const m of methods) {
      if (seen.has(m.id)) throw new Error(`two subjects declare the method ${m.id}`);
      seen.add(m.id);
    }
    if (methods.filter((m) => m.baseline).length > 1) throw new Error('more than one method is the baseline');
    return methods;
  }

  private async answerCase<D, A>(
    task: Task<D, A>,
    subjects: Subject<D, A>[],
    c: Case<D>,
    ctx: { spend: Spend; fresh: boolean; log: (m: string) => void; write: (rel: string, data: string | Buffer) => Promise<string> },
  ): Promise<{ scored: ScoredAnswer<A>[]; finish: FinishOutcome }> {
    const answered = await Promise.all(subjects.map(async (s): Promise<Answer<A>[]> => {
      try {
        return await s.solve(c, { spend: ctx.spend, fresh: ctx.fresh, log: ctx.log });
      } catch (err) {
        // A call the budget could not cover leaves the subject's methods out of the run, as if they had not been
        // asked; any other error fails them, with the error as the reason.
        return s.methods.map((m): Answer<A> => (err instanceof BudgetExceeded ? { method: m.id, skipped: true } : { method: m.id, error: errorMessage(err) }));
      }
    }));
    const sctx: ScoreContext = { write: ctx.write, log: ctx.log };
    const scored: ScoredAnswer<A>[] = [];
    for (const a of answered.flat()) {
      if (a.skipped) continue;
      let answer = a;
      let outcome: Outcome = { scores: {} };
      // An answer can carry a remark in `error` (it did not finish, so this is its last try) and still be scored.
      if (a.answer !== undefined) {
        try {
          outcome = await task.score(c, a.answer, sctx);
        } catch (err) {
          answer = { ...a, error: errorMessage(err) };
        }
      }
      scored.push({ answer, outcome });
    }
    const finish = (await task.finish?.(c, scored, sctx)) ?? {};
    return { scored, finish };
  }

  private recordOf(c: Case<any>, finish: FinishOutcome): CaseRecord {
    const { data: _data, ...record } = c;
    return { ...record, ...(finish.artifacts ? { artifacts: { ...record.artifacts, ...finish.artifacts } } : {}) };
  }

  private resultsOf(c: Case<any>, scored: ScoredAnswer<any>[], finish: FinishOutcome): ResultRecord[] {
    return scored.map(({ answer: a, outcome: o }) => ({
      case: c.id,
      method: a.method,
      scores: { ...o.scores, ...finish.scores?.[a.method] },
      ...(o.label !== undefined ? { label: o.label } : {}),
      costUsd: a.costUsd ?? 0,
      latencyMs: a.latencyMs ?? 0,
      ...(a.calls !== undefined ? { calls: a.calls } : {}),
      ...(a.cachedCalls !== undefined ? { cachedCalls: a.cachedCalls } : {}),
      ...(o.note ?? a.note ? { note: o.note ?? a.note } : {}),
      ...(a.error ? { error: a.error } : {}),
      ...(a.details || o.details ? { details: { ...a.details, ...o.details } } : {}),
    }));
  }

  /** One line for the log: the primary score of each method on the case. */
  private line(task: AnyTask, methods: MethodSpec[], scored: ScoredAnswer<any>[]): string {
    if (!scored.length) return 'no method ran';
    const primary = metricOf(task, task.primary);
    return scored
      .map(({ answer, outcome }) => {
        const m = methods.find((x) => x.id === answer.method);
        const v = outcome.scores[primary.id];
        return `${answer.method}${m?.subjectLabel ? `(${m.subjectLabel})` : ''} ${outcome.label ?? (isNum(v) ? v.toFixed(2) : '–')}`;
      })
      .join(' · ');
  }

  // ---------- reading ----------

  /** A stored run in the current format; older formats go through the task's `upgrade`. */
  async readRun(taskId: string, id: string): Promise<RunFile | null> {
    const raw = this.store.raw(taskId, id);
    if (!raw) return null;
    if ((raw as { format?: unknown }).format === 2) return raw as RunFile;
    return this.known.get(taskId)?.upgrade?.(raw, { id, dir: this.store.runDir(taskId, id) }) ?? null;
  }

  /** The runs of a task, newest first. */
  async runs(taskId: string): Promise<RunItem[]> {
    const items: RunItem[] = [];
    for (const id of this.store.ids(taskId)) {
      const run = await this.readRun(taskId, id);
      if (!run) continue;
      const dims: Record<string, string[]> = {};
      for (const d of taskInfoOf(run, this.known.get(taskId)).dimensions) {
        const values = [...new Set(run.cases.map((c) => c.dims[d.id]).filter((v): v is string => Boolean(v)))].sort();
        if (values.length) dims[d.id] = values;
      }
      items.push({
        id,
        task: taskId,
        finishedAt: run.finishedAt,
        caseCount: run.cases.length,
        spendUsd: run.spend.usd,
        subjects: [...new Set(run.methods.map((m) => m.subject).filter((s): s is string => Boolean(s)))],
        dims,
      });
    }
    return items;
  }

  async view(taskId: string, id: string): Promise<RunView | null> {
    const run = await this.readRun(taskId, id);
    return run ? buildRunView(run, this.known.get(taskId)) : null;
  }

  /** Write the markdown report of a run next to its results, and return it. */
  async report(taskId: string, id: string): Promise<string> {
    const view = await this.view(taskId, id);
    if (!view) throw new Error(`no run ${id} of ${taskId}`);
    const text = renderReport(view);
    await writeFileAtomic(path.join(this.store.runDir(taskId, id), 'report.md'), text);
    return text;
  }

  /** Every task: the registered ones, and any others that have runs in the current format on disk. */
  async tasks(): Promise<TaskItem[]> {
    const items: TaskItem[] = [];
    const seen = new Set<string>();
    for (const task of this.known.values()) {
      const ids = this.store.ids(task.id);
      items.push({ info: taskInfo(task), runs: ids.length, latest: ids[0] });
      seen.add(task.id);
    }
    for (const taskId of this.store.taskIds()) {
      if (seen.has(taskId)) continue;
      const ids = this.store.ids(taskId);
      const latest = ids.length ? this.store.raw(taskId, ids[0]) : null;
      const info = (latest as { format?: number; task?: TaskInfo } | null)?.format === 2 ? (latest as RunFile).task : null;
      if (info) items.push({ info, runs: ids.length, latest: ids[0] });
    }
    return items;
  }

  /** What the ledger says was paid for. */
  async usage(hooks: UsageHooks = {}) {
    return summarizeLedger(await this.ledger.read(), hooks);
  }
}

export function createBenchmark(o: BenchmarkOptions): Benchmark {
  return new Benchmark(o);
}
