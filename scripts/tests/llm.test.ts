import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Spend as BaseSpend } from '@wom/metrics';
import { modelCompletion, modelJson } from '../../server/src/clients/llm.ts';
import { openAiTokenCostUsd } from '../../server/src/clients/openai.ts';
import { DEFAULT_OPTIONS, normalizeOptions } from '../../server/src/config.ts';
import type { ChatMessage } from '../../server/src/clients/meta.ts';
import { agentPlacement, type PlacementTask } from '../../server/src/bench/llm.ts';
import { PLACEMENT_AGENT_REVISION } from '../../server/src/placement.ts';

const realFetch = globalThis.fetch;
const savedEnv = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_KEY: process.env.OPENAI_KEY, MUSE_API_KEY: process.env.MUSE_API_KEY };
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
const reply = (output: unknown[], usage = { input_tokens: 100, output_tokens: 20 }) =>
  Response.json({ status: 'completed', output, usage });
const textOutput = (text: string) => [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];

test('Sol is opt-in and normalization keeps the frozen default models', () => {
  assert.equal(normalizeOptions(undefined).plannerModel, 'muse-spark-1.3');
  assert.deepEqual(DEFAULT_OPTIONS.placementAgents, ['muse-spark-1.3', 'muse-wonder-1.0']);
  const o = normalizeOptions({ plannerModel: 'gpt-6.1-sol', placementAgents: ['gpt-6.1-sol', 'gpt-6.1-sol'] });
  assert.equal(o.plannerModel, 'gpt-6.1-sol');
  assert.deepEqual(o.placementAgents, ['gpt-6.1-sol']);
});

test('Sol uses Responses, images and encrypted reasoning survive a tool round trip', async () => {
  process.env.OPENAI_API_KEY = 'test-canonical';
  process.env.OPENAI_KEY = 'test-legacy';
  const output = [
    { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque-test-state' },
    { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'auto_fit', arguments: '{}' },
  ];
  let turn = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-canonical');
    const body = JSON.parse(String(init!.body));
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, 'low');
    assert.equal(body.tools[0].strict, false);
    if (turn++ === 0) {
      assert.deepEqual(body.input[1].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,dGVzdA==' });
      return reply(output);
    }
    assert.deepEqual(body.input.slice(-3, -1), output);
    assert.deepEqual(body.input.at(-1), { type: 'function_call_output', call_id: 'call_test', output: '{"iou":0.8}' });
    return reply(textOutput('done'));
  };
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Place the object.' },
    { role: 'user', content: [{ type: 'text', text: 'photo' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,dGVzdA==' } }] },
  ];
  const req = { model: 'gpt-6.1-sol', reasoningEffort: 'minimal' as const, messages,
    tools: [{ type: 'function' as const, function: { name: 'auto_fit', description: 'fit', parameters: { type: 'object', properties: {}, required: [] } } }] };
  const first = await modelCompletion(req);
  assert.equal(first.message.tool_calls?.[0].id, 'call_test');
  messages.push({ role: 'assistant', ...first.message }, { role: 'tool', tool_call_id: 'call_test', content: '{"iou":0.8}' });
  assert.equal((await modelCompletion(req)).message.content, 'done');
  assert.equal(turn, 2);
});

test('Sol structured JSON uses the same scene schema and rejects incomplete answers', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
  let incomplete = false;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    assert.deepEqual(body.text.format, { type: 'json_schema', name: 'ScenePlan', schema, strict: true });
    return incomplete ? Response.json({ status: 'incomplete', output: textOutput('{"title":"partial"}'), usage: {} }) : reply(textOutput('{"title":"Garden"}'));
  };
  const req = { model: 'gpt-6.1-sol', system: 'Plan', content: [{ type: 'text' as const, text: 'memory' }], schemaName: 'ScenePlan', schema };
  assert.deepEqual((await modelJson(req)).data, { title: 'Garden' });
  incomplete = true;
  await assert.rejects(modelJson(req), /no complete ScenePlan/);
});

test('Muse retains its own endpoint, request format and key', async () => {
  process.env.MUSE_API_KEY = 'test-meta';
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith('/chat/completions'));
    const body = JSON.parse(String(init!.body));
    assert.equal(body.model, 'muse-wonder-1.0');
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-meta');
    assert.equal(body.store, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Muse result' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  };
  const r = await modelCompletion({ model: 'muse-wonder-1.0', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(r.message.content, 'Muse result');
});

test('Sol and Terra token costs use their respective prices', () => {
  const usage = { inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 100_000 };
  assert.equal(openAiTokenCostUsd('gpt-6.1-sol', usage), 2.05);
  assert.equal(openAiTokenCostUsd('gpt-6.1-terra', usage), 1.025);
  assert.throws(() => openAiTokenCostUsd('unknown', usage), /No OpenAI token prices/);
});

test('placement agent completes a Sol tool loop with the same task contract', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  let turn = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    assert.ok(body.input[0].content.includes(PLACEMENT_AGENT_REVISION));
    assert.ok(body.tools.find((t: any) => t.name === 'auto_fit').description.includes('32-round refinement'));
    const i = turn++;
    if (i === 0) return reply([
      { type: 'reasoning', id: 'rs_agent', summary: [], encrypted_content: 'agent-state' },
      { type: 'function_call', id: 'fc_fit', call_id: 'call_fit', name: 'auto_fit', arguments: '{}' },
    ]);
    assert.ok(body.input.some((p: any) => p.encrypted_content === 'agent-state'));
    assert.ok(body.input.some((p: any) => p.type === 'function_call_output' && p.call_id === 'call_fit'));
    return reply([{ type: 'function_call', id: 'fc_submit', call_id: 'call_submit', name: 'submit_placement', arguments: JSON.stringify({
      base_x: 500, base_y: 800, height_m: 1, yaw_deg: 45, pitch_deg: 0, roll_deg: 0, source: 'fitter', rationale: 'Checked the fit.',
    }) }]);
  };
  const placement = { base: [0, -1, 3] as [number, number, number], heightM: 1, yawDeg: 45, pitchDeg: 0, rollDeg: 0 };
  const scored = { placement, grid: { x: 500, y: 800 }, overlay: Buffer.from('overlay'),
    metrics: { iou: 0.8, colorErr: 0.1, depthErr: 0.02, contactGapM: 0, tiltDeg: 0, yawDeg: 45, heightM: 1, centroidErr: 0 } };
  const task: PlacementTask = {
    label: 'test/object/idol', objectName: 'test object', description: 'a test object', assetKind: 'splat', assetModel: 'idol', proportions: [1, 1, 1],
    facts: { imageWidth: 1000, imageHeight: 1000, hfovDeg: 60, cameraHeightM: 1.5, cameraPitchDownDeg: 0, viewElevationDeg: 20 },
    photo: Buffer.from('photo'), turntable: Buffer.from('turntable'), yaws: [0, 45], place: () => placement,
    score: async () => scored, autoFit: async () => scored, measure: () => [],
  };
  const out = await agentPlacement(task, 'gpt-6.1-sol', { spend: new BaseSpend({ id: 'test', maxUsd: 1 }), fresh: true, effort: 'low', ledger: false });
  assert.deepEqual(out.placement, placement);
  assert.equal(out.steps[0].tool, 'auto_fit');
  assert.equal(out.info.calls, 2);
  assert.equal(out.info.error, undefined);
});

test('copying auto_fit parameters keeps the exact scored pose instead of its rounded reconstruction', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  let turn = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    if (turn++ === 0) return reply([{ type: 'function_call', call_id: 'fit_exact', name: 'auto_fit', arguments: '{}' }]);
    const tool = body.input.find((p: any) => p.type === 'function_call_output' && p.call_id === 'fit_exact');
    const args = JSON.parse(tool.output).placement;
    return reply([{ type: 'function_call', call_id: 'submit_exact', name: 'submit_placement', arguments: JSON.stringify({ ...args, source: 'fitter', rationale: 'Keep the scored fit.' }) }]);
  };
  const placement = { base: [0.123456, -1.234567, 3.456789] as [number, number, number], heightM: 0.987654, yawDeg: 43.876543, pitchDeg: 0, rollDeg: 0 };
  let roundTrips = 0;
  const scored = { placement, grid: { x: 512.34567, y: 765.4321 }, overlay: Buffer.from('overlay'),
    metrics: { iou: 0.9, colorErr: 0.1, depthErr: 0.02, contactGapM: 0, tiltDeg: 0, yawDeg: placement.yawDeg, heightM: placement.heightM, centroidErr: 0 } };
  const task: PlacementTask = {
    label: 'test/exact/idol', objectName: 'test object', description: 'test', assetKind: 'splat', assetModel: 'idol', proportions: [1, 1, 1],
    facts: { imageWidth: 1000, imageHeight: 1000, hfovDeg: 60, cameraHeightM: 1.5, cameraPitchDownDeg: 0, viewElevationDeg: 20 },
    photo: Buffer.from('photo'), turntable: Buffer.from('turntable'), yaws: [0, 45],
    place: () => { roundTrips++; return { ...placement, heightM: 0.988 }; },
    score: async () => scored, autoFit: async () => scored, measure: () => [],
  };
  const out = await agentPlacement(task, 'gpt-6.1-sol', { spend: new BaseSpend({ id: 'exact-test', maxUsd: 1 }), fresh: true, effort: 'low', ledger: false });
  assert.deepEqual(out.placement, placement);
  assert.equal(roundTrips, 0);
  assert.equal(out.info.error, undefined);
});
