// Overview: the headline numbers, what they say in words, and where to look next. It reads every task, so
// it says the same thing whatever the tasks measure: how far the baseline gets, what a model or agent adds,
// where the cases are hard, whether the verdicts agree with the people who set them, and what it cost.
import { formatScore, isNum, metricOf } from '../../core/analyze.ts';
import type { RunView, SpendSummary, TaskInfo } from '../../core/types.ts';
import {
  baselineOf, caseDims, countOf, crossInsight, dimensionRows, familyColor, goodness, hardestCases, keptCases, methodLabel, methodStats, metricsInsights,
  runFacts, spendInsights, toneOf, verdictInsights,
} from '../analytics.ts';
import { diverge, meter } from '../charts.ts';
import { clear, h } from '../dom.ts';
import { fSigned, fUsd, fx, mean, plural, lower } from '../format.ts';
import type { DashboardInsight, MetricsContext, View } from '../host.ts';
import { kpi, notice, panel, type KpiOptions } from '../ui.ts';

const settle = async <T>(p: Promise<T>) => p.then((value) => ({ value }), (error: unknown) => ({ error }));

interface Loaded {
  tasks: TaskInfo[];
  runs: Map<string, RunView>;
  spend: SpendSummary | null;
  errors: string[];
}

export function overviewView(ctx: MetricsContext): View {
  const kpis = h('div.kpis', { 'aria-live': 'polite' }, h('p.muted.loading', 'Loading the numbers…'));
  const findings = h('div.insights-host', h('p.muted.loading', 'Reading the data…'));
  const gain = h('div.gain-host', h('p.muted.loading', 'Comparing the methods…'));
  const hardest = h('div.hardest-host', h('p.muted.loading', 'Looking for hard cases…'));

  const el = h('div.tab-overview',
    kpis,
    h('div.cols-2.lead',
      panel({ title: 'What the numbers say', lede: 'Written from the latest runs and from the other tabs. Methods are compared on the cases they share, so a method that only ran on easy cases cannot look better than it is.' }, findings),
      h('div.stack-col',
        panel({ title: 'Against the baseline', lede: 'The gain of each method over the baseline, on the cases both ran. A bar to the left of the line scores worse than the baseline.' }, gain),
        panel({ title: 'Where it is hard', lede: 'Cases where even the best method scores low.' }, hardest),
      ),
    ),
  );

  void (async () => {
    const load = await loadAll(ctx);
    if (ctx.isDisposed()) return;
    const { tasks, runs, spend } = load;
    const metricsTasks = tasks.filter((t) => t.kind === 'metrics');
    const verdictTasks = tasks.filter((t) => t.kind === 'verdicts');
    const primary = metricsTasks.find((t) => runs.has(t.id)) ?? metricsTasks[0];
    const primaryRun = primary ? runs.get(primary.id) ?? null : null;
    const stats = primaryRun ? methodStats(primaryRun, spend) : [];

    // ----- headline numbers -----
    const cards: KpiOptions[] = [];
    for (const t of tasks) {
      const run = runs.get(t.id) ?? null;
      cards.push(...(t.kind === 'metrics' ? metricsKpis(ctx, t, run, spend) : verdictKpis(ctx, t, run)));
    }
    const host = ctx.host.tabs ?? [];
    const headlines = await Promise.all(host.map((tab) => (tab.headline ? settle(tab.headline(ctx)) : Promise.resolve({ value: null as KpiOptions | null }))));
    if (ctx.isDisposed()) return;
    headlines.forEach((hl, i) => {
      const tab = host[i];
      const link = { href: ctx.href(tab.id), onClick: () => ctx.go(tab.id) };
      if ('value' in hl && hl.value) cards.push({ ...hl.value, link });
      else if ('error' in hl) cards.push({ label: tab.label, value: '–', sub: 'Not available', link });
    });
    cards.push(spendKpi(ctx, spend));
    clear(kpis);
    kpis.append(...cards.map(kpi));

    // ----- what the numbers say -----
    const said: DashboardInsight[] = [];
    for (const t of metricsTasks) {
      const run = runs.get(t.id);
      if (run) said.push(...metricsInsights(run, methodStats(run, spend)));
    }
    for (const t of verdictTasks) {
      const run = runs.get(t.id);
      if (!run) continue;
      said.push(...verdictInsights(run));
      for (const dim of t.dimensions.filter((d) => d.values)) {
        const x = crossInsight(dim, dimensionRows(dim, run, [...runs.values()].filter((r) => r.task.kind === 'metrics')), t);
        if (x) said.push(x);
      }
    }
    for (let i = 0; i < host.length; i++) {
      const tab = host[i];
      if (!tab.insights) continue;
      const r = await settle(tab.insights(ctx));
      if (ctx.isDisposed()) return;
      if ('value' in r) said.push(...r.value);
    }
    said.push(...spendInsights(spend));

    clear(findings);
    for (const e of load.errors) findings.append(notice(e, 'warn'));
    if (!runs.size && !load.errors.length) findings.append(notice(`No benchmark runs yet.${tasks.find((t) => t.howToRun)?.howToRun ? ` ${tasks.find((t) => t.howToRun)!.howToRun}` : ''}`, 'info'));
    if (said.length) {
      const tabLabel = (id: string) => tasks.find((t) => t.id === id)?.label ?? host.find((t) => t.id === id)?.label ?? (id === 'spend' ? 'Spend' : id);
      findings.append(h('ul.insights', said.slice(0, 8).map((i) => h('li', { class: i.tone },
        h('p', i.parts.map((p) => (typeof p === 'string' ? p : h('strong', p.b)))),
        i.tab ? h('a.more', { href: ctx.href(i.tab), onclick: (e: Event) => { e.preventDefault(); ctx.go(i.tab!); } }, `${tabLabel(i.tab)} →`) : null,
      ))));
    }

    // ----- against the baseline, and where it is hard -----
    clear(gain);
    const compared = stats.filter((s) => !s.method.baseline && s.paired);
    if (primaryRun && compared.length) {
      const base = baselineOf(primaryRun)!;
      const metric = metricOf(primaryRun.task, primaryRun.task.primary);
      const maxAbs = Math.max(0.1, ...compared.map((s) => Math.abs(s.paired!.improvement)));
      gain.append(h('ul.gainlist', compared.map((s) => h('li', { title: `${s.paired!.mean.toFixed(3)} against ${s.paired!.base.toFixed(3)} for the ${base.label}, on the ${plural(s.paired!.n, 'case')} both ran (${metric.label})` },
        h('span.gain-name', h('i.fam-dot', { style: `background:${familyColor(primaryRun.task, s.method)}` }), methodLabel(primaryRun.task, s.method, s.row.split), h('small', ` ${plural(s.paired!.n, 'case')}`)),
        diverge(s.paired!.improvement, maxAbs, fSigned(s.paired!.improvement), true),
      ))));
    } else {
      gain.append(notice(primaryRun ? 'No method shares cases with the baseline yet.' : 'Needs a benchmark run.'));
    }

    clear(hardest);
    if (primaryRun && primary) {
      const metric = metricOf(primary, primary.primary);
      const rows = hardestCases(primaryRun, 5);
      hardest.append(rows.length
        ? h('ol.hardest', rows.map((r) => h('li',
          h('a', {
            href: ctx.href(primary.id),
            onclick: (e: Event) => { e.preventDefault(); ctx.go(primary.id, { case: r.c.id }); },
            title: `Open ${r.c.title} in ${primary.label}`,
          }, h('strong', r.c.title), h('span.muted', caseDims(primaryRun, r.c).map((d) => ` · ${d}`))),
          meter(r.value, { text: fx(r.value, metric.digits ?? 2), goodness: goodness(metric, r.value), max: (metric.range ?? [0, 1])[1] }),
        )))
        : notice('Nothing scored yet.'));
      if (primary.hardCasesHint) hardest.append(h('p.muted.small', primary.hardCasesHint));
    } else {
      hardest.append(notice('Needs a benchmark run.'));
    }
  })();

  return { el };
}

/** Every task, and the run of each that the dashboard shows. A task that fails to load is reported, not fatal. */
async function loadAll(ctx: MetricsContext): Promise<Loaded> {
  const errors: string[] = [];
  const tasksR = await settle(ctx.data.tasks());
  const tasks = 'value' in tasksR ? tasksR.value.map((t) => t.info) : [];
  if ('error' in tasksR) errors.push((tasksR.error as Error).message);
  const results = await Promise.all(tasks.map((t) => settle(ctx.run(t.id))));
  const runs = new Map<string, RunView>();
  results.forEach((r, i) => {
    if ('value' in r) {
      if (r.value) runs.set(tasks[i].id, r.value);
    } else {
      errors.push(`The ${lower(tasks[i].label)} results did not load: ${(r.error as Error).message}`);
    }
  });
  const spendR = await settle(ctx.data.spend());
  return { tasks, runs, spend: 'value' in spendR ? spendR.value : null, errors };
}

// ---------- the cards ----------

function metricsKpis(ctx: MetricsContext, task: TaskInfo, run: RunView | null, spend: SpendSummary | null): KpiOptions[] {
  const go = { href: ctx.href(task.id), onClick: () => ctx.go(task.id) };
  if (!run) return [{ label: 'Cases scored', value: '–', sub: `No ${lower(task.label)} run yet`, link: go }];
  const primary = metricOf(task, task.primary);
  const f = runFacts(run);
  const base = baselineOf(run);
  const stats = methodStats(run, spend);
  const out: KpiOptions[] = [{
    label: 'Cases scored',
    value: String(f.scored),
    sub: `${f.counts.map((c) => countOf(c.dim, c.count)).join(' · ')}${f.excluded ? `${f.counts.length ? ' · ' : ''}${f.excluded} left out` : ''}`,
    hint: 'A case is one thing to measure. Cases a person marked as unfit for scoring (a mask on the wrong object) are left out.',
    link: go,
  }];

  if (base) {
    const kept = keptCases(run);
    const v = mean(kept.map((c) => c.results.find((r) => r.method === base.id)?.scores[primary.id]).filter(isNum));
    out.push({
      label: base.subject ? 'Baseline' : 'Free baseline',
      value: fx(v, primary.digits ?? 2),
      tone: toneOf(primary, v),
      sub: `Mean ${primary.label} of the ${base.label}.${base.subject ? '' : ' No model, no cost.'}`,
      hint: primary.description,
      link: go,
    });
    const assisted = stats.filter((s) => s.method.subject && s.paired && s.paired.n >= 3);
    if (assisted.length) {
      const best = assisted.reduce((a, s) => (s.paired!.improvement > a.paired!.improvement ? s : a));
      out.push({
        label: 'Best model gain',
        value: fSigned(best.paired!.improvement),
        tone: best.paired!.improvement > task.gain ? 'good' : 'muted',
        sub: `${methodLabel(task, best.method, best.row.split)} · ${plural(best.paired!.n, 'case')}`,
        hint: `${primary.label} of a model-assisted method compared with the ${base.label}'s on the same cases. A gain counts above ${task.gain.toFixed(2)}.`,
        link: go,
      });
    } else {
      out.push({ label: 'Best model gain', value: '–', sub: 'No model-assisted method ran on 3 or more cases', link: go });
    }
  } else {
    // Nothing to compare with, so say where the methods stand: the mean of their primary scores, and the span.
    const scores = stats.map((s) => s.row.scores[primary.id]).filter(isNum);
    const v = mean(scores);
    if (v !== null) {
      const span = scores.length > 1 && Math.min(...scores) !== Math.max(...scores) ? `, from ${formatScore(primary, Math.min(...scores))} to ${formatScore(primary, Math.max(...scores))}` : '';
      out.push({
        label: primary.label,
        value: formatScore(primary, v),
        tone: toneOf(primary, v),
        sub: `Mean of ${plural(scores.length, 'method')}${span} · ${plural(f.scored, 'case')}`,
        hint: primary.description,
        link: go,
      });
    }
  }
  return out;
}

function verdictKpis(ctx: MetricsContext, task: TaskInfo, run: RunView | null): KpiOptions[] {
  const go = { href: ctx.href(task.id), onClick: () => ctx.go(task.id) };
  const labels = task.labels ?? [];
  const ag = run?.agreement;
  const who = run?.methods[0]?.label ?? task.label;
  if (run && ag && ag.labelled > 0) {
    const perfect = ag.severe.caught === ag.severe.total && ag.clean.flagged === 0;
    return [{
      label: `${who} agrees`,
      value: `${ag.exact} of ${ag.labelled}`,
      tone: perfect ? 'good' : 'fair',
      sub: `Caught ${ag.severe.caught} of ${ag.severe.total} “${labels[0]?.label}” · flagged ${ag.clean.flagged} of ${ag.clean.total} “${labels[labels.length - 1]?.label}”`,
      hint: 'Verdicts against labels a person set by eye.',
      link: go,
    }];
  }
  if (run) {
    const judged = run.cases.filter((c) => c.results.some((r) => r.label !== undefined));
    const severe = labels[0];
    return [{
      label: `${task.label} checked`,
      value: String(judged.length),
      sub: severe ? `${judged.filter((c) => c.results.some((r) => r.label === severe.id)).length} are “${severe.label}”` : undefined,
      link: go,
    }];
  }
  return [{ label: `${task.label} checked`, value: '–', sub: `No ${lower(task.label)} run yet`, link: go }];
}

function spendKpi(ctx: MetricsContext, spend: SpendSummary | null): KpiOptions {
  const link = { href: ctx.href('spend'), onClick: () => ctx.go('spend') };
  if (!spend) return { label: 'Paid so far', value: '–', sub: 'Not available', link };
  const parts = spend.byContext.slice(0, 2).map((c) => `${fUsd(c.usd)} on ${lower(c.label)}`);
  return {
    label: 'Paid so far',
    value: fUsd(spend.totalUsd),
    sub: parts.join(' · '),
    hint: 'From the ledger of every paid call. Answers read from the benchmark cache cost nothing and are not in it.',
    link,
  };
}

