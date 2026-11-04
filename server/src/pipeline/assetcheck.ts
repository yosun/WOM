// The asset check for a world's own assets (see bench/assetcheck.ts for what it looks for and how).
// It runs right after the 3D models are made, on demand for every asset a world holds ("Check assets" in
// the viewer), and never fails a build: the verdict is advice, and a missing answer only means "unchecked".
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { BudgetExceeded, Spend } from '../bench/cache.ts';
import { CHECK_MODEL, checkIsCurrent, findingTile, judgeAsset, toAssetCheck } from '../bench/assetcheck.ts';
import { loadAsset } from '../bench/context.ts';
import { keysConfigured } from '../config.ts';
import { flagAssetCheck } from '../observe/store.ts';
import type { WorldHandle } from '../store.ts';
import type { AssetCheck, AssetVerdict, MeshModel, ObjectAsset, ObjectRecord } from '../types.ts';
import { errorMessage, mapLimit, writeFileAtomic } from '../util.ts';
import { OBJECT_MODELS } from './generate.ts';

/** Most one world may spend on checks in one run (about fifty assets). */
const BUDGET_USD = 1;

/** Limits a check to one object, or to some models' assets of it. */
export interface CheckOnly {
  object: string;
  models?: MeshModel[];
}

/** Assets on disk that have no check for their current file. `active` limits it to what each object shows now. */
export function uncheckedAssets(world: WorldHandle, scope: 'active' | 'all', only?: CheckOnly): { object: ObjectRecord; asset: ObjectAsset }[] {
  const out: { object: ObjectRecord; asset: ObjectAsset }[] = [];
  for (const object of world.manifest.objects) {
    if (only && object.id !== only.object) continue;
    for (const asset of Object.values(object.assets ?? {})) {
      if (!asset?.file || !existsSync(world.file(asset.file))) continue;
      if (only?.models && !only.models.includes(asset.model)) continue;
      if (scope === 'active' && object.mesh?.file !== asset.file) continue;
      if (checkIsCurrent(asset.check, asset, statSync(world.file(asset.file)).size)) continue;
      out.push({ object, asset });
    }
  }
  return out;
}

export interface WorldCheckResult {
  checked: number;
  failed: number;
  /** Assets whose verdict is not clean. */
  flagged: { object: string; model: MeshModel; verdict: AssetVerdict }[];
}

/** Check every asset of the world that has no current check, two at a time, and keep the verdicts on the assets. */
export async function checkWorldAssets(world: WorldHandle, opts: { scope: 'active' | 'all'; fresh?: boolean; only?: CheckOnly }): Promise<WorldCheckResult> {
  const todo = uncheckedAssets(world, opts.scope, opts.only);
  const spend = new Spend(BUDGET_USD, `world-${world.id}-assetcheck`);
  const result: WorldCheckResult = { checked: 0, failed: 0, flagged: [] };
  if (!todo.length) return result;
  world.log(`Asset check: looking for leftovers of the photo's background in ${todo.length} asset(s)`);
  const settled = await mapLimit(todo, 2, async ({ object, asset }) => {
    const file = asset.file!;
    const loaded = await loadAsset(world, asset);
    const description = world.manifest.plan?.objects.find((p) => p.id === object.id)?.description;
    const r = await judgeAsset({
      objectName: object.name,
      description,
      asset: loaded,
      spend,
      fresh: opts.fresh,
      label: `asset check: ${world.id}/${object.id}/${asset.model}`,
      ledger: false,
    });
    if (r.costUsd > 0) await world.addCost({ label: `Asset check: ${object.name} (${asset.model})`, usd: r.costUsd, provider: 'meta', estimated: false }, { model: CHECK_MODEL });
    // The turntable the checker saw stays next to the asset, so the viewer and build page can show it.
    const sheet = path.posix.join(path.posix.dirname(file), 'check.jpg');
    await writeFileAtomic(world.file(sheet), r.sheet);
    const check = toAssetCheck(r.judgement, { file, bytes: statSync(world.file(file)).size, sheet });
    await world.update((m) => {
      const rec = m.objects.find((x) => x.id === object.id)?.assets?.[asset.model];
      if (rec) rec.check = check;
    });
    if (check.verdict !== 'clean') {
      world.log(`Asset check: ${object.name} (${asset.model}) is ${check.verdict}: ${check.findings.map((f) => f.what).join('; ') || check.rationale}`);
      result.flagged.push({ object: object.name, model: asset.model, verdict: check.verdict });
    }
    // Background inside what the world shows (a sheet in a wheel, a slab of hedge) goes to Observations.
    if (check.verdict === 'contaminated' && object.mesh?.file === file) await openFlag(world, object, asset.model, check, r.sheet);
    result.checked++;
  });
  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      result.failed++;
      world.log(`Asset check skipped for ${todo[i].object.name} (${todo[i].asset.model}): ${s.reason instanceof BudgetExceeded ? s.reason.message : errorMessage(s.reason)}`);
    }
  });
  return result;
}

/** Open a flag for a person to inspect, and note its id on the check. A flag that cannot be made is only logged. */
async function openFlag(world: WorldHandle, object: ObjectRecord, model: MeshModel, check: AssetCheck, sheet: Buffer) {
  const what = check.findings.map((f) => f.what).join('; ') || check.rationale;
  try {
    const flag = await flagAssetCheck(world, {
      check: { object: object.id, model, file: check.file, bytes: check.bytes, verdict: check.verdict, foreignShare: check.foreignShare, findings: check.findings, rationale: check.rationale, checker: check.model },
      sheet,
      mark: findingTile(check.findings),
      note: `Background inside the ${object.name} (${OBJECT_MODELS[model].label}): ${what}`,
    });
    if (!flag) return;
    await world.update((m) => {
      const rec = m.objects.find((x) => x.id === object.id)?.assets?.[model];
      if (rec?.check?.file === check.file) rec.check.flag = flag.id;
    });
  } catch (err) {
    world.log(`Asset check: could not flag ${object.name} for inspection: ${errorMessage(err)}`);
  }
}

/**
 * After the pipeline made the objects: check the asset each one shows. Returns a short note for the step's
 * message ("" when nothing was checked). Never throws.
 */
export async function checkActiveAssets(world: WorldHandle): Promise<string> {
  if (!keysConfigured().meta) return '';
  try {
    const r = await checkWorldAssets(world, { scope: 'active' });
    if (r.flagged.length) return ` · asset check: ${r.flagged.map((f) => `${f.object} is ${f.verdict}`).join(', ')}`;
    return r.checked ? ' · asset check: clean' : '';
  } catch (err) {
    world.log(`Asset check skipped: ${errorMessage(err)}`);
    return '';
  }
}
