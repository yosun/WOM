// Check the retained evidence independently of the study runner; makes no provider calls.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const dir = path.resolve(process.argv[2] ?? 'data/bench/model-study/20261105-002209');
const hash = (v) => createHash('sha256').update(v).digest('hex');
const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const protocol = await read(path.join(dir, 'protocol.json'));
const checks = [], errors = [], ids = new Set(), signatures = new Map();
const check = (name, condition) => { checks.push({ name, passed: !!condition }); if (!condition) errors.push(name); };
function canonical(body) {
  const messages = (body.messages ?? body.input).map((m) => ({ role: m.role === 'developer' ? 'system' : m.role,
    content: typeof m.content === 'string' ? m.content : m.content?.map((p) => ({ type: p.type === 'input_text' ? 'text' : p.type === 'input_image' ? 'image_url' : p.type,
      ...(p.text !== undefined ? { text: p.text } : {}), ...(p.image_url ? { image: typeof p.image_url === 'string' ? p.image_url : p.image_url.url } : {}) })) }));
  const tools = body.tools.map((t) => { const tool = t.function ?? t; return { name: tool.name, description: tool.description, parameters: tool.parameters }; });
  return { messages, tools, effort: body.reasoning?.effort ?? body.reasoning_effort, tokens: body.max_output_tokens ?? body.max_tokens, parallel: body.parallel_tool_calls };
}
for (const [file, expected] of Object.entries(protocol.codeHashes)) check(`Source snapshot: ${file}`, hash(await readFile(path.join(dir, 'source', file))) === expected);
for (const c of protocol.cases) {
  check(`Photo evidence: ${c.id}`, hash(await readFile(path.join(dir, c.inputDir, 'photo.jpg'))) === c.photoSha256);
  check(`Turntable evidence: ${c.id}`, hash(await readFile(path.join(dir, c.inputDir, 'turntable.jpg'))) === c.turntableSha256);
}
let requests = 0, responses = 0, cost = 0, unknown = 0;
for (const job of await readdir(path.join(dir, 'calls'))) {
  const block = protocol.blocks[Number(job.split('__')[0]) - 1];
  const folder = path.join(dir, 'calls', job);
  for (const name of await readdir(folder)) {
    const value = await read(path.join(folder, name));
    if (name.endsWith('-request.json')) {
      requests++;
      check(`Registered before request: ${job}/${name}`, Date.parse(value.at) >= Date.parse(protocol.preparedAt));
      if (name === '01-request.json') {
        const signature = hash(JSON.stringify(canonical(value.body)));
        const previous = signatures.get(block.caseId);
        check(`Identical first prompt/images/tools: ${job}`, !previous || signature === previous);
        signatures.set(block.caseId, signature);
      }
    } else if (name.endsWith('-response.json')) {
      responses++; cost += value.costUsd;
      if (value.responseId) { check(`Unique provider response: ${job}/${name}`, !ids.has(value.responseId)); ids.add(value.responseId); }
      check(`Requested model returned: ${job}/${name}`, job.endsWith(`__${value.model}`));
    } else if (name.endsWith('-unknown.json')) unknown++;
  }
}
let final = null;
try { final = await read(path.join(dir, 'results.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (final) {
  check('Protocol digest matches final result', final.protocolSha256 === hash(await readFile(path.join(dir, 'protocol.json'))));
  check('Every registered attempt has a receipt', final.receipts.length === protocol.cases.length * protocol.trials * protocol.models.length);
  check('All case/model/trial cells are unique', new Set(final.receipts.map((r) => `${r.row.caseId}/${r.row.model}/${r.row.trial}`)).size === final.receipts.length);
  check('Every counted call has a provider receipt', final.receipts.reduce((n, r) => n + r.row.calls, 0) === responses);
  check('Token cost reconciles with provider receipts', Math.abs(final.actualSpendUsd - cost) < 1e-8 && unknown === 0);
  check('Spend stayed below the registered cap', final.actualSpendUsd <= protocol.maxUsd);
  // Recompute the primary mean directly from receipts, independently of the analysis module.
  for (const summary of final.analysis.summaries) {
    const photoValues = [];
    for (const photo of new Set(protocol.cases.map((c) => c.photo))) {
      const objects = protocol.cases.filter((c) => c.photo === photo);
      const objectValues = objects.map((c) => {
        const rows = final.receipts.filter((r) => r.row.model === summary.model && r.row.caseId === c.id);
        check(`Complete repeat block: ${summary.model}/${c.id}`, rows.length === protocol.trials);
        return rows.reduce((n, r) => n + (r.row.status === 'completed' ? r.row.iou : 0), 0) / protocol.trials;
      });
      photoValues.push(objectValues.reduce((a, b) => a + b, 0) / objectValues.length);
    }
    const independentlyComputed = photoValues.reduce((a, b) => a + b, 0) / photoValues.length;
    check(`Independent equal-photo arithmetic: ${summary.model}`, Math.abs(independentlyComputed - summary.photoWeightedIou) < 1e-12);
  }
  const entries = (await readFile('data/ledger.jsonl', 'utf8')).split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } })
    .filter((entry) => entry.ref?.startsWith(`${protocol.id}:`));
  check('Paid calls reconcile with the WOMetrics ledger', Math.abs(entries.reduce((n, entry) => n + entry.usd, 0) - cost) < 1e-8);
}
const result = { checkedAt: new Date().toISOString(), final: !!final, requests, responses, unknown, tokenCostUsd: cost, distinctPromptCases: signatures.size, checks: checks.length, passed: checks.length - errors.length, errors };
await writeFile(path.join(dir, 'audit.json'), JSON.stringify({ ...result, details: checks }, null, 2));
console.log(JSON.stringify(result));
if (errors.length) process.exitCode = 1;
