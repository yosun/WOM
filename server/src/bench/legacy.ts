// Benchmark runs written before the metrics framework (data/bench/placement/<run>/results.json and
// data/bench/assets/<run>/results.json), read as runs of the current format. Nothing on disk is changed:
// the old file stays as it is and is converted each time it is read.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { slug, sortMethods, taskInfo, type CaseRecord, type MethodSpec, type ResultRecord, type RunFile, type Scores } from '@wom/metrics';
import { asFindings, ASSET_CHECK_SPEC, checkMethod, checkMethodId, methodSpec, PLACEMENT_SPEC, type PlacementKind } from './spec.ts';

interface OldPlacementResult {
  case: string;
  world: string;
  worldTitle: string;
  object: string;
  objectName: string;
  asset: string;
  depth?: string;
  maskVersion?: number;
  method: PlacementKind;
  llm?: string;
  metrics?: { iou: number; colorErr: number; depthErr: number; contactGapM: number; tiltDeg: number };
  placement?: unknown;
  yawVsFitter?: number;
  costUsd: number;
  latencyMs: number;
  calls?: number;
  cachedCalls?: number;
  details?: Record<string, unknown>;
  error?: string;
}

interface OldRun<R> {
  config?: Record<string, unknown> & { model?: string };
  summary?: { id?: string; finishedAt?: string; spentUsd?: number; newCalls?: number; cachedCalls?: number; missing?: string[] };
  results?: R[];
}

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The time a run started, from the config.json the old runner kept beside its results. */
function startedAtOf(dir: string): string | undefined {
  const file = path.join(dir, 'config.json');
  if (!existsSync(file)) return undefined;
  try {
    const at = (JSON.parse(readFileSync(file, 'utf8')) as { startedAt?: unknown }).startedAt;
    return typeof at === 'string' ? at : undefined;
  } catch {
    return undefined;
  }
}

const spendOf = (s: OldRun<unknown>['summary']) => ({ usd: s?.spentUsd ?? 0, newCalls: s?.newCalls ?? 0, cachedCalls: s?.cachedCalls ?? 0 });

/** A model answer that never happened because the spend cap was reached. It is no result. */
const notRun = (r: OldPlacementResult) => !r.metrics && /^(skipped|stopped): budget/.test(r.error ?? '');

export function upgradePlacementRun(raw: unknown, ctx: { id: string; dir: string }): RunFile | null {
  const old = raw as OldRun<OldPlacementResult>;
  if (!Array.isArray(old?.results) || !old.summary) return null;
  const all = old.results;
  const kept = all.filter((r) => !notRun(r));

  const cases: CaseRecord[] = [];
  for (const id of new Set(all.map((r) => r.case))) {
    const r = all.find((x) => x.case === id)!;
    const key = slug(id);
    const has = (rel: string) => existsSync(path.join(ctx.dir, rel));
    const artifacts: Record<string, string> = {};
    if (has(`overlays/${key}.jpg`)) artifacts.overlay = `overlays/${key}.jpg`;
    if (has(`inputs/${key}/turntable.jpg`)) artifacts.turntable = `inputs/${key}/turntable.jpg`;
    cases.push({
      id,
      title: r.objectName,
      group: r.worldTitle,
      dims: { world: r.world, object: r.object, asset: r.asset, depth: r.depth ?? 'moge2' },
      revision: r.maskVersion ?? 1,
      noteKeys: [`${r.world}/${r.object}/${r.asset}`, `${r.world}/${r.object}`],
      artifacts,
    });
  }

  const methods = new Map<string, MethodSpec>();
  const results: ResultRecord[] = kept.map((r) => {
    const spec = methodSpec(r.method, r.llm);
    methods.set(spec.id, spec);
    const m = r.metrics;
    const rationale = typeof r.details?.rationale === 'string' ? r.details.rationale : undefined;
    return {
      case: r.case,
      method: spec.id,
      scores: m
        ? {
          iou: finite(m.iou), colorErr: finite(m.colorErr), depthErr: finite(m.depthErr), gapCm: finite(m.contactGapM * 100), tiltDeg: finite(m.tiltDeg),
          ...(r.yawVsFitter !== undefined ? { yawVsFitter: finite(r.yawVsFitter) } : {}),
        }
        : {},
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      ...(r.calls !== undefined ? { calls: r.calls } : {}),
      ...(r.cachedCalls !== undefined ? { cachedCalls: r.cachedCalls } : {}),
      ...(rationale ? { note: rationale } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.details || r.placement ? { details: { ...r.details, ...(r.placement ? { placement: r.placement } : {}) } } : {}),
    };
  });

  return {
    format: 2,
    id: ctx.id,
    task: taskInfo(PLACEMENT_SPEC),
    startedAt: startedAtOf(ctx.dir),
    finishedAt: old.summary.finishedAt,
    config: old.config ?? {},
    methods: sortMethods([...methods.values()]),
    cases,
    results,
    spend: spendOf(old.summary),
    skipped: old.summary.missing ?? [],
  };
}

interface OldAssetResult {
  case: string;
  world?: string;
  worldTitle?: string;
  object?: string;
  objectName?: string;
  asset?: string;
  maskVersion?: number;
  judgement?: { verdict: string; foreignShare: number; findings: { what: string; severity?: string; yaws?: number[] }[]; rationale: string };
  sheet?: string;
  costUsd?: number;
  cached?: boolean;
  latencyMs?: number;
  error?: string;
}

export function upgradeAssetRun(raw: unknown, ctx: { id: string; dir: string }): RunFile | null {
  const old = raw as OldRun<OldAssetResult>;
  if (!Array.isArray(old?.results) || !old.summary) return null;
  const method = checkMethod(old.config?.model ?? 'muse-spark-1.3');

  const cases: CaseRecord[] = old.results.map((r) => {
    // A result that failed before it had a name only carries the case id: world/object/asset.
    const [world, object, asset] = r.case.split('/');
    const artifacts: Record<string, string> = {};
    if (r.sheet) artifacts.sheet = r.sheet;
    return {
      id: r.case,
      title: r.objectName ?? object ?? r.case,
      group: r.worldTitle ?? world,
      dims: { world: r.world ?? world ?? '', object: r.object ?? object ?? '', asset: r.asset ?? asset ?? '' },
      revision: r.maskVersion ?? 1,
      artifacts,
    };
  });

  const results: ResultRecord[] = old.results.map((r) => {
    const j = r.judgement;
    const scores: Scores = j ? { foreignShare: finite(j.foreignShare) } : {};
    return {
      case: r.case,
      method: checkMethodId(method.subject!),
      scores,
      ...(j ? { label: j.verdict, calls: 1, cachedCalls: r.cached ? 1 : 0, note: j.rationale || undefined, details: { findings: asFindings(j.findings), rationale: j.rationale, sheet: r.sheet } } : {}),
      costUsd: r.costUsd ?? 0,
      latencyMs: r.latencyMs ?? 0,
      ...(r.error ? { error: r.error } : {}),
    };
  });

  return {
    format: 2,
    id: ctx.id,
    task: taskInfo(ASSET_CHECK_SPEC),
    startedAt: startedAtOf(ctx.dir),
    finishedAt: old.summary.finishedAt,
    config: old.config ?? {},
    methods: [method],
    cases,
    results,
    spend: spendOf(old.summary),
    skipped: [],
  };
}
