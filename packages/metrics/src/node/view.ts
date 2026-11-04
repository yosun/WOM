// A stored run, as the dashboard gets it: scores summarised, human notes applied, files turned into URLs.
// Read each time a run is shown, so editing a note or an exclusion shows at once.
import { agreementOf, annotationFor, sortMethods, summarize } from '../core/analyze.ts';
import type { Annotation } from '../core/analyze.ts';
import type { CaseView, Extras, ResultView, RunFile, RunView } from '../core/types.ts';
import { taskInfo, type Task } from './define.ts';

/** `/bench-files/<task>/<run>/<path>`: where the routes serve a run's files. */
export function fileUrl(taskId: string, runId: string, rel: string) {
  return `/bench-files/${taskId}/${runId}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * What a run says about its task, with the task's current definition laid over it: wording, thresholds and
 * labels that were improved since the run was made apply to it too. A run of a task nobody registers any more
 * keeps what it stored.
 */
export function taskInfoOf(run: RunFile, task?: Task<any, any>) {
  return task ? { ...run.task, ...taskInfo(task) } : run.task;
}

export function buildRunView(run: RunFile, task?: Task<any, any>): RunView {
  const info = taskInfoOf(run, task);
  const notes: Record<string, Annotation> = task?.annotations?.() ?? {};
  const order = new Map(sortMethods(run.methods).map((m, i) => [m.id, i]));
  const resultsOf = new Map<string, ResultView[]>();
  for (const r of run.results) {
    const v: ResultView = { method: r.method, scores: r.scores, label: r.label, costUsd: r.costUsd, latencyMs: r.latencyMs, note: r.note, error: r.error, details: r.details };
    resultsOf.set(r.case, [...(resultsOf.get(r.case) ?? []), v]);
  }

  const cases: CaseView[] = run.cases.map((c) => {
    const a = annotationFor(c, notes);
    const results = (resultsOf.get(c.id) ?? []).sort((x, y) => (order.get(x.method) ?? 0) - (order.get(y.method) ?? 0));
    const artifacts = Object.fromEntries(Object.entries(c.artifacts ?? {}).map(([id, rel]) => [id, fileUrl(info.id, run.id, rel)]));
    return {
      id: c.id,
      title: c.title,
      group: c.group,
      dims: c.dims,
      revision: c.revision,
      note: a?.note ?? task?.caseNote?.(c, run.results.filter((r) => r.case === c.id)),
      excluded: Boolean(a?.exclude),
      expected: a?.expected,
      artifacts,
      results,
    };
  });
  const excluded = cases.filter((c) => c.excluded).map((c) => c.id);

  const view: Omit<RunView, 'extras'> = {
    id: run.id,
    task: info,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    config: run.config,
    spend: run.spend,
    methods: sortMethods(run.methods),
    summary: summarize(info, run.methods, run.cases, run.results, new Set(excluded)),
    cases,
    excluded,
    agreement: info.labels ? agreementOf(info.labels, cases) : undefined,
    skipped: run.skipped,
  };
  const extra = task?.extras?.(view) ?? {};
  const extras: Extras = { ...extra, tables: extra.tables ?? [], notes: extra.notes ?? [] };
  return { ...view, extras };
}
