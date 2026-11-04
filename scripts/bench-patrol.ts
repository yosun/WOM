// Standardized world patrol: render the same deterministic path and have independent VLMs report visible
// reconstruction aberrations. Findings can be recorded in the existing observe-to-fix ledger.
//
//   npm run bench:patrol -- --models muse-spark-1.3,gemini-3.8-flash,gpt-6.1-terra --max-usd 5
//   npm run bench:patrol -- --worlds <id> --cached-only --no-record
//
// Playwright is loaded the same way as the slide checks. Install playwright-core, or set PLAYWRIGHT_CORE
// to an existing playwright-core index.mjs. Gemini additionally requires .kiro/gcp-project.json.
import { bench } from '../server/src/bench/suite.ts';
import { DEFAULT_MAX_VIEWS, patrolSubject, patrolTask, PATROL_MODELS, type PatrolModel, type PatrolOptions } from '../server/src/bench/patrol.ts';

type Effort = NonNullable<PatrolOptions['effort']>;
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (name: string) => opt(name)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
const flag = (name: string) => args.includes(`--${name}`);
const absent = (name: string) => args.includes(`--no-${name}`);

const allowed = new Set(PATROL_MODELS);
const requested = list('models');
const models = (requested.length ? requested : PATROL_MODELS).filter((m): m is PatrolModel => allowed.has(m as PatrolModel));
if (!models.length) throw new Error(`--models must contain one of ${PATROL_MODELS.join(', ')}`);
if (requested.length !== models.length) throw new Error(`Unknown patrol model. Use: ${PATROL_MODELS.join(', ')}`);

const effort = (opt('effort') ?? 'low') as Effort;
if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error(`Unknown effort: ${effort}`);
const maxViews = Math.max(1, Math.min(64, Math.round(Number(opt('max-views') ?? DEFAULT_MAX_VIEWS))));
const record = !absent('record');
const options: PatrolOptions = {
  maxViews,
  effort,
  recordObservations: record,
  recordCached: flag('record-cached'),
  baseUrl: opt('base'),
};

await bench.run(
  patrolTask,
  models.map((model) => patrolSubject(model, options)),
  {
    selection: { worlds: list('worlds') },
    maxUsd: flag('cached-only') ? 0 : Number(opt('max-usd') ?? 5),
    concurrency: Math.max(1, Math.min(4, Number(opt('concurrency') ?? 1))),
    fresh: flag('fresh'),
    config: { models, maxViews, effort, recordObservations: record, recordCached: Boolean(options.recordCached), baseUrl: options.baseUrl ?? process.env.BASE ?? 'http://localhost:5173' },
  },
);
