// Paid calls: a budget that stops spending at a cap, a cache so a question asked twice is paid for once, and
// the ledger entry for each call that is paid for. This is how any model, agent or process that costs money
// takes part in a benchmark: it wraps its call in `spend.call`, and the framework does the rest.
//
// The cache is keyed by the content of the request, whatever the caller says that is: the same key is
// answered from disk instead of paying again. A run that repeats earlier questions therefore costs nothing.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Ledger } from './ledger.ts';
import { nowIso, writeFileAtomic } from './util.ts';

export class BudgetExceeded extends Error {}

export interface CallSpec<T = unknown> {
  /** What makes two calls the same question: anything JSON-serialisable (a request, the inputs). */
  key: unknown;
  /** What the call is, for the ledger and the cache file. */
  label: string;
  /** A rough upper bound on its cost, checked against the budget before a call that is not cached. */
  estimateUsd?: number;
  /** Cache folder, so unrelated kinds of call do not share one. Default 'calls'. */
  namespace?: string;
  /** How to read the cost out of a cached value written before costs were stored beside it. */
  costOf?: (value: T) => number;
  /** The ledger entry to write for a paid call, or false to book nothing (the caller books it). */
  ledger?: false | { context?: string; provider: string; model?: string };
}

export interface CallResult<T> {
  value: T;
  /** Answered from the cache, so nothing was paid now. */
  cached: boolean;
  /** What this call cost now: 0 when cached. */
  costUsd: number;
  /** What it cost when it was first paid, so a cached run can still say what a method costs. */
  listUsd: number;
  latencyMs: number;
  key: string;
}

export interface SpendOptions {
  maxUsd: number;
  /** Names this spend in the ledger (`<id>:<cache key>`): a run id, or a world's. */
  id: string;
  ledger?: Ledger;
  /** Where cached answers live. Without it nothing is cached. */
  cacheDir?: string;
}

/** The running spend of one run, or of one piece of work, with a hard cap on new (uncached) calls. */
export class Spend {
  usd = 0;
  calls = 0;
  cachedCalls = 0;
  readonly maxUsd: number;
  readonly id: string;
  private readonly ledger?: Ledger;
  private readonly cacheDir?: string;

  constructor(o: SpendOptions) {
    this.maxUsd = o.maxUsd;
    this.id = o.id;
    this.ledger = o.ledger;
    this.cacheDir = o.cacheDir;
  }

  /** Throws unless a call that may cost `estimateUsd` fits. A budget that is spent, or zero, stops every uncached call, estimate or not. */
  check(estimateUsd: number) {
    if (this.usd >= this.maxUsd || this.usd + estimateUsd > this.maxUsd) throw new BudgetExceeded(`budget of ${this.maxUsd.toFixed(2)} reached (${this.usd.toFixed(3)} spent)`);
  }

  /**
   * Run `fn` unless the same question was paid for before. `fn` returns the value and what it cost.
   * Throws BudgetExceeded rather than make a call the budget cannot cover.
   */
  async call<T>(spec: CallSpec<T>, fn: () => Promise<{ value: T; costUsd: number }>, opts: { fresh?: boolean } = {}): Promise<CallResult<T>> {
    const key = createHash('sha256').update(JSON.stringify(spec.key)).digest('hex');
    const file = this.cacheDir ? path.join(this.cacheDir, spec.namespace ?? 'calls', `${key}.json`) : null;
    if (file && !opts.fresh && existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, 'utf8')) as { result: T; latencyMs: number; costUsd?: number };
      this.cachedCalls++;
      return { value: hit.result, cached: true, costUsd: 0, listUsd: hit.costUsd ?? spec.costOf?.(hit.result) ?? 0, latencyMs: hit.latencyMs, key };
    }
    this.check(spec.estimateUsd ?? 0);
    const t0 = Date.now();
    const { value, costUsd } = await fn();
    const latencyMs = Date.now() - t0;
    this.usd += costUsd;
    this.calls++;
    if (file) await writeFileAtomic(file, JSON.stringify({ key, at: nowIso(), label: spec.label, latencyMs, costUsd, request: spec.key, result: value }, null, 1));
    if (spec.ledger !== false && this.ledger) {
      void this.ledger.append({
        at: nowIso(),
        context: spec.ledger?.context ?? 'bench',
        provider: spec.ledger?.provider ?? 'unknown',
        label: spec.label,
        usd: costUsd,
        model: spec.ledger?.model,
        ref: `${this.id}:${key}`,
      });
    }
    return { value, cached: false, costUsd, listUsd: costUsd, latencyMs, key };
  }
}
