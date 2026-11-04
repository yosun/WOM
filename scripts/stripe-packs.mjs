// Make the credit packs in Stripe, and write what the server needs to sell them.
//
//   node scripts/stripe-packs.mjs          test mode -> server/src/packs.json
//   node scripts/stripe-packs.mjs --live   live mode -> server/src/packs.live.json
//
// Uses the Stripe CLI you are logged in with, and refuses responses from the wrong mode. It needs no key of its own.
// Safe to run again: a product, price or payment link that is already there (found by its metadata) is reused, so
// a changed pack in PACKS below is made fresh and the old one is left for you to archive in the dashboard.
//
// Each pack is a Payment Link. The server adds ?client_reference_id=<user> to it, and Stripe's webhook (server/src/stripe.ts)
// tells the server who paid for which link. The server holds no Stripe API key, only the webhook's signing secret.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { params, requireMode, stripe as callStripe } from './stripe-cli.mjs';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--live')) throw new Error('Usage: node scripts/stripe-packs.mjs [--live]');
const live = args.includes('--live');
const stripe = (args) => callStripe(args, { live });

// What each pack costs and gives. A world costs 500 credits (WORLD_CREDITS), so $10 builds two, and the bigger packs
// give 10%, 20% and 30% more credits per dollar. Change these numbers, run this again, and commit packs.json.
const PACKS = [
  { id: 'starter', name: 'Starter', usd: 10, credits: 1000 },
  { id: 'explorer', name: 'Explorer', usd: 25, credits: 2750 },
  { id: 'creator', name: 'Creator', usd: 50, credits: 6000 },
  { id: 'studio', name: 'Studio', usd: 100, credits: 13000 },
];
const ORIGIN = 'https://wom.quest';
const OUT = path.resolve(import.meta.dirname, live ? '../server/src/packs.live.json' : '../server/src/packs.json');

requireMode(live);

function completeList(args) {
  const result = stripe(args);
  if (result.has_more) throw new Error(`Too many Stripe results for ${args.slice(0, 2).join(' ')}; refusing to create duplicates.`);
  return result.data;
}
const products = completeList(['products', 'list', '--limit', '100']);
const links = completeList(['payment_links', 'list', '--limit', '100']);
const out = [];

for (const pack of PACKS) {
  const cents = pack.usd * 100;
  const label = `${pack.name} (${pack.credits.toLocaleString('en-US')} credits)`;

  let product = products.find((p) => p.active && p.metadata?.app === 'wom' && p.metadata?.pack === pack.id && p.metadata?.credits === String(pack.credits));
  if (!product) {
    product = stripe(['products', 'create', ...params({
      name: `WOM credits: ${pack.name}`,
      description: `${pack.credits.toLocaleString('en-US')} credits to build worlds from your memories on wom.quest.`,
      'metadata[app]': 'wom', 'metadata[pack]': pack.id, 'metadata[credits]': pack.credits,
    })]);
  }

  const prices = completeList(['prices', 'list', '--product', product.id, '--active=true', '--limit', '100']);
  let price = prices.find((p) => p.unit_amount === cents && p.currency === 'usd' && !p.recurring);
  if (!price) price = stripe(['prices', 'create', ...params({ product: product.id, unit_amount: cents, currency: 'usd' })]);

  let link = links.find((l) => l.active && l.metadata?.app === 'wom' && l.metadata?.pack === pack.id && l.metadata?.credits === String(pack.credits)
    && l.metadata?.cents === String(cents));
  if (!link) {
    link = stripe(['payment_links', 'create', ...params({
      'line_items[0][price]': price.id,
      'line_items[0][quantity]': 1,
      'after_completion[type]': 'redirect',
      'after_completion[redirect][url]': `${ORIGIN}/?credits=paid`,
      'custom_text[submit][message]': 'Your credits are added to your WOM account as soon as the payment goes through.',
      'payment_intent_data[description]': `WOM credits: ${label}`,
      'payment_intent_data[metadata][app]': 'wom',
      'payment_intent_data[metadata][pack]': pack.id,
      'metadata[app]': 'wom', 'metadata[pack]': pack.id, 'metadata[credits]': pack.credits, 'metadata[cents]': cents,
    })]);
  }
  // Only what the server needs. The Stripe account, product and price ids stay in Stripe.
  out.push({ id: pack.id, name: pack.name, usd: pack.usd, credits: pack.credits, paymentLink: link.id, url: link.url });
  console.log(`${pack.id.padEnd(9)} $${String(pack.usd).padEnd(4)} ${String(pack.credits).padStart(6)} credits  ${link.id}  ${link.url}`);
}

writeFileSync(OUT, `${JSON.stringify({ mode: live ? 'live' : 'test', packs: out }, null, 2)}\n`);
console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
