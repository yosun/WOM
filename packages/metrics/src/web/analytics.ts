// Derived numbers for the dashboard. Pure functions over what the server sends (no DOM), so each figure on
// the page can be checked against the data in a script. Nothing here knows what a task measures: it reads the
// metrics, methods, families and dimensions each run carries.
//
// One rule runs through all of it: methods are compared on the cases they share. A model costs money, so it is
// often run on fewer cases than a free solver, and a mean over "all the cases a method ran" would compare
// different objects. `paired` is the mean over the cases a method and the baseline both ran.
import { betterThan, formatScore, isNum, mean, metricOf, pairedStat, type PairedStat } from '../core/analyze.ts';
import type {
  CaseView, DimensionSpec, FamilySpec, MethodSpec, MetricSpec, RunView, SpendSummary, SummaryRow, TaskInfo, Tone,
} from '../core/types.ts';
import type { DashboardInsight, InsightPart } from './host.ts';
import { fSigned, fx, plural, lower } from './format.ts';

/** A case whose best method is worse than this share of the metric's range counts as hard. */
export const HARD_GOODNESS = 0.6;

// ---------- reading a metric ----------

/** How good a score is, 0 (worst) to 1 (best), from the metric's range and which way it points. */
export function goodness(metric: MetricSpec, v: number | null | undefined): number | null {
  if (!isNum(v)) return null;
  const [lo, hi] = metric.range ?? [0, 1];
  const x = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0;
  return metric.better === 'higher' ? x : 1 - x;
}

/** Poor, fair or good: by the metric's thresholds when it has them, else by where it sits in its range. */
export function toneOf(metric: MetricSpec, v: number | null | undefined): Tone {
  if (!isNum(v)) return 'muted';
  const t = metric.thresholds;
  if (t) {
    return metric.better === 'higher' ? (v >= t.good ? 'good' : v >= t.fair ? 'fair' : 'poor') : v <= t.good ? 'good' : v <= t.fair ? 'fair' : 'poor';
  }
  const g = goodness(metric, v)!;
  return g >= 0.75 ? 'good' : g >= 0.5 ? 'fair' : 'poor';
}

// ---------- names ----------

export const valueLabel = (task: TaskInfo, dim: string, value: string) => task.dimensions.find((d) => d.id === dim)?.values?.[value]?.label ?? value;
export const familyOf = (task: TaskInfo, m: MethodSpec): FamilySpec | undefined => task.families.find((f) => f.id === m.family);
export const familyColor = (task: TaskInfo, m: MethodSpec) => familyOf(task, m)?.color ?? 'var(--muted)';

/** `Agent · Spark`, with the value of the split dimension when the run has several (`· MoGe-3`). */
export function methodLabel(task: TaskInfo, m: MethodSpec, split?: string) {
  return `${m.label}${m.subjectLabel ? ` · ${m.subjectLabel}` : ''}${split && task.splitBy ? ` · ${valueLabel(task, task.splitBy, split)}` : ''}`;
}

/** Dimension names with a count: `2 worlds`. */
export const countOf = (d: DimensionSpec, n: number) => plural(n, lower(d.label));

// ---------- one run ----------

/** Cases that count towards the summary: the ones nobody marked as unfit for scoring. */
export const keptCases = (run: RunView) => run.cases.filter((c) => !c.excluded);

export const baselineOf = (run: Pick<RunView, 'methods'>) => run.methods.find((m) => m.baseline);

export interface MethodStat {
  method: MethodSpec;
  row: SummaryRow;
  /** Cases the run scored for this row's split, which is how many it could have run on. */
  of: number;
  /** Against the baseline on the cases both ran. Missing for the baseline itself. */
  paired?: PairedStat;
  /** What the calls behind one case cost when they are paid for; 0 for a method without a subject; null when unknown. */
  usdPerCase: number | null;
  /** The method's time plus that of the method it is made from, for one case. */
  secPerCase: number | null;
}

function usdPerCase(m: MethodSpec, row: SummaryRow, rows: Map<string, SummaryRow>, paid: Map<string, SpendSummary['perCase'][number]>): number | null {
  if (!m.subject && !m.via) return 0;
  // A method made from another's answer costs what that answer cost.
  const source = m.via ?? m.id;
  const fresh = paid.get(source);
  if (fresh && fresh.cases > 0) return fresh.usdPerCase;
  // Without the ledger, only what this run itself paid; a run answered from the cache paid nothing.
  const own = rows.get(`${source}|${row.split ?? ''}`);
  return own && own.n > 0 && own.costUsd > 0 ? own.costUsd / own.n : null;
}

function secPerCase(m: MethodSpec, row: SummaryRow, rows: Map<string, SummaryRow>): number | null {
  if (!isNum(row.latencyS)) return null;
  if (m.via) {
    const source = rows.get(`${m.via}|${row.split ?? ''}`);
    return source && isNum(source.latencyS) ? row.latencyS + source.latencyS : null;
  }
  return row.latencyS;
}

export function methodStats(run: RunView, spend?: SpendSummary | null): MethodStat[] {
  const task = run.task;
  const kept = keptCases(run);
  const base = baselineOf(run);
  const rows = new Map(run.summary.map((r) => [`${r.method}|${r.split ?? ''}`, r]));
  const paid = new Map((spend?.perCase ?? []).map((p) => [p.method, p]));
  const stats: MethodStat[] = [];
  for (const row of run.summary) {
    const method = run.methods.find((m) => m.id === row.method);
    if (!method) continue;
    stats.push({
      method,
      row,
      of: kept.filter((c) => !row.split || c.dims[task.splitBy ?? ''] === row.split).length,
      paired: base && !method.baseline ? pairedStat(task, run.cases, method.id, base.id, task.primary, row.split) : undefined,
      usdPerCase: usdPerCase(method, row, rows, paid),
      secPerCase: secPerCase(method, row, rows),
    });
  }
  return stats;
}

export interface RunFacts {
  cases: number;
  scored: number;
  excluded: number;
  /** How many values each dimension takes among the scored cases; one-value dimensions that say little are left out. */
  counts: { dim: DimensionSpec; count: number }[];
}

export function runFacts(run: RunView): RunFacts {
  const kept = keptCases(run);
  const counts = run.task.dimensions
    .map((dim) => ({ dim, count: new Set(kept.map((c) => c.dims[dim.id]).filter(Boolean)).size }))
    .filter((x) => x.count > 1 || (x.count === 1 && x.dim.show === 'always'));
  return { cases: run.cases.length, scored: kept.length, excluded: run.cases.length - kept.length, counts };
}

/** The best primary score any method reached on a case, and which method. */
export function bestOfCase(task: TaskInfo, c: CaseView): { value: number | null; method: string | null } {
  const metric = metricOf(task, task.primary);
  let value: number | null = null, method: string | null = null;
  for (const r of c.results) {
    const v = r.scores[metric.id];
    if (isNum(v) && (value === null || betterThan(metric, v, value))) { value = v; method = r.method; }
  }
  return { value, method };
}

/** Scored cases where even the best method does badly, worst first. */
export function hardestCases(run: RunView, limit = 5) {
  const metric = metricOf(run.task, run.task.primary);
  return keptCases(run)
    .map((c) => ({ c, ...bestOfCase(run.task, c) }))
    .filter((x): x is { c: CaseView; value: number; method: string | null } => x.value !== null)
    .sort((a, b) => (goodness(metric, a.value) ?? 1) - (goodness(metric, b.value) ?? 1))
    .slice(0, limit);
}

/** What sets a case apart from the others, beside its title: the dimensions it always names, and those that vary in the run. */
export function caseDims(run: Pick<RunView, 'task' | 'cases'>, c: CaseView): string[] {
  return run.task.dimensions
    .filter((d) => {
      if (!c.dims[d.id] || d.show === 'never') return false;
      return d.show === 'always' || new Set(run.cases.map((x) => x.dims[d.id])).size > 1;
    })
    .map((d) => valueLabel(run.task, d.id, c.dims[d.id]));
}

/** The case's title and the dimensions it always names: `Red vintage bicycle (IDOL)`. */
export function caseName(task: TaskInfo, c: CaseView, all = false) {
  const named = task.dimensions
    .filter((d) => c.dims[d.id] && (all ? d.show !== 'never' : d.show === 'always'))
    .map((d) => valueLabel(task, d.id, c.dims[d.id]));
  return named.length ? `${c.title} (${named.join(', ')})` : c.title;
}

/** Columns of the case × method matrix: the methods the run has, in order. */
export const matrixMethods = (run: RunView) => run.methods.filter((m) => run.summary.some((s) => s.method === m.id));

// ---------- a dimension seen by several tasks ----------

export interface DimensionRow {
  value: string;
  label: string;
  priceUsd?: number;
  /** From the verdict task's run: how many cases got a verdict, how many of each, and the mean primary score. */
  verdicts?: { checked: number; byLabel: Record<string, number>; mean: number | null };
  /** From each metrics task's run: the baseline method's mean primary score on cases with this value. */
  scores: { task: TaskInfo; metric: MetricSpec; method: MethodSpec; mean: number | null; n: number }[];
}

/**
 * One row per value of a dimension, with what each task found about it. This is how a 3D model that places
 * well but is often unclean shows up: the placement task and the asset check meet on the model.
 */
export function dimensionRows(dim: DimensionSpec, verdictRun: RunView | null, metricRuns: RunView[]): DimensionRow[] {
  const values = new Set<string>();
  for (const run of [verdictRun, ...metricRuns]) for (const c of run?.cases ?? []) if (c.dims[dim.id]) values.add(c.dims[dim.id]);
  const rows: DimensionRow[] = [];
  for (const value of values) {
    const row: DimensionRow = { value, label: dim.values?.[value]?.label ?? value, priceUsd: dim.values?.[value]?.priceUsd, scores: [] };
    if (verdictRun) {
      const judged = verdictRun.cases.filter((c) => c.dims[dim.id] === value).map((c) => c.results.find((r) => r.label !== undefined)).filter((r) => r !== undefined);
      const byLabel: Record<string, number> = {};
      for (const r of judged) byLabel[r.label!] = (byLabel[r.label!] ?? 0) + 1;
      row.verdicts = { checked: judged.length, byLabel, mean: mean(judged.map((r) => r.scores[verdictRun.task.primary]).filter(isNum)) };
    }
    for (const run of metricRuns) {
      const base = baselineOf(run);
      if (!base) continue;
      const placed = keptCases(run).filter((c) => c.dims[dim.id] === value);
      const xs = placed.map((c) => c.results.find((r) => r.method === base.id)?.scores[run.task.primary]).filter(isNum);
      row.scores.push({ task: run.task, metric: metricOf(run.task, run.task.primary), method: base, mean: mean(xs), n: xs.length });
    }
    rows.push(row);
  }
  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

// ---------- what the numbers say ----------

const B = (b: string): InsightPart => ({ b });

/** `a **bold** b` as parts. */
export function parseBold(text: string): InsightPart[] {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? B(part) : part)).filter((p) => p !== '');
}

function range(xs: number[], fmt: (v: number) => string) {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return lo === hi || fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
}
const secs = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
const usd = (v: number) => `$${v.toFixed(2)}`;

/** Sentences about one run of a metrics task, written from its numbers. */
export function metricsInsights(run: RunView, stats: MethodStat[]): DashboardInsight[] {
  const task = run.task;
  const out: DashboardInsight[] = [];
  const primary = metricOf(task, task.primary);
  const base = baselineOf(run);
  const baseLabel = base ? base.label : 'baseline';
  const at = task.id;

  // The baseline on its own.
  const baselines = stats.filter((s) => s.method.baseline && s.row.n > 0 && isNum(s.row.scores[primary.id]));
  if (base && baselines.length) {
    const each = baselines.length > 1 ? ' each' : '';
    out.push({
      tone: 'info', tab: at,
      parts: [
        `The ${base.subject ? '' : 'free '}baseline, ${base.label}, scores a mean ${primary.label} of `,
        B(baselines.map((s) => `${fx(s.row.scores[primary.id], primary.digits ?? 2)}${s.row.split ? ` on ${valueLabel(task, task.splitBy ?? '', s.row.split)}` : ''}`).join(' and ')),
        ` on ${plural(baselines[0].row.n, 'case')}${each}.`,
      ],
    });
  }

  // What a model or agent adds to it.
  const assisted = stats.filter((s) => s.method.subject && s.paired && s.paired.n >= 3);
  if (assisted.length) {
    const best = assisted.reduce((a, s) => (s.paired!.improvement > a.paired!.improvement ? s : a));
    const d = best.paired!;
    const name = methodLabel(task, best.method, best.row.split);
    if (d.improvement > task.gain) {
      out.push({
        tone: 'good', tab: at,
        parts: [B(name), ` beats the ${baseLabel} by `, B(`${fSigned(d.improvement)} ${primary.label}`), ` on the ${d.n} cases both ran (${d.wins} better, ${d.losses} worse).`],
      });
    } else {
      // A gain just under the threshold needs a third decimal, or "+0.02" would sit beside "more than 0.02".
      const digits = Math.abs(d.improvement - task.gain) < 0.005 ? 3 : 2;
      out.push({
        tone: 'warn', tab: at,
        parts: [`No model or agent beats the ${baseLabel} by more than `, B(`${task.gain.toFixed(2)} ${primary.label}`), ' on the cases it ran. The closest is ', B(name), ` (${fSigned(d.improvement, digits)} on ${plural(d.n, 'case')}).`],
      });
    }
  }

  // What the dearest family of methods costs.
  const priced = stats.filter((s) => s.usdPerCase !== null && s.usdPerCase > 0 && s.secPerCase !== null);
  if (priced.length) {
    const dear = priced.reduce((a, s) => (s.usdPerCase! > a.usdPerCase! ? s : a));
    const family = priced.filter((s) => s.method.family === dear.method.family);
    const fam = familyOf(task, dear.method)?.label ?? dear.method.label;
    const free = stats.find((s) => s.method.baseline) ?? stats.find((s) => s.usdPerCase === 0);
    out.push({
      tone: 'info', tab: 'spend',
      parts: [
        `The “${fam}” methods cost `, B(range(family.map((s) => s.usdPerCase!), usd)), ' and take ', B(`${range(family.map((s) => s.secPerCase!), secs)} s`), ' per case. ',
        free ? `${free.method.label} costs nothing and takes ${isNum(free.secPerCase) && free.secPerCase < 1 ? 'under a second' : `${fx(free.secPerCase, 1)} s`}.` : '',
      ],
    });
  }

  // The same method on each value of the split dimension (the depth models).
  if (base && task.splitBy) {
    const rows = stats.filter((s) => s.method.id === base.id && s.row.split && s.row.n > 0 && isNum(s.row.scores[primary.id]));
    if (rows.length === 2 && rows[0].row.n === rows[1].row.n) {
      const [a, c] = rows;
      const va = a.row.scores[primary.id]!, vc = c.row.scores[primary.id]!;
      const diff = (primary.better === 'higher' ? 1 : -1) * (va - vc);
      const dim = lower(task.dimensions.find((d) => d.id === task.splitBy)?.label ?? 'value');
      const la = valueLabel(task, task.splitBy, a.row.split!), lc = valueLabel(task, task.splitBy, c.row.split!);
      const d = primary.digits ?? 2;
      out.push({
        tone: 'info', tab: at,
        parts: Math.abs(diff) < task.gain
          ? [`The two ${dim}s score about equally well: `, B(`${base.label} ${primary.label} ${fx(va, d)} on ${la}, ${fx(vc, d)} on ${lc}`), ` (${plural(a.row.n, 'case')} each).`]
          : [B(diff > 0 ? la : lc), ` scores better: ${base.label} ${primary.label} ${fx(diff > 0 ? va : vc, d)} against ${fx(diff > 0 ? vc : va, d)} (${plural(a.row.n, 'case')} each).`],
      });
    }
  }

  // The case every method fails.
  const hard = hardestCases(run, 1)[0];
  if (hard && (goodness(primary, hard.value) ?? 1) < HARD_GOODNESS) {
    out.push({
      tone: 'warn', tab: at,
      parts: ['Hardest case: ', B(caseName(task, hard.c)), `. Even the best method reaches only ${primary.label} ${formatScore(primary, hard.value)}.${task.hardCasesHint ? ` ${task.hardCasesHint}` : ''}`],
    });
  }

  // Whatever the task itself has to say.
  for (const i of run.extras.insights ?? []) out.push({ tone: i.tone, tab: at, parts: parseBold(i.text) });
  return out;
}

/** Sentences about one run of a verdict task. */
export function verdictInsights(run: RunView): DashboardInsight[] {
  const ag = run.agreement;
  const labels = run.task.labels ?? [];
  if (!ag || !ag.labelled || labels.length < 2) return [];
  const severe = labels[0].label, clean = labels[labels.length - 1].label;
  const bad = ag.severe.total ? `caught ${ag.severe.caught} of ${ag.severe.total} “${severe}” cases` : null;
  const good = ag.clean.total ? `flagged ${ag.clean.flagged} of ${ag.clean.total} “${clean}” ones` : null;
  return [{
    tone: ag.severe.caught === ag.severe.total && ag.clean.flagged === 0 ? 'good' : 'warn', tab: run.task.id,
    parts: [`The ${run.methods[0]?.label ?? run.task.label} `, B([bad, good].filter(Boolean).join(' and ') || `matched ${ag.exact} labels`), `; ${ag.exact} of ${ag.labelled} verdicts match the labels set by eye.`],
  }];
}

/**
 * A dimension value that scores best on a metrics task but is not the cleanest on a verdict task: read the
 * two together. Returns nothing unless the data has such a pair.
 */
export function crossInsight(dim: DimensionSpec, rows: DimensionRow[], verdictTask: TaskInfo): DashboardInsight | null {
  const labels = verdictTask.labels ?? [];
  if (labels.length < 2) return null;
  const clean = labels[labels.length - 1].id;
  const withScore = rows.filter((r) => r.scores[0] && isNum(r.scores[0].mean) && (r.verdicts?.checked ?? 0) >= 2);
  if (withScore.length < 2) return null;
  const metric = withScore[0].scores[0].metric;
  const score = (r: DimensionRow) => r.scores[0].mean!;
  const top = withScore.reduce((a, r) => (betterThan(metric, score(r), score(a)) ? r : a));
  const dirty = (r: DimensionRow) => (r.verdicts!.checked - (r.verdicts!.byLabel[clean] ?? 0));
  const severe = (r: DimensionRow) => r.verdicts!.byLabel[labels[0].id] ?? 0;
  const cleanest = withScore
    .filter((r) => r.value !== top.value && dirty(r) === 0)
    .sort((a, b) => (betterThan(metric, score(a), score(b)) ? -1 : 1))[0];
  if (!cleanest || severe(top) === 0) return null;
  const task = top.scores[0].task;
  return {
    tone: 'warn', tab: verdictTask.id,
    parts: [
      `The best-scoring ${lower(dim.label)} is not the cleanest: `, B(`${top.label} scores ${metric.label} ${fx(score(top), metric.digits ?? 2)}`),
      ` on ${plural(top.scores[0].n, 'case')}, but ${severe(top)} of its ${top.verdicts!.checked} checked ${lower(verdictTask.label)} ${severe(top) === 1 ? 'is' : 'are'} "${labels[0].label}". ${cleanest.label} scores ${fx(score(cleanest), metric.digits ?? 2)} on ${plural(cleanest.scores[0].n, 'case')} with none. Read ${lower(task.label)} and ${lower(verdictTask.label)} together.`,
    ],
  };
}

/** Sentences about the ledger. Kinds whose id starts with `bench` are what benchmarks spent. */
export function spendInsights(spend: SpendSummary | null): DashboardInsight[] {
  if (!spend || spend.totalUsd <= 0) return [];
  const bench = spend.byContext.find((c) => c.id === 'bench');
  if (!bench || bench.usd <= 0) return [];
  const top = spend.byKind.find((k) => k.id.startsWith('bench'));
  return [{
    tone: 'info', tab: 'spend',
    parts: ['Benchmarks account for ', B(usd(bench.usd)), ` of the ${usd(spend.totalUsd)} paid so far${top ? `, ${usd(top.usd)} of it on ${top.label.replace(/^Benchmark: /i, '').toLowerCase()}` : ''}. A run that repeats a question already asked is answered from the cache and costs nothing.`],
  }];
}
