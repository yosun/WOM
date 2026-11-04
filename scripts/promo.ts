// Make promo codes for judges and testers. A code adds credits to one person's balance, once.
//
//   npm run promo -- --credits 1500 --count 25 --days 45 --note judges                  the database in .env (development)
//   node --env-file=.env.main scripts/promo.ts --credits 1500 --count 25 --days 45 --note judges      production
//
//   --credits  what each code is worth (a world costs 500 by default)
//   --count    how many codes to make (default 1)
//   --uses     how many people can use each code (default 1)
//   --days     the codes stop working after this many days (default: never)
//   --note     a label kept with the codes, such as "judges"
//
// The codes are printed here and nowhere else: only their hashes are stored. To turn one off, set promo_codes.disabled.
import { parseArgs } from 'node:util';
import { mintPromo } from '../server/src/credits.ts';
import { closeDb } from '../server/src/db.ts';

const { values } = parseArgs({
  options: {
    credits: { type: 'string' },
    count: { type: 'string', default: '1' },
    uses: { type: 'string', default: '1' },
    days: { type: 'string' },
    note: { type: 'string' },
  },
});
const credits = Number(values.credits);
const count = Number(values.count);
const uses = Number(values.uses);
const days = values.days === undefined ? null : Number(values.days);
if (!Number.isInteger(credits) || credits <= 0 || !Number.isInteger(count) || count <= 0 || count > 500 || !Number.isInteger(uses) || uses <= 0 || (days !== null && !(days > 0))) {
  console.error('usage: promo --credits <n> [--count <n>] [--uses <n>] [--days <n>] [--note <text>]');
  process.exit(1);
}
const url = process.env.DATABASE_URL_SYSTEM;
if (!url) {
  console.error('DATABASE_URL_SYSTEM is not set. Run with --env-file=.env or --env-file=.env.main.');
  process.exit(1);
}
console.error(`Making ${count} code${count === 1 ? '' : 's'} worth ${credits} credits on ${new URL(url).hostname.split('.')[0]}${days === null ? '' : `, good for ${days} days`}.`);

const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);
try {
  for (let i = 0; i < count; i++) console.log(await mintPromo({ credits, maxRedemptions: uses, expiresAt, note: values.note }));
} finally {
  await closeDb();
}
