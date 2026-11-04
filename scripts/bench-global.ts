// Imports reviewed comparisons; never generates worlds, calls a judge or makes up ballots.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PAR_PROTOCOL, readParCourse, readParSubmission, type ParSubmission } from '@wom/metrics';
import { DEFAULT_PAR_ARTIFACTS, DEFAULT_PAR_COURSE, globalTaskFor, parReferenceSubject, parSubject } from '../server/src/bench/global.ts';
import { bench } from '../server/src/bench/suite.ts';

const args = process.argv.slice(2);
const options = new Set(['--course', '--artifacts', '--submissions', '--submission-root', '--template']);
const seen = new Set<string>();
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--help') continue;
  if (!options.has(args[i]) || seen.has(args[i])) throw new Error(`Unknown or repeated option: ${args[i]}`);
  seen.add(args[i]);
  if (!args[++i] || args[i].startsWith('--')) throw new Error('Each option requires a value; use --help');
}
const opt = (key: string) => {
  const i = args.indexOf(`--${key}`);
  if (i < 0) return undefined;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`--${key} requires a value`);
  return args[i + 1];
};
if (args.includes('--help')) {
  console.log('bench:global [--course <json>] [--artifacts <root>] [--submissions <json,...>] [--submission-root <root>] [--template <new.json>]\nVerifies content hashes, scores the frozen reference and imports real ballots. No API calls.');
} else {
  const loaded = await readParCourse(opt('course') ?? DEFAULT_PAR_COURSE, opt('artifacts') ?? DEFAULT_PAR_ARTIFACTS);
  const template = opt('template');
  if (template) {
    const submission: ParSubmission = {
      protocol: PAR_PROTOCOL, courseSha256: loaded.sha256,
      method: { id: 'your-method', label: 'Your method', revision: 'record code, models, configuration and generation seeds here' },
      setup: {
        schema: 'wom-agent-setup/1', id: 'your-method', label: 'Your method', revision: 'record code, models, configuration and generation seeds here',
        runner: { kind: 'command', argv: ['your-runner', '--input', '{photo}', '--output', '{output}'] },
        adapter: { id: 'your-rendering-adapter', revision: 'v1' }, models: [], agents: [], environment: [],
      },
      comparisons: [],
    };
    await writeFile(template, JSON.stringify(submission, null, 2) + '\n', { flag: 'wx' });
    console.log(`Created an unscored submission template: ${template}`);
  } else {
    const files = opt('submissions')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    const subjects = [parReferenceSubject(loaded)];
    for (const file of files) {
      const submission = await readParSubmission(file, loaded, opt('submission-root') ?? path.dirname(path.resolve(file)));
      subjects.push(parSubject(submission));
    }
    const run = await bench.run(globalTaskFor(loaded), subjects, {
      maxUsd: 0, concurrency: 1,
      config: { protocol: PAR_PROTOCOL, course: loaded.course.id, courseSha256: loaded.sha256, track: loaded.course.evaluation.id, artifactsVerified: true, submissions: files },
    });
    if (run.skipped.length || run.results.length !== subjects.length || run.results.some((r) => r.error || r.scores.par == null)) process.exitCode = 2;
  }
}
