import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import Stripe from 'stripe';

process.env.WOM_STRIPE_MODE = 'test';
const { handleWebhook, PACKS, packsFor, STRIPE_TEST_MODE } = await import('../../server/src/stripe.ts');
const signingSecret = 'whsec_wom_local_stripe_test';
process.env.STRIPE_WEBHOOK_SECRET = signingSecret;

function signedEvent(overrides: Record<string, unknown> = {}, sessionOverrides: Record<string, unknown> = {}) {
  const payload = JSON.stringify({
    id: 'evt_local_test', type: 'checkout.session.completed', livemode: false,
    data: { object: { id: 'cs_local_test', payment_link: PACKS[0].paymentLink, payment_status: 'unpaid',
      currency: 'usd', amount_total: PACKS[0].usd * 100, client_reference_id: 'user_example', ...sessionOverrides } },
    ...overrides,
  });
  return { payload, signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: signingSecret }) };
}

test('test-mode packs include the signed-in user and reject invalid user identifiers', () => {
  assert.equal(STRIPE_TEST_MODE, true);
  assert.ok(packsFor('user_example').every((pack) => new URL(pack.url).searchParams.get('client_reference_id') === 'user_example'));
  assert.deepEqual(packsFor('bad user'), []);
});

test('the webhook verifies signatures and ignores wrong-mode, unrelated, and unpaid events', async () => {
  let event = signedEvent();
  assert.equal((await handleWebhook(event.payload, 'bad-signature')).status, 400);
  event = signedEvent({ livemode: true });
  assert.deepEqual((await handleWebhook(event.payload, event.signature)).body, { ignored: 'wrong mode' });
  event = signedEvent({}, { payment_link: 'plink_some_other_product' });
  assert.deepEqual((await handleWebhook(event.payload, event.signature)).body, { ignored: 'not one of our packs' });
  event = signedEvent();
  assert.deepEqual((await handleWebhook(event.payload, event.signature)).body, { ignored: 'payment is unpaid' });
});

test('the webhook refuses paid events with the wrong amount or an invalid user before granting credits', async () => {
  let event = signedEvent({}, { payment_status: 'paid', amount_total: 1 });
  assert.equal((await handleWebhook(event.payload, event.signature)).status, 500);
  event = signedEvent({}, { payment_status: 'paid', client_reference_id: 'invalid user' });
  assert.equal((await handleWebhook(event.payload, event.signature)).status, 500);
});

test('mode selection defaults to test and refuses missing live packs or an invalid mode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wom-stripe-mode-'));
  try {
    await copyFile('server/src/stripe.ts', path.join(dir, 'stripe.ts'));
    await copyFile('server/src/db.ts', path.join(dir, 'db.ts'));
    await symlink(path.resolve('node_modules'), path.join(dir, 'node_modules'));
    const pack = (url: string) => [{ id: 'starter', name: 'Starter', usd: 10, credits: 1000, paymentLink: 'plink_fixture', url }];
    await writeFile(path.join(dir, 'packs.json'), JSON.stringify({ mode: 'test', packs: pack('https://buy.stripe.com/test_fixture') }));
    await writeFile(path.join(dir, 'packs.live.json'), JSON.stringify({ mode: 'live', packs: pack('https://buy.stripe.com/live_fixture') }));
    const entry = pathToFileURL(path.join(dir, 'stripe.ts')).href;
    const run = (mode?: string) => {
      const env = { ...process.env };
      if (mode === undefined) delete env.WOM_STRIPE_MODE; else env.WOM_STRIPE_MODE = mode;
      return spawnSync(process.execPath, ['--input-type=module', '-e',
        `const s = await import(${JSON.stringify(entry)}); console.log(JSON.stringify({test:s.STRIPE_TEST_MODE,url:s.PACKS[0].url}));`],
      { encoding: 'utf8', env });
    };
    const defaultResult = run();
    assert.equal(defaultResult.status, 0, defaultResult.stderr);
    assert.deepEqual(JSON.parse(defaultResult.stdout), { test: true, url: 'https://buy.stripe.com/test_fixture' });
    const liveResult = run('live');
    assert.equal(liveResult.status, 0, liveResult.stderr);
    assert.deepEqual(JSON.parse(liveResult.stdout), { test: false, url: 'https://buy.stripe.com/live_fixture' });
    assert.notEqual(run('invalid').status, 0);
    await writeFile(path.join(dir, 'packs.live.json'), JSON.stringify({ mode: 'live', packs: [] }));
    assert.notEqual(run('live').status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Stripe CLI wrapper rejects API errors and responses from the wrong mode', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wom-stripe-cli-'));
  try {
    await writeFile(path.join(dir, 'stripe'), '#!/bin/sh\nprintf "%s\\n" "$WOM_FAKE_STRIPE_RESPONSE"\n', { mode: 0o755 });
    const entry = pathToFileURL(path.resolve('scripts/stripe-cli.mjs')).href;
    const run = (response: unknown, live: boolean) => spawnSync(process.execPath, ['--input-type=module', '-e',
      `const {stripe} = await import(${JSON.stringify(entry)}); stripe(['get', '/v1/balance'], {live:${live}});`],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      WOM_FAKE_STRIPE_RESPONSE: JSON.stringify(response) } });
    assert.equal(run({ livemode: false }, false).status, 0);
    assert.equal(run({ livemode: true }, true).status, 0);
    assert.notEqual(run({ livemode: true }, false).status, 0);
    assert.notEqual(run({ livemode: false }, true).status, 0);
    assert.notEqual(run({ error: { message: 'permission denied' } }, true).status, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
