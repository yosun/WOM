// Placement benchmark: Muse Spark vs. Muse Wonder vs. the geometric fitter on built worlds.
// Reuses every world's existing masks, depth and 3D assets; no 3D generation happens here.
// Model calls are cached by content (data/bench/cache/llm), so re-running is free.
// Runs on the metrics framework (@wom/metrics); the dashboard shows the result at #/bench/placement.
//
//   npm run bench:placement -- [options]
//     --worlds a,b          world ids (default: every world with a scene)
//     --objects a,b         object ids
//     --assets m1,m2        asset models to place (default: idol)
//     --depths d1,d2        depth models to place with: moge2, moge3 (default: each world's active one)
//     --models m1,m2        default: muse-spark-1.3,muse-wonder-1.0
//     --protocols p1,p2     direct, agent (default: both)
//     --effort level        reasoning effort for both models (default: medium)
//     --max-usd n           cap on new model spend for this run (default: 4)
//     --concurrency n       cases in parallel (default: 2)
//     --fresh               ignore cached answers
//     --cached-only         make no new calls (same as --max-usd 0)
//     --report <run dir>    only rebuild that run's report.md (after editing data/bench/annotations.json)
import path from 'node:path';
import { bench } from '../server/src/bench/suite.ts';
import type { Effort } from '../server/src/bench/llm.ts';
import { geometrySubject, museSubject, placementTask } from '../server/src/bench/placement.ts';
import type { Protocol } from '../server/src/bench/spec.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (name: string, fallback: string[]) => (opt(name)?.split(',').map((s) => s.trim()).filter(Boolean) ?? fallback);
const flag = (name: string) => args.includes(`--${name}`);

const protocols = list('protocols', ['direct', 'agent']) as Protocol[];
for (const p of protocols) if (p !== 'direct' && p !== 'agent') throw new Error(`unknown protocol ${p}`);

// --report <run dir>: rebuild report.md from a finished run (e.g. after editing annotations.json).
const reportDir = opt('report');
if (reportDir) {
  const dir = path.resolve(reportDir);
  await bench.report(path.basename(path.dirname(dir)), path.basename(dir));
  console.log(`rewrote ${path.join(reportDir, 'report.md')}`);
  process.exit(0);
}

const effort = (opt('effort') ?? 'medium') as Effort;
const models = list('models', ['muse-spark-1.3', 'muse-wonder-1.0']);

await bench.run(placementTask, [geometrySubject, ...models.map((m) => museSubject(m, { protocols, effort }))], {
  selection: {
    worlds: list('worlds', []),
    objects: list('objects', []),
    assets: list('assets', ['idol']),
    depths: list('depths', []),
  },
  maxUsd: flag('cached-only') ? 0 : Number(opt('max-usd') ?? 4),
  fresh: flag('fresh'),
  concurrency: Number(opt('concurrency') ?? 2),
  config: { models, protocols, effort },
});
