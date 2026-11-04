// Asset-check benchmark: every asset of every built world, judged by a vision model for anything that is
// not the object (see assetcheck.ts for what it looks for and how the verdict is decided). On the metrics
// framework (@wom/metrics): the task lists the assets and scores a verdict; the subject is the checker.
//
// Verdicts are compared with data/bench/asset-labels.json, what a person saw in the same turntable, so a
// run says how often the checker agrees with a person.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BudgetExceeded, defineSubject, defineTask, errorMessage, slug, type Annotation, type Case, type Subject } from '@wom/metrics';
import { WORLDS_DIR } from '../config.ts';
import { mtimeIn, planRegistry } from '../pipeline/assets.ts';
import type { AssetVerdict, ObjectAsset, WorldManifest } from '../types.ts';
import { judgeAsset, type AssetJudgement } from './assetcheck.ts';
import { BENCH_DIR } from './cache.ts';
import { loadAsset } from './context.ts';
import type { Effort } from './llm.ts';
import { upgradeAssetRun } from './legacy.ts';
import { asFindings, ASSET_CHECK_SPEC, checkMethod, checkMethodId, shortModel } from './spec.ts';

interface WorldAssets {
  id: string;
  title: string;
  file: (rel: string) => string;
  objects: { id: string; name: string; description: string; maskVersion: number; assets: ObjectAsset[] }[];
}

/** A built world's objects and every asset on disk (the registry plus older files recovered from the log). */
export function readWorldAssets(worldId: string): WorldAssets {
  const dir = path.join(WORLDS_DIR, worldId);
  const file = (rel: string) => {
    const full = path.resolve(dir, rel);
    if (!full.startsWith(dir + path.sep)) throw new Error('path escapes world directory');
    return full;
  };
  const manifest = JSON.parse(readFileSync(file('manifest.json'), 'utf8')) as WorldManifest;
  const logFile = file('log.txt');
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
  const registry = planRegistry(manifest, log, mtimeIn({ file }));
  return {
    id: worldId,
    title: manifest.title,
    file,
    objects: manifest.objects.map((o) => ({
      id: o.id,
      name: o.name,
      description: manifest.plan?.objects.find((p) => p.id === o.id)?.description ?? '',
      maskVersion: o.maskVersion ?? 1,
      assets: Object.values(registry.objects.get(o.id) ?? {}).filter((a): a is ObjectAsset => Boolean(a?.file && existsSync(file(a.file)))),
    })),
  };
}

export function listWorldIds(): string[] {
  if (!existsSync(WORLDS_DIR)) return [];
  return readdirSync(WORLDS_DIR).filter((id) => existsSync(path.join(WORLDS_DIR, id, 'manifest.json')));
}

/**
 * What a person saw in an asset's turntable, in data/bench/asset-labels.json keyed "<world>/<object>/<asset>".
 * `maskVersion` limits a label to that mask of the object.
 */
export type AssetLabels = Record<string, { verdict: AssetVerdict; note: string; maskVersion?: number }>;

export function loadAssetLabels(): AssetLabels {
  const file = path.join(BENCH_DIR, 'asset-labels.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AssetLabels) : {};
}

/** What the checker answers for one asset: its judgement and the turntable it looked at. */
export interface CheckAnswer {
  judgement: AssetJudgement;
  sheet: Buffer;
}

export interface AssetData {
  world: WorldAssets;
  object: WorldAssets['objects'][number];
  asset: ObjectAsset;
}

export const assetCheckTask = defineTask<AssetData, CheckAnswer>({
  ...ASSET_CHECK_SPEC,

  async cases(selection) {
    const cases: Case<AssetData>[] = [];
    const skipped: string[] = [];
    for (const wid of selection.worlds?.length ? selection.worlds : listWorldIds()) {
      let world: WorldAssets;
      try {
        world = readWorldAssets(wid);
      } catch (err) {
        skipped.push(`${wid} (${errorMessage(err)})`);
        continue;
      }
      for (const object of world.objects) {
        if (selection.objects?.length && !selection.objects.includes(object.id)) continue;
        for (const asset of object.assets) {
          if (selection.assets?.length && !selection.assets.includes(asset.model)) continue;
          cases.push({
            id: `${world.id}/${object.id}/${asset.model}`,
            title: object.name,
            group: world.title,
            dims: { world: world.id, object: object.id, asset: asset.model },
            revision: object.maskVersion,
            data: { world, object, asset },
          });
        }
      }
    }
    return { cases, skipped };
  },

  async score(c, answer, ctx) {
    const j = answer.judgement;
    const sheet = await ctx.write(`sheets/${slug(c.id)}.jpg`, answer.sheet);
    return {
      label: j.verdict,
      scores: { foreignShare: j.foreignShare },
      note: j.rationale || undefined,
      details: { findings: asFindings(j.findings), rationale: j.rationale, sheet },
    };
  },

  finish(_c, scored) {
    const sheet = scored.map((s) => s.outcome.details?.sheet).find((s): s is string => typeof s === 'string');
    return sheet ? { artifacts: { sheet } } : {};
  },

  annotations(): Record<string, Annotation> {
    return Object.fromEntries(Object.entries(loadAssetLabels()).map(([key, l]) => [key, { expected: l.verdict, note: l.note, revision: l.maskVersion }]));
  },

  upgrade: upgradeAssetRun,
});

/** A vision model as the asset checker: one call per asset, on its turntable. */
export function museChecker(model: string, effort: Effort): Subject<AssetData, CheckAnswer> {
  const method = checkMethodId(model);
  return defineSubject<AssetData, CheckAnswer>({
    id: model,
    label: `Muse ${shortModel(model)}`,
    methods: [checkMethod(model)],
    async solve(c, ctx) {
      const { world, object, asset: rec } = c.data;
      try {
        const asset = await loadAsset(world, rec);
        const r = await judgeAsset({
          objectName: object.name, description: object.description, asset, model, effort,
          spend: ctx.spend, fresh: ctx.fresh, label: `asset check ${model}: ${c.id}`,
        });
        return [{ method, answer: { judgement: r.judgement, sheet: r.sheet }, costUsd: r.costUsd, latencyMs: r.latencyMs, calls: 1, cachedCalls: r.cached ? 1 : 0 }];
      } catch (err) {
        // Over budget the asset is not checked, which the framework leaves out of the run; any other error fails the check.
        if (err instanceof BudgetExceeded) throw err;
        return [{ method, error: errorMessage(err) }];
      }
    },
  });
}
