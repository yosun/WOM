// One append-only record of every paid call, across worlds and benchmarks: a JSON-lines file.
// Runs and worlds keep their own cost lists; the ledger is the single place to audit what was spent.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { LedgerEntry } from '../core/types.ts';

export class Ledger {
  readonly file: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  /** Append entries in order. A failure is logged, never thrown: a ledger hiccup must not fail a build. */
  append(...entries: LedgerEntry[]): Promise<void> {
    const lines = entries.filter((e) => e.usd > 0).map((e) => JSON.stringify(e)).join('\n');
    if (!lines) return this.chain;
    this.chain = this.chain
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, `${lines}\n`);
      })
      .catch((err) => console.error('[ledger] append failed:', err));
    return this.chain;
  }

  exists() {
    return existsSync(this.file);
  }

  /** Every entry. A torn line (a crash in the middle of an append) must not hide the rest. */
  async read(): Promise<LedgerEntry[]> {
    if (!existsSync(this.file)) return [];
    const out: LedgerEntry[] = [];
    for (const line of (await readFile(this.file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LedgerEntry;
        if (typeof e.usd === 'number' && Number.isFinite(e.usd) && typeof e.at === 'string' && typeof e.label === 'string') out.push(e);
      } catch {
        // skip it
      }
    }
    return out;
  }
}
