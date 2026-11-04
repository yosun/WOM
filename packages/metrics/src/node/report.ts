// The markdown report of a run: the same tables the dashboard shows, for reading in an editor or a review.
import { formatScore, isNum } from '../core/analyze.ts';
import type { CaseView, MetricSpec, RunView } from '../core/types.ts';

const md = (s: string) => s.replace(/\|/g, '/').replace(/\n/g, ' ');
const head = (m: MetricSpec) => `${m.label}${m.unit ? ` (${m.unit})` : ''} ${m.better === 'higher' ? '↑' : '↓'}`;

export function renderReport(view: RunView): string {
  const { task } = view;
  const L: string[] = [];
  const label = (id: string) => view.methods.find((m) => m.id === id)?.label ?? id;
  const subjectOf = (id: string) => view.methods.find((m) => m.id === id)?.subjectLabel;
  const name = (id: string) => `${label(id)}${subjectOf(id) ? ` · ${subjectOf(id)}` : ''}`;
  // What sets a case apart, in words: its dimensions (unless the title already says it) and its revision.
  const detail = (c: CaseView) => [
    ...task.dimensions
      .filter((d) => d.show !== 'never' && c.dims[d.id])
      .map((d) => d.values?.[c.dims[d.id]]?.label ?? c.dims[d.id]),
    ...(task.revision && (c.revision ?? 1) > 1 ? [`${task.revision.label} v${c.revision}`] : []),
  ];

  L.push(`# ${task.label} run ${view.id}`, '');
  const cfg = Object.entries(view.config).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`);
  if (cfg.length) L.push(cfg.join(' · '), '');
  L.push(`Cases: ${view.cases.length} · new calls: ${view.spend.newCalls} ($${view.spend.usd.toFixed(3)}) · answered from cache: ${view.spend.cachedCalls}`);
  if (view.skipped.length) L.push(`Skipped: ${view.skipped.join('; ')}`);
  L.push('');
  if (task.description) L.push(task.description, '');
  if (view.extras.notice) L.push(view.extras.notice, '');
  L.push(`Metrics: ${task.metrics.map((m) => `${m.label}${m.description ? `: ${m.description}` : ''}`).join(' · ')}`, '');
  if (view.excluded.length) {
    L.push(`Left out of the table (see the case notes): ${view.excluded.map((id) => { const c = view.cases.find((x) => x.id === id); return `${id}${c?.note ? ` — ${c.note}` : ''}`; }).join('; ')}`, '');
  }

  const metrics = task.metrics;
  L.push(`| Method | Cases | ${metrics.map(head).join(' | ')} | Top | Cost $ | Time s |`);
  L.push(`| --- | --: |${' --: |'.repeat(metrics.length)} --: | --: | --: |`);
  for (const s of view.summary) {
    L.push(`| ${md(name(s.method))}${s.split ? ` @${s.split}` : ''} | ${s.n}${s.failed ? ` (+${s.failed} failed)` : ''} | ${metrics.map((m) => formatScore(m, s.scores[m.id], false)).join(' | ')} | ${s.wins} | ${s.costUsd.toFixed(3)} | ${s.latencyS === null ? '–' : s.latencyS.toFixed(1)} |`);
  }
  L.push('');

  if (view.agreement?.labelled) {
    const a = view.agreement;
    L.push('## Against the labels', '', `${a.exact} of ${a.labelled} verdicts match. Most severe caught: ${a.severe.caught} of ${a.severe.total}. Clean flagged: ${a.clean.flagged} of ${a.clean.total}.`, '');
  }

  const { tables, notes } = view.extras;
  if (tables.length) {
    L.push(`## ${view.extras.tablesTitle ?? 'Tables'}`, '');
    if (view.extras.tablesCaption) L.push(view.extras.tablesCaption, '');
    const cell = (c: { value: number | null; secondary?: number | null }) => `${isNum(c.value) ? c.value.toFixed(2) : '–'}${c.secondary !== undefined ? ` / ${isNum(c.secondary) ? c.secondary.toFixed(2) : '–'}` : ''}`;
    for (const t of tables) {
      const total = t.rows.some((r) => r.total);
      L.push(`**${md(t.title)}**`, '');
      if (t.caption) L.push(t.caption, '');
      L.push(`| | ${t.columns.map((c) => md(c.label)).join(' | ')} |${total ? ' Mean |' : ''}`, `| --- |${' --: |'.repeat(t.columns.length + (total ? 1 : 0))}`);
      for (const r of t.rows) L.push(`| ${md(r.label)}${r.sub ? ` ${md(r.sub)}` : ''} | ${r.cells.map(cell).join(' | ')} |${r.total ? ` ${cell(r.total)} |` : ''}`);
      L.push('');
    }
  }
  if (notes.length) {
    L.push(`## ${view.extras.notesTitle ?? 'Notes'}`, '');
    if (view.extras.notesCaption) L.push(view.extras.notesCaption, '');
    for (const n of notes) L.push(`- ${n}`);
    L.push('');
  }

  L.push('## Cases', '');
  for (const c of view.cases) {
    L.push(`### ${[c.title, ...detail(c), c.group].filter(Boolean).join(' · ')}`, '');
    if (c.note) L.push(`> ${c.excluded ? 'Not in the summary. ' : ''}${c.note}`, '');
    for (const [id, url] of Object.entries(c.artifacts)) {
      const artifact = task.artifacts.find((a) => a.id === id);
      L.push(`${artifact?.kind === 'file' ? '' : '!'}[${artifact?.label ?? id}](${url.replace(/^\/bench-files\/[^/]+\/[^/]+\//, '')})`, '');
    }
    L.push(`| Method | ${metrics.map((m) => m.label).join(' | ')} | Notes |`, `| --- |${' --: |'.repeat(metrics.length)} --- |`);
    for (const r of c.results) {
      const notes = [r.error, r.label ? `verdict ${r.label}${c.expected && c.expected !== r.label ? ` (expected ${c.expected})` : ''}` : '', r.note].filter(Boolean).join('; ');
      L.push(`| ${md(name(r.method))} | ${metrics.map((m) => formatScore(m, r.scores[m.id], false)).join(' | ')} | ${md(notes)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}
