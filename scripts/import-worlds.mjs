// Put worlds that exist as files under data/worlds into the database, as someone's worlds.
//
//   node scripts/import-worlds.mjs                                   every finished world, as the local development owner (.env)
//   node scripts/import-worlds.mjs --env .env.main --owner yosun     every finished world, as the person with that handle, on production
//   node scripts/import-worlds.mjs --owner yosun <world-id> ...      only these
//
// Worlds are shared by link, like any world. The files themselves are not moved: on a server, copy data/worlds/<id> to the same
// place under the server's data directory first. Safe to run again: it refreshes the stored manifest and never
// changes a world's owner, visibility or takedown. Uses DATABASE_URL_ADMIN from the env file and prints no secrets.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const envName = option('--env', '.env');
const ownerHandle = option('--owner', 'local');

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data', 'worlds');
const envFile = path.resolve(ROOT, envName);
if (!existsSync(envFile)) throw new Error(`${envName} not found`);
const adminUrl = readFileSync(envFile, 'utf8').match(/^DATABASE_URL_ADMIN=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '');
if (!adminUrl) throw new Error(`DATABASE_URL_ADMIN is missing from ${envName}`);
const url = new URL(adminUrl);
url.searchParams.delete('sslmode');   // pg reads it as verify-full and warns; the ssl option below says the same thing plainly

const manifestOf = (id) => JSON.parse(readFileSync(path.join(DATA, id, 'manifest.json'), 'utf8'));
const ids = args.length
  ? args
  : readdirSync(DATA).filter((id) => /^[a-z0-9]{6,32}$/.test(id) && existsSync(path.join(DATA, id, 'manifest.json'))
      && ['done', 'partial'].includes(manifestOf(id).status) && manifestOf(id).scene);

const client = new Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  let owner;
  if (ownerHandle === 'local') {
    await client.query(`insert into users (id, handle, role) values ('local', 'local', 'admin') on conflict (id) do update set handle = excluded.handle, role = 'admin'`);
    owner = { id: 'local', handle: 'local' };
  } else {
    const r = await client.query('select id, handle from users where handle = $1', [ownerHandle.toLowerCase()]);
    if (r.rowCount !== 1) throw new Error(`No one has the handle "${ownerHandle}". They need to sign in once first.`);
    owner = r.rows[0];
  }
  for (const id of ids) {
    if (!/^[a-z0-9]{6,32}$/.test(id)) throw new Error(`invalid world id: ${id}`);
    if (!existsSync(path.join(DATA, id, 'manifest.json'))) throw new Error(`no manifest for ${id} under data/worlds`);
    const manifest = manifestOf(id);
    const cost = manifest.costs.reduce((sum, item) => sum + Number(item.usd || 0), 0);
    const result = await client.query(
      `insert into worlds
         (id, owner_id, title, status, visibility, manifest, objects_count, has_world, cost_usd, scene_key, created_at, updated_at)
       values ($1, $2, $3, $4, 'link', $5::jsonb, $6, $7, $8, $9, $10, $11)
       on conflict (id) do update set
         title = excluded.title, status = excluded.status, manifest = excluded.manifest, objects_count = excluded.objects_count,
         has_world = excluded.has_world, cost_usd = excluded.cost_usd, scene_key = excluded.scene_key, updated_at = excluded.updated_at
       returning owner_id, visibility, (xmax = 0) as inserted`,
      [id, owner.id, manifest.title ?? 'Untitled memory', manifest.status, JSON.stringify(manifest), manifest.objects?.length ?? 0,
        Boolean(manifest.world?.splats?.length), cost, manifest.scene?.file ?? null, manifest.createdAt, manifest.updatedAt ?? manifest.createdAt],
    );
    const row = result.rows[0];
    console.log(`${row.inserted ? 'imported' : 'refreshed'} ${id}  /u/${owner.handle}/${id}  (${row.visibility === 'link' ? 'anyone with the link' : row.visibility}${row.owner_id === owner.id ? '' : `; owned by ${row.owner_id}, not changed`})  ${manifest.title}`);
  }
} finally {
  await client.end();
}
