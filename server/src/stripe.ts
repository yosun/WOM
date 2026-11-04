// Selling credits with Stripe. The packs are Payment Links made by scripts/stripe-packs.mjs and listed in the packs JSON files. The
// server holds no Stripe API key: it sends the buyer to a link with their user id attached (client_reference_id), and Stripe
// tells it, in a signed webhook, who paid for which link. The one secret is the webhook's signing secret (STRIPE_WEBHOOK_SECRET).
import Stripe from 'stripe';
import { asSystem } from './db.ts';
import testPacks from './packs.json' with { type: 'json' };
import livePacks from './packs.live.json' with { type: 'json' };

export interface Pack {
  id: string;
  name: string;
  usd: number;
  credits: number;
  /** The Payment Link's id (plink_...), which is how a webhook says which pack was bought. */
  paymentLink: string;
  url: string;
}

const mode = process.env.WOM_STRIPE_MODE?.trim() || 'test';
if (mode !== 'test' && mode !== 'live') throw new Error('WOM_STRIPE_MODE must be test or live.');
const packsFile = mode === 'live' ? livePacks : testPacks;
if (packsFile.mode !== mode || !packsFile.packs.length) throw new Error(`Stripe ${mode} mode requires matching ${mode} payment links.`);

export const PACKS: readonly Pack[] = packsFile.packs;
/** Packs bought in test mode take a test card (4242 4242 4242 4242) and no real money. */
export const STRIPE_TEST_MODE = mode === 'test';

// Stripe takes letters, digits, dashes and underscores in client_reference_id, up to 200 characters.
const REFERENCE = /^[A-Za-z0-9_-]{1,200}$/;

/** What a signed-in person is offered to buy, each with a link that remembers who is buying. Nothing for an id Stripe cannot carry. */
export function packsFor(userId: string): Array<{ id: string; name: string; usd: number; credits: number; url: string }> {
  if (!REFERENCE.test(userId)) return [];
  return PACKS.map((p) => ({ id: p.id, name: p.name, usd: p.usd, credits: p.credits, url: `${p.url}?client_reference_id=${userId}` }));
}

export interface WebhookResult {
  status: 200 | 400 | 500 | 503;
  body: Record<string, unknown>;
}

const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

/**
 * Handle one webhook delivery: check its signature, and when it says one of our packs was paid for, add the credits.
 * Answers 200 for anything that needs no retry (including events that are not ours, since the Stripe account sells other
 * things too), 400 for a bad signature, and 500 when Stripe should send the event again.
 *
 * Stripe delivering an event twice, or the completed and the paid event for one checkout, adds the credits once: they are
 * keyed by the checkout session (credit_ledger.idem), and the event id is recorded in the same transaction.
 */
export async function handleWebhook(payload: string, signature: string | undefined): Promise<WebhookResult> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return { status: 503, body: { error: 'Payments are not set up.' } };

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(payload, signature ?? '', secret);
  } catch {
    return { status: 400, body: { error: 'Bad signature.' } };
  }
  if (!PAID_EVENTS.has(event.type)) return { status: 200, body: { ignored: event.type } };
  // A test payment must never add credits on a live site, nor a live one on a test site.
  if (event.livemode !== !STRIPE_TEST_MODE) return { status: 200, body: { ignored: 'wrong mode' } };

  const session = event.data.object as Stripe.Checkout.Session;
  const linkId = typeof session.payment_link === 'string' ? session.payment_link : session.payment_link?.id;
  const pack = PACKS.find((p) => p.paymentLink === linkId);
  if (!pack) return { status: 200, body: { ignored: 'not one of our packs' } };
  // A card pays at once. A bank debit completes the checkout first and pays later: wait for the event that says it did.
  if (session.payment_status !== 'paid') return { status: 200, body: { ignored: `payment is ${session.payment_status}` } };

  const problem = (why: string) => {
    console.error(`[stripe] ${event.id} ${session.id}: ${why}`);
    return { status: 500 as const, body: { error: why } };
  };
  if (session.currency !== 'usd' || session.amount_total !== pack.usd * 100) return problem(`paid ${session.amount_total} ${session.currency}, but ${pack.id} costs ${pack.usd * 100} usd`);
  const userId = session.client_reference_id;
  if (!userId || !REFERENCE.test(userId)) return problem('the payment names no user');

  try {
    const credited = await asSystem(async (db) => {
      const seen = await db.query('insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing', [event.id, event.type]);
      if (seen.rowCount === 0) return false;
      // The credits are keyed by the checkout, so its second event (completed, then paid) adds nothing. Say so.
      const key = `stripe:${session.id}`;
      const already = await db.query('select 1 from credit_ledger where idem = $1', [key]);
      await db.query(`select wom.credit_grant($1, $2::bigint, 'purchase', $3, $3, $4)`, [userId, pack.credits, key, `${pack.name} pack, $${pack.usd}`]);
      return already.rowCount === 0;
    });
    return { status: 200, body: { received: true, credited } };
  } catch (err) {
    // An unknown user fails here too (the ledger refuses a row for someone who does not exist). Stripe tries again, and shows the failure.
    return problem(`could not add ${pack.credits} credits to ${userId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
