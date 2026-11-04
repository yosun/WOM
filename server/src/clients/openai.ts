// OpenAI JSON for the patrol judge, plus Responses for Sol planning and placement tools.
import { HttpError, withRetry } from '../util.ts';
import type { ChatContent, ChatMessage, ChatRequest, ChatResult, ToolCall } from './meta.ts';

export interface OpenAiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** USD per 1M tokens: https://developers.openai.com/api/docs/models/gpt-6.1-sol */
const TOKEN_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-6.1-terra': { input: 1, cached: 0.05, output: 5 },
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
};

export function openAiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_KEY?.trim());
}

function openAiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_KEY?.trim();
  if (!key) throw new Error('OPENAI_API_KEY is not set. Add it to the server environment (OPENAI_KEY is also accepted).');
  return key;
}

export function openAiTokenCostUsd(model: string, usage: OpenAiUsage) {
  const prices = TOKEN_PRICES[model];
  if (!prices) throw new Error(`No OpenAI token prices configured for ${model}`);
  const uncached = Math.max(0, usage.inputTokens - usage.cachedTokens);
  return (uncached * prices.input + usage.cachedTokens * prices.cached + usage.outputTokens * prices.output) / 1e6;
}

/** Replay the complete Responses output, including encrypted reasoning, between tool turns. */
function responseInput(messages: ChatMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    } else if (m.role === 'assistant') {
      if (m.responseItems?.length) input.push(...m.responseItems);
      else {
        if (m.content) input.push({ role: 'assistant', content: m.content });
        for (const tc of m.tool_calls ?? []) input.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    } else {
      const content = typeof m.content === 'string' ? m.content : m.content.map((p) => p.type === 'text'
        ? { type: 'input_text', text: p.text }
        : { type: 'input_image', image_url: p.image_url.url });
      input.push({ role: m.role === 'system' ? 'developer' : 'user', content });
    }
  }
  return input;
}

/** Tool calling on GPT-6.1 Sol requires Responses. No server-side conversation storage. */
export async function openAiCompletion(req: ChatRequest): Promise<ChatResult> {
  // Fail before making a paid request if accounting for this model is unknown.
  openAiTokenCostUsd(req.model, { inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  const body: Record<string, unknown> = {
    model: req.model, input: responseInput(req.messages), store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: req.reasoningEffort === 'minimal' ? 'low' : req.reasoningEffort ?? 'medium' },
    max_output_tokens: req.maxTokens ?? 16000,
  };
  if (req.tools?.length) {
    // The existing tools have optional fields; keep their schemas and semantics unchanged.
    body.tools = req.tools.map((t) => ({ type: 'function', ...t.function, strict: false }));
    body.parallel_tool_calls = req.parallelToolCalls ?? false;
  }
  if (req.schema) body.text = { format: { type: 'json_schema', name: req.schema.name, schema: req.schema.schema, strict: true } };
  const json = await withRetry(`OpenAI ${req.model}`, async () => {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${openAiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`OpenAI returned ${res.status}`, res.status, text);
    try { return JSON.parse(text) as Record<string, any>; }
    catch { throw new HttpError('OpenAI returned invalid JSON', 502, text.slice(0, 500)); }
  });
  if (json.error) throw new Error(`OpenAI response failed: ${json.error.message ?? json.error.code ?? 'unknown error'}`);
  const output: Record<string, any>[] = Array.isArray(json.output) ? json.output : [];
  const content = output.filter((o) => o.type === 'message').flatMap((o) => o.content ?? [])
    .filter((p) => p.type === 'output_text').map((p) => p.text).join('');
  const calls: ToolCall[] = output.filter((o) => o.type === 'function_call').map((o) => ({
    id: o.call_id, type: 'function', function: { name: o.name, arguments: o.arguments },
  }));
  const usage: OpenAiUsage = {
    inputTokens: Number(json.usage?.input_tokens ?? 0), outputTokens: Number(json.usage?.output_tokens ?? 0),
    cachedTokens: Number(json.usage?.input_tokens_details?.cached_tokens ?? 0),
  };
  return {
    message: { content: content || null, ...(calls.length ? { tool_calls: calls } : {}), responseItems: output },
    finishReason: json.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop',
    usage, costUsd: openAiTokenCostUsd(req.model, usage),
  };
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
  return { data, usage, costUsd: openAiTokenCostUsd(req.model, usage) };
}
