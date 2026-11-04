// One append-only record of every paid call, across worlds and benchmarks: data/ledger.jsonl.
// World manifests keep their own cost lists; the ledger is the single place to audit total spend.
// The record itself is the metrics package's (@wom/metrics); this binds it to the app's data folder.
import path from 'node:path';
import { Ledger, type LedgerEntry } from '@wom/metrics';
import { DATA_DIR } from './config.ts';

export type { LedgerEntry };

export const LEDGER_FILE = path.join(DATA_DIR, 'ledger.jsonl');
export const ledger = new Ledger(LEDGER_FILE);

/** Append entries in order; failures are logged, never thrown (a ledger hiccup must not fail a build). */
export const appendLedger = (...entries: LedgerEntry[]) => ledger.append(...entries);

export const ledgerExists = () => ledger.exists();
