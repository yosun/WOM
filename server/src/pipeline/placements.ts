// After compose: every object gets each placement the viewer can switch between — the compose fitter,
// the fitter kept upright on the ground, and the Muse Spark / Muse Wonder agents (with the same tools and
// prompts as the placement benchmark, so their answers are shared with it through the call cache).
// The active one becomes the object's base transform; the user picks it in the viewer.
import { existsSync, readFileSync } from 'node:fs';
import { CaseRunner } from '../bench/case.ts';
import { modelProvider } from '../clients/llm.ts';
import { DEFAULT_OPTIONS } from '../config.ts';
import { BudgetExceeded, Spend } from '../bench/cache.ts';
import { loadAsset, loadBenchWorld } from '../bench/context.ts';
import { agentPlacement } from '../bench/llm.ts';
import { evaluatePlacement } from '../bench/metrics.ts';
import { CV_TO_THREE, cvToThree, mul, quatFromMat3, type Mat3, type Vec3 } from '../geometry/math.ts';
import type { Pose } from '../geometry/raster.ts';
import { PLACEMENT_AGENT_REVISION } from '../placement.ts';
import type { WorldHandle } from '../store.ts';
import { AGENT_PLACEMENTS, MODEL_LABELS, PLACEMENT_METHODS, type PlacementMethod, type PlacementVariant, type PlannerModel, type SceneDoc } from '../types.ts';
import { errorMessage, mapLimit, writeFileAtomic } from '../util.ts';

/** Most a single world's agent placements may spend in one run. */
const AGENT_BUDGET_USD = 3;

function toThree(pose: Pose) {
  return { position: cvToThree(pose.t), quaternion: quatFromMat3(mul(CV_TO_THREE, pose.R)), scale: pose.s };
}

function fromThree(o: { position: Vec3; quaternion: [number, number, number, number]; scale: number }): Pose {
  const [x, y, z, w] = o.quaternion;
  const R3: Mat3 = [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
  return { R: mul(CV_TO_THREE, R3), t: cvToThree(o.position), s: o.scale };
}

/** Rewrite scene.json so `method` is each object's base transform (objects without it keep the fitter). */
export function applyPlacement(doc: SceneDoc, method: PlacementMethod): SceneDoc {
  for (const o of doc.objects) {
    const v = o.placements?.[method] ?? o.placements?.fitter;
    if (!v) continue;
    o.position = v.position;
    o.quaternion = v.quaternion;
    o.scale = v.scale;
  }
  const methods = PLACEMENT_METHODS.map(({ id, label }) => {
    const vs = doc.objects.map((o) => o.placements?.[id]).filter((v): v is PlacementVariant => Boolean(v));
    return { id, label, objects: vs.length, meanIou: vs.length ? vs.reduce((a, v) => a + v.iou, 0) / vs.length : 0 };
  }).filter((m) => m.objects > 0);
  doc.placement = { active: methods.some((m) => m.id === method) ? method : 'fitter', methods };
  return doc;
}

/**
 * Compute every placement for the world's current scene and write them into scene.json.
 * `newCalls: false` (recompose) only uses agent answers already in the call cache, so it costs nothing.
 * `agents` limits which agents run (default: the world's setting); other agents' placements already in
 * scene.json are kept. Compose writes a fresh scene.json, so those always belong to the current assets.
 */
export async function computePlacements(world: WorldHandle, opts: { newCalls: boolean; agents?: PlannerModel[] }): Promise<string> {
  const file = world.file('scene.json');
  if (!existsSync(file)) throw new Error('no scene to place objects in');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as SceneDoc;
  const bw = await loadBenchWorld(world.id);
  // Worlds made before the setting existed get the default agents.
  const agents: PlannerModel[] = opts.agents ?? world.manifest.options.placementAgents ?? DEFAULT_OPTIONS.placementAgents;
  const spend = new Spend(opts.newCalls ? AGENT_BUDGET_USD : 0, `world-${world.id}`);
  const notes: string[] = [];

  await mapLimit(doc.objects, 2, async (so) => {
    const obj = bw.objects.find((o) => o.id === so.id);
    const rec = world.manifest.objects.find((o) => o.id === so.id);
    const model = rec?.mesh?.job?.model;
    const assetRec = obj?.assets.find((a) => a.model === model && a.file === rec?.mesh?.file) ?? obj?.assets.find((a) => a.model === model);
    if (!obj || !assetRec) return;
    // The head and the body of a split person are one body: placing them separately (on the ground, or by an agent) would pull them apart.
    // They keep the fitter's placement, which alignment was made for.
    if (world.manifest.plan?.objects.find((p) => p.id === so.id)?.part) {
      const base = so.placements?.fitter ?? { position: so.position, quaternion: so.quaternion, scale: so.scale };
      const only: NonNullable<typeof so.placements> = {
        fitter: { ...toThree(fromThree(base)), iou: so.placements?.fitter?.iou ?? so.fitIou, contactGapM: so.placements?.fitter?.contactGapM ?? 0, tiltDeg: so.placements?.fitter?.tiltDeg ?? 0, heightM: so.placements?.fitter?.heightM ?? 0, note: 'part of a split person: placed together with the other half' },
      };
      so.placements = only;
      return;
    }
    const asset = await loadAsset(bw, assetRec);
    const c = new CaseRunner(bw, obj, asset);
    const variant = (pose: Pose, note?: string): PlacementVariant => {
      const m = evaluatePlacement(bw, obj, asset, pose);
      return { ...toThree(pose), iou: m.iou, contactGapM: m.contactGapM, tiltDeg: m.tiltDeg, heightM: m.heightM, ...(note ? { note } : {}) };
    };
    const placements: NonNullable<typeof so.placements> = {};
    // Keep an existing result if this placement pass cannot replace it.
    for (const method of Object.values(AGENT_PLACEMENTS)) {
      if (so.placements?.[method]) placements[method] = so.placements[method];
    }
    // The compose fit as written (or as previously recorded, if the base transform already shows another method).
    const fitterBase = so.placements?.fitter ?? { position: so.position, quaternion: so.quaternion, scale: so.scale };
    placements.fitter = variant(fromThree(fitterBase));
    const g = c.fitGrounded();
    if (g.pose) placements.grounded = variant(g.pose);

    if (agents.length) {
      const task = await c.task();
      await Promise.all(agents.map(async (llm) => {
        const method = AGENT_PLACEMENTS[llm];
        try {
          const out = await agentPlacement(task, llm, { spend, fresh: false, effort: 'medium', ledger: false, partialOk: opts.newCalls });
          if (out.info.costUsd > 0) {
            await world.addCost({ label: `${MODEL_LABELS[llm]} placement agent: ${obj.name}`, usd: out.info.costUsd, provider: modelProvider(llm), estimated: false }, { model: llm });
          }
          if (out.placement) {
            const tools = [...new Set(out.steps.map((s) => s.tool))].join(', ') || 'no tools';
            placements[method] = { ...variant(c.pose(out.placement), `${out.submitted?.source ?? 'last try'} (${tools}): ${out.submitted?.rationale ?? out.info.error ?? ''}`.trim()), agentRevision: PLACEMENT_AGENT_REVISION };
          } else if (out.info.error && !/budget/.test(out.info.error)) {
            notes.push(`${obj.name}: ${llm} agent failed (${out.info.error})`);
          }
        } catch (err) {
          if (!(err instanceof BudgetExceeded)) notes.push(`${obj.name}: ${llm} agent failed (${errorMessage(err)})`);
        }
      }));
    }
    so.placements = placements;
  });

  applyPlacement(doc, world.manifest.placementMethod ?? 'fitter');
  await writeFileAtomic(file, JSON.stringify(doc, null, 2));
  for (const n of notes) world.log(`placements: ${n}`);
  const summary = doc.placement!.methods.map((m) => `${m.label} ${m.meanIou.toFixed(2)}`).join(' · ');
  world.log(`placements: ${summary}${spend.usd > 0 ? ` (agents $${spend.usd.toFixed(3)})` : ''}`);
  return summary;
}
