// Model calls for the benchmark and the pipeline's placement step: the Muse chat API behind the metrics
// package's budget and cache (@wom/metrics `Spend`). The same request (model, messages, images, tools,
// schema, effort) is answered from disk instead of paying again. Images are keyed by their SHA-256, so cache
// files stay small and re-renders that produce identical pixels still hit.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { BudgetExceeded, Spend as BaseSpend } from '@wom/metrics';
import type { ChatRequest, ChatResult } from '../clients/meta.ts';
import { modelCompletion, modelProvider } from '../clients/llm.ts';
import { DATA_DIR } from '../config.ts';
import { ledger } from '../ledger.ts';

export const BENCH_DIR = path.join(DATA_DIR, 'bench');
export const CACHE_DIR = path.join(BENCH_DIR, 'cache');

export { BudgetExceeded };

/** A budget for model calls that books to the app's ledger and caches under data/bench/cache. */
export class Spend extends BaseSpend {
  constructor(maxUsd: number, runId: string) {
    super({ maxUsd, id: runId, ledger, cacheDir: CACHE_DIR });
  }
}

function hashData(s: string) {
  return createHash('sha256').update(s).digest('hex');
}

/** Replace data URLs by their hash so the key (and the cache file) does not carry image bytes. */
function normalize(req: ChatRequest): unknown {
  return JSON.parse(JSON.stringify(req), (_k, v) => (typeof v === 'string' && v.startsWith('data:') ? `sha256:${hashData(v)}` : v));
}

export interface CachedResult extends ChatResult {
  cached: boolean;
  key: string;
  latencyMs: number;
}

/** Rough upper bound for one call, used only for the budget check. */
function estimateUsd(req: ChatRequest) {
  const images = JSON.stringify(req.messages).split('data:image').length - 1;
  const textChars = JSON.stringify(normalize(req)).length;
  const inTok = textChars / 3.5 + images * 1800;
  const outTok = req.maxTokens ?? 16000;
  const [pin, pout] = req.model === 'gpt-6.1-sol' ? [2, 10] : req.model.startsWith('muse-wonder') ? [4, 20] : [1.25, 4.25];
  return (inTok * pin + outTok * pout) / 1e6;
}

/** `ledger: false` when the caller records the cost itself (the pipeline does, per world). */
export async function cachedChat(req: ChatRequest, ctx: { spend: BaseSpend; fresh: boolean; label: string; ledger?: boolean }): Promise<CachedResult> {
  const r = await ctx.spend.call<ChatResult>(
    {
      key: normalize(req),
      label: ctx.label,
      estimateUsd: estimateUsd(req),
      namespace: 'llm',
      costOf: (v) => v.costUsd,
      ledger: ctx.ledger === false ? false : { context: 'bench', provider: modelProvider(req.model), model: req.model },
    },
    async () => {
      const value = await modelCompletion(req);
      return { value, costUsd: value.costUsd };
    },
    { fresh: ctx.fresh },
  );
  return { ...r.value, cached: r.cached, key: r.key, latencyMs: r.latencyMs };
}
