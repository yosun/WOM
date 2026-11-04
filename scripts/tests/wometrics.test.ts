import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { STEP_ORDER, type PlacementVariant, type SceneDoc, type WorldManifest } from '../../server/src/types.ts';
import { worldMetrics } from '../../server/src/wometrics.ts';

const fixture = (): WorldManifest => ({
  id: 'world123', title: 'Test world', status: 'done', createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:03:00Z',
  image: { file: 'source.jpg', thumb: 'thumb.jpg', width: 1000, height: 1000, camera: { source: 'exif', hfovDeg: 65 } },
  options: { maxObjects: 2, plannerModel: 'muse-spark-1.3', meshModel: 'idol', worldModel: 'none', depthModel: 'moge3', completeOccluded: false, splitPeople: false, placementAgents: [] },
  steps: Object.fromEntries(STEP_ORDER.map((s) => [s.id, { ...s, status: 'pending' }])) as WorldManifest['steps'],
  objects: [], depth: {}, costs: [],
});
const variant = (iou: number, contactGapM = 0): PlacementVariant => ({ position: [0, 0, -3], quaternion: [0, 0, 0, 1], scale: 1, iou, contactGapM, tiltDeg: 0, heightM: 1 });
const scene = (): SceneDoc => ({
  version: 42, title: 'Test world', image: { url: '/files/world123/source.jpg', width: 1000, height: 1000 },
  camera: { fovY: 60, aspect: 1, up: [0, 1, 0], target: [0, 0, -3], source: 'moge' },
  objects: [], lighting: { sky: '#fff', ground: '#000', sun: [0, 1, 0] }, diagnostics: ['private diagnostic'],
});
const so = (id: string, placements: SceneDoc['objects'][number]['placements'] = {}): SceneDoc['objects'][number] => ({
  id, name: id, kind: 'splat', url: `/files/world123/objects/${id}/model.ply`, position: [0, 0, -3], quaternion: [0, 0, 0, 1], scale: 1, visible: true, fitIou: 0.25, bytes: 1000, placements,
});
const opts = { owner: true, running: false, reprojection: false };

test('queued and failed generations have a report without invented zero scores', () => {
  for (const status of ['queued', 'failed'] as const) {
    const m = fixture();
    m.status = status;
    const r = worldMetrics(m, null, opts);
    assert.equal(r.sceneVersion, null);
    assert.equal(r.elapsedMs, null);
    assert.equal(r.plannedObjects, null);
    assert.equal(r.placement.meanIou, null);
    assert.equal(r.placement.meanAbsGapM, null);
    assert.equal(r.payloadBytes, null);
    assert.equal(r.assets.checked, 0);
  }
});

test('placement uses the active method and per-object fitter fallback, with coverage', () => {
  const m = fixture();
  m.objects = ['one', 'two', 'failed'].map((id) => ({ id, name: id, status: id === 'failed' ? 'failed' : 'done' }));
  const s = scene();
  s.placement = { active: 'agent-spark', methods: [] };
  s.objects = [so('one', { 'agent-spark': variant(0.9, 0.04), fitter: variant(0.1) }), so('two', { fitter: variant(0.7, -0.02) })];
  const r = worldMetrics(m, s, opts);
  assert.equal(r.placement.meanIou, 0.8);
  assert.equal(r.placement.meanAbsGapM, 0.03); // positive and negative gaps must not cancel
  assert.equal(r.placement.measured, 2);
  assert.equal(r.placedObjects, 2);
  assert.equal(r.objects[1].method, 'fitter');
  assert.equal(r.objects[2].iou, null);
});

test('legacy fitter scores are usable, hidden objects and nonfinite values are excluded', () => {
  const s = scene();
  s.objects = [so('legacy'), { ...so('hidden'), visible: false }, so('bad', { fitter: variant(NaN, Infinity) })];
  const r = worldMetrics(fixture(), s, opts);
  assert.equal(r.placement.meanIou, 0.25);
  assert.equal(r.placement.measured, 1);
  assert.equal(r.placement.gapMeasured, 0);
  assert.equal(r.objects[1].inScene, false);
  assert.equal(r.objects[2].iou, null);
  assert.doesNotMatch(JSON.stringify(r), /NaN|Infinity/);
});

test('asset checks must match the current generated file', () => {
  const m = fixture();
  const job = { model: 'idol', idempotencyKey: 'private-key', jobId: 'private-job', status: 'succeeded' };
  m.objects = [{ id: 'one', name: 'one', status: 'done', mesh: { job, file: 'new.ply', alignImage: false }, assets: {
    idol: { model: 'idol', kind: 'splat', job, file: 'new.ply', alignImage: false, createdAt: m.createdAt, source: 'pipeline',
      check: { file: 'old.ply', bytes: 50, verdict: 'clean', foreignShare: 0, findings: [], rationale: 'private rationale', model: 'judge', at: m.createdAt } },
  } }];
  const stale = worldMetrics(m, null, opts);
  assert.equal(stale.assets.generated, 1);
  assert.equal(stale.assets.checked, 0);
  m.objects[0].assets!.idol!.check!.file = 'new.ply';
  const current = worldMetrics(m, null, opts);
  assert.equal(current.assets.checked, 1);
  assert.equal(current.assets.clean, 1);
  assert.doesNotMatch(JSON.stringify(current), /private-key|private-job|private rationale|new\.ply/);
});

test('wall time uses stage bounds rather than summing parallel stages', () => {
  const m = fixture();
  m.steps.analyze = { ...m.steps.analyze, status: 'done', startedAt: '2026-11-04T00:00:00Z', endedAt: '2026-11-04T00:02:00Z' };
  m.steps.depth = { ...m.steps.depth, status: 'done', startedAt: '2026-11-04T00:01:00Z', endedAt: '2026-11-04T00:03:00Z' };
  assert.equal(worldMetrics(m, null, opts).elapsedMs, 180_000);
  assert.equal(worldMetrics(m, null, { ...opts, running: true, now: Date.parse('2026-11-04T00:04:00Z') }).elapsedMs, 240_000);
});

test('a saved scene cannot inherit a newer asset’s clean verdict during rebuilding', () => {
  const m = fixture();
  const job = { model: 'idol', idempotencyKey: 'unused', status: 'succeeded' };
  m.objects = [{ id: 'one', name: 'one', status: 'running', mesh: { job, file: 'new.ply', alignImage: false }, assets: {
    idol: { model: 'idol', kind: 'splat', job, file: 'new.ply', alignImage: false, createdAt: m.createdAt, source: 'pipeline',
      check: { file: 'new.ply', bytes: 1000, verdict: 'clean', foreignShare: 0, findings: [], rationale: '', model: 'judge', at: m.createdAt } },
  } }];
  const s = scene();
  s.objects = [so('one')];
  const r = worldMetrics(m, s, opts);
  assert.equal(r.objects[0].inScene, true);
  assert.equal(r.objects[0].verdict, null);
  assert.equal(r.objects[0].model, null);
  assert.equal(r.assets.clean, 0);
});

test('camera field of view converts degrees correctly and keeps signed lens error', () => {
  const r = worldMetrics(fixture(), scene(), opts);
  assert.ok(Math.abs(r.camera.hfovDeg! - 60) < 1e-9);
  assert.ok(Math.abs(r.camera.lensErrorDeg! + 5) < 1e-9);
});

test('background-only worlds have no object score and intentional background omission is explicit', () => {
  const r = worldMetrics(fixture(), scene(), opts);
  assert.equal(r.placement.meanIou, null);
  assert.equal(r.components.backgroundRequested, false);
  assert.equal(r.payloadBytes, null);
});

test('public facts redact spend and observations, owner totals include estimated charges', () => {
  const m = fixture();
  m.costs = [{ label: 'private label', provider: 'meta', usd: 0.25, estimated: true }, { label: 'Retry', provider: 'ai3d', usd: 1, estimated: false }];
  const observations = [{ status: 'open' as const }, { status: 'wontfix' as const }, { status: 'fixed' as const }, { status: 'false-positive' as const }];
  const owned = worldMetrics(m, scene(), { ...opts, observations });
  assert.equal(owned.spend?.usd, 1.25);
  assert.equal(owned.spend?.estimatedUsd, 0.25);
  assert.deepEqual(owned.observations, { total: 4, unresolved: 2, fixed: 1 });
  const publicFacts = worldMetrics(m, scene(), { ...opts, owner: false, observations });
  assert.equal(publicFacts.spend, null);
  assert.equal(publicFacts.observations, null);
  assert.doesNotMatch(JSON.stringify(publicFacts), /private label|private diagnostic/);
});

// Exercise the real route and access guard in an isolated store, with no provider calls or live data changes.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'wometrics-test-'));
process.env.WOM_DATA_DIR = dataDir;
process.env.WOM_STORE = 'fs';
process.env.WOM_AUTH = 'off';
const { createWorld } = await import('../../server/src/store.ts');
const { setResolverForTests } = await import('../../server/src/access.ts');
const { app } = await import('../../server/src/index.ts');
after(async () => { setResolverForTests(null); await rm(dataDir, { recursive: true, force: true }); });

test('metrics endpoint exists before composition and public visitors receive only safe facts', async () => {
  const world = await createWorld({ options: fixture().options, width: 1000, height: 1000, owner: { id: 'local' } });
  world.manifest.costs = fixture().costs.concat({ label: 'Private charge', provider: 'ai3d', usd: 5, estimated: false });
  const url = `/api/worlds/${world.id}/metrics`;
  const owner = await app.request(url);
  assert.equal(owner.status, 200);
  assert.equal((await owner.json()).spend.usd, 5);
  assert.equal(owner.headers.get('cache-control'), 'private, no-store');
  const s = scene();
  await writeFile(world.file('scene.json'), JSON.stringify(s));
  setResolverForTests(async () => ({ user: null, cookies: [] }));
  try {
    const response = await app.request(url);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.spend, null);
    assert.equal(report.observations, null);
    assert.equal(report.sceneVersion, 42);
    assert.equal((await app.request(`/api/worlds/${world.id}/events`)).status, 401);
    assert.equal((await app.request('/api/worlds/notfound123/metrics')).status, 404);
  } finally { setResolverForTests(null); }
});
