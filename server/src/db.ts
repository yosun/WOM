// Postgres on Neon (schema in db/migrations). The API connects as wom_app, so row-level security decides what each caller
// can read and write. Boot work and admin jobs connect as wom_system. Without DATABASE_URL the server keeps everything on
// disk (WOM_STORE, config.ts).
import { Pool, type PoolClient, type PoolConfig } from 'pg';

/** Who is asking. Row-level security reads this from the transaction (wom.uid(), wom.is_admin()). */
export interface Caller {
  id: string;
  role: 'user' | 'admin';
}

/** What a query function receives: a connection inside the transaction. */
export type Db = Pick<PoolClient, 'query'>;

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];
const pools = new Map<string, Pool>();

function poolConfig(url: string): PoolConfig {
  const u = new URL(url);
  const mode = u.searchParams.get('sslmode');
  // pg reads sslmode=require as verify-full and warns that this will change. Ask for what is meant: TLS with a checked certificate.
  u.searchParams.delete('sslmode');
  const plain = LOCAL_HOSTS.includes(u.hostname) || mode === 'disable';
  return {
    connectionString: u.toString(),
    ssl: plain ? undefined : { rejectUnauthorized: true },
    max: Number(process.env.WOM_DB_POOL ?? 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  };
}

function poolFor(name: 'DATABASE_URL' | 'DATABASE_URL_SYSTEM'): Pool {
  let pool = pools.get(name);
  if (!pool) {
    const url = process.env[name]?.trim();
    if (!url) throw new Error(`${name} is not set. Add it to .env.`);
    pool = new Pool(poolConfig(url));
    pool.on('error', (err) => console.error(`[db] idle connection (${name}) failed: ${err.message}`));
    pools.set(name, pool);
  }
  return pool;
}

/** Whether the API role's connection string is set. */
export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

async function inTransaction<T>(pool: Pool, caller: Caller | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // The caller is set for this transaction only (the `true`), so a pooled connection never carries it to the next request.
    // One round trip: begin and the settings together.
    await client.query(caller
      ? `begin; select set_config('app.user_id', ${client.escapeLiteral(caller.id)}, true), set_config('app.role', ${client.escapeLiteral(caller.role)}, true)`
      : 'begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Run `fn` in one transaction as `caller`, with row-level security applied to that person. */
export function asCaller<T>(caller: Caller, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(poolFor('DATABASE_URL'), caller, fn);
}

/** Run `fn` in one transaction as the system role: boot work, lookups the API makes for no one in particular, the webhook. */
export function asSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return inTransaction(poolFor('DATABASE_URL_SYSTEM'), null, fn);
}

/** Postgres error code 23505: a unique constraint (a taken handle, a repeated id) refused the row. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Postgres error code 23514: a check constraint refused the row (a balance that would go below zero). */
export function isCheckViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23514';
}

export async function closeDb(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((p) => p.end()));
}
