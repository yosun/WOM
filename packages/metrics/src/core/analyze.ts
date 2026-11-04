// The arithmetic of a run, shared by the server (reports, run views) and the dashboard. Pure functions
// over the types in types.ts, so every figure can be checked against the data in a script.
//
// One rule runs through it: methods are compared on the cases they share. A model costs money, so it is
// often run on fewer cases than a free solver; a mean over "all the cases a method ran" then compares
// different objects. `paired` is the mean over the cases a method and the baseline both ran.
import type { Agreement, CaseRecord, CaseView, LabelSpec, MetricSpec, MethodSpec, ResultRecord, Scores, SummaryRow, TaskInfo } from './types.ts';

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

export function aggregate(values: (number | null | undefined)[], how: MetricSpec['aggregate'] = 'mean'): number | null {
  const xs = values.filter(isNum);
  if (how === 'meanAbs') return mean(xs.map(Math.abs));
  if (how === 'median') return median(xs);
  if (how === 'medianAbs') return median(xs.map(Math.abs));
  return mean(xs);
}

// ---------- notes written by people ----------

/** A human note on a case or group of cases: an exclusion, a remark, or what the verdict should be. */
export interface Annotation {
  /** Keep the case out of the summary (it stays in the details). */
  exclude?: boolean;
  note?: string;
  /** For verdict tasks: what the verdict should be. */
  expected?: string;
  /** Applies only to this revision of what the case is about. */
  revision?: number;
}

/**
 * The first note whose key the case names (its id, unless it lists `noteKeys`). A note for another
 * revision does not apply, and neither does a note under a later key.
 */
export function annotationFor(c: Pick<CaseRecord, 'id' | 'noteKeys' | 'revision'>, notes: Record<string, Annotation>): Annotation | undefined {
  for (const key of c.noteKeys?.length ? c.noteKeys : [c.id]) {
    const a = notes[key];
    if (a) return a.revision === undefined || a.revision === (c.revision ?? 1) ? a : undefined;
  }
  return undefined;
}

// ---------- which results count ----------

/** A result that carries a score or a verdict, as opposed to one that failed. */
export const isScored = (r: Pick<ResultRecord, 'scores' | 'label'>) => r.label !== undefined || Object.values(r.scores).some(isNum);

/** True when `a` is a better value of the metric than `b`. */
export const betterThan = (metric: Pick<MetricSpec, 'better'>, a: number, b: number) => (metric.better === 'higher' ? a > b : a < b);

export function metricOf(task: Pick<TaskInfo, 'metrics'>, id: string): MetricSpec {
  const m = task.metrics.find((x) => x.id === id);
  if (!m) throw new Error(`the task has no metric ${id}`);
  return m;
}

/** Methods in the order tables show them: by `order`, then as declared. */
export function sortMethods(methods: MethodSpec[]): MethodSpec[] {
  return methods.map((m, i) => ({ m, i })).sort((a, b) => (a.m.order ?? 0) - (b.m.order ?? 0) || a.i - b.i).map((x) => x.m);
}

// ---------- the summary table ----------

/** The values of the task's `splitBy` dimension in a run, when there are several of them. */
export function splitValues(task: TaskInfo, cases: CaseRecord[]): string[] {
  if (!task.splitBy) return [];
  const values = [...new Set(cases.map((c) => c.dims[task.splitBy!]).filter((v): v is string => Boolean(v)))].sort();
  return values.length > 1 ? values : [];
}

/**
 * One row per method (and per value of the split dimension), over the cases not marked as excluded.
 * `wins` counts the cases where a method had the best primary score of all the methods.
 */
export function summarize(task: TaskInfo, methods: MethodSpec[], cases: CaseRecord[], results: ResultRecord[], excluded: Set<string>): SummaryRow[] {
  const primary = metricOf(task, task.primary);
  const caseById = new Map(cases.map((c) => [c.id, c]));
  const kept = results.filter((r) => !excluded.has(r.case));
  const splits = splitValues(task, cases);
  const splitOf = (r: ResultRecord) => (splits.length ? caseById.get(r.case)?.dims[task.splitBy!] : undefined);

  const best = new Map<string, number>();
  for (const r of kept) {
    const v = r.scores[primary.id];
    if (!isScored(r) || !isNum(v)) continue;
    const b = best.get(r.case);
    if (b === undefined || betterThan(primary, v, b)) best.set(r.case, v);
  }

  const rows: SummaryRow[] = [];
  for (const method of sortMethods(methods)) {
    for (const split of splits.length ? splits : [undefined]) {
      const rs = kept.filter((r) => r.method === method.id && splitOf(r) === split);
      if (!rs.length) continue;
      const ok = rs.filter(isScored);
      const scores: Scores = {};
      for (const m of task.metrics) scores[m.id] = aggregate(ok.map((r) => r.scores[m.id]), m.aggregate);
      const timed = rs.filter((r) => r.latencyMs > 0);
      rows.push({
        method: method.id,
        split,
        n: ok.length,
        failed: rs.length - ok.length,
        scores,
        wins: ok.filter((r) => {
          const v = r.scores[primary.id];
          const b = best.get(r.case);
          return isNum(v) && b !== undefined && Math.abs(v - b) <= 1e-9;
        }).length,
        costUsd: rs.reduce((a, r) => a + r.costUsd, 0),
        latencyS: timed.length ? timed.reduce((a, r) => a + r.latencyMs / 1000, 0) / timed.length : null,
      });
    }
  }
  return rows;
}

// ---------- comparing with the baseline on shared cases ----------

export interface PairedStat {
  n: number;
  /** The method's mean score on the shared cases. */
  mean: number;
  /** The baseline's mean score on the same cases. */
  base: number;
  /** How much better the method is than the baseline: positive is better, whichever way the metric points. */
  improvement: number;
  wins: number;
  ties: number;
  losses: number;
}

/** The method against the baseline on the cases both have a score for. `split` limits it to one value of the split dimension. */
export function pairedStat(task: TaskInfo, cases: CaseView[], method: string, base: string, metricId = task.primary, split?: string): PairedStat | undefined {
  const metric = metricOf(task, metricId);
  const pairs: [number, number][] = [];
  for (const c of cases) {
    if (c.excluded || (split !== undefined && c.dims[task.splitBy ?? ''] !== split)) continue;
    const a = c.results.find((r) => r.method === method)?.scores[metricId];
    const b = c.results.find((r) => r.method === base)?.scores[metricId];
    if (isNum(a) && isNum(b)) pairs.push([a, b]);
  }
  if (!pairs.length) return undefined;
  const n = pairs.length;
  const m = pairs.reduce((s, p) => s + p[0], 0) / n, b = pairs.reduce((s, p) => s + p[1], 0) / n;
  const sign = metric.better === 'higher' ? 1 : -1;
  const wins = pairs.filter(([x, y]) => sign * (x - y) > task.tie).length;
  const losses = pairs.filter(([x, y]) => sign * (y - x) > task.tie).length;
  return { n, mean: m, base: b, improvement: sign * (m - b), wins, ties: n - wins - losses, losses };
}

// ---------- verdicts against what a person said ----------

/** The answers' verdicts against the expected ones. Labels run from the most severe to the cleanest. */
export function agreementOf(labels: LabelSpec[], cases: CaseView[]): Agreement | undefined {
  if (labels.length < 2) return undefined;
  const ids = labels.map((l) => l.id);
  const matrix: Agreement['matrix'] = Object.fromEntries(ids.map((e) => [e, Object.fromEntries(ids.map((j) => [j, 0]))]));
  let labelled = 0, exact = 0;
  for (const c of cases) {
    const judged = c.results.find((r) => r.label !== undefined)?.label;
    if (!c.expected || judged === undefined || !matrix[c.expected] || matrix[c.expected][judged] === undefined) continue;
    matrix[c.expected][judged]++;
    labelled++;
    if (c.expected === judged) exact++;
  }
  const severe = ids[0], clean = ids[ids.length - 1];
  const sum = (row: Record<string, number>) => Object.values(row).reduce((a, b) => a + b, 0);
  return {
    matrix,
    labelled,
    exact,
    severe: { total: sum(matrix[severe]), caught: matrix[severe][severe] },
    clean: { total: sum(matrix[clean]), flagged: sum(matrix[clean]) - matrix[clean][clean] },
  };
}

// ---------- showing a score ----------

export function formatScore(metric: Pick<MetricSpec, 'digits' | 'unit' | 'format'>, v: number | null | undefined, withUnit = false) {
  if (!isNum(v)) return '–';
  if (metric.format === 'percent') return `${(v * 100).toFixed(metric.digits ?? 0)}%`;
  // A small negative number that rounds to nothing is zero, not "-0".
  const s = v.toFixed(metric.digits ?? 2).replace(/^-(0(\.0+)?)$/, '$1');
  return withUnit && metric.unit ? `${s} ${metric.unit}` : s;
}
