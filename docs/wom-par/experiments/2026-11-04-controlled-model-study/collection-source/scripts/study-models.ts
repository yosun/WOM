// Controlled live study using WOMAgent execution, WOMetrics scoring and WOMPar saved inputs.
// node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/study-models.ts --prepare
// node --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/study-models.ts --run <study-dir>
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { createBenchmark, defineSubject, Spend, Ledger, type Case, type RunFile, type ResultRecord } from '@wom/metrics';
import { loadBenchWorld, loadAsset } from '../server/src/bench/context.ts';
import { CaseRunner } from '../server/src/bench/case.ts';
import { evaluatePlacement } from '../server/src/bench/metrics.ts';
import { placementTask, type PlacementData, type PlacementAnswer } from '../server/src/bench/placement.ts';
import { observedAgentPlacement } from '../server/src/agents/placement.ts';
import { PLACEMENT_AGENT_REVISION } from '../server/src/placement.ts';
import { writeFileAtomic } from '../server/src/util.ts';
import { analyzeStudy, STUDY_MODELS, type StudyRow } from './model-study-analysis.ts';

const ROOT = process.cwd(), MODELS = STUDY_MODELS, TRIALS = 3, MAX_USD = 20;
const WORLDS = ['mvxixlbz34cbfb22', 'mvxjtywhaeb1ff10', 'mvzp2tur93987dde', 'mw1u8wfg5b232a59'];
const CODE = ['scripts/study-models.ts', 'scripts/model-study-analysis.ts', 'server/src/bench/llm.ts', 'server/src/bench/case.ts', 'server/src/bench/context.ts', 'server/src/bench/metrics.ts', 'server/src/geometry/fit.ts', 'server/src/geometry/raster.ts', 'server/src/clients/meta.ts', 'server/src/clients/openai.ts', 'server/src/clients/llm.ts', 'server/src/agents/placement.ts'];
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const fileHash = (p: string) => hash(readFileSync(p));
const json = async (p: string, value: unknown) => writeFileAtomic(p, JSON.stringify(value, null, 2));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items]; let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; const j = state % (i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

interface Prepared {
  id: string; photo: string; object: string; contact: string; maskVersion: number;
  sourceSha256: string; photoSha256: string; turntableSha256: string; assetSha256: string; maskSha256: string;
  baselineIou: number; toolIou: number; inputDir: string; files: Record<string, string>;
}
interface Protocol {
  schema: string; id: string; preparedAt: string; models: string[]; trials: number; maxUsd: number;
  seed: number; codeHashes: Record<string, string>; cases: Prepared[]; blocks: { caseId: string; trial: number; models: string[] }[];
  [key: string]: unknown;
}

async function loadCases(dir: string, expected?: Protocol) {
  const cases: Case<PlacementData>[] = [], records: Prepared[] = [], seen = new Set<string>();
  const annotations = JSON.parse(await readFile('data/bench/annotations.json', 'utf8'));
  for (const worldId of WORLDS) {
    const world = await loadBenchWorld(worldId, 'moge3');
    const photo = hash(world.sourceJpeg);
    if (seen.has(photo)) throw new Error('Duplicate source photograph');
    seen.add(photo);
    for (const obj of world.objects) {
      const note = annotations[`${worldId}/${obj.id}`];
      if (note?.exclude && (!note.maskVersion || note.maskVersion === obj.maskVersion)) throw new Error(`Resolve prespecified invalid mask before collection: ${obj.id}`);
      const rec = obj.assets.find((a) => a.model === 'idol');
      if (!rec) throw new Error(`Missing IDOL asset: ${obj.id}`);
      const asset = await loadAsset(world, rec), runner = new CaseRunner(world, obj, asset);
      const id = `${worldId}/${obj.id}/idol@moge3`, inputDir = `inputs/${worldId}__${obj.id}`;
      const input = await runner.task();
      const grounded = runner.fitGrounded();
      if (!grounded.pose) throw new Error(`Missing geometric baseline: ${id}`);
      const baseline = evaluatePlacement(world, obj, asset, grounded.pose);
      // Deterministic tools are memoized equally for every model; no paid run updates world placements.
      const realFit = input.autoFit, fits = new Map<string, ReturnType<typeof realFit>>();
      input.autoFit = (yaw, window) => { const key = JSON.stringify([yaw, window]); if (!fits.has(key)) fits.set(key, realFit(yaw, window)); return fits.get(key)!; };
      const automatic = await input.autoFit();
      const manifestObj = world.manifest.objects.find((o) => o.id === obj.id)!;
      const files = Object.fromEntries([
        world.file(world.manifest.image.file), world.file(manifestObj.mask!.file), world.file(asset.file),
        world.file('scene.json'), world.file('manifest.json'),
        ...Object.values(world.manifest.depth.original?.files ?? {}).filter((f): f is string => typeof f === 'string').map(world.file),
      ].filter(existsSync).map((file) => [path.relative(ROOT, file), fileHash(file)]));
      const record: Prepared = { id, photo, object: obj.id, contact: obj.plan?.contact ?? 'unknown', maskVersion: obj.maskVersion,
        sourceSha256: photo, photoSha256: hash(input.photo), turntableSha256: hash(input.turntable), assetSha256: fileHash(world.file(asset.file)),
        maskSha256: hash(obj.mask.data), baselineIou: baseline.iou, toolIou: automatic.metrics.iou, inputDir, files };
      if (expected) {
        const frozen = expected.cases.find((c) => c.id === id);
        if (!frozen || JSON.stringify(record) !== JSON.stringify(frozen)) throw new Error(`Frozen input changed: ${id}`);
      } else {
        await mkdir(path.join(dir, inputDir), { recursive: true });
        await writeFile(path.join(dir, inputDir, 'photo.jpg'), input.photo);
        await writeFile(path.join(dir, inputDir, 'turntable.jpg'), input.turntable);
        await writeFile(path.join(dir, inputDir, 'baseline.jpg'), automatic.overlay);
        await json(path.join(dir, inputDir, 'facts.json'), { facts: input.facts, description: input.description, proportions: input.proportions, yaws: input.yaws, baseline, automatic: { metrics: automatic.metrics, placement: automatic.placement } });
      }
      records.push(record);
      cases.push({ id, title: obj.name, group: world.title, dims: { world: worldId, object: obj.id, asset: 'idol', depth: 'moge3' }, revision: obj.maskVersion, data: { runner, input: Promise.resolve(input), grounded: Promise.resolve(grounded) as never } });
      console.log(JSON.stringify({ event: 'prepared', case: id, baselineIou: baseline.iou, toolIou: automatic.metrics.iou }));
    }
  }
  if (expected && cases.length !== expected.cases.length) throw new Error('Frozen course changed');
  return { cases, records };
}

function requestSummary(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body), (key, value) => key === 'encrypted_content' ? '[opaque reasoning omitted]' : typeof value === 'string' && value.startsWith('data:') ? `sha256:${hash(value)}` : value);
}

async function run(dir: string) {
  const protocol = JSON.parse(await readFile(path.join(dir, 'protocol.json'), 'utf8')) as Protocol;
  for (const [file, sha] of Object.entries(protocol.codeHashes)) if (fileHash(file) !== sha) throw new Error(`Study code changed after registration: ${file}`);
  // Prefer the already-authorized project key over unrelated shell credentials. Never print key values.
  const local = parseEnv(await readFile('.env.local', 'utf8'));
  if (local.OPENAI_API_KEY || local.OPENAI_KEY) process.env.OPENAI_API_KEY = local.OPENAI_API_KEY || local.OPENAI_KEY;
  if (!process.env.MUSE_API_KEY || !process.env.OPENAI_API_KEY) throw new Error('Project Meta and OpenAI credentials are required');
  const { cases } = await loadCases(dir, protocol);
  const rows: StudyRow[] = [], receipts: Record<string, unknown>[] = [];
  const resultsDir = path.join(dir, 'attempts'); await mkdir(resultsDir, { recursive: true });
  const store = new AsyncLocalStorage<{ job: string; counter: number }>();
  const realFetch = globalThis.fetch;
  let spent = 0, reserved = 0;
  const rates: Record<string, number[]> = { 'muse-spark-1.3': [1.25, .15, 4.25], 'muse-wonder-1.0': [4, .2, 20], 'gpt-6.1-terra': [1, .05, 5], 'gpt-6.1-sol': [2, .1, 10] };
  const budget = new Spend({ maxUsd: protocol.maxUsd, id: protocol.id, ledger: new Ledger('data/ledger.jsonl'), cacheDir: path.join(dir, 'cache') });
  const bench = createBenchmark({ dir: 'data/bench', ledger: new Ledger('data/ledger.jsonl') }).register(placementTask);
  // Bound paid requests and keep authenticated headers out of all evidence. Identical model decisions use
  // the existing runtime client and tool loop. Local response caches are bypassed on every trial.
  globalThis.fetch = async (url, init) => {
    if (!init?.body || init.method !== 'POST') return realFetch(url, init);
    const address = new URL(String(url));
    if (!['api.openai.com', 'api.meta.ai'].includes(address.hostname)) throw new Error('Unexpected study provider');
    const body = JSON.parse(String(init.body)), context = store.getStore();
    if (!context || !MODELS.includes(body.model)) throw new Error('Unregistered paid request');
    const [pin, pcache, pout] = rates[body.model];
    const normalized = requestSummary(body), text = JSON.stringify(normalized);
    const images = (text.match(/sha256:/g) ?? []).length;
    const upper = ((text.length + images * 20000) * pin + 16000 * pout) / 1e6;
    if (spent + reserved + upper > protocol.maxUsd) throw new Error('Study spend cap reached before request');
    reserved += upper;
    const number = ++context.counter, prefix = path.join(dir, 'calls', context.job, String(number).padStart(2, '0'));
    const start = Date.now();
    await json(`${prefix}-request.json`, { at: new Date().toISOString(), endpoint: address.origin + address.pathname, body: normalized, bodySha256: hash(String(init.body)), reservationUsd: upper });
    try {
      const response = await realFetch(url, init), value = await response.clone().json();
      const u = value.usage ?? {}, input = u.input_tokens ?? u.prompt_tokens ?? 0, output = u.output_tokens ?? u.completion_tokens ?? 0;
      const cached = u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      const cost = ((input - cached) * pin + cached * pcache + output * pout) / 1e6;
      spent += cost;
      await json(`${prefix}-response.json`, { at: new Date().toISOString(), status: response.status, model: value.model ?? body.model,
        responseId: value.id ?? null, usage: u, costUsd: cost, latencyMs: Date.now() - start,
        output: value.output?.filter((o: { type: string }) => o.type !== 'reasoning') ?? value.choices ?? null,
        error: response.ok ? null : { code: value.error?.code, type: value.error?.type } });
      console.log(JSON.stringify({ event: 'request', job: context.job, model: body.model, number, status: response.status, seconds: (Date.now() - start) / 1000, spentUsd: spent }));
      return response;
    } catch (error) {
      // An unknown network outcome reserves its worst-case charge rather than assuming it was free.
      spent += upper;
      await json(`${prefix}-unknown.json`, { at: new Date().toISOString(), chargeUnknown: true, reservedUsd: upper, error: (error as Error).name });
      throw error;
    } finally { reserved -= upper; }
  };
  try {
    for (const [blockIndex, block] of protocol.blocks.entries()) {
      const original = cases.find((c) => c.id === block.caseId)!;
      const record = protocol.cases.find((c) => c.id === block.caseId)!;
      await Promise.all(block.models.map(async (model) => {
        const job = `${String(blockIndex + 1).padStart(3, '0')}__${model}`;
        const receiptFile = path.join(resultsDir, `${job}.json`);
        if (existsSync(receiptFile)) throw new Error('Do not repeat paid attempts; use a new registered study');
        const started = Date.now();
        const c = { ...original, id: `${original.id}/trial-${block.trial}` };
        const subject = defineSubject<PlacementData, PlacementAnswer>({ id: model, label: model,
          methods: [{ id: `agent:${model}`, label: model, family: 'agent', subject: model }],
          async solve(_case, ctx) {
            const input = await original.data.input!;
            const outcome = await observedAgentPlacement(input, model, { spend: ctx.spend as never, fresh: true, effort: 'medium', partialOk: false },
              { source: 'benchmark', worldId: original.data.runner.world.id, worldTitle: original.group!, objectId: record.object,
                depth: 'moge3', maskVersion: record.maskVersion, agentRevision: PLACEMENT_AGENT_REVISION, baselineIou: record.baselineIou, benchmarkRunId: protocol.id },
              (placement) => { const m = evaluatePlacement(original.data.runner.world, original.data.runner.obj, original.data.runner.asset, original.data.runner.pose(placement)); return { iou: m.iou, baselineIou: record.baselineIou, deltaIou: m.iou - record.baselineIou, gapCm: m.contactGapM * 100, tiltDeg: m.tiltDeg }; });
            const complete = !!outcome.placement && !!outcome.submitted && !outcome.info.error;
            return [{ method: `agent:${model}`, answer: complete ? { pose: original.data.runner.pose(outcome.placement!), title: model } : undefined,
              costUsd: outcome.info.costUsd, latencyMs: outcome.info.latencyMs, calls: outcome.info.calls, cachedCalls: outcome.info.cachedCalls,
              error: outcome.info.error ?? (complete ? undefined : 'No valid final submission'),
              details: { submitted: outcome.submitted, steps: outcome.steps, inputTokens: outcome.info.inputTokens, outputTokens: outcome.info.outputTokens } }];
          } });
        const [scored] = await store.run({ job, counter: 0 }, () => bench.evaluate({ ...placementTask, finish: undefined }, c, [subject], { spend: budget, fresh: true }));
        const a = scored.answer, o = scored.outcome;
        const row: StudyRow = { caseId: original.id, photo: record.photo, model, trial: block.trial, status: typeof o.scores.iou === 'number' && !a.error ? 'completed' : 'failed',
          iou: typeof o.scores.iou === 'number' ? o.scores.iou : null, costUsd: a.costUsd ?? 0, wallMs: Date.now() - started, modelMs: a.latencyMs ?? 0, calls: a.calls ?? 0 };
        const receipt = { row, scores: o.scores, error: a.error ?? null, details: a.details, pose: a.answer?.pose ?? null };
        await json(receiptFile, receipt); rows.push(row); receipts.push(receipt);
        console.log(JSON.stringify({ event: 'completed', block: blockIndex + 1, blocks: protocol.blocks.length, model, trial: block.trial, object: record.object, status: row.status, iou: row.iou, attempts: rows.length, expected: protocol.blocks.length * MODELS.length, spentUsd: spent }));
      }));
      await json(path.join(dir, 'progress.json'), { updatedAt: new Date().toISOString(), completedBlocks: blockIndex + 1, blocks: protocol.blocks.length, attempts: rows.length, spentUsd: spent, analysis: analyzeStudy(rows, protocol.cases, TRIALS) });
    }
  } finally { globalThis.fetch = realFetch; }
  const analysis = analyzeStudy(rows, protocol.cases, TRIALS);
  await json(path.join(dir, 'results.json'), { protocolSha256: fileHash(path.join(dir, 'protocol.json')), finishedAt: new Date().toISOString(), actualSpendUsd: spent, analysis, receipts });
  const runCases = protocol.blocks.map((b) => { const c = cases.find((c) => c.id === b.caseId)!; return { id: `${c.id}/trial-${b.trial}`, title: c.title, group: c.group, dims: { ...c.dims, trial: String(b.trial) }, revision: c.revision }; });
  const results: ResultRecord[] = receipts.map((receipt) => {
    const r = receipt.row as StudyRow;
    return { case: `${r.caseId}/trial-${r.trial}`, method: `agent:${r.model}`, scores: { ...(receipt.scores as object), iou: r.status === 'completed' ? r.iou : 0 },
      costUsd: r.costUsd, latencyMs: r.modelMs, calls: r.calls, cachedCalls: 0, ...(receipt.error ? { error: String(receipt.error) } : {}), details: { ...(receipt.details as object), status: r.status, photo: r.photo } };
  });
  const runFile: RunFile = { format: 2, id: protocol.id, task: { ...placementTask, cases: undefined, score: undefined, finish: undefined } as never,
    startedAt: protocol.preparedAt, finishedAt: new Date().toISOString(), config: { study: protocol.id, protocol: path.relative(ROOT, path.join(dir, 'protocol.json')), trials: TRIALS, models: MODELS, fresh: true, effort: 'medium', partialOk: false, maxUsd: MAX_USD },
    methods: MODELS.map((model) => ({ id: `agent:${model}`, label: model, family: 'agent', subject: model })), cases: runCases, results, spend: { usd: spent, newCalls: rows.reduce((n, r) => n + r.calls, 0), cachedCalls: 0 }, skipped: [] };
  // Function properties are discarded by the JSON store; keep the standard Placement task identity.
  await bench.store.write(runFile);
  await bench.report('placement', protocol.id);
  await writeReport(dir, protocol, analysis, spent);
  console.log(JSON.stringify({ event: 'finished', dir, spentUsd: spent, analysis }));
}

async function writeReport(dir: string, p: Protocol, analysis: ReturnType<typeof analyzeStudy>, spent: number) {
  const escape = (v: unknown) => String(v).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const f = (v: number | null, scale = 1, digits = 2) => v === null ? 'Unavailable' : (v * scale).toFixed(digits);
  const rows = analysis.summaries.map((s) => `<tr><td>${escape(s.model)}</td><td>${s.completed}/${s.expected}</td><td>${f(s.photoWeightedIou, 100)}%</td><td>$${f(s.totalUsd, 1, 4)}</td><td>${f(s.medianWallSeconds)}s</td></tr>`).join('');
  const pairs = analysis.pairs.map((s) => `<h3>${escape(s.meta)} vs ${escape(s.openai)}</h3><p>Meta minus OpenAI: ${f(s.deltaMetaMinusOpenai, 100)} IoU percentage points. Object wins/ties/losses: ${s.objectWins}/${s.objectTies}/${s.objectLosses}, after averaging trials; tie threshold 1 point. Photo-level exact sign-flip p=${f(s.photoSignFlipP, 1, 3)}; Holm-adjusted p=${f(s.holmP, 1, 3)}.</p><p>Descriptive photo-bootstrap interval: ${s.descriptiveBootstrap95?.map((v) => f(v, 100)).join(' to ') ?? 'Unavailable'} points.</p>`).join('');
  const references = p.cases.map((c) => `<tr><td>${escape(c.object)}</td><td>${escape(c.contact)}</td><td>${f(c.baselineIou, 100)}%</td><td>${f(c.toolIou, 100)}%</td><td><a href="${c.inputDir}/photo.jpg">Photo</a> · <a href="${c.inputDir}/turntable.jpg">Asset</a> · <a href="${c.inputDir}/baseline.jpg">Fit</a></td></tr>`).join('');
  await writeFile(path.join(dir, 'report.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>WOM controlled model study</title><style>body{font:17px/1.6 system-ui;max-width:1100px;margin:48px auto;padding:0 24px;color:#20252b;background:#faf9f6}table{border-collapse:collapse;width:100%;font-size:15px}th,td{padding:10px;text-align:left;border-bottom:1px solid #ccc}h1{line-height:1.15}a{color:#1257a8}code{font-size:14px}.note{padding:20px;background:#fff0ca}</style><h1>WOM controlled model study</h1><p>${escape(p.id)} · ${analysis.photos} distinct photographs · ${analysis.cases} objects · ${TRIALS} fresh trials per model · ${analysis.rows} live agent attempts · $${spent.toFixed(4)} token-accounted spend.</p><p class="note">Controlled, repeated evaluation on the project's existing development assets. This measures source-camera placement using identical WOMAgent tools. It is not a held-out population benchmark or a Global WOMPar preference ranking.</p><h2>Results</h2><table><tr><th>Model</th><th>Completed</th><th>Photo-weighted IoU</th><th>Total cost</th><th>Median wall time</th></tr>${rows}</table><p>${escape(analysis.estimand)}</p><h2>Prespecified comparisons</h2>${pairs}<p>Only four photograph clusters are available. Repeating calls estimates variability on these inputs; it does not create new independent photographs. Surface-supported objects are retained and identified because the existing placement tools use a local support plane. Scoring against SAM masks can reward segmentation errors and asset contamination.</p><h2>Reference evidence</h2><table><tr><th>Object</th><th>Support</th><th>Grounded reference</th><th>Available auto-fit</th><th>Evidence</th></tr>${references}</table><h2>Audit and reproduction</h2><p><a href="protocol.json">Protocol registered before live collection</a> · <a href="results.json">Complete results and analysis</a> · <a href="progress.json">Progress</a></p><p>Protocol SHA-256: <code>${fileHash(path.join(dir, 'protocol.json'))}</code>. Exact model IDs, code/input hashes, seeded block order, full tool traces and sanitized request/response receipts are retained. No local cached responses count as fresh trials. Existing scenes were not changed.</p></html>`);
}

if (process.argv.includes('--prepare')) {
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  const dir = path.resolve('data/bench/model-study', id); await mkdir(dir, { recursive: true });
  const { records } = await loadCases(dir);
  const seed = 20261105;
  const blocks = shuffle(records.flatMap((c) => [1, 2, 3].map((trial) => ({ caseId: c.id, trial }))), seed)
    .map((b, i) => ({ ...b, models: shuffle(MODELS, seed + i + 1) }));
  const protocol: Protocol = { schema: 'wom-controlled-placement-study/1', id, preparedAt: new Date().toISOString(), models: MODELS, trials: TRIALS, maxUsd: MAX_USD, seed,
    gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), codeHashes: Object.fromEntries(CODE.map((p) => [p, fileHash(p)])), cases: records, blocks,
    hypothesis: 'Paired source-camera placement quality and completion, cost and latency differ between Spark/Terra and Wonder/Sol under identical WOM tools.',
    primary: 'Success-adjusted silhouette IoU: equal weights per unique photograph, then objects, then trials. Failed final submissions score zero; missing trials cannot rank.',
    secondary: ['Completion rate', 'Conditional IoU', 'Colour/depth/support error', 'Token-accounted total cost', 'Median observed end-to-end and model time'],
    settings: { protocol: 'agent', effort: 'medium', maxOutputTokensPerCall: 16000, maxNonSubmissionToolCalls: 8, maxModelCalls: 11, partialFallback: false, localCache: 'bypassed', concurrency: 4 },
    statistics: 'Average trials within objects and objects within photograph. Two-sided exact sign flip at photograph level; Holm correction for two primary comparisons. Exhaustive photo-bootstrap interval is descriptive only.',
    failurePolicy: 'Retain all final-submission failures with score zero. No selective retries or exclusions based on outcomes. Transient retries follow the existing client, are logged and charged; unknown requests reserve their maximum estimated cost.',
    stopping: 'Exactly 3 fresh attempts per model/object; stop new requests at $20. No outcome-based early stopping. Incomplete coverage remains explicitly unranked.',
    scope: 'Existing convenience development sample: 4 unique photographs, one saved IDOL asset/object, MoGe-3. No fresh 3D generation, no claim about coding ability, no Global Par inference. Portrait duplicate is excluded by source identity.',
    unavailable: 'Opus/Sonnet Kiro coding sessions are baseline provenance, not API subjects in this study; no Anthropic key is configured.',
    pricingSources: ['https://developers.openai.com/api/docs/models/gpt-6.1-sol', 'https://developers.openai.com/api/docs/models/gpt-6.1-terra', 'https://dev.meta.ai/docs/pricing-rate-limits'] };
  await json(path.join(dir, 'protocol.json'), protocol);
  console.log(JSON.stringify({ event: 'registered', dir, id, cases: records.length, photos: new Set(records.map((c) => c.photo)).size, attempts: blocks.length * MODELS.length, maxUsd: MAX_USD, protocolSha256: fileHash(path.join(dir, 'protocol.json')) }));
} else if (process.argv.includes('--run')) {
  const dir = process.argv[process.argv.indexOf('--run') + 1]; if (!dir) throw new Error('Specify the registered study directory');
  await run(path.resolve(dir));
} else throw new Error('Use --prepare, then --run <registered-study-directory>');
