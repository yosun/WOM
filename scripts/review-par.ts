// Ask Muse for bounded, cached code-improvement proposals against a frozen WOM Par revision.
// Suggestions are saved for review; this script never edits or executes model-proposed code.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { cachedChat, Spend } from '../server/src/bench/cache.ts';
import { DATA_DIR, ROOT } from '../server/src/config.ts';
import { writeFileAtomic } from '../server/src/util.ts';

const args = process.argv.slice(2);
const opt = (key: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? undefined : args[i + 1]; };
const baselineRef = opt('baseline') ?? 'f616d59';
const models = (opt('models') ?? 'muse-spark-1.3,muse-wonder-1.0').split(',');
for (const model of models) if (!['muse-spark-1.3', 'muse-wonder-1.0'].includes(model)) throw new Error(`Unknown review model: ${model}`);
const maxUsd = Number(opt('max-usd') ?? 0.75);
if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error('--max-usd must be a nonnegative number');
const files = ['server/src/geometry/fit.ts', 'server/src/geometry/pose.ts', 'server/src/bench/case.ts'];
const code = files.map((file) => `FILE ${file}\n${execFileSync('git', ['show', `${baselineRef}:${file}`], { cwd: ROOT, encoding: 'utf8' })}`).join('\n\n');
const schema = {
  type: 'object', properties: {
    assessment: { type: 'string' },
    improvements: { type: 'array', maxItems: 2, items: {
      type: 'object', properties: {
        file: { type: 'string' }, problem: { type: 'string' }, proposed_change: { type: 'string' },
        verification: { type: 'string' }, risk: { type: 'string' },
      }, required: ['file', 'problem', 'proposed_change', 'verification', 'risk'], additionalProperties: false,
    } },
  }, required: ['assessment', 'improvements'], additionalProperties: false,
};
const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const dir = path.join(DATA_DIR, 'bench/par-reviews', id);
const spend = new Spend(maxUsd, `par-review-${id}`);
let failed = false;
for (const model of models) {
  try {
    const r = await cachedChat({ model, reasoningEffort: 'medium', maxTokens: 18000,
      schema: { name: 'ParImprovementReview', schema }, messages: [
        { role: 'system', content: 'Review single-image 3D object placement code. Find up to TWO concrete small algorithm improvements. Return the required JSON in under 600 visible words. Distinguish certain bugs from hypotheses. Give exact code logic, a falsifiable saved-case verification and risks. Never claim improvements have already been measured. Read the supplied placement/grounding code before proposing a correction it already does. Avoid generic model swaps.' },
        { role: 'user', content: `Review frozen WOM Par ${baselineRef}. We compare on identical saved photos, masks, metric depth and assets; floor-supported cases separately from tabletop objects and split parts. No unified whole-scene score exists. Optimize silhouette agreement, colour and depth without silently trading away other metrics.\n\n${code}` },
      ],
    }, { spend, fresh: args.includes('--fresh'), label: `WOM Par ${baselineRef} code review ${model}` });
    const complete = r.finishReason !== 'length' && Boolean(r.message.content);
    let review: unknown = null;
    if (complete) review = JSON.parse(r.message.content!);
    else failed = true;
    const result = { baselineRef, files, model, complete, cached: r.cached, costUsd: r.cached ? 0 : r.costUsd,
      finishReason: r.finishReason, usage: r.usage, review };
    await writeFileAtomic(path.join(dir, `${model}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ model, complete, cached: r.cached, costUsd: result.costUsd, file: path.join(dir, `${model}.json`) }));
  } catch (err) {
    failed = true;
    // HttpError.message contains status only; never print a provider's raw credential-error body.
    const error = err instanceof Error ? err.message : 'Review failed';
    await writeFileAtomic(path.join(dir, `${model}.json`), JSON.stringify({ model, baselineRef, complete: false, error }, null, 2));
    console.error(`${model}: ${error}`);
  }
}
console.log(`New review spend: $${spend.usd.toFixed(4)}. Results: ${dir}`);
if (failed) process.exitCode = 1;
