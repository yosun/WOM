// The dashboard page: the name, which run each task shows, and the tabs. The tabs are an overview, one for each
// task the server reports, the application's own (MetricsUiHost.tabs), and spend. They live in one page, so
// switching is instant and each tab keeps its filters and sort order while you look at another.
import type { RunItem, TaskInfo, TaskItem } from '../core/types.ts';
import { valueLabel } from './analytics.ts';
import { womHeader } from './brand.ts';
import { MetricsData } from './data.ts';
import { clear, h } from './dom.ts';
import { fUsd, fWhen, plural } from './format.ts';
import type { MetricsContext, MetricsUiHost, View, ViewTarget } from './host.ts';
import { overviewView } from './views/overview.ts';
import { resultsView } from './views/results.ts';
import { spendView } from './views/spend.ts';
import { verdictsView } from './views/verdicts.ts';

export interface MetricsRoute {
  /** The run to show for the task of the tab. */
  run?: string;
  tab?: string;
}

/**
 * #/bench, #/bench/<tab>, #/bench/<run>, #/bench/<run>/<tab> or #/bench/<tab>/<run>. Null for any other hash,
 * so the application's router can try its next route.
 */
export function matchMetricsRoute(hash: string): MetricsRoute | null {
  const m = /^#\/bench(?:\/([0-9][0-9-]*))?(?:\/([a-z][a-z0-9-]*))?(?:\/([0-9][0-9-]*))?$/.exec(hash);
  return m ? { run: m[1] ?? m[3], tab: m[2] } : null;
}

const DEFAULT_LEDE = 'Scores what was built against what it was built from. Each task below measures one thing, and the last tab says what it all cost.';

interface TabSpec {
  id: string;
  label: string;
  question: string;
  /** The task whose run the tab shows, which is what the run picker lists. */
  task?: string;
  make(ctx: MetricsContext): View;
}

/** `Nov 1, 9:58 PM · 22 cases · IDOL, Tripo P1 · MoGe-3 · no new model calls · 20261101-215829` */
export function runLabel(task: TaskInfo | undefined, r: RunItem) {
  const spent = r.spendUsd > 0 ? `${fUsd(r.spendUsd)} spent` : 'no new model calls';
  const named = (task?.dimensions ?? [])
    .filter((d) => d.show !== 'never')
    .map((d) => (r.dims[d.id] ?? []).map((v) => (task ? valueLabel(task, d.id, v) : v)).join(', '))
    .filter(Boolean);
  return [fWhen(r.finishedAt) || r.id, plural(r.caseCount, 'case'), ...named, spent, r.id].join(' · ');
}

export function mountMetrics(root: HTMLElement, route: MetricsRoute = {}, host: MetricsUiHost = {}): () => void {
  clear(root);
  const data = new MetricsData();
  let disposed = false;
  let tab = route.tab ?? 'overview';
  let tasks: TaskItem[] = [];
  let tabs: TabSpec[] = [];
  /** The run a person picked, by task. Tasks not in it show their newest run. */
  const chosen = new Map<string, string>();
  const views = new Map<string, View>();

  const taskOf = (id: string) => tabs.find((t) => t.id === id)?.task;
  const infoOf = (id: string | undefined) => tasks.find((t) => t.info.id === id)?.info;

  const syncUrl = () => {
    const run = chosen.get(taskOf(tab) ?? '');
    const hash = `#/bench${run ? `/${run}` : ''}/${tab}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
  };

  const ctx: MetricsContext = {
    data,
    host,
    isDisposed: () => disposed,
    go: (next, target) => show(next, target),
    href: (next) => {
      const run = chosen.get(taskOf(next) ?? '');
      return `#/bench${run ? `/${run}` : ''}/${next}`;
    },
    runs: (task) => data.runs(task),
    run: async (task) => {
      const runs = await data.runs(task);
      if (!runs.length) return null;
      const want = chosen.get(task);
      return data.run(task, want && runs.some((r) => r.id === want) ? want : runs[0].id);
    },
  };

  // ----- header: the name, and which run the tab shows -----
  const select = h('select', { 'aria-label': 'Run' }) as HTMLSelectElement;
  const runLinks = h('span.run-links');
  const pickerLabel = h('span', 'Run');
  const picker = h('label.run-picker', pickerLabel, select, runLinks);
  picker.hidden = true;

  const drawRunLinks = (task: string) => {
    clear(runLinks);
    // The label can be longer than the box, so the full text is also the tooltip.
    select.title = select.selectedOptions[0]?.textContent ?? '';
    if (!select.value) return;
    runLinks.append(
      h('a', { href: data.fileUrl(task, select.value, 'report.md'), target: '_blank', rel: 'noopener', title: 'The report the benchmark wrote: tables and overlay sheets' }, 'Report'),
      h('a', { href: data.fileUrl(task, select.value, 'results.json'), target: '_blank', rel: 'noopener', title: 'Every answer, tool call and score of the run' }, 'Raw data'),
    );
  };

  async function drawPicker() {
    const task = taskOf(tab);
    picker.hidden = !task;
    if (!task) return;
    const runs = await data.runs(task).catch((): RunItem[] => []);
    if (disposed || taskOf(tab) !== task) return;
    const info = infoOf(task);
    pickerLabel.textContent = `${info?.label ?? task} run`;
    select.setAttribute('aria-label', `${info?.label ?? task} run`);
    clear(select);
    const want = chosen.get(task);
    const current = want && runs.some((r) => r.id === want) ? want : runs[0]?.id;
    for (const r of runs) select.append(h('option', { value: r.id, selected: r.id === current }, runLabel(info, r)));
    picker.hidden = !runs.length;
    drawRunLinks(task);
  }

  select.addEventListener('change', () => {
    const task = taskOf(tab);
    if (!task) return;
    chosen.set(task, select.value);
    // Every tab that reads a run is built again when it is next opened (the verdict tabs read the others' runs too).
    for (const spec of tabs) {
      if (spec.task || spec.id === 'overview') {
        views.get(spec.id)?.el.remove();
        views.delete(spec.id);
      }
    }
    drawRunLinks(task);
    show(tab);
  });

  // ----- tabs -----
  const tablist = h('div.wom-tabs-inner', { role: 'tablist', 'aria-label': 'Metrics' });
  const buttons = new Map<string, HTMLButtonElement>();
  const tabsBar = h('div.wom-tabs', tablist);
  const content = h('div.wom-content', h('p.muted.loading', 'Loading…'));

  tablist.addEventListener('keydown', (e) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = tabs[(next + tabs.length) % tabs.length].id;
    show(target);
    buttons.get(target)?.focus();
  });

  function buildTabs() {
    const primary = tasks.find((t) => t.info.kind === 'metrics')?.info.id ?? tasks[0]?.info.id;
    tabs = [
      { id: 'overview', label: 'Overview', question: 'The short version', task: primary, make: overviewView },
      ...tasks.map((t): TabSpec => ({
        id: t.info.id,
        label: t.info.label,
        question: t.info.question ?? t.info.description?.split('. ')[0] ?? t.info.label,
        task: t.info.id,
        make: (c) => (t.info.kind === 'verdicts' ? verdictsView(c, t.info) : resultsView(c, t.info)),
      })),
      ...(host.tabs ?? []).map((t): TabSpec => ({ id: t.id, label: t.label, question: t.question, make: (c) => t.view(c) })),
      { id: 'spend', label: 'Spend', question: 'What did it all cost?', make: spendView },
    ];
    for (const spec of tabs) {
      const btn = h('button.wom-tab', {
        type: 'button',
        role: 'tab',
        id: `wom-tab-${spec.id}`,
        'aria-controls': `wom-panel-${spec.id}`,
        title: spec.question,
        onclick: () => show(spec.id),
      }, spec.label) as HTMLButtonElement;
      buttons.set(spec.id, btn);
      tablist.append(btn);
    }
    if (!tabs.some((t) => t.id === tab)) tab = 'overview';
    // A run named in the address is the one the tab's task shows; with no tab named it is the overview's.
    const task = taskOf(tab);
    if (route.run && task) chosen.set(task, route.run);
  }

  function show(next: string, target?: ViewTarget) {
    const spec = tabs.find((t) => t.id === next) ?? tabs[0];
    if (!spec) return;
    tab = spec.id;
    let view = views.get(tab);
    if (!view) {
      view = spec.make(ctx);
      view.el.id = `wom-panel-${tab}`;
      view.el.setAttribute('role', 'tabpanel');
      view.el.setAttribute('aria-labelledby', `wom-tab-${tab}`);
      views.set(tab, view);
      content.append(view.el);
    }
    for (const [id, v] of views) v.el.hidden = id !== tab;
    for (const [id, btn] of buttons) {
      btn.setAttribute('aria-selected', String(id === tab));
      btn.tabIndex = id === tab ? 0 : -1;
    }
    void drawPicker();
    syncUrl();
    if (target && view.focus) {
      view.focus(target);
    } else {
      // Land at the top of the new tab, just under the tab bar.
      const top = content.getBoundingClientRect().top + window.scrollY - tabsBar.offsetHeight - 12;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
    }
  }

  root.append(h('main.bench.wom',
    womHeader({ lede: host.lede ?? DEFAULT_LEDE, back: host.back, controls: picker }),
    tabsBar,
    content,
  ));

  // The tabs depend on which tasks the server has. If it cannot say, the overview reports why.
  void data.tasks().then((t) => { tasks = t; }, () => { tasks = []; }).then(() => {
    if (disposed) return;
    clear(content);
    buildTabs();
    show(tab);
  });

  return () => { disposed = true; };
}
