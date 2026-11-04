// Read-only facts about one generation. No model calls, benchmark runs, or migrations are needed.
import { STEP_ORDER, type AssetVerdict, type ObservationRecord, type PlacementMethod, type SceneDoc, type WorldManifest } from './types.ts';
import type { ParStatus } from '@wom/metrics/core';

export interface WorldMetrics {
  schema: 'wometrics/1';
  world: string;
  title: string;
  status: WorldManifest['status'];
  updatedAt: string;
  sceneVersion: number | null;
  running: boolean;
  par: ParStatus | null;
  stages: { done: number; failed: number; skipped: number; total: number };
  elapsedMs: number | null;
  objects: {
    id: string; name: string; status: string; model: string | null; inScene: boolean;
    iou: number | null; gapM: number | null; tiltDeg: number | null;
    method: PlacementMethod | null; verdict: AssetVerdict | null; foreignShare: number | null;
  }[];
  plannedObjects: number | null;
  placedObjects: number;
  placement: { active: PlacementMethod; measured: number; meanIou: number | null; meanAbsGapM: number | null; gapMeasured: number; meanTiltDeg: number | null };
  assets: { generated: number; checked: number; clean: number; minor: number; contaminated: number };
  components: { background: boolean; backgroundRequested: boolean; relief: boolean; collision: boolean; depth: boolean };
  camera: { source: string | null; hfovDeg: number | null; lensHfovDeg: number | null; lensErrorDeg: number | null; heightM: number | null };
  models: { role: string; models: string[] }[];
  payloadBytes: number | null;
  payloadComplete: boolean;
  reprojection: boolean;
  // Costs and observation records remain private to the owner, including on a shared metrics page.
  spend: { usd: number; estimatedUsd: number; calls: number; providers: { provider: string; usd: number }[] } | null;
  observations: { total: number; unresolved: number; fixed: number } | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const number = (v: unknown): number | null => finite(v) ? v : null;
const mean = (vs: (number | null)[]) => {
  const values = vs.filter(finite);
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
};
const unique = (vs: (string | undefined)[]) => [...new Set(vs.filter((v): v is string => Boolean(v)))];

export function worldMetrics(m: WorldManifest, scene: SceneDoc | null, opts: {
  running: boolean; owner: boolean; reprojection: boolean; observations?: Pick<ObservationRecord, 'status'>[]; now?: number; par?: ParStatus | null;
}): WorldMetrics {
  const states = STEP_ORDER.map((s) => m.steps[s.id]).filter(Boolean);
  const starts = states.map((s) => Date.parse(s.startedAt ?? '')).filter(finite);
  const ends = states.map((s) => Date.parse(s.endedAt ?? '')).filter(finite);
  const end = opts.running ? (opts.now ?? Date.now()) : ends.length ? Math.max(...ends) : null;
  const active = scene?.placement?.active ?? m.placementMethod ?? 'fitter';
  const ids = unique([...(m.plan?.objects.map((o) => o.id) ?? []), ...m.objects.map((o) => o.id), ...(scene?.objects.map((o) => o.id) ?? [])]);
  const objects = ids.map((id): WorldMetrics['objects'][number] => {
    const rec = m.objects.find((o) => o.id === id);
    const so = scene?.objects.find((o) => o.id === id && o.visible);
    const variant = so?.placements?.[active] ?? so?.placements?.fitter;
    const url = (file: string | undefined) => file ? `/files/${m.id}/${file}` : null;
    const versions = rec ? [rec, ...(rec.history ?? [])] : [];
    // During a rebuild the saved scene may still show an earlier asset. Keep its verdict tied to its bytes.
    const asset = versions.flatMap((v) => Object.values(v.assets ?? {})).find((a) => a?.file && (so
      ? url(a.file) === so.url || versions.some((v) => url(v.aligned?.file) === so.url && a.file === v.mesh?.file)
      : a.file === rec?.mesh?.file));
    const meshMatches = !so || versions.some((v) => url(v.mesh?.file) === so.url || url(v.aligned?.file) === so.url);
    const check = asset?.check?.file === asset?.file ? asset?.check : undefined;
    return {
      id, name: rec?.name ?? so?.name ?? m.plan?.objects.find((o) => o.id === id)?.name ?? id,
      status: rec?.status ?? 'pending', model: asset?.model ?? (meshMatches ? rec?.mesh?.job?.model ?? null : null), inScene: Boolean(so),
      iou: number(so ? variant?.iou ?? so.fitIou : undefined), gapM: number(variant?.contactGapM), tiltDeg: number(variant?.tiltDeg),
      method: so ? so.placements?.[active] ? active : 'fitter' : null,
      verdict: check?.verdict ?? null, foreignShare: number(check?.foreignShare),
    };
  });
  const gaps = objects.map((o) => o.gapM === null ? null : Math.abs(o.gapM));
  const hfov = scene ? 2 * Math.atan(Math.tan(scene.camera.fovY * Math.PI / 360) * scene.camera.aspect) * 180 / Math.PI : null;
  const lens = number(m.image.camera?.hfovDeg);
  const payload = [...(scene?.objects.filter((o) => o.visible).map((o) => o.bytes) ?? []), ...(scene?.world?.splats.slice(0, 1).map((s) => s.size) ?? [])];
  const costs = m.costs.filter((c) => finite(c.usd) && c.usd >= 0);
  const flags = opts.observations;
  return {
    schema: 'wometrics/1', world: m.id, title: m.title, status: m.status, updatedAt: m.updatedAt, sceneVersion: scene?.version ?? null, running: opts.running, par: opts.par ?? null,
    stages: { done: states.filter((s) => s.status === 'done').length, failed: states.filter((s) => s.status === 'failed').length, skipped: states.filter((s) => s.status === 'skipped').length, total: STEP_ORDER.length },
    elapsedMs: starts.length && end !== null ? Math.max(0, end - Math.min(...starts)) : null,
    objects, plannedObjects: m.plan ? m.plan.objects.length : null, placedObjects: objects.filter((o) => o.inScene).length,
    placement: { active, measured: objects.filter((o) => o.iou !== null).length, meanIou: mean(objects.map((o) => o.iou)), meanAbsGapM: mean(gaps), gapMeasured: gaps.filter(finite).length, meanTiltDeg: mean(objects.map((o) => o.tiltDeg)) },
    assets: { generated: objects.filter((o) => m.objects.find((r) => r.id === o.id)?.mesh?.file).length, checked: objects.filter((o) => o.verdict).length, clean: objects.filter((o) => o.verdict === 'clean').length, minor: objects.filter((o) => o.verdict === 'minor').length, contaminated: objects.filter((o) => o.verdict === 'contaminated').length },
    components: { background: Boolean(scene?.world?.splats.length), backgroundRequested: m.options.worldModel !== 'none', relief: Boolean(scene?.relief), collision: Boolean(scene?.world?.colliderUrl), depth: Boolean(m.depth?.original?.files?.points) },
    camera: { source: scene?.camera.source ?? null, hfovDeg: number(hfov), lensHfovDeg: lens, lensErrorDeg: hfov !== null && lens !== null ? hfov - lens : null, heightM: number(scene?.camera.heightM) },
    models: [
      { role: 'Scene director', models: unique([m.options.plannerModel]) },
      { role: 'Segmentation', models: states.some((s) => s.id === 'segment' && s.status === 'done') ? ['SAM 3.1'] : [] },
      { role: 'Object generation', models: unique(m.objects.filter((o) => o.mesh?.file).map((o) => o.mesh?.job?.model)) },
      { role: 'Depth', models: unique([m.depth?.original?.job.model, m.depth?.clean?.job.model]) },
      { role: 'Surrounding world', models: unique(m.world?.splats?.length ? [m.world.job?.model] : []) },
      { role: 'Asset checker', models: unique(m.objects.flatMap((o) => Object.values(o.assets ?? {}).filter((a) => a?.file === o.mesh?.file && a?.check?.file === a?.file).map((a) => a?.check?.model))) },
    ],
    payloadBytes: scene && payload.length && payload.some(finite) ? payload.filter(finite).reduce((sum, v) => sum + v, 0) : null,
    payloadComplete: Boolean(scene && payload.length && payload.every(finite)),
    reprojection: opts.reprojection,
    spend: opts.owner ? { usd: costs.reduce((sum, c) => sum + c.usd, 0), estimatedUsd: costs.filter((c) => c.estimated).reduce((sum, c) => sum + c.usd, 0), calls: costs.length, providers: unique(costs.map((c) => c.provider)).map((provider) => ({ provider, usd: costs.filter((c) => c.provider === provider).reduce((sum, c) => sum + c.usd, 0) })) } : null,
    observations: opts.owner && flags ? { total: flags.length, unresolved: flags.filter((f) => f.status === 'open' || f.status === 'confirmed' || f.status === 'wontfix').length, fixed: flags.filter((f) => f.status === 'fixed').length } : null,
  };
}
