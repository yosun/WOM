// A verdict task: each case gets a label (clean, minor, contaminated), judged by a model or a person and
// compared with what a person said it should be. Counts per label, how the labels agree with the people who
// set them, the dimensions the task shares with the metrics tasks, and every case with what was found.
import { formatScore, isNum, metricOf } from '../../core/analyze.ts';
import type { CaseView, Finding, LabelSpec, ResultView, RunView, TaskInfo, Tone } from '../../core/types.ts';
import { caseName, dimensionRows, goodness, type DimensionRow } from '../analytics.ts';
import { meter, stack } from '../charts.ts';
import { clear, h } from '../dom.ts';
import { clamp01, DASH, fPct, fUsd, fx, plural, lower } from '../format.ts';
import type { MetricsContext, View } from '../host.ts';
import { chip, kpi, loadInto, notice, panel } from '../ui.ts';

const FILL: Record<Tone, string> = { good: '#5fae78', fair: '#d9a658', poor: '#d9705f', info: '#7aa7d9', muted: '#8b8072' };
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The verdict a case got: its first result that carries a label. */
const judgedOf = (c: CaseView): ResultView | undefined => c.results.find((r) => r.label !== undefined);

export function verdictsView(ctx: MetricsContext, task: TaskInfo): View {
  const host = h('div', { class: `tab-${task.id}` });
  loadInto(host, Promise.all([ctx.run(task.id), metricsRuns(ctx)]), ([run, others]) => {
    if (!run) return notice(`No ${lower(task.label)} runs yet.${task.howToRun ? ` ${task.howToRun}` : ''}`);
    const labels = task.labels ?? [];
    const how = run.methods[0]?.description;
    return [
      panel({ title: `What the ${(run.methods[0]?.label ?? task.label).toLowerCase()} looks for`, lede: task.description },
        h('p.muted', how ? `${how} ` : '', labels.length ? ['Verdicts: ', ...labels.flatMap((l, i) => [i ? '; ' : '', h('b', l.label), l.description ? `: ${l.description}` : ''])] : null)),
      h('div.verdict-body', detail(ctx, run, others)),
    ];
  }, `the ${lower(task.label)} results`, ctx.isDisposed);
  return { el: host };
}

/** The runs of the metrics tasks, which the verdicts are read together with. */
async function metricsRuns(ctx: MetricsContext): Promise<RunView[]> {
  const tasks = await ctx.data.tasks().catch(() => []);
  const runs = await Promise.all(tasks.filter((t) => t.info.kind === 'metrics').map((t) => ctx.run(t.info.id).catch(() => null)));
  return runs.filter((r): r is RunView => Boolean(r));
}

function detail(ctx: MetricsContext, run: RunView, others: RunView[]) {
  const { task } = run;
  const labels = task.labels ?? [];
  const judged = run.cases.filter((c) => judgedOf(c));
  const count = (id: string) => judged.filter((c) => judgedOf(c)!.label === id).length;
  const ag = run.agreement;
  const spent = run.spend.usd;
  const who = [...new Set(run.methods.map((m) => m.subjectLabel).filter(Boolean))].join(', ');

  const kpis = h('div.kpis.compact',
    kpi({
      label: `${task.label} checked`, value: String(judged.length),
      sub: run.cases.length > judged.length ? `${run.cases.length - judged.length} could not be checked` : `by ${who || 'the checker'}${spent > 0 ? ` · ${fUsd(spent)}` : ' · from the cache'}`,
    }),
    // Cleanest first, as the verdicts read from the good end.
    ...[...labels].reverse().map((l, i) => {
      const n = count(l.id);
      // Nothing at the cleanest end is the point; nothing at the worst end is good news; the middle is just a count.
      return kpi({ label: cap(l.label), value: String(n), tone: i === 0 ? 'good' : n ? l.tone : l === labels[0] ? 'good' : 'muted', sub: fPct(judged.length ? n / judged.length : null) });
    }),
    ag?.labelled
      ? kpi({ label: 'Agrees with the labels', value: `${ag.exact} of ${ag.labelled}`, tone: ag.exact === ag.labelled ? 'good' : 'fair', sub: 'Labels were set by eye' })
      : kpi({ label: 'Labels', value: DASH, sub: `None set for these ${lower(task.label)}` }),
  );

  const byDimension = task.dimensions.filter((d) => d.values).map((dim) => dimensionPanel(run, dim, others));
  return [kpis, ...byDimension, agreementPanel(run), casesPanel(ctx, run)];
}

// ---------- by dimension: the task read with the metrics tasks ----------

function dimensionPanel(run: RunView, dim: TaskInfo['dimensions'][number], others: RunView[]) {
  const { task } = run;
  const labels = task.labels ?? [];
  const primary = metricOf(task, task.primary);
  const rows = dimensionRows(dim, run, others);
  // Which metrics tasks have a baseline to report: their columns.
  const cols = others.filter((o) => o.methods.some((m) => m.baseline) && o.task.dimensions.some((d) => d.id === dim.id));
  const priced = rows.some((r) => r.priceUsd !== undefined);
  const parts = (r: DimensionRow) => [...labels].reverse().map((l) => ({ label: l.label, value: r.verdicts?.byLabel[l.id] ?? 0, color: FILL[l.tone === 'muted' ? 'good' : l.tone] }));

  return panel({
    title: `By ${lower(dim.label)}`,
    lede: `How often each ${lower(dim.label)} got which verdict, next to how it scored in the other tasks. A ${lower(dim.label)} can score well and still be unclean.`,
  },
  h('div.table-wrap', h('table.lb.models',
    h('thead', h('tr',
      h('th.left', dim.label),
      h('th', { title: 'Cases with a verdict' }, 'Checked'),
      h('th.left', { title: [...labels].reverse().map((l) => l.label).join(', ') }, 'Verdicts'),
      h('th', { title: primary.description }, primary.label),
      cols.map((o) => h('th', { title: `Mean ${o.task.primary} of the baseline in the selected ${lower(o.task.label)} run` }, `${o.task.label} ${metricOf(o.task, o.task.primary).label}`)),
      priced ? h('th', { title: 'What one costs to make' }, 'Price') : null,
    )),
    h('tbody', rows.map((r) => h('tr',
      h('td.left', h('strong', r.label)),
      h('td', String(r.verdicts?.checked ?? 0)),
      h('td.left.wide', r.verdicts?.checked ? stack(parts(r)) : h('span.muted', 'not checked')),
      h('td', formatScore(primary, r.verdicts?.mean ?? null)),
      cols.map((o) => {
        const s = r.scores.find((x) => x.task.id === o.task.id);
        const m = s?.metric;
        return h('td', s && m && s.n ? meter(isNum(s.mean) ? clamp01(((s.mean - (m.range ?? [0, 1])[0]) / ((m.range ?? [0, 1])[1] - (m.range ?? [0, 1])[0] || 1))) : null, { text: fx(s.mean, m.digits ?? 2), goodness: goodness(m, s.mean) })
          : h('span.muted', { title: `This ${lower(o.task.label)} run has no case for this ${lower(dim.label)}` }, DASH));
      }),
      priced ? h('td', r.priceUsd !== undefined ? fUsd(r.priceUsd) : DASH) : null,
    ))),
  )),
  cols.length ? h('p.muted.small', cols.map((o) => `${o.task.label} ${metricOf(o.task, o.task.primary).label} is from run ${o.id}.`).join(' '), cols[0].task.caveat ? ` ${cols[0].task.caveat}` : '') : null);
}

// ---------- against the labels ----------

function agreementPanel(run: RunView) {
  const ag = run.agreement;
  const labels = run.task.labels ?? [];
  if (!ag?.labelled) return null;
  return panel({
    title: 'Against the labels',
    lede: `${ag.exact} of ${ag.labelled} verdicts match what a person said. Caught ${ag.severe.caught} of ${ag.severe.total} “${labels[0].label}” cases; flagged ${ag.clean.flagged} of ${ag.clean.total} “${labels[labels.length - 1].label}” ones.`,
  },
  h('div.matrix-wrap',
    h('div.table-wrap', h('table.confusion',
      h('thead', h('tr', h('th'), h('th', { colspan: labels.length }, 'The check said'))),
      h('tbody',
        h('tr.sub', h('th.left', 'A person said'), labels.map((l) => h('th', l.label))),
        labels.map((e) => h('tr', h('th.left', e.label),
          labels.map((j) => {
            const n = ag.matrix[e.id]?.[j.id] ?? 0;
            return h('td', { class: `${e.id === j.id ? 'agree' : ''}${n && e.id !== j.id ? ' differ' : ''}`, title: `${plural(n, 'case')} labelled ${e.label}, judged ${j.label}` }, String(n));
          }))),
      ),
    )),
    h('p.muted.small', 'Labels are one person\'s judgment, and some were set after seeing the checker\'s verdicts. Read the agreement as indicative, not as proof.'),
  ));
}

// ---------- every case ----------

function findingsOf(r: ResultView | undefined): Finding[] {
  const f = r?.details?.findings;
  return Array.isArray(f) ? (f as Finding[]).filter((x) => x && typeof x.what === 'string') : [];
}

function casesPanel(ctx: MetricsContext, run: RunView) {
  const { task } = run;
  const labels = task.labels ?? [];
  const primary = metricOf(task, task.primary);
  const severity = new Map(labels.map((l, i) => [l.id, i]));
  const label = (id: string): LabelSpec | undefined => labels.find((l) => l.id === id);
  const cases = [...run.cases].sort((a, b) => {
    const ja = judgedOf(a), jb = judgedOf(b);
    return (severity.get(ja?.label ?? '') ?? labels.length) - (severity.get(jb?.label ?? '') ?? labels.length)
      || (goodness(primary, ja?.scores[primary.id]) ?? 1) - (goodness(primary, jb?.scores[primary.id]) ?? 1)
      || a.title.localeCompare(b.title);
  });
  type Filter = string;
  let filter: Filter = 'all';
  const rows = new Map<string, HTMLElement>();
  const chips = h('div.chips');
  const list = h('div.verdict-cases');

  const matches = (c: CaseView, f: Filter) => {
    const j = judgedOf(c);
    return f === 'all' || (f === 'unchecked' ? !j : f === 'differs' ? Boolean(c.expected && j && c.expected !== j.label) : j?.label === f);
  };
  const filters: [Filter, string][] = [['all', 'All'], ...labels.map((l): [Filter, string] => [l.id, cap(l.label)]), ['differs', 'Differs from the label'], ['unchecked', 'Not checked']];
  const drawChips = () => {
    clear(chips);
    for (const [id, text] of filters) {
      const n = cases.filter((c) => matches(c, id)).length;
      if (!n && id !== 'all') continue;
      chips.append(h('button.chip', { type: 'button', class: filter === id ? 'on' : '', 'aria-pressed': String(filter === id), onclick: () => { filter = id; drawChips(); apply(); } }, `${text} ${n}`));
    }
  };
  const apply = () => { for (const c of cases) rows.get(c.id)!.hidden = !matches(c, filter); };

  for (const c of cases) {
    const j = judgedOf(c);
    const l = j?.label ? label(j.label) : undefined;
    const share = j?.scores[primary.id];
    let built = false;
    const d = h('details.verdict-case',
      h('summary',
        h('span.case-name', caseName(task, c)),
        j && l ? chip(l.label, l.tone) : chip('not checked', 'unchecked'),
        j && isNum(share) ? h('span.foreign', { title: primary.description }, meter(share, { max: (primary.range ?? [0, 1])[1], text: formatScore(primary, share), alpha: 0.55, goodness: goodness(primary, share) })) : null,
        c.expected ? h('span.muted', c.expected === j?.label ? 'as labelled' : `labelled ${label(c.expected)?.label ?? c.expected}`) : null,
        c.group ? h('span.muted', c.group) : null,
      ),
    ) as HTMLDetailsElement;
    d.addEventListener('toggle', () => {
      if (!d.open || built) return;
      built = true;
      const found = findingsOf(j);
      const links = ctx.host.caseLinks?.(task, c) ?? [];
      d.append(h('div.case-body',
        j?.error ?? c.results.find((r) => r.error)?.error ? h('p.note-block.warn', j?.error ?? c.results.find((r) => r.error)?.error) : null,
        c.note ? h('p.note-block', c.note) : null,
        found.length ? h('ul.diag', found.map((f) => h('li', `${f.severity ? `${f.severity}: ` : ''}${f.what}${f.where ? ` (${f.where})` : ''}`))) : (j ? h('p.muted', 'Nothing found.') : null),
        j?.note ? h('p.muted', j.note) : null,
        task.artifacts.filter((a) => c.artifacts[a.id]).map((a) => h('figure.shot',
          h('img.bench-overlay', { src: c.artifacts[a.id], alt: `${c.title}: ${a.label}`, loading: 'lazy' }),
          h('figcaption', a.label))),
        links.length ? h('p.muted.small', ...links.flatMap((x, i) => [i ? ' · ' : '', h('a', { href: x.href }, x.label)])) : null,
      ));
    });
    rows.set(c.id, d);
    list.append(d);
  }
  drawChips();

  return panel({ title: `Every ${lower(task.label).replace(/s$/, '')}`, lede: 'Worst first. Open one to see what was found and the files kept for it.' }, chips, list);
}

