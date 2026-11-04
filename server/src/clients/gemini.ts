// Gemini 3.8 Flash, by one of two routes:
//
//   GEMINI_API_KEY       the Gemini API (generativelanguage.googleapis.com). A key in the environment is all it needs,
//                        so it works anywhere the app runs, AWS included. Preferred when the key is set.
//   .kiro/gcp-project.json   Vertex AI in a verified Google Cloud project, authenticated with the local gcloud CLI. The
//                        project is deliberately read only from that file, so a benchmark run cannot silently charge
//                        whichever project happens to be active in a user's global gcloud config.
//
// Both take the same request and report usage the same way.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from '../config.ts';
import { HttpError, withRetry } from '../util.ts';

const execFileAsync = promisify(execFile);
const MODEL = 'gemini-3.8-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** USD per 1M tokens. 3.8 Flash has an introductory price until the end of 2026 (Google's pricing page). */
function tokenPrices() {
  return Date.now() < Date.UTC(2027, 0, 1) ? { input: 0.75, cached: 0.075, output: 3.75 } : { input: 1.5, cached: 0.15, output: 7.5 };
}

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface GcpProjectFile {
  projectId?: unknown;
  region?: unknown;
  cloudRunService?: unknown;
}

const apiKey = () => process.env.GEMINI_API_KEY?.trim() || undefined;
const projectFile = () => path.join(ROOT, '.kiro', 'gcp-project.json');

export function geminiConfigured() {
  return Boolean(apiKey()) || existsSync(projectFile());
}

function projectId(): string {
  const file = projectFile();
  if (!existsSync(file)) {
    throw new Error('Gemini needs GEMINI_API_KEY, or a verified GCP target in .kiro/gcp-project.json (create it after confirming the projectId).');
  }
  let raw: GcpProjectFile;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as GcpProjectFile;
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  const id = typeof raw.projectId === 'string' ? raw.projectId.trim() : '';
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(id)) throw new Error(`${file} must contain a valid projectId.`);
  return id;
}

async function accessToken(project: string): Promise<string> {
  const bin = process.env.GCLOUD_BIN?.trim() || 'gcloud';
  const result = await execFileAsync(bin, ['auth', 'print-access-token', `--project=${project}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const token = String(result.stdout).trim();
  if (!token) throw new Error('gcloud returned no access token. Run gcloud auth application-default login or gcloud auth login.');
  return token;
}

function tokenCostUsd(usage: GeminiUsage) {
  const p = tokenPrices();
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (uncached * p.input + usage.cachedTokens * p.cached + usage.outputTokens * p.output) / 1e6;
}

export interface GeminiJsonRequest {
  model?: string;
  system: string;
  content: { text?: string; inlineData?: { mimeType: string; data: string } }[];
  schema: Record<string, unknown>;
  thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  maxTokens?: number;
}

/** Who a request is made as: a key for the Gemini API, or a token for a Vertex AI project. */
type Auth = { kind: 'key'; key: string } | { kind: 'vertex'; project: string; token: string };

/** One way of spelling the request. A 400 is not billed, so the next spelling can be tried without paying twice. */
interface Spelling {
  schemaField: 'responseJsonSchema' | 'responseSchema';
  level: string;
}

async function generate(auth: Auth, req: GeminiJsonRequest, spelling: Spelling) {
  const model = req.model ?? MODEL;
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: req.content }],
    generationConfig: {
      responseMimeType: 'application/json',
      [spelling.schemaField]: req.schema,
      thinkingConfig: { thinkingLevel: spelling.level },
      maxOutputTokens: req.maxTokens ?? 1400,
    },
  };
  let url: string;
  let headers: Record<string, string>;
  if (auth.kind === 'key') {
    url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    // In a header, never the query string: URLs end up in logs.
    headers = { 'x-goog-api-key': auth.key, 'Content-Type': 'application/json' };
  } else {
    const location = process.env.GEMINI_LOCATION?.trim() || 'global';
    url = `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(auth.project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  }
  const who = auth.kind === 'key' ? 'Gemini API' : 'Vertex AI';
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`${who} returned ${res.status}`, res.status, text);
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new HttpError(`${who} returned invalid JSON`, 502, text.slice(0, 500));
  }
}

export async function geminiChatJson<T>(req: GeminiJsonRequest): Promise<{ data: T; usage: GeminiUsage; costUsd: number }> {
  const key = apiKey();
  const auth: Auth = key ? { kind: 'key', key } : { kind: 'vertex', project: projectId(), token: await accessToken(projectId()) };
  const level = req.thinkingLevel ?? 'LOW';
  // The first spelling is the documented one. The others cover an endpoint that words the same setting differently:
  // the Gemini API's enum may be lower case, and Vertex endpoints have taken the older `responseSchema` field.
  const spellings: Spelling[] = auth.kind === 'key'
    ? [{ schemaField: 'responseJsonSchema', level }, { schemaField: 'responseJsonSchema', level: level.toLowerCase() }]
    : [{ schemaField: 'responseJsonSchema', level }, { schemaField: 'responseSchema', level }];
  let json: Record<string, any> | undefined;
  for (let i = 0; i < spellings.length; i++) {
    try {
      json = await withRetry(`Gemini ${req.model ?? MODEL}`, () => generate(auth, req, spellings[i]));
      break;
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 400 || i === spellings.length - 1) throw err;
    }
  }
  if (!json) throw new Error('Gemini returned no response');
  const parts = json.candidates?.[0]?.content?.parts;
  const content = Array.isArray(parts) ? parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('') : '';
  if (!content) throw new Error(`Gemini returned no content (${json.candidates?.[0]?.finishReason ?? 'unknown'})`);
  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch {
    throw new Error(`Gemini returned JSON that does not parse: ${content.slice(0, 240)}`);
  }
  const meta = json.usageMetadata ?? {};
  const usage: GeminiUsage = {
    inputTokens: Number(meta.promptTokenCount ?? 0),
    // Reasoning is reported apart from the answer (thoughtsTokenCount) and billed as output.
    outputTokens: Number(meta.candidatesTokenCount ?? 0) + Number(meta.thoughtsTokenCount ?? 0),
    cachedTokens: Number(meta.cachedContentTokenCount ?? 0),
  };
  return { data, usage, costUsd: tokenCostUsd(usage) };
}
