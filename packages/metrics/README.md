# @wom/metrics

**WOM: World Observation Metrics.** A benchmark framework. It does not care which model, agent or process gives the answers: an application declares what is asked (a *task*) and who answers (*subjects*), and the framework runs them, keeps the paid calls honest, stores the runs and serves the dashboard that reads them.

```
your app ──defines──▶  Task      the cases, and how an answer is scored
          ──plugs in─▶  Subject   anything that answers: a model, an agent with tools, a solver, a script, a person
                              │
                              ▼
                        Benchmark  runs subjects on cases, scores, books the spend, stores the run
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
        data/bench/…    /api/bench/…      dashboard (mountMetrics)
        results.json    HTTP routes       tabs, charts, leaderboards
        report.md
```

It is a workspace package of this repository (`npm install` links it as `@wom/metrics`). The runner does not know about masks, Muse or MoGe: the WOM app plugs those in, and a different application can do the same with its own tasks. The package also exports a representation-independent global Par protocol for whole-world comparisons on fixed courses of photographs.

- [A benchmark in one file](#a-benchmark-in-one-file)
- [The model](#the-model): task, case, subject, method, answer, run
- [Global Par scoring](#global-par-scoring): frozen references, full coverage and immutable scores
- [Node API](#node-api): `createBenchmark`, `defineTask`, `defineSubject`, `Spend`, `Ledger`
- [HTTP routes](#http-routes)
- [Dashboard](#dashboard): `mountMetrics`, adding tabs
- [Plugging in an agent or a process](#plugging-in-an-agent-or-a-process)
- [What is stored](#what-is-stored)

## A benchmark in one file

[`examples/sums.ts`](examples/sums.ts) is a complete benchmark: a task, a free subject, a subject that costs money, two runs (the second is answered from the cache), and the numbers. Run it with `node packages/metrics/examples/sums.ts`.

```ts
import { createBenchmark, defineSubject, defineTask, Ledger } from '@wom/metrics';

// 1. A task: what is asked, and how an answer is scored.
const sums = defineTask<{ a: number; b: number }, number>({
  id: 'sums',
  label: 'Sums',
  metrics: [{ id: 'exact', label: 'Exact', better: 'higher', format: 'percent' }],
  primary: 'exact',
  families: [{ id: 'plain', label: 'No model', color: '#8ab8f0' }, { id: 'model', label: 'Model', color: '#bfa4ee' }],
  async cases() {
    return { cases: [{ id: 'sum-0', title: '2 + 3', dims: {}, data: { a: 2, b: 3 } }] };
  },
  score: (c, answer) => ({ scores: { exact: answer === c.data.a + c.data.b ? 1 : 0 } }),
});

// 2. Subjects: anything that answers. Every paid call goes through ctx.spend.call.
const assistant = defineSubject<{ a: number; b: number }, number>({
  id: 'assistant',
  label: 'Assistant',
  methods: [{ id: 'assistant', label: 'Assistant', family: 'model', subject: 'assistant-1' }],
  async solve(c, ctx) {
    const asked = await ctx.spend.call(
      { key: c.data, label: `assistant: ${c.title}`, estimateUsd: 0.01, ledger: { provider: 'acme', model: 'assistant-1' } },
      async () => ({ value: await askTheAssistant(c.data), costUsd: 0.004 }),
      { fresh: ctx.fresh },
    );
    return [{ method: 'assistant', answer: asked.value, costUsd: asked.costUsd, latencyMs: asked.latencyMs }];
  },
});

// 3. The benchmark: run, store, report.
const bench = createBenchmark({ dir: 'data/bench', ledger: new Ledger('data/ledger.jsonl') }).register(sums);
await bench.run(sums, [assistant], { maxUsd: 1 });
```

## The model

| Term | What it is |
| --- | --- |
| **Task** | What is asked: how to build the *cases*, how to score an *answer*, and what the metrics are. A task with `kind: 'metrics'` gives answers numbers; `kind: 'verdicts'` gives them a label (clean, minor, contaminated) that is compared with what a person said. |
| **Case** | One thing to measure. A public record (`id`, `title`, `group`, `dims`, `revision`, `noteKeys`) plus `data`, which only the task and its subjects see. Its `dims` say how cases differ (world, object, model) so tables can group and filter. |
| **Subject** | Anything that answers a case: `solve(case, ctx)` returns one *answer* per method it can give. A model, an agent with tools, a geometric solver, a script, a person typing. |
| **Method** | One way of answering, and so one column of every table: `id`, `label`, `family` (for colour and grouping), `subject`/`subjectLabel` (who, so the dashboard can look up what it costs), `baseline` (the reference others are compared with), `via` (made from another method's output, so it carries that method's cost and time). |
| **Answer** | What a method gave for a case: the answer itself, and its `costUsd`, `latencyMs`, `calls`, `cachedCalls`, a `note` in its own words, an `error`, or `skipped` when it did not run. |
| **Outcome** | What scoring an answer gives: `scores` (a number, or `null` when it cannot be measured, per metric id), a `label` for verdict tasks, a `note`, `details`, and `images` kept in memory for `finish`. |
| **Run** | A task measured on some subjects, stored as `results.json` (format 2) with a `report.md` and the files the task kept. |

A run covers every case with every subject. All subjects answer a case at once; each answer is scored by the task; then `task.finish` may add scores that compare the answers (how far each method's facing is from the baseline's) and decide which files to keep.

**Methods are compared on the cases they share.** A model costs money, so it is usually run on fewer cases than a free solver. A mean over "all the cases a method ran" then compares different cases. The summary reports each method's mean and `pairedStat` reports its gain over the baseline on the cases both ran, with how many it won, tied and lost (within `task.tie`; it counts as a gain above `task.gain`).

## Global Par scoring

`@wom/metrics/core` exports `ParCourse`, `ParSubmission`, `ParScore`, `scorePar`,
`parReferenceSubmission`, `rankPar`, `assertParCourse` and `PAR_PROTOCOL` (`wom-par-v1`).
The Node entry additionally exports `readParCourse`, `readParSubmission`, `parDigest`,
`parFileDigest` and `verifyParFiles` for recursive content-hash and provenance checks.

```ts
import { readParCourse, readParSubmission, parReferenceSubmission, scorePar, rankPar } from '@wom/metrics';

const frozen = await readParCourse('course.json', '/private/frozen-artifact-root');
const reference = scorePar(frozen.course, frozen.sha256, parReferenceSubmission(frozen.course, frozen.sha256));
const entry = await readParSubmission('/submission/entry.json', frozen);
const result = scorePar(frozen.course, frozen.sha256, entry);
const ranked = rankPar([reference, result]);
```

The score is `100 × (1 − 2p)`, where `p` is the candidate's preference against the fixed
reference, counting ties as half a win. **0 is par; negative is better; range −100 to +100.**
It averages judges, generation trials, unique source photographs and fixed category weights
in order. Exact reference replays get zero with no invented self-comparison ballots. Missing
evidence or incomplete panels leave a score null; evidenced generation/render failures lose
against success. Human and model judging tracks cannot mix. Model judges must see both orders.

Scores depend on one immutable course digest, not a jointly fitted entrant roster, so new
entrants cannot move existing scores. Convenience-sample pilots are descriptive only; eligible
independent-scene courses can report conservative photo-level bounds. No claim is made that a
single number is a universal ranking across unrelated tasks or datasets.

Pure `scorePar` validates structure and arithmetic; it does not read bytes, authenticate raters
or certify that a renderer complied. Use the Node loaders before importing external evidence,
and audit capture/judging compliance. See the [full protocol](../../docs/wom-par/protocols/global-v1.md)
and [WOM Global task](../../server/src/bench/global.ts). That task deliberately makes the whole
course **one case** so the generic finite-value mean cannot reward selective scene coverage.

For new agentic contributions, include the standard `AgentSetup` descriptor as `submission.setup`.
`assertAgentSetup` checks its schema, runner/adapter versions, models, agent/tool references and
environment variable names. Its identity/revision must match the scored method; the Node importer
also verifies a declared configuration file's hash. Runner metadata is recorded, never executed
by the scoring command. See the [schema](schema/agent-setup-v1.json) and
[contributor guide](../../docs/wometrics/contributing.md).

## Node API

```ts
import { createBenchmark, createMetricsRoutes, defineSubject, defineTask, Ledger, Spend, BudgetExceeded } from '@wom/metrics';
```

### `createBenchmark({ dir, ledger, cacheDir? })` → `Benchmark`

| Member | What it does |
| --- | --- |
| `register(task)` | Make the task known, so the dashboard lists it and old runs can be read through its `upgrade`. Returns the benchmark. |
| `run(task, subjects, options)` | Measure and store a run. Returns the `RunFile`. |
| `evaluate(task, case, subjects, options)` | Answer and score one case, and store nothing. For an agent or an application that wants a score now. |
| `budget({ maxUsd, id })` | A `Spend` that books to this benchmark's ledger and caches in its cache folder, to pass as `evaluate`'s `spend`. |
| `runs(task)`, `readRun(task, id)`, `view(task, id)`, `report(task, id)`, `tasks()`, `usage(hooks)` | Read: the runs of a task (newest first), one stored run, a run as the dashboard shows it (`RunView`), the markdown report (written next to `results.json` and returned), every task with its run count, and what the ledger says was paid for. |

`run` options: `selection` (which cases; the task decides what the keys mean, for example `{ worlds: ['a'], assets: ['idol'] }`), `maxUsd` (cap on new paid calls; **default 0: only answers already in the cache are used**), `concurrency` (cases at once, default 2), `fresh` (ask again instead of using cached answers), `config` (how the run was set up; stored and shown, not interpreted), `log`, `id`.

### `defineTask(task)`

`TaskSpec` is everything about a task except its code, and every stored run carries it: `id`, `label`, `description`, `kind`, `metrics`, `primary`, `families`, `dimensions`, `splitBy`, `labels`, `artifacts`, `tie`, `gain`, `smallSample`, `revision`, `caveat`, `hardCasesHint`, `howToRun`, `groupLabel`, `question`.

| Hook | |
| --- | --- |
| `cases(selection, { log })` | **Required.** Returns `{ cases, skipped? }`; `skipped` lists what could not be built, one line each. |
| `score(case, answer, ctx)` | **Required.** Returns an `Outcome`. `ctx.write(path, data)` stores a file in the run's folder. |
| `finish(case, scored, ctx)` | Optional. After every answer to a case is scored: returns `{ artifacts, scores }`, files to show with the case and scores to add to a method's result. |
| `annotations()` | Optional. Human notes, read each time a run is shown (see below). |
| `caseNote(case, results)` | Optional. A warning computed from a case's results when no person wrote a note. |
| `extras(view)` | Optional. Tables, remarks and sentences specific to the task: `{ tables, notes, insights }`. |
| `upgrade(raw, { id, dir })` | Optional. Reads a run stored before format 2. Returns a `RunFile`, or `null`. Nothing on disk is changed. |

A **metric** is `{ id, label, better: 'higher' | 'lower', unit?, format?: 'percent', digits?, range?, thresholds?: { good, fair }, aggregate?: 'mean' | 'median' | 'meanAbs' | 'medianAbs', advanced?, description? }`. `aggregate` says how a method's cases add up to one number; the default is the mean of the finite values. `advanced` metrics sit behind a toggle in the dashboard.

A case **artifact** is declared as `{ id, label, kind?: 'image' | 'file' }`. The default embeds
an image; `kind: 'file'` makes reports and the dashboard link documents or raw JSON directly.

**Annotations** are `Record<key, { exclude?, note?, expected?, revision? }>`. A case looks its notes up under its `noteKeys` (default: its `id`), the first key that exists wins, and a note with a `revision` applies only to that revision of what the case is about. `exclude` keeps a case out of the summary (it stays in the details); `expected` is what a person said the verdict should be.

**Verdict tasks** list `labels` from the most severe to the cleanest. Their runs get an `agreement` against the `expected` labels: a confusion matrix, how many exact, how many of the most severe were caught, how many of the clean were flagged.

### `defineSubject(subject)`

```ts
defineSubject<D, A>({
  id: 'assistant',
  label: 'Assistant',
  methods: MethodSpec[],                    // the ways this subject can answer; ids are unique across a run
  solve(c: Case<D>, ctx: SolveContext): Promise<Answer<A>[]>,
});
```

`solve` returns one answer per method, and omits a method to leave it out of the run for that case. `ctx` has `spend`, `fresh` and `log`. If `solve` throws, its methods are recorded as failed with the error as the reason, except for `BudgetExceeded`: a call the budget could not cover leaves the methods out of the run, as if they had not been asked. An answer can also say `skipped: true`, or carry an `error` and still be scored (an agent that did not finish and gave its last try).

### `Spend` and `Ledger`: paid calls

Any call that costs money goes through `ctx.spend.call(spec, fn, { fresh })`:

```ts
const r = await ctx.spend.call(
  { key: request, label: 'what it is', estimateUsd: 0.05, namespace: 'llm', ledger: { provider: 'acme', model: 'x' } },
  async () => ({ value: await theCall(request), costUsd }),
);
r.value; r.cached; r.costUsd /* paid now: 0 when cached */; r.listUsd /* what it cost when first paid */; r.latencyMs;
```

- **Budget.** Before a call that is not cached, `estimateUsd` is checked against the cap; over it, `BudgetExceeded` is thrown and nothing is paid.
- **Cache.** `key` is anything JSON-serialisable; the same key is answered from `<dir>/cache/<namespace>/<sha256>.json`. A run that repeats earlier questions costs nothing. Hash anything large (images) into the key yourself.
- **Ledger.** A paid call appends `{ at, context, provider, label, usd, model?, ref }` to the ledger, a JSON-lines file (`context` is `bench` unless you say otherwise; `ref` is `<run id>:<cache key>`). Calls answered from the cache are not in it. `ledger: false` books nothing, for callers that book the cost themselves.

`bench.usage(hooks)` summarises the ledger for the dashboard's Spend tab: by context, provider, kind of work, day and world, and what one case costs per method. How a label maps to a kind, a world or a method is the application's knowledge, so it comes in as `UsageHooks` (`classify`, `perCase`, `worldOf`, `worldTitles`, `contextLabels`, `providerLabels`).

## HTTP routes

`createMetricsRoutes(bench, { usage })` returns a [Hono](https://hono.dev) app. Mount it at the root of yours: `app.route('/', createMetricsRoutes(bench, { usage: () => hooks }))`.

| Route | Answers with |
| --- | --- |
| `GET /api/bench/tasks` | Every task: `{ info: TaskInfo, runs, latest? }[]` |
| `GET /api/bench/:task/runs` | The task's runs, newest first: `RunItem[]` |
| `GET /api/bench/:task/runs/:id` | One run as the dashboard shows it: `RunView` (summary, cases with their results, notes applied, exclusions, agreement, extras) |
| `GET /api/bench/spend` | `SpendSummary`, from the ledger |
| `GET /bench-files/:task/:id/<path>` | A file of a run: `report.md`, `results.json`, and what the task kept (images, `.md` and `.json` only) |

Task and run ids are checked wherever they come from, because they end up in a path (`^[a-z][a-z0-9-]*$`, `^[0-9][0-9-]*$`).

## Dashboard

```ts
import '@wom/metrics/web/styles.css';
import { matchMetricsRoute, mountMetrics, type MetricsUiHost } from '@wom/metrics/web';

const route = matchMetricsRoute(location.hash);          // #/bench, #/bench/<tab>, #/bench/<tab>/<run>, #/bench/<run>/<tab>
if (route) teardown = mountMetrics(root, route, host);    // returns a function that stops it
```

The tabs are an **Overview**, one tab for each task the server reports, the application's own tabs, and **Spend**. Everything the dashboard says comes from the run: the metrics, methods, families, dimensions, labels and descriptions the task declared, so a new task or method needs no change here. For each metrics task it shows a leaderboard (sortable, with each method's gain over the baseline on shared cases, its cost and time per case, and a *More metrics* toggle), a chart of what the extra cost buys, a case × method matrix, the task's tables and remarks, and every case with its files. For each verdict task it shows counts per verdict, a table per dimension next to what the other tasks found about the same values, the agreement with the labels, and every case.

`MetricsUiHost` is what the application adds:

| | |
| --- | --- |
| `tabs` | Extra tabs (`HostTab`): `{ id, label, question, view(ctx), headline?(ctx), insights?(ctx) }`. `headline` is one card for the overview; `insights` are sentences for "What the numbers say". |
| `caseLinks(task, case)` | Where a case leads in the application: `[{ label, href }]`. |
| `lede`, `back` | The line under the name, and the back link. |

A tab of the application's own is built from the pieces the package exports, so it looks like the rest: `h`, `panel`, `kpi`, `chip`, `notice`, `loadInto`, `hbars`, `stack`, `meter`, `diverge`, `scatter`, `heat`, the formatters (`fUsd`, `fSec`, `fSigned`, `fPct`, `plural`…) and `ctx.data.remember(key, load)`, which makes a request once for the page. The WOM app adds Camera and Observations this way (`web/src/wom.ts`).

The stylesheet is scoped under `.wom`, the class of the page's root, so importing it restyles nothing else, and it is self-contained. To match another theme, set `--wom-bg`, `--wom-bg2`, `--wom-line`, `--wom-text`, `--wom-muted`, `--wom-accent`, `--wom-accent2`, `--wom-ok`, `--wom-bad`, `--wom-run`, `--wom-radius`, `--wom-serif` or `--wom-sans` on `:root`.

## Plugging in an agent or a process

A subject is a function from a case to an answer, so what answers can live anywhere. To measure something out of process, write a subject whose `solve` calls it:

```ts
defineSubject({
  id: 'remote-agent',
  label: 'Remote agent',
  methods: [{ id: 'remote', label: 'Remote agent', family: 'agent', subject: 'remote-v3' }],
  async solve(c, ctx) {
    const r = await ctx.spend.call(                     // cached and capped like any paid call
      { key: c.data, label: `remote: ${c.id}`, ledger: { provider: 'remote-co' } },
      async () => {
        const res = await fetch('http://agent.local/solve', { method: 'POST', body: JSON.stringify(c.data) });
        const body = await res.json();                  // the agent reports its answer and what it spent
        return { value: body.answer, costUsd: body.costUsd };
      },
    );
    return [{ method: 'remote', answer: r.value, costUsd: r.costUsd, latencyMs: r.latencyMs, cachedCalls: r.cached ? 1 : 0 }];
  },
});
```

For a score right now rather than a stored run, `bench.evaluate(task, case, [subject], { spend })` answers and scores one case and stores nothing. An application can put it behind a route of its own.

What stays in the application: the task's cases and scorer (they know what a world, a mask or a placement is), the subjects (they know how to call a model), and anything the dashboard has no word for, which it adds as a tab.

## What is stored

```
<dir>/                         createBenchmark({ dir })      data/bench in the WOM app
  cache/<namespace>/<sha256>.json    one paid answer: { key, at, label, latencyMs, costUsd, request, result }
  <task>/<run>/results.json          the run: format 2, the task's spec, methods, cases, results, spend, skipped
  <task>/<run>/report.md             the same tables as the dashboard, for an editor or a review
  <task>/<run>/…                     the files the task kept with ctx.write (overlays, sheets, inputs)
<ledger file>                        one JSON line per paid call
```

A run id is the UTC time it started (`20261101-215829`). `results.json` holds `format: 2`; a run without it goes through the task's `upgrade` each time it is read, and the file is left as it is. When a task is registered, its current definition (wording, thresholds, labels) is laid over what a stored run says about it, so a better description applies to old runs too. Human notes are read when a run is shown, never copied into it: editing an annotation changes every run at once.

## Layout of the package

```
src/core/    types and arithmetic, safe anywhere (server and browser): the contract, summaries, paired stats, agreement
src/node/    Benchmark, Task/Subject, Spend, Ledger, RunStore, reports, usage, routes
src/web/     the dashboard: shell, views, charts, styles.css
examples/    sums.ts
```

`@wom/metrics` is the node side plus the core, `@wom/metrics/core` is the core alone, `@wom/metrics/web` is the dashboard and `@wom/metrics/web/styles.css` its styles. The package ships TypeScript source, as the rest of the repository does: Node runs it with its built-in type stripping and Vite bundles it. `npm run typecheck -w @wom/metrics` checks the node and the web side.
