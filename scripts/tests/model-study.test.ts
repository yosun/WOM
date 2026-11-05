import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeStudy, photoBootstrap, photoPermutation, type StudyRow } from '../model-study-analysis.ts';

const models = ['muse-spark-1.3', 'muse-wonder-1.0', 'gpt-6.1-terra', 'gpt-6.1-sol'];
const cases = [{ id: 'a', photo: 'one' }, { id: 'b', photo: 'one' }, { id: 'c', photo: 'two' }];
const row = (caseId: string, model: string, iou: number, trial = 1): StudyRow => ({ caseId, photo: cases.find((c) => c.id === caseId)!.photo,
  model, iou, trial, status: 'completed', costUsd: .01, wallMs: 100, modelMs: 80, calls: 1 });
test('study weights photos equally and does not turn repeated objects or trials into independent photos', () => {
  const rows = models.flatMap((m) => cases.flatMap((c) => [1, 2, 3].map((t) => row(c.id, m, c.photo === 'one' ? 1 : 0, t))));
  const result = analyzeStudy(rows, cases, 3);
  assert.equal(result.photos, 2);
  assert.equal(result.summaries[0].photoWeightedIou, .5);
  assert.equal(result.pairs[0].photoSignFlipP, 1);
});
test('failed attempts count as zero while unattempted cells cannot produce a complete ranking', () => {
  const rows = models.flatMap((m) => cases.map((c) => row(c.id, m, 1)));
  rows[0] = { ...rows[0], status: 'failed', iou: null };
  assert.equal(analyzeStudy(rows, cases, 1).summaries[0].photoWeightedIou, .75);
  rows.shift();
  assert.equal(analyzeStudy(rows, cases, 1).pairs[0].complete, false);
  assert.equal(analyzeStudy(rows, cases, 1).summaries[0].photoWeightedIou, null);
});
test('photo-level exact test, interval and duplicate validation expose the small sample honestly', () => {
  assert.equal(photoPermutation([.1, .1, .1, .1]), .125);
  assert.equal(photoPermutation([0, 0, 0, 0]), 1);
  assert.deepEqual(photoBootstrap([0, 0]), [0, 0]);
  const r = row('a', models[0], .8);
  assert.throws(() => analyzeStudy([r, r], cases, 1), /Duplicate/);
});
