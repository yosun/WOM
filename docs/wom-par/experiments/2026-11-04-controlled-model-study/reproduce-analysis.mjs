// Recompute the published study without credentials, private images or provider calls.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { analyzeStudy } from '../../../../scripts/model-study-analysis.ts';

const read = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const protocol = await read('./protocol.json');
const rows = await read('./trials.json');
const published = await read('../2026-11-04-controlled-model-study.json');
const analysis = analyzeStudy(rows, protocol.cases, protocol.trials, protocol.models);
assert.equal(analysis.rows, 144);
assert.equal(analysis.photos, 4);
assert.deepEqual(analysis.summaries, published.summaries);
assert.deepEqual(analysis.pairs, published.prespecifiedPairs);
console.log(JSON.stringify({ reproduced: true, providerCalls: 0, analysis }, null, 2));
