// @wom/metrics: WOM, World Observation Metrics.
//
// A benchmark framework for rebuilt worlds. It does not care which model, agent or process gives the
// answers: an application declares a Task (the cases and how an answer is scored) and Subjects (whatever
// answers), and the framework runs them, keeps the paid calls honest, stores the runs and serves the
// dashboard that reads them. See the README for the API.
export * from './core/index.ts';
export { Benchmark, createBenchmark, type BenchmarkOptions, type EvaluateOptions, type RunOptions } from './node/benchmark.ts';
export {
  defineSubject, defineTask, taskInfo,
  type Answer, type Case, type CaseSelection, type FinishOutcome, type Outcome, type ScoreContext, type ScoredAnswer, type SolveContext, type Subject, type Task, type TaskSpec,
} from './node/define.ts';
export { Ledger } from './node/ledger.ts';
export { renderReport } from './node/report.ts';
export { createMetricsRoutes, type RoutesOptions } from './node/routes.ts';
export { BudgetExceeded, Spend, type CallResult, type CallSpec, type SpendOptions } from './node/spend.ts';
export { isRunId, isTaskId, RunStore } from './node/store.ts';
export { summarizeLedger, type UsageHooks } from './node/usage.ts';
export { errorMessage, mapLimit, newRunId, nowIso, slug, writeFileAtomic } from './node/util.ts';
export { buildRunView, fileUrl } from './node/view.ts';
