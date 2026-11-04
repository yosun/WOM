// Give the database roles their passwords and write the connection strings to .env.
//
//   node scripts/db-roles.mjs
//
// Needs DATABASE_URL_ADMIN in .env (the owner, direct connection). Creates passwords for wom_app and wom_system,
// then appends DATABASE_URL (wom_app, pooled) and DATABASE_URL_SYSTEM (wom_system, pooled) to .env. Existing values
// are kept: delete the line to rotate. Nothing secret is printed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ENV = path.resolve(import.meta.dirname, '..', '.env');
const text = existsSync(ENV) ? readFileSync(ENV, 'utf8') : '';
const read = (name) => text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '');

const admin = read('DATABASE_URL_ADMIN');
if (!admin) {
  console.error('DATABASE_URL_ADMIN is missing from .env');
  process.exit(1);
}

function psql(sql) {
  const u = new URL(admin);
  const env = { ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.slice(1), PGSSLMODE: 'require' };
  const r = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', '-'], { input: sql, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.trim().split('\n').pop());
}

const wanted = [
  ['DATABASE_URL', 'wom_app'],
  ['DATABASE_URL_SYSTEM', 'wom_system'],
];
const lines = [];
for (const [name, role] of wanted) {
  if (read(name)) {
    console.log(`${name}: already set, left alone`);
    continue;
  }
  const password = randomBytes(24).toString('base64url');
  psql(`alter role ${role} login password '${password}';`);
  const u = new URL(admin);
  u.username = role;
  u.password = password;
  u.hostname = u.hostname.includes('-pooler') ? u.hostname : u.hostname.replace(/^([^.]+)/, '$1-pooler');
  lines.push(`${name}=${u.toString()}`);
  console.log(`${name}: ${role} can now log in (pooled)`);
}
if (lines.length) appendFileSync(ENV, `${text.endsWith('\n') || !text ? '' : '\n'}${lines.join('\n')}\n`);
