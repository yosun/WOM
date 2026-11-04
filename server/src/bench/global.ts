// One complete course is one benchmark case. The generic runner must never average a partial course.
import path from 'node:path';
import {
  defineSubject, defineTask, parReferenceSubmission, rankPar, readParCourse, scorePar,
  type Case, type LoadedParCourse, type ParScore, type ParSubmission, type Task,
} from '@wom/metrics';
import { DATA_DIR, ROOT } from '../config.ts';

export const DEFAULT_PAR_COURSE = path.join(ROOT, 'docs/wom-par/courses/0.1-pilot.json');
export const DEFAULT_PAR_ARTIFACTS = path.join(DATA_DIR, 'par-courses/wompar-0.1-pilot');

const scoreOf = (details?: Record<string, unknown>) => details?.parScore as ParScore | undefined;

export function parSubject(submission: ParSubmission, baseline = false) {
  return defineSubject<LoadedParCourse, ParSubmission>({
    id: submission.method.id,
    label: submission.method.label,
    methods: [{ ...submission.method, family: baseline ? 'reference' : 'challenger', baseline }],
    async solve() { return [{ method: submission.method.id, answer: submission }]; },
  });
}

/** Freeze the already verified manifest in this task; no filesystem re-read during a run. */
export function globalTaskFor(loaded?: LoadedParCourse): Task<LoadedParCourse, ParSubmission> {
  return defineTask({
    id: 'global', label: 'Global', kind: 'metrics',
    description: 'Complete-world preference against a frozen WOMPar course. Zero is par; negative is better.',
    question: 'Does the complete reconstructed world beat the frozen WOMPar reference?',
    primary: 'par',
    metrics: [
      { id: 'par', label: 'Par', better: 'lower', digits: 1, range: [-100, 100], description: '100 × (loss share − win share), averaged by trial, photograph and fixed stratum. Only a complete course has a score.' },
      { id: 'coverage', label: 'Course coverage', better: 'higher', format: 'percent', description: 'Required scene/trials with a complete judging panel, exact identity or an evidenced failure.' },
      { id: 'ballots', label: 'Actual ballots', better: 'higher', digits: 0, advanced: true, description: 'Evidence count, not quality. Reference identity needs no votes.' },
    ],
    families: [{ id: 'reference', label: 'Frozen par', color: '#b7a16b' }, { id: 'challenger', label: 'Challengers', color: '#6aaec6' }],
    dimensions: [{ id: 'course', label: 'Course' }, { id: 'track', label: 'Judging track' }],
    artifacts: [{ id: 'scorecard', label: 'Global scorecard', kind: 'file' }, { id: 'inputs', label: 'Manifest and ballots', kind: 'file' }],
    tie: 1e-9, gain: 1e-9, smallSample: 1,
    caveat: 'Par is relative to the named course and judging track. Reference zero is an anchor, not evidence of perfect quality. Pilot and model-panel scores are descriptive. A lower point estimate alone does not establish a population-level improvement.',
    howToRun: 'npm run bench:global -- --submissions <submission.json,...>; the command verifies frozen artifacts and imports real ballots without making model calls.',
    groupLabel: 'course',
    async cases(selection) {
      const data = loaded ?? await readParCourse(selection.course?.[0] ?? DEFAULT_PAR_COURSE, selection.artifacts?.[0] ?? DEFAULT_PAR_ARTIFACTS);
      const c: Case<LoadedParCourse> = {
        id: data.course.id, title: data.course.label, group: data.course.label,
        dims: { course: data.course.id, track: data.course.evaluation.id }, data,
      };
      return { cases: [c] };
    },
    score(c, submission) {
      const result = scorePar(c.data.course, c.data.sha256, submission);
      return {
        scores: { par: result.par, coverage: result.coverage.fraction, ballots: result.ballots },
        note: `${result.status}; ${result.photographs} distinct photographs; ${result.coverage.complete}/${result.coverage.expected} required trials; ${result.ballots} actual ballots. ${result.uncertainty}`,
        details: { parScore: result },
      };
    },
    async finish(c, scored, ctx) {
      const scores = scored.map((s) => scoreOf(s.outcome.details)).filter((s): s is ParScore => Boolean(s));
      // Also verifies that no method from another course/track slipped into this report.
      const ranked = rankPar(scores);
      const lines = [
        `# ${c.data.course.label}`, '',
        `Protocol: ${c.data.course.protocol}. Course SHA-256: \`${c.data.sha256}\`.`, '',
        `Track: ${c.data.course.evaluation.id} (${c.data.course.evaluation.kind}). Release: **${c.data.course.release}**.`, '',
        '**0 = par; lower is better.** Reference zero is defined by frozen output identity, without invented self-comparison ballots.', '',
        '| Method | Par | Status | Trials | Actual ballots |', '| --- | ---: | --- | ---: | ---: |',
        ...[...ranked, ...scores.filter((s) => s.par === null)].map((s) =>
          `| ${s.method.label.replaceAll('|', '\\|')} | ${s.par === null ? 'unranked' : s.par.toFixed(2)} | ${s.status} | ${s.coverage.complete}/${s.coverage.expected} | ${s.ballots} |`), '',
        'Each photograph has fixed influence. Frames, objects, judges and generation trials are not independent photographs. Cost and latency are separate diagnostics.', '',
        ...scores.flatMap((s) => [`## ${s.method.label}`, '', s.uncertainty, '',
          ...(s.interval95 ? [`Conditional 95% scene bound: [${s.interval95[0].toFixed(2)}, ${s.interval95[1].toFixed(2)}].`, ''] : []),
          ...s.missing.map((m) => `- ${m}`), ...(s.missing.length ? [''] : []),
          '| Photograph | Weight | Par | Trials |', '| --- | ---: | ---: | ---: |',
          ...s.scenes.map((v) => `| ${v.scene} | ${v.weight.toFixed(4)} | ${v.par === null ? 'unscored' : v.par.toFixed(2)} | ${v.complete}/${v.trials} |`), '']),
      ];
      return { artifacts: {
        scorecard: await ctx.write('scorecard.md', lines.join('\n')),
        inputs: await ctx.write('inputs.json', JSON.stringify({
          course: c.data.course, courseSha256: c.data.sha256,
          submissions: scored.map((s) => s.answer.answer).filter(Boolean), scores,
        }, null, 2)),
      } };
    },
    extras(view) {
      const results = view.cases.flatMap((c) => c.results).map((r) => scoreOf(r.details)).filter((s): s is ParScore => Boolean(s));
      return {
        notice: `Reference zero is an anchor. This ${results[0]?.release ?? 'named'} course has ${results[0]?.photographs ?? 0} photographs and ${results.reduce((n, r) => n + r.ballots, 0)} actual comparison ballots in this run. Spend shown here is evaluation import only; generation cost and time are separate.`,
        notes: [
          'Zero for the reference is definitional. Actual human/model ballot counts are reported separately.',
          'Only complete courses rank. Judge panels, output bytes, photographs, paths, render conditions and rubric are bound to the course hash.',
          ...new Set(results.map((s) => s.uncertainty)),
        ],
        tablesTitle: 'Every photograph',
        tables: results.length ? [{
          id: 'global-photos', title: 'Par by photograph', metric: 'par', caption: 'Diagnostic breakdown; the published Par uses the frozen photograph/stratum weights.',
          columns: results.map((s) => ({ id: s.method.id, label: s.method.label })),
          rows: results[0].scenes.map((s) => ({
            id: s.scene, label: s.scene, sub: `weight ${s.weight.toFixed(4)}`,
            cells: results.map((r) => ({ value: r.scenes.find((v) => v.scene === s.scene)?.par ?? null })),
          })),
        }] : [],
      };
    },
  });
}

export const globalTask = globalTaskFor();
export const parReferenceSubject = (loaded: LoadedParCourse) => parSubject(parReferenceSubmission(loaded.course, loaded.sha256), true);
