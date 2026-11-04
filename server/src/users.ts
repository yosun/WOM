// People. A signed-in person is a row in users: the Clerk id, and the handle that names them in links
// (wom.quest/u/<handle>/<world>). Clerk proves who someone is. This file decides what WOM calls them.
import { randomBytes } from 'node:crypto';
import { asCaller, isUniqueViolation } from './db.ts';

export interface Identity {
  /** The Clerk user id, or 'local' for the person at this machine when sign-in is off. */
  id: string;
  handle: string | null;
  role: 'user' | 'admin';
}

/** The person at this machine when sign-in is off. Everything on the machine is theirs. */
export const LOCAL_USER: Identity = { id: 'local', handle: 'local', role: 'admin' };

// The same rule and the same list as the check on users.handle (db/migrations/001_init.sql). The database has the last word.
export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED = new Set((
  'admin administrator api app assets static files cdn www u w wom quest help support about terms privacy legal login logout ' +
  'signin sign-in signup sign-up register account accounts clerk clkmail billing credits pricing bench benchmark settings ' +
  'profile explore discover new create null undefined root system staff mod moderator security abuse report status blog docs mail email'
).split(' '));

export class HandleError extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

/** Tidy what someone typed into a handle: lower case, spaces and underscores to hyphens, one hyphen at a time. */
function tidy(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-');
}

/** The handle for what someone typed, or a HandleError saying what is wrong with it. */
export function checkHandle(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new HandleError('Choose a name.');
  const handle = tidy(raw);
  if (!HANDLE_RE.test(handle)) throw new HandleError('Use 3 to 30 letters, numbers or hyphens, starting and ending with a letter or a number.');
  if (RESERVED.has(handle)) throw new HandleError('That name is reserved. Choose another.');
  return handle;
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomId(n: number): string {
  return Array.from(randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Handles to try for a new person, best first: what they asked for or their Clerk username, then a random one. */
function* candidates(wanted: string | null | undefined): Generator<string> {
  if (wanted) {
    try {
      const handle = checkHandle(wanted);
      yield handle;
      for (let i = 0; i < 3; i++) yield `${handle.slice(0, 25)}-${randomId(3)}`;
    } catch {
      // not usable as a handle: fall through to a random one
    }
  }
  for (let i = 0; i < 6; i++) yield `user-${randomId(6)}`;
}

const TTL_MS = 30_000;
const known = new Map<string, { identity: Identity; until: number }>();

function remember(identity: Identity): Identity {
  known.set(identity.id, { identity, until: Date.now() + TTL_MS });
  return identity;
}

async function load(id: string): Promise<Identity | null> {
  const r = await asCaller({ id, role: 'user' }, (db) => db.query<{ handle: string | null; role: 'user' | 'admin' }>('select handle, role from users where id = $1', [id]));
  const row = r.rows[0];
  return row ? { id, handle: row.handle, role: row.role } : null;
}

/**
 * The WOM user for a signed-in person, made the first time they are seen. `usernameOf` looks up their Clerk username,
 * which becomes their handle when it is a valid, free one. Answers are kept for half a minute.
 */
export async function ensureUser(id: string, usernameOf?: () => Promise<string | null>): Promise<Identity> {
  const hit = known.get(id);
  if (hit && hit.until > Date.now()) return hit.identity;
  const existing = await load(id);
  if (existing) return remember(existing);
  // Asked only now, when there is a handle to choose: it costs a call to Clerk.
  const username = usernameOf ? await usernameOf().catch(() => null) : null;
  for (const handle of candidates(username)) {
    try {
      await asCaller({ id, role: 'user' }, (db) => db.query('insert into users (id, handle) values ($1, $2) on conflict (id) do nothing', [id, handle]));
    } catch (err) {
      if (isUniqueViolation(err)) continue; // that handle is taken
      throw err;
    }
    const made = await load(id);
    if (made) return remember(made);
  }
  throw new Error('Could not give this person a handle.');
}

/** Rename a person's handle. Links made with the old one keep working, because worlds are found by their id. */
export async function setHandle(user: Identity, raw: unknown): Promise<Identity> {
  const handle = checkHandle(raw);
  if (handle === user.handle) return user;
  try {
    const r = await asCaller({ id: user.id, role: 'user' }, (db) => db.query('update users set handle = $2, handle_changed_at = now() where id = $1', [user.id, handle]));
    if (r.rowCount !== 1) throw new Error('unknown user');
  } catch (err) {
    if (isUniqueViolation(err)) throw new HandleError('That name is taken. Choose another.', 409);
    throw err;
  }
  return remember({ ...user, handle });
}

/** Forget what was kept about a person, so the next request reads the database again. */
export function forgetUser(id?: string) {
  if (id) known.delete(id);
  else known.clear();
}
