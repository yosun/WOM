import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CaseRunner } from '../../server/src/bench/case.ts';
import { loadAsset, loadBenchWorld } from '../../server/src/bench/context.ts';
import { WORLDS_DIR } from '../../server/src/config.ts';
import { PLACEMENT_AGENT_REVISION, placementAgentNeedsRun } from '../../server/src/placement.ts';
import type { PlacementVariant, SceneDoc } from '../../server/src/types.ts';

const variant = (agentRevision?: string): PlacementVariant => ({
  position: [0, 0, 3], quaternion: [0, 0, 0, 1], scale: 1,
  iou: 0.8, contactGapM: 0, tiltDeg: 0, heightM: 1, agentRevision,
});
const object = (id: string, placements: SceneDoc['objects'][number]['placements'] = {}): SceneDoc['objects'][number] => ({
  id, name: id, kind: 'splat', url: '/unused.ply', position: [0, 0, 3], quaternion: [0, 0, 0, 1],
  scale: 1, visible: true, fitIou: 0.8, placements,
});

test('legacy, missing and partly updated agent placements are eligible for an update', () => {
  assert.equal(placementAgentNeedsRun({ objects: [object('one', { 'agent-spark': variant() })] }, 'agent-spark'), true);
  assert.equal(placementAgentNeedsRun({ objects: [object('one')] }, 'agent-spark'), true);
  const doc = { objects: [object('one', { 'agent-spark': variant(PLACEMENT_AGENT_REVISION) }), object('two')] };
  assert.equal(placementAgentNeedsRun(doc, 'agent-spark'), true);
});

test('current results are reused and another model can still need its own update', () => {
  const doc = { objects: [object('one', { 'agent-spark': variant(PLACEMENT_AGENT_REVISION) })] };
  assert.equal(placementAgentNeedsRun(doc, 'agent-spark'), false);
  assert.equal(placementAgentNeedsRun(doc, 'agent-wonder'), true);
});

test('split-person parts never trigger independent agent placements', () => {
  const plan = [{ id: 'head', part: { of: 'person', role: 'head' as const } }, { id: 'body', part: { of: 'person', role: 'body' as const } }];
  assert.equal(placementAgentNeedsRun({ objects: [object('head'), object('body')] }, 'agent-sol', plan), false);
  const doc = { objects: [object('head'), object('body'), object('dog', { 'agent-sol': variant(PLACEMENT_AGENT_REVISION) })] };
  assert.equal(placementAgentNeedsRun(doc, 'agent-sol', plan), false);
});

for (const model of ['idol', 'tripo-p1'] as const) {
  test(`saved lemon tree: updated auto_fit ${model === 'idol' ? 'uses the improved IDOL fit' : 'rejects the known Tripo P1 regression'}`, async (t) => {
    const wid = 'mvxixlbz34cbfb22';
    if (!existsSync(path.join(WORLDS_DIR, wid, 'manifest.json'))) { t.skip('Saved-asset fixture is not installed'); return; }
    const world = await loadBenchWorld(wid);
    const obj = world.objects.find((o) => o.id === 'potted-lemon-tree');
    const rec = obj?.assets.find((a) => a.model === model);
    if (!obj || !rec) { t.skip(`Saved ${model} asset is not installed`); return; }
    const c = new CaseRunner(world, obj, await loadAsset(world, rec));
    const original = c.fitGrounded().pose;
    const polished = c.fitGrounded(undefined, undefined, true).pose;
    assert.ok(original);
    assert.ok(polished);
    const baseline = await c.score(c.placementOf(original));
    const candidate = await c.score(c.placementOf(polished));
    const selected = await c.autoFit();
    assert.ok(selected.metrics.iou >= baseline.metrics.iou);
    assert.ok(selected.metrics.tiltDeg < 0.0001);
    if (model === 'idol') {
      assert.ok(candidate.metrics.iou > baseline.metrics.iou + 0.01);
      assert.deepEqual(selected.placement, candidate.placement);
    } else {
      assert.ok(candidate.metrics.iou < baseline.metrics.iou - 0.01);
      assert.deepEqual(selected.placement, baseline.placement);
    }
    t.diagnostic(`IoU original ${baseline.metrics.iou.toFixed(4)}; polished ${candidate.metrics.iou.toFixed(4)}; selected ${selected.metrics.iou.toFixed(4)}`);
  });
}
