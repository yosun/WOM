// Compare a frozen WOM Par fitter with candidate algorithms on identical saved assets. No API calls.
// npm run bench:par -- --assets idol,triposplat,tripo-v31,tripo-p1 --contacts floor
// Use --contacts all for a separate check on surface-supported objects and split parts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAsset, loadBenchWorld, groundHeight } from '../server/src/bench/context.ts';
import { evaluatePlacement, type PlacementMetrics } from '../server/src/bench/metrics.ts';
import { listBenchWorlds } from '../server/src/bench/placement.ts';
import { DATA_DIR, ROOT } from '../server/src/config.ts';
import { fitObject, type FitInputs } from '../server/src/geometry/fit.ts';
import { groundPose } from '../server/src/geometry/pose.ts';
import { writeFileAtomic } from '../server/src/util.ts';
import type { MeshModel } from '../server/src/types.ts';

const args = process.argv.slice(2);
const opt = (key: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? undefined : args[i + 1]; };
const list = (key: string, fallback: string[]) => opt(key)?.split(',').filter(Boolean) ?? fallback;
const baselineRef = opt('baseline') ?? 'f616d59';
const worlds = list('worlds', listBenchWorlds());
const assets = list('assets', ['idol']) as MeshModel[];
const contacts = list('contacts', ['floor']);
const objects = list('objects', []);
const modes = list('modes', ['classic', 'grounded']);
for (const mode of modes) if (!['classic', 'grounded'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);

const geometryDir = path.join(ROOT, 'server/src/geometry');
const candidateSource = await readFile(path.join(geometryDir, 'fit.ts'), 'utf8');
const candidateFitSha256 = createHash('sha256').update(candidateSource).digest('hex');
const frozen = execFileSync('git', ['show', `${baselineRef}:server/src/geometry/fit.ts`], { cwd: ROOT, encoding: 'utf8' });
// The fitter imports these modules. Refuse a mixed baseline if one of its runtime dependencies changed.
for (const name of ['math.ts', 'pose.ts', 'raster.ts']) {
  const original = execFileSync('git', ['show', `${baselineRef}:server/src/geometry/${name}`], { cwd: ROOT, encoding: 'utf8' });
  if (original !== await readFile(path.join(geometryDir, name), 'utf8')) throw new Error(`Baseline dependency changed: ${name}`);
}
const js = stripTypeScriptTypes(frozen).replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g,
  (_match, _quote: string, specifier: string) => `from '${pathToFileURL(path.resolve(geometryDir, specifier)).href}'`);
const baseline: typeof fitObject = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)).fitObject;
const candidates: Record<string, Partial<FitInputs>> = {
  control: {},
  'multi-start': { refineStarts: 3 },
  overlap: { silhouetteLoss: 'iou' },
  combined: { refineStarts: 3, silhouetteLoss: 'iou' },
  fine: { fitResolution: 360 },
  'spark-depth': { depthFilter: 'spark' },
  'spark-initial': { initialDepth: 'upper-quartile' },
  'wonder-depth': { depthFilter: 'wonder' },
  polish: { refineRounds: 32, preserveTranslation: true },
  'fine-polish': { fitResolution: 360, refineRounds: 32, preserveTranslation: true },
};
const variants = list('variants', ['polish', 'fine-polish', 'spark-depth', 'wonder-depth']);
for (const variant of variants) if (!(variant in candidates)) throw new Error(`Unknown variant: ${variant}`);
const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const dir = path.join(DATA_DIR, 'bench/par', id);
interface Row {
  case: string;
  world: string;
  object: string;
  asset: string;
  mode: string;
  variant: string;
  metrics: PlacementMetrics;
  ms: number;
  evaluations: number;
  pose: NonNullable<ReturnType<typeof fitObject>>['pose'];
}
const rows: Row[] = [];
const skipped: string[] = [];
const inputs: { world: string; sourceSha256: string }[] = [];
for (const wid of worlds) {
  const world = await loadBenchWorld(wid);
  inputs.push({ world: wid, sourceSha256: createHash('sha256').update(world.source.rgb).digest('hex') });
  for (const obj of world.objects) {
    if (objects.length && !objects.includes(obj.id)) continue;
    if (!contacts.includes('all') && !contacts.includes(obj.plan?.contact ?? 'unknown')) continue;
    for (const model of assets) {
      const rec = obj.assets.find((a) => a.model === model);
      if (!rec) { skipped.push(`${wid}/${obj.id}/${model}: no saved asset`); continue; }
      const asset = await loadAsset(world, rec);
      const common = {
        shape: asset.shape, k: world.k, mask: obj.mask, srcScaleX: world.srcScaleX, srcScaleY: world.srcScaleY,
        image: world.source, depth: world.moge.depth, valid: world.moge.valid, alignImage: asset.alignImage,
      };
      for (const mode of modes) {
        const inp: FitInputs = { ...common, base: mode === 'grounded' ? asset.frame.canon : asset.fitBase,
          ...(mode === 'grounded' ? { upright: world.up } : {}) };
        for (const variant of ['par-0.1', ...variants]) {
          const t0 = performance.now();
          const fit = variant === 'par-0.1' ? baseline(inp) : fitObject({ ...inp, ...candidates[variant] });
          if (!fit) { skipped.push(`${wid}/${obj.id}/${model}/${mode}/${variant}: no fit`); continue; }
          const pose = mode === 'grounded' ? groundPose(fit.pose, world.up, asset.frame, groundHeight(world, obj.box)).pose : fit.pose;
          const ms = performance.now() - t0;
          const metrics = evaluatePlacement(world, obj, asset, pose);
          rows.push({ case: `${wid}/${obj.id}/${model}@${world.depthModel}`, world: wid, object: obj.id, asset: model, mode, variant, metrics, ms, evaluations: fit.evaluations, pose });
        }
      }
      console.log(`${wid}/${obj.id}/${model}: compared ${modes.join(', ')}`);
    }
  }
}
const mean = (vs: number[]) => { const ns = vs.filter(Number.isFinite); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null; };
const summaries = modes.flatMap((mode) => ['par-0.1', ...variants].map((variant) => {
  const rs = rows.filter((r) => r.mode === mode && r.variant === variant);
  const pairs = rs.flatMap((r) => {
    const b = rows.find((b) => b.case === r.case && b.mode === mode && b.variant === 'par-0.1');
    return b ? [{ row: r, delta: r.metrics.iou - b.metrics.iou }] : [];
  });
  return { mode, variant, cases: rs.length, iou: mean(rs.map((r) => r.metrics.iou)), colorErr: mean(rs.map((r) => r.metrics.colorErr)),
    depthErr: mean(rs.map((r) => r.metrics.depthErr)), gapCm: mean(rs.map((r) => Math.abs(r.metrics.contactGapM) * 100)),
    tiltDeg: mean(rs.map((r) => r.metrics.tiltDeg)), meanMs: mean(rs.map((r) => r.ms)),
    paired: { cases: pairs.length, meanIouDelta: mean(pairs.map((p) => p.delta)), wins: pairs.filter((p) => p.delta > 0.01).length,
      losses: pairs.filter((p) => p.delta < -0.01).length, ties: pairs.filter((p) => Math.abs(p.delta) <= 0.01).length,
      worstIouDelta: pairs.length ? Math.min(...pairs.map((p) => p.delta)) : null } };
}));
const output = { id, baselineRef, baselineFitSha256: createHash('sha256').update(frozen).digest('hex'),
  candidateFitSha256,
  config: { worlds, assets, contacts, objects, modes, variants }, inputs, summaries, skipped, rows };
await writeFileAtomic(path.join(dir, 'results.json'), JSON.stringify(output, null, 2));
await writeFileAtomic(path.join(dir, 'candidate-fit.ts'), candidateSource);
const n = (v: number | null, digits = 3) => v === null ? '—' : v.toFixed(digits);
const report = [`# WOM Par 0.1 fitter experiment ${id}`, '',
  `Frozen fitter: ${baselineRef}. Identical saved photos, masks, depth and assets; no API calls or generation. Contacts: ${contacts.join(', ')}.`, '',
  'This is a stage-level case study, not a unified scene-quality score. Multiple assets of the same object are correlated. Wins/losses use a 0.01 IoU threshold.', '',
  '| Mode | Variant | Cases | IoU ↑ | Δ IoU | Win/tie/loss | Worst Δ | Colour ↓ | Depth ↓ | Gap cm ↓ | Mean ms |',
  '| --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
  ...summaries.map((s) => `| ${s.mode} | ${s.variant} | ${s.cases} | ${n(s.iou)} | ${n(s.paired.meanIouDelta, 4)} | ${s.paired.wins}/${s.paired.ties}/${s.paired.losses} | ${n(s.paired.worstIouDelta)} | ${n(s.colorErr)} | ${n(s.depthErr)} | ${n(s.gapCm, 1)} | ${n(s.meanMs, 0)} |`), '',
  'Full per-case metrics, poses, configuration and source hashes are in [results.json](./results.json). The tested [candidate source](./candidate-fit.ts) is preserved with the run.', '',
  ...(skipped.length ? ['Skipped:', ...skipped.map((s) => `- ${s}`), ''] : []),
].join('\n');
await writeFileAtomic(path.join(dir, 'report.md'), report);
console.log(report);
console.log(`Saved ${dir}`);
if (!rows.length) throw new Error('No matching saved cases; no comparison was performed.');
