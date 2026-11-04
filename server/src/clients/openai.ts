// Minimal OpenAI client for the standardized WOM patrol judge.
// GPT-6.1 Terra accepts image input and structured JSON output through Chat Completions.
import { HttpError, withRetry } from '../util.ts';
import type { ChatContent, ChatMessage } from './meta.ts';

export interface OpenAiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

const TOKEN_PRICES = { input: 1, cached: 0.05, output: 5 };

export function openAiConfigured() {
  return Boolean(process.env.OPENAI_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
}

function openAiKey(): string {
  const key = process.env.OPENAI_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error('OPENAI_KEY is not set. Add it to .env.local or the environment.');
  return key;
}

function tokenCostUsd(usage: OpenAiUsage) {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (uncached * TOKEN_PRICES.input + usage.cachedTokens * TOKEN_PRICES.cached + usage.outputTokens * TOKEN_PRICES.output) / 1e6;
}

export interface OpenAiJsonRequest {
  model: string;
  system: string;
  content: ChatContent[];
  schemaName: string;
  schema: Record<string, unknown>;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
}

export async function openAiChatJson<T>(req: OpenAiJsonRequest): Promise<{ data: T; usage: OpenAiUsage; costUsd: number }> {
  const body = {
    model: req.model,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.content },
    ],
    response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
    reasoning_effort: req.reasoningEffort ?? 'low',
    max_completion_tokens: req.maxTokens ?? 1400,
  };
  const json = await withRetry(`OpenAI ${req.model}`, async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openAiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`OpenAI returned ${res.status}`, res.status, text);
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      throw new HttpError('OpenAI returned invalid JSON', 502, text.slice(0, 500));
    }
  });
  const choice = json.choices?.[0];
  const content = typeof choice?.message?.content === 'string'
    ? choice.message.content
    : Array.isArray(choice?.message?.content)
      ? choice.message.content.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('')
      : '';
  if (!content) throw new Error(`OpenAI returned no content (finish_reason=${choice?.finish_reason ?? 'unknown'})`);
  let data: T;
  try {
    data = JSON.parse(content) as T;
  } catch {
    throw new Error(`OpenAI returned JSON that does not parse: ${content.slice(0, 240)}`);
  }
  const usage: OpenAiUsage = {
    inputTokens: Number(json.usage?.prompt_tokens ?? 0),
    outputTokens: Number(json.usage?.completion_tokens ?? 0),
    cachedTokens: Number(json.usage?.prompt_tokens_details?.cached_tokens ?? 0),
  };
  return { data, usage, costUsd: tokenCostUsd(usage) };
}
