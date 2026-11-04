// Public-safe reference metadata. Reading a facts page never runs an evaluation or regenerates a world.
import { readFile } from 'node:fs/promises';
import { assertParCourse, parDigest, RunStore, type ParCourse, type ParScore, type ParStatus, type RunFile } from '@wom/metrics';
import { BENCH_DIR } from './cache.ts';
import { DEFAULT_PAR_COURSE } from './global.ts';

export async function currentParStatus(courseFile = DEFAULT_PAR_COURSE, benchDir = BENCH_DIR): Promise<ParStatus | null> {
  let course: ParCourse;
  try {
    course = JSON.parse(await readFile(courseFile, 'utf8')) as ParCourse;
    assertParCourse(course);
  } catch { return null; }
  const sha256 = parDigest(course);
  const store = new RunStore(benchDir);
  let evaluation: ParStatus['evaluation'] = null;
  for (const id of store.ids('global')) {
    const run = store.raw('global', id) as RunFile | null;
    if (run?.format !== 2 || run.config?.courseSha256 !== sha256 || !Array.isArray(run.results)) continue;
    const scores = run.results.map((r) => r?.details?.parScore as ParScore | undefined).filter((s): s is ParScore =>
      Boolean(s && s.method?.id && s.courseSha256 === sha256 && s.track === course.evaluation.id && Number.isSafeInteger(s.ballots) && s.ballots >= 0));
    const reference = scores.find((s) => s.method.id === course.reference.id && s.status === 'anchor' && s.par === 0);
    if (!reference) continue;
    evaluation = { run: id, finishedAt: run.finishedAt ?? null, actualBallots: scores.reduce((n, s) => n + s.ballots, 0) };
    break;
  }
  return {
    schema: 'wom-par-status/1', protocol: course.protocol,
    course: { id: course.id, label: course.label, sha256, release: course.release, photographs: course.scenes.length,
      trials: course.scenes.reduce((n, s) => n + s.trials.length, 0) },
    reference: { id: course.reference.id, label: course.reference.label, score: 0 },
    track: { id: course.evaluation.id, kind: course.evaluation.kind }, evaluation,
    generation: { score: null, status: 'not-ranked' },
  };
}
