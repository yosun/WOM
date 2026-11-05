// The same photo, prompts, tools and output contract for Meta and OpenAI comparisons.
import { chatCompletion as metaCompletion, chatJson as metaJson, type ChatJsonRequest, type ChatRequest, type ChatResult } from './meta.ts';
import { openAiCompletion } from './openai.ts';

export const modelProvider = (model: string): 'meta' | 'openai' => model.startsWith('gpt-') ? 'openai' : 'meta';

export function modelCompletion(req: ChatRequest): Promise<ChatResult> {
  return modelProvider(req.model) === 'openai' ? openAiCompletion(req) : metaCompletion(req);
}

export async function modelJson<T>(req: ChatJsonRequest) {
  if (modelProvider(req.model) === 'meta') return metaJson<T>(req);
  const r = await openAiCompletion({ model: req.model, messages: [
    { role: 'system', content: req.system }, { role: 'user', content: req.content },
  ], schema: { name: req.schemaName, schema: req.schema }, reasoningEffort: req.reasoningEffort, maxTokens: req.maxTokens });
  if (!r.message.content || r.finishReason === 'length') throw new Error(`OpenAI returned no complete ${req.schemaName} (finish_reason=${r.finishReason})`);
  return { data: JSON.parse(r.message.content) as T, usage: r.usage, costUsd: r.costUsd };
}
