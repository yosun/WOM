// The app's benchmark: WOM, World Observation Metrics. One @wom/metrics Benchmark that keeps its runs in
// data/bench and books paid calls to data/ledger.jsonl. Stage diagnostics and the complete-course global
// Par score are separate tasks. The scripts run it, the server shows it.
import { createBenchmark, createMetricsRoutes } from '@wom/metrics';
import { ledger } from '../ledger.ts';
import { assetCheckTask } from './assets-task.ts';
import { BENCH_DIR } from './cache.ts';
import { placementTask } from './placement.ts';
import { patrolTask } from './patrol.ts';
import { globalTask } from './global.ts';
import { usageHooks } from './usage.ts';

export const bench = createBenchmark({ dir: BENCH_DIR, ledger })
  .register(placementTask)
  .register(assetCheckTask)
  .register(patrolTask)
  .register(globalTask);

/** The HTTP routes the dashboard reads: /api/bench/* and /bench-files/*. Mount them at the root. */
export const metricsRoutes = () => createMetricsRoutes(bench, { usage: usageHooks });
