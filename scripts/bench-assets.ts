// Asset check: does a reconstructed 3D asset hold anything that is not the object (lawn, hedge or wall
// that the photo showed through gaps in the cutout)? One Muse Spark call per asset, on its turntable.
// Reads built worlds only; model answers are cached by content (data/bench/cache/llm), so re-running is free.
// Runs on the metrics framework (@wom/metrics); the dashboard shows the result at #/bench/assets.
//
//   npm run bench:assets -- [options]
//     --worlds a,b        world ids (default: every world)
//     --objects a,b       object ids
//     --assets m1,m2      asset models (default: every asset on disk)
//     --model name        default: muse-spark-1.3
//     --effort level      reasoning effort (default: medium)
//     --max-usd n         cap on new model spend for this run (default: 0.5)
//     --concurrency n     assets in parallel (default: 2)
//     --fresh             ignore cached answers
//     --cached-only       make no new calls (same as --max-usd 0)
//
// Verdicts are compared with the labels in data/bench/asset-labels.json, so the report says how often the
// checker agrees with a person looking at the same turntable.
import { assetCheckTask, museChecker } from '../server/src/bench/assets-task.ts';
import type { Effort } from '../server/src/bench/llm.ts';
import { bench } from '../server/src/bench/suite.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (name: string) => opt(name)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
const flag = (name: string) => args.includes(`--${name}`);

const model = opt('model') ?? 'muse-spark-1.3';
const effort = (opt('effort') ?? 'medium') as Effort;

await bench.run(assetCheckTask, [museChecker(model, effort)], {
  selection: { worlds: list('worlds'), objects: list('objects'), assets: list('assets') },
  maxUsd: flag('cached-only') ? 0 : Number(opt('max-usd') ?? 0.5),
  fresh: flag('fresh'),
  concurrency: Number(opt('concurrency') ?? 2),
  config: { model, effort },
});
