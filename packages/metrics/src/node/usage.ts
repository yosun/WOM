// Spend analytics: what the ledger says was paid for, grouped for the dashboard. The ledger holds every
// paid call from world builds and benchmarks, so these totals are the audit trail; calls answered from the
// cache cost nothing and never appear in it.
//
// How a call's label maps to what it bought, which world it was about and which subject's method it priced
// is the application's knowledge, so it comes in as hooks. Without them calls are grouped by their context.
import type { CostPerCase, LedgerEntry, SpendRow, SpendSummary } from '../core/types.ts';

export interface UsageHooks {
  /** What a paid call bought. */
  classify?(e: LedgerEntry): { id: string; label: string };
  /** The subject's method a call belongs to and the case it was for, to price a method per case. */
  perCase?(e: LedgerEntry): { subject: string; method: string; case: string; run: string; label?: string; about?: string } | null;
  /** The world a call was about. */
  worldOf?(e: LedgerEntry): string | undefined;
  /** Titles of worlds, by id. */
  worldTitles?: Map<string, string>;
  /** Names for the ids in `context` and `provider`. */
  contextLabels?: Record<string, string>;
  providerLabels?: Record<string, string>;
}

/** The calendar day on this machine (the one that runs the server, which is normally the browser's too). */
function localDay(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

class Tally {
  private rows = new Map<string, SpendRow>();
  add(id: string, label: string, usd: number) {
    const row = this.rows.get(id) ?? { id, label, usd: 0, calls: 0 };
    row.usd += usd;
    row.calls++;
    this.rows.set(id, row);
  }
  list(order: 'usd' | 'id' = 'usd') {
    const rows = [...this.rows.values()];
    return order === 'usd' ? rows.sort((a, b) => b.usd - a.usd) : rows.sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function summarizeLedger(entries: LedgerEntry[], hooks: UsageHooks = {}): SpendSummary {
  const context = new Tally(), provider = new Tally(), kind = new Tally(), day = new Tally(), world = new Tally();
  const perCase = new Map<string, { subject: string; method: string; label?: string; about?: string; calls: number; usd: number; cases: Set<string> }>();
  let totalUsd = 0, estimatedUsd = 0;
  let firstAt: string | undefined, lastAt: string | undefined;

  for (const e of entries) {
    totalUsd += e.usd;
    if (e.estimated) estimatedUsd += e.usd;
    if (!firstAt || e.at < firstAt) firstAt = e.at;
    if (!lastAt || e.at > lastAt) lastAt = e.at;
    context.add(e.context, hooks.contextLabels?.[e.context] ?? e.context, e.usd);
    provider.add(e.provider, hooks.providerLabels?.[e.provider] ?? e.provider, e.usd);
    const k = hooks.classify?.(e) ?? { id: e.context, label: hooks.contextLabels?.[e.context] ?? e.context };
    kind.add(k.id, k.label, e.usd);
    day.add(localDay(e.at), localDay(e.at), e.usd);
    const worldId = hooks.worldOf?.(e) ?? e.worldId;
    if (worldId) world.add(worldId, hooks.worldTitles?.get(worldId) ?? worldId, e.usd);

    const c = hooks.perCase?.(e);
    if (c) {
      const key = `${c.subject} ${c.method}`;
      const acc = perCase.get(key) ?? { subject: c.subject, method: c.method, label: c.label, about: c.about, calls: 0, usd: 0, cases: new Set<string>() };
      acc.calls++;
      acc.usd += e.usd;
      // A case paid for in two runs counts twice: the average is the price of one fresh run of a case.
      acc.cases.add(`${c.run}|${c.case}`);
      perCase.set(key, acc);
    }
  }

  const costs: CostPerCase[] = [...perCase.values()]
    .map((p) => ({ subject: p.subject, method: p.method, ...(p.label ? { label: p.label } : {}), ...(p.about ? { about: p.about } : {}), calls: p.calls, usd: p.usd, cases: p.cases.size, usdPerCase: p.cases.size ? p.usd / p.cases.size : 0 }))
    .sort((a, b) => a.method.localeCompare(b.method) || a.subject.localeCompare(b.subject));

  return {
    totalUsd,
    calls: entries.length,
    estimatedUsd,
    firstAt,
    lastAt,
    byContext: context.list(),
    byProvider: provider.list(),
    byKind: kind.list(),
    byDay: day.list('id'),
    byWorld: world.list(),
    perCase: costs,
  };
}
