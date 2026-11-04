import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PAR_PROTOCOL, assertParCourse, createBenchmark, createMetricsRoutes, Ledger, parDigest,
  parFileDigest, parReferenceSubmission, rankPar, readParCourse, readParSubmission, scorePar, verifyParFiles,
  type ParBallot, type ParCourse, type ParFile, type ParOutput, type ParSubmission,
} from '@wom/metrics';
import { globalTaskFor, parReferenceSubject, parSubject } from '../../server/src/bench/global.ts';

const h = (s: string) => createHash('sha256').update(s).digest('hex');
const f = (name: string, bundle = false): ParFile => ({ path: name, sha256: h(name), ...(bundle ? { kind: 'bundle' as const } : {}) });
const ok = (name: string): ParOutput => ({ status: 'ok', artifact: f(`${name}-world.json`, true), evidence: f(`${name}-evidence.json`, true) });
const failed = (name: string): ParOutput => ({ status: 'failed', reason: 'generation failed, see hashed log', evidence: f(`${name}-failure.json`, true) });

function course(n = 2): ParCourse {
  return {
    protocol: PAR_PROTOCOL, id: 'test-course', label: 'Test course', release: 'pilot', sampling: 'convenience',
    reference: { id: 'wompar-0.1', label: 'WOMPar 0.1', revision: 'frozen-saved-outputs' },
    conditions: f('conditions.json'), rubric: f('rubric.md'),
    evaluation: { id: 'human-v1', kind: 'human', judgesPerTrial: 5 },
    strata: [{ id: 'all', weight: 1 }],
    scenes: Array.from({ length: n }, (_, i) => ({
      id: `photo-${i}`, title: `Photo ${i}`, source: f(`photo-${i}.jpg`), stratum: 'all', trajectory: f(`trajectory-${i}.json`),
      trials: [{ id: 'trial-0', reference: ok(`reference-${i}`) }],
    })),
  };
}

function submission(c: ParCourse, choices: ('win' | 'tie' | 'loss')[] = ['win', 'win', 'win', 'loss', 'loss']): ParSubmission {
  const s = parReferenceSubmission(c, parDigest(c));
  s.method = { id: 'challenger', label: 'Challenger', revision: 'test-revision' };
  for (const x of s.comparisons) {
    const ref = x.candidate;
    x.candidate = ok(`challenger-${x.scene}-${x.trial}`);
    x.ballots = choices.map((choice, i): ParBallot => {
      const side = i % 2 === 0 ? 'A' : 'B';
      return {
        judge: `judge-${i}`, candidateSide: side,
        choice: choice === 'tie' ? 'tie' : choice === 'win' ? side : side === 'A' ? 'B' : 'A',
        candidateEvidence: x.candidate.evidence.sha256, referenceEvidence: ref.evidence.sha256,
      };
    });
  }
  return s;
}
const score = (c: ParCourse, s: ParSubmission) => scorePar(c, parDigest(c), s);

test('frozen WOMPar identity is exactly zero without fabricated ballots', () => {
  const c = course(100), replay = parReferenceSubmission(c, parDigest(c)), r = score(c, replay);
  assert.equal(r.par, 0);
  assert.equal(r.status, 'anchor');
  assert.equal(r.ballots, 0);
  assert.equal(r.coverage.fraction, 1);
  assert.equal(r.interval95, null);
  replay.comparisons[0].candidate.evidence.sha256 = h('changed replay');
  assert.notEqual(c.scenes[0].trials[0].reference.evidence.sha256, replay.comparisons[0].candidate.evidence.sha256);
});

test('signed score has a fixed interpretable scale, including real ties', () => {
  const c = course();
  assert.ok(Math.abs(score(c, submission(c)).par! + 20) < 1e-10);
  for (const [choice, expected] of [['win', -100], ['loss', 100], ['tie', 0]] as const) {
    assert.equal(score(c, submission(c, Array(5).fill(choice))).par, expected);
  }
  assert.equal(score(c, submission(c, ['win', 'win', 'tie', 'loss', 'loss'])).par, 0);
});

test('partial courses and partial panels cannot get a global score', () => {
  const c = course(), s = submission(c);
  s.comparisons.pop();
  let r = score(c, s);
  assert.equal(r.par, null);
  assert.equal(r.coverage.fraction, 0.5);
  assert.equal(r.status, 'incomplete');
  assert.deepEqual(rankPar([r]), []);
  s.comparisons[0].ballots.pop();
  r = score(c, s);
  assert.equal(r.par, null);
  assert.equal(r.coverage.fraction, 0);
  assert.equal(r.ballots, 4);
  assert.equal(r.missing.length, 2);
});

test('evidenced failures lose, successful outputs beat failed references, and both failures tie', () => {
  const c = course(1), s = submission(c);
  s.comparisons[0].candidate = failed('candidate');
  s.comparisons[0].ballots = [];
  assert.equal(score(c, s).par, 100);
  c.scenes[0].trials[0].reference = failed('reference');
  s.courseSha256 = parDigest(c);
  assert.equal(score(c, s).par, 0);
  s.comparisons[0].candidate = ok('candidate');
  assert.equal(score(c, s).par, -100);
});

test('duplicate photographs, trials, comparisons and raters are rejected', () => {
  const c = course(), s = submission(c);
  const duplicatePhoto = structuredClone(c);
  duplicatePhoto.scenes[1].source = duplicatePhoto.scenes[0].source;
  assert.throws(() => assertParCourse(duplicatePhoto), /same source photograph/);
  const duplicateTrial = structuredClone(c);
  duplicateTrial.scenes[0].trials.push(duplicateTrial.scenes[0].trials[0]);
  assert.throws(() => assertParCourse(duplicateTrial), /duplicate\/invalid trial/);
  s.comparisons.push(s.comparisons[0]);
  assert.throws(() => score(c, s), /duplicate comparison/);
  s.comparisons.pop();
  s.comparisons[0].ballots[1].judge = s.comparisons[0].ballots[0].judge;
  assert.throws(() => score(c, s), /human rater voted twice/);
});

test('order counterbalancing, fixed sample sizes and ballot provenance are mandatory', () => {
  const c = course(1);
  let s = submission(c);
  s.comparisons[0].ballots.forEach((b) => { b.candidateSide = 'A'; });
  assert.throws(() => score(c, s), /not counterbalanced/);
  s = submission(c);
  s.comparisons[0].ballots[0].candidateEvidence = h('wrong evidence');
  assert.throws(() => score(c, s), /ballot evidence mismatch/);
  s = submission(c);
  s.comparisons[0].ballots.push({ ...s.comparisons[0].ballots[0], judge: 'extra-rater' });
  assert.throws(() => score(c, s), /too many raters/);
});

test('a scene averages its trials before the frozen stratum weights are applied', () => {
  const c = course(3);
  c.strata = [{ id: 'indoor', weight: 0.5 }, { id: 'outdoor', weight: 0.5 }];
  c.scenes.forEach((v, i) => { v.stratum = i === 0 ? 'indoor' : 'outdoor'; });
  // More trials for one photo must not give it more course weight.
  c.scenes[0].trials.push({ id: 'trial-1', reference: ok('second-reference') });
  const s = submission(c, Array(5).fill('win'));
  for (const x of s.comparisons.filter((x) => x.scene === c.scenes[0].id)) {
    for (const b of x.ballots) b.choice = b.candidateSide === 'A' ? 'B' : 'A';
  }
  const r = score(c, s);
  assert.deepEqual(r.scenes.map((v) => v.weight), [0.5, 0.25, 0.25]);
  assert.equal(r.par, 0);
  assert.equal(r.photographs, 3);
  assert.ok(Math.abs(r.effectivePhotographs - 1 / 0.375) < 1e-10);
});

test('score and ranking stay fixed when ballots are reordered or another entrant arrives', () => {
  const c = course(), a = submission(c), r = score(c, a);
  const reordered = structuredClone(a);
  reordered.comparisons.reverse().forEach((x) => x.ballots.reverse());
  assert.deepEqual(score(c, reordered), r);
  const b = submission(c, Array(5).fill('win'));
  b.method.id = 'better';
  const ref = score(c, parReferenceSubmission(c, parDigest(c)));
  const original = JSON.stringify(rankPar([r, ref]));
  assert.deepEqual(rankPar([r, score(c, b), ref]).map((v) => v.method.id), ['better', 'challenger', 'wompar-0.1']);
  assert.equal(JSON.stringify(rankPar([r, ref])), original);
});

test('changing course, judging track or the reserved reference invalidates a comparison', () => {
  const c = course(), s = submission(c);
  const other = structuredClone(c);
  other.evaluation.id = 'human-v2';
  assert.throws(() => score(other, s), /course hash\/protocol mismatch/);
  const otherSubmission = submission(other);
  otherSubmission.method.id = 'other';
  assert.throws(() => rankPar([score(c, s), score(other, otherSubmission)]), /different courses/);
  s.method = { ...c.reference };
  assert.throws(() => score(c, s), /reserved for an exact replay/);
});

test('model track requires each frozen judge in both orders, neutralizing an always-A panel', () => {
  const c = course(1);
  c.evaluation = { id: 'model-v1', kind: 'model', judgesPerTrial: 3,
    configuration: f('model-evaluator.json'),
    judges: Array.from({ length: 3 }, (_, i) => ({ id: `model-${i}`, revision: `snapshot-${i}` })) };
  const s = submission(c), x = s.comparisons[0];
  x.ballots = c.evaluation.judges!.flatMap((j) => ['A', 'B'].map((side): ParBallot => ({
    judge: j.id, candidateSide: side as 'A' | 'B', choice: 'A',
    candidateEvidence: x.candidate.evidence.sha256, referenceEvidence: c.scenes[0].trials[0].reference.evidence.sha256,
  })));
  assert.equal(score(c, s).par, 0);
  x.ballots.pop();
  assert.equal(score(c, s).par, null);
  x.ballots[0].judge = 'unknown-model';
  assert.throws(() => score(c, s), /too many raters|unknown model judge/);
});

test('pilot uncertainty stays descriptive; independent-scene bounds do not invent extra samples', () => {
  const c = course(100);
  assert.equal(score(c, submission(c)).interval95, null);
  c.release = 'release';
  c.sampling = 'independent';
  const r = score(c, submission(c, Array(5).fill('win')));
  assert.equal(r.interval95![0], -100);
  assert.ok(r.interval95![1] < -70 && r.interval95![1] > -75);
  const small = course(4);
  small.sampling = 'independent';
  const wide = score(small, submission(small, Array(5).fill('tie')));
  assert.deepEqual(wide.interval95, [-100, 100]);
});

test('course hashing ignores JSON object key order but binds every scoring condition', () => {
  const c = course();
  const reversedKeys = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(parDigest(c), parDigest(reversedKeys));
  const amended = structuredClone(c);
  amended.conditions.sha256 = h('amended render conditions');
  assert.notEqual(parDigest(c), parDigest(amended));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wom-par-'));
  const put = async (name: string, value: string | object, bundle = false): Promise<ParFile> => {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
    return { path: name, sha256: await parFileDigest(path.join(root, name)), ...(bundle ? { kind: 'bundle' as const } : {}) };
  };
  const c = course(1), scene = c.scenes[0];
  c.conditions = await put('conditions.json', { renderer: 'fixture' });
  c.rubric = await put('rubric.md', 'Fixture rubric');
  scene.source = await put('source.jpg', 'fixture image');
  scene.trajectory = await put('trajectory.json', { protocol: PAR_PROTOCOL, fovY: 60, aspect: 1.6,
    samples: [{ id: 'home', position: [0, 0, 0], quaternion: [0, 0, 0, 1] }] });
  const world = await put('assets/world.bin', 'fixture geometry');
  const frame = await put('frames/home.jpg', 'fixture render');
  const clip = await put('walkthrough.mp4', 'fixture walkthrough');
  scene.trials[0].reference = {
    status: 'ok', artifact: await put('world.json', { format: 'wom-par-bundle-v1', files: [world] }, true),
    evidence: await put('evidence.json', {
      format: 'wom-par-bundle-v1', files: [frame, clip],
      provenance: { protocol: PAR_PROTOCOL, status: 'ok', sourceSha256: scene.source.sha256,
        trajectorySha256: scene.trajectory.sha256, conditionsSha256: c.conditions.sha256,
        cameraSamples: [{ id: 'home', frameSha256: frame.sha256 }], walkthroughSha256: clip.sha256 },
    }, true),
  };
  await put('course.json', c);
  return { root, c, put };
}

test('artifact verifier checks nested bytes even if a bundle was first listed as a plain file', async () => {
  const { root, c } = await fixture();
  try {
    await readParCourse(path.join(root, 'course.json'));
    await writeFile(path.join(root, 'assets/world.bin'), 'changed geometry');
    const ref = c.scenes[0].trials[0].reference;
    assert.equal(ref.status, 'ok');
    if (ref.status !== 'ok') return;
    const plain = { ...ref.artifact, kind: undefined };
    await assert.rejects(verifyParFiles(root, [plain, ref.artifact]), /artifact hash mismatch/);
    await assert.rejects(readParCourse(path.join(root, 'course.json')), /artifact hash mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('safe paths and real paths prevent traversal and escaping symlinks', async () => {
  const { root } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'wom-par-outside-'));
  try {
    await writeFile(path.join(outside, 'secret'), 'outside');
    await symlink(path.join(outside, 'secret'), path.join(root, 'escaped'));
    await assert.rejects(verifyParFiles(root, [{ path: '../escape', sha256: h('x') }]), /unsafe artifact path/);
    await assert.rejects(verifyParFiles(root, [{ path: 'escaped', sha256: h('outside') }]), /leaves artifact root/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('valid file hashes do not excuse evidence from different camera/source conditions', async () => {
  const { root, c, put } = await fixture();
  try {
    const ref = c.scenes[0].trials[0].reference;
    const evidence = JSON.parse(await readFile(path.join(root, ref.evidence.path), 'utf8'));
    evidence.provenance.trajectorySha256 = h('different trajectory');
    ref.evidence = await put('evidence.json', evidence, true);
    await put('course.json', c);
    await assert.rejects(readParCourse(path.join(root, 'course.json')), /trajectory mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a panel cannot turn incomplete camera coverage into a finished score', async () => {
  const { root, c, put } = await fixture();
  try {
    const ref = c.scenes[0].trials[0].reference;
    const evidence = JSON.parse(await readFile(path.join(root, ref.evidence.path), 'utf8'));
    evidence.provenance.cameraSamples = [];
    ref.evidence = await put('evidence.json', evidence, true);
    await put('course.json', c);
    await assert.rejects(readParCourse(path.join(root, 'course.json')), /incomplete camera frames/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('complete-course results, original ballots and unranked incomplete entries survive HTTP/report storage', async () => {
  const { root, put } = await fixture();
  try {
    const loaded = await readParCourse(path.join(root, 'course.json'));
    const incomplete: ParSubmission = { protocol: PAR_PROTOCOL, courseSha256: loaded.sha256,
      method: { id: 'unfinished', label: 'Unfinished', revision: 'test' }, comparisons: [] };
    await put('submission.json', incomplete);
    assert.deepEqual(await readParSubmission(path.join(root, 'submission.json'), loaded), incomplete);
    const task = globalTaskFor(loaded);
    const bench = createBenchmark({ dir: path.join(root, 'runs'), ledger: new Ledger(path.join(root, 'ledger.jsonl')) }).register(task);
    const run = await bench.run(task, [parReferenceSubject(loaded), parSubject(incomplete)], { log() {} });
    assert.equal(run.results[0].scores.par, 0);
    assert.equal(run.results[1].scores.par, null);
    assert.equal(run.cases.length, 1);
    assert.equal(run.spend.usd, 0);
    const routes = createMetricsRoutes(bench);
    const response = await routes.request(`/api/bench/global/runs/${run.id}`);
    assert.equal(response.status, 200);
    const view = await response.json() as any;
    assert.equal(view.summary.find((s: any) => s.method === 'unfinished').scores.par, null);
    const inputs = await routes.request(`/bench-files/global/${run.id}/inputs.json`);
    assert.equal((await inputs.json() as any).courseSha256, loaded.sha256);
    const report = await readFile(path.join(root, 'runs/global', run.id, 'scorecard.md'), 'utf8');
    assert.match(report, /unranked/);
    assert.match(report, /without invented self-comparison ballots/);
    const generic = await readFile(path.join(root, 'runs/global', run.id, 'report.md'), 'utf8');
    assert.match(generic, /^\[Global scorecard\]\(scorecard.md\)/m);
    assert.doesNotMatch(generic, /!\[Global scorecard\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
