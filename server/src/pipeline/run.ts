// The WOM pipeline. Steps persist their outputs, so re-running a world skips finished work and resumes
// AI3D jobs that were already submitted.
//
//   prepare ─┬─ analyze ── segment ── split ─┬─ cleanplate ─┬─ world (Marble)
//            │                      │              └─ depth (clean plate)
//            └─ depth (photo)       └─ cutouts ── meshes (Tripo)
//                                                         └──────────── compose
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { uploadImage } from '../clients/ai3d.ts';
import { toDataUrl } from '../clients/meta.ts';
import { modelProvider } from '../clients/llm.ts';
import { MAX_PARALLEL_MESH_JOBS, STORE } from '../config.ts';
import { refundWorld } from '../credits.ts';
import { maskFromPng, maskToPng } from '../geometry/mask.ts';
import type { WorldHandle } from '../store.ts';
import type { MeshModel, ObjectRecord, PlannedObject, PlannerModel, StepId } from '../types.ts';
import { errorMessage, mapLimit, writeFileAtomic } from '../util.ts';
import { analyzeScene } from './analyze.ts';
import { activateAsset, objectDir, versionSuffix, wantedModel } from './assets.ts';
import { checkActiveAssets } from './assetcheck.ts';
import { makeCleanPlate } from './cleanplate.ts';
import { composeScene } from './compose.ts';
import { makeCutout } from './cutouts.ts';
import { OBJECT_MODELS, runMoge, runObjectModel, runWorldGen } from './generate.ts';
import { computePlacements } from './placements.ts';
import { reviewMasks } from './review.ts';
import { segmentObjects } from './segment.ts';
import { cutoutInputs, splitPeople } from './split.ts';

class CriticalStepError extends Error {}

const running = new Map<string, Promise<void>>();

export function isRunning(id: string) {
  return running.has(id);
}

export function startWorld(world: WorldHandle): Promise<void> {
  const existing = running.get(world.id);
  if (existing) return existing;
  const p = runWorld(world)
    .catch((err) => console.error(`[pipeline] world ${world.id} crashed:`, err))
    .finally(() => finish(world));
  running.set(world.id, p);
  return p;
}

/** Release the world and send one more update, so pages see that nothing is running any more. */
function finish(world: WorldHandle) {
  running.delete(world.id);
  void world.update(() => undefined);
}

/**
 * Run other work on a world in the background (generating assets to compare, running placement agents).
 * It holds the same lock as the pipeline, so a world never runs two jobs at once.
 */
export function startTask(world: WorldHandle, label: string, fn: () => Promise<unknown>): boolean {
  if (running.has(world.id)) return false;
  const p = fn()
    .then(() => undefined)
    .catch((err) => world.log(`${label} failed: ${errorMessage(err)}`))
    .finally(() => finish(world));
  running.set(world.id, p);
  return true;
}

/**
 * Generate `model`'s asset for every object that does not have one for its current mask (or only for the
 * objects in `only`), without making it the active model. Each object is generated at most once per model
 * and mask; existing ones are reused.
 */
export async function generateAssets(world: WorldHandle, model: MeshModel, only?: string[]) {
  const has = (o: ObjectRecord) => Boolean(o.assets?.[model]?.file);
  const todo = world.manifest.objects.filter((o) => o.cutout?.publicUrl && !has(o) && (!only || only.includes(o.id)));
  if (!todo.length) return;
  world.log(`Generating ${OBJECT_MODELS[model].label} for ${todo.map((o) => o.name).join(', ')} (to compare; the world keeps its current model)`);
  const results = await mapLimit(todo, MAX_PARALLEL_MESH_JOBS, (o) => runObjectModel(world, objectFor(world, o.id), model, { activate: false }));
  results.forEach((r, i) => {
    if (r.status === 'rejected') world.log(`${OBJECT_MODELS[model].label} failed for ${todo[i].name}: ${errorMessage(r.reason)}`);
  });
  const done = world.manifest.objects.filter(has).length;
  world.log(`${OBJECT_MODELS[model].label}: ${done} of ${world.manifest.objects.filter((o) => o.cutout).length} object(s) have one`);
}

/**
 * Show another object model in the world. Every object must already have it, so no 3D job runs; compose
 * fits the assets again and the placements use only cached agent answers (run agents from the viewer).
 */
export async function switchObjectModel(world: WorldHandle, model: MeshModel) {
  const missing = world.manifest.objects.filter((o) => o.cutout && !o.assets?.[model]?.file);
  if (missing.length) throw new Error(`${missing.map((o) => o.name).join(', ')} ${missing.length === 1 ? 'has' : 'have'} no ${OBJECT_MODELS[model].label} yet; generate it first`);
  await world.update((m) => {
    m.options.meshModel = model;
    for (const o of m.objects) {
      const a = o.assets?.[model];
      if (a?.file) activateAsset(o, a);
      // Switching the whole world means every object follows it again.
      o.pinnedModel = undefined;
    }
  });
  world.log(`Showing ${OBJECT_MODELS[model].label} objects (no new 3D jobs)`);
  await recompose(world);
}

/**
 * Show another model's asset for one object, e.g. because the asset check found leftovers of the photo's
 * background in the current one. The other objects keep theirs. The choice is saved on the object, so
 * retries and rebuilds of other objects do not undo it. Free: the asset already exists, compose fits it
 * again, and agent placements come only from the call cache.
 */
export async function switchObjectAsset(world: WorldHandle, objectId: string, model: MeshModel) {
  const o = world.manifest.objects.find((x) => x.id === objectId);
  if (!o) throw new Error(`unknown object ${objectId}`);
  const asset = o.assets?.[model];
  if (!asset?.file || !existsSync(world.file(asset.file))) throw new Error(`${o.name} has no ${OBJECT_MODELS[model].label} yet; generate it first`);
  await world.update((m) => {
    const rec = m.objects.find((x) => x.id === objectId)!;
    activateAsset(rec, asset);
    rec.pinnedModel = model === m.options.meshModel ? undefined : model;
  });
  // A saved layout for this object was made for the previous asset's frame and scale.
  const layoutFile = world.file('layout.json');
  if (existsSync(layoutFile)) {
    try {
      const saved = JSON.parse(await readFile(layoutFile, 'utf8')) as { objects?: { id: string }[] };
      if (saved.objects?.some((l) => l.id === objectId)) {
        await writeFileAtomic(layoutFile, JSON.stringify({ ...saved, objects: saved.objects.filter((l) => l.id !== objectId) }, null, 2));
      }
    } catch {
      // an unreadable layout is ignored by the viewer as well
    }
  }
  world.log(`${o.name}: showing the ${OBJECT_MODELS[model].label} asset (no new 3D job)`);
  await recompose(world);
}

/** Run placement agents on every object now (the world's agent selection is saved separately). */
export async function runPlacementAgents(world: WorldHandle, agents: PlannerModel[]) {
  await world.setStep('placements', { status: 'running' });
  try {
    const message = await computePlacements(world, { newCalls: true, agents });
    await world.setStep('placements', { status: 'done', message });
  } catch (err) {
    await world.setStep('placements', { status: 'failed', error: errorMessage(err) });
    throw err;
  }
}

async function step(world: WorldHandle, id: StepId, fn: () => Promise<string | void>, critical: boolean): Promise<boolean> {
  const state = world.manifest.steps[id];
  if (state.status === 'done' || state.status === 'skipped') return true;
  await world.setStep(id, { status: 'running', message: undefined, error: undefined });
  try {
    const message = await fn();
    if (world.manifest.steps[id].status === 'running') {
      await world.setStep(id, { status: 'done', message: typeof message === 'string' ? message : undefined });
    }
    return true;
  } catch (err) {
    const msg = errorMessage(err);
    world.log(`${state.label} failed: ${msg}`);
    await world.setStep(id, { status: 'failed', error: msg });
    if (critical) throw new CriticalStepError(msg);
    return false;
  }
}

async function skip(world: WorldHandle, id: StepId, message: string) {
  if (world.manifest.steps[id].status === 'done') return;
  await world.setStep(id, { status: 'skipped', message });
}

function positionWord(o: PlannedObject) {
  const cx = (o.box.x0 + o.box.x1) / 2;
  return cx < 380 ? 'on the left' : cx > 620 ? 'on the right' : 'in the middle';
}

function objectFor(world: WorldHandle, id: string): ObjectRecord {
  const o = world.manifest.objects.find((x) => x.id === id);
  if (!o) throw new Error(`unknown object ${id}`);
  return o;
}

async function prepare(world: WorldHandle) {
  if (world.manifest.image.publicUrl) return;
  const bytes = await readFile(world.file(world.manifest.image.file));
  const url = await uploadImage(bytes, 'source.jpg', 'image/jpeg');
  await world.update((m) => { m.image.publicUrl = url; });
  return 'Photo uploaded for AI3D';
}

async function analyze(world: WorldHandle) {
  const m = world.manifest;
  if (m.plan) return;
  const small = await sharp(world.file(m.image.file)).resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
  const splittable = m.options.splitPeople && OBJECT_MODELS[m.options.meshModel].kind === 'splat';
  const { plan, costUsd } = await analyzeScene({ imageJpeg: small, model: m.options.plannerModel, maxObjects: m.options.maxObjects, splitPeople: splittable });
  await world.addCost({ label: `${m.options.plannerModel} scene plan`, usd: costUsd, provider: modelProvider(m.options.plannerModel), estimated: false });
  await world.update((mm) => {
    mm.plan = plan;
    mm.title = plan.title;
    mm.objects = plan.objects.map((o) => ({ id: o.id, name: o.name, status: 'pending' }));
  });
  world.log(`${m.options.plannerModel} planned "${plan.title}" with ${plan.objects.length} object(s): ${plan.objects.map((o) => o.name).join(', ') || 'none'}`);
  return `${plan.objects.length} object(s): ${plan.objects.map((o) => o.name).join(', ') || 'background only'}`;
}

async function segment(world: WorldHandle) {
  const m = world.manifest;
  const plan = m.plan!;
  const todo = plan.objects.filter((o) => !objectFor(world, o.id).mask);
  if (todo.length) {
    const jpeg = await readFile(world.file(m.image.file));
    const { results, costUsd } = await segmentObjects({
      imageDataUrl: toDataUrl(jpeg, 'image/jpeg'),
      width: m.image.width,
      height: m.image.height,
      objects: todo,
      log: (msg) => world.log(msg),
    });
    await world.addCost({ label: 'SAM 3.1 segmentation', usd: costUsd, provider: 'meta', estimated: false });

    // When SAM produced competing masks, Muse Spark looks at the cutouts and picks the cleanest one.
    const contested = results.filter((r) => r.alternatives.length > 0);
    if (contested.length) {
      const candidates = contested.flatMap((r) =>
        [r, ...r.alternatives.slice(0, 2)].map((c) => ({ objectId: r.id, objectName: plan.objects.find((o) => o.id === r.id)!.name, mask: c.mask, box: c.box })),
      );
      try {
        const review = await reviewMasks({
          source: jpeg,
          width: m.image.width,
          height: m.image.height,
          candidates,
          model: m.options.plannerModel === 'muse-wonder-1.0' ? 'muse-wonder-1.0' : 'muse-spark-1.3',
        });
        await world.addCost({ label: 'Muse Spark mask review', usd: review.costUsd, provider: 'meta', estimated: false });
        let k = 0;
        for (const r of contested) {
          const options = [r, ...r.alternatives.slice(0, 2)];
          const scores = review.scores.slice(k, k + options.length);
          k += options.length;
          let bestIdx = 0;
          for (let i = 1; i < options.length; i++) if (scores[i] > scores[bestIdx] + 0.25) bestIdx = i;
          const name = plan.objects.find((o) => o.id === r.id)!.name;
          if (bestIdx > 0) {
            const pick = options[bestIdx];
            world.log(`Muse Spark preferred the ${pick.method}-prompt mask for ${name} (scores ${scores.map((s) => s.toFixed(1)).join(' / ')})`);
            Object.assign(r, { mask: pick.mask, box: pick.box, area: pick.area, method: pick.method });
          } else if (scores[0] <= 2) {
            world.log(`Muse Spark rated the mask for ${name} as poor (${scores[0].toFixed(1)}/5); keeping the best available`);
          }
        }
      } catch (err) {
        world.log(`Mask review skipped: ${errorMessage(err)}`);
      }
    }

    for (const r of results) {
      const rel = `objects/${r.id}/mask.png`;
      await writeFileAtomic(world.file(rel), await maskToPng(r.mask));
      await world.update(() => {
        objectFor(world, r.id).mask = { file: rel, box: r.box, area: r.area, method: r.method };
      });
    }
    await world.update((mm) => {
      for (const o of mm.objects) if (!o.mask) { o.status = 'skipped'; o.error = 'SAM 3.1 found no mask'; }
    });
  }
  const n = world.manifest.objects.filter((o) => o.mask).length;
  return `${n} of ${plan.objects.length} object(s) segmented`;
}

/** People the plan marked become a head and a body (only for Gaussian-splat object models, which alignment can move). */
async function split(world: WorldHandle) {
  const m = world.manifest;
  if (!m.options.splitPeople) return 'Off for this world';
  if (OBJECT_MODELS[m.options.meshModel].kind !== 'splat') return 'Needs a Gaussian-splat object model';
  return splitPeople(world);
}

async function cleanplate(world: WorldHandle) {
  const m = world.manifest;
  if (m.cleanPlate?.publicUrl) return;
  const plan = m.plan!;
  const kept = plan.objects.filter((o) => objectFor(world, o.id).mask);
  // If SAM dropped an object, write our own removal prompt so that object stays in the background.
  const removal = kept.length === plan.objects.length
    ? plan
    : {
        ...plan,
        removalPrompt: kept.length
          ? `Remove ${kept.map((o) => `the ${o.name} ${positionWord(o)}`).join(', ')}${plan.hasOverlayText ? ', and any overlaid text or watermarks' : ''}, and fill the revealed areas with what would be behind them, continuing the surrounding background.`
          : plan.hasOverlayText ? 'Remove all overlaid text, captions and watermarks.' : '',
      };
  const source = await readFile(world.file(m.image.file));
  const result = await makeCleanPlate({
    sourceJpeg: source,
    width: m.image.width,
    height: m.image.height,
    plan: removal,
    objectNames: kept.map((o) => o.name),
    reviewer: m.options.plannerModel === 'muse-wonder-1.0' ? 'muse-wonder-1.0' : 'muse-spark-1.3',
    log: (msg) => world.log(msg),
  });
  await world.addCost({ label: 'Muse Image clean plate + Muse Spark review', usd: result.costUsd, provider: 'meta', estimated: false });
  await writeFileAtomic(world.file('clean.jpg'), result.jpeg);
  const url = await uploadImage(result.jpeg, 'clean.jpg', 'image/jpeg');
  await world.update((mm) => { mm.cleanPlate = { file: 'clean.jpg', publicUrl: url }; });
  return result.attempts > 1 ? `Cleaned in ${result.attempts} passes` : result.attempts === 0 ? 'Nothing to remove' : 'Objects erased';
}

async function cutouts(world: WorldHandle) {
  const m = world.manifest;
  const plan = m.plan!;
  const source = await readFile(world.file(m.image.file));
  const todo = m.objects.filter((o) => o.mask && !o.cutout?.publicUrl);
  const results = await mapLimit(todo, 3, async (o) => {
    const planned = plan.objects.find((p) => p.id === o.id)!;
    // the head of a split person is cut from the photo with its hidden jaw painted in (see cutoutInputs)
    const inputs = cutoutInputs(world, o, planned);
    const mask = await maskFromPng(inputs.maskFile);
    const filled = inputs.sourceFile ? await readFile(inputs.sourceFile) : null;
    const c = await makeCutout({
      sourceJpeg: filled ?? source,
      width: m.image.width,
      height: m.image.height,
      mask,
      object: planned,
      complete: m.options.completeOccluded,
      log: (msg) => world.log(msg),
    });
    if (c.costUsd) await world.addCost({ label: `Muse Image completion: ${o.name}`, usd: c.costUsd, provider: 'meta', estimated: false });
    const rawRel = `${objectDir(o)}/cutout_raw.png`;
    const rel = `${objectDir(o)}/cutout.png`;
    await writeFileAtomic(world.file(rawRel), c.rawPng);
    await writeFileAtomic(world.file(rel), c.finalPng);
    const url = await uploadImage(c.finalPng, `${o.id}${versionSuffix(o)}.png`, 'image/png');
    await world.update(() => {
      objectFor(world, o.id).cutout = { file: rel, rawFile: rawRel, completed: c.completed, publicUrl: url };
    });
  });
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const o = todo[i];
      world.log(`Cutout failed for ${o.name}: ${errorMessage(r.reason)}`);
      void world.update(() => { const rec = objectFor(world, o.id); rec.status = 'failed'; rec.error = errorMessage(r.reason); });
    }
  });
  const ok = world.manifest.objects.filter((o) => o.cutout).length;
  if (todo.length && ok === 0) throw new Error('no cutouts could be made');
  return `${ok} cutout(s)${world.manifest.objects.some((o) => o.cutout?.completed) ? ', occluded parts completed by Muse Image' : ''}`;
}

async function meshes(world: WorldHandle) {
  const m = world.manifest;
  const todo = m.objects.filter((o) => o.cutout?.publicUrl && !(o.mesh?.file && o.mesh.job?.model === wantedModel(m, o)));
  await world.update(() => { for (const o of todo) objectFor(world, o.id).status = 'running'; });
  const results = await mapLimit(todo, MAX_PARALLEL_MESH_JOBS, async (o) => {
    await runObjectModel(world, objectFor(world, o.id), wantedModel(m, o));
    await world.update(() => { const rec = objectFor(world, o.id); rec.status = 'done'; rec.error = undefined; });
  });
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      const msg = errorMessage(r.reason);
      world.log(`Mesh failed for ${todo[i].name}: ${msg}`);
      await world.update(() => { const rec = objectFor(world, todo[i].id); rec.status = 'failed'; rec.error = msg; });
    }
  }
  const kind = OBJECT_MODELS[m.options.meshModel].kind === 'splat' ? 'splat' : 'mesh';
  const done = world.manifest.objects.filter((o) => o.mesh?.file && o.mesh.job?.model === wantedModel(world.manifest, o)).length;
  const wanted = world.manifest.objects.filter((o) => o.cutout).length;
  if (wanted > 0 && done === 0) throw new Error(`every ${kind} job failed`);
  if (done < wanted) await world.setStep('meshes', { status: 'failed', error: `${wanted - done} of ${wanted} ${kind}(es) failed`, message: `${done} of ${wanted} ${kind}(es) ready` });
  // Look for leftovers of the photo's background in the new assets (about a cent each; never fails the step).
  const flagged = done > 0 ? await checkActiveAssets(world) : '';
  return `${done} ${kind === 'splat' ? 'splat' : 'mesh'}${done === 1 ? '' : 'es'} ready${flagged}`;
}

async function worldStep(world: WorldHandle) {
  const m = world.manifest;
  if (m.options.worldModel === 'none') return;
  const url = m.cleanPlate?.publicUrl ?? m.image.publicUrl;
  if (!url) throw new Error('no image for the world generator');
  if (!m.cleanPlate) world.log('No clean plate; Marble will grow the world from the original photo');
  await runWorldGen(world, m.options.worldModel, url, m.plan?.worldPrompt ?? '');
  const n = world.manifest.world?.splats?.length ?? 0;
  return `${n} splat level(s) of detail`;
}

async function runWorld(world: WorldHandle) {
  await world.update((m) => { m.status = 'running'; m.error = undefined; });
  world.log('Pipeline started');
  let resolveClean!: (ok: boolean) => void;
  const cleanDone = new Promise<boolean>((r) => (resolveClean = r));
  let depthP: Promise<boolean> = Promise.resolve(false);
  try {
    await step(world, 'prepare', () => prepare(world), true);

    depthP = step(world, 'depth', async () => {
      await runMoge(world, 'original', world.manifest.image.publicUrl!);
      const hasClean = await cleanDone;
      const clean = world.manifest.cleanPlate?.publicUrl;
      if (hasClean && clean) {
        try {
          await runMoge(world, 'clean', clean);
        } catch (err) {
          world.log(`Clean-plate depth failed (${errorMessage(err)}); the relief will use the photo's depth`);
        }
      }
      return world.manifest.depth.clean?.files ? 'Photo and clean plate measured' : 'Photo measured';
    }, true).catch((err) => { resolveClean(false); throw err; });

    await step(world, 'analyze', () => analyze(world), true);
    await step(world, 'segment', () => segment(world), true);
    await step(world, 'split', () => split(world), false);

    const hasObjects = world.manifest.objects.some((o) => o.mask);
    const cleanP = (async () => {
      if (!hasObjects && !world.manifest.plan?.hasOverlayText) {
        // Nothing to erase: the photo itself is the clean plate.
        if (!world.manifest.cleanPlate) {
          await world.update((m) => { m.cleanPlate = { file: m.image.file, publicUrl: m.image.publicUrl }; });
        }
        await skip(world, 'cleanplate', 'Nothing to erase');
        return true;
      }
      return step(world, 'cleanplate', () => cleanplate(world), false);
    })().then((ok) => { resolveClean(ok); return ok; });

    const fgP = (async () => {
      if (!hasObjects) {
        await skip(world, 'cutouts', 'No objects');
        await skip(world, 'meshes', 'No objects');
        return true;
      }
      const ok = await step(world, 'cutouts', () => cutouts(world), false);
      return ok && step(world, 'meshes', () => meshes(world), false);
    })();

    const worldP = (async () => {
      await cleanP;
      if (world.manifest.options.worldModel === 'none') {
        await skip(world, 'world', 'Disabled in options');
        return true;
      }
      return step(world, 'world', () => worldStep(world), false);
    })();

    await Promise.all([cleanP, fgP, worldP, depthP]);
    // compose is cheap and local: always rebuild it after generation work.
    await world.setStep('compose', { status: 'pending' });
    await step(world, 'compose', async () => {
      const doc = await composeScene(world);
      await world.update((m) => { m.scene = { file: 'scene.json', version: doc.version }; });
      for (const d of doc.diagnostics) world.log(`compose: ${d}`);
      return `${doc.objects.length} object(s) placed${doc.world ? ' in the Marble world' : ''}`;
    }, true);
    // Alternative placements (grounded fitter, Muse agents). The scene is already viewable; this adds choices.
    await world.setStep('placements', { status: 'pending' });
    await step(world, 'placements', () => computePlacements(world, { newCalls: true }), false);

    const anyFailed = Object.values(world.manifest.steps).some((s) => s.status === 'failed') ||
      world.manifest.objects.some((o) => o.status === 'failed');
    await world.update((m) => { m.status = anyFailed ? 'partial' : 'done'; });
    world.log(anyFailed ? 'Finished with some failures; you can retry the failed parts' : 'World ready');
  } catch (err) {
    resolveClean(false);
    // A MoGe job may still be polling; let it finish in the background so a retry can reuse it.
    depthP.catch(() => undefined);
    const msg = errorMessage(err);
    await world.update((m) => { m.status = 'failed'; m.error = msg; });
    world.log(`Pipeline stopped: ${msg}`);
    await refundFailedBuild(world);
  }
}

/**
 * A build that ends `failed` made no world: a step it cannot do without stopped it. The credits it held go back to its owner.
 * This comes after the status is saved, so that if the server stops in between, the check at start-up (credits.ts,
 * refundFailedWorlds) finds a failed world that still holds its credits. A world that ends `partial` keeps them: it can be
 * looked at, and retrying its failed parts is free. Retrying a failed world holds the price again first (the retry route).
 */
async function refundFailedBuild(world: WorldHandle) {
  if (STORE !== 'postgres') return;
  try {
    const back = await refundWorld({ id: world.ownerId, role: 'user' }, world.id);
    if (back > 0) world.log(`Gave back ${back.toLocaleString('en-US')} credits because the build failed. A retry holds them again.`);
  } catch (err) {
    world.log(`Could not give back the credits yet (${errorMessage(err)}). They are given back when the server next starts.`);
  }
}

/** Reset failed parts so the next run retries them (finished steps and paid-for outputs are kept). */
export async function prepareRetry(world: WorldHandle) {
  await world.update((m) => {
    for (const s of Object.values(m.steps)) {
      if (s.status === 'failed' || s.status === 'running') { s.status = 'pending'; s.error = undefined; }
    }
    for (const o of m.objects) {
      if (o.status === 'failed' || o.status === 'running') { o.status = 'pending'; o.error = undefined; }
    }
    // Objects made with a different model than the current option are regenerated.
    for (const o of m.objects) {
      if (o.cutout && o.mesh?.file && o.mesh.job?.model !== wantedModel(m, o)) o.status = 'pending';
    }
    // Steps that depend on retried objects must run again.
    if (m.objects.some((o) => o.cutout && !(o.mesh?.file && o.mesh.job?.model === wantedModel(m, o)))) m.steps.meshes.status = 'pending';
    // A different world or depth model: reuse it if it was made before, otherwise generate it once.
    if (m.options.worldModel !== 'none' && m.world?.job?.model && m.world.job.model !== m.options.worldModel) m.steps.world.status = 'pending';
    if ((m.depth.original?.job?.model ?? 'moge2') !== (m.options.depthModel ?? 'moge2')) m.steps.depth.status = 'pending';
    if (m.objects.some((o) => o.mask && !o.cutout)) m.steps.cutouts.status = 'pending';
    m.steps.compose.status = 'pending';
    if (m.steps.placements) m.steps.placements.status = 'pending';
  });
}

/** Re-run only the local compose step and the placements (free: agents answer only from the call cache). */
export async function recompose(world: WorldHandle) {
  await world.setStep('compose', { status: 'running' });
  let doc;
  try {
    doc = await composeScene(world);
    await world.update((m) => { m.scene = { file: 'scene.json', version: doc!.version }; });
    await world.setStep('compose', { status: 'done', message: `${doc.objects.length} object(s) placed${doc.world ? ' in the Marble world' : ''}` });
    for (const d of doc.diagnostics) world.log(`compose: ${d}`);
  } catch (err) {
    await world.setStep('compose', { status: 'failed', error: errorMessage(err) });
    throw err;
  }
  await world.setStep('placements', { status: 'running' });
  try {
    const message = await computePlacements(world, { newCalls: false });
    await world.setStep('placements', { status: 'done', message });
  } catch (err) {
    world.log(`placements failed: ${errorMessage(err)}`);
    await world.setStep('placements', { status: 'failed', error: errorMessage(err) });
  }
  return doc;
}
