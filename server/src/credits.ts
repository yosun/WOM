// Credits: what a person spends to build a world. The balance and every change to it live in Neon (db/migrations/001_init.sql):
// users.credits, the credit_ledger, and the functions that change them. The API's database role can only spend its own
// credits (wom.credit_debit), give back what a world holds (wom.credit_release) and redeem a promo code (wom.redeem_promo).
// Granting credits is for the system role.
import { createHash, randomInt } from 'node:crypto';
import { asCaller, asSystem, isCheckViolation, isUniqueViolation, type Caller, type Db } from './db.ts';

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

// What a world holds is worked out from the ledger, never remembered: credits taken for it (kind 'hold') minus credits given
// back (kind 'release'), under ref `world:<id>`. A world is held in rounds. Round 1 is the hold made when it is created. If the
// build fails the round is released, and a retry then holds the price again as round 2, and so on. Hold n and release n
// share a number, which is what makes each of them idempotent on its own.
interface Held {
  /** Credits taken for the world and not yet given back. */
  held: number;
  /** How many times the world has been held, and so the number of the round in progress or just ended. */
  rounds: number;
  /** How many of those rounds have been given back. */
  released: number;
}

async function heldFor(db: Db, userId: string, worldId: string): Promise<Held> {
  const r = await db.query<{ held: string; rounds: string; released: string }>(
    `select coalesce(-sum(delta) filter (where kind = 'hold'), 0) - coalesce(sum(delta) filter (where kind = 'release'), 0) as held,
            count(*) filter (where kind = 'hold') as rounds,
            count(*) filter (where kind = 'release') as released
       from credit_ledger where user_id = $1 and ref = $2`,
    [userId, `world:${worldId}`],
  );
  return { held: Number(r.rows[0].held), rounds: Number(r.rows[0].rounds), released: Number(r.rows[0].released) };
}

/**
 * Hold the price of a world again before a retry, when its credits were given back because its build failed. Does nothing for a
 * world that still holds its credits (a retry after a partial build is free) and for one that never held any (an administrator's,
 * or one made before credits existed). Throws a CreditsError (402) when the person has fewer credits, and takes nothing.
 */
export async function holdForRetry(caller: Caller, worldId: string, amount: number): Promise<void> {
  try {
    await asCaller(caller, async (db) => {
      const s = await heldFor(db, caller.id, worldId);
      if (s.held > 0 || s.released === 0) return;
      await db.query('select wom.credit_debit($1::bigint, $2, $3)', [amount, `world:${worldId}`, `hold:${worldId}:${s.rounds + 1}`]);
    });
  } catch (err) {
    if (isCheckViolation(err)) throw new CreditsError(`A world costs ${amount} credits.`, 402, await balanceOf(caller).catch(() => 0));
    throw err;
  }
}

/**
 * Give back everything a world holds. Safe to call twice, from two places, or after a restart: a world that holds nothing (an
 * administrator's, or already given back) gives back nothing. Answers how many credits came back. `caller` is the world's owner,
 * because the credits are theirs.
 */
export async function refundWorld(caller: Caller, worldId: string): Promise<number> {
  try {
    return await asCaller(caller, async (db) => {
      const s = await heldFor(db, caller.id, worldId);
      if (s.held <= 0) return 0;
      await db.query('select wom.credit_release($1, $2::bigint, $3)', [`world:${worldId}`, s.held, `release:${worldId}:${s.rounds}`]);
      return s.held;
    });
  } catch (err) {
    // Two refunds at once: the database lets one through and tells the other there is nothing left to give back.
    if (err instanceof Error && /cannot release more than was charged/.test(err.message)) return 0;
    throw err;
  }
}

/**
 * Give back the credits of every world that ended `failed` and still holds them. A failed build gives its credits back as it
 * fails, so this only finds what that missed: a restart or a database error in between, and builds that failed before credits
 * were given back at all. Run it before the server takes requests, so that it cannot meet a retry halfway. Safe to run any
 * number of times. System role (it reads every world), though each refund is made as the world's owner.
 */
export async function refundFailedWorlds(): Promise<{ worlds: number; credits: number }> {
  const found = await asSystem((db) => db.query<{ id: string; owner_id: string }>(
    `select w.id, w.owner_id from worlds w
      where w.status = 'failed'
        and (select coalesce(-sum(l.delta) filter (where l.kind = 'hold'), 0) - coalesce(sum(l.delta) filter (where l.kind = 'release'), 0)
               from credit_ledger l where l.user_id = w.owner_id and l.ref = 'world:' || w.id) > 0`,
  ));
  let worlds = 0;
  let credits = 0;
  for (const row of found.rows) {
    const back = await refundWorld({ id: row.owner_id, role: 'user' }, row.id);
    if (back > 0) {
      worlds += 1;
      credits += back;
    }
  }
  return { worlds, credits };
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
