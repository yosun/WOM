// Shared by the Stripe scripts: run the Stripe CLI you are logged in with, and refuse to touch anything that is not test mode.
import { spawnSync } from 'node:child_process';

/** Run `stripe <args>` and parse its JSON. Throws on a failure and on any live-mode object. */
export function stripe(args) {
  const r = spawnSync('stripe', args, { encoding: 'utf8', maxBuffer: 50e6 });
  if (r.status !== 0) throw new Error(`stripe ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  const out = JSON.parse(r.stdout);
  for (const item of out.object === 'list' ? out.data : [out]) {
    if (item.livemode === true) throw new Error('Stripe answered in live mode. These scripts only work in test mode.');
  }
  return out;
}

/** { a: 1, 'b[c]': 2 } becomes -d a=1 -d b[c]=2, how the CLI takes request parameters. */
export const params = (o) => Object.entries(o).flatMap(([k, v]) => ['-d', `${k}=${v}`]);

/** Stops unless Stripe says, in so many words, that this login is test mode (the balance carries livemode; the account does not). */
export function requireTestMode() {
  if (stripe(['get', '/v1/balance']).livemode !== false) throw new Error('Could not confirm that the Stripe CLI is in test mode. Nothing was changed.');
  const account = stripe(['get', '/v1/account']);
  console.log(`Stripe account ${account.id}${account.business_profile?.name ? ` (${account.business_profile.name})` : ''}, test mode`);
  return account;
}
