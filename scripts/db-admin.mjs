// Make someone an administrator (or take it away). Administrators build worlds for free, see every world, and can use the
// benchmark, observation and model-spend tools.
//
//   node scripts/db-admin.mjs <handle>                  on the database in .env (the dev branch)
//   node scripts/db-admin.mjs --env .env.main <handle>  on production
//   node scripts/db-admin.mjs --revoke <handle>
//
// The person must have signed in once, so that they have a row. Uses DATABASE_URL_ADMIN from the env file; prints no secrets.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return undefined; args.splice(i, 1); return true; };
const revoke = flag('--revoke');
let envFile = '.env';
const e = args.indexOf('--env');
if (e >= 0) { envFile = args[e + 1]; args.splice(e, 2); }
const handle = args[0];
if (!handle) { console.error('usage: node scripts/db-admin.mjs [--env .env.main] [--revoke] <handle>'); process.exit(1); }

const file = path.resolve(import.meta.dirname, '..', envFile);
if (!existsSync(file)) { console.error(`${envFile} not found`); process.exit(1); }
const url = readFileSync(file, 'utf8').match(/^DATABASE_URL_ADMIN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!url) { console.error(`DATABASE_URL_ADMIN is missing from ${envFile}`); process.exit(1); }

const parsed = new URL(url);
parsed.searchParams.delete('sslmode');   // pg reads it as verify-full and warns; the options below say the same thing plainly
const client = new Client({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  const r = await client.query('update users set role = $2 where handle = $1 returning id, handle, role', [handle.toLowerCase(), revoke ? 'user' : 'admin']);
  if (r.rowCount !== 1) {
    console.error(`No one has the handle "${handle}". They need to sign in once first.`);
    const some = await client.query('select handle from users order by created_at desc limit 10');
    if (some.rowCount) console.error(`Handles so far: ${some.rows.map((x) => x.handle).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`${r.rows[0].handle} is now ${r.rows[0].role} (${envFile}). The server picks it up within 30 seconds.`);
  }
} finally {
  await client.end();
}
