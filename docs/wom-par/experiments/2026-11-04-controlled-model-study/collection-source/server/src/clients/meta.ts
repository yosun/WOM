// Minimal client for Meta Model API (https://api.meta.ai/v1): Muse Spark / Muse Wonder chat with
// structured output, SAM 3.1 segmentation over the Responses API, and Muse Image edits.
import { META_BASE_URL, metaKey } from '../config.ts';
import { HttpError, withRetry } from '../util.ts';

export interface MetaUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** Pay-as-you-go prices from https://dev.meta.ai/docs/pricing-rate-limits (USD per 1M tokens). */
const TOKEN_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'muse-spark-1.3': { input: 1.25, cached: 0.15, output: 4.25 },
  'muse-wonder-1.0': { input: 4.0, cached: 0.2, output: 20.0 },
};

export function tokenCostUsd(model: string, usage: MetaUsage): number {
  const p = TOKEN_PRICES[model] ?? TOKEN_PRICES['muse-spark-1.3'];
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (uncached * p.input + usage.cachedTokens * p.cached + usage.outputTokens * p.output) / 1e6;
}

export const MUSE_IMAGE_PRICE_USD = 0.01;
export const SAM_IMAGE_PRICE_USD = 0.0025;

async function metaFetch(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const res = await fetch(`${META_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${metaKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`Meta API ${path} returned ${res.status}`, res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`Meta API ${path} returned invalid JSON`, 502, text.slice(0, 500));
  }
}

export function toDataUrl(bytes: Uint8Array, mime: string) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

export type ChatContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContent[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; responseItems?: Record<string, unknown>[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** JSON schema for the final answer (structured output). */
  schema?: { name: string; schema: Record<string, unknown> };
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
  parallelToolCalls?: boolean;
}

export interface ChatResult {
  message: { content: string | null; tool_calls?: ToolCall[]; responseItems?: Record<string, unknown>[] };
  finishReason: string;
  usage: MetaUsage;
  costUsd: number;
}

/** One Chat Completions call with optional tools (tool_choice is always "auto" on Model API). */
export async function chatCompletion(req: ChatRequest, options: { signal?: AbortSignal } = {}): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    reasoning_effort: req.reasoningEffort ?? 'medium',
    max_tokens: req.maxTokens ?? 16000,
  };
  if (req.tools?.length) {
    body.tools = req.tools;
    body.parallel_tool_calls = req.parallelToolCalls ?? false;
  }
  if (req.schema) body.response_format = { type: 'json_schema', json_schema: { name: req.schema.name, schema: req.schema.schema } };
  const json = await withRetry(`chat ${req.model}`, () => {
    options.signal?.throwIfAborted();
    return metaFetch('/chat/completions', body, 600_000, options.signal);
  });
  const choice = json.choices?.[0];
  const usage: MetaUsage = {
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
  return {
    message: { content: choice?.message?.content ?? null, tool_calls: choice?.message?.tool_calls ?? undefined },
    finishReason: choice?.finish_reason ?? 'unknown',
    usage,
    costUsd: tokenCostUsd(req.model, usage),
  };
}

export interface ChatJsonRequest {
  model: string;
  system: string;
  content: ChatContent[];
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

/** Chat completion constrained to a JSON schema. Returns the parsed object and token usage. */
export async function chatJson<T>(req: ChatJsonRequest): Promise<{ data: T; usage: MetaUsage; costUsd: number }> {
  const body = {
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.content },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: req.schemaName, schema: req.schema },
    },
    reasoning_effort: req.reasoningEffort ?? 'medium',
    max_tokens: req.maxTokens ?? 16000,
  };
  const json = await withRetry(`chat ${req.schemaName}`, () => metaFetch('/chat/completions', body, 300_000));
  const choice = json.choices?.[0];
  const content: string = choice?.message?.content ?? '';
  if (!content) {
    throw new Error(`Muse returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'})`);
  }
  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch {
    throw new Error(`Muse returned JSON that does not parse: ${content.slice(0, 200)}`);
  }
  const usage: MetaUsage = {
    inputTokens: json.usage?.prompt_tokens ?? 0,
    outputTokens: json.usage?.completion_tokens ?? 0,
    cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
  return { data, usage, costUsd: tokenCostUsd(req.model, usage) };
}

/**
 * Run SAM 3.1 on one image. `prompt` is either a short noun phrase or box/point prompt tokens.
 * Returns the raw special-token output text (parse it with @meta-sam/parser).
 */
export async function samSegment(imageUrl: string, prompt: string): Promise<string> {
  const body = {
    model: 'sam-3.1',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
    metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
  };
  const json = await withRetry('sam-3.1', () => metaFetch('/responses', body, 180_000));
  if (json.status && json.status !== 'completed') {
    throw new Error(`SAM 3.1 response status ${json.status}: ${JSON.stringify(json.error ?? json.incomplete_details ?? {})}`);
  }
  let text = typeof json.output_text === 'string' ? json.output_text : '';
  if (!text) {
    for (const item of json.output ?? []) {
      if (item.type !== 'message') continue;
      for (const part of item.content ?? []) {
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      }
    }
  }
  return text;
}

export interface ImageEditRequest {
  prompt: string;
  images: string[];
  /** "WxH" — sets the aspect ratio only. */
  size?: string;
}

/** One-shot Muse Image edit. Web, image-search and shell tools are disabled so private photos stay in the request. */
export async function museImageEdit(req: ImageEditRequest): Promise<Buffer> {
  const body: Record<string, unknown> = {
    model: 'muse-image-1.0',
    prompt: req.prompt,
    images: req.images.map((image_url) => ({ image_url })),
    n: 1,
    output_format: 'png',
    response_format: 'b64_json',
    tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
  };
  if (req.size) body.size = req.size;
  const json = await withRetry('muse-image edit', () => metaFetch('/images/edits', body, 300_000), { attempts: 3, baseMs: 3000 });
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('Muse Image returned no image');
  return Buffer.from(b64, 'base64');
}

/** One-shot Muse Image generation (used by the sample-photo script). */
export async function museImageGenerate(prompt: string, size?: string): Promise<Buffer> {
  const body: Record<string, unknown> = {
    model: 'muse-image-1.0',
    prompt,
    n: 1,
    output_format: 'png',
    response_format: 'b64_json',
    tool_enablement: { enable_image_search: false, enable_web_search: false, enable_shell: false },
  };
  if (size) body.size = size;
  const json = await withRetry('muse-image generate', () => metaFetch('/images/generations', body, 300_000), { attempts: 3, baseMs: 3000 });
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('Muse Image returned no image');
  return Buffer.from(b64, 'base64');
}
