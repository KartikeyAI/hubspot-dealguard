import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, databaseUrl } from './helpers/postgres-fixture.mjs';
import { recordUsageAtomic, retryAtomicUsageReports } from '../dist/billing-usage.js';
import { deliverUsageEvent, DELIVERY_CONTEXT_KEY } from '../dist/billing-usage-delivery.js';
import { getBillingStatus, setManualSubscription, recordUsage, retryUsageReports } from '../dist/billing.js';
const latch = () => { let resolve; return { promise: new Promise(r => { resolve = r; }), resolve: () => resolve() }; };

test('durable usage delivery preserves its original authorization and payload', { skip: !databaseUrl, timeout: 30000 }, async t => {
  const f = await fixture(t, 'usage-provenance');
  const env = { ...f.env, DODO_ENVIRONMENT: 'test', DODO_API_KEY: 'synthetic-test-key', DODO_EVENT_OVERAGE_EVENT_NAME: 'observed_event' };
  const rows = async () => (await f.first.query('SELECT * FROM billing_usage_events WHERE portal_id=$1 ORDER BY created_at,id', [f.portal])).rows;
  async function setup() {
    await f.first.query('DELETE FROM billing_usage_events WHERE portal_id=$1', [f.portal]);
    await f.first.query('DELETE FROM billing_usage_counters WHERE portal_id=$1', [f.portal]);
    await setManualSubscription(env, f.portal, 'enterprise', null, { usageMode: 'metered', overageEnabled: true });
    await f.first.query(`UPDATE subscriptions_v2 SET provider='dodo',provider_customer_id='original-customer',
      provider_subscription_id='original-subscription',provider_product_id='original-product',
      current_period_start=$2,current_period_end=$3 WHERE portal_id=$1`,
      [f.portal, new Date(Date.now()-86400000).toISOString(), new Date(Date.now()+86400000).toISOString()]);
  }
  async function pending(subtest, name = 'pending') {
    subtest.mock.method(globalThis, 'fetch', async () => new Response('not stored', { status: 503 }));
    await assert.rejects(recordUsageAtomic(env, f.portal, 'event_overage', 2, name), { code: 'dodo_usage_report_failed' });
    return (await rows()).find(r => r.idempotency_key === name);
  }
  await t.test('stores the original target before transport without exposing internal binding in provider metadata', async t => {
    await setup(); let event;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      const stored = (await rows())[0]; assert.equal(stored.status, 'pending');
      assert.equal(JSON.parse(JSON.parse(stored.metadata_json)[DELIVERY_CONTEXT_KEY]).customerId, 'original-customer');
      event = JSON.parse(init.body).events[0]; return Response.json({ ingested_count: 1 });
    });
    await recordUsageAtomic(env, f.portal, 'event_overage', 2, 'binding', { [DELIVERY_CONTEXT_KEY]: 'caller override', portal_id: 'other', quantity: 99 });
    assert.equal(Object.hasOwn(event.metadata, DELIVERY_CONTEXT_KEY), false);
    assert.equal(event.metadata.portal_id, f.portal); assert.equal(event.metadata.quantity, 2);
  });
  for (const [field, value] of [['provider_customer_id', 'different-customer'], ['provider_subscription_id', 'different-sub'],
    ['provider_product_id', 'different-product'], ['current_period_start', new Date().toISOString()]]) {
    await t.test(`changed ${field} cannot redirect pending usage`, async t => {
      await setup(); const row = await pending(t);
      await f.first.query(`UPDATE subscriptions_v2 SET ${field}=$2 WHERE portal_id=$1`, [f.portal, value]);
      const calls = globalThis.fetch.mock.callCount();
      await assert.rejects(deliverUsageEvent(env, f.portal, row.id), { code: 'usage_delivery_target_changed' });
      assert.equal(globalThis.fetch.mock.callCount(), calls);
      assert.equal((await rows())[0].status, 'failed'); assert.equal((await rows())[0].provider_event_id, row.provider_event_id);
    });
  }
  for (const change of [{ DODO_ENVIRONMENT: 'live' }, { DODO_EVENT_OVERAGE_EVENT_NAME: 'replacement_meter' }]) {
    await t.test(`configuration change ${Object.keys(change)[0]} requires reconciliation`, async t => {
      await setup(); const row = await pending(t); const calls = globalThis.fetch.mock.callCount();
      await assert.rejects(deliverUsageEvent({ ...env, ...change }, f.portal, row.id), { code: 'usage_delivery_target_changed' });
      assert.equal(globalThis.fetch.mock.callCount(), calls);
    });
  }
  await t.test('usage captured without metering consent stays local after later activation', async t => {
    await setup(); await f.first.query("UPDATE subscriptions_v2 SET usage_mode='capped',overage_enabled=0 WHERE portal_id=$1", [f.portal]);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('must never send'); });
    await recordUsageAtomic(env, f.portal, 'event_overage', 2, 'local-only');
    const row = (await rows())[0]; assert.equal(row.status, 'ignored');
    // Model a crash between the local reservation and its ignored transition.
    await f.first.query("UPDATE billing_usage_events SET status='pending' WHERE id=$1", [row.id]);
    await f.first.query("UPDATE subscriptions_v2 SET usage_mode='metered',overage_enabled=1 WHERE portal_id=$1", [f.portal]);
    await retryAtomicUsageReports(env); assert.equal(globalThis.fetch.mock.callCount(), 0);
    assert.equal((await rows())[0].status, 'ignored');
    assert.equal((await getBillingStatus(env, f.portal)).allowances.find(a => a.metric === 'event_overage').consumedQuantity, 2);
  });
  await t.test('crash-created pending events retry even without an error message', async t => {
    await setup(); const row = await pending(t);
    await f.first.query('UPDATE billing_usage_events SET error_message=NULL WHERE id=$1', [row.id]);
    let sent; t.mock.method(globalThis, 'fetch', async (_url, init) => { sent = JSON.parse(init.body).events[0]; return Response.json({ ingested_count: 1 }); });
    await retryAtomicUsageReports(env);
    assert.equal(sent.event_id, row.provider_event_id); assert.equal(sent.timestamp, row.occurred_at);
    assert.equal((await rows())[0].status, 'reported');
  });
  await t.test('legacy events without an original target are withheld, not relabeled', async t => {
    await setup(); const row = await pending(t);
    await f.first.query("UPDATE billing_usage_events SET metadata_json='{}' WHERE id=$1", [row.id]);
    const calls = globalThis.fetch.mock.callCount();
    await assert.rejects(deliverUsageEvent(env, f.portal, row.id), { code: 'usage_delivery_provenance_missing' });
    assert.equal(globalThis.fetch.mock.callCount(), calls);
    assert.equal((await rows())[0].provider_event_id, row.provider_event_id);
  });
  await t.test('a corrupt event does not abort the remaining retry batch', async t => {
    await setup(); const broken = await pending(t, 'corrupt'); await pending(t, 'valid');
    await f.first.query("UPDATE billing_usage_events SET metadata_json='{' WHERE id=$1", [broken.id]);
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ingested_count: 1 }));
    await retryAtomicUsageReports(env);
    const result = await rows();
    assert.equal(result.find(r => r.idempotency_key === 'corrupt').status, 'failed');
    assert.equal(result.find(r => r.idempotency_key === 'valid').status, 'reported');
  });
  for (const [name, offset, code] of [['expired', -3601000, 'usage_delivery_window_expired'], ['future', 301000, 'usage_delivery_clock_invalid']]) {
    await t.test(`${name} observation is never shifted to now`, async t => {
      await setup(); const row = await pending(t), stamp = new Date(Date.now()+offset).toISOString();
      await f.first.query('UPDATE billing_usage_events SET occurred_at=$2 WHERE id=$1', [row.id, stamp]);
      const calls = globalThis.fetch.mock.callCount();
      await assert.rejects(deliverUsageEvent(env, f.portal, row.id), { code });
      assert.equal(globalThis.fetch.mock.callCount(), calls); assert.equal((await rows())[0].occurred_at, stamp);
    });
  }
  await t.test('duplicate acknowledgment requires matching provider evidence', async t => {
    await setup(); let original;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
      if (init.method === 'POST') { original = JSON.parse(init.body).events[0]; return Response.json({ ingested_count: 0 }); }
      assert.equal(url, `https://test.dodopayments.com/events/${original.event_id}`);
      return Response.json({ ...original, business_id: 'fixture-business' });
    });
    assert.deepEqual(await recordUsageAtomic(env, f.portal, 'event_overage', 2, 'already-ingested'), { recorded: true, reported: true });
    assert.equal(globalThis.fetch.mock.callCount(), 2);
  });
  for (const mismatch of ['customer_id', 'event_name', 'event_id', 'timestamp', 'metadata']) {
    await t.test(`provider ${mismatch} mismatch cannot acknowledge our event`, async t => {
      await setup(); let original;
      t.mock.method(globalThis, 'fetch', async (_url, init) => {
        if (init.method === 'POST') { original = JSON.parse(init.body).events[0]; return Response.json({ ingested_count: 0 }); }
        return Response.json({ ...original, [mismatch]: mismatch === 'metadata' ? { ...original.metadata, quantity: 9 } : 'not-original' });
      });
      await assert.rejects(recordUsageAtomic(env, f.portal, 'event_overage', 2, mismatch), { code: 'usage_delivery_provider_conflict' });
      assert.equal((await rows())[0].status, 'failed');
    });
  }
  await t.test('late transport failure cannot reset a concurrently reported event', async t => {
    await setup(); const row = await pending(t), entered = latch(), release = latch(); let count = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      if (++count === 1) { entered.resolve(); await release.promise; return new Response('', { status: 503 }); }
      return Response.json({ ingested_count: 1 });
    });
    const delayed = deliverUsageEvent(env, f.portal, row.id).catch(e => e); await entered.promise;
    try { assert.equal(await deliverUsageEvent({ ...env, ...f.envFor(f.second) }, f.portal, row.id), true); }
    finally { release.resolve(); }
    assert.equal((await delayed).code, 'dodo_usage_report_failed');
    assert.equal((await rows())[0].status, 'reported'); assert.equal((await rows())[0].error_message, null);
  });
  await t.test('permanent rejection is held and does not refund local consumption', async t => {
    await setup(); t.mock.method(globalThis, 'fetch', async () => new Response('sensitive-provider-response', { status: 400 }));
    await assert.rejects(recordUsageAtomic(env, f.portal, 'event_overage', 2, 'rejected'), { code: 'dodo_usage_report_failed' });
    const row = (await rows())[0]; assert.equal(row.status, 'failed'); assert.equal(row.error_message, 'dodo_usage_report_failed');
    assert.equal((await getBillingStatus(env, f.portal)).allowances.find(a => a.metric === 'event_overage').consumedQuantity, 2);
  });
  await t.test('metadata limits reject collisions, nonfinite values and oversized maps before recording', async t => {
    await setup(); t.mock.method(globalThis, 'fetch', async () => { throw new Error('no provider call'); });
    for (const metadata of [{ ['a'.repeat(101)]: 1 }, { v: Infinity }, { v: 'x'.repeat(501) },
      Object.fromEntries(Array.from({length: 49}, (_, i) => ['field'+i, i]))]) {
      await assert.rejects(recordUsageAtomic(env, f.portal, 'event_overage', 1, crypto.randomUUID(), metadata), { code: 'usage_metadata_invalid' });
    }
    assert.equal((await rows()).length, 0); assert.equal(globalThis.fetch.mock.callCount(), 0);
  });
  await t.test('legacy exported entry points delegate without deleting original events', async t => {
    await setup(); const row = await pending(t, 'compatibility');
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ingested_count: 1 }));
    assert.equal((await recordUsage(env, f.portal, 'event_overage', 2, 'compatibility')).recorded, false);
    await retryUsageReports(env); const after = (await rows())[0];
    assert.equal(after.id, row.id); assert.equal(after.occurred_at, row.occurred_at); assert.equal(after.status, 'reported');
  });
  await t.test('reported identity is inaccessible through another tenant', async t => {
    await setup(); const row = await pending(t); const calls = globalThis.fetch.mock.callCount();
    assert.equal(await deliverUsageEvent(env, f.other, row.id), false);
    assert.equal(globalThis.fetch.mock.callCount(), calls); assert.equal((await rows())[0].status, 'pending');
  });
});
