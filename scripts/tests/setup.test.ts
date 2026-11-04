import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  assertAgentSetup, parDigest, parFileDigest, parReferenceSubmission, readParSubmission, RunStore, scorePar,
  type AgentSetup, type ParCourse, type ParSubmission, type RunFile,
} from '@wom/metrics';

const setup = (): AgentSetup => ({
  schema: 'wom-agent-setup/1', id: 'outside-agent', label: 'Outside agent', revision: 'code-and-model-v1',
  runner: { kind: 'command', argv: ['python', 'agent.py', '--photo', '{photo}', '--output', '{output}'] },
  adapter: { id: 'radiance-field-renderer', revision: 'adapter-v1' },
  models: [{ id: 'provider/model-v1', provider: 'provider', role: 'Reconstruction' }],
  agents: [{ id: 'builder', role: 'Generate and inspect', model: 'provider/model-v1', tools: ['render', 'inspect'] }],
  environment: ['OPENAI_API_KEY'],
});

test('one setup descriptor supports a non-WOM renderer without masks, separate objects or WOM models', () => {
  assert.doesNotThrow(() => assertAgentSetup(setup()));
  const deterministic = setup();
  deterministic.models = [];
  deterministic.agents = [];
  deterministic.environment = [];
  deterministic.runner = { kind: 'http', path: '/reconstruct' };
  assert.doesNotThrow(() => assertAgentSetup(deterministic));
});

test('setup validation rejects mismatched model references, duplicates and environment values', () => {
  let s = setup();
  s.agents[0].model = 'unknown';
  assert.throws(() => assertAgentSetup(s), /model reference/);
  s = setup();
  s.agents[0].tools.push('render');
  assert.throws(() => assertAgentSetup(s), /tool/);
  s = setup();
  s.environment = ['OPENAI_API_KEY=placeholder-value'];
  assert.throws(() => assertAgentSetup(s), /never values/);
  s = setup();
  s.runner = { kind: 'http', path: '//outside.example/path' };
  assert.throws(() => assertAgentSetup(s), /HTTP runner/);
  s = setup();
  s.configuration = null as any;
  assert.throws(() => assertAgentSetup(s), /configuration/);
});

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wom-setup-'));
process.env.WOM_DATA_DIR = dataDir;
process.env.WOM_STORE = 'fs';
process.env.WOM_AUTH = 'off';
const { currentParStatus } = await import('../../server/src/bench/par-summary.ts');
const { app } = await import('../../server/src/index.ts');
const { setResolverForTests } = await import('../../server/src/access.ts');
after(async () => { setResolverForTests(null); await rm(dataDir, { recursive: true, force: true }); });
const courseFile = path.resolve('docs/wom-par/courses/0.1-pilot.json');
const course = JSON.parse(await readFile(courseFile, 'utf8')) as ParCourse;

test('setup identity and revision must describe exactly the method being scored', () => {
  const p = setup();
  const submission: ParSubmission = { protocol: course.protocol, courseSha256: parDigest(course),
    method: { id: p.id, label: p.label, revision: p.revision }, setup: p, comparisons: [] };
  assert.equal(scorePar(course, parDigest(course), submission).par, null);
  submission.setup!.revision = 'different';
  assert.throws(() => scorePar(course, parDigest(course), submission), /identity\/revision differ/);
});

test('the importer verifies a contributed setup configuration without executing its runner', async () => {
  const s = setup();
  await writeFile(path.join(dataDir, 'configuration.json'), '{"seed": 7}');
  s.configuration = { path: 'configuration.json', sha256: await parFileDigest(path.join(dataDir, 'configuration.json')) };
  const submission: ParSubmission = { protocol: course.protocol, courseSha256: parDigest(course), setup: s,
    method: { id: s.id, label: s.label, revision: s.revision }, comparisons: [] };
  const file = path.join(dataDir, 'submission.json');
  await writeFile(file, JSON.stringify(submission));
  const loaded = { course, sha256: parDigest(course), root: dataDir };
  assert.equal((await readParSubmission(file, loaded)).setup!.adapter.id, 'radiance-field-renderer');
  await writeFile(path.join(dataDir, 'configuration.json'), '{"seed": 8}');
  await assert.rejects(readParSubmission(file, loaded), /hash mismatch/);
});

test('a current reference remains zero while the individual generation stays unranked', async () => {
  const status = await currentParStatus(courseFile, path.join(dataDir, 'bench'));
  assert.equal(status!.reference.score, 0);
  assert.equal(status!.generation.score, null);
  assert.equal(status!.generation.status, 'not-ranked');
  assert.equal(status!.evaluation, null);
  assert.equal(status!.course.sha256, parDigest(course));
  assert.equal(await currentParStatus(path.join(dataDir, 'missing-course.json')), null);
});

test('published reference metadata does not expose source paths, raw ballots, other worlds or private configuration', async () => {
  const store = new RunStore(path.join(dataDir, 'bench'));
  const score = scorePar(course, parDigest(course), parReferenceSubmission(course, parDigest(course)));
  const run = {
    format: 2, id: '20261104-000001', task: { id: 'global' }, finishedAt: '2026-11-04T00:00:00Z',
    config: { courseSha256: parDigest(course), private: 'private-config' },
    results: [{ details: { parScore: score, rawBallots: 'private-ballots', sourceFile: 'private-source-path' } }],
  } as unknown as RunFile;
  await store.write(run);
  // An incomplete newer file must not break every generation's public facts page.
  await store.write({ format: 2, id: '20261104-000002', task: { id: 'global' } } as RunFile);
  const status = await currentParStatus(courseFile, store.dir);
  assert.deepEqual(status!.evaluation, { run: run.id, finishedAt: run.finishedAt, actualBallots: 0 });
  assert.doesNotMatch(JSON.stringify(status), /private-config|private-ballots|private-source-path|reference\//);
});

test('the setup schema is publicly discoverable, valid JSON and aligned with runtime identifier/path rules', async () => {
  setResolverForTests(async () => ({ user: null, cookies: [] }));
  const response = await app.request('/api/wometrics/setup-schema');
  assert.equal(response.status, 200);
  const schema = await response.json();
  assert.equal(schema.properties.schema.const, 'wom-agent-setup/1');
  assert.ok(new RegExp(schema.$defs.id.pattern).test(setup().id));
  const pattern = new RegExp(schema.properties.configuration.properties.path.pattern);
  assert.ok(pattern.test('parameters/configuration.json'));
  for (const bad of ['../configuration.json', '/configuration.json', 'a/../configuration.json', 'a\\b', 'a//b']) assert.equal(pattern.test(bad), false, bad);
  assert.equal((await app.request('/api/bench/global/runs/20261104-000001')).status, 401);
  setResolverForTests(null);
});
