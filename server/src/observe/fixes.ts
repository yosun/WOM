// What can be done about a problem, best first, and doing it.
//
// Only objects can be repaired today. A problem in an object (leftovers of the photo's background, a sheet
// hanging off it) is dealt with by showing another model of the object that the asset check found clean. The
// suggestions come from facts the server already holds (the flag, the object's assets and their checks), not
// from a new model call: the asset check is where an AI looks at the assets, and it is offered as a step when
// the evidence is missing. The ranking is a plain rule, so the same flag gets the same suggestions every time.
//
// A fix that costs money is applied only when the request sends its price back (`approveUsd`), so a script or
// an agent cannot spend by accident. Fixes run in the background on the world's lock, like the other tasks.
import { existsSync, statSync } from 'node:fs';
import { checkIsCurrent } from '../bench/assetcheck.ts';
import { ASSET_MODELS } from '../bench/catalog.ts';
import { keysConfigured } from '../config.ts';
import { checkWorldAssets } from '../pipeline/assetcheck.ts';
import { OBJECT_MODELS } from '../pipeline/generate.ts';
import { generateAssets, startTask, switchObjectAsset } from '../pipeline/run.ts';
import type { WorldHandle } from '../store.ts';
import {
  CHECK_PRICE_USD,
  type AssetVerdict,
  type FixSuggestion,
  type FixSuggestions,
  type MeshModel,
  type ObjectAsset,
  type ObservationRecord,
} from '../types.ts';
import { nowIso } from '../util.ts';
import { getObservation, ObservationError, parseAuthor, recordFix } from './store.ts';

const usd = (v: number) => Math.round(v * 1000) / 1000;
const asModel = (m: unknown): MeshModel | null => (typeof m === 'string' && m in OBJECT_MODELS ? (m as MeshModel) : null);
const name = (m: MeshModel) => ASSET_MODELS[m]?.label ?? m;
/** "Tripo H3.1 mesh", "IDOL splat". */
const describe = (m: MeshModel) => `${name(m)} ${OBJECT_MODELS[m].kind === 'mesh' ? 'mesh' : 'splat'}`;

/** What the stored check says about an asset's current file; 'unchecked' when there is none, or it is about another file. */
function verdictOf(world: WorldHandle, a: ObjectAsset): AssetVerdict | 'unchecked' {
  return checkIsCurrent(a.check, a, statSync(world.file(a.file!)).size) ? a.check.verdict : 'unchecked';
}

/** Where a fix sits in the list; lower is better. Within a rank, a model of the same kind as the flagged one comes first. */
const RANK = { clean: 10, minor: 20, check: 25, unchecked: 30, generate: 40, mask: 50 } as const;

export function suggestFixes(world: WorldHandle, rec: ObservationRecord): FixSuggestions {
  const suspect = rec.suspect;
  if (!suspect) return { fixes: [], notes: ['The layer the problem is in is not known. Choose it on the card first.'] };
  if (suspect === 'world') return { fixes: [], notes: ['Nothing here repairs part of the Marble world yet.'] };
  if (suspect === 'relief') return { fixes: [], notes: ['Nothing here repairs the depth relief. It is off by default: hide it under Layers.'] };

  const oid = suspect.slice('object:'.length);
  const obj = world.manifest.objects.find((o) => o.id === oid);
  if (!obj) return { fixes: [], notes: ['That object is no longer in this world.'] };

  const state = rec.scene?.objects.find((o) => o.id === oid);
  const flagged = asModel(rec.assetCheck?.model ?? state?.asset);
  const shows = asModel(obj.mesh?.job?.model);
  const object = { id: obj.id, name: obj.name, flagged, shows };
  const notes: string[] = [];

  // Flags the asset check opened have no mask version; for the others, a redone mask means every asset is new.
  if (!rec.assetCheck && (state?.maskVersion ?? 1) !== (obj.maskVersion ?? 1)) {
    return { object, fixes: [], notes: [`The mask of the ${obj.name} was redone after this flag, so what the world shows is a new model. Open the view to see whether the problem is gone.`] };
  }
  if (rec.category === 'placement') {
    return { object, fixes: [], notes: [`This is about where the ${obj.name} stands, not about its model. Change the placement under Layers → Placement, or move it with Edit layout.`] };
  }
  if (flagged && shows && flagged !== shows) {
    notes.push(`This was flagged on the ${describe(flagged)}; the world shows the ${describe(shows)} now. Open the view to see whether that fixed it.`);
  }
  const flaggedAsset = flagged ? obj.assets?.[flagged] : undefined;
  if (flaggedAsset?.file && existsSync(world.file(flaggedAsset.file)) && verdictOf(world, flaggedAsset) === 'clean' && !rec.assetCheck) {
    notes.push(`The asset check called the ${describe(flagged!)} clean, so it did not see this.`);
  }

  const keys = keysConfigured();
  const flaggedKind = flagged ? OBJECT_MODELS[flagged].kind : null;
  const list: (FixSuggestion & { rank: number })[] = [];
  const unchecked: ObjectAsset[] = [];

  const candidates = Object.values(obj.assets ?? {}).filter((a): a is ObjectAsset => Boolean(a?.file) && existsSync(world.file(a!.file!)) && a!.model !== shows && a!.model !== flagged);
  for (const a of candidates) {
    const verdict = verdictOf(world, a);
    if (verdict === 'contaminated') {
      notes.push(`The ${describe(a.model)} was checked and has leftovers too, so it is not offered.`);
      continue;
    }
    if (verdict === 'unchecked') unchecked.push(a);
    const differs = flaggedKind && a.kind !== flaggedKind
      ? ` It is ${a.kind === 'mesh' ? 'a textured mesh' : 'a splat'}, so it will look different from the ${describe(flagged!)} it replaces.`
      : '';
    const because = verdict === 'clean'
      ? 'Its asset check found no leftovers of the photo\'s background.'
      : verdict === 'minor'
        ? `Its asset check found only minor leftovers${a.check?.findings.length ? `: ${a.check.findings.map((f) => f.what).join('; ')}` : ''}.`
        : 'It has not been checked, so it may have the same problem.';
    list.push({
      id: `use:${a.model}`,
      kind: 'use-asset',
      title: `Show the ${describe(a.model)}`,
      because: because + differs,
      costUsd: 0,
      object: oid,
      model: a.model,
      evidence: verdict,
      rank: RANK[verdict === 'clean' ? 'clean' : verdict === 'minor' ? 'minor' : 'unchecked'] + (differs ? 1 : 0),
    });
  }

  if (unchecked.length) {
    if (keys.meta) {
      list.push({
        id: 'check',
        kind: 'check-assets',
        title: unchecked.length === 1 ? `Check the ${describe(unchecked[0].model)} first` : `Check the other ${unchecked.length} models first`,
        because: 'The asset check looks at a turntable of each model for leftovers of the photo\'s background, so the model can be chosen on evidence.',
        costUsd: usd(unchecked.length * CHECK_PRICE_USD),
        object: oid,
        models: unchecked.map((a) => a.model),
        rank: RANK.check,
      });
    } else {
      notes.push('MUSE_API_KEY is not set, so the other models cannot be checked.');
    }
  }

  // A new model is worth paying for only when nothing the object already has is known to be good or still unchecked.
  const hasGood = list.some((f) => f.evidence === 'clean' || f.evidence === 'minor');
  if (!hasGood && !unchecked.length && obj.cutout?.publicUrl) {
    const missing = (Object.keys(ASSET_MODELS) as MeshModel[]).filter((m) => !obj.assets?.[m]?.file);
    if (missing.length && !keys.ai3d) notes.push('AI3D_API_KEY is not set, so no new model can be made.');
    else {
      for (const m of missing) {
        list.push({
          id: `generate:${m}`,
          kind: 'generate-asset',
          title: `Make a ${describe(m)} of the ${obj.name}`,
          because: keys.meta
            ? 'It is checked right after it is made, so the card shows whether it has the same problem before you choose it.'
            : 'It is not checked afterwards (MUSE_API_KEY is not set).',
          costUsd: usd((ASSET_MODELS[m]?.priceUsd ?? 0) + (keys.meta ? CHECK_PRICE_USD : 0)),
          object: oid,
          model: m,
          rank: RANK.generate + (OBJECT_MODELS[m].kind === flaggedKind ? 0 : 1),
        });
      }
    }
  }

  if (obj.cutout) {
    list.push({
      id: 'mask',
      kind: 'edit-mask',
      title: `Redo the ${obj.name}'s mask by hand`,
      because: 'Leftovers of the background come from gaps the mask fills in. Cutting the gaps out of the mask and rebuilding only this object removes the cause. It is done on the build page.',
      costUsd: 0,
      object: oid,
      href: `#/world/${world.id}/build`,
      rank: RANK.mask,
    });
  }

  list.sort((a, b) => a.rank - b.rank);
  return { object, fixes: list.map(({ rank: _rank, ...f }) => f), notes };
}

/**
 * Start the fix `fixId` for the problem the flag `flagId` belongs to. It runs in the background: the caller
 * polls the world until it is no longer busy. A fix that charges needs `approveUsd` of at least its price.
 */
export async function applyFix(world: WorldHandle, flagId: string, fixId: unknown, opts: { approveUsd?: unknown; by?: unknown }): Promise<{ started: true; fix: FixSuggestion }> {
  const rec = await getObservation(world.id, flagId);
  if (!rec) throw new ObservationError(404, 'no such observation');
  const fix = suggestFixes(world, rec).fixes.find((f) => f.id === fixId);
  if (!fix) throw new ObservationError(409, 'That fix is not offered for this problem now, because the world has changed. Reload the card.');
  if (fix.kind === 'edit-mask') throw new ObservationError(409, 'The mask is redone by hand on the build page.');
  const approved = typeof opts.approveUsd === 'number' && Number.isFinite(opts.approveUsd) ? opts.approveUsd : 0;
  if (fix.costUsd > approved + 1e-9) throw new ObservationError(402, `This can cost up to $${fix.costUsd.toFixed(2)}. Send approveUsd: ${fix.costUsd} to go ahead.`);
  const by = parseAuthor(opts.by);
  const keys = keysConfigured();
  const oid = fix.object!;
  const obj = world.manifest.objects.find((o) => o.id === oid)!;
  const model = fix.model!;

  let started = false;
  if (fix.kind === 'use-asset') {
    const from = asModel(obj.mesh?.job?.model);
    const title = `Showed the ${describe(model)}${from ? ` instead of the ${describe(from)}` : ''}`;
    started = startTask(world, `Switching ${obj.name} to ${name(model)}`, async () => {
      await switchObjectAsset(world, oid, model);
      await recordFix(world.id, flagId, { kind: 'use-asset', at: nowIso(), by, object: oid, from, to: model, title });
    });
  } else if (fix.kind === 'check-assets') {
    if (!keys.meta) throw new ObservationError(400, 'MUSE_API_KEY must be set in .env');
    // Only the models the price was quoted for: not the flagged asset, which a person has already judged.
    started = startTask(world, `Asset check of the ${obj.name}`, () => checkWorldAssets(world, { scope: 'all', only: { object: oid, models: fix.models } }));
  } else if (fix.kind === 'generate-asset') {
    if (!keys.ai3d) throw new ObservationError(400, 'AI3D_API_KEY must be set in .env');
    started = startTask(world, `Making the ${describe(model)} of the ${obj.name}`, async () => {
      await generateAssets(world, model, [oid]);
      if (keys.meta && world.manifest.objects.find((o) => o.id === oid)?.assets?.[model]?.file) await checkWorldAssets(world, { scope: 'all', only: { object: oid, models: [model] } });
    });
  }
  if (!started) throw new ObservationError(409, 'This world is busy; try again when it is done.');
  world.log(`Fix for observation ${flagId}: ${fix.title} (${by}${fix.costUsd ? `, up to $${fix.costUsd.toFixed(2)}` : ''})`);
  return { started: true, fix };
}
