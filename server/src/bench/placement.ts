// Placement benchmark: Muse Spark vs. Muse Wonder vs. the geometric fitter, on worlds that are already
// built. Every case reuses the world's existing masks, depth and 3D assets (one per model, generated
// once); the only paid calls are the language-model calls, and those are cached by content.
//
// This is the application's side of the metrics framework (@wom/metrics): the task says what a case is
// and how a placement is scored, and the subjects (the geometric fitter, a Muse model) answer. Running,
// storing, budgets and the dashboard are the framework's.
//
// A case is one object × one asset model × one depth model. Methods per case:
//   fitter           the compose fitter (view-aligned, ±20° pitch, distance from depth)
//   fitter-grounded  the same search kept upright along gravity, then scaled about the camera so the base
//                    pivot rests on the ground plane (same silhouette): the geometric answer in the
//                    terms the models use
//   direct           one structured answer from the model; its base point is put on the ground plane
//   direct+defer     what the model deferred decided by the fitter, the rest fixed to its answer
//   direct→fit       fitter-grounded searching only ±30° around the model's yaw
//   agent            the model with tools (render_placement, auto_fit = fitter-grounded, measure_depth)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  defineSubject, defineTask, errorMessage, isNum, slug,
  pairedStat, type Annotation, type Answer, type Case, type CaseView, type HeatTable, type Insight, type MethodSpec, type PairedStat, type Scores, type Subject, type TaskInfo,
} from '@wom/metrics';
import { WORLDS_DIR } from '../config.ts';
import { angleDiff, type Placement } from '../geometry/pose.ts';
import type { Pose } from '../geometry/raster.ts';
import { MODEL_LABELS, type DepthModel, type MeshModel, type PlannerModel } from '../types.ts';
import { BENCH_DIR } from './cache.ts';
import { ASSET_MODELS, DEPTH_MODELS } from './catalog.ts';
import { CaseRunner } from './case.ts';
import { loadAsset, loadBenchWorld, projectToGrid, type BenchAsset, type BenchObject, type BenchWorld } from './context.ts';
import { upgradePlacementRun } from './legacy.ts';
import { agentPlacement, directPlacement, type Effort, type PlacementTask } from './llm.ts';
import { evaluatePlacement } from './metrics.ts';
import { contactSheet, renderOverlay } from './render.ts';
import { BASELINE_ID, methodId, methodSpec, parseMethodId, PLACEMENT_SPEC, shortModel, type PlacementKind, type Protocol } from './spec.ts';

export type { Protocol };

/** What the subjects share about a case. */
export interface PlacementData {
  runner: CaseRunner;
  /** What the models are shown (the photo, the turntable) and the tools that act on the case; made once. */
  input?: Promise<PlacementTask>;
  /** The grounded fitter's answer, which the baseline and the refined methods build on; made once. */
  grounded?: ReturnType<CaseRunner['fitGrounded']>;
}

/** A placement as a pose, with the name its overlay is captioned with. */
export interface PlacementAnswer {
  pose: Pose;
  title: string;
}

export const modelInput = (d: PlacementData) => (d.input ??= d.runner.task());
export const groundedFit = (d: PlacementData) => (d.grounded ??= d.runner.fitGrounded());

const finite = (v: number) => (Number.isFinite(v) ? v : null);

// ---------- the task ----------

export function listBenchWorlds(): string[] {
  if (!existsSync(WORLDS_DIR)) return [];
  return readdirSync(WORLDS_DIR).filter((id) => existsSync(path.join(WORLDS_DIR, id, 'scene.json')));
}

/**
 * Human notes on cases, in data/bench/annotations.json, keyed "<world>/<object>" (every asset) or
 * "<world>/<object>/<asset>". `exclude` keeps a case out of the summary table (it stays in the details),
 * e.g. when the SAM mask covers the wrong object and IoU against it is meaningless. `maskVersion` limits a
 * note to that mask of the object (a bad mask that was redone later).
 */
type AnnotationFile = Record<string, { exclude?: boolean; note?: string; maskVersion?: number }>;

export function loadAnnotations(): Record<string, Annotation> {
  const file = path.join(BENCH_DIR, 'annotations.json');
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8')) as AnnotationFile;
  return Object.fromEntries(Object.entries(raw).map(([key, a]) => [key, { exclude: a.exclude, note: a.note, revision: a.maskVersion }]));
}

/** Every model-only placement misses the mask while the fitter matches it: the mask may be on the wrong thing. */
const MASK_WARNING = 'Every model-only placement misses the mask while the fitter matches it; the mask may cover the wrong object.';

export const placementTask = defineTask<PlacementData, PlacementAnswer>({
  ...PLACEMENT_SPEC,

  async cases(selection) {
    const worlds = selection.worlds?.length ? selection.worlds : listBenchWorlds();
    const assets = (selection.assets?.length ? selection.assets : ['idol']) as MeshModel[];
    const cases: Case<PlacementData>[] = [];
    const missing = new Set<string>();
    for (const wid of worlds) {
      let first: BenchWorld;
      try {
        first = await loadBenchWorld(wid);
      } catch (err) {
        missing.add(`${wid} (${errorMessage(err)})`);
        continue;
      }
      const depths = (selection.depths?.length ? selection.depths : [first.depthModel]) as DepthModel[];
      for (const depth of depths) {
        let world: BenchWorld;
        try {
          world = depth === first.depthModel ? first : await loadBenchWorld(wid, depth);
        } catch (err) {
          missing.add(`${wid} @${depth} (${errorMessage(err)})`);
          continue;
        }
        for (const obj of world.objects) {
          if (selection.objects?.length && !selection.objects.includes(obj.id)) continue;
          for (const model of assets) {
            const rec = obj.assets.find((a) => a.model === model);
            if (!rec) {
              missing.add(`${wid}/${obj.id}/${model}`);
              continue;
            }
            cases.push(caseOf(world, obj, await loadAsset(world, rec)));
          }
        }
      }
    }
    return { cases, skipped: [...missing] };
  },

  async score(c, a) {
    const { runner } = c.data;
    const { world, obj, asset } = runner;
    const m = evaluatePlacement(world, obj, asset, a.pose);
    const pl = runner.placementOf(a.pose);
    const [x, y] = projectToGrid(world, pl.base);
    const overlay = await renderOverlay(world, obj, asset, a.pose, {
      title: a.title,
      subtitle: `IoU ${m.iou.toFixed(2)} · yaw ${m.yawDeg.toFixed(0)}° · ${m.heightM.toFixed(2)} m · gap ${(m.contactGapM * 100).toFixed(0)} cm`,
    });
    return {
      scores: { iou: finite(m.iou), colorErr: finite(m.colorErr), depthErr: finite(m.depthErr), gapCm: finite(m.contactGapM * 100), tiltDeg: finite(m.tiltDeg) },
      details: { placement: { yawDeg: pl.yawDeg, heightM: pl.heightM, pitchDeg: pl.pitchDeg, rollDeg: pl.rollDeg, base: pl.base, grid: { x, y } } },
      images: { overlay },
    };
  },

  async finish(c, scored, ctx) {
    const key = slug(c.id);
    // What the models were shown is kept with the run, whether or not a model ran.
    const input = await modelInput(c.data);
    await ctx.write(`inputs/${key}/photo.jpg`, input.photo);
    const turntable = await ctx.write(`inputs/${key}/turntable.jpg`, input.turntable);
    const artifacts: Record<string, string> = { turntable };
    // Every answer is in: the pictures need not stay in memory for the rest of a long run.
    c.data.input = undefined;

    const overlays = scored.flatMap((s) => s.outcome.images?.overlay ?? []);
    if (overlays.length) artifacts.overlay = await ctx.write(`overlays/${key}.jpg`, await contactSheet(overlays, Math.min(4, overlays.length)));

    // How much each method's facing disagrees with the free geometric answer.
    const yawOf = (s: (typeof scored)[number]) => (s.outcome.details?.placement as { yawDeg?: number } | undefined)?.yawDeg;
    const base = scored.find((s) => s.answer.method === BASELINE_ID);
    const baseYaw = base ? yawOf(base) : undefined;
    const scores: Record<string, Scores> = {};
    if (isNum(baseYaw)) {
      for (const s of scored) {
        const yaw = yawOf(s);
        if (s.answer.method !== BASELINE_ID && isNum(yaw)) scores[s.answer.method] = { yawVsFitter: angleDiff(yaw, baseYaw) };
      }
    }
    return { artifacts, scores };
  },

  annotations: loadAnnotations,

  caseNote(_c, results) {
    const fitter = results.find((r) => r.method === 'fitter')?.scores.iou ?? 0;
    const own = results.filter((r) => /^(direct|agent):/.test(r.method)).map((r) => r.scores.iou).filter(isNum);
    return fitter > 0.5 && own.length > 0 && Math.max(...own) < 0.05 ? MASK_WARNING : undefined;
  },

  extras(view) {
    const tables = assetTables(view.cases.filter((c) => !c.excluded));
    const notes = behaviour(view);
    return {
      tables,
      tablesTitle: '3D models and depth models',
      tablesCaption: 'IoU of the fitter, with the grounded fitter\'s after the slash, for each 3D model and depth model on the same objects. New worlds take their models from Settings on the home page.',
      notes,
      notesTitle: 'Do the models hand placement to geometry?',
      notesCaption: 'How each model chose between its own answer and the fitter, from the answers in this run.',
      insights: insightsOf(view),
    };
  },

  upgrade: upgradePlacementRun,
});

function caseOf(world: BenchWorld, obj: BenchObject, asset: BenchAsset): Case<PlacementData> {
  const runner = new CaseRunner(world, obj, asset);
  return {
    id: `${runner.label}@${world.depthModel}`,
    title: obj.name,
    group: world.title,
    dims: { world: world.id, object: obj.id, asset: asset.model, depth: world.depthModel },
    revision: obj.maskVersion,
    noteKeys: [runner.label, `${world.id}/${obj.id}`],
    data: { runner },
  };
}

// ---------- extras: tables and remarks drawn from a run ----------

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const iouOf = (c: CaseView, method: string) => {
  const v = c.results.find((r) => r.method === method)?.scores.iou;
  return isNum(v) ? v : null;
};

/**
 * The geometric placement of every asset × depth combination, per world, so asset and depth models can
 * be compared on the same objects. Only for runs with more than one asset or depth model.
 */
function assetTables(cases: CaseView[]): HeatTable[] {
  const rowKey = (c: CaseView) => `${c.dims.asset} @${c.dims.depth ?? 'moge2'}`;
  if (new Set(cases.map(rowKey)).size < 2) return [];
  const tables: HeatTable[] = [];
  for (const world of [...new Set(cases.map((c) => c.dims.world))]) {
    const rs = cases.filter((c) => c.dims.world === world);
    const objects = [...new Map(rs.map((c) => [c.dims.object, c.title])).entries()].map(([id, label]) => ({ id, label }));
    const avg = (xs: (number | null)[]) => (xs.every((x) => x !== null) ? mean(xs as number[]) : null);
    tables.push({
      id: world,
      title: rs[0].group ?? world,
      columns: objects,
      rows: [...new Set(rs.map(rowKey))].sort().map((key) => {
        const [asset, depth] = key.split(' @');
        const cells = objects.map((o) => {
          const c = rs.find((x) => rowKey(x) === key && x.dims.object === o.id);
          return { value: c ? iouOf(c, 'fitter') : null, secondary: c ? iouOf(c, BASELINE_ID) : null };
        });
        return {
          id: key,
          label: ASSET_MODELS[asset as MeshModel]?.label ?? asset,
          sub: DEPTH_MODELS[depth as DepthModel]?.label ?? depth,
          cells,
          total: { value: avg(cells.map((c) => c.value)), secondary: avg(cells.map((c) => c.secondary)) },
        };
      }),
    });
  }
  return tables;
}

/**
 * What only this task can say: model answers used as given miss the mask, and the fitter finishing the job
 * around the model's facing brings them back. Compared with the free baseline on the cases both ran.
 */
function insightsOf(view: { task: TaskInfo; methods: MethodSpec[]; cases: CaseView[]; summary: { method: string; split?: string }[] }): Insight[] {
  const splits = [...new Set(view.summary.map((r) => r.split))];
  const rows = (kind: PlacementKind) => view.methods
    .filter((m) => parseMethodId(m.id)?.kind === kind)
    .flatMap((m) => splits.map((split) => pairedStat(view.task, view.cases, m.id, BASELINE_ID, 'iou', split)))
    .filter((p): p is PairedStat => p !== undefined && p.n >= 3);
  const direct = rows('direct'), refined = rows('direct→fit');
  if (!direct.length || !refined.length || !direct.every((p) => p.improvement < -0.05)) return [];
  const ious = direct.map((p) => p.mean);
  const base = mean(direct.map((p) => p.base))!;
  const gap = Math.ceil(Math.max(...refined.map((p) => Math.abs(p.improvement))) * 100) / 100;
  const lo = Math.min(...ious).toFixed(2), hi = Math.max(...ious).toFixed(2);
  return [{
    tone: 'info',
    text: `Model answers used as given miss the mask (**IoU ${lo === hi ? lo : `${lo}–${hi}`}** against ${base.toFixed(2)} for the grounded fitter on the same cases). When the fitter finishes the job around the model's facing (Direct → fit), they land within ${gap.toFixed(2)} of it.`,
  }];
}

/** How each model chose between its own answer and the fitter: one line per model and protocol. Every case counts, left-out ones too. */
function behaviour(view: { methods: { id: string; subject?: string }[]; cases: CaseView[] }): string[] {
  const f = (v: number | null, d = 2) => (v === null ? '–' : v.toFixed(d));
  const models = [...new Set(view.methods.filter((m) => m.subject).map((m) => m.subject!))];
  const results = view.cases.flatMap((c) => c.results);
  const lines: string[] = [];
  for (const model of models) {
    const d = results.filter((r) => r.method === methodId('direct', model) && r.details);
    if (d.length) {
      const defer = { position: 0, scale: 0, yaw: 0 };
      const pref: Record<string, number> = {};
      const conf = { position: [] as number[], scale: [] as number[], yaw: [] as number[] };
      for (const r of d) {
        const det = r.details as { defer: typeof defer; preference: string; confidence: Record<keyof typeof conf, number> };
        for (const k of Object.keys(defer) as (keyof typeof defer)[]) defer[k] += det.defer[k] ? 1 : 0;
        pref[det.preference] = (pref[det.preference] ?? 0) + 1;
        for (const k of Object.keys(conf) as (keyof typeof conf)[]) conf[k].push(det.confidence[k]);
      }
      lines.push(`${model}, direct (${d.length} answers): deferred position ${defer.position}, scale ${defer.scale}, yaw ${defer.yaw}. Preference: ${Object.entries(pref).map(([k, v]) => `${k} ${v}`).join(', ')}. Mean confidence: position ${f(mean(conf.position))}, scale ${f(mean(conf.scale))}, yaw ${f(mean(conf.yaw))}.`);
    }
    const g = results.filter((r) => r.method === methodId('agent', model) && r.details);
    if (g.length) {
      const tools: Record<string, number> = {};
      const src: Record<string, number> = {};
      let usedFit = 0;
      for (const r of g) {
        const det = r.details as { tools: Record<string, number>; source?: string };
        for (const [k, v] of Object.entries(det.tools)) tools[k] = (tools[k] ?? 0) + v;
        src[det.source ?? 'none'] = (src[det.source ?? 'none'] ?? 0) + 1;
        if (det.tools.auto_fit) usedFit++;
      }
      lines.push(`${model}, agent (${g.length} runs): called auto_fit in ${usedFit}. Tool calls: ${Object.entries(tools).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}. Declared source: ${Object.entries(src).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    }
  }
  return lines;
}

// ---------- subjects ----------

/** The geometric fitter: free, and the reference the model-based methods are compared with. */
export const geometrySubject: Subject<PlacementData, PlacementAnswer> = defineSubject<PlacementData, PlacementAnswer>({
  id: 'geometry',
  label: 'Geometric fitter',
  methods: [methodSpec('fitter'), methodSpec('fitter-grounded')],
  async solve(c) {
    const classic = c.data.runner.fitClassic();
    const grounded = groundedFit(c.data);
    return [
      {
        method: 'fitter',
        answer: classic.fit ? { pose: classic.fit.pose, title: 'fitter' } : undefined,
        latencyMs: classic.ms,
        error: classic.fit ? undefined : 'no fit',
      },
      {
        method: BASELINE_ID,
        answer: grounded.pose ? { pose: grounded.pose, title: BASELINE_ID } : undefined,
        latencyMs: grounded.ms,
        error: grounded.pose ? undefined : 'no fit',
        details: { groundingScale: grounded.factor },
      },
    ];
  },
});

/** The model could not be asked, because the spend cap was reached (for example with `--cached-only`). */
const budgetStop = (error: string | undefined) => /^(skipped|stopped): budget/.test(error ?? '');

export interface MuseOptions {
  protocols: Protocol[];
  effort: Effort;
}

/**
 * A Muse model as a placer: `direct` (one structured answer, then the same answer finished by the fitter in
 * two ways) and `agent` (a tool loop that renders and scores placements, may call the fitter, then submits).
 */
export function museSubject(model: string, o: MuseOptions): Subject<PlacementData, PlacementAnswer> {
  const short = model.replace(/^muse-/, '');
  const id = (kind: Parameters<typeof methodId>[0]) => methodId(kind, model);
  const methods = [
    ...(o.protocols.includes('direct') ? [methodSpec('direct', model), methodSpec('direct+defer', model), methodSpec('direct→fit', model)] : []),
    ...(o.protocols.includes('agent') ? [methodSpec('agent', model)] : []),
  ];

  return defineSubject<PlacementData, PlacementAnswer>({
    id: model,
    label: MODEL_LABELS[model as PlannerModel] ?? model,
    methods,
    async solve(c, ctx) {
      const { runner } = c.data;
      const input = await modelInput(c.data);
      const opts = { spend: ctx.spend, fresh: ctx.fresh, effort: o.effort };
      const jobs: Promise<Answer<PlacementAnswer>[]>[] = [];

      if (o.protocols.includes('direct')) {
        jobs.push((async (): Promise<Answer<PlacementAnswer>[]> => {
          const d = await directPlacement(input, model, opts);
          const a = d.answer;
          if (!d.placement && budgetStop(d.info.error)) return [{ method: id('direct'), skipped: true }];
          const direct: Answer<PlacementAnswer> = {
            method: id('direct'),
            answer: d.placement ? { pose: runner.pose(d.placement), title: `${short} direct` } : undefined,
            costUsd: d.info.costUsd,
            latencyMs: d.info.latencyMs,
            calls: d.info.calls,
            cachedCalls: d.info.cachedCalls,
            error: d.info.error,
            note: a?.rationale,
            details: a ? {
              defer: a.defer, preference: a.preference, confidence: a.confidence, rationale: a.rationale, observations: a.observations,
              answer: { base_point: a.base_point, height_m: a.height_m, yaw_deg: a.yaw_deg, pitch_deg: a.pitch_deg, roll_deg: a.roll_deg },
            } : undefined,
          };
          if (a && !d.placement) direct.error ??= 'base point does not reach the ground';
          if (!d.placement || !a) return [direct];

          // What the model deferred is decided by the fitter; what it kept stays fixed (its yaw is held
          // during the fit unless it deferred yaw too).
          let mixed: Placement = d.placement;
          let deferMs = 0;
          if (a.defer.position || a.defer.scale) {
            const f = runner.fitGrounded(a.defer.yaw ? undefined : a.yaw_deg, a.defer.yaw ? undefined : 0);
            deferMs = f.ms;
            if (f.pose) {
              const fp = runner.placementOf(f.pose);
              mixed = {
                ...d.placement,
                base: a.defer.position ? fp.base : d.placement.base,
                heightM: a.defer.scale ? fp.heightM : d.placement.heightM,
                yawDeg: a.defer.yaw ? fp.yawDeg : d.placement.yawDeg,
              };
            }
          } else if (a.defer.yaw) {
            const grounded = groundedFit(c.data);
            if (grounded.pose) mixed = { ...d.placement, yawDeg: runner.placementOf(grounded.pose).yawDeg };
          }
          const deferred: Answer<PlacementAnswer> = {
            method: id('direct+defer'),
            answer: { pose: runner.pose(mixed), title: `${short} direct+defer` },
            latencyMs: deferMs,
            details: { defer: a.defer, preference: a.preference },
          };

          // The model's yaw as the centre of a narrow geometric search.
          const refined = runner.fitGrounded(a.yaw_deg, 30);
          const fitted: Answer<PlacementAnswer> = {
            method: id('direct→fit'),
            answer: refined.pose ? { pose: refined.pose, title: `${short} direct→fit` } : undefined,
            latencyMs: refined.ms,
            error: refined.pose ? undefined : 'no fit',
          };
          return [direct, deferred, fitted];
        })().catch((err): Answer<PlacementAnswer>[] => [{ method: id('direct'), error: errorMessage(err) }]));
      }

      if (o.protocols.includes('agent')) {
        jobs.push((async (): Promise<Answer<PlacementAnswer>[]> => {
          const g = await agentPlacement(input, model, opts);
          if (!g.placement && budgetStop(g.info.error)) return [{ method: id('agent'), skipped: true }];
          const tools: Record<string, number> = {};
          for (const s of g.steps) tools[s.tool] = (tools[s.tool] ?? 0) + 1;
          return [{
            method: id('agent'),
            answer: g.placement ? { pose: runner.pose(g.placement), title: `${short} agent` } : undefined,
            costUsd: g.info.costUsd,
            latencyMs: g.info.latencyMs,
            calls: g.info.calls,
            cachedCalls: g.info.cachedCalls,
            error: g.info.error,
            note: g.submitted?.rationale,
            details: {
              tools,
              source: g.submitted?.source,
              rationale: g.submitted?.rationale,
              steps: g.steps.map((s) => ({ tool: s.tool, args: s.args, result: s.result })),
            },
          }];
        })().catch((err): Answer<PlacementAnswer>[] => [{ method: id('agent'), error: errorMessage(err) }]));
      }

      return (await Promise.all(jobs)).flat();
    },
  });
}
