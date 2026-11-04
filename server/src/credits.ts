// Credits: what a person spends to build a world. The balance and every change to it live in Neon (db/migrations/001_init.sql):
// users.credits, the credit_ledger, and the functions that change them. The API's database role can only spend its own
// credits (wom.credit_debit) and redeem a promo code (wom.redeem_promo). Granting credits is for the system role.
import { createHash, randomInt } from 'node:crypto';
import { asCaller, asSystem, isCheckViolation, isUniqueViolation, type Caller } from './db.ts';

export class CreditsError extends Error {
  readonly status: 400 | 402 | 429;
  readonly balance?: number;
  constructor(message: string, status: 400 | 402 | 429, balance?: number) {
    super(message);
    this.status = status;
    this.balance = balance;
  }
}

/** How many credits a person has. */
export async function balanceOf(caller: Caller): Promise<number> {
  const r = await asCaller(caller, (db) => db.query<{ credits: string }>('select credits from users where id = $1', [caller.id]));
  return Number(r.rows[0]?.credits ?? 0);
}

/**
 * Take `amount` credits for building a world. Asking twice for the same world takes them once. Throws a CreditsError (402)
 * when the person has fewer, and takes nothing.
 */
export async function holdForWorld(caller: Caller, worldId: string, amount: number): Promise<number> {
  try {
    const r = await asCaller(caller, (db) => db.query<{ balance: string }>(
      'select wom.credit_debit($1::bigint, $2, $3) as balance',
      [amount, `world:${worldId}`, `hold:${worldId}:1`],
    ));
    return Number(r.rows[0].balance);
  } catch (err) {
    if (isCheckViolation(err)) throw new CreditsError(`A world costs ${amount} credits.`, 402, await balanceOf(caller).catch(() => 0));
    throw err;
  }
}

/** Give back credits taken for a world, never more than were taken. Asking twice gives back once. */
export async function releaseForWorld(caller: Caller, worldId: string, amount: number): Promise<number> {
  const r = await asCaller(caller, (db) => db.query<{ balance: string }>(
    'select wom.credit_release($1, $2::bigint, $3) as balance',
    [`world:${worldId}`, amount, `release:${worldId}:1`],
  ));
  return Number(r.rows[0].balance);
}

// ---------------------------------------------------------------- promo codes

// Codes are typed by people: no 0/O, 1/I/L. They are stored as a hash of the letters and digits alone, so dashes and case do not matter.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normalize = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashOf = (code: string) => createHash('sha256').update(code).digest('hex');
const pick = (n: number) => Array.from({ length: n }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

/**
 * Make a promo code worth `credits`, good for `maxRedemptions` people (once each). The code is returned here and nowhere
 * else: only its hash is kept. System role.
 */
export async function mintPromo(o: { credits: number; maxRedemptions?: number; expiresAt?: Date | null; note?: string }): Promise<string> {
  if (!Number.isInteger(o.credits) || o.credits <= 0) throw new CreditsError('credits must be a positive whole number.', 400);
  const max = o.maxRedemptions ?? 1;
  if (!Number.isInteger(max) || max <= 0) throw new CreditsError('maxRedemptions must be a positive whole number.', 400);
  const letters = `WOM${pick(4)}${pick(4)}`;
  await asSystem((db) => db.query(
    'insert into promo_codes (code_hash, credits, max_redemptions, expires_at, note) values ($1, $2, $3, $4, $5)',
    [hashOf(letters), o.credits, max, o.expiresAt ?? null, o.note ?? null],
  ));
  return `WOM-${letters.slice(3, 7)}-${letters.slice(7)}`;
}

// A guess costs a database call and teaches nothing, so each person gets a few an hour.
const attempts = new Map<string, number[]>();
const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 8;

/** Add a promo code's credits to a person's balance. Answers with the new balance. */
export async function redeemPromo(caller: Caller, raw: unknown): Promise<number> {
  const now = Date.now();
  const recent = (attempts.get(caller.id) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) throw new CreditsError('Too many tries. Wait a few minutes.', 429);
  attempts.set(caller.id, [...recent, now]);
  const code = typeof raw === 'string' ? normalize(raw) : '';
  if (code.length < 8 || code.length > 40) throw new CreditsError('That code is not valid.', 400);
  try {
    const r = await asCaller(caller, (db) => db.query<{ balance: string }>('select wom.redeem_promo($1) as balance', [code]));
    return Number(r.rows[0].balance);
  } catch (err) {
    if (isUniqueViolation(err)) throw new CreditsError('You have already used that code.', 400);
    if (err instanceof Error && /invalid or expired code/.test(err.message)) throw new CreditsError('That code is not valid, or it has expired or been used up.', 400);
    throw err;
  }
}
