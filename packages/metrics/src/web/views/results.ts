// A metrics task: how each method scores. A leaderboard compared on shared cases, what each method costs in
// money and time, a case × method matrix, the task's own tables and remarks, and every case with its files.
// Everything it says comes from the run: the metrics, methods, families and dimensions the task declared.
import { betterThan, formatScore, isNum, metricOf } from '../../core/analyze.ts';
import type { CaseView, HeatTable, MetricSpec, RunView, TaskInfo } from '../../core/types.ts';
import {
  baselineOf, bestOfCase, caseDims, familyColor, familyOf, goodness, HARD_GOODNESS, matrixMethods, methodLabel, methodStats, runFacts,
  toneOf, valueLabel, countOf, type MethodStat,
} from '../analytics.ts';
import { heat, legend, meter, scatter, TONE_COLOR, type ScatterPoint, type Tone } from '../charts.ts';
import { clear, h, type Child } from '../dom.ts';
import { clamp01, DASH, fSec, fSigned, fUsd, fx, plural, lower } from '../format.ts';
import type { MetricsContext, View, ViewTarget } from '../host.ts';
import { loadInto, notice, panel, segmented } from '../ui.ts';

const arrow = (m: MetricSpec) => (m.better === 'higher' ? '↑' : '↓');
const head = (m: MetricSpec) => `${m.label}${m.unit ? ` ${m.unit}` : ''} ${arrow(m)}`;
/** A bar's length for a score: where it sits in the metric's range. */
const barOf = (m: MetricSpec, v: number | null | undefined) => {
  if (!isNum(v)) return null;
  const [lo, hi] = m.range ?? [0, 1];
  return hi > lo ? clamp01((v - lo) / (hi - lo)) : 0;
};
const show = (m: MetricSpec, v: number | null | undefined) => formatScore(m, v);

export function resultsView(ctx: MetricsContext, task: TaskInfo): View {
  const host = h('div', { class: `tab-${task.id}` });
  let target: ViewTarget | undefined;
  let focusCase: ((id: string) => void) | undefined;

  loadInto(host, Promise.all([ctx.run(task.id), ctx.data.spend().catch(() => null)]), ([run, spend]) => {
    if (!run) return notice(`No ${lower(task.label)} runs yet.${task.howToRun ? ` ${task.howToRun}` : ''}`);
    const stats = methodStats(run, spend);
    const cases = casesPanel(ctx, run, stats);
    focusCase = cases.open;
    if (target?.case) queueMicrotask(() => cases.open(target!.case!));
    return [
      runLine(run),
      guide(run),
      leaderboardPanel(run, stats),
      chartPanel(run, stats),
      matrixPanel(run, cases.open),
      tablesPanel(run),
      notesPanel(run),
      cases.el,
    ];
  }, `the ${lower(task.label)} results`, ctx.isDisposed);

  return {
    el: host,
    focus(t) {
      target = t;
      if (t.case && focusCase) focusCase(t.case);
    },
  };
}

// ---------- the run, in a line, and how to read the numbers ----------

function runLine(run: RunView) {
  const f = runFacts(run);
  const who = [...new Set(run.methods.map((m) => m.subjectLabel).filter((s): s is string => Boolean(s)))];
  return h('p.run-line',
    h('strong', `Run ${run.id}`),
    ` · ${plural(f.scored, 'case')} scored${f.counts.length ? ` (${f.counts.map((c) => countOf(c.dim, c.count)).join(', ')})` : ''}`,
    f.excluded ? ` · ${f.excluded} left out` : '',
    who.length ? ` · answered by ${who.join(', ')}` : '',
    run.spend.usd > 0 ? ` · ${fUsd(run.spend.usd)} spent on new calls` : (who.length ? ' · every paid answer came from the cache, so prices below are the ledger\'s' : ''),
  );
}

function guide(run: RunView) {
  const { task } = run;
  const primary = metricOf(task, task.primary);
  const base = baselineOf(run);
  const band = (tone: Tone, text: string) => h('span.band', h('i', { style: `background:${TONE_COLOR[tone]}` }), text);
  const t = primary.thresholds;
  const d = primary.digits ?? 2;
  const legendBands = t
    ? (primary.better === 'higher'
      ? [band('good', `${t.good.toFixed(d)} or more`), band('fair', `${t.fair.toFixed(d)} to ${t.good.toFixed(d)}`), band('poor', `below ${t.fair.toFixed(d)}`)]
      : [band('good', `${t.good.toFixed(d)} or less`), band('fair', `${t.good.toFixed(d)} to ${t.fair.toFixed(d)}`), band('poor', `above ${t.fair.toFixed(d)}`)])
    : null;
  const advanced = task.metrics.filter((m) => m.advanced);
  return h('details.glossary',
    h('summary', 'How to read these numbers'),
    h('div.glossary-body',
      task.description ? h('p', task.description) : null,
      h('dl',
        task.metrics.filter((m) => !m.advanced).flatMap((m) => [h('dt', `${m.label} ${arrow(m)}`), h('dd', m.description ?? '')]),
        base ? [h('dt', 'vs. baseline'), h('dd', `The method's mean ${primary.label} compared with the ${base.label}'s, on the cases both ran: positive is better. W / T / L counts the cases it did better, the same (within ${task.tie}) and worse.`)] : null,
        h('dt', 'Cost, time'),
        h('dd', 'What the calls behind one case cost when paid for, and how long they took, including those of the method it is made from.'),
        advanced.length ? [h('dt', 'More metrics'), h('dd', advanced.map((m) => `${m.label}: ${m.description ?? ''}`).join(' '))] : null,
      ),
      legendBands ? h('div.band-legend', `${primary.label} colours `, legendBands) : null,
      task.caveat ? h('p.muted', task.caveat) : null,
    ),
  );
}

// ---------- leaderboard ----------

interface Col {
  id: string;
  label: string;
  title: string;
  /** Which end is best, which decides the first click on the header. */
  best?: 'high' | 'low';
  extra?: boolean;
  sortValue(s: MethodStat): number | string | null;
  cell(s: MethodStat): Child;
}

function columns(run: RunView): Col[] {
  const { task } = run;
  const primary = metricOf(task, task.primary);
  const base = baselineOf(run);
  const small = task.smallSample;
  const span = Math.abs((primary.range ?? [0, 1])[1] - (primary.range ?? [0, 1])[0]) || 1;
  const deltaTone = (d: number): Tone => (d > task.gain ? 'good' : d >= -task.gain ? 'muted' : d >= -0.1 * span ? 'fair' : 'poor');
  const metricCol = (m: MetricSpec): Col => ({
    id: m.id, label: head(m), title: `${m.description ?? m.label} ${m.better === 'higher' ? 'Higher' : 'Lower'} is better.`.trim(), best: m.better === 'higher' ? 'high' : 'low', extra: m.advanced,
    sortValue: (s) => s.row.scores[m.id] ?? null,
    cell: (s) => (m.id === primary.id
      ? meter(barOf(m, s.row.scores[m.id]), { goodness: goodness(m, s.row.scores[m.id]), text: show(m, s.row.scores[m.id]) })
      : show(m, s.row.scores[m.id])),
  });
  const cols: Col[] = [
    {
      id: 'method', label: 'Method', title: 'What answers. Hover a name to see how it works.', best: 'low',
      sortValue: (s) => methodLabel(task, s.method, s.row.split),
      cell: (s) => h('div.method-cell', { title: s.method.description },
        h('i.fam-dot', { style: `background:${familyColor(task, s.method)}` }),
        h('div', h('strong', methodLabel(task, s.method, s.row.split)), h('small', s.method.baseline ? (s.method.subject ? 'baseline' : 'free baseline') : familyOf(task, s.method)?.label ?? '')),
      ),
    },
    {
      id: 'cases', label: 'Cases', title: 'Cases the method was scored on, out of the cases it could have run on. Few cases make a mean unreliable.', best: 'high',
      sortValue: (s) => s.row.n,
      cell: (s) => h('span', { class: s.row.n < small ? 'few' : '', title: s.row.n < small ? `Only ${plural(s.row.n, 'case')}: read this row with care` : '' },
        `${s.row.n} of ${s.of}`, s.row.failed ? h('small', ` +${s.row.failed} failed`) : null),
    },
    metricCol(primary),
  ];
  if (base) {
    cols.push({
      id: 'delta', label: 'vs. baseline', title: `Mean ${primary.label} compared with the ${base.label}'s on the cases both ran (positive is better). W / T / L: cases it did better, the same (within ${task.tie}), worse.`, best: 'high',
      sortValue: (s) => (s.method.baseline ? 0 : s.paired?.improvement ?? null),
      cell: (s) => {
        if (s.method.baseline) return h('span.muted', 'baseline');
        const p = s.paired;
        if (!p) return DASH;
        return h('span.delta', { class: deltaTone(p.improvement), title: `${p.mean.toFixed(3)} against ${p.base.toFixed(3)} for the ${base.label}, on the ${plural(p.n, 'case')} both ran` },
          h('b', fSigned(p.improvement)), h('small', `${p.wins}W ${p.ties}T ${p.losses}L`));
      },
    });
  }
  for (const m of task.metrics) if (m.id !== primary.id && !m.advanced) cols.push(metricCol(m));
  cols.push(
    {
      id: 'cost', label: 'Cost / case', title: 'The calls behind one case, at the price paid in the ledger. A method made from another\'s answer includes that answer\'s price.', best: 'low',
      sortValue: (s) => s.usdPerCase,
      cell: (s) => (s.usdPerCase === 0 ? h('span.muted', 'free') : fUsd(s.usdPerCase)),
    },
    { id: 'time', label: 'Time / case', title: 'Time for one case, including the method it is made from.', best: 'low', sortValue: (s) => s.secPerCase, cell: (s) => fSec(s.secPerCase) },
  );
  for (const m of task.metrics) if (m.advanced) cols.push(metricCol(m));
  cols.push({ id: 'wins', label: `Top ${primary.label} in`, title: `Cases where the method had the best ${primary.label} of all methods.`, best: 'high', extra: true, sortValue: (s) => s.row.wins, cell: (s) => String(s.row.wins) });
  return cols;
}

function leaderboardPanel(run: RunView, stats: MethodStat[]) {
  const COLS = columns(run);
  const { task } = run;
  let sort: { col: string | null; dir: 'asc' | 'desc' } = { col: null, dir: 'desc' };
  let more = false;
  const tableHost = h('div.table-wrap');

  const sorted = () => {
    if (!sort.col) return stats;
    const col = COLS.find((c) => c.id === sort.col)!;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...stats].sort((a, b) => {
      const x = col.sortValue(a), y = col.sortValue(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * dir;
    });
  };

  const clickHeader = (col: Col) => {
    const first = col.best === 'low' ? 'asc' : 'desc';
    if (sort.col !== col.id) sort = { col: col.id, dir: first };
    else if (sort.dir === first) sort = { col: col.id, dir: first === 'asc' ? 'desc' : 'asc' };
    else sort = { col: null, dir: 'desc' };
    draw();
  };

  const draw = () => {
    clear(tableHost);
    const cols = COLS.filter((c) => more || !c.extra);
    tableHost.append(h('table.lb',
      h('thead', h('tr', cols.map((c) => h('th', { scope: 'col', title: c.title, class: c.id === 'method' ? 'left' : '', 'aria-sort': sort.col === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
        h('button.sort', { type: 'button', onclick: () => clickHeader(c) }, c.label, h('span.arrow', { 'aria-hidden': 'true' }, sort.col === c.id ? (sort.dir === 'asc' ? '▲' : '▼') : '')),
      )))),
      h('tbody', sorted().map((s) => h('tr', { class: s.method.baseline ? 'baseline' : '' }, cols.map((c) => h('td', { class: c.id === 'method' ? 'left' : '' }, c.cell(s)))))),
    ));
  };
  draw();

  const base = baselineOf(run);
  const toggle = h('input', { type: 'checkbox', onchange: (e: Event) => { more = (e.target as HTMLInputElement).checked; draw(); } });
  return panel({
    title: 'Leaderboard',
    lede: base
      ? `Click a column to sort. "vs. baseline" compares each method with the ${base.label} on the cases both ran, because the methods that cost money ran on fewer cases than the free ones.`
      : 'Click a column to sort.',
    actions: h('label.toggle', toggle, 'More metrics'),
    id: `wom-${task.id}-leaderboard`,
  }, tableHost, run.excluded.length ? h('p.muted.small', `Not in the table: ${run.excluded.length} ${run.excluded.length === 1 ? 'case' : 'cases'} a person marked as unfit for scoring (see the case notes below).`) : null);
}

// ---------- cost, time and quality ----------

function chartPanel(run: RunView, stats: MethodStat[]) {
  const { task } = run;
  const base = baselineOf(run);
  if (!base) return null;
  const primary = metricOf(task, task.primary);
  let mode: 'cost' | 'time' = 'cost';
  const chartHost = h('div.chart-wrap');
  const note = h('p.muted.small');
  // A run that compared values of the split dimension has each method once per value. Filled and ringed dots tell
  // them apart, so every method is labelled once instead of twice.
  const splits = [...new Set(run.summary.map((r) => r.split).filter((s): s is string => Boolean(s)))].sort();
  const multi = splits.length > 1;

  const draw = () => {
    clear(chartHost);
    const points: ScatterPoint[] = [];
    const left: string[] = [];
    for (const s of stats) {
      const y = s.method.baseline ? 0 : s.paired?.improvement;
      const x = mode === 'cost' ? s.usdPerCase : s.secPerCase;
      if (!isNum(y) || !isNum(x)) { left.push(methodLabel(task, s.method, s.row.split)); continue; }
      const n = s.paired?.n ?? s.row.n;
      const label = methodLabel(task, s.method);
      points.push({
        label,
        group: multi ? label : undefined,
        hollow: multi && s.row.split === splits[0],
        x, y,
        r: Math.min(11, 4.5 + Math.sqrt(n) * 0.9),
        color: familyColor(task, s.method),
        title: `${methodLabel(task, s.method, s.row.split)}: ${s.method.baseline ? 'the baseline' : `${fSigned(y)} ${primary.label} against the ${base.label} on ${plural(n, 'shared case')}`} · ${s.usdPerCase === 0 ? 'free' : fUsd(s.usdPerCase)} and ${fSec(s.secPerCase)} per case`,
      });
    }
    if (multi) {
      // One label per method: the last dot of each group keeps it.
      const last = new Map<string, number>();
      points.forEach((p, i) => last.set(p.group!, i));
      points.forEach((p, i) => { if (last.get(p.group!) !== i) p.label = ''; });
    }
    chartHost.append(scatter(points, {
      xLabel: mode === 'cost' ? 'Cost per case (USD)' : 'Time per case (log scale)',
      yLabel: `${primary.label} gain over the ${base.label}`,
      xScale: mode === 'time' ? 'log' : 'linear',
      xFormat: (v) => (mode === 'cost' ? `$${v.toFixed(2)}` : v >= 60 ? `${+(v / 60).toFixed(1)} min` : `${+v.toPrecision(2)} s`),
      xTicks: mode === 'time' ? [0.1, 0.3, 1, 3, 10, 30, 60, 180, 600] : undefined,
      yFormat: (v) => (v === 0 ? '0' : fSigned(v)),
      ref: { y: 0, label: `Same as the ${base.label}` },
      ariaLabel: `${primary.label} gain over the ${base.label} against ${mode === 'cost' ? 'cost' : 'time'} per case, for ${plural(points.length, 'method')}`,
    }));
    note.textContent = left.length ? `Not plotted, because ${mode === 'cost' ? 'their price' : 'their time'} is unknown: ${left.join(', ')}.` : '';
  };
  draw();

  const splitLabel = (s: string) => valueLabel(task, task.splitBy ?? '', s);
  return panel({
    title: 'What the extra cost buys',
    lede: `Each dot is a method. Up is better: above the dashed line a method beats the ${base.label} on the same cases, below it loses. Left is cheaper. Bigger dots rest on more cases.`,
    actions: segmented([{ id: 'cost', label: 'Cost' }, { id: 'time', label: 'Time' }], mode, (m) => { mode = m; draw(); }, 'Horizontal axis'),
    id: `wom-${task.id}-chart`,
  },
  chartHost,
  legend([
    ...task.families.map((f) => ({ label: f.label, color: f.color, title: f.description })),
    ...(multi ? [{ label: `Filled: ${splitLabel(splits[splits.length - 1])}`, color: '#bdb3a4' }, { label: `Ring: ${splitLabel(splits[0])}`, color: '#bdb3a4', hollow: true }] : []),
  ]),
  note);
}

// ---------- case × method matrix ----------

function matrixPanel(run: RunView, open: (id: string) => void) {
  const { task } = run;
  const primary = metricOf(task, task.primary);
  const methods = matrixMethods(run);
  const groups = new Map<string, CaseView[]>();
  for (const c of run.cases) groups.set(c.group ?? '', [...(groups.get(c.group ?? '') ?? []), c]);

  const head = h('tr', h('th.left', { scope: 'col' }, 'Case'), methods.map((m) => h('th.mcol', { scope: 'col', title: m.description },
    h('i.fam-bar', { style: `background:${familyColor(task, m)}` }),
    h('span', m.label), m.subjectLabel ? h('small', m.subjectLabel) : null,
  )));

  const body: Child[] = [];
  for (const [group, cases] of groups) {
    if (group) body.push(h('tr.mgroup', h('th', { colspan: methods.length + 1, scope: 'colgroup' }, group)));
    for (const c of cases) {
      const best = bestOfCase(task, c);
      body.push(h('tr', { class: c.excluded ? 'excluded' : '' },
        h('th.left', { scope: 'row' },
          h('button.link', { type: 'button', onclick: () => open(c.id), title: c.excluded ? 'Left out of the summary. Click to see why.' : 'Open this case' }, c.title),
          h('small', ` ${caseDims(run, c).join(' · ')}`),
        ),
        methods.map((m) => {
          const v = c.results.find((r) => r.method === m.id)?.scores[primary.id];
          const value = isNum(v) ? v : null;
          const isBest = value !== null && best.value !== null && (value === best.value || !betterThan(primary, best.value, value));
          return h('td.cell', {
            class: isBest ? 'best' : '',
            style: `background:${heat(goodness(primary, value), 0.4)}`,
            title: value === null ? 'Not run on this case' : `${methodLabel(task, m)}: ${primary.label} ${value.toFixed(3)}${isBest ? ' (best on this case)' : ''}`,
          }, value === null ? '·' : show(primary, value));
        }),
      ));
    }
  }

  return panel({
    title: 'Every case, every method',
    lede: `Each cell is the ${primary.label} of one method on one case. Look for rows that are poor everywhere (a hard case) and columns that are poor everywhere (a weak method). The outlined cell is the best on its row.`,
    id: `wom-${task.id}-matrix`,
    actions: h('span.band-legend', h('span.heat-scale', { 'aria-hidden': 'true' }), h('small', 'poor → good')),
  }, h('div.table-wrap', h('table.matrix', h('thead', head), h('tbody', body))));
}

// ---------- tables and remarks the task adds ----------

function tablesPanel(run: RunView) {
  const tables = run.extras.tables;
  if (!tables.length) return null;
  const cell = (c: { value: number | null; secondary?: number | null }, strong = false) => h('td.cell', { style: `background:${heat(c.value, 0.4)}` },
    strong ? h('b', fx(c.value)) : fx(c.value), c.secondary !== undefined ? h('small', ` / ${fx(c.secondary)}`) : null);
  return panel({
    title: run.extras.tablesTitle ?? 'Tables',
    lede: run.extras.tablesCaption,
    id: `wom-${run.task.id}-tables`,
  }, tables.map((t: HeatTable) => h('div.table-wrap',
    h('h3', t.title),
    t.caption ? h('p.muted.small', t.caption) : null,
    h('table.bench-table.heat-table',
      h('thead', h('tr', h('th.left', ''), t.columns.map((c) => h('th', c.label)), t.rows.some((r) => r.total) ? h('th', 'Mean') : null)),
      h('tbody', t.rows.map((row) => h('tr',
        h('th.left', { scope: 'row' }, row.label, row.sub ? h('small', ` ${row.sub}`) : null),
        row.cells.map((c) => cell(c)),
        row.total ? cell(row.total, true) : null,
      ))),
    ),
  )));
}

function notesPanel(run: RunView) {
  if (!run.extras.notes.length) return null;
  return h('details.panel.mpanel.behaviour',
    h('summary', h('h2', run.extras.notesTitle ?? 'Notes')),
    run.extras.notesCaption ? h('p.panel-lede', run.extras.notesCaption) : null,
    h('ul.diag', run.extras.notes.map((b) => h('li', b))),
  );
}

// ---------- the cases ----------

interface CaseItem {
  c: CaseView;
  el: HTMLDetailsElement;
  /** How good the best method's primary score is, 0 to 1; null when nothing scored. */
  best: number | null;
  attention: boolean;
}

function casesPanel(ctx: MetricsContext, run: RunView, stats: MethodStat[]) {
  const { task } = run;
  const primary = metricOf(task, task.primary);
  const methods = matrixMethods(run);
  const list = h('div.case-list');
  const items: CaseItem[] = run.cases.map((c) => {
    const best = bestOfCase(task, c);
    const g = goodness(primary, best.value);
    const attention = Boolean(c.note) || c.excluded || (g !== null && g < HARD_GOODNESS);
    return { c, el: caseRow(ctx, run, c, best, methods, stats), best: g, attention };
  });

  const select = (label: string, options: [string, string][]) => h('select', { 'aria-label': label }, h('option', { value: '' }, label), options.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;
  const groups = [...new Set(run.cases.map((c) => c.group).filter((g): g is string => Boolean(g)))];
  const groupSel = select(`Every ${task.groupLabel ?? 'group'}`, groups.map((g) => [g, g]));
  // One filter for each dimension the cases name that takes several values (the 3D models, the depth models).
  const dimSels = task.dimensions
    .filter((d) => d.show !== 'never')
    .map((d) => ({ d, values: [...new Set(run.cases.map((c) => c.dims[d.id]).filter(Boolean))] }))
    .filter((x) => x.values.length > 1)
    .map((x) => ({ ...x, el: select(`Every ${lower(x.d.label)}`, x.values.map((v) => [v, valueLabel(task, x.d.id, v)])) }));
  const orderSel = h('select', { 'aria-label': 'Order' },
    h('option', { value: 'listed' }, 'As listed'),
    h('option', { value: 'hardest' }, 'Hardest first'),
    h('option', { value: 'easiest' }, 'Easiest first'),
  ) as HTMLSelectElement;
  const search = h('input', { type: 'search', placeholder: 'Find a case', 'aria-label': 'Find a case' }) as HTMLInputElement;
  const attention = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const count = h('span.muted.small');

  const apply = () => {
    const q = search.value.trim().toLowerCase();
    const ordered = [...items];
    if (orderSel.value !== 'listed') ordered.sort((a, b) => ((a.best ?? 2) - (b.best ?? 2)) * (orderSel.value === 'hardest' ? 1 : -1));
    let shown = 0;
    for (const it of ordered) {
      const visible = (!groupSel.value || it.c.group === groupSel.value)
        && dimSels.every((x) => !x.el.value || it.c.dims[x.d.id] === x.el.value)
        && (!q || it.c.title.toLowerCase().includes(q))
        && (!attention.checked || it.attention);
      it.el.hidden = !visible;
      if (visible) shown++;
      list.append(it.el);
    }
    count.textContent = `Showing ${shown} of ${items.length}`;
  };
  for (const el of [groupSel, ...dimSels.map((x) => x.el), orderSel, attention]) el.addEventListener('change', apply);
  search.addEventListener('input', apply);
  apply();

  const bar = h('div.filters',
    groups.length > 1 ? groupSel : null,
    dimSels.map((x) => x.el),
    search,
    h('label.toggle', { title: 'Cases where even the best method does badly, or that carry a note' }, attention, 'Needs attention'),
    h('label.row', h('span', 'Order'), orderSel),
    count,
  );

  const open = (id: string) => {
    const it = items.find((i) => i.c.id === id);
    if (!it) return;
    if (it.el.hidden) {
      groupSel.value = search.value = '';
      for (const x of dimSels) x.el.value = '';
      attention.checked = false;
      apply();
    }
    it.el.open = true;
    it.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    it.el.classList.add('flash');
    setTimeout(() => it.el.classList.remove('flash'), 1800);
  };

  const el = panel({
    title: 'Cases',
    lede: 'Open a case for the files the run kept for it and the score of every method.',
    id: `wom-${task.id}-cases`,
  }, bar, list);
  return { el, open };
}

function caseRow(ctx: MetricsContext, run: RunView, c: CaseView, best: { value: number | null; method: string | null }, methods: RunView['methods'], stats: MethodStat[]): HTMLDetailsElement {
  const { task } = run;
  const primary = metricOf(task, task.primary);
  const bestMethod = methods.find((m) => m.id === best.method);
  const strip = h('span.strip', { 'aria-hidden': 'true' }, methods.map((m) => {
    const v = c.results.find((r) => r.method === m.id)?.scores[primary.id];
    const g = goodness(primary, isNum(v) ? v : null);
    return h('i', {
      style: g !== null ? `height:${Math.max(2, Math.round(g * 18))}px;background:${heat(g, 0.85)}` : 'height:2px;background:rgba(255,255,255,.12)',
      title: `${methodLabel(task, m)}: ${isNum(v) ? show(primary, v) : 'not run'}`,
    });
  }));
  const revision = task.revision && (c.revision ?? 1) > 1 ? h('span.chip', { title: task.revision.hint }, `${task.revision.label} v${c.revision}`) : null;
  let built = false;
  const d = h('details.case', { class: c.excluded ? 'excluded' : '', id: `case-${task.id}-${c.id.replace(/[^a-z0-9]+/gi, '-')}` },
    h('summary',
      h('span.case-name', c.title),
      caseDims(run, c).map((label) => h('span.chip', label)),
      revision,
      c.excluded ? h('span.chip.status-wontfix', { title: c.note }, 'left out') : (c.note ? h('span.chip.minor', { title: c.note }, 'note') : null),
      h('span.case-best', bestMethod
        ? [h('span.muted', 'best '), `${methodLabel(task, bestMethod)} `, h('b', { class: toneOf(primary, best.value) }, show(primary, best.value))]
        : h('span.muted', 'no score')),
      strip,
    ),
  ) as HTMLDetailsElement;

  d.addEventListener('toggle', () => {
    if (!d.open || built) return;
    built = true;
    const metrics = task.metrics.filter((m) => !m.advanced);
    const links = ctx.host.caseLinks?.(task, c) ?? [];
    d.append(h('div.case-body',
      c.note ? h('p.note-block', { class: c.excluded ? 'warn' : '' }, c.excluded ? `Not in the summary. ${c.note}` : c.note) : null,
      c.group || links.length ? h('p.muted.small', c.group ?? '', ...links.flatMap((l) => [' · ', h('a', { href: l.href }, l.label)])) : null,
      task.artifacts.filter((a) => c.artifacts[a.id]).map((a) => h('figure.shot',
        h('img.bench-overlay', { src: c.artifacts[a.id], alt: `${c.title}: ${a.label}`, loading: 'lazy' }),
        h('figcaption', a.label))),
      h('div.table-wrap', h('table.bench-table.compact',
        h('thead', h('tr', h('th.left', 'Method'), metrics.map((m) => h('th', { title: m.description }, head(m))), h('th', 'Paid in this run'), h('th.left', 'Why'))),
        h('tbody', c.results.map((r) => {
          const method = run.methods.find((m) => m.id === r.method);
          const stat = stats.find((s) => s.method.id === r.method && (!s.row.split || s.row.split === c.dims[task.splitBy ?? '']));
          const why = r.error ?? r.note;
          return h('tr',
            h('td.left', method ? [h('i.fam-dot', { style: `background:${familyColor(task, method)}` }), ' ', methodLabel(task, method)] : r.method),
            metrics.map((m) => (m.id === primary.id
              ? h('td', meter(barOf(m, r.scores[m.id]), { alpha: 0.7, goodness: goodness(m, r.scores[m.id]), text: show(m, r.scores[m.id]) }))
              // A metric summed by its size (a gap that floats or sinks) keeps its sign on a single case.
              : h('td', m.aggregate === 'meanAbs' || m.aggregate === 'medianAbs' ? fSigned(r.scores[m.id], m.digits ?? 1) : show(m, r.scores[m.id])))),
            h('td', r.costUsd ? fUsd(r.costUsd) : (stat && stat.usdPerCase ? h('span.muted', { title: 'Answered from the cache' }, 'cached') : DASH)),
            h('td.left.why', why ? h('details', h('summary', 'why'), h('p', why)) : null),
          );
        })),
      )),
    ));
  });
  return d;
}

