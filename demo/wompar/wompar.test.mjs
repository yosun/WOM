import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { PROVIDERS, downloadSplat, generateWorld, reviewPair, selectProvider } from './providers.mjs';
import { ROOT, loadFixture, parseArgs, readEnvironment, renderReport, runDemo, sourceViewPar } from './wompar.mjs';

const execFileAsync = promisify(execFile);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const review = { choice: 'B', reason: 'Visible facial details match the source.', limitations: 'One view cannot establish 3D consistency.' };
const images = [0, 1, 2].map((i) => ({ mime: 'image/webp', bytes: Buffer.from(`image-${i}`), extension: '.webp' }));
const noNetwork = async () => { throw new Error('A request was made in offline mode.'); };
async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wompar-demo-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('one key alone selects each supported provider; blanks, aliases and explicit choices work', () => {
  for (const [provider, config] of Object.entries(PROVIDERS)) {
    for (const key of config.keys) assert.equal(selectProvider('auto', { [key]: 'test-key' }), provider);
  }
  assert.equal(selectProvider('auto', {}), 'offline');
  assert.equal(selectProvider('auto', { OPENAI_API_KEY: ' ', OPENAI_KEY: 'test-key' }), 'openai');
  assert.equal(selectProvider('auto', { AI3D_API_KEY: 'a', GEMINI_API_KEY: 'g' }), 'gemini');
  assert.equal(selectProvider('ai3d', { MUSE_API_KEY: 'm', AI3D_API_KEY: 'a' }), 'ai3d');
  assert.equal(selectProvider('offline', { OPENAI_API_KEY: 'secret' }), 'offline');
  assert.throws(() => selectProvider('anthropic', {}), /ANTHROPIC_API_KEY/);
  assert.throws(() => selectProvider('wrong', {}), /Choose/);
});

test('CLI rejects misspellings, missing values and invalid limits before doing work', () => {
  for (const argv of [['--typo'], ['--provider'], ['--timeout-seconds', '0'], ['--timeout-seconds', 'NaN'],
    ['--max-reservation-usd', '-1'], ['--timeout-seconds', '3601']]) assert.throws(() => parseArgs(argv));
  assert.equal(parseArgs(['--offline', '--provider', 'openai']).provider, 'offline');
  assert.equal(parseArgs(['--model', 'my-model']).model, 'my-model');
});

test('env files have predictable precedence and never override shell values', async (t) => {
  const dir = await temp(t);
  await writeFile(path.join(dir, '.env'), 'MUSE_API_KEY=first\nOPENAI_API_KEY=first\n');
  await writeFile(path.join(dir, '.env.local'), 'OPENAI_API_KEY=local\nGEMINI_API_KEY="local # quoted"\n');
  assert.deepEqual(await readEnvironment(dir, { MUSE_API_KEY: 'shell' }), {
    MUSE_API_KEY: 'shell', OPENAI_API_KEY: 'local', GEMINI_API_KEY: 'local # quoted',
  });
});

test('source-view Par is numeric, accounts for candidate side and ties, and requires both orders', () => {
  const pair = (first, second) => [{ candidateSide: 'B', review: { choice: first } }, { candidateSide: 'A', review: { choice: second } }];
  for (const [first, second, expected] of [
    ['B', 'A', -100], ['A', 'B', 100], ['tie', 'tie', 0], ['B', 'B', 0], ['A', 'A', 0],
    ['B', 'tie', -50], ['tie', 'A', -50], ['A', 'tie', 50], ['tie', 'B', 50],
  ]) {
    const reviews = pair(first, second);
    assert.equal(sourceViewPar(reviews), expected);
    assert.equal(sourceViewPar(reviews.toReversed()), expected);
  }
  assert.equal(sourceViewPar([]), null);
  assert.equal(sourceViewPar(pair('B', 'A').slice(0, 1)), null);
  assert.equal(sourceViewPar([pair('B', 'A')[0], pair('B', 'A')[0]]), null);
  assert.throws(() => sourceViewPar(pair('invalid', 'A')), /Invalid/);
});

test('checked-in public fixture hashes match and offline replay never calls a provider', async (t) => {
  const output = await temp(t), logs = [];
  const fixture = await loadFixture();
  assert.equal(fixture.images.length, 3);
  assert.ok(fixture.diagnostics.figureColorError255.candidate < fixture.diagnostics.figureColorError255.reference);
  const run = await runDemo(parseArgs(['--offline', '--output', output]), {
    env: { OPENAI_API_KEY: 'do-not-persist-this-secret' }, fetchImpl: noNetwork, log: (s) => logs.push(s),
  });
  assert.equal(run.result.globalPar, null);
  assert.equal(run.result.par, null);
  assert.equal(run.result.referencePar, 0);
  assert.equal(run.result.reviews.length, 0);
  assert.equal(run.result.status, 'not-ranked');
  const stored = await readFile(path.join(run.dir, 'results.json'), 'utf8');
  const html = await readFile(path.join(run.dir, 'report.html'), 'utf8');
  assert.ok(!stored.includes('do-not-persist-this-secret') && !html.includes('do-not-persist-this-secret'));
  assert.match(html, /data:image\/webp;base64,/);
  assert.match(html, /Not ranked/);
  assert.match(html, /aria-label="Reference Par">0<\/output>/);
  assert.match(html, /aria-label="Candidate source-view Par">Awaiting review<\/output>/);
  assert.ok(logs.some((s) => s.includes('Report:')));
});

for (const provider of ['muse', 'openai', 'gemini', 'anthropic']) {
  test(`${provider}: actual adapter sends the images, bounded output and only its own credential`, async () => {
    const key = `${provider}-test-secret`;
    const result = await reviewPair({ provider, env: { [PROVIDERS[provider].keys[0]]: key }, images,
      fetchImpl: async (url, options) => {
        const body = JSON.parse(options.body);
        assert.equal(body.model ?? PROVIDERS[provider].model, PROVIDERS[provider].model);
        assert.equal(options.redirect, 'error');
        assert.ok(!options.body.includes(key));
        for (const image of images) assert.ok(options.body.includes(image.bytes.toString('base64')));
        if (provider === 'muse') {
          assert.match(url, /api\.meta\.ai\/v1\/chat\/completions$/);
          assert.equal(options.headers.Authorization, `Bearer ${key}`);
          assert.equal(body.max_tokens, 4096);
          return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(review) } }], usage: { completion_tokens: 50 } });
        }
        if (provider === 'openai') {
          assert.match(url, /api\.openai\.com\/v1\/responses$/);
          assert.equal(body.store, false);
          assert.equal(body.text.format.strict, true);
          return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(review) }] }], usage: { output_tokens: 50 } });
        }
        if (provider === 'gemini') {
          assert.match(url, /generativelanguage\.googleapis\.com/);
          assert.ok(!url.includes(key));
          assert.equal(options.headers['x-goog-api-key'], key);
          assert.equal(body.generationConfig.responseMimeType, 'application/json');
          return json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(review) }] } }], usageMetadata: { candidatesTokenCount: 50 } });
        }
        assert.match(url, /api\.anthropic\.com\/v1\/messages$/);
        assert.equal(options.headers['x-api-key'], key);
        assert.equal(body.tool_choice.name, 'record_review');
        return json({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_review', input: review }], usage: { output_tokens: 50 } });
      },
    });
    assert.deepEqual(result.review, review);
    assert.ok(result.usage);
  });
}

test('live demo saves numeric source-view Par after both orders while preserving global ranking status', async (t) => {
  const output = await temp(t), sent = [], logs = [];
  const run = await runDemo(parseArgs(['--provider', 'openai', '--output', output]), {
    env: { OPENAI_API_KEY: 'test-secret', MUSE_API_KEY: 'unused' }, log: (s) => logs.push(s),
    fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body).input[0].content);
      const response = { ...review, choice: sent.length === 1 ? 'B' : 'A' };
      return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(response) }] }] });
    },
  });
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0][1], sent[1][1]); // same source
  assert.deepEqual(sent[0][2], sent[1][3]); // reference swaps sides
  assert.deepEqual(sent[0][3], sent[1][2]); // candidate swaps sides
  assert.deepEqual(run.result.reviews.map((r) => r.candidateSide), ['B', 'A']);
  assert.equal(run.result.par, -100);
  assert.equal(run.result.referencePar, 0);
  assert.equal(run.result.parScope, 'source-view');
  assert.equal(run.result.globalPar, null);
  assert.equal(run.result.status, 'not-ranked');
  const stored = JSON.parse(await readFile(path.join(run.dir, 'results.json'), 'utf8'));
  assert.equal(stored.par, -100);
  assert.equal(typeof stored.par, 'number');
  const html = await readFile(path.join(run.dir, 'report.html'), 'utf8');
  assert.match(html, /aria-label="Candidate source-view Par">-100<\/output>/);
  assert.ok(logs.some((s) => s.includes('Source-view Par: -100')));
});

test('provider failures do not leak response bodies or retry paid calls; partial results survive', async (t) => {
  const output = await temp(t);
  let calls = 0;
  await assert.rejects(runDemo(parseArgs(['--provider', 'openai', '--output', output]), {
    env: { OPENAI_API_KEY: 'test-secret' }, log: () => {},
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(review) }] }] });
      return json({ error: 'raw-credential-body test-secret' }, 401);
    },
  }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes('raw-credential-body') && !error.message.includes('test-secret'));
    return true;
  });
  assert.equal(calls, 2);
  const { readdir } = await import('node:fs/promises');
  const [folder] = await readdir(output);
  const stored = JSON.parse(await readFile(path.join(output, folder, 'results.json'), 'utf8'));
  assert.equal(stored.reviews.length, 1);
  assert.equal(stored.reviewCallsAttempted, 2);
  assert.equal(stored.par, null);
  assert.equal(stored.referencePar, 0);
  assert.match(stored.error, /HTTP 401/);
});

test('truncation and malformed model JSON cannot become valid comparisons', async () => {
  for (const response of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"choice":"unknown"}' }] }] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] },
  ]) await assert.rejects(reviewPair({ provider: 'openai', env: { OPENAI_API_KEY: 'test' }, images, fetchImpl: async () => json(response) }));
});

test('AI3D generation preflights price, uploads once, saves recovery key before submitting and polls one job', async () => {
  const routes = [], saved = [];
  const result = await generateWorld({ env: { AI3D_API_KEY: 'ai3d-test-key' }, image: images[0], onProgress: () => {},
    onJob: async (job) => { saved.push(job); }, sleep: async () => {},
    fetchImpl: async (url, options) => {
      routes.push(new URL(url).pathname);
      assert.equal(options.headers.Authorization, 'Bearer ai3d-test-key');
      if (url.includes('/models?')) return json({ models: [{ id: 'worldlabs-draft' }] });
      if (url.endsWith('/billing/prices')) return json({ prices: [{ model: 'worldlabs-draft', reserve_nano_usd: 180_000_000 }] });
      if (url.endsWith('/uploads')) { assert.ok(options.body instanceof FormData); return json({ image_url: 'https://uploads.example/source.webp' }); }
      if (url.endsWith('/jobs')) {
        assert.equal(saved[0].idempotencyKey, options.headers['Idempotency-Key']);
        assert.equal(JSON.parse(options.body).model, 'worldlabs-draft');
        return json({ id: 'job-demo', status: 'running' });
      }
      return json({ id: 'job-demo', status: 'succeeded', billing: { charged_nano_usd: 170_000_000 }, artifacts: [] });
    },
  });
  assert.equal(result.jobId, 'job-demo');
  assert.equal(result.reservationUsd, 0.18);
  assert.equal(result.chargedUsd, 0.17);
  assert.equal(routes.filter((r) => r === '/v2/jobs').length, 1);
});

test('AI3D resume never uploads or resubmits, and reservation limits fail before upload', async () => {
  let calls = 0;
  await generateWorld({ env: { AI3D_API_KEY: 'test' }, image: images[0], resume: 'saved-job',
    fetchImpl: async (url) => { calls++; assert.match(url, /\/jobs\/saved-job$/); return json({ id: 'saved-job', status: 'succeeded' }); },
  });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(generateWorld({ env: { AI3D_API_KEY: 'test' }, image: images[0], maxReservationUsd: 0.01,
    fetchImpl: async (url) => {
      calls++;
      if (url.includes('/models?')) return json({ models: [{ id: 'worldlabs-draft' }] });
      assert.match(url, /\/billing\/prices$/);
      return json({ prices: [{ model: 'worldlabs-draft', reserve_estimate_usd: '0.18' }] });
    },
  }), /reservation exceeds/);
  assert.equal(calls, 2);
});

test('AI3D-only demo downloads the smallest returned SPZ and resumption never invents source provenance', async (t) => {
  const output = await temp(t);
  const env = { AI3D_API_KEY: 'test-key' };
  const job = { id: 'my-job', status: 'succeeded', model: 'worldlabs-draft',
    artifacts: [
      { name: 'large.spz', size: 100, download_url: 'https://api.ai3d.dev/v2/files/large.spz' },
      { name: 'small.spz', size: 10, download_url: 'https://api.ai3d.dev/v2/files/small.spz' },
    ],
  };
  const fetchImpl = async (url) => {
    if (url.includes('/models?')) return json({ models: [{ id: 'worldlabs-draft' }] });
    if (url.endsWith('/prices')) return json({ prices: [{ model: 'worldlabs-draft', reserve_estimate_usd: '0.18' }] });
    if (url.endsWith('/uploads')) return json({ image_url: 'https://uploads.example/image.webp' });
    if (url.includes('/jobs')) return json(job);
    assert.ok(url.endsWith('/small.spz'));
    return new Response('SPZ fixture');
  };
  const first = await runDemo(parseArgs(['--provider', 'ai3d', '--output', output]), { env, fetchImpl, log: () => {} });
  assert.equal((await readFile(path.join(first.dir, 'world.spz'))).toString(), 'SPZ fixture');
  assert.equal(first.result.generation.file.artifact, 'small.spz');
  assert.ok(first.result.generation.sourceSha256);
  assert.equal(first.result.globalPar, null);
  assert.equal(first.result.par, null);
  assert.equal(first.result.referencePar, 0);
  const resumed = await runDemo(parseArgs(['--provider', 'ai3d', '--resume', 'my-job', '--output', output]), { env, fetchImpl, log: () => {} });
  assert.equal(resumed.result.generation.sourceSha256, null);
  const html = await readFile(path.join(resumed.dir, 'report.html'), 'utf8');
  assert.match(html, /original input is not verified/);
});

test('custom image comparisons omit unrelated saved diagnostic measurements', async (t) => {
  const output = await temp(t);
  const { fixture } = await loadFixture();
  const options = parseArgs(['--offline', '--output', output,
    '--source', path.join(ROOT, fixture.source.path), '--reference', path.join(ROOT, fixture.reference.path), '--candidate', path.join(ROOT, fixture.candidate.path)]);
  const { result } = await runDemo(options, { env: {}, fetchImpl: noNetwork, log: () => {} });
  assert.equal(result.diagnostics, null);
  assert.equal(result.globalPar, null);
  assert.equal(result.par, null);
  assert.equal(result.referencePar, 0);
  assert.equal(result.evidence[0].sha256, fixture.source.sha256);
  await assert.rejects(runDemo(parseArgs(['--offline', '--source', options.source, '--output', output]), { env: {}, fetchImpl: noNetwork, log: () => {} }), /together/);
});

test('AI3D unknown submission status stops; the prewritten recovery key survives a lost response', async () => {
  await assert.rejects(generateWorld({ env: { AI3D_API_KEY: 'test' }, resume: 'unknown-job', onProgress: () => {},
    fetchImpl: async () => json({ id: 'unknown-job', status: 'submission_unknown' }),
  }), /submission_unknown/);
  let recovery;
  await assert.rejects(generateWorld({ env: { AI3D_API_KEY: 'test' }, image: images[0], onJob: async (job) => { recovery = job; },
    fetchImpl: async (url) => {
      if (url.includes('/models?')) return json({ models: [{ id: 'worldlabs-draft' }] });
      if (url.endsWith('/prices')) return json({ prices: [{ model: 'worldlabs-draft', reserve_estimate_usd: '0.18' }] });
      if (url.endsWith('/uploads')) return json({ image_url: 'https://uploads.example/image.webp' });
      throw new Error('sensitive raw network body');
    },
  }), /No request was retried/);
  assert.match(recovery.idempotencyKey, /^wompar-demo-/);
  assert.equal(recovery.status, 'submitting');
});

test('SPZ download authenticates only AI3D-origin URLs, and HTML escapes model content', async () => {
  for (const url of ['https://api.ai3d.dev/v2/files/demo.spz', 'https://signed.example/demo.spz']) {
    const bytes = await downloadSplat({ env: { AI3D_API_KEY: 'private-key' }, artifact: { downloadUrl: url },
      fetchImpl: async (_url, options) => {
        assert.equal(Boolean(options.headers.Authorization), url.includes('api.ai3d.dev'));
        assert.equal(options.redirect, 'error');
        return new Response('SPZ bytes');
      },
    });
    assert.equal(bytes.toString(), 'SPZ bytes');
  }
  const html = renderReport({ scope: '<script>bad()</script>', provider: 'offline', offline: true, reference: 'Reference', candidate: 'Candidate',
    diagnostics: null, generation: null, reviews: [{ candidateSide: 'B', review: { ...review, reason: '<img src=x onerror=alert(1)>' } }],
  }, images);
  assert.ok(!html.includes('<script>bad()'));
  assert.match(html, /&lt;img src=x/);
});

test('CLI works from another directory without dependencies, .env, a server or Git metadata', async (t) => {
  const output = await temp(t);
  const { stdout } = await execFileAsync(process.execPath, [path.join(ROOT, 'demo/wompar/wompar.mjs'), '--offline', '--output', output], {
    cwd: output, env: { PATH: process.env.PATH },
  });
  assert.match(stdout, /Global Par: Not ranked/);
  assert.match(stdout, /Reference Par: 0/);
  const { stdout: help } = await execFileAsync(process.execPath, [path.join(ROOT, 'demo/wompar/wompar.mjs'), '--help'], { cwd: output });
  assert.match(help, /ANTHROPIC_API_KEY/);
});
