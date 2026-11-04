#!/usr/bin/env node
// node demo/wompar/wompar.mjs --help — no npm install required.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { PROVIDERS, REVIEW_PROMPT, downloadSplat, generateWorld, reviewPair, selectProvider } from './providers.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = new URL('./fixture.json', import.meta.url);
export const HELP = `WOMetrics / WOMPar standalone demo — Node 22.18+, no npm install

  node demo/wompar/wompar.mjs                       Auto-select one configured key
  node demo/wompar/wompar.mjs --offline             Public saved measurements; no network
  node demo/wompar/wompar.mjs --provider openai     One selected vision provider, two A/B calls
  node demo/wompar/wompar.mjs --provider ai3d       One real Marble draft world-generation job

Options:
  --provider auto|muse|openai|gemini|anthropic|ai3d|offline
  --offline                 Ignore all keys; make no network requests
  --check                   Show configured providers by name; make no requests
  --model ID                Override the selected provider's default model
  --source FILE             With --reference and --candidate, review your three images
                            For AI3D, use only --source to generate from your photo
  --reference FILE          Reference render (JPEG/PNG/WebP)
  --candidate FILE          Candidate render (JPEG/PNG/WebP)
  --output DIR              Create a new run folder here (default data/wompar-demo)
  --resume JOB_ID           Resume AI3D polling without uploading or submitting again
  --timeout-seconds N       AI3D polling timeout (default 600)
  --max-reservation-usd N   AI3D reservation ceiling (default 2; final charge can differ)
  --help                    Show this help

Set just ONE of MUSE_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY or
AI3D_API_KEY in your environment, .env or .env.local. Shell variables take priority.
Auto priority: Muse, OpenAI, Gemini, Anthropic, AI3D; no keys selects offline.
Review calls are billed by the selected provider. AI3D runs one generation job.
Source-view Par is numeric after both A/B comparisons: 0 matches the reference; lower is better.
This source-view demo does not award a complete-course global Par score.
`;

export function parseArgs(argv) {
  const options = { provider: 'auto', output: path.join(ROOT, 'data/wompar-demo'), timeoutSeconds: 600, maxReservationUsd: 2 };
  const values = { '--provider': 'provider', '--model': 'model', '--source': 'source', '--reference': 'reference', '--candidate': 'candidate',
    '--output': 'output', '--resume': 'resume', '--timeout-seconds': 'timeoutSeconds', '--max-reservation-usd': 'maxReservationUsd' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '-h', '--offline', '--check'].includes(arg)) { options[arg === '-h' ? 'help' : arg.slice(2)] = true; continue; }
    if (!Object.hasOwn(values, arg) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid option or missing value. Run with --help.');
    options[values[arg]] = argv[++i];
  }
  for (const field of ['timeoutSeconds', 'maxReservationUsd']) {
    options[field] = Number(options[field]);
    if (!Number.isFinite(options[field]) || options[field] <= 0) throw new Error('Timeout and reservation ceiling must be positive numbers.');
  }
  if (options.timeoutSeconds > 3600) throw new Error('AI3D timeout may be at most 3600 seconds; use --resume for longer jobs.');
  if (options.offline) options.provider = 'offline';
  return options;
}

export async function readEnvironment(root = ROOT, shell = process.env) {
  const fromFiles = {};
  for (const name of ['.env', '.env.local']) {
    try { Object.assign(fromFiles, parseEnv(await readFile(path.join(root, name), 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read ${name}. Check its permissions and format.`); }
  }
  return { ...fromFiles, ...shell };
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function imageAt(file, expected) {
  const bytes = await readFile(file);
  if (expected && digest(bytes) !== expected) throw new Error('Public fixture hash mismatch. Restore the checked-in demo assets.');
  const extension = path.extname(file).toLowerCase();
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[extension];
  if (!mime || bytes.length > 10 * 1024 * 1024 || bytes.length < 12) throw new Error('Use JPEG, PNG or WebP images, each at most 10 MiB.');
  const valid = mime === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8
    : mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('Image contents do not match their JPEG, PNG or WebP extension.');
  return { bytes, mime, extension, sha256: digest(bytes) };
}

export async function loadFixture() {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const images = await Promise.all(['source', 'reference', 'candidate'].map((name) => imageAt(path.join(ROOT, fixture[name].path), fixture[name].sha256)));
  const bytes = await readFile(path.join(ROOT, fixture.measurements.path));
  if (digest(bytes) !== fixture.measurements.sha256) throw new Error('Public measurement hash mismatch. Restore the checked-in demo assets.');
  const saved = JSON.parse(bytes);
  return { fixture, images, diagnostics: {
    provenance: 'Saved measurements of the public object-split case; not recomputed by this demo.',
    figureColorError255: { reference: saved.figureError.one, candidate: saved.figureError.eyes },
    rightEyeShiftPx: { reference: saved.eyeMetrics.one.right.shiftPx, candidate: saved.eyeMetrics.eyes.right.shiftPx },
    leftEyeShiftPx: { reference: saved.eyeMetrics.one.left.shiftPx, candidate: saved.eyeMetrics.eyes.left.shiftPx },
    sideGapPixels: saved.sideGaps,
  } };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Average both presentation orders for one judge; this is a source-view diagnostic. */
export function sourceViewPar(reviews) {
  if (reviews.length !== 2 || !['A', 'B'].every((side) => reviews.some((r) => r.candidateSide === side))) return null;
  const preference = reviews.reduce((sum, { candidateSide, review }) => {
    if (!['A', 'B', 'tie'].includes(review.choice)) throw new Error('Invalid source-view comparison choice.');
    return sum + (review.choice === 'tie' ? 0.5 : review.choice === candidateSide ? 1 : 0);
  }, 0) / reviews.length;
  return 100 * (1 - 2 * preference) || 0;
}

const formatPar = (score) => score > 0 ? `+${score}` : String(score);

export function renderReport(result, images, generationImage = images[0]) {
  const names = ['Source photograph', 'Reference: ' + result.reference, 'Candidate: ' + result.candidate];
  const figures = images.map((im, i) => `<figure><img alt="${escapeHtml(names[i])}" src="data:${im.mime};base64,${im.bytes.toString('base64')}"><figcaption>${escapeHtml(names[i])}</figcaption></figure>`).join('');
  const reviews = result.reviews.map((r) => `<li><strong>Candidate shown as ${r.candidateSide}: ${escapeHtml(r.review.choice)}</strong><p>${escapeHtml(r.review.reason)}</p><p>${escapeHtml(r.review.limitations)}</p></li>`).join('');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WOMetrics — WOMPar demo</title><style>
body{font:17px/1.55 system-ui,sans-serif;color:#213129;background:#f6f4ed;max-width:1200px;margin:36px auto;padding:0 24px}
h1{font-size:clamp(2rem,6vw,4rem);letter-spacing:-.04em;margin-bottom:0}a{color:#225b43}.status{padding:14px 20px;background:#e5eddf;border-left:4px solid #436943}
.par-scores{display:flex;flex-wrap:wrap;gap:24px;margin:24px 0}.par-score{flex:1;min-width:0;padding:20px;background:#e5eddf;border-radius:8px}.par-score h2{font-size:1rem;margin:0}.par-score output{display:block;font-size:clamp(2rem,6vw,4rem);font-weight:600;font-variant-numeric:tabular-nums}.par-score p{margin:0}.par-help{margin-top:0}
.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}figure{margin:0}img{width:100%;height:330px;object-fit:contain;background:#e8e6df}figcaption{padding:8px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:16px;border-radius:8px}li{margin:20px 0}@media(max-width:700px){.par-scores{flex-direction:column}.images{grid-template-columns:1fr}img{height:auto}}
</style><h1>WOMetrics</h1><p>World Observation Metrics · WOMPar standalone demo</p>
<section aria-label="Source-view Par"><div class="par-scores"><div class="par-score"><h2>Demo reference Par</h2><output aria-label="Reference Par">0</output><p>${escapeHtml(result.reference)}</p></div><div class="par-score"><h2>Candidate source-view Par</h2><output aria-label="Candidate source-view Par">${typeof result.par === 'number' ? formatPar(result.par) : 'Awaiting review'}</output><p>${escapeHtml(result.candidate)}</p></div></div>
<p class="par-help">0 matches the reference. Negative beats it; positive trails it. Range: −100 to +100. The candidate score uses both A/B orders from one model reviewing this source view.</p>
${typeof result.par === 'number' ? '' : '<p>Both A/B comparisons are required for a candidate score. Offline and AI3D generation modes do not review the candidate.</p>'}</section>
<p class="status"><strong>Global WOMPar: Not ranked.</strong> ${escapeHtml(result.scope)}</p>
<p>Mode: <strong>${escapeHtml(result.provider)}</strong>. Review requests attempted: ${result.reviewCallsAttempted ?? result.reviews.length}; completed comparisons: ${result.reviews.length}. ${result.offline ? 'Offline: no network requests.' : 'One provider selected; other keys are unused.'}</p>
<div class="images">${figures}</div><h2>${result.diagnostics ? 'Saved diagnostics' : 'Custom comparison'}</h2>${result.diagnostics ? '<pre>' + escapeHtml(JSON.stringify(result.diagnostics, null, 2)) + '</pre>' : '<p>Saved fixture measurements do not apply to these custom images.</p>'}
<h2>Live source-view comparisons</h2>${reviews ? '<ul>' + reviews + '</ul>' : '<p>No live comparison recorded.</p>'}
${result.provider === 'ai3d' ? '<h2>AI3D generation input</h2>' + (result.resumed
    ? '<p>Resumed an existing job. Its original input is not verified by this run; see the original job report.</p>'
    : '<figure><img alt="Photo submitted for AI3D generation" src="data:' + generationImage.mime + ';base64,' + generationImage.bytes.toString('base64') + '"><figcaption>Generation input SHA-256: ' + escapeHtml(generationImage.sha256) + '</figcaption></figure>') : ''}
${result.generation ? '<h2>AI3D generation</h2><p>This new world has not been rendered or judged by the source-view comparison above.</p>' +
    (result.generation.file ? '<p><a href="world.spz">Download the generated 3D world (SPZ)</a></p>' : '') +
    (result.generation.viewerUrl ? '<p><a href="' + escapeHtml(result.generation.viewerUrl) + '">Open the AI3D viewer</a></p>' : '') +
    '<pre>' + escapeHtml(JSON.stringify(result.generation, null, 2)) + '</pre>' : ''}
${result.error ? '<h2>Run incomplete</h2><p>' + escapeHtml(result.error) + '</p>' : ''}
<p>The public saved case demonstrates reconstruction tradeoffs. Its whole-person reference and split candidate are from the scripted object-split experiment, not the frozen global pilot course. Side gaps can increase while source-view detail improves.</p>
<p>WOMPar 0.1 defines Par 0 on its named full course; negative beats that reference. A valid complete-course score requires frozen walkthrough evidence and the full independent judging panel.</p>
<p>See <a href="https://github.com/yosun/WOM/tree/main/docs/wometrics/contributing.md">contributing a setup</a>. <a href="results.json">Download this report's JSON</a>.</p></html>`;
}

// Do not forward raw provider bodies, environment values, or untrusted network errors to logs/reports.
function safeError(error, env) {
  let message = error instanceof Error ? error.message : 'Demo failed.';
  for (const p of Object.values(PROVIDERS)) for (const name of p.keys) {
    const value = env[name]?.trim();
    if (value) message = message.split(value).join('[redacted]');
  }
  return message;
}

export async function runDemo(options, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const provider = selectProvider(options.provider, env);
  if (options.resume && provider !== 'ai3d') throw new Error('--resume requires --provider ai3d.');
  const custom = Boolean(options.source || options.reference || options.candidate);
  if (custom && provider !== 'ai3d' && !(options.source && options.reference && options.candidate)) {
    throw new Error('Custom review requires --source, --reference and --candidate together.');
  }
  if (provider === 'ai3d' && (options.reference || options.candidate)) throw new Error('AI3D generates from --source; use a vision provider to compare render images.');
  const saved = await loadFixture();
  const images = custom && provider !== 'ai3d'
    ? await Promise.all([options.source, options.reference, options.candidate].map((file) => imageAt(path.resolve(file))))
    : saved.images;
  const generationImage = provider === 'ai3d' && options.source ? await imageAt(path.resolve(options.source)) : images[0];
  await mkdir(options.output, { recursive: true });
  const dir = await mkdtemp(path.join(path.resolve(options.output), 'run-'));
  const result = { schema: 'wompar-demo/1', createdAt: new Date().toISOString(), provider, offline: provider === 'offline', resumed: Boolean(options.resume),
    scope: 'Single-source-view demonstration; no complete-course evidence or independent judging panel.',
    reference: custom && provider !== 'ai3d' ? 'Your reference render' : saved.fixture.reference.label,
    candidate: custom && provider !== 'ai3d' ? 'Your candidate render' : saved.fixture.candidate.label,
    par: null, referencePar: 0, parScope: 'source-view', globalPar: null, status: 'not-ranked',
    diagnostics: custom && provider !== 'ai3d' ? null : saved.diagnostics,
    diagnosticsSource: custom && provider !== 'ai3d' ? null : saved.fixture.measurements,
    evidence: images.map((im, i) => ({ role: ['source', 'reference', 'candidate'][i], sha256: im.sha256 })),
    configuration: { prompt: REVIEW_PROMPT, promptSha256: digest(REVIEW_PROMPT),
      model: options.model || env[PROVIDERS[provider]?.modelEnv]?.trim() || PROVIDERS[provider]?.model || null },
    reviewCallsAttempted: 0, reviews: [], generation: null, error: null,
  };
  const persist = async () => {
    await writeFile(path.join(dir, 'results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    await writeFile(path.join(dir, 'report.html'), renderReport(result, images, generationImage), { mode: 0o600 });
  };
  // A useful inspectable report exists even if a provider fails after a billed request.
  await persist();
  log(`WOMetrics / WOMPar demo: ${provider}. Reference Par: ${result.referencePar}. Global Par: Not ranked.`);
  log(`Report: ${path.join(dir, 'report.html')}`);
  try {
    if (provider === 'ai3d') {
      result.generation = await generateWorld({ env, image: generationImage, model: options.model, resume: options.resume,
        timeoutMs: options.timeoutSeconds * 1000, maxReservationUsd: options.maxReservationUsd, fetchImpl,
        onProgress: log, onJob: (job) => writeFile(path.join(dir, 'job.json'), JSON.stringify({ ...job,
          sourceSha256: options.resume ? null : generationImage.sha256 }, null, 2) + '\n', { mode: 0o600 }),
      });
      result.generation.sourceSha256 = options.resume ? null : generationImage.sha256;
      await persist();
      const artifact = result.generation.artifacts.filter((a) => /\.spz$/i.test(a.name) && typeof a.downloadUrl === 'string')
        .sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))[0];
      if (!artifact) throw new Error('AI3D succeeded without a downloadable SPZ. Inspect job.json for retained artifacts.');
      const splat = await downloadSplat({ env, artifact, fetchImpl });
      await writeFile(path.join(dir, 'world.spz'), splat, { mode: 0o600 });
      result.generation.file = { path: 'world.spz', sha256: digest(splat), bytes: splat.length, artifact: artifact.name };
    } else if (provider !== 'offline') {
      for (const candidateSide of ['B', 'A']) {
        const ordered = candidateSide === 'B' ? images : [images[0], images[2], images[1]];
        const t0 = performance.now();
        result.reviewCallsAttempted++;
        await persist();
        const response = await reviewPair({ provider, env, images: ordered, model: options.model, fetchImpl });
        result.reviews.push({ candidateSide, ...response, latencyMs: Math.round(performance.now() - t0) });
        result.par = sourceViewPar(result.reviews);
        await persist();
        log(`Source-view comparison ${result.reviews.length}/2 saved (candidate ${candidateSide}).`);
      }
    }
  } catch (error) {
    result.error = safeError(error, env);
    await persist();
    throw new Error(`${result.error} Partial report saved in ${dir}`);
  }
  await persist();
  if (result.par !== null) log(`Source-view Par: ${formatPar(result.par)} (reference ${result.referencePar}; lower is better).`);
  log(`Saved ${path.join(dir, 'results.json')}`);
  return { dir, result };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(HELP); return; }
  const env = await readEnvironment();
  if (options.check) {
    for (const provider of Object.keys(PROVIDERS)) {
      const configured = PROVIDERS[provider].keys.some((key) => Boolean(env[key]?.trim()));
      console.log(`${provider}: ${configured ? 'configured' : 'not configured'}`);
    }
    return;
  }
  await runDemo(options, { env });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
