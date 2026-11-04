// Shared by the Stripe scripts. Test mode is the default; live mode must be requested explicitly.
import { spawnSync } from 'node:child_process';

/** Run `stripe <args>` and reject any object returned from the wrong mode. */
export function stripe(args, { live = false } = {}) {
  const r = spawnSync('stripe', live ? [...args, '--live', '--confirm'] : args, { encoding: 'utf8', maxBuffer: 50e6 });
  const redact = (s) => String(s).replace(/\b(?:sk|rk)_(?:live|test)_[\w.]+/g, '[redacted]');
  if (r.status !== 0) throw new Error(`stripe ${args.slice(0, 2).join(' ')} failed: ${redact(r.stderr || r.stdout).trim().slice(0, 500)}`);
  const out = JSON.parse(r.stdout);
  // Some Stripe CLI versions exit successfully even when the API returned an error object.
  if (out.error) throw new Error(`stripe ${args.slice(0, 2).join(' ')} failed: ${redact(out.error.message || out.error.type || 'API error').slice(0, 500)}`);
  for (const item of out.object === 'list' ? out.data : [out]) {
    if (typeof item.livemode === 'boolean' && item.livemode !== live) {
      throw new Error(`Stripe answered in ${item.livemode ? 'live' : 'test'} mode, but ${live ? 'live' : 'test'} mode was requested.`);
    }
  }
  return out;
}

/** { a: 1, 'b[c]': 2 } becomes -d a=1 -d b[c]=2, how the CLI takes request parameters. */
export const params = (o) => Object.entries(o).flatMap(([k, v]) => ['-d', `${k}=${v}`]);

/** The balance confirms the requested mode; the account confirms where the changes will go. */
export function requireMode(live = false) {
  const options = { live };
  if (stripe(['get', '/v1/balance'], options).livemode !== live) {
    throw new Error(`Could not confirm that the Stripe CLI is in ${live ? 'live' : 'test'} mode. Nothing was changed.`);
  }
  const account = stripe(['get', '/v1/account'], options);
  if (live && !account.charges_enabled) throw new Error('The Stripe account cannot accept live charges. Nothing was changed.');
  console.log(`Stripe account ${account.id}${account.business_profile?.name ? ` (${account.business_profile.name})` : ''}, ${live ? 'live' : 'test'} mode`);
  return account;
}

export const requireTestMode = () => requireMode(false);
